import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { detectAbapObject } from "../lib/cbo-precheck/abapObject.js";
import { parseRfcInterface, extractRfcTechnicalSummary, buildRfcPreview } from "../lib/cbo-precheck/rfcPreview.js";
import { buildPreview } from "../lib/cbo-precheck/preview.js";
import { buildDirectFilePreviewResponse, buildDirectFolderPreviewResponse } from "../api/cbo-precheck.js";

const rfcSource = fs.readFileSync("fixtures/rfc/ZAQMF_RECV_DEVIATION_FROM_QMS.abap", "utf8");
const ddicSource = fs.readFileSync("fixtures/rfc/ZAQMF_RECV_DEVIATION_FROM_QMS_DDIC.txt", "utf8");
const rfcFile = { name: "ZAQMF_RECV_DEVIATION_FROM_QMS.abap", content: rfcSource };
const ddicFile = { name: "ZAQMF_RECV_DEVIATION_FROM_QMS_DDIC.txt", content: ddicSource, isRfcDdic: true };

test("detectAbapObject: FUNCTION 선언을 function-module로 판별한다", () => {
  assert.deepEqual(detectAbapObject(rfcSource, rfcFile.name), {
    type: "function-module",
    name: "ZAQMF_RECV_DEVIATION_FROM_QMS",
    previewable: true,
  });
});

test("detectAbapObject: CALL FUNCTION을 Function Module 선언으로 오인하지 않는다", () => {
  const src = "REPORT zcall.\nCALL FUNCTION 'Z_FM'.\n";
  const obj = detectAbapObject(src, "zcall.abap");
  assert.equal(obj.type, "report");
  assert.equal(obj.name, "ZCALL");
});

test("detectAbapObject: 소문자 function 선언을 인식한다", () => {
  const obj = detectAbapObject("function zlower_case.\nendfunction.", "zlower_case.abap");
  assert.equal(obj.type, "function-module");
  assert.equal(obj.name, "ZLOWER_CASE");
});

test("parseRfcInterface: IMPORTING/OPTIONAL/DEFAULT를 파싱한다", () => {
  const { interface: iface } = parseRfcInterface(rfcSource);
  const eaiIf = iface.importing.find((p) => p.name === "EAI_IF_ID");
  assert.equal(eaiIf.typing, "TYPE");
  assert.equal(eaiIf.dataType, "CHAR16");
  assert.equal(eaiIf.optional, false);
  const eaiUser = iface.importing.find((p) => p.name === "EAI_USER");
  assert.equal(eaiUser.optional, true);
  const mode = iface.importing.find((p) => p.name === "EAI_MODE");
  assert.equal(mode.defaultValue, "'N'");
});

test("parseRfcInterface: EXPORTING을 파싱한다", () => {
  const { interface: iface } = parseRfcInterface(rfcSource);
  assert.deepEqual(iface.exporting.map((p) => p.name), ["EV_CD", "EV_MSG"]);
});

test("parseRfcInterface: TABLES STRUCTURE를 파싱한다", () => {
  const { interface: iface } = parseRfcInterface(rfcSource);
  const table = iface.tables.find((p) => p.name === "T_TABLE");
  assert.equal(table.typing, "STRUCTURE");
  assert.equal(table.dataType, "ZAQMS0002");
  const ret = iface.tables.find((p) => p.name === "ET_RETURN");
  assert.equal(ret.optional, true);
});

test("extractRfcTechnicalSummary: FORM 루틴과 CALL FUNCTION을 추출한다", () => {
  const summary = extractRfcTechnicalSummary(rfcSource);
  assert.deepEqual(summary.forms, ["SAVE_RESULT", "VALIDATE_HEADER"]);
  assert.deepEqual(summary.calledFunctions, ["CONVERSION_EXIT_ALPHA_INPUT"]);
});

test("extractRfcTechnicalSummary: SELECT 대상과 INSERT/MODIFY 대상을 구분한다", () => {
  const summary = extractRfcTechnicalSummary(rfcSource);
  assert.deepEqual(summary.readTables, ["ZAQMT0150"]);
  assert.deepEqual(summary.writtenTables, ["ZAQMT0151", "ZAQMT0152"]);
});

