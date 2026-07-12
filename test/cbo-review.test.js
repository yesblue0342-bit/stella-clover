import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
  applyFindings, assertSafeRelativePath, chunkSource, detectLanguage, extractMainTitle,
  normalizeFindings, parseJsonObject, sanitizeName, specFileName, validateProviderModel,
} from "../lib/cbo-review/core.js";
import { extractBuffer, markdownToWorkbook } from "../lib/cbo-review/extract.js";
import { parseGitHubUrl } from "../lib/cbo-review/repository.js";

test("파일명 규칙: KST 날짜와 안전한 제목을 사용한다", () => {
  const name = specFileName({ title: "ZAQMR0130 / 검사유형?", extension: "md", date: new Date("2026-07-11T16:00:00Z") });
  assert.equal(name, "spec_20260712_ZAQMR0130_검사유형.md");
  assert.equal(sanitizeName("../bad:*name"), "bad_name");
});

test("프로그램 ID를 메인 제목으로 우선 추출한다", () => {
  assert.equal(extractMainTitle({ prompt: "ZAQMR0130 프로그램 기능 스펙", generated: "# 다른 제목" }), "ZAQMR0130");
});

test("ABAP과 일반 언어를 구분한다", () => {
  assert.equal(detectLanguage("report.txt", "REPORT zaqmr0130.\nDATA: lv_matnr TYPE matnr."), "ABAP");
  assert.equal(detectLanguage("app.py", "print('ok')"), "Python");
});

test("대용량 소스를 줄 경계를 유지해 분할한다", () => {
  const chunks = chunkSource({ name: "z.abap", content: "a\n".repeat(100) }, 20);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].startLine, 1);
  assert.ok(chunks[1].startLine > chunks[0].startLine);
  assert.ok(chunks.every((item) => item.chunked));
});

test("AI JSON 코드펜스와 지적사항 라인을 정규화한다", () => {
  const parsed = parseJsonObject('```json\n{"findings":[{"line":2,"severity":"High","reason":"x","before":"A","after":"B"}]}\n```');
  const findings = normalizeFindings(parsed, "z.abap", 10);
  assert.equal(findings[0].line, 11);
  assert.equal(findings[0].severity, "High");
});

test("선택한 finding만 원문 일치 방식으로 적용한다", () => {
  const result = applyFindings("A B C", [{ id: "1", before: "B", after: "X" }, { id: "2", before: "Q", after: "Y" }]);
  assert.equal(result.content, "A X C");
  assert.deepEqual(result.applied, ["1"]);
  assert.deepEqual(result.skipped, ["2"]);
});

test("중복 원문은 finding line에 가장 가까운 위치만 수정한다", () => {
  const source = "FORM first.\nWRITE 'same'.\nENDFORM.\nFORM second.\nWRITE 'same'.\nENDFORM.";
  const result = applyFindings(source, [{ id: "line5", line: 5, before: "WRITE 'same'.", after: "WRITE 'changed'." }]);
  assert.match(result.content, /FORM first\.\nWRITE 'same'\./);
  assert.match(result.content, /FORM second\.\nWRITE 'changed'\./);
});

test("provider별 모델 문자열과 repo 경로 allowlist를 검증한다", () => {
  assert.deepEqual(validateProviderModel("openai", "gpt-5.6"), { provider: "openai", model: "gpt-5.6" });
  assert.throws(() => validateProviderModel("openai", "claude-opus-4-8"), /허용/);
  assert.equal(assertSafeRelativePath("src/z.abap"), "src/z.abap");
  assert.throws(() => assertSafeRelativePath("../secret"), /허용/);
  assert.equal(parseGitHubUrl("https://github.com/yesblue0342-bit/0Program/blob/main/src/z.abap"), "src/z.abap");
  assert.throws(() => parseGitHubUrl("https://github.com/other/repo/blob/main/a"), /링크만/);
});

test("텍스트와 XLSX 첨부를 추출한다", async () => {
  const text = await extractBuffer("sample.abap", Buffer.from("REPORT ztest."));
  assert.equal(text.content, "REPORT ztest.");
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Input").addRow(["MATNR", "WERKS"]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const extracted = await extractBuffer("input.xlsx", xlsx);
  assert.match(extracted.content, /MATNR\tWERKS/);
});

test("Markdown을 섹션별 XLSX로 만들고 수식 주입을 방지한다", async () => {
  const buffer = await markdownToWorkbook("# 개요\n=HYPERLINK(\"x\")\n## 테스트\n정상", "Spec");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.worksheets.length, 2);
  assert.equal(workbook.worksheets[0].getCell("B3").value, "'=HYPERLINK(\"x\")");
});
