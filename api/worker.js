// api/worker.js - 워치독 엔드포인트(수동/크론 재개용).
//   POST /api/worker?id=N → 인프로세스 런타임에 해당 잡을 다시 큐잉(kick, 멱등) 후 현재 상태 반환.
//
// ※ Vercel 함수모델의 "한 청크 처리 후 HTTP 자기재호출" 패턴 제거. 실제 처리는 lib/jobs-runtime.js가
//   OCI 장수 프로세스 안에서 끝까지 수행한다. 이 엔드포인트는 멈춘 잡을 강제로 다시 펌프하는 용도.
import { getPool, sql, hasDbConfig } from "./_db.js";
import { kick, runtimeStats } from "../lib/jobs-runtime.js";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const id = parseInt(req.query.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "id 필요" });
  if (!hasDbConfig()) return res.status(200).json({ ok: false, message: "DB 환경변수 미설정" });

  try {
    const pool = await getPool();
    const r = await pool.request().input("id", sql.BigInt, id)
      .query(`SELECT job_id,status,chunks_total,chunks_done,error_msg FROM transcribe_jobs WHERE job_id=@id`);
    const j = r.recordset[0];
    if (!j) return res.status(200).json({ ok: false, message: "작업 없음" });
    if (j.status === "error" && String(req.query.retry || "") === "1") {
      // 실패 잡 수동 재시도: 상태를 되돌리고 재큐잉. 전처리 전 실패(chunks_total=0)면 preparing 부터,
      // 그 외에는 processing 부터 — 완료된 단계는 산출물 컬럼 체크포인트(segments/corrected/minutes/
      // audio_drive_id)로 자동 스킵되므로 실패 지점(예: 원본 Drive 업로드)부터 이어서 진행된다.
      const back = j.chunks_total ? "processing" : "preparing";
      // 전 구간 STT 실패("텍스트를 추출하지 못했습니다")는 세그먼트가 실패 마커뿐이고 chunks_done 이
      // 이미 끝까지 전진해 있어, 되감지 않으면 재시도가 같은 오류를 결정적으로 반복한다(재전사 없음).
      // 이 실패 클래스는 교정/회의록 산출물이 없으므로(가드에서 중단) 청크 STT 를 처음부터 다시 돌린다
      // (청크 파일은 error 시 보존됨 — OpenAI 장애 복구 후 '다시 시도' 한 번으로 완주 가능).
      const sttWipe = /음성에서 텍스트를 추출하지 못했습니다/.test(String(j.error_msg || ""));
      if (sttWipe && j.chunks_total) {
        await pool.request().input("id", sql.BigInt, id)
          .query(`UPDATE transcribe_jobs SET status='processing', error_msg=NULL, chunks_done=0, segments_json='[]', updated_at=now() WHERE job_id=@id AND status='error'`);
      } else {
        await pool.request().input("id", sql.BigInt, id).input("st", sql.NVarChar(32), back)
          .query(`UPDATE transcribe_jobs SET status=@st, error_msg=NULL, updated_at=now() WHERE job_id=@id AND status='error'`);
      }
      kick(id);
      return res.status(200).json({ ok: true, retried: true, status: back, rewound: !!(sttWipe && j.chunks_total), runtime: runtimeStats() });
    }
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
