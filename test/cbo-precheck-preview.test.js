import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parsePreview, buildPreview } from "../lib/cbo-precheck/preview.js";
import { saveScan } from "../lib/cbo-precheck/store.js";
import handler from "../api/cbo-precheck.js";
import { parseTextsDoc } from "../lib/cbo-precheck/textSymbols.js";

const good = fs.readFileSync("fixtures/zaqmr0130_good.prog.abap", "utf8");

test("GATE 3: 정상 fixture에서 PARAMETERS 2 / SELECT-OPTIONS 1 / BLOCK 1 / ALV 컬럼 3 을 파싱한다", () => {
  const { elements, coverage } = parsePreview(good, "zaqmr0130_good.prog.abap");

  const parameters = elements.filter((e) => e.type === "parameter");
  const selectOptions = elements.filter((e) => e.type === "select-options");
  const blockBegins = elements.filter((e) => e.type === "block-begin");
  const blockEnds = elements.filter((e) => e.type === "block-end");
  const alv = elements.filter((e) => e.type === "alv");

  assert.equal(parameters.length, 2);
  assert.equal(selectOptions.length, 1);
  assert.equal(blockBegins.length, 1);
  assert.equal(blockEnds.length, 1);
  assert.equal(blockBegins[0].name, blockEnds[0].name);
  assert.equal(blockBegins[0].title, "TEXT-b01");
  assert.equal(alv.length, 1);
  assert.equal(alv[0].columns.length, 3);
  assert.deepEqual(alv[0].columns.map((c) => c.fieldname), ["PRUEFLOS", "MATNR", "WERK"]);

  const obligatoryDefault = parameters.find((p) => p.obligatory);
  assert.equal(obligatoryDefault.default, "US11");
  const checkbox = parameters.find((p) => p.checkbox);
  assert.ok(checkbox);
  assert.equal(selectOptions[0].forField, "qals-prueflos");

  const comment = elements.find((e) => e.type === "comment");
  assert.equal(comment.text, "TEXT-c01");
  const pushbutton = elements.find((e) => e.type === "pushbutton");
  assert.equal(pushbutton.text, "TEXT-p01");
  assert.equal(pushbutton.userCommand, "fltr");

  assert.equal(coverage.unparsed, 0);
  assert.ok(coverage.parsed >= 10);
});

test("파싱 불가 구문(ULINE 등)은 건너뛰지 않고 unparsed 로 목록화된다", () => {
  const src = "REPORT zt.\nSELECTION-SCREEN ULINE.\nPARAMETERS p_x TYPE c.\n";
  const { elements, coverage } = parsePreview(src, "zt.prog.abap");
  const unparsed = elements.filter((e) => e.type === "unparsed");
  assert.equal(unparsed.length, 1);
  assert.match(unparsed[0].text, /ULINE/);
  assert.equal(coverage.unparsed, 1);
});

test("ALV: VALUE #( ( fieldname = ... ) ... ) 생성자 패턴(정규식 보조)도 인식한다", () => {
  const src = "REPORT zt.\nDATA gt_fcat TYPE lvc_t_fcat.\n" +
    "gt_fcat = VALUE #( ( fieldname = 'A' coltext = 'Alpha' outputlen = 5 ) ( fieldname = 'B' coltext = 'Beta' outputlen = 8 ) ).\n";
  const { elements } = parsePreview(src, "zt.prog.abap");
  const alv = elements.find((e) => e.type === "alv");
  assert.equal(alv.columns.length, 2);
  assert.deepEqual(alv.columns.map((c) => c.fieldname), ["A", "B"]);
});

