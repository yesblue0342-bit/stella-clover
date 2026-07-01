// lib/jobs-runtime.js — 백그라운드 전사 워커 (OCI 인프로세스 런타임)
//
// ※ Vercel 함수모델(응답 후 종료) 의존 제거. OCI 우분투 서버는 장수 프로세스이므로
//   "한 청크 처리→HTTP 자기재호출" 대신 인프로세스 루프로 남은 청크를 끝까지 처리한다.
//   - DB(transcribe_jobs)에 진행률 영속 → 상태조회/재시작 복구 가능.
//   - chunks_done CAS 가드로 동시 워커(워치독·복구) 중복 처리 방지(멱등).
//   - 동시 실행 잡 수 상한(JOBS_CONCURRENCY, 기본 2) + 대기 큐 → OOM/과부하 방지.
//   - 한 청크 실패해도 전체 중단 안 함([구간 N 변환 실패] 표시 후 계속).
import { getPool, sql, parseJson } from "../api/_db.js";
import { getDrive, downloadFileById } from "../api/_drive.js";
import { isLocalRef, readChunk, deleteSession, sessionOfRefs } from "./chunkStore.js";
import { transcribeBuffer } from "../api/_stt.js";
import { labelSpeakers, structuredSummary } from "../api/_analyze.js";

const MAX_CONCURRENT = Math.max(1, Number(process.env.JOBS_CONCURRENCY || 2));
const active = new Set();   // 현재 실행 중인 job_id
const queued = new Set();   // 대기 큐에 든 job_id (중복 enqueue 방지)
const waiting = [];         // 순서 보장용 배열

// 앞 청크들의 누적 실제 길이 → 글로벌 타임라인 offset (A1). 순수 함수(단위 테스트 가능).
export function computeOffsetSec(refs, cur) {
  if (!Array.isArray(refs)) return 0;
  return refs.slice(0, cur).reduce((a, x) => a + (Number(x && x.durationSec) || 0), 0);
}

// 큐에 넣고 펌프. 이미 실행/대기 중이면 무시(멱등). 외부(jobs.js POST·worker.js 워치독·복구)에서 호출.
export function kick(id) {
  const jid = Number(id);
  if (!Number.isInteger(jid)) return;
  if (active.has(jid) || queued.has(jid)) return;
  queued.add(jid);
  waiting.push(jid);
  pump();
}

function pump() {
  while (active.size < MAX_CONCURRENT && waiting.length) {
    const jid = waiting.shift();
    queued.delete(jid);
    active.add(jid);
    runJob(jid)
      .catch(() => { /* runJob 내부에서 이미 error 기록 */ })
      .finally(() => { active.delete(jid); pump(); });
  }
}

