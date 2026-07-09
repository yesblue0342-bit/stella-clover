// test/notes-body-cache.test.js — 노트 상세(action=get) 본문 캐시 경로 + save 의 body 기록 검증.
//   실제 Google 자격증명 없이 검증하기 위해 api/_drive.js 를 mock.module 로 완전히 대체한다
//   (node --experimental-test-module-mocks 필요 — package.json test 스크립트에 이미 반영).
//   mock.module 은 이 파일에서 처음 import 되는 시점부터 적용되므로, 파일 최상단(테스트 실행 전)에서
//   호출한다 — node --test 는 파일마다 별도 프로세스라 다른 테스트 파일의 모듈 캐시와 섞이지 않는다.
//   검증: (a) notes_meta.body 캐시 히트 시 getDrive 가 전혀 호출되지 않는다(Drive 미접근, 목표 성능개선의 핵심)
//        (b) 캐시 미스 시 Drive 폴백 후 notes_meta.body 를 백필해 다음 조회부터 캐시 히트가 된다
//        (c) save 액션이 Drive 저장과 같은 트랜잭션에서 notes_meta.body 도 함께 기록한다
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";

const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL 미설정 — 통합 테스트 skip";

const driveCalls = { getDrive: 0, readJsonById: 0, saveJsonToDrive: 0, findFileByName: 0 };
const FAKE_DRIVE_NOTE = {
  id: "itest-miss-note", userId: "clover", title: "미스 노트", body: "드라이브에서 온 본문",
  category: "노트", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deleted: false,
};

if (!SKIP) {
  process.env.GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "itest-dummy-token";
  mock.module("../api/_drive.js", {
    exports: {
      getDrive() { driveCalls.getDrive++; return { __fake: true }; },
      async findFileByName() { driveCalls.findFileByName++; return null; },
      async readJsonById() { driveCalls.readJsonById++; return FAKE_DRIVE_NOTE; },
      async saveJsonToDrive() { driveCalls.saveJsonToDrive++; return { id: "itest-fake-drive-id" }; },
      async listJsonInFolder() { return []; },
      async listJsonInFolderSince() { return []; },
    },
  });
}

after(async () => {
  if (SKIP) return;
  const { getPool } = await import("../api/_db.js");
  try { const pool = await getPool(); if (typeof pool.end === "function") await pool.end(); } catch { /* ignore */ }
});

function fakeRes() {
  return {
    _status: 200, _json: null,
    setHeader() {},
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
  };
}

async function waitForBody(pool, id, timeoutMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await pool.request().input("id", id).query(`SELECT body FROM notes_meta WHERE id=@id`);
    const body = r.recordset?.[0]?.body;
    if (body != null) return body;
    await new Promise(r2 => setTimeout(r2, 20));
  }
  return null;
}

test("get: notes_meta.body 캐시 히트 시 Drive 를 전혀 타지 않는다", { skip: SKIP }, async () => {
  const { getPool } = await import("../api/_db.js");
  const { default: handler } = await import("../api/notes.js");
  const pool = await getPool();
  const id = "itest-hit-note";
  await pool.request().input("id", id).query(`DELETE FROM notes_meta WHERE id=@id`);
  try {
    await pool.request().input("id", id).input("title", "히트 노트").input("body", "캐시된 본문")
      .query(`INSERT INTO notes_meta (id, title, preview, body, source, updated_at) VALUES (@id, @title, 'p', @body, 'itest', now())`);
    const before = driveCalls.getDrive;
    const t0 = Date.now();
    const req = { query: { action: "get", id }, body: {} };
    const res = fakeRes();
    await handler(req, res);
    const elapsed = Date.now() - t0;
    assert.equal(res._json.ok, true);
    assert.equal(res._json.item.body, "캐시된 본문");
    assert.equal(driveCalls.getDrive, before, "캐시 히트 시 getDrive 호출이 없어야 함");
    console.log(`[test] get(cache-hit) elapsed=${elapsed}ms`);
  } finally {
    await pool.request().input("id", id).query(`DELETE FROM notes_meta WHERE id=@id`);
  }
});

test("get: notes_meta.body 캐시 미스 시 Drive 폴백 + 백필(다음 조회부터 히트)", { skip: SKIP }, async () => {
  const { getPool } = await import("../api/_db.js");
  const { default: handler } = await import("../api/notes.js");
  const pool = await getPool();
  const id = FAKE_DRIVE_NOTE.id;
  await pool.request().input("id", id).query(`DELETE FROM notes_meta WHERE id=@id`);
  try {
    // driveFileId 는 있지만 body 는 아직 채워지지 않은 구노트 상태를 흉내(백필 이전).
    await pool.request().input("id", id).input("driveFileId", "itest-fake-drive-id")
      .query(`INSERT INTO notes_meta (id, drive_file_id, title, preview, source, updated_at) VALUES (@id, @driveFileId, 't', 'p', 'itest', now())`);
    const beforeReads = driveCalls.readJsonById;
    const req = { query: { action: "get", id }, body: {} };
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.item.body, FAKE_DRIVE_NOTE.body, "캐시 미스 시 Drive 응답 본문을 반환");
    assert.equal(driveCalls.readJsonById, beforeReads + 1, "캐시 미스 시 Drive 를 1회 읽어야 함");

    const backfilled = await waitForBody(pool, id);
    assert.equal(backfilled, FAKE_DRIVE_NOTE.body, "조회 후 notes_meta.body 가 백필되어야 함");

    // 백필 이후 재조회는 Drive 를 다시 타지 않아야 한다(캐시 히트로 전환).
    const beforeReads2 = driveCalls.readJsonById;
    const res2 = fakeRes();
    await handler({ query: { action: "get", id }, body: {} }, res2);
    assert.equal(res2._json.item.body, FAKE_DRIVE_NOTE.body);
    assert.equal(driveCalls.readJsonById, beforeReads2, "백필 후 재조회는 Drive 미접근");
  } finally {
    await pool.request().input("id", id).query(`DELETE FROM notes_meta WHERE id=@id`);
  }
});

test("save: Drive 저장과 함께 notes_meta.body 도 기록", { skip: SKIP }, async () => {
  const { getPool } = await import("../api/_db.js");
  const { default: handler } = await import("../api/notes.js");
  const pool = await getPool();
  const id = "itest-save-note";
  await pool.request().input("id", id).query(`DELETE FROM notes_meta WHERE id=@id`);
  try {
    const req = { query: { action: "save" }, body: { id, title: "저장 테스트", body: "저장된 본문입니다" } };
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res._json.ok, true);

    const r = await pool.request().input("id", id).query(`SELECT title, body FROM notes_meta WHERE id=@id`);
    assert.equal(r.recordset?.[0]?.body, "저장된 본문입니다", "save 가 notes_meta.body 를 함께 기록해야 함");
    assert.equal(r.recordset?.[0]?.title, "저장 테스트");

    // 저장 직후 상세 조회는 Drive 없이 바로 Postgres 캐시로 응답(방금 쓴 body).
    const before = driveCalls.getDrive;
    const res2 = fakeRes();
    await handler({ query: { action: "get", id }, body: {} }, res2);
    assert.equal(res2._json.item.body, "저장된 본문입니다");
    assert.equal(driveCalls.getDrive, before, "save 직후 get 도 캐시 히트라 Drive 미접근");
  } finally {
    await pool.request().input("id", id).query(`DELETE FROM notes_meta WHERE id=@id`);
  }
});
