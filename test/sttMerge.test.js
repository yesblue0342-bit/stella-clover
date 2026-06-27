// Stella Clover — 청크 오버랩 병합 디듀프 단위 테스트.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normTok, dedupOverlapTokens } from "../lib/sttMerge.js";

test("dedupOverlapTokens: 겹치는 머리 토큰 제거(경계 중복 해소)", () => {
  const prev = "오늘 회의는 자재마스터 정비와 컷오버 일정을";
  const next = "컷오버 일정을 점검하기로 했습니다";
  assert.equal(dedupOverlapTokens(prev, next), "점검하기로 했습니다");
});

test("dedupOverlapTokens: 구두점/대소문자 차이 흡수", () => {
  assert.equal(dedupOverlapTokens("we discussed SAP, BAPI", "sap bapi interface design"), "interface design");
});

test("dedupOverlapTokens: 겹침 없으면 next 원형 보존(누락 0)", () => {
  assert.equal(dedupOverlapTokens("앞 문장입니다", "전혀 다른 내용입니다"), "전혀 다른 내용입니다");
  assert.equal(dedupOverlapTokens("", "첫 청크입니다"), "첫 청크입니다");
  assert.equal(dedupOverlapTokens("이전", ""), "");
});

test("dedupOverlapTokens: 단일 토큰 겹침(k=1)은 무시(과잉 제거 방지)", () => {
  // '네' 한 토큰만 겹치는 건 우연일 수 있어 제거하지 않음.
  assert.equal(dedupOverlapTokens("그래서 네", "네 다음 안건"), "네 다음 안건");
});

test("dedupOverlapTokens: 전체가 겹치면 빈 문자열(완전 중복 청크)", () => {
  assert.equal(dedupOverlapTokens("같은 문장 반복", "같은 문장 반복"), "");
});

test("normTok: 구두점 제거 + 소문자", () => {
  assert.equal(normTok("SAP,"), "sap");
  assert.equal(normTok("일정을…"), "일정을");
});
