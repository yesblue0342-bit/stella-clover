// GATE 1: lib/cbo-precheck/textSymbols.js — `*_TEXTS.txt` 파서. 실제 0Program 저장소에서 실측한
// 두 포맷(WORK_REPORT.md Phase 0 참고: ZAQMR0130의 "*===" 주석 스타일, ZAQMR0100의 "[N] ------" 스타일)을
// 샘플 그대로(축약) 검증하고, 파일이 없거나 인식 못 하는 형식일 때 조용히 빈 매핑으로 폴백함을 확인한다.
import test from "node:test";
import assert from "node:assert/strict";
import { isTextsDoc, parseTextsDoc, EMPTY_TEXTS_MAP } from "../lib/cbo-precheck/textSymbols.js";

test("isTextsDoc: *_TEXTS.txt 만 인식(대소문자 무관), 다른 확장자는 아님", () => {
  assert.ok(isTextsDoc("ZAQMR0130_TEXTS.txt"));
  assert.ok(isTextsDoc("_abap/zaqmr0130_texts.txt"));
  assert.ok(!isTextsDoc("ZAQMR0130_DDIC.txt"));
  assert.ok(!isTextsDoc("ZAQMR0130.abap"));
});

// 실제 ZAQMR0130_TEXTS.txt 샘플(WORK_REPORT.md Phase 0 원문 인용, 미션 표의 케이스 전부 포함).
const ASTERISK_STYLE = `***********************************************************************
* ZAQMR0130 — Text Symbols / Selection Texts / GUI Title & Status
***********************************************************************

*=== Text Symbols (SE38 > Goto > Text Elements > Text Symbols) =========
* 001   Selection Criteria
* 004   Processing Mode              ★★반드시 입력 — 미입력 시 Display/Change&Create
*                                     라디오 블록이 제목 없는 빈 프레임으로 나온다
* M01   Display

*=== Selection Texts (SE38 > Goto > Text Elements > Selection Texts) ===
* S_WERKS   Plant
* P_DISP    Display                     ★미입력 시 화면에 "P_DISP" 로 노출됨
* P_APA     Preferred Inspection Type

* ※ 제거된 선택 텍스트 (대상 시스템에 남아 있으면 삭제):
*   P_ALL  / P_RANGE — 조회조건 All/Range 라디오 제거(Mod 006). 시스템에
*                      남아 있으면 삭제한다.

*=== GUI Title (SE41 > Titles) ========================================
* TITLE_0100   [QM] Assign Inspection Type to QM View — &1 (&2)

*=== GUI Status (SE41 > Status: STATUS_0100) ==========================
* BACK   (F3)   Back
`;

test("GATE 1 (a): 실제 _TEXTS.txt(asterisk 스타일) 샘플에서 심볼→텍스트 매핑이 정확히 추출된다", () => {
  const r = parseTextsDoc(ASTERISK_STYLE);
  assert.equal(r.textSymbols["001"], "Selection Criteria");
  assert.equal(r.textSymbols["004"], "Processing Mode");
  assert.equal(r.textSymbols["M01"], "Display");
  assert.equal(r.selectionTexts["S_WERKS"], "Plant");
  assert.equal(r.selectionTexts["P_DISP"], "Display", "★ 인라인 강조 표시가 값을 오염시키면 안 됨");
  assert.equal(r.selectionTexts["P_APA"], "Preferred Inspection Type");
  assert.equal(r.title, "[QM] Assign Inspection Type to QM View — &1 (&2)");
  // "P_ALL  / P_RANGE — ..." 같은 산문 주석 continuation 줄이 오탐되어 selectionTexts에 들어가면 안 됨.
  assert.equal(r.selectionTexts["P_ALL"], undefined, "주석 continuation 줄의 우연한 2칸 간격 오탐 방지");
  // GUI Status 섹션 항목(BACK)이 title/selectionTexts로 새어 들어가지 않아야 함.
  assert.equal(r.selectionTexts["BACK"], undefined);
});

const BRACKET_STYLE = `==============================================================================
ZAQMR0100 - Text Symbols / Selection Texts / Screen 0100 / GUI Status·Title
==============================================================================
------------------------------------------------------------------------------
[1] Text Symbols (Text Elements)
------------------------------------------------------------------------------
  b01  조회 조건
  m02  변경/생성(Change & Create)   " [수정013] 종전 "변경(Change)" 에서 개칭

------------------------------------------------------------------------------
[2] Selection Texts
------------------------------------------------------------------------------
  S_WERKS  플랜트 (US11/US1N)
  P_CHNG   변경 (Change & Create)   " [수정013] 종전 "변경 (Change)" 에서 개칭
                                   "  Material 지정 시 미배정 자재도 신규 생성 가능
`;

test("GATE 1 (a): 다른 실제 프로그램의 _TEXTS.txt(bracket 스타일)도 같은 파서가 처리한다", () => {
  const r = parseTextsDoc(BRACKET_STYLE);
  assert.equal(r.textSymbols["B01"], "조회 조건");
  assert.equal(r.textSymbols["M02"], "변경/생성(Change & Create)", "ABAP 인라인 주석(\") 이후는 잘려야 함");
  assert.equal(r.selectionTexts["S_WERKS"], "플랜트 (US11/US1N)");
  assert.equal(r.selectionTexts["P_CHNG"], "변경 (Change & Create)", "여러 줄에 걸친 주석 continuation이 값에 섞이면 안 됨");
});

test("GATE 1 (a): 키-값 구분자가 탭 1개뿐이어도 인식한다(공백 2칸 요구로 탭 문서를 놓치면 안 됨)", () => {
  const tabDoc = "*=== Text Symbols ===\n* 001\tSelection Criteria\n\n*=== Selection Texts ===\n* S_WERKS\tPlant\n";
  const r = parseTextsDoc(tabDoc);
  assert.equal(r.textSymbols["001"], "Selection Criteria");
  assert.equal(r.selectionTexts["S_WERKS"], "Plant");
});

test("GATE 1 (c): 인식 못 하는 형식/빈 문서는 크래시 없이 빈 매핑을 반환한다(조용한 폴백)", () => {
  const proseStyle = `Block Title (Text-101):\n  EN: "Q Info Record Search Criteria"\n  KO: "품질정보데이터 조회 조건"\n`;
  const r1 = parseTextsDoc(proseStyle);
  assert.deepEqual(r1.textSymbols, {});
  assert.deepEqual(r1.selectionTexts, {});
  assert.equal(r1.title, null);

  const r2 = parseTextsDoc("");
  assert.deepEqual(r2.textSymbols, {});
  assert.deepEqual(r2.selectionTexts, {});

  const r3 = parseTextsDoc(undefined);
  assert.deepEqual(r3, EMPTY_TEXTS_MAP);
});
