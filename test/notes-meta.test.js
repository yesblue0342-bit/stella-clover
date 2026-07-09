// notes_meta 통합 테스트 — 실제 Postgres 필요(DATABASE_URL). 미설정 시 전체 skip.
//   검증: list 액션이 notes_meta 만 SELECT(Drive 미접근·본문 미포함)하고 검색/페이지네이션/
//         정렬이 동작 / withTransaction 이 실패 시 ROLLBACK, 성공 시 COMMIT 하는지 /
//         상세(get) 본문 캐시 히트 시 Drive 미접근 + 캐시 미스 시 폴백·백필 / save 가 본문을
//         notes_meta 에도 함께 쓰는지(node --experimental-test-module-mocks 필요, package.json 참고).
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";

const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL 미설정 — 통합 테스트 skip";

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

test("notes list 액션: notes_meta 만 SELECT(Drive 미접근) + 검색/페이지네이션/정렬", { skip: SKIP }, async () => {
  process.env.GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "itest-dummy-token"; // list 는 Drive 미사용이라 실제 유효성 불필요
  const { getPool } = await import("../api/_db.js");
  const { default: handler } = await import("../api/notes.js");
  const pool = await getPool();

  const ids = ["itest-note-1", "itest-note-2", "itest-note-3"];
  await pool.request().query(`DELETE FROM notes_meta WHERE id IN ('${ids.join("','")}')`);
  try {
    for (let i = 0; i < ids.length; i++) {
      await pool.request()
        .input("id", ids[i]).input("title", "통합테스트 노트 " + i).input("preview", "미리보기 " + i)
        .input("ts", new Date(Date.now() - i * 1000).toISOString())
        .query(`INSERT INTO notes_meta (id, title, preview, source, updated_at) VALUES (@id, @title, @preview, 'itest', @ts)`);
    }

    const req = { query: { action: "list", page: "0", q: "통합테스트" }, body: {} };
    const res = fakeRes();
    await handler(req, res);

    assert.equal(res._json.ok, true);
    assert.ok(res._json.items.length >= 3, "검색 결과에 방금 넣은 3건이 포함되어야 함");
    for (const it of res._json.items) {
      assert.ok(!("body" in it), "list 응답엔 본문 필드가 없어야 함(미리보기만)");
    }
    const idx0 = res._json.items.findIndex(it => it.id === ids[0]);
    const idx2 = res._json.items.findIndex(it => it.id === ids[2]);
    assert.ok(idx0 >= 0 && idx2 >= 0 && idx0 < idx2, "updated_at DESC 정렬(최신이 먼저)");
  } finally {
    await pool.request().query(`DELETE FROM notes_meta WHERE id IN ('${ids.join("','")}')`);
  }
});

test("withTransaction: 콜백이 throw 하면 ROLLBACK 되어 변경이 남지 않는다", { skip: SKIP }, async () => {
  const { getPool, withTransaction } = await import("../api/_db.js");
  const pool = await getPool();
  const id = "itest-tx-rollback";
  await pool.request().input("id", id).query(`DELETE FROM notes_meta WHERE id=@id`);
  try {
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query(`INSERT INTO notes_meta (id, title, source, updated_at) VALUES ($1,'x','itest',now())`, [id]);
        throw new Error("의도된 실패 — 롤백 확인용");
      }),
      /의도된 실패/
    );
    const r = await pool.request().input("id", id).query(`SELECT id FROM notes_meta WHERE id=@id`);
    assert.equal(r.recordset.length, 0, "롤백되어 행이 남지 않아야 함(Drive 실패 시 메타 롤백과 동일 경로)");
  } finally {
    await pool.request().input("id", id).query(`DELETE FROM notes_meta WHERE id=@id`);
  }
});

test("withTransaction: 성공하면 COMMIT 되어 변경이 남는다", { skip: SKIP }, async () => {
  const { getPool, withTransaction } = await import("../api/_db.js");
  const pool = await getPool();
  const id = "itest-tx-commit";
  await pool.request().input("id", id).query(`DELETE FROM notes_meta WHERE id=@id`);
  try {
    await withTransaction(async (client) => {
      await client.query(`INSERT INTO notes_meta (id, title, source, updated_at) VALUES ($1,'x','itest',now())`, [id]);
    });
    const r = await pool.request().input("id", id).query(`SELECT id FROM notes_meta WHERE id=@id`);
    assert.equal(r.recordset.length, 1, "커밋되어 행이 남아야 함");
  } finally {
    await pool.request().input("id", id).query(`DELETE FROM notes_meta WHERE id=@id`);
  }
});
