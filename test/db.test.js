// Stella Clover — PostgreSQL 호환 셰임(@name → $n) 단위 테스트.
// pg 런타임 없이 검증 가능(순수 변환 함수). Azure SQL → PostgreSQL 마이그레이션 회귀 가드.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPositional, sql } from "../api/_sqlshim.js";

test("toPositional: 단일 파라미터 → $1", () => {
  const r = toPositional("SELECT * FROM t WHERE id=@id", { id: 7 });
  assert.equal(r.text, "SELECT * FROM t WHERE id=$1");
  assert.deepEqual(r.values, [7]);
});

test("toPositional: 같은 이름 여러 번 → 같은 $n, 값 1개", () => {
  const r = toPositional(
    "SELECT * FROM t WHERE a ILIKE @q OR b ILIKE @q OR c ILIKE @q",
    { q: "%x%" }
  );
  assert.equal(r.text, "SELECT * FROM t WHERE a ILIKE $1 OR b ILIKE $1 OR c ILIKE $1");
  assert.deepEqual(r.values, ["%x%"]);
});

test("toPositional: 서로 다른 파라미터는 등장 순서대로 $1,$2,…", () => {
  const r = toPositional(
    "UPDATE t SET title=@title, n=@n WHERE id=@id",
    { title: "회의", n: 3, id: 42 }
  );
  assert.equal(r.text, "UPDATE t SET title=$1, n=$2 WHERE id=$3");
  assert.deepEqual(r.values, ["회의", 3, 42]);
});

test("toPositional: 다중 INSERT 값 매핑(워크스페이스 시나리오)", () => {
  const r = toPositional(
    "INSERT INTO ws_sessions (id,user_id,project_id,title) VALUES (@id,@u,@p,@t)",
    { id: "uuid", u: "a@b.com", p: null, t: "새 채팅" }
  );
  assert.equal(r.text, "INSERT INTO ws_sessions (id,user_id,project_id,title) VALUES ($1,$2,$3,$4)");
  assert.deepEqual(r.values, ["uuid", "a@b.com", null, "새 채팅"]);
});

test("toPositional: null/undefined 값 보존", () => {
  const r = toPositional("INSERT INTO t (a,b) VALUES (@a,@b)", { a: null, b: undefined });
  assert.deepEqual(r.values, [null, undefined]);
});

test("toPositional: 파라미터 없는 DDL은 그대로 통과", () => {
  const ddl = "CREATE TABLE IF NOT EXISTS t (id SERIAL PRIMARY KEY)";
  const r = toPositional(ddl, {});
  assert.equal(r.text, ddl);
  assert.deepEqual(r.values, []);
});

test("sql 타입 토큰: NVarChar(MAX)/Int/BigInt 접근·호출이 안전(throw 없음)", () => {
  assert.doesNotThrow(() => sql.NVarChar(300));
  assert.doesNotThrow(() => sql.NVarChar(sql.MAX));
  assert.doesNotThrow(() => sql.Int);
  assert.doesNotThrow(() => sql.BigInt);
});
