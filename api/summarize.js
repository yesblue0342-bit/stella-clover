// api/summarize.js - 텍스트 → AI 회의록 + Drive 저장 + Postgres(전문 저장)
//
// ※ 백그라운드 전사 잡의 회의록 생성은 이제 서버 워커(lib/jobs-runtime → lib/minutes)가 수행한다
//   (창 닫힘과 무관하게 완결). 이 엔드포인트는 OCR 텍스트 회의록과 레거시(구버전 캐시) 클라이언트
//   호환용으로 유지되며, 같은 코어(lib/minutes.js)를 호출한다 — 로직 단일 출처.
import { prepareTranscript } from "./_meeting.js";
import { getPool, sql, hasDbConfig } from "./_db.js";
import { generateMinutes, backupMinutesToDrive, saveMeetingRecord } from "../lib/minutes.js";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST only" });

  const { transcript: rawTranscript, audioFileName, sessionId, lang, userInstruction, fileDate } = req.body || {};
  // 전사 전체 사용(잘림 없음). 합본 원본을 회의록·요약 입력으로 그대로 전달.
  const transcript = prepareTranscript(rawTranscript);
  if (!transcript?.trim()) return res.status(400).json({ ok: false, message: "회의 내용이 없습니다." });
  const audioSession = (sessionId || "").toString().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

  // 멱등 쇼트서킷: 같은 세션의 회의록이 이미 있으면(예: 서버 워커가 이미 완결한 잡을 구버전 캐시
  // 클라이언트가 다시 마무리하려는 경우) LLM/Drive 를 재실행하지 않고 기존 결과를 그대로 반환.
  // 구버전 '이어보기' 경로는 실제 세션 대신 'resume_<jobId>' 를 보낸다(meta 유실/타 기기) —
  // 그대로 두면 세션 불일치로 쇼트서킷을 놓쳐 이력이 중복 저장되므로, 잡의 실제 세션으로 치환해 조회.
  if (audioSession && hasDbConfig()) {
    try {
      const pool = await getPool();
      let lookupSession = audioSession;
      const rm = audioSession.match(/^resume_(\d+)$/);
      if (rm) {
        const jr = await pool.request().input("jid", sql.BigInt, parseInt(rm[1], 10))
          .query(`SELECT session_id, chunk_refs FROM transcribe_jobs WHERE job_id=@jid`);
        const job = jr.recordset && jr.recordset[0];
        if (job) {
          const real = String(job.session_id || "")
            || ((String(job.chunk_refs || "").match(/local:([A-Za-z0-9_.-]+)\//) || [])[1] || "");
          if (real) lookupSession = real;
        }
      }
      const ex = await pool.request().input("s", sql.NVarChar(100), lookupSession)
        .query(`SELECT id,title,keywords,summary,drive_file_id,drive_link FROM cl_meetings WHERE audio_session=@s ORDER BY id ASC LIMIT 1`);
      const it = ex.recordset && ex.recordset[0];
      if (it) {
        return res.status(200).json({
          ok: true, summary: it.summary || "", title: it.title || "", keywords: it.keywords || "",
          driveFileId: it.drive_file_id || null, driveLink: it.drive_link || null,
          warnings: { driveError: null, dbError: null }, deduped: true,
        });
      }
    } catch (e) { /* 조회 실패 시 기존 경로로 정상 생성(쇼트서킷은 최적화일 뿐) */ }
  }

  // 1. AI 회의록 — 전사 전체를 입력으로 사용(잘림 없음). 너무 길면 map-reduce(부분요약→통합)로 누락 0.
  let minutes;
  try {
    minutes = await generateMinutes({
      transcript, lang,
      audioFileName: audioFileName || "",
      fileDate: fileDate || "",
      userInstruction: userInstruction || "",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: "AI 회의록 생성 실패: " + e.message });
  }
  const { summary, title, keywords } = minutes;

  // 2. Google Drive 저장 (회의록 + 원본 전사 + 메타데이터 JSON) — 실패해도 graceful(warnings).
  const bk = await backupMinutesToDrive({ summary, transcript, title, keywords, audioFileName: audioFileName || "", audioSession });

  // 3. Postgres - 전문 저장 (키워드 검색용). 멱등: 같은 audio_session 이 있으면 INSERT 생략.
  const sv = await saveMeetingRecord({
    title, keywords, summary, transcript,
    driveFileId: bk.driveFileId || "", driveLink: bk.driveLink || "",
    audioFileName: audioFileName || "", audioSession,
  });

  return res.status(200).json({
    ok: true, summary, title, keywords, driveFileId: bk.driveFileId, driveLink: bk.driveLink,
    warnings: { driveError: bk.driveError, dbError: sv.dbError }
  });
}
