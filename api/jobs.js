// api/jobs.js - 백그라운드 전사 작업 (B3)
//   POST /api/jobs           : 작업 생성(INSERT status=processing) + worker 1회 트리거 → { job_id }
//   GET  /api/jobs?id=N      : 상태/진행률/segments/speakers/summary
//   GET  /api/jobs?action=list&userId= : 사용자의 비종료(processing/summarizing) 작업 목록
// 모든 경로 항상 JSON 반환(프런트 safeJson과 짝). DB 콜드스타트는 _db.js 재시도로 흡수.
import { getPool, sql, parseJson, hasDbConfig } from "./_db.js";

export const config = { maxDuration: 30 };

function baseUrl(req) {
  // 신뢰 가능한 고정 베이스 우선(헤더 스푸핑/SSRF 방지). OCI 등 배포 환경에서 PUBLIC_BASE_URL 권장.
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, "");
  // 리버스 프록시(OCI LB 등) 뒤에서는 forwarded 헤더가 공개 호스트를 반영.
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}
// worker를 비차단으로 트리거 (응답 기다리지 않음)
function triggerWorker(req, jobId) {
  try { fetch(`${baseUrl(req)}/api/worker?id=${encodeURIComponent(jobId)}`, { method: "POST" }).catch(() => {}); }
  catch (e) { /* best-effort */ }
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!hasDbConfig()) {
    return res.status(200).json({ ok: false, message: "DB 환경변수 미설정 (DATABASE_URL 또는 PGHOST 확인)" });
  }
  try {
    const pool = await getPool();

    if (req.method === "POST") {
      const b = req.body || {};
      const userId = String(b.userId || "anon").slice(0, 128);
      const language = String(b.language || "ko").slice(0, 16);
      const model = String(b.model || "whisper-1").slice(0, 64);
      const chunkRefs = Array.isArray(b.chunkRefs) ? b.chunkRefs : [];
      const audioRef = b.audioRef || null;
      const title = String(b.title || "회의록").slice(0, 300);
      if (!chunkRefs.length) return res.status(400).json({ ok: false, message: "chunkRefs가 비어 있습니다." });

      const r = await pool.request()
        .input("uid", sql.NVarChar(128), userId)
        .input("lang", sql.NVarChar(16), language)
        .input("model", sql.NVarChar(64), model)
        .input("ct", sql.Int, chunkRefs.length)
        .input("refs", sql.NVarChar(sql.MAX), JSON.stringify(chunkRefs))
        .input("aref", sql.NVarChar(sql.MAX), audioRef ? JSON.stringify(audioRef) : null)
        .input("title", sql.NVarChar(300), title)
        .query(`
          INSERT INTO transcribe_jobs (user_id,language,model,status,chunks_total,chunks_done,chunk_refs,segments_json,audio_ref,title)
          VALUES (@uid,@lang,@model,'processing',@ct,0,@refs,'[]',@aref,@title)
          RETURNING job_id`);
      const jobId = r.recordset[0].job_id;
      triggerWorker(req, jobId);
      return res.status(200).json({ ok: true, job_id: jobId });
    }

    if (req.method === "GET") {
      const action = String(req.query.action || "");
      if (action === "list") {
        const userId = String(req.query.userId || "anon").slice(0, 128);
        const r = await pool.request().input("uid", sql.NVarChar(128), userId)
          .query(`
            SELECT job_id,title,status,chunks_total,chunks_done,model,language,updated_at
            FROM transcribe_jobs WHERE user_id=@uid AND status IN ('processing','summarizing')
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
      return res.status(200).json({
        ok: true,
        job: {
          job_id: j.job_id, status: j.status, model: j.model, language: j.language, title: j.title,
          chunks_total: j.chunks_total, chunks_done: j.chunks_done,
          progress: j.chunks_total ? Math.round((j.chunks_done / j.chunks_total) * 100) : 0,
          segments: merged,
          summary: parseJson(j.summary_json, null),
          audioRef: parseJson(j.audio_ref, null),
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
