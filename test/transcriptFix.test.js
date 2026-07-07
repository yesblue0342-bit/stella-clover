// lib/transcriptFix.js — LLM 교정 패스의 "전사를 볼모로 잡지 않는다" 안전성 회귀.
import { test } from "node:test";
import assert from "node:assert/strict";

// API 키를 강제로 제거 → 모든 교정 창이 실패하는 상황을 재현(네트워크 호출 없음).
delete process.env.OPENAI_API_KEY;
const { correctTranscript } = await import("../lib/transcriptFix.js");

test("correctTranscript: LLM 사용 불가(키 없음) 시 원문을 그대로 반환(파이프라인 비차단)", async () => {
  const raw = "오늘 회의에서는 검사로트 생성과 마이그레이션 일정을 논의했습니다. 다음 주 컷오버 리허설을 진행합니다.";
  const r = await correctTranscript(raw);
  assert.equal(r.corrected, raw, "실패 창은 원문 유지");
  assert.equal(r.windows, 1);
  assert.equal(r.failedWindows, 1, "키 없음 → 전 창 실패로 집계");
});

test("correctTranscript: 빈 입력 안전 통과", async () => {
  const r = await correctTranscript("");
  assert.equal(r.corrected, "");
  assert.equal(r.windows, 0);
  const r2 = await correctTranscript(null);
  assert.equal(r2.corrected, "");
});

test("correctTranscript: 초장문도 창 분할로 전량 커버(실패 시 원문 무손실)", async () => {
  // 동일 문장 반복은 collapseRepeats(환각 축소)가 접어버리므로, 서로 다른 문장 400개로 구성.
  const raw = Array.from({ length: 400 }, (_, i) => `${i}번째 안건으로 인터페이스 ${i}번 개발과 단위테스트 결과를 공유했습니다.`).join(" ");
  const r = await correctTranscript(raw);
  assert.ok(r.windows >= 2, "창 분할: " + r.windows);
  // 실패 창은 원문 유지 → 공백 정규화 기준 내용 무손실.
  assert.equal(r.corrected.replace(/\s+/g, " ").trim(), raw.replace(/\s+/g, " ").trim());
});
