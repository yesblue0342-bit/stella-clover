// Stella Clover — 회의록/요약 입력 전처리 + 프롬프트 빌더 단위 테스트.
// 핵심: 전사 전체가 잘림 없이 사용되는지 + 한국어 비즈니스 회의록 형식이 갖춰지는지.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prepareTranscript, needsMapReduce, splitTranscript, splitCoversAll, SINGLE_PASS_LIMIT,
  buildMinutesSystemPrompt, buildSummarySystemPrompt, buildPartialSystemPrompt, meetingDateFromName,
  defaultMeetingTitle, resolveMeetingTitle, titleFromFileName, collapseRepeats, isHallucinatedSegment,
} from "../api/_meeting.js";

test("collapseRepeats: '3, 3, 3, …' 런어웨이 반복 축소", () => {
  const bad = "고. 네. 그리고 이 " + "3, ".repeat(200).trim();
  const out = collapseRepeats(bad);
  assert.ok(/그리고 이 3, 3, 3,?$/.test(out), out.slice(-40));
  assert.ok((out.match(/3/g) || []).length <= 4, "3 반복이 충분히 줄어야 함");
});

test("collapseRepeats: 단어/구 반복 축소 + 정상 문장 보존", () => {
  assert.equal(collapseRepeats("네 네 네 네 네 네"), "네 네 네"); // 1토큰 반복은 3개까지 보존
  // 2토큰 필러 반복은 더 강하게 축소(구/문장 반복 환각 대응 강화). 3→2개.
  assert.equal(collapseRepeats("그리고 이 그리고 이 그리고 이 그리고 이 끝"), "그리고 이 그리고 이 끝");
  const normal = "오늘 회의는 자재 마스터와 컷오버 일정을 점검했습니다.";
  assert.equal(collapseRepeats(normal), normal); // 정상 텍스트는 변형 없음
  assert.equal(collapseRepeats(""), "");
});

test("collapseRepeats: 문장 전체(5~8토큰) 반복 환각 축소 — 실사용 회귀(회의록 품질)", () => {
  // Whisper 반복 루프: 같은 문장이 수십 번 → 1개만 남고 앞뒤 실제 발화는 보존.
  const s1 = "논의 시작. " + "Q. 4, 5일에 개발을 시작하겠습니까? ".repeat(20) + "A. 네, 10월 2일에 개발을 시작하겠습니다.";
  const o1 = collapseRepeats(s1);
  assert.equal((o1.match(/개발을 시작하겠습니까/g) || []).length, 1, "20회 반복 문장은 1개로 축소");
  assert.ok(/10월 2일/.test(o1), "뒤따르는 실제 답변(A.) 보존");
  assert.ok(/논의 시작/.test(o1), "앞선 실제 발화 보존");

  const s2 = "유효성 점검. " + "Q. QM에 대한 리뷰도 중요하지 않겠습니까? ".repeat(15) + "다음 안건으로 넘어갑니다.";
  const o2 = collapseRepeats(s2);
  assert.equal((o2.match(/리뷰도 중요하지/g) || []).length, 1, "15회 반복 문장은 1개로 축소");
  assert.ok(/다음 안건/.test(o2), "뒤 문장 보존");

  // 서로 다른 문장은 절대 병합되지 않는다(내용 손실 없음).
  const real = "자재 마스터를 정리했습니다. 컷오버 일정을 확정했습니다. 리허설은 다음 주입니다.";
  assert.equal(collapseRepeats(real), real);
});

test("isHallucinatedSegment: 극단적 압축비(문구 반복)도 환각 처리", () => {
  assert.equal(isHallucinatedSegment({ compression_ratio: 3.5, avg_logprob: -0.2 }), true); // 반복 루프(확신도 높아도)
  assert.equal(isHallucinatedSegment({ compression_ratio: 2.4, avg_logprob: -0.3 }), false); // 정상 범위
});

test("prepareTranscript: 반복 축소까지 적용", () => {
  assert.ok(!/3, 3, 3, 3, 3, 3/.test(prepareTranscript("회의 " + "3, ".repeat(50))));
});

