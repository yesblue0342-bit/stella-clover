// api/summarize.js - 텍스트 → AI 회의록 + Drive 저장 + Azure 메타데이터
// (drive 유틸을 직접 포함하여 Vercel 번들 문제 방지)
import OpenAI from "openai";
import { google } from "googleapis";
import sql from "mssql";
import { Readable } from "stream";

export const config = { maxDuration: 120 };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ────── 재시도 ──────
async function retry(fn, times = 3, delay = 2000) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, delay * (i + 1))); }
  }
  throw lastErr;
}

// ────── Google Drive ──────
const CLOVER_FOLDER = "stellaclover";
const FOLDER_MIME = "application/vnd.google-apps.folder";

function getDrive() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth: oauth2 });
}

async function ensureFolder(drive, name, parentId) {
  const q = `name='${name}' and mimeType='${FOLDER_MIME}' and '${parentId}' in parents and trashed=false`;
  const r = await drive.files.list({ q, fields: "files(id,name)", pageSize: 1 });
  if (r.data.files?.[0]) return r.data.files[0].id;
  const c = await drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
    fields: "id"
  });
  return c.data.id;
}

async function getCloverRoot(drive) {
  const q = `name='${CLOVER_FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const r = await drive.files.list({ q, fields: "files(id)", pageSize: 1 });
  if (r.data.files?.[0]) return r.data.files[0].id;
  const c = await drive.files.create({
    requestBody: { name: CLOVER_FOLDER, mimeType: FOLDER_MIME },
    fields: "id"
  });
  return c.data.id;
}

async function ensurePath(drive, parts) {
  let parentId = await getCloverRoot(drive);
  for (const part of parts.filter(Boolean)) {
    parentId = await ensureFolder(drive, part, parentId);
  }
  return parentId;
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
  const now = new Date();
  const Y = now.getFullYear().toString();
  const YM = Y + String(now.getMonth() + 1).padStart(2, "0");
  const YMD = YM + String(now.getDate()).padStart(2, "0");
  const HM = String(now.getHours()).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0");
  return { Y, YM, YMD, HM };
}

// ────── Azure SQL ──────
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

// ────── 언어 설정 ──────
const LANG_NAMES = {
  ko: "한국어", en: "English", ja: "日本語",
  zh: "中文", de: "Deutsch", es: "Español", fr: "Français"
};
const LANG_LOCALES = {
  ko: "ko-KR", en: "en-US", ja: "ja-JP",
  zh: "zh-CN", de: "de-DE", es: "es-ES", fr: "fr-FR"
};

function buildSystemPrompt(lang) {
  const locale = LANG_LOCALES[lang] || "ko-KR";
  const today = new Date().toLocaleDateString(locale);
  const langLine = lang === "auto"
    ? "Detect the language of the meeting content and write the ENTIRE minutes (including all section headings) in that same language."
    : `Write the ENTIRE minutes (including all section headings) in ${LANG_NAMES[lang] || lang}.`;

  return `You are a professional meeting-minutes writer AI.
${langLine}
The meeting may contain SAP terminology (module names, T-codes, table names, etc.); keep such technical terms accurate and unchanged.

Your response MUST begin with a single line in exactly this form:
TITLE: <a concise meeting title>
Then one blank line, then the minutes following this structure (translate the headings into the target language, keep the markdown):

# Meeting Minutes
## Title
## Date (${today})
## Attendees (infer, or mark unknown)
## Summary (3-5 key lines)
## Decisions (bulleted)
## Action Items (markdown table: owner | task | due date)
## Issues (if any)
## Next Steps (if any)`;
}

// ────── 메인 핸들러 ──────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST only" });

  const { transcript, audioFileName } = req.body || {};
  if (!transcript?.trim()) return res.status(400).json({ ok: false, message: "회의 내용이 없습니다." });

  const lang = String((req.body && req.body.lang) || "ko").trim().toLowerCase();

  // 1. AI 회의록 생성
  let summary;
  try {
    summary = await retry(async () => {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: buildSystemPrompt(lang) },
          { role: "user", content: `Write the meeting minutes for the following meeting transcript:\n\n${transcript}` }
        ],
        temperature: 0.3,
        max_tokens: 2000
      });
      return resp.choices[0].message.content;
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: "AI 회의록 생성 실패: " + e.message });
  }

  // 2. 제목 추출 (언어 무관: 첫 줄의 TITLE: 마커 사용, 표시에서는 제거)
  let title = "회의록";
  const tMatch = summary.match(/^\s*TITLE:\s*(.+)$/im);
  if (tMatch) {
    title = tMatch[1].trim();
    summary = summary.replace(/^\s*TITLE:\s*.+\r?\n?/im, "").replace(/^\s+/, "");
  } else {
    // 마커가 없으면 한국어 헤딩 기반 폴백
    const m = summary.match(/##\s*(?:회의 제목|Title|タイトル|标题|Titel)\s*\r?\n+\s*([^\n]+)/i);
    if (m) title = m[1].trim();
  }
  title = title.replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 80);
  if (!title) title = "회의록";

  const { Y, YM, YMD, HM } = dateParts();
  const fileBase = `${YMD}_${HM}_${title.slice(0, 20)}`;

  // 3. Google Drive 저장
  let driveFileId = null, driveLink = null, driveError = null;
  try {
    const drive = getDrive();
    const folderId = await retry(() => ensurePath(drive, ["Meeting", Y, YM]));
    const up = await retry(() => uploadText(drive, folderId, `${fileBase}.txt`, summary));
    driveFileId = up.id;
    driveLink = up.webViewLink;
  } catch (e) {
    driveError = e.message;
    console.error("[Drive] 저장 실패:", e.message);
  }

  // 4. Azure SQL 메타데이터
  let dbError = null;
  try {
    const pool = await sql.connect(getDbConfig());
    await pool.request()
      .input("title", sql.NVarChar(300), title)
      .input("tc", sql.Int, transcript.length)
      .input("sc", sql.Int, summary.length)
      .input("fid", sql.NVarChar(200), driveFileId || "")
      .input("link", sql.NVarChar(500), driveLink || "")
      .input("audio", sql.NVarChar(300), audioFileName || "")
      .query(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name='cl_meetings')
        CREATE TABLE cl_meetings (
          id INT IDENTITY PRIMARY KEY,
          title NVARCHAR(300), transcript_chars INT, summary_chars INT,
          drive_file_id NVARCHAR(200), drive_link NVARCHAR(500),
          audio_file NVARCHAR(300), created_at DATETIME2 DEFAULT SYSUTCDATETIME()
        );
        INSERT INTO cl_meetings (title,transcript_chars,summary_chars,drive_file_id,drive_link,audio_file)
        VALUES (@title,@tc,@sc,@fid,@link,@audio)
      `);
    await pool.close();
  } catch (e) {
    dbError = e.message;
    console.error("[Azure] 저장 실패:", e.message);
  }

  return res.status(200).json({
    ok: true, summary, title, driveFileId, driveLink,
    warnings: { driveError, dbError }
  });
}