test("extractRfcTechnicalSummary: MODIFY VALUE/HANDLER 같은 비테이블 구문은 written table로 오인하지 않는다", () => {
  const summary = extractRfcTechnicalSummary("FUNCTION z.\nMODIFY VALUE #( ( a = 1 ) ).\nSET UPDATE TASK LOCAL.\nMODIFY HANDLER lcl_h=>m.\nUPDATE zaqmt0150 SET a = 1.\nENDFUNCTION.");
  assert.deepEqual(summary.writtenTables, ["ZAQMT0150"]);
});

test("extractRfcTechnicalSummary: COMMIT/ROLLBACK과 번호 기반 processing step을 감지한다", () => {
  const summary = extractRfcTechnicalSummary(rfcSource);
  assert.equal(summary.commits, true);
  assert.equal(summary.rollbacks, true);
  assert.deepEqual(summary.processingSteps.map((s) => s.text), [
    "Header validation",
    "Run header creation",
    "Normalize input and build lookup keys",
  ]);
});

test("buildPreview: RFC 파일 직접 지정 시 objectType=function-module과 DDIC 메타데이터를 반환한다", () => {
  const result = buildPreview(rfcFile.name, rfcFile.content, [rfcFile, ddicFile]);
  assert.equal(result.objectType, "function-module");
  assert.equal(result.objectName, "ZAQMF_RECV_DEVIATION_FROM_QMS");
  assert.equal(result.relatedDdicFile, "ZAQMF_RECV_DEVIATION_FROM_QMS_DDIC.txt");
  assert.equal(result.elements.length, 0);
});

test("buildRfcPreview: Local Interface가 없어도 500 대신 부분 미리보기를 반환한다", () => {
  const result = buildRfcPreview("ZNO_IF.abap", "FUNCTION zno_if.\nCALL FUNCTION 'Z_PING'.\nENDFUNCTION.", []);
  assert.equal(result.objectType, "function-module");
  assert.deepEqual(result.rfcInterface.importing, []);
  assert.match(result.warnings.join(" "), /Local Interface/);
});

test("buildDirectFolderPreviewResponse: REPORT 없이 RFC 하나만 있어도 200", () => {
  const result = buildDirectFolderPreviewResponse([rfcFile, ddicFile]);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.equal(result.body.objectType, "function-module");
});

test("buildDirectFolderPreviewResponse: RFC 여러 개면 multi 응답", () => {
  const second = { name: "ZSECOND.abap", content: "FUNCTION zsecond.\nENDFUNCTION." };
  const result = buildDirectFolderPreviewResponse([rfcFile, second]);
  assert.equal(result.status, 200);
  assert.equal(result.body.multi, true);
  assert.equal(result.body.previews.filter((p) => p.objectType === "function-module").length, 2);
});

test("buildDirectFolderPreviewResponse: REPORT와 RFC가 같이 있으면 둘 다 반환한다", () => {
  const report = { name: "ZREP.abap", content: "REPORT zrep.\nPARAMETERS p_a TYPE c.\n" };
  const result = buildDirectFolderPreviewResponse([report, rfcFile, ddicFile]);
  assert.equal(result.status, 200);
  assert.equal(result.body.multi, true);
  assert.ok(result.body.previews.some((p) => p.objectType === "report" && p.file === "ZREP.abap"));
  assert.ok(result.body.previews.some((p) => p.objectType === "function-module" && p.file === rfcFile.name));
});

test("buildDirectFilePreviewResponse: RFC 파일 직접 지정 시 200", () => {
  const result = buildDirectFilePreviewResponse([rfcFile, ddicFile], rfcFile.name);
  assert.equal(result.status, 200);
  assert.equal(result.body.objectType, "function-module");
});

test("buildDirectFilePreviewResponse: 파일 경로에 공백이 있어도 정상 처리", () => {
  const spaced = { name: "folder with spaces/ZAQMF_RECV_DEVIATION_FROM_QMS.abap", content: rfcSource };
  const spacedDdic = { name: "folder with spaces/ZAQMF_RECV_DEVIATION_FROM_QMS_DDIC.txt", content: ddicSource, isRfcDdic: true };
  const result = buildDirectFilePreviewResponse([spaced, spacedDdic], "ZAQMF_RECV_DEVIATION_FROM_QMS.abap");
  assert.equal(result.status, 200);
  assert.equal(result.body.relatedDdicFile, "folder with spaces/ZAQMF_RECV_DEVIATION_FROM_QMS_DDIC.txt");
});
