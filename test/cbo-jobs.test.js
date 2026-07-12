// CBO Review 잡 실행기(lib/cbo-review/jobRuntime.js) 통합 테스트 — 실제 Postgres 필요(DATABASE_URL).
//   검증: 상태전이(queued→running→done/failed) / 동시 실행 1개 제한(큐잉) / 서버 재시작 복구
//   (running→failed 좀비 처리, queued→재투입). 실제 CLI/API 호출은 하지 않고 registerRunner로 대체한다.
import { test, after } from "node:test";
import assert from "node:assert/strict";

const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL 미설정 — 통합 테스트 skip";

// getPool 은 프로세스당 단일 풀을 캐시하므로, 개별 테스트가 아닌 전체 종료 시 한 번만 닫는다.
after(async () => {
  if (SKIP) return;
  const { getPool } = await import("../api/_db.js");
  try { const pool = await getPool(); if (typeof pool.end === "function") await pool.end(); } catch { /* ignore */ }
});

test("createJob은 등록되지 않은 kind를 DB 접근 없이 즉시 거부한다", async () => {
  const { createJob } = await import("../lib/cbo-review/jobRuntime.js");
  await assert.rejects(() => createJob({ kind: "no-such-kind-xyz", payload: {} }), /알 수 없는 잡 종류/);
});

test("잡 상태전이: queued → running → done, 결과가 result_json에 저장된다", { skip: SKIP }, async () => {
  const { registerRunner, createJob, getJob } = await import("../lib/cbo-review/jobRuntime.js");
  registerRunner("cbo-test-echo", async (payload) => ({ echoed: payload.value }));
  const id = await createJob({ kind: "cbo-test-echo", payload: { value: "hello" } });
  let job;
  for (let i = 0; i < 50; i++) {
    job = await getJob(id);
    if (job.status === "done" || job.status === "failed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(job.status, "done");
  assert.deepEqual(JSON.parse(job.result_json), { echoed: "hello" });
});

test("실행기가 throw하면 잡은 failed로 기록되고 error_msg가 남는다", { skip: SKIP }, async () => {
  const { registerRunner, createJob, getJob } = await import("../lib/cbo-review/jobRuntime.js");
  registerRunner("cbo-test-fail", async () => { throw new Error("의도된 실패"); });
  const id = await createJob({ kind: "cbo-test-fail", payload: {} });
  let job;
  for (let i = 0; i < 50; i++) {
    job = await getJob(id);
    if (job.status === "done" || job.status === "failed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(job.status, "failed");
  assert.match(job.error_msg, /의도된 실패/);
});

test("동시 실행은 1개로 제한된다(두 번째 잡은 첫 번째가 끝난 뒤 시작)", { skip: SKIP }, async () => {
  const { registerRunner, createJob, getJob } = await import("../lib/cbo-review/jobRuntime.js");
  const events = [];
  registerRunner("cbo-test-slow", async (payload) => {
    events.push(`start:${payload.tag}`);
    await new Promise((r) => setTimeout(r, 300));
    events.push(`end:${payload.tag}`);
    return { tag: payload.tag };
  });
  const id1 = await createJob({ kind: "cbo-test-slow", payload: { tag: "A" } });
  const id2 = await createJob({ kind: "cbo-test-slow", payload: { tag: "B" } });
  let job1, job2;
  for (let i = 0; i < 100; i++) {
    job1 = await getJob(id1); job2 = await getJob(id2);
    if (job1.status === "done" && job2.status === "done") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(job1.status, "done");
  assert.equal(job2.status, "done");
  assert.deepEqual(events, ["start:A", "end:A", "start:B", "end:B"], "B는 A가 끝난 뒤에만 시작되어야 한다(동시 1개 제한)");
});

test("recover(): running은 좀비로 간주해 failed 처리, queued는 재투입되어 완료까지 진행된다", { skip: SKIP }, async () => {
  const { getPool, sql } = await import("../api/_db.js");
  const { registerRunner, recover, getJob } = await import("../lib/cbo-review/jobRuntime.js");
  registerRunner("cbo-test-recover", async (payload) => ({ ok: true, tag: payload.tag }));
  const pool = await getPool();
  const insA = await pool.request().input("kind", sql.NVarChar(20), "cbo-test-recover")
    .input("payload", sql.NVarChar(sql.MAX), JSON.stringify({ tag: "zombie" }))
    .query(`INSERT INTO cbo_jobs (kind, status, payload_json) VALUES (@kind, 'running', @payload) RETURNING job_id`);
  const zombieId = insA.recordset[0].job_id;
  const insB = await pool.request().input("kind", sql.NVarChar(20), "cbo-test-recover")
    .input("payload", sql.NVarChar(sql.MAX), JSON.stringify({ tag: "resume" }))
    .query(`INSERT INTO cbo_jobs (kind, status, payload_json) VALUES (@kind, 'queued', @payload) RETURNING job_id`);
  const queuedId = insB.recordset[0].job_id;

  await recover();

  const zombie = await getJob(zombieId);
  assert.equal(zombie.status, "failed");
  assert.match(zombie.error_msg, /재시작/);

  let resumed;
  for (let i = 0; i < 50; i++) {
    resumed = await getJob(queuedId);
    if (resumed.status === "done" || resumed.status === "failed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(resumed.status, "done");
});
