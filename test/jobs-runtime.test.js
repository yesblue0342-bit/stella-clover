// lib/jobs-runtime.js 순수 함수 회귀 (인프로세스 워커 offset 계산)
import { test } from "node:test";
import assert from "node:assert/strict";

// jobs-runtime은 _stt(OpenAI 인스턴스화)를 임포트하므로, 모듈 로드 전 더미 키를 설정하고 동적 import.
async function load() {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-dummy";
  return import("../lib/jobs-runtime.js");
}

test("computeOffsetSec: 앞 청크들의 누적 durationSec(글로벌 타임라인 offset)", async () => {
  const { computeOffsetSec } = await load();
  const refs = [{ durationSec: 120 }, { durationSec: 118 }, { durationSec: 60 }];
  assert.equal(computeOffsetSec(refs, 0), 0);
  assert.equal(computeOffsetSec(refs, 1), 120);
  assert.equal(computeOffsetSec(refs, 2), 238);
  assert.equal(computeOffsetSec(refs, 3), 298);
});

test("computeOffsetSec: 비배열/누락 durationSec 방어", async () => {
  const { computeOffsetSec } = await load();
  assert.equal(computeOffsetSec(null, 2), 0);
  assert.equal(computeOffsetSec([{}, { durationSec: null }], 2), 0);
  assert.equal(computeOffsetSec([{ durationSec: "x" }, { durationSec: 30 }], 2), 30);
});
