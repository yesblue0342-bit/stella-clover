// api/summarize.js - 텍스트 → AI 회의록 + Drive 저장 + Azure 메타데이터
import OpenAI from "openai";
import { ensurePath, uploadToDrive, dateParts } from "../lib/drive.js";
import sql from "mssql";

export const config = { maxDuration: 120 };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function retry(fn, times = 3) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
  throw lastErr;
}

function getDbConfig() {
  return {
    server: process.env.CL_DB_SV,
    database: process.env.CL_DB_NM,
    user: process.env.CL_DB_USR,
    password: process.env.CL_DB_PW,
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 3, min: 0, idleTimeoutMillis: 30000 }
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST only" });

  const { transcript, audioFileName } = req.body || {};
  if (!transcript?.trim()) return res.status(400).json({ ok: false, message: "회의 내용이 없습니다." });

  // 1. AI 회의록 생성
  let summary;
  try {
    summary = await retry(async () => {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `당신은 전문 회의록 작성 AI입니다. 주어진 회의 내용을 분석하여 아래 형식으로 회의록을 작성하세요.
반드시 아래 형식을 지키고, 내용은 한국어로 작성하세요.

---
# 회의록

## 회의 제목
(내용에서 추론)

## 회의 일시
(현재 날짜 기준: ${new Date().toLocaleDateString("ko-KR")})

## 참석자
(내용에서 추론 또는 "미상")

## 회의 내용 요약
(핵심 내용 3~5줄)

## 주요 결정사항
- (항목별로 나열)

## Action Item
| 담당자 | 내용 | 완료 예정일 |
|--------|------|------------|
| | | |

## 이슈 사항
- (있는 경우)

## 차기 일정
- (있는 경우)
---`
          },
          { role: "user", content: `다음 회의 내용으로 회의록을 작성해주세요:\n\n${transcript}` }
        ],
        temperature: 0.3,
        max_tokens: 2000
      });
      return resp.choices[0].message.content;
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: "AI 생성 실패: " + e.message });
  }

  // 2. 제목 추출 (회의록에서)
  const titleMatch = summary.match(/## 회의 제목\s*\n([^\n]+)/);
  const title = titleMatch ? titleMatch[1].trim() : "회의록";

  const { Y, YM, YMD, HM } = dateParts();
  const fileBase = `${YMD}_${HM}_${title.slice(0, 20)}`;

  // 3. Google Drive 저장 (회의록 텍스트)
  let driveFileId = null, driveLink = null;
  try {
    const folder = await retry(() => ensurePath(["Meeting", Y, YM]));
    const uploaded = await retry(() => uploadToDrive({
      folderId: folder.id,
      fileName: `${fileBase}.txt`,
      mimeType: "text/plain",
      content: summary
    }));
    driveFileId = uploaded.id;
    driveLink = uploaded.webViewLink;
  } catch (e) {
    console.error("Drive 저장 실패:", e.message);
    // Drive 실패해도 요약은 반환
  }

  // 4. Azure SQL 메타데이터 저장
  try {
    const pool = await sql.connect(getDbConfig());
    await pool.request()
      .input("title", sql.NVarChar(300), title)
      .input("transcript_chars", sql.Int, transcript.length)
      .input("summary_chars", sql.Int, summary.length)
      .input("drive_file_id", sql.NVarChar(200), driveFileId || "")
      .input("drive_link", sql.NVarChar(500), driveLink || "")
      .input("audio_file", sql.NVarChar(300), audioFileName || "")
      .query(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name='cl_meetings')
        CREATE TABLE cl_meetings (
          id INT IDENTITY PRIMARY KEY,
          title NVARCHAR(300),
          transcript_chars INT,
          summary_chars INT,
          drive_file_id NVARCHAR(200),
          drive_link NVARCHAR(500),
          audio_file NVARCHAR(300),
          created_at DATETIME2 DEFAULT SYSUTCDATETIME()
        );
        INSERT INTO cl_meetings (title,transcript_chars,summary_chars,drive_file_id,drive_link,audio_file)
        VALUES (@title,@transcript_chars,@summary_chars,@drive_file_id,@drive_link,@audio_file)
      `);
  } catch (e) {
    console.error("Azure 저장 실패:", e.message);
  }

  return res.status(200).json({
    ok: true,
    summary,
    title,
    driveFileId,
    driveLink
  });
}
