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

test("computeOffsetSec: ffmpeg 분할 refs 는 startSec(오버랩 반영) 우선", async () => {
  const { computeOffsetSec } = await load();
  // 무음 분할: 청크1이 96초에 끝나고 청크2는 90초(=96-6 오버랩)부터 시작 → offset 은 90이어야 정확.
  const refs = [
    { durationSec: 96, startSec: 0 },
    { durationSec: 116, startSec: 90 },
    { durationSec: 100, startSec: 200 },
  ];
  assert.equal(computeOffsetSec(refs, 0), 0);
  assert.equal(computeOffsetSec(refs, 1), 90);
  assert.equal(computeOffsetSec(refs, 2), 200);
  // startSec 없는 레거시 refs 는 기존 누적 방식 유지.
  assert.equal(computeOffsetSec([{ durationSec: 120 }, { durationSec: 120 }], 1), 120);
});

test("ACTIVE_STATUSES: 신규 단계 포함(복구/목록 단일 출처)", async () => {
  const { ACTIVE_STATUSES } = await load();
  for (const s of ["preparing", "processing", "correcting", "summarizing", "uploading"]) {
    assert.ok(ACTIVE_STATUSES.includes(s), "누락 상태: " + s);
  }
});
