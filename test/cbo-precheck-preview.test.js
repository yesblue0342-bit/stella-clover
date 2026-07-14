import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parsePreview } from "../lib/cbo-precheck/preview.js";
import { saveScan } from "../lib/cbo-precheck/store.js";
import handler from "../api/cbo-precheck.js";

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