test("api action=preview: 스캔 결과에 저장된 소스로 미리보기를 생성한다", async () => {
  const scanId = saveScan({
    repoUrl: "git@github.com:a/b.git", branch: "main", path: "",
    issues: [], fileCount: 1, files: ["zaqmr0130_good.prog.abap"],
    fileContents: { "zaqmr0130_good.prog.abap": good },
  });
  const res = { _status: 200, setHeader() {}, status(c) { this._status = c; return this; }, json(o) { this._body = o; return this; } };
  await handler({ method: "POST", query: { action: "preview" }, headers: {}, body: { scanId, file: "zaqmr0130_good.prog.abap" } }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.ok(res._body.elements.some((e) => e.type === "alv"));
});

test("api action=preview: 스캔 결과에 없는 파일은 404", async () => {
  const scanId = saveScan({ repoUrl: "git@github.com:a/b.git", branch: "main", path: "", issues: [], fileCount: 0, files: [], fileContents: {} });
  const res = { _status: 200, setHeader() {}, status(c) { this._status = c; return this; }, json(o) { this._body = o; return this; } };
  await handler({ method: "POST", query: { action: "preview" }, headers: {}, body: { scanId, file: "nope.prog.abap" } }, res);
  assert.equal(res._status, 404);
});

// GATE 1: 텍스트 심볼/선택화면 텍스트 라벨 치환 — 실제 미션 표(TEXT-001→"Selection Criteria" 류)와
// 동일한 구조의 매핑을 fixture 필드명(b01/c01/p01, s_pruef/p_werk/p_all)에 맞춰 재현한다.
const TEXTS_DOC = `*=== Text Symbols (SE38 > Goto > Text Elements > Text Symbols) =========
* b01   조회 조건
* c01   안내 문구
* p01   필터 적용

*=== Selection Texts (SE38 > Goto > Text Elements > Selection Texts) ===
* S_PRUEF   검사로트
* P_WERK    플랜트
* P_ALL     전체 조회
`;

test("GATE 1 (b): _TEXTS.txt 매핑을 넘기면 블록 제목/코멘트/푸시버튼/필드 라벨이 실제 텍스트로 치환된다", () => {
  const textsMap = parseTextsDoc(TEXTS_DOC);
  const { elements } = parsePreview(good, "zaqmr0130_good.prog.abap", textsMap);

  const block = elements.find((e) => e.type === "block-begin");
  assert.equal(block.title, "조회 조건", "TEXT-b01 심볼이 실제 텍스트로 치환되어야 함");
  assert.equal(block.titleSymbol, "TEXT-b01", "개발자가 원 심볼도 알 수 있어야 함(완전히 숨기지 않음)");

  const comment = elements.find((e) => e.type === "comment");
  assert.equal(comment.text, "안내 문구");
  const pushbutton = elements.find((e) => e.type === "pushbutton");
  assert.equal(pushbutton.text, "필터 적용");

  const selectOption = elements.find((e) => e.type === "select-options");
  assert.equal(selectOption.label, "검사로트");
  assert.equal(selectOption.name, "s_pruef", "변수명은 보조 정보로 그대로 남아야 함");

  const werk = elements.find((e) => e.name === "p_werk");
  assert.equal(werk.label, "플랜트");
  assert.equal(werk.obligatory, true);
  assert.equal(werk.default, "US11");

  const checkbox = elements.find((e) => e.name === "p_all");
  assert.equal(checkbox.label, "전체 조회");
});

test("GATE 1 (c): 매핑에 없는 심볼/필드는 크래시 없이 기존 심볼/변수명 표시로 폴백한다(회귀 없음)", () => {
  const textsMap = parseTextsDoc("*=== Text Symbols ===\n* zzz   무관한 심볼\n");
  const { elements } = parsePreview(good, "zaqmr0130_good.prog.abap", textsMap);
  const block = elements.find((e) => e.type === "block-begin");
  assert.equal(block.title, "TEXT-b01", "매핑 없는 심볼은 원본 그대로");
  assert.equal(block.titleSymbol, null);
  const selectOption = elements.find((e) => e.type === "select-options");
  assert.equal(selectOption.label, null, "매핑 없는 필드는 label이 null(호출부가 변수명으로 폴백)");
});

test("GATE 1 (d): SELECT-OPTIONS OBLIGATORY 도 파싱된다(기존에는 PARAMETERS만 추출됨)", () => {
  const src = "REPORT zt.\nSELECT-OPTIONS s_req FOR mara-matnr OBLIGATORY.\n";
  const { elements } = parsePreview(src, "zt.prog.abap");
  const so = elements.find((e) => e.type === "select-options");
  assert.equal(so.obligatory, true);
});

// GATE 2: INCLUDE 병합 — 메인 프로그램(REPORT 문 포함)이 INCLUDE 하는 형제 파일의 선택화면 정의가
// 병합 후 그대로 해석되고, include 파일 단독 지정은 기존과 동일하게(회귀 없음) 동작해야 한다.
test("GATE 2 (a): 메인 프로그램 지정 시 INCLUDE를 따라가 형제 파일의 선택화면이 전부 해석된다", () => {
  const mainSrc = "REPORT zaqmr9999.\n  INCLUDE zaqmr9999_top.\n  INCLUDE zaqmr9999_s01.\n";
  const topSrc = "DATA gv_x TYPE i.\n";
  const s01Src = "PARAMETERS p_foo TYPE c.\nSELECT-OPTIONS s_bar FOR mara-matnr.\n";
  const siblingFiles = [
    { name: "_abap/ZAQMR9999.abap", content: mainSrc },
    { name: "_abap/ZAQMR9999_TOP.abap", content: topSrc },
    { name: "_abap/ZAQMR9999_S01.abap", content: s01Src },
  ];
  const result = buildPreview("_abap/ZAQMR9999.abap", mainSrc, siblingFiles);
  assert.deepEqual(result.mergedFiles.sort(), ["_abap/ZAQMR9999_S01.abap", "_abap/ZAQMR9999_TOP.abap"]);
  assert.equal(result.warnings.length, 0);
  assert.ok(result.elements.some((e) => e.type === "parameter" && e.name === "p_foo"), "INCLUDE에만 있던 PARAMETERS가 병합 후 해석되어야 함");
  assert.ok(result.elements.some((e) => e.type === "select-options" && e.name === "s_bar"));
});

test("GATE 2 (b): include 파일(REPORT 문 없음) 단독 지정은 기존과 동일하게 병합 없이 동작한다(회귀 없음)", () => {
  const s01Src = "PARAMETERS p_foo TYPE c.\n";
  const siblingFiles = [
    { name: "_abap/ZAQMR9999_TOP.abap", content: "DATA gv_x TYPE i.\n" },
    { name: "_abap/ZAQMR9999_S01.abap", content: s01Src },
  ];
  const result = buildPreview("_abap/ZAQMR9999_S01.abap", s01Src, siblingFiles);
  assert.equal(result.mergedFiles.length, 0, "REPORT/PROGRAM 문이 없는 파일은 병합 대상이 아님");
  assert.ok(result.elements.some((e) => e.type === "parameter" && e.name === "p_foo"));
});

test("GATE 2 (c): 대응하는 INCLUDE 파일이 없으면 그 INCLUDE만 건너뛰고 경고와 함께 부분 렌더된다(크래시 없음)", () => {
  const mainSrc = "REPORT zaqmr9999.\n  INCLUDE zaqmr9999_top.\n  INCLUDE zaqmr9999_missing.\n";
  const siblingFiles = [{ name: "_abap/ZAQMR9999_TOP.abap", content: "DATA gv_x TYPE i.\n" }];
  const result = buildPreview("_abap/ZAQMR9999.abap", mainSrc, siblingFiles);
  assert.deepEqual(result.mergedFiles, ["_abap/ZAQMR9999_TOP.abap"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /ZAQMR9999_MISSING/);
});

// 아키텍트 리뷰 후속: ABAP 문법상 유효한 `INCLUDE name IF FOUND.` 형태도 인식해야 하고, 인식하지 못하는
// INCLUDE 형태는 "선택화면이 원래 없는 프로그램"과 구별되도록 반드시 경고를 남겨야 한다(침묵 실패 금지).
test("GATE 2 (d): INCLUDE ... IF FOUND. 형태도 병합된다(ABAP 문법상 유효)", () => {
  const mainSrc = "REPORT zaqmr9997.\n  INCLUDE zaqmr9997_s01 IF FOUND.\n";
  const s01Src = "PARAMETERS p_foo TYPE c.\n";
  const siblingFiles = [{ name: "_abap/ZAQMR9997_S01.abap", content: s01Src }];
  const result = buildPreview("_abap/ZAQMR9997.abap", mainSrc, siblingFiles);
  assert.deepEqual(result.mergedFiles, ["_abap/ZAQMR9997_S01.abap"]);
  assert.equal(result.warnings.length, 0);
  assert.ok(result.elements.some((e) => e.type === "parameter" && e.name === "p_foo"));
});

// 실측 회귀 재현: 0Program 저장소의 실제 INCLUDE 문은 전부 뒤에 ABAP 인라인 주석(" ...)이 붙어 있다
// (`INCLUDE zaqmr0130_top.   " 전역 데이터/타입/상수 선언`). 종결 뒤 아무 내용도 허용하지 않는 정규식으로
// "고치면" 실사용 100% 케이스가 전부 미인식으로 되돌아간다 — 이 세션 중 실제로 겪은 회귀라 고정한다.
test("GATE 2 (d-2): INCLUDE name. 뒤에 ABAP 인라인 주석이 붙어도 정상 병합된다(실측 회귀 고정)", () => {
  const mainSrc = "REPORT zaqmr9995.\n  INCLUDE zaqmr9995_s01.   \" 선택화면\n";
  const s01Src = "PARAMETERS p_foo TYPE c.\n";
  const result = buildPreview("_abap/ZAQMR9995.abap", mainSrc, [{ name: "_abap/ZAQMR9995_S01.abap", content: s01Src }]);
  assert.deepEqual(result.mergedFiles, ["_abap/ZAQMR9995_S01.abap"]);
  assert.equal(result.warnings.length, 0);
  assert.ok(result.elements.some((e) => e.type === "parameter" && e.name === "p_foo"));
});

test("GATE 2 (e): 인식 못하는 INCLUDE 형태는 경고를 남긴다(침묵 실패 금지 — '선택화면 없음'과 구별)", () => {
  const mainSrc = "REPORT zaqmr9996.\n  INCLUDE zaqmr9996_s01. WRITE 'x'.\n";
  const result = buildPreview("_abap/ZAQMR9996.abap", mainSrc, []);
  assert.equal(result.mergedFiles.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /인식하지 못해/);
});

test("GATE 2 (f): INCLUDE STRUCTURE/INCLUDE TYPE(DDIC 구조 병합 문법)은 프로그램 INCLUDE로 오인하지 않는다", () => {
  const mainSrc = "REPORT zt.\nTYPES: BEGIN OF ty,\n  INCLUDE STRUCTURE zst_foo.\nTYPES: END OF ty.\n";
  const result = buildPreview("zt.abap", mainSrc, []);
  assert.equal(result.mergedFiles.length, 0);
  assert.equal(result.warnings.length, 0, "INCLUDE STRUCTURE는 경고 대상이 아님(프로그램 INCLUDE가 아니므로)");
});

test("api action=preview: collectedFiles의 형제 TEXTS 문서/INCLUDE가 end-to-end로 병합·라벨 치환된다", async () => {
  const mainSrc = "REPORT zaqmr9998.\n  INCLUDE zaqmr9998_s01.\n";
  const s01Src = "SELECTION-SCREEN BEGIN OF BLOCK b1 WITH FRAME TITLE TEXT-001.\n" +
    "  PARAMETERS p_foo TYPE c.\n" +
    "SELECTION-SCREEN END OF BLOCK b1.\n";
  const textsSrc = "*=== Text Symbols ===\n* 001   조회 조건\n\n*=== Selection Texts ===\n* P_FOO   테스트 필드\n";
  const collectedFiles = [
    { name: "_abap/ZAQMR9998.abap", content: mainSrc },
    { name: "_abap/ZAQMR9998_S01.abap", content: s01Src },
    { name: "_abap/ZAQMR9998_TEXTS.txt", content: textsSrc, isTexts: true },
  ];
  const scanId = saveScan({
    repoUrl: "git@github.com:a/b.git", branch: "main", path: "",
    issues: [], fileCount: 1, files: ["_abap/ZAQMR9998.abap"],
    fileContents: { "_abap/ZAQMR9998.abap": mainSrc },
    collectedFiles,
  });
  const res = { _status: 200, setHeader() {}, status(c) { this._status = c; return this; }, json(o) { this._body = o; return this; } };
  await handler({ method: "POST", query: { action: "preview" }, headers: {}, body: { scanId, file: "_abap/ZAQMR9998.abap" } }, res);
  assert.equal(res._status, 200);
  assert.deepEqual(res._body.mergedFiles, ["_abap/ZAQMR9998_S01.abap"]);
  const block = res._body.elements.find((e) => e.type === "block-begin");
  assert.equal(block.title, "조회 조건");
  const param = res._body.elements.find((e) => e.type === "parameter");
  assert.equal(param.label, "테스트 필드");
});

test("api action=scan-get 는 collectedFiles(원본 소스 전체)도 응답에 포함하지 않는다", async () => {
  const scanId = saveScan({
    repoUrl: "git@github.com:a/b.git", branch: "main", path: "",
    issues: [], fileCount: 1, files: ["a.prog.abap"], fileContents: { "a.prog.abap": "REPORT a." },
    collectedFiles: [{ name: "a.prog.abap", content: "REPORT a." }],
  });
  const res = { _status: 200, setHeader() {}, status(c) { this._status = c; return this; }, json(o) { this._body = o; return this; } };
  await handler({ method: "GET", query: { action: "scan-get", scanId }, headers: {}, body: {} }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.collectedFiles, undefined);
});

test("api action=scan-get 는 fileContents 를 응답에 포함하지 않는다(불필요한 소스 노출 방지)", async () => {
  const scanId = saveScan({
    repoUrl: "git@github.com:a/b.git", branch: "main", path: "",
    issues: [], fileCount: 1, files: ["a.prog.abap"], fileContents: { "a.prog.abap": "REPORT a." },
  });
  const res = { _status: 200, setHeader() {}, status(c) { this._status = c; return this; }, json(o) { this._body = o; return this; } };
  await handler({ method: "GET", query: { action: "scan-get", scanId }, headers: {}, body: {} }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.fileContents, undefined);
});
