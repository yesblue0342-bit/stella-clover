// api/summarize.js - 텍스트 → AI 회의록 + Drive 저장 + Azure(전문 저장)
import OpenAI from "openai";
import { getPool, sql } from "./_db.js";
import { getDrive, ensurePath, uploadText, dateParts } from "./_drive.js";
import { prepareTranscript, needsMapReduce, splitTranscript, buildMinutesSystemPrompt, buildPartialSystemPrompt, meetingDateFromName, resolveMeetingTitle } from "./_meeting.js";

// (Vercel maxDuration 제거 — OCI 서버는 시간 제한 없음. map-reduce 요약도 끝까지 수행.)

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function retry(fn, times = 3, delay = 2000) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, delay * (i + 1))); }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST only" });

  const { transcript: rawTranscript, audioFileName, sessionId, lang, userInstruction, fileDate } = req.body || {};
  // 전사 전체 사용(잘림 없음). 합본 원본을 회의록·요약 입력으로 그대로 전달.
  const transcript = prepareTranscript(rawTranscript);
  // 작성일: 파일 메타(fileDate, YYYY-MM-DD) 우선, 없으면 오늘.
  const writtenDate = (String(fileDate || "").match(/\d{4}-\d{2}-\d{2}/) || [])[0] || new Date().toISOString().slice(0, 10);
  const LANG_NAMES = {
    ko: "한국어", en: "English", ja: "日本語", zh: "中文",
    vi: "Tiếng Việt", th: "ภาษาไทย", es: "Español", fr: "Français",
    de: "Deutsch", id: "Bahasa Indonesia", ru: "Русский", ar: "العربية", auto: "한국어"
  };
  const outLang = LANG_NAMES[lang] || "한국어";
  if (!transcript?.trim()) return res.status(400).json({ ok: false, message: "회의 내용이 없습니다." });
  const audioSession = (sessionId || "").toString().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  // "내 AI 지침": 사용자 정의 요약 프롬프트(길이 제한). 있으면 시스템 프롬프트에 반영.
  const customInstruction = String(userInstruction || "").trim().slice(0, 1000);
  const customBlock = customInstruction
    ? `\n\n[사용자 추가 지침 — 우선 반영]\n${customInstruction}\n`
    : "";

  // 1. AI 회의록 — 전사 전체를 입력으로 사용(잘림 없음). 너무 길면 map-reduce(부분요약→통합)로 누락 0.
  async function llmText(system, user, max_tokens) {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.2,
      max_tokens,
    });
    return resp.choices[0].message.content || "";
  }
  const meetingDate = meetingDateFromName(audioFileName); // 파일명(예: 260612_…)에서 회의 일시 추출
  const minutesSystem = buildMinutesSystemPrompt({ outLang, writtenDate, meetingDate, customBlock });

  let summary;
  try {
    if (needsMapReduce(transcript)) {
      // map: 분할 부분요약(누락 없이) → reduce: 통합 회의록
      const parts = splitTranscript(transcript);
      const partials = [];
      for (let i = 0; i < parts.length; i++) {
        const ps = buildPartialSystemPrompt({ outLang, idx: i, total: parts.length });
        const pt = await retry(() => llmText(ps, parts[i], 2000));
        partials.push(`[부분 ${i + 1}/${parts.length}]\n${pt}`);
      }
      const combined = partials.join("\n\n");
      summary = await retry(() => llmText(minutesSystem, `다음은 회의 전사의 부분요약 모음입니다. 누락 없이 통합해 회의록을 작성하세요:\n\n${combined}`, 4000));
    } else {
      summary = await retry(() => llmText(minutesSystem, `다음 회의 전사 전체로 회의록을 작성해주세요:\n\n${transcript}`, 4000));
    }
  } catch (e) {
    return res.status(500).json({ ok: false, message: "AI 회의록 생성 실패: " + e.message });
  }

  // 2. 제목 + 키워드 추출
  const tm = summary.match(/##\s*회의 제목\s*\n+\s*([^\n]+)/);
  // AI 제목이 없거나 generic이면 KST 날짜+시각 키 제목으로 대체(업로드별 구분 + 최신본 식별).
  const title = resolveMeetingTitle(tm ? tm[1] : "", new Date());

  const km = summary.match(/##\s*주요 키워드\s*\n+\s*([^\n]+)/);
  const keywords = km ? km[1].trim() : "";

  const { Y, YM, YMD, HM } = dateParts();
  const fileBase = `${YMD}_${HM}_${title.slice(0, 20)}`;

  // 3. Google Drive 저장 (회의록 + 원본 전사 + 메타데이터 JSON)
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
    // 메타데이터 JSON 미러 (Azure SQL이 원본, Drive는 포터블 백업)
    try {
      const metaFolder = await ensurePath(drive, ["Metadata", Y, YM]);
      const meta = {
        title, keywords,
        created_at: new Date().toISOString(),
        transcript_chars: transcript.length,
        summary_chars: summary.length,
        drive_file_id: driveFileId,
        drive_link: driveLink,
        audio_file: audioFileName || "",
        audio_session: audioSession || ""
      };
      await uploadText(drive, metaFolder, `${fileBase}.json`, JSON.stringify(meta, null, 2));
    } catch (e3) {}
  } catch (e) {
    driveError = e.message;
  }

  // 4. Azure SQL - 전문 저장 (키워드 검색용)
  let dbError = null;
  try {
    const pool = await getPool();
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
      .input("asession", sql.NVarChar(100), audioSession || "")
      .query(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name='cl_meetings')
        CREATE TABLE cl_meetings (
          id INT IDENTITY PRIMARY KEY,
          title NVARCHAR(300), keywords NVARCHAR(500),
          summary NVARCHAR(MAX), transcript NVARCHAR(MAX),
          transcript_chars INT, summary_chars INT,
          drive_file_id NVARCHAR(200), drive_link NVARCHAR(500),
          audio_file NVARCHAR(300), audio_session NVARCHAR(100),
          created_at DATETIME2 DEFAULT SYSUTCDATETIME()
        );
        IF COL_LENGTH('cl_meetings','keywords') IS NULL ALTER TABLE cl_meetings ADD keywords NVARCHAR(500);
        IF COL_LENGTH('cl_meetings','summary') IS NULL ALTER TABLE cl_meetings ADD summary NVARCHAR(MAX);
        IF COL_LENGTH('cl_meetings','transcript') IS NULL ALTER TABLE cl_meetings ADD transcript NVARCHAR(MAX);
        IF COL_LENGTH('cl_meetings','audio_session') IS NULL ALTER TABLE cl_meetings ADD audio_session NVARCHAR(100);
        INSERT INTO cl_meetings (title,keywords,summary,transcript,transcript_chars,summary_chars,drive_file_id,drive_link,audio_file,audio_session)
        VALUES (@title,@keywords,@summary,@transcript,@tc,@sc,@fid,@link,@audio,@asession)
      `);
  } catch (e) {
    dbError = e.message;
  }

  return res.status(200).json({
    ok: true, summary, title, keywords, driveFileId, driveLink,
    warnings: { driveError, dbError }
  });
}
