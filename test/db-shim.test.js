// _db.js mssql 호환 셰임 단위 테스트 — @name→$n 변환(중복 이름 재사용) + recordset/rowsAffected 매핑.
// 실제 DB 불필요: 가짜 pg 풀을 주입해 변환된 SQL/값 배열을 캡처한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeShimPool, sql, parseJson } from "../api/_db.js";

test("셰임: @name→$n 변환 + 중복 이름 동일 $n 재사용 + 값 배열 순서(첫 등장 기준)", async () => {
  let captured;
  const fakePg = {
    query: async (text, values) => { captured = { text, values }; return { rows: [{ job_id: 7 }], rowCount: 1 }; },
  };
  const pool = makeShimPool(fakePg);
  const r = await pool.request()
    .input("id", sql.BigInt, 7)
    .input("e", sql.NVarChar(sql.MAX), "boom")
    .query("UPDATE transcribe_jobs SET error_msg=@e, updated_at=now() WHERE job_id=@id AND prev=@id");

  // 텍스트 내 첫 등장 순서: @e→$1, @id→$2 (재등장 @id 는 $2 재사용)
  assert.equal(captured.text, "UPDATE transcribe_jobs SET error_msg=$1, updated_at=now() WHERE job_id=$2 AND prev=$2");
  assert.deepEqual(captured.values, ["boom", 7]);
  // mssql 호환 반환 형태
  assert.deepEqual(r.recordset, [{ job_id: 7 }]);
  assert.equal(r.rowsAffected[0], 1);
  assert.equal(r.rowCount, 1);
});

test("셰임: 파라미터 없는 쿼리도 동작(값 배열 빈 배열)", async () => {
  let captured;
  const fakePg = { query: async (text, values) => { captured = { text, values }; return { rows: [], rowCount: 0 }; } };
  const pool = makeShimPool(fakePg);
  const r = await pool.request().query("SELECT 1 AS x");
  assert.equal(captured.text, "SELECT 1 AS x");
  assert.deepEqual(captured.values, []);
  assert.deepEqual(r.recordset, []);
  assert.equal(r.rowsAffected[0], 0);
});

test("셰임: .input(name, value) 2-인자 형태(타입 생략)도 허용", async () => {
  let captured;
  const fakePg = { query: async (text, values) => { captured = { text, values }; return { rows: [], rowCount: 1 }; } };
  const pool = makeShimPool(fakePg);
  await pool.request().input("uid", "anon").query("SELECT * FROM t WHERE user_id=@uid");
  assert.equal(captured.text, "SELECT * FROM t WHERE user_id=$1");
  assert.deepEqual(captured.values, ["anon"]);
});

test("parseJson: 문자열 파싱 / 잘못된 JSON·null 은 fallback / 이미 객체면 그대로", () => {
  assert.deepEqual(parseJson('[1,2]', null), [1, 2]);
  assert.deepEqual(parseJson('not json', []), []);
  assert.deepEqual(parseJson(null, "fb"), "fb");
  assert.deepEqual(parseJson({ a: 1 }, null), { a: 1 });
});

test("sql 타입 마커: 값으로도 호출로도 안전(no-op)", () => {
  assert.equal(typeof sql.Int, "function");
  assert.equal(typeof sql.NVarChar, "function");
  // sql.NVarChar(sql.MAX) 같은 호출이 throw 하지 않아야 함
  assert.doesNotThrow(() => sql.NVarChar(sql.MAX));
  assert.doesNotThrow(() => sql.NVarChar(300));
});
