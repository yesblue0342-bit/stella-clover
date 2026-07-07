// api/jobs.js - 백그라운드 전사 작업 (B3)
//   POST /api/jobs (신규): { sessionId, partsTotal, fileName, ... } — 업로드된 원본 파트를 조립하고
//        잡 생성(status=preparing) 후 즉시 job_id 반환. 이후 STT→교정→회의록→Drive 보관 전 과정을
//        서버 백그라운드(lib/jobs-runtime)가 수행한다(탭 닫힘과 무관).
//   POST /api/jobs (레거시): { chunkRefs } — 구버전 클라이언트의 WAV 청크 잡(호환 유지).
//   GET  /api/jobs?id=N      : 상태/진행률/segments/회의록(minutes)/원본 Drive 링크
//   GET  /api/jobs?action=list&userId= : 진행 중 + 최근 실패 잡 목록(재접속 가시화)
// 모든 경로 항상 JSON 반환(프런트 safeJson과 짝). DB cold-start는 _db.js 재시도로 흡수.
import path from "path";
import { getPool, sql, parseJson, hasDbConfig } from "./_db.js";
import { assembleSource } from "../lib/chunkStore.js";
import { kick } from "../lib/jobs-runtime.js";

// ※ Vercel 함수모델 제거 — worker를 HTTP로 자기재호출하지 않고 OCI 인프로세스 런타임(kick)에 위임.
//   (진행 중 상태 목록의 단일 출처는 lib/jobs-runtime.ACTIVE_STATUSES.)

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!hasDbConfig()) {
    return res.status(200).json({ ok: false, message: "DB 환경변수 미설정" });
  }
  try {
    const pool = await getPool();

    if (req.method === "POST") {
      const b = req.body || {};
      const userId = String(b.userId || "anon").slice(0, 128);
      const language = String(b.language || "ko").slice(0, 16);
      const model = String(b.model || "whisper-1").slice(0, 64);
      const title = String(b.title || "회의록").slice(0, 300);
      const userInstruction = String(b.userInstruction || "").trim().slice(0, 1000);
      const fileDate = (String(b.fileDate || "").match(/\d{4}-\d{2}-\d{2}/) || [""])[0];

      // ── 신규: 원본 파일 파트 조립 → preparing 잡 (서버측 ffmpeg 전처리/전 과정 백그라운드) ──
      if (b.sessionId && b.partsTotal) {
        const sessionId = String(b.sessionId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
        if (!sessionId) return res.status(400).json({ ok: false, message: "잘못된 sessionId" });
        const fileName = String(b.fileName || "recording.webm").slice(0, 300);
        let assembled;
        try {
          assembled = await assembleSource({ sessionId, partsTotal: b.partsTotal, ext: path.extname(fileName).toLowerCase() });
        } catch (e) {
          return res.status(200).json({ ok: false, message: "원본 조립 실패: " + e.message });
        }
        const r = await pool.request()
          .input("uid", sql.NVarChar(128), userId)
          .input("lang", sql.NVarChar(16), language)
          .input("model", sql.NVarChar(64), model)
          .input("title", sql.NVarChar(300), title)
          .input("sess", sql.NVarChar(64), sessionId)
          .input("sname", sql.NVarChar(300), fileName)
          .input("fdate", sql.NVarChar(10), fileDate)
          .input("instr", sql.NVarChar(sql.MAX), userInstruction)
          .input("aref", sql.NVarChar(sql.MAX), JSON.stringify({ type: "source", ext: assembled.ext, bytes: assembled.bytes }))
          .query(`
            INSERT INTO transcribe_jobs (user_id,language,model,status,chunks_total,chunks_done,chunk_refs,segments_json,title,session_id,source_name,file_date,user_instruction,audio_ref)
            VALUES (@uid,@lang,@model,'preparing',0,0,'[]','[]',@title,@sess,@sname,@fdate,@instr,@aref)
            RETURNING job_id`);
        const jobId = r.recordset[0].job_id;
        kick(jobId); // 인프로세스 백그라운드 처리 시작(비차단). 즉시 job_id 반환 → 이후 탭 닫아도 무관.
        return res.status(200).json({ ok: true, job_id: jobId });
      }

      // ── 레거시: 클라이언트 WAV 청크 refs (구버전 앱 캐시 호환) ──
      const chunkRefs = Array.isArray(b.chunkRefs) ? b.chunkRefs : [];
      const audioRef = b.audioRef || null;
      if (!chunkRefs.length) return res.status(400).json({ ok: false, message: "chunkRefs가 비어 있습니다." });

      const r = await pool.request()
        .input("uid", sql.NVarChar(128), userId)
        .input("lang", sql.NVarChar(16), language)
        .input("model", sql.NVarChar(64), model)
        .input("ct", sql.Int, chunkRefs.length)
        .input("refs", sql.NVarChar(sql.MAX), JSON.stringify(chunkRefs))
        .input("aref", sql.NVarChar(sql.MAX), audioRef ? JSON.stringify(audioRef) : null)
        .input("title", sql.NVarChar(300), title)
        .input("instr", sql.NVarChar(sql.MAX), userInstruction)
        .query(`
          INSERT INTO transcribe_jobs (user_id,language,model,status,chunks_total,chunks_done,chunk_refs,segments_json,audio_ref,title,user_instruction)
          VALUES (@uid,@lang,@model,'processing',@ct,0,@refs,'[]',@aref,@title,@instr)
          RETURNING job_id`);
      const jobId = r.recordset[0].job_id;
      kick(jobId);
      return res.status(200).json({ ok: true, job_id: jobId });
    }

    if (req.method === "GET") {
      const action = String(req.query.action || "");
      if (action === "list") {
        const userId = String(req.query.userId || "anon").slice(0, 128);
        // 진행 중 전체 + 최근 3일 내 실패 잡(재접속 시 실패도 보이게 — 원인 확인/재시도 유도).
        const r = await pool.request().input("uid", sql.NVarChar(128), userId)
          .query(`
            SELECT job_id,title,status,chunks_total,chunks_done,model,language,error_msg,updated_at
            FROM transcribe_jobs
            WHERE user_id=@uid AND (status IN ('preparing','processing','correcting','summarizing','uploading')
                                    OR (status='error' AND updated_at > now() - interval '3 days'))
            ORDER BY job_id DESC LIMIT 20`);
        return res.status(200).json({ ok: true, jobs: r.recordset || [] });
      }
      const id = parseInt(req.query.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "id 필요" });
      const r = await pool.request().input("id", sql.BigInt, id)
        .query(`SELECT * FROM transcribe_jobs WHERE job_id=@id`);
      const j = r.recordset[0];
      if (!j) return res.status(200).json({ ok: false, message: "작업을 찾을 수 없습니다." });
      const segments = parseJson(j.segments_json, []);
      const speakers = parseJson(j.speakers_json, []);
      // segment에 speaker 병합(있으면)
      const merged = segments.map((s, i) => speakers[i] ? { ...s, speaker: speakers[i] } : s);
      // 회의록/교정 전사 같은 무거운 본문은 종료 상태에서만 내려보낸다 — 3초 폴링이 수백 KB 를 반복 수신하지 않게(모바일 데이터 절약).
      const terminal = j.status === "done" || j.status === "error";
      return res.status(200).json({
        ok: true,
        job: {
          job_id: j.job_id, status: j.status, model: j.model, language: j.language, title: j.title,
          chunks_total: j.chunks_total, chunks_done: j.chunks_done,
          progress: j.chunks_total ? Math.round((j.chunks_done / j.chunks_total) * 100) : 0,
          segments: terminal ? merged : [],
          summary: terminal ? parseJson(j.summary_json, null) : null,
          chunkRefs: parseJson(j.chunk_refs, []), // 세그먼트 클릭 재생용(청크별 /api/audio)
          audioRef: parseJson(j.audio_ref, null),
          // 서버측 마무리 산출물(신규): 회의록/제목/키워드/교정 전사/원본 Drive 링크/이력 레코드 id
          minutes: terminal ? (j.minutes_md || null) : null,
          meetingTitle: j.meeting_title || null,
          keywords: j.keywords || null,
          correctedText: terminal ? (j.corrected_text || null) : null,
          meetingId: j.meeting_id || null,
          audioDriveId: j.audio_drive_id || null,
          audioDriveLink: j.audio_drive_link || null,
          error: j.error_msg || null,
          updated_at: j.updated_at,
        }
      });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, message: "Method Not Allowed" });
  } catch (e) {
    return res.status(200).json({ ok: false, message: "작업 처리 오류: " + e.message });
  }
}
