// api/worker.js - 백그라운드 전사 워커 (B3). 한 번에 미처리 청크 1개 처리, idempotent/resumable.
//   POST /api/worker?id=N
//   · DB의 chunks_done 기준 "다음 청크"를 재계산 → 어디서 끊겨도 resume (탭 닫힘 대비 B4)
//   · Drive에서 청크 받아 [선택 model]로 전사, timestamps 있으면 글로벌 offset 보정(A1)
//   · segments append, chunks_done++ (CAS 가드로 중복 처리 방지), 남으면 worker 재트리거
//   · 다 끝나면 status=summarizing → 화자(A4)+구조화요약(A5) → status=done
import { getPool, sql, CREATE_JOBS, parseJson } from "./_db.js";
import { getDrive, downloadFileById } from "./_drive.js";
import { transcribeBuffer } from "./_stt.js";
import { labelSpeakers, structuredSummary } from "./_analyze.js";

export const config = { maxDuration: 300 }; // 청크 1개 전사 커버

function baseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}
function retrigger(req, id) {
  try { fetch(`${baseUrl(req)}/api/worker?id=${encodeURIComponent(id)}`, { method: "POST" }).catch(() => {}); }
  catch (e) {}
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const id = parseInt(req.query.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "id 필요" });

  let pool;
  try { pool = await getPool(); }
  catch (e) { return res.status(200).json({ ok: false, message: "DB 연결 실패: " + e.message }); }

  try {
    const r = await pool.request().input("id", sql.BigInt, id)
      .query(`${CREATE_JOBS} SELECT * FROM transcribe_jobs WHERE job_id=@id`);
    const j = r.recordset[0];
    if (!j) return res.status(200).json({ ok: false, message: "작업 없음" });
    if (j.status === "done" || j.status === "error") return res.status(200).json({ ok: true, done: true, status: j.status });

    const refs = parseJson(j.chunk_refs, []);
    const total = j.chunks_total || refs.length;
    const cur = j.chunks_done || 0;

    // ── 남은 청크 처리 ──
    if (cur < total) {
      const ref = refs[cur];
      if (!ref || !ref.id) {
        await pool.request().input("id", sql.BigInt, id).input("e", sql.NVarChar(sql.MAX), `청크 ref 누락(index ${cur})`)
          .query("UPDATE transcribe_jobs SET status='error', error_msg=@e, updated_at=SYSUTCDATETIME() WHERE job_id=@id");
        return res.status(200).json({ ok: false, message: "청크 ref 누락" });
      }
      const offsetSec = refs.slice(0, cur).reduce((a, x) => a + (Number(x.durationSec) || 0), 0);
      const segs = parseJson(j.segments_json, []);
      const prevText = segs.length ? String(segs[segs.length - 1].text || "").slice(-200) : "";

      let result;
      try {
        const drive = getDrive();
        const buffer = await downloadFileById(drive, ref.id);
        result = await transcribeBuffer({ buffer, ext: ref.ext || ".wav", lang: j.language || "ko", model: j.model || "whisper-1", prevText, offsetSec });
      } catch (e) {
        // 이 청크만 실패 → 표시 세그먼트 넣고 계속(전체 중단 금지)
        result = { text: "", segments: [{ start: offsetSec, end: offsetSec, text: `[구간 ${cur + 1} 변환 실패: ${String(e.message || e).slice(0, 80)}]` }], duration: 0, hasTimestamps: false };
      }
      const newSegs = segs.concat(result.segments || []);
      const next = cur + 1;
      // CAS 가드: chunks_done이 여전히 cur일 때만 전진 → 동시 워커 중복 방지(idempotent)
      const upd = await pool.request()
        .input("id", sql.BigInt, id)
        .input("cur", sql.Int, cur)
        .input("next", sql.Int, next)
        .input("seg", sql.NVarChar(sql.MAX), JSON.stringify(newSegs))
        .query("UPDATE transcribe_jobs SET chunks_done=@next, segments_json=@seg, updated_at=SYSUTCDATETIME() WHERE job_id=@id AND chunks_done=@cur");
      if (!upd.rowsAffected[0]) return res.status(200).json({ ok: true, skipped: "다른 워커가 이미 진행" });

      if (next < total) { retrigger(req, id); return res.status(200).json({ ok: true, processed: next, total }); }
      // 마지막 청크였으면 아래 finalize로
    }

    // ── 모든 청크 완료 → 화자 + 요약 ──
    await pool.request().input("id", sql.BigInt, id)
      .query("UPDATE transcribe_jobs SET status='summarizing', updated_at=SYSUTCDATETIME() WHERE job_id=@id AND status<>'done'");
    const segs = parseJson(
      (await pool.request().input("id", sql.BigInt, id).query("SELECT segments_json FROM transcribe_jobs WHERE job_id=@id")).recordset[0]?.segments_json,
      []
    );
    const transcript = segs.map(s => s.text).join(" ").trim();
    let speakers = [], summary = null;
    try { speakers = await labelSpeakers(segs); } catch (e) { speakers = []; }
    try { summary = await structuredSummary(transcript, j.language || "ko"); } catch (e) { summary = null; }

    await pool.request()
      .input("id", sql.BigInt, id)
      .input("sp", sql.NVarChar(sql.MAX), JSON.stringify(speakers))
      .input("sm", sql.NVarChar(sql.MAX), summary ? JSON.stringify(summary) : null)
      .query("UPDATE transcribe_jobs SET status='done', speakers_json=@sp, summary_json=@sm, updated_at=SYSUTCDATETIME() WHERE job_id=@id");
    return res.status(200).json({ ok: true, done: true });
  } catch (e) {
    try {
      await pool.request().input("id", sql.BigInt, id).input("e", sql.NVarChar(sql.MAX), String(e.message || e).slice(0, 1000))
        .query("UPDATE transcribe_jobs SET status='error', error_msg=@e, updated_at=SYSUTCDATETIME() WHERE job_id=@id");
    } catch (e2) {}
    return res.status(200).json({ ok: false, message: "워커 오류: " + e.message });
  }
}
