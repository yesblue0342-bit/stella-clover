// api/summarize.js - 텍스트 → AI 회의록 + Drive 저장 + Azure(전문 저장)
import OpenAI from "openai";
import { google } from "googleapis";
import sql from "mssql";
import { Readable } from "stream";

export const config = { maxDuration: 120 };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function retry(fn, times = 3, delay = 2000) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, delay * (i + 1))); }
  }
  throw lastErr;
}

// ── Google Drive ──
const CLOVER_FOLDER = "stellaclover";
const FOLDER_MIME = "application/vnd.google-apps.folder";

function getDrive() {
  const o = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  o.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth: o });
}
async function ensureFolder(drive, name, parentId) {
  const q = `name='${name}' and mimeType='${FOLDER_MIME}' and '${parentId}' in parents and trashed=false`;
  const r = await drive.files.list({ q, fields: "files(id)", pageSize: 1 });
  if (r.data.files?.[0]) return r.data.files[0].id;
  const c = await drive.files.create({ requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] }, fields: "id" });
  return c.data.id;
}
async function getRoot(drive) {
  const q = `name='${CLOVER_FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const r = await drive.files.list({ q, fields: "files(id)", pageSize: 1 });
  if (r.data.files?.[0]) return r.data.files[0].id;
  const c = await drive.files.create({ requestBody: { name: CLOVER_FOLDER, mimeType: FOLDER_MIME }, fields: "id" });
  return c.data.id;
}
async function ensurePath(drive, parts) {
  let p = await getRoot(drive);
  for (const part of parts.filter(Boolean)) p = await ensureFolder(drive, part, p);
  return p;
}
async function uploadText(drive, folderId, fileName, content) {
  const r = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType: "text/plain", body: Readable.from([Buffer.from(content, "utf-8")]) },
    fields: "id,webViewLink"
  });
  return r.data;
}
function dateParts() {
  const n = new Date();
  const Y = n.getFullYear().toString();
  const YM = Y + String(n.getMonth() + 1).padStart(2, "0");
  const YMD = YM + String(n.getDate()).padStart(2, "0");
  const HM = String(n.getHours()).padStart(2, "0") + String(n.getMinutes()).padStart(2, "0");
  return { Y, YM, YMD, HM };
}

// ── Azure SQL ──
function getDbConfig() {
  return {
    server: process.env.CL_DB_SV, database: process.env.CL_DB_NM,
    user: process.env.CL_DB_USR, password: process.env.CL_DB_PW,
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 3, min: 0, idleTimeoutMillis: 30000 }
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST only" });

  const { transcript, audioFileName } = req.body || {};
  if (!transcript?.trim()) return res.status(400).json({ ok: false, message: "회의 내용이 없습니다." });

  // 1. AI 회의록 (SAP/ERP 컨설팅 컨텍스트)
  let summary;
  try {
    summary = await retry(async () => {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `당신은 SAP/ERP 컨설팅 프로젝트 전문 회의록 작성 AI입니다.
회의 참석자는 SAP 컨설턴트, 개발자, 현업 담당자입니다.
SAP 전문용어(ABAP, BAPI, IDoc, BOM, MRP, QM, PP, MM, SD, FI, CO, S/4HANA, 검사로트, 자재마스터, 생산오더, 고도화, 인터페이스, 마이그레이션 등)를 정확히 이해하고 회의록에 반영하세요.
음성 인식 오류로 보이는 용어는 SAP 맥락에 맞게 교정하세요.

아래 형식으로 한국어 회의록을 작성하세요:

# 회의록

## 회의 제목
(내용에서 추론)

## 회의 일시
${new Date().toLocaleDateString("ko-KR")}

## 참석자
(추론 또는 "미상")

## 회의 내용 요약
(핵심 5~8줄, SAP 모듈/기능 중심)

## 주요 결정사항
- (항목별)

## Action Item
| 담당자 | 내용 | 완료 예정일 |
|--------|------|------------|
| | | |

## 이슈 사항
- (기술적 이슈, 미결정 사항)

## 차기 일정
- (있으면)

## 주요 키워드
(이 회의의 핵심 SAP 용어/주제를 쉼표로 5~10개)`
          },
          { role: "user", content: `다음 SAP 프로젝트 회의 내용으로 회의록을 작성해주세요:\n\n${transcript}` }
        ],
        temperature: 0.3,
        max_tokens: 2500
      });
      return resp.choices[0].message.content;
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: "AI 회의록 생성 실패: " + e.message });
  }

  // 2. 제목 + 키워드 추출
  const tm = summary.match(/##\s*회의 제목\s*\n+\s*([^\n]+)/);
  let title = tm ? tm[1].trim().replace(/[\\/:*?"<>|]/g, "") : "회의록";
  if (!title) title = "회의록";

  const km = summary.match(/##\s*주요 키워드\s*\n+\s*([^\n]+)/);
  const keywords = km ? km[1].trim() : "";

  const { Y, YM, YMD, HM } = dateParts();
  const fileBase = `${YMD}_${HM}_${title.slice(0, 20)}`;

  // 3. Google Drive 저장 (회의록 + 원본 전사)
  let driveFileId = null, driveLink = null, driveError = null;
  try {
    const drive = getDrive();
    const folderId = await retry(() => ensurePath(drive, ["Meeting", Y, YM]));
    const up = await retry(() => uploadText(drive, folderId, `${fileBase}.txt`, summary));
    driveFileId = up.id;
    driveLink = up.webViewLink;
    // 원본 전사도 별도 저장 (AI_Report 폴더)
    try {
      const rawFolder = await ensurePath(drive, ["AI_Report", Y, YM]);
      await uploadText(drive, rawFolder, `${fileBase}_전사.txt`, transcript);
    } catch (e2) {}
  } catch (e) {
    driveError = e.message;
  }

  // 4. Azure SQL - 전문 저장 (키워드 검색용)
  let dbError = null;
  try {
    const pool = await sql.connect(getDbConfig());
    await pool.request()
      .input("title", sql.NVarChar(300), title)
      .input("keywords", sql.NVarChar(500), keywords)
      .input("summary", sql.NVarChar(sql.MAX), summary)
      .input("transcript", sql.NVarChar(sql.MAX), transcript)
      .input("tc", sql.Int, transcript.length)
      .input("sc", sql.Int, summary.length)
      .input("fid", sql.NVarChar(200), driveFileId || "")
      .input("link", sql.NVarChar(500), driveLink || "")
      .input("audio", sql.NVarChar(300), audioFileName || "")
      .query(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name='cl_meetings')
        CREATE TABLE cl_meetings (
          id INT IDENTITY PRIMARY KEY,
          title NVARCHAR(300), keywords NVARCHAR(500),
          summary NVARCHAR(MAX), transcript NVARCHAR(MAX),
          transcript_chars INT, summary_chars INT,
          drive_file_id NVARCHAR(200), drive_link NVARCHAR(500),
          audio_file NVARCHAR(300), created_at DATETIME2 DEFAULT SYSUTCDATETIME()
        );
        IF COL_LENGTH('cl_meetings','keywords') IS NULL ALTER TABLE cl_meetings ADD keywords NVARCHAR(500);
        IF COL_LENGTH('cl_meetings','summary') IS NULL ALTER TABLE cl_meetings ADD summary NVARCHAR(MAX);
        IF COL_LENGTH('cl_meetings','transcript') IS NULL ALTER TABLE cl_meetings ADD transcript NVARCHAR(MAX);
        INSERT INTO cl_meetings (title,keywords,summary,transcript,transcript_chars,summary_chars,drive_file_id,drive_link,audio_file)
        VALUES (@title,@keywords,@summary,@transcript,@tc,@sc,@fid,@link,@audio)
      `);
    await pool.close();
  } catch (e) {
    dbError = e.message;
  }

  return res.status(200).json({
    ok: true, summary, title, keywords, driveFileId, driveLink,
    warnings: { driveError, dbError }
  });
}
