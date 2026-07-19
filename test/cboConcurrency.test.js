// lib/cbo-review/core.js mapWithConcurrency — 코드 리뷰 병렬화 유틸 회귀 테스트.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "../lib/cbo-review/core.js";

test("순서 보존 + 동시성 상한 준수(병렬 실행 확인)", async () => {
  let active = 0, maxActive = 0;
  const items = [...Array(12).keys()];
  const out = await mapWithConcurrency(items, 4, async (x) => {
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return x * 10;
  });
  assert.deepEqual(out, items.map((x) => x * 10));
  assert.ok(maxActive <= 4, `maxActive=${maxActive} (상한 4 초과)`);
  assert.ok(maxActive > 1, `병렬 실행되지 않음 maxActive=${maxActive}`);
});

test("limit이 항목 수보다 커도 안전", async () => {
  const out = await mapWithConcurrency([1, 2, 3], 10, async (x) => x + 1);
  assert.deepEqual(out, [2, 3, 4]);
});

test("빈 목록 → 빈 결과(worker 미호출)", async () => {
  let called = 0;
  const out = await mapWithConcurrency([], 5, async (x) => { called += 1; return x; });
  assert.deepEqual(out, []);
  assert.equal(called, 0);
});

test("worker 예외는 전파된다", async () => {
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3, 4], 2, async (x) => { if (x === 3) throw new Error("boom"); return x; }),
    /boom/,
  );
});

test("각 항목당 worker 정확히 1회 호출", async () => {
  const seen = [];
  await mapWithConcurrency([...Array(20).keys()], 3, async (x) => { seen.push(x); return x; });
  assert.deepEqual(seen.slice().sort((a, b) => a - b), [...Array(20).keys()]);
});
