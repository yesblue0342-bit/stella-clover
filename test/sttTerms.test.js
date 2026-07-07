// Stella Clover — STT 도메인 사전(프롬프트 + 후처리 교정) 단위 테스트.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SAP_TERMS, SAP_PROMPT, CORRECTIONS, applyCorrections } from "../lib/sttTerms.js";

test("SAP_PROMPT: 핵심 용어 포함 + 200토큰(대략 단어수) 이내", () => {
  for (const t of ["SAP", "ABAP", "BAPI", "S/4HANA", "검사로트", "컷오버"]) {
    assert.ok(SAP_PROMPT.includes(t), "용어 누락: " + t);
  }
  // 토큰 과다 방지(대략적 가드): 콤마 구분 항목 수가 적당해야 디코딩 편향 위험 낮음.
  assert.ok(SAP_TERMS.length <= 60, "용어 과다(프롬프트 편향 위험)");
  assert.ok(SAP_PROMPT.endsWith("."), "프롬프트 마침표");
});

test("config/stt-terms.json 이 실제 로드된다(JSON 전용 용어 포함) + 신규 도메인 용어", () => {
  // Celltrion/BISON 은 내장 폴백에 없고 JSON 에만 있다 → 포함되어 있으면 JSON 로드 성공 증거.
  for (const t of ["Celltrion", "BISON", "US11", "US1N", "EWM", "HU", "MIC", "Usage Decision", "CBO", "검사계획", "핸들링유닛", "컨버전"]) {
    assert.ok(SAP_TERMS.includes(t), "JSON 용어 누락: " + t);
  }
});

test("applyCorrections: JSON 정의 교정 규칙 동작(Usage Decision/핸들링유닛)", () => {
  assert.equal(applyCorrections("유세이지 디시전 처리"), "Usage Decision 처리");
  assert.equal(applyCorrections("핸들링 유닛 구성"), "핸들링유닛 구성");
  assert.equal(applyCorrections("검사 계획 등록"), "검사계획 등록");
});

test("applyCorrections: 영문 약어 음차 복원", () => {
  assert.equal(applyCorrections("에이밥 개발이 필요합니다"), "ABAP 개발이 필요합니다");
  assert.equal(applyCorrections("에이 밥 표준"), "ABAP 표준");
  assert.equal(applyCorrections("바피 호출"), "BAPI 호출");
  assert.equal(applyCorrections("아이독 인터페이스"), "IDoc 인터페이스");
  assert.equal(applyCorrections("에스포하나 전환"), "S/4HANA 전환");
  assert.equal(applyCorrections("S4HANA 마이그레이션"), "S/4HANA 마이그레이션");
});

test("applyCorrections: 도메인 합성어 띄어쓰기 정규화", () => {
  assert.equal(applyCorrections("검사 로트 생성"), "검사로트 생성");
  assert.equal(applyCorrections("자재 마스터 정비"), "자재마스터 정비");
  assert.equal(applyCorrections("컷 오버 일정"), "컷오버 일정");
  assert.equal(applyCorrections("생산 오더 확정"), "생산오더 확정");
});

test("applyCorrections: 정상 텍스트/빈값/비문자열 안전 통과(오탐 없음)", () => {
  const normal = "오늘 회의는 일정과 리스크를 점검했습니다.";
  assert.equal(applyCorrections(normal), normal);
  assert.equal(applyCorrections(""), "");
  assert.equal(applyCorrections(null), "");
  assert.equal(applyCorrections(undefined), "");
});

test("CORRECTIONS: 각 항목이 [정규식, 문자열] 형태", () => {
  for (const c of CORRECTIONS) {
    assert.ok(Array.isArray(c) && c.length === 2, "형태 오류");
    assert.ok(c[0] instanceof RegExp, "1번 요소 정규식");
    assert.equal(typeof c[1], "string", "2번 요소 문자열");
  }
});
