// lib/cbo-review/jobRuntime.js — CBO Review(스펙 생성/코드 리뷰) 비동기 잡 실행기.
//
// transcribe 잡(lib/jobs-runtime.js)과 같은 패턴(DB 영속 상태 + 인프로세스 큐 + kick)을 재사용하되,
// CBO 잡은 청크 재개가 없는 단발성 LLM 호출이라 훨씬 단순하다:
//   queued → running → done | failed. 재시도/이어하기 없음(실패 시 프론트에서 재요청).
// 동시 실행 1개 고정 — claude/codex CLI 서브프로세스 중복 실행 방지(계정 로그인 구독 한도 보호).
// CLI 프로세스 자체의 하드킬 타임아웃(15분)은 lib/cbo-review/providers.js runCli 에 있다 —
// 여기서는 그 결과(성공/타임아웃 에러)를 받아 잡 상태에 반영만 한다(중복 타임아웃 래핑 없음).
import { getPool, sql } from "../../api/_db.js";

const MAX_CONCURRENT = 1; // CLI 계정 로그인 경로는 동시 다중 실행을 지원하지 않음(요청사항).
const active = new Set();
const queued = new Set();
const waiting = [];
const runners = new Map(); // kind → async (payload) => result(JSON-직렬화 가능 객체)

// kind별 실행 함수 등록. api/cbo-review.js가 모듈 로드 시 1회 등록한다.
export function registerRunner(kind, fn) {
  runners.set(kind, fn);
}

async function setJob(pool, id, fields) {
  const req = pool.request().input("id", sql.BigInt, id);
  const sets = [];
  let i = 0;
  for (const [k, v] of Object.entries(fields)) {
    const p = "p" + (i++);
    req.input(p, sql.NVarChar(sql.MAX), v);
    sets.push(`${k}=@${p}`);
  }
  await req.query(`UPDATE cbo_jobs SET ${sets.join(", ")}, updated_at=now() WHERE job_id=@id`);
}

// 잡 레코드 생성 후 큐에 투입. HTTP 핸들러는 이 함수가 반환하는 즉시 job_id를 응답한다(수 초 내 종료).
export async function createJob({ kind, payload }) {
  if (!runners.has(kind)) throw new Error(`알 수 없는 잡 종류: ${kind}`);
  const pool = await getPool();
  const r = await pool.request()
    .input("kind", sql.NVarChar(20), kind)
    .input("payload", sql.NVarChar(sql.MAX), JSON.stringify(payload))
    .query(`INSERT INTO cbo_jobs (kind, status, payload_json) VALUES (@kind, 'queued', @payload) RETURNING job_id`);
  const jobId = r.recordset[0].job_id;
  kick(jobId);
  return jobId;
}

// 큐에 넣고 펌프. 이미 실행/대기 중이면 무시(멱등) — 워치독·부팅 복구에서도 안전하게 재호출 가능.
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
      .catch(() => { /* runJob 내부에서 이미 실패 기록 */ })
      .finally(() => { active.delete(jid); pump(); });
  }
}

async function runJob(id) {
  let pool;
  try { pool = await getPool(); }
  catch (e) { console.warn("[cbo-jobs] DB 연결 실패 job", id, e && e.message); return; }

  const row = (await pool.request().input("id", sql.BigInt, id)
    .query(`SELECT * FROM cbo_jobs WHERE job_id=@id`)).recordset[0];
  if (!row || row.status !== "queued") return; // 이미 처리됐거나 존재하지 않음(중복 kick 방지)

  await setJob(pool, id, { status: "running" });
  await pool.request().input("id", sql.BigInt, id).query(`UPDATE cbo_jobs SET started_at=now() WHERE job_id=@id`);

  const runner = runners.get(row.kind);
  let payload;
  try { payload = JSON.parse(row.payload_json || "{}"); }
  catch { payload = {}; }

  try {
    if (!runner) throw new Error(`알 수 없는 잡 종류: ${row.kind}`);
    const result = await runner(payload);
    await pool.request().input("id", sql.BigInt, id)
      .input("r", sql.NVarChar(sql.MAX), JSON.stringify(result ?? null))
      .query(`UPDATE cbo_jobs SET status='done', result_json=@r, finished_at=now(), updated_at=now() WHERE job_id=@id`);
  } catch (e) {
    await pool.request().input("id", sql.BigInt, id)
      .input("e", sql.NVarChar(sql.MAX), String((e && e.message) || e).slice(0, 1000))
      .query(`UPDATE cbo_jobs SET status='failed', error_msg=@e, finished_at=now(), updated_at=now() WHERE job_id=@id`);
    console.warn("[cbo-jobs] 처리 실패 job", id, e && e.message);
  }
}

// 잡 상태 조회(폴링용). 존재하지 않으면 null.
export async function getJob(id) {
  const jid = Number(id);
  if (!Number.isInteger(jid)) return null;
  const pool = await getPool();
  const row = (await pool.request().input("id", sql.BigInt, jid)
    .query(`SELECT * FROM cbo_jobs WHERE job_id=@id`)).recordset[0];
  return row || null;
}

// 서버 부팅 시 호출(server.mjs). 좀비 잡(재시작으로 유실된 실행 중 CLI 프로세스) 방지:
//  · running → failed 로 마킹(재개 불가 — 클라이언트가 다시 요청해야 함).
//  · queued  → 아직 아무 작업도 하지 않았으므로 안전하게 재투입(kick)만 하면 이어서 처리됨.
export async function recover() {
  try {
    const pool = await getPool();
    await pool.request().query(`
      UPDATE cbo_jobs SET status='failed', error_msg='서버 재시작으로 중단되었습니다. 다시 요청해주세요.', finished_at=now(), updated_at=now()
      WHERE status='running'`);
    const r = await pool.request().query(`SELECT job_id FROM cbo_jobs WHERE status='queued' ORDER BY job_id ASC`);
    const ids = (r.recordset || []).map((x) => Number(x.job_id)).filter(Number.isInteger);
    ids.forEach(kick);
    if (ids.length) console.log(`[cbo-jobs] 부팅 복구: 대기 중 잡 ${ids.length}건 재개`, ids.slice(0, 20));
    return ids.length;
  } catch (e) {
    console.warn("[cbo-jobs] 부팅 복구 실패(무시):", e && e.message);
    return 0;
  }
}

// 진단용 현재 상태(시크릿 없음).
export function runtimeStats() {
  return { maxConcurrent: MAX_CONCURRENT, active: active.size, queued: waiting.length };
}