test("isHallucinatedSegment: 무음/반복 환각만 true", () => {
  assert.equal(isHallucinatedSegment({ no_speech_prob: 0.9, avg_logprob: -1.2 }), true);  // 침묵 환각
  assert.equal(isHallucinatedSegment({ compression_ratio: 5.0, avg_logprob: -0.6 }), true); // 반복
  assert.equal(isHallucinatedSegment({ no_speech_prob: 0.1, avg_logprob: -0.3, compression_ratio: 1.4 }), false); // 정상
  assert.equal(isHallucinatedSegment({ no_speech_prob: 0.7, avg_logprob: -0.2 }), false); // 말없음 높지만 확신도 높음 → 보존
});

test("defaultMeetingTitle: KST 날짜+시각 키 제목", () => {
  // 2026-06-22T10:38:00Z = KST 19:38
  assert.equal(defaultMeetingTitle(new Date("2026-06-22T10:38:00Z")), "2026-06-22 19:38 회의록");
  // 자정 경계: 2026-06-21T15:00:00Z = KST 2026-06-22 00:00
  assert.equal(defaultMeetingTitle(new Date("2026-06-21T15:00:00Z")), "2026-06-22 00:00 회의록");
  assert.match(defaultMeetingTitle(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} 회의록$/);
});

test("resolveMeetingTitle: 의미있는 제목 보존, generic/빈값은 날짜+시각", () => {
  assert.equal(resolveMeetingTitle("SAP 프로젝트 점검", new Date("2026-06-22T10:38:00Z")), "SAP 프로젝트 점검");
  assert.equal(resolveMeetingTitle("", new Date("2026-06-22T10:38:00Z")), "2026-06-22 19:38 회의록");
  assert.equal(resolveMeetingTitle("회의록", new Date("2026-06-22T10:38:00Z")), "2026-06-22 19:38 회의록");
  assert.equal(resolveMeetingTitle('보고/회의:점검', new Date()), "보고회의점검"); // 금지문자 제거
});

test("titleFromFileName: 회의록 제목 = 업로드 파일명(확장자 제거·언더스코어→공백, ★날짜 접두어 유지)", () => {
  // 사용자 요구: 파일명 그대로(날짜 포함). "컨설턴트 미팅"처럼 날짜가 사라지면 파일과 다르다고 느낀다.
  assert.equal(titleFromFileName("260714_컨설턴트 미팅.m4a"), "260714 컨설턴트 미팅");
  assert.equal(titleFromFileName("260710_SAP Role 설명회.m4a"), "260710 SAP Role 설명회");
  assert.equal(titleFromFileName("GMP 스코프 및 마이그레이션.m4a"), "GMP 스코프 및 마이그레이션");
  assert.equal(titleFromFileName("음성 260711_203109.m4a"), "음성 260711 203109");
  // 의미없는 기본명만 "" → 호출부가 AI/날짜 제목으로 폴백
  assert.equal(titleFromFileName("recording.webm"), "");
  assert.equal(titleFromFileName("2026-07-15 12:09 회의록.webm"), ""); // 앱 기본 키 제목(파일명 아님)
  assert.equal(titleFromFileName("ocr_image"), "");
  assert.equal(titleFromFileName(""), "");
  assert.equal(titleFromFileName(undefined), "");
});

test("제목 우선순위: 파일명 제목이 있으면 AI 제목 대신 사용(날짜 유지), 없으면 AI 폴백", () => {
  // generateMinutes 내부 로직과 동일: resolveMeetingTitle(titleFromFileName || aiTitle)
  const aiTitle = "SAP 프로젝트 점검";
  const now = new Date("2026-06-22T10:38:00Z");
  assert.equal(resolveMeetingTitle(titleFromFileName("260714_컨설턴트 미팅.m4a") || aiTitle, now), "260714 컨설턴트 미팅"); // 파일명(날짜 포함) 우선
  assert.equal(resolveMeetingTitle(titleFromFileName("") || aiTitle, now), aiTitle);                        // 파일명 없으면 AI
  assert.equal(resolveMeetingTitle(titleFromFileName("recording.webm") || aiTitle, now), aiTitle);          // 이름없는 녹음 → AI 폴백
});

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
