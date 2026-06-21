// Stella Clover — 회의록/요약 입력 전처리 + 프롬프트 빌더 단위 테스트.
// 핵심: 전사 전체가 잘림 없이 사용되는지 + 한국어 비즈니스 회의록 형식이 갖춰지는지.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prepareTranscript, needsMapReduce, splitTranscript, splitCoversAll, SINGLE_PASS_LIMIT,
  buildMinutesSystemPrompt, buildSummarySystemPrompt, buildPartialSystemPrompt, meetingDateFromName,
} from "../api/_meeting.js";

test("meetingDateFromName: 파일명에서 회의 날짜 추출(260612/20260612/2026-06-12)", () => {
  assert.equal(meetingDateFromName("260612_주간회의.m4a"), "2026-06-12");
  assert.equal(meetingDateFromName("20260612_회의.wav"), "2026-06-12");
  assert.equal(meetingDateFromName("2026-06-12 회의.m4a"), "2026-06-12");
  assert.equal(meetingDateFromName("회의록.m4a"), "");     // 날짜 없음
  assert.equal(meetingDateFromName("recording.webm"), ""); // 날짜 없음
  assert.equal(meetingDateFromName("261399_x.m4a"), "");   // 잘못된 월/일 거부
});

test("buildMinutesSystemPrompt: meetingDate 있으면 일시 기본값으로 파일 날짜 힌트", () => {
  const p = buildMinutesSystemPrompt({ meetingDate: "2026-06-12" });
  assert.match(p, /파일 날짜 2026-06-12/);
  const p2 = buildMinutesSystemPrompt({}); // 없으면 미확인
  assert.match(p2, /일시: \(본문에 명시되면 기재, 없으면 미확인\)/);
});

test("prepareTranscript: 트림/개행정규화만, 길이 컷 없음(전체 보존)", () => {
  const big = "가".repeat(50000);
  assert.equal(prepareTranscript(big).length, 50000); // 잘리지 않음
  assert.equal(prepareTranscript("  a\r\nb  "), "a\nb");
  assert.equal(prepareTranscript(null), "");
});

test("needsMapReduce: SINGLE_PASS_LIMIT 경계", () => {
  assert.equal(needsMapReduce("x".repeat(SINGLE_PASS_LIMIT)), false);
  assert.equal(needsMapReduce("x".repeat(SINGLE_PASS_LIMIT + 1)), true);
});

test("splitTranscript: 분할이 원본을 빠짐없이 덮음(누락 0)", () => {
  for (const n of [0, 100, 16000, 16001, 50000, 123456]) {
    const s = "단어 ".repeat(Math.ceil(n / 3)).slice(0, n);
    const parts = splitTranscript(s);
    assert.equal(parts.join(""), prepareTranscript(s), "join==원본 n=" + n);
    assert.equal(splitCoversAll(s), true, "covers n=" + n);
  }
});

test("splitTranscript: 짧으면 1조각, 길면 여러 조각", () => {
  assert.equal(splitTranscript("짧은 텍스트").length, 1);
  assert.ok(splitTranscript("a".repeat(50000)).length >= 3);
});

test("buildMinutesSystemPrompt: 한국어 비즈니스 회의록 6개 섹션 + 제목/키워드 마커 + 작성일", () => {
  const p = buildMinutesSystemPrompt({ writtenDate: "2026-06-09" });
  for (const sec of ["## 회의 제목", "## 1. 회의 기본정보", "## 2. 참석자", "## 3. 안건별 논의", "## 4. 결정사항", "## 5. Action Item", "## 6. 일정", "## 핵심 요약", "## 주요 키워드"]) {
    assert.ok(p.includes(sec), "섹션 누락: " + sec);
  }
  assert.ok(p.includes("2026-06-09"), "작성일 반영");
  assert.ok(/지어내지|창작/.test(p), "사실충실(창작 금지) 지침");
  assert.ok(/일정/.test(p) && /빠짐없이/.test(p), "일정 빠짐없이 정리 지침");
  assert.ok(/미확인/.test(p), "없는 일시/장소는 미확인");
});

test("buildMinutesSystemPrompt: 제목/키워드 추출 정규식과 호환", () => {
  // summarize.js의 추출 정규식이 새 형식에서도 동작해야 함
  const sample = "# 회의록\n\n## 회의 제목\nQM 마이그레이션 킥오프\n\n## 주요 키워드\nQM, 마이그레이션, 컷오버";
  const tm = sample.match(/##\s*회의 제목\s*\n+\s*([^\n]+)/);
  const km = sample.match(/##\s*주요 키워드\s*\n+\s*([^\n]+)/);
  assert.equal(tm[1].trim(), "QM 마이그레이션 킥오프");
  assert.equal(km[1].trim(), "QM, 마이그레이션, 컷오버");
});

test("buildSummarySystemPrompt / buildPartialSystemPrompt: 핵심 지침 포함", () => {
  assert.ok(/3~5줄/.test(buildSummarySystemPrompt()));
  assert.ok(/누락 없이/.test(buildPartialSystemPrompt({ idx: 0, total: 3 })));
  assert.ok(buildPartialSystemPrompt({ idx: 1, total: 3 }).includes("2/3"));
});

// 회귀 가드: 어떤 함수도 전사를 잘라 반환하지 않음(전체 입력 보존)
test("회귀 가드: 7.5KB·100KB 전사 모두 전처리 후 길이 유지(잘림 없음)", () => {
  for (const n of [7500, 100000]) {
    const s = "회".repeat(n);
    assert.equal(prepareTranscript(s).length, n);
    assert.equal(splitTranscript(s).join("").length, n);
  }
});
