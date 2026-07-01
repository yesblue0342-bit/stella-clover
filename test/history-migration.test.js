// 이력 지속성 회귀 가드: (1) 프로그램 개정 시 컬럼 마이그레이션(ADD COLUMN IF NOT EXISTS),
// (2) 목록이 이전 파일도 보이도록 하드캡(LIMIT 50) 제거 + offset 페이지네이션.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("_db.js: cl_meetings 핵심 컬럼에 idempotent 마이그레이션(ADD COLUMN IF NOT EXISTS)", async () => {
  const mod = await import("../api/_db.js");
  assert.ok(typeof mod.MIGRATE === "string" && mod.MIGRATE.length, "MIGRATE 문자열 필요");
  for (const col of ["title", "summary", "transcript", "transcript_chars", "created_at"]) {
    assert.ok(
      new RegExp(`ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS ${col}\\b`).test(mod.MIGRATE),
      `cl_meetings.${col} 마이그레이션 누락`
    );
  }
  // 파괴적 DDL(DROP/DELETE)이 마이그레이션에 섞이지 않았는지(데이터 보존).
  assert.ok(!/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i.test(mod.MIGRATE), "마이그레이션에 파괴적 구문 금지");
});

test("_db.js: ensureSchema 가 CREATE 이후 MIGRATE 를 실행한다", () => {
  const src = read("api/_db.js");
  assert.ok(/await pgPool\.query\(MIGRATE\)/.test(src), "ensureSchema 에서 MIGRATE 실행 필요");
});

test("meetings.js: 목록이 LIMIT 50 하드캡을 쓰지 않고 offset/limit 페이지네이션을 지원", () => {
  const src = read("api/meetings.js");
  assert.ok(!/ORDER BY id DESC LIMIT 50\b/.test(src), "이전 파일을 가리던 LIMIT 50 하드캡 잔존 금지");
  assert.ok(/OFFSET\s+\$\{offset\}/.test(src), "offset 페이지네이션 필요");
  assert.ok(/hasMore/.test(src), "hasMore 반환(추가 페이지 존재 여부) 필요");
});