// 한 잡의 남은 청크를 끝까지 처리하고 마무리(요약)까지. 멱등/재진입 안전.
async function runJob(id) {
  let pool;
  try { pool = await getPool(); }
  catch (e) { console.warn("[jobs] DB 연결 실패 job", id, e && e.message); return; }

  try {
  // ── 청크 루프 ──
  // 매 반복마다 DB에서 cur를 다시 읽어 어디서 끊겨도 resume. CAS 실패 시 다른 워커가 잡았으므로 종료.
  // (안전 상한: chunks_total + 5회 — 무한루프 방지)
  let guard = 0;
  while (true) {
    if (guard++ > 100000) { console.warn("[jobs] guard 초과 job", id); return; }
    const r = await pool.request().input("id", sql.BigInt, id)
      .query(`SELECT * FROM transcribe_jobs WHERE job_id=@id`);
    const j = r.recordset[0];
    if (!j) return;
    if (j.status === "done" || j.status === "error") return;

    const refs = parseJson(j.chunk_refs, []);
    const total = j.chunks_total || refs.length;
    const cur = j.chunks_done || 0;

    if (cur >= total) break; // 모든 청크 완료 → 마무리로

    const ref = refs[cur];
    if (!ref || !ref.id) {
      await pool.request().input("id", sql.BigInt, id).input("e", sql.NVarChar(sql.MAX), `청크 ref 누락(index ${cur})`)
        .query("UPDATE transcribe_jobs SET status='error', error_msg=@e, updated_at=now() WHERE job_id=@id");
      return;
    }

    const offsetSec = computeOffsetSec(refs, cur);
    const segs = parseJson(j.segments_json, []);
    const prevText = segs.length ? String(segs[segs.length - 1].text || "").slice(-200) : "";

    let result;
    try {
      // 로컬 청크(신규 기본)는 디스크에서 직접 읽고, 레거시 Drive ref(in-flight 잡)만 Drive 에서 내려받는다.
      const buffer = isLocalRef(ref.id)
        ? await readChunk(ref.id)
        : await downloadFileById(getDrive(), ref.id);
      result = await transcribeBuffer({ buffer, ext: ref.ext || ".wav", lang: j.language || "ko", model: j.model || "whisper-1", prevText, offsetSec });
    } catch (e) {
      // 이 청크만 실패 → 표시 세그먼트 넣고 계속(전체 중단 금지)
      result = { text: "", segments: [{ start: offsetSec, end: offsetSec, text: `[구간 ${cur + 1} 변환 실패: ${String(e.message || e).slice(0, 80)}]` }], duration: 0, hasTimestamps: false };
    }
    // 타임스탬프 미지원 모델(gpt-4o-*-transcribe)은 segments=[]·text만 반환 → text를 세그먼트로 합성(누락 방지).
    const rs = (result.segments && result.segments.length)
      ? result.segments
      : (result.text ? [{ start: offsetSec, end: offsetSec, text: result.text }] : []);
    const newSegs = segs.concat(rs);
    const next = cur + 1;
    // CAS 가드: chunks_done이 여전히 cur일 때만 전진 → 동시 워커 중복 방지(idempotent)
    const upd = await pool.request()
      .input("id", sql.BigInt, id)
      .input("cur", sql.Int, cur)
      .input("next", sql.Int, next)
      .input("seg", sql.NVarChar(sql.MAX), JSON.stringify(newSegs))
      .query("UPDATE transcribe_jobs SET chunks_done=@next, segments_json=@seg, updated_at=now() WHERE job_id=@id AND chunks_done=@cur");
    if (!upd.rowsAffected[0]) return; // 다른 워커가 이미 진행 → 양보
    // 다음 청크 계속(루프)
  }

  // ── 모든 청크 완료 → 화자 + 요약 ──
  await pool.request().input("id", sql.BigInt, id)
    .query("UPDATE transcribe_jobs SET status='summarizing', updated_at=now() WHERE job_id=@id AND status<>'done'");
  const fin = (await pool.request().input("id", sql.BigInt, id)
    .query("SELECT segments_json, language FROM transcribe_jobs WHERE job_id=@id")).recordset[0] || {};
  const segs = parseJson(fin.segments_json, []);
  const lang = fin.language || "ko"; // 요약 언어 = 사용자가 고른 회의 언어
  const transcript = segs.map(s => s.text).join(" ").trim();
  let speakers = [], summary = null;
  try { speakers = await labelSpeakers(segs); } catch (e) { speakers = []; }
  try { summary = await structuredSummary(transcript, lang); } catch (e) { summary = null; }

  await pool.request()
    .input("id", sql.BigInt, id)
    .input("sp", sql.NVarChar(sql.MAX), JSON.stringify(speakers))
    .input("sm", sql.NVarChar(sql.MAX), summary ? JSON.stringify(summary) : null)
    .query("UPDATE transcribe_jobs SET status='done', speakers_json=@sp, summary_json=@sm, updated_at=now() WHERE job_id=@id");

  // ★ 전사 완료 → 로컬 청크(원본) 즉시 삭제로 OCI 디스크 용량 관리. (텍스트/요약은 DB·Drive 에 보존)
  try {
    const jr = (await pool.request().input("id", sql.BigInt, id).query("SELECT chunk_refs FROM transcribe_jobs WHERE job_id=@id")).recordset[0];
    const sess = sessionOfRefs(parseJson(jr && jr.chunk_refs, []));
    if (sess) { const n = await deleteSession(sess); if (n) console.log(`[jobs] 완료 청크 정리 job ${id}: ${n}개 삭제(sess ${sess})`); }
  } catch (e) { /* 청크 정리 실패는 무시(일일 cleanup 이 백업으로 회수) */ }
  } catch (e) {
    // 처리/마무리 중 예외 → 잡을 error로 마킹(요약 단계에서 멈춰 'summarizing'에 갇히는 회귀 방지).
    try {
      await pool.request().input("id", sql.BigInt, id).input("e", sql.NVarChar(sql.MAX), String((e && e.message) || e).slice(0, 1000))
        .query("UPDATE transcribe_jobs SET status='error', error_msg=@e, updated_at=now() WHERE job_id=@id AND status<>'done'");
    } catch (e2) { /* 에러 기록 실패는 무시 */ }
    console.warn("[jobs] 처리 오류 job", id, e && e.message);
  }
}

// 워치독: 외부에서 한 잡을 강제로 다시 펌프(멱등). worker.js 엔드포인트가 사용.
export function watchdog(id) { kick(id); }

// 서버 부팅 시: DB에서 미완료(processing/summarizing) 잡을 모두 다시 큐에 넣어 자동 재개(탭/서버 재시작 무관).
export async function recover() {
  try {
    const pool = await getPool();
    const r = await pool.request()
      .query(`SELECT job_id FROM transcribe_jobs WHERE status IN ('processing','summarizing') ORDER BY job_id ASC`);
    const ids = (r.recordset || []).map(x => Number(x.job_id)).filter(Number.isInteger);
    ids.forEach(kick);
    if (ids.length) console.log(`[jobs] 부팅 복구: 미완료 잡 ${ids.length}건 재개`, ids.slice(0, 20));
    return ids.length;
  } catch (e) {
    console.warn("[jobs] 부팅 복구 실패(무시):", e && e.message);
    return 0;
  }
}

// 진단용 현재 상태(시크릿 없음).
export function runtimeStats() {
  return { maxConcurrent: MAX_CONCURRENT, active: active.size, queued: waiting.length };
}
