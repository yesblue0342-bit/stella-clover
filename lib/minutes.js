// lib/minutes.js — 회의록 생성/Drive 백업/cl_meetings 저장 공유 코어.
//
// 왜: 과거에는 완료된 전사(fullText)를 **브라우저가** /api/summarize 로 다시 보내 회의록을 만들었다.
//   → 잡이 끝난 뒤 탭이 닫혀 있으면 회의록·이력 저장이 영영 실행되지 않는 구조적 결함(창 닫으면 중단).
//   이 모듈로 코어를 분리해 백그라운드 워커(lib/jobs-runtime)가 서버에서 끝까지 수행하고,
//   /api/summarize(OCR·레거시 경로)는 같은 코어를 호출한다 — 로직 단일 출처.
import { getPool, sql } from "../api/_db.js";
import { getDrive, ensurePath, uploadText, dateParts } from "../api/_drive.js";
import { buildMinutesSystemPrompt, buildPartialSystemPrompt, needsMapReduce, splitTranscript, meetingDateFromName, resolveMeetingTitle } from "../api/_meeting.js";
import { getOpenAI } from "../api/_stt.js";

export const LANG_NAMES = {
  ko: "한국어", en: "English", ja: "日本語", zh: "中文",
  vi: "Tiếng Việt", th: "ภาษาไทย", es: "Español", fr: "Français",
  de: "Deutsch", id: "Bahasa Indonesia", ru: "Русский", ar: "العربية", auto: "한국어"
};

async function retry(fn, times = 3, delay = 2000) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, delay * (i + 1))); }
  }
  throw lastErr;
}

async function llmText(system, user, max_tokens) {
  const resp = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.2,
    max_tokens,
  });
  return resp.choices[0].message.content || "";
}

// 전사(전처리 완료 상태) → 회의록 마크다운 + 제목 + 키워드. 너무 길면 map-reduce(누락 0).
export async function generateMinutes({ transcript, lang = "ko", audioFileName = "", fileDate = "", userInstruction = "" }) {
  const outLang = LANG_NAMES[lang] || "한국어";
  const writtenDate = (String(fileDate || "").match(/\d{4}-\d{2}-\d{2}/) || [])[0] || new Date().toISOString().slice(0, 10);
  const customInstruction = String(userInstruction || "").trim().slice(0, 1000);
  const customBlock = customInstruction ? `\n\n[사용자 추가 지침 — 우선 반영]\n${customInstruction}\n` : "";
  const meetingDate = meetingDateFromName(audioFileName);
  const minutesSystem = buildMinutesSystemPrompt({ outLang, writtenDate, meetingDate, customBlock });

  let summary;
  if (needsMapReduce(transcript)) {
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

  const tm = summary.match(/##\s*회의 제목\s*\n+\s*([^\n]+)/);
  const title = resolveMeetingTitle(tm ? tm[1] : "", new Date());
  const km = summary.match(/##\s*주요 키워드\s*\n+\s*([^\n]+)/);
  const keywords = km ? km[1].trim() : "";
  return { summary, title, keywords };
}

// Drive 백업(회의록 + 원본 전사 + 메타 JSON). 실패해도 throw 하지 않고 error 문자열 반환(graceful).
export async function backupMinutesToDrive({ summary, transcript, title, keywords, audioFileName = "", audioSession = "" }) {
  let driveFileId = null, driveLink = null, driveError = null;
  const { Y, YM, YMD, HM } = dateParts();
  const fileBase = `${YMD}_${HM}_${String(title || "회의록").slice(0, 20)}`;
  try {
    const drive = getDrive();
    const folderId = await retry(() => ensurePath(drive, ["Meeting", Y, YM]));
    const up = await retry(() => uploadText(drive, folderId, `${fileBase}.txt`, summary));
    driveFileId = up.id;
    driveLink = up.webViewLink;
    try {
      const rawFolder = await ensurePath(drive, ["AI_Report", Y, YM]);
      await uploadText(drive, rawFolder, `${fileBase}_전사.txt`, transcript);
    } catch (e2) { /* 전사 백업 실패는 회의록 백업 성공과 무관 */ }
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
    } catch (e3) { /* 메타 미러 실패 무시 */ }
  } catch (e) {
    driveError = e.message;
  }
  return { driveFileId, driveLink, driveError };
}

// cl_meetings 저장(멱등: audio_session 이 이미 있으면 INSERT 생략하고 기존 id 반환).
// 실패해도 throw 하지 않고 error 문자열 반환(graceful) — 회의록 자체는 잡 레코드에 남는다.
export async function saveMeetingRecord({
  title, keywords, summary, transcript, transcriptRaw = "",
  driveFileId = "", driveLink = "", audioFileName = "", audioSession = "",
  audioDriveId = "", audioDriveLink = "",
}) {
  let meetingId = null, dbError = null;
  try {
    const pool = await getPool();
    const ins = await pool.request()
      .input("title", sql.NVarChar(300), title)
      .input("keywords", sql.NVarChar(500), keywords)
      .input("summary", sql.NVarChar(sql.MAX), summary)
      .input("transcript", sql.NVarChar(sql.MAX), transcript)
      .input("traw", sql.NVarChar(sql.MAX), transcriptRaw || "")
      .input("tc", sql.Int, transcript.length)
      .input("sc", sql.Int, summary.length)
      .input("fid", sql.NVarChar(200), driveFileId || "")
      .input("link", sql.NVarChar(500), driveLink || "")
      .input("audio", sql.NVarChar(300), audioFileName || "")
      .input("asession", sql.NVarChar(100), audioSession || "")
      .input("adid", sql.NVarChar(200), audioDriveId || "")
      .input("adlink", sql.NVarChar(500), audioDriveLink || "")
      .query(`
        INSERT INTO cl_meetings (title,keywords,summary,transcript,transcript_raw,transcript_chars,summary_chars,drive_file_id,drive_link,audio_file,audio_session,audio_drive_id,audio_drive_link)
        SELECT @title,@keywords,@summary,@transcript,@traw,@tc,@sc,@fid,@link,@audio,@asession,@adid,@adlink
        WHERE @asession = '' OR NOT EXISTS (SELECT 1 FROM cl_meetings WHERE audio_session=@asession)
        RETURNING id
      `);
    if (ins.recordset && ins.recordset[0]) {
      meetingId = ins.recordset[0].id;
    } else if (audioSession) {
      // 이미 존재(멱등 스킵) → 기존 id 조회
      const ex = await pool.request().input("asession", sql.NVarChar(100), audioSession)
        .query(`SELECT id FROM cl_meetings WHERE audio_session=@asession ORDER BY id ASC LIMIT 1`);
      meetingId = ex.recordset && ex.recordset[0] ? ex.recordset[0].id : null;
    }
  } catch (e) {
    dbError = e.message;
  }
  return { meetingId, dbError };
}

export default { LANG_NAMES, generateMinutes, backupMinutesToDrive, saveMeetingRecord };
