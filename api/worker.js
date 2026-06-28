// api/worker.js - 워치독 엔드포인트(수동/크론 재개용).
//   POST /api/worker?id=N → 인프로세스 런타임에 해당 잡을 다시 큐잉(kick, 멱등) 후 현재 상태 반환.
//
// ※ Vercel 함수모델의 "한 청크 처리 후 HTTP 자기재호출" 패턴 제거. 실제 처리는 lib/jobs-runtime.js가
//   OCI 장수 프로세스 안에서 끝까지 수행한다. 이 엔드포인트는 멈춘 잡을 강제로 다시 펌프하는 용도.
import { getPool, sql, CREATE_JOBS, parseJson, hasDbConfig } from "./_db.js";
import { kick, runtimeStats } from "../lib/jobs-runtime.js";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const id = parseInt(req.query.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "id 필요" });
  if (!hasDbConfig()) return res.status(200).json({ ok: false, message: "DB 환경변수 미설정" });

  try {
    const pool = await getPool();
    const r = await pool.request().input("id", sql.BigInt, id)
      .query(`${CREATE_JOBS} SELECT job_id,status,chunks_total,chunks_done FROM transcribe_jobs WHERE job_id=@id`);
    const j = r.recordset[0];
    if (!j) return res.status(200).json({ ok: false, message: "작업 없음" });
    if (j.status === "done" || j.status === "error") {
      return res.status(200).json({ ok: true, done: true, status: j.status });
    }
    kick(id); // 인프로세스 재개(이미 실행 중이면 무시)
    return res.status(200).json({
      ok: true, kicked: true, status: j.status,
      chunks_done: j.chunks_done, chunks_total: j.chunks_total, runtime: runtimeStats()
    });
  } catch (e) {
    return res.status(200).json({ ok: false, message: "워커 오류: " + e.message });
  }
}
