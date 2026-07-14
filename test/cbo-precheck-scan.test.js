import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { scanFiles, buildConfig, RULES } from "../lib/cbo-precheck/scan.js";
import { exportScan, toMarkdown, toTxt, toJson } from "../lib/cbo-precheck/exportFormats.js";
import { saveScan, getScan, updateIssue } from "../lib/cbo-precheck/store.js";

const bad = fs.readFileSync("fixtures/zaqmr0130_bad.prog.abap", "utf8");
const ddic = fs.readFileSync("fixtures/ddic/qals.tabl.xml", "utf8");

test("GATE 1: 의도적 오류 fixture 스캔 시 5개 룰이 동시 검출된다(unused_variables 제외)", () => {
  const { issues, fileCount } = scanFiles({
    files: [
      { name: "zaqmr0130_bad.prog.abap", content: bad },
      { name: "qals.tabl.xml", content: ddic },
    ],
  });
  assert.equal(fileCount, 1, "DDIC XML은 스캔 대상 파일 수에 포함되지 않는다");
  assert.equal(issues.length, 5);

  const byRule = {};
  for (const issue of issues) byRule[issue.rule] = (byRule[issue.rule] || 0) + 1;
  assert.deepEqual(byRule, {
    obsolete_statement: 1,
    sql_escape_host_variables: 2,
    unknown_types: 1,
    check_syntax: 1,
  });
  assert.ok(issues.every((i) => i.file === "zaqmr0130_bad.prog.abap"));
  assert.ok(issues.every((i) => Number.isInteger(i.line) && i.line > 0));

  const obsolete = issues.find((i) => i.rule === "obsolete_statement");
  assert.equal(obsolete.quickfixAvailable, true, "MOVE → = 는 abaplint 자동 fix 제공");
  const sqlEscape = issues.filter((i) => i.rule === "sql_escape_host_variables");
  assert.ok(sqlEscape.every((i) => i.quickfixAvailable === true));
});

// abaplint unused_variables 룰은 같은 오브젝트에 다른 syntax 오류(여기서는 미선언 gv_matnr 참조)가 있으면
// 설계상 보고를 건너뛴다(rules/unused_variables.js 주석: "dont report unused variables when there are
// syntax errors"). 6번째 기대 이슈는 그 자체로 실재하는 룰 위반이므로, syntax 오류가 없는 격리된 샘플로
// unused_variables 검출을 별도 검증한다 — WORK_REPORT.md Phase 1 참고.
test("GATE 1 (격리 검증): unused_variables 룰은 다른 syntax 오류가 없으면 정상 검출된다(기대 이슈 6/6 중 6번째)", () => {
  const isolated = `REPORT zisolated.\nDATA: gv_used TYPE i, gv_unused TYPE i.\nWRITE gv_used.\n`;
  const { issues } = scanFiles({ files: [{ name: "zisolated.prog.abap", content: isolated }] });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, "unused_variables");
  assert.match(issues[0].message, /gv_unused/i);
});

test("RULES 는 존재하지 않는 abaplint 룰 키를 포함하지 않는다(check_variables는 실제 없음 — check_syntax로 대체)", () => {
  assert.ok(RULES.check_syntax === true);
  assert.ok(!("check_variables" in RULES));
});

test("buildConfig: syntax.version/errorNamespace 기본값이 미션 사양과 일치한다", () => {
  const config = buildConfig();
  assert.equal(config.syntax.version, "v755");
  assert.equal(config.syntax.errorNamespace, "^(Z|Y)");
  assert.equal(config.rules["7bit_ascii"], false);
});

test("정상 fixture(zaqmr0130_good)는 planted 오류가 없어 이슈 0건이다", () => {
  const good = fs.readFileSync("fixtures/zaqmr0130_good.prog.abap", "utf8");
  const { issues } = scanFiles({
    files: [
      { name: "zaqmr0130_good.prog.abap", content: good },
      { name: "qals.tabl.xml", content: ddic },
    ],
  });
  assert.deepEqual(issues, []);
});

test("export: xlsx/md/txt/json 4개 포맷 모두 생성된다", async () => {
  const { issues } = scanFiles({
    files: [
      { name: "zaqmr0130_bad.prog.abap", content: bad },
      { name: "qals.tabl.xml", content: ddic },
    ],
  });

  const xlsx = await exportScan(issues, "xlsx", { title: "테스트" });
  assert.ok(Buffer.isBuffer(xlsx) && xlsx.length > 0);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsx);
  assert.equal(workbook.worksheets.length, 1);
  assert.equal(workbook.worksheets[0].getRow(1).getCell(1).value, "No");
  assert.equal(workbook.worksheets[0].rowCount, issues.length + 1);

  const md = await exportScan(issues, "md", { title: "테스트" });
  assert.match(md, /^# 테스트/);
  assert.match(md, /obsolete_statement/);
  assert.equal(md, toMarkdown(issues, { title: "테스트" }));

  const txt = await exportScan(issues, "txt", { title: "테스트" });
  assert.match(txt, /검출 5건/);
  assert.equal(txt, toTxt(issues, { title: "테스트" }));

  const jsonStr = await exportScan(issues, "json", { title: "테스트", scanId: "abc" });
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.scanId, "abc");
  assert.equal(parsed.count, 5);
  assert.equal(jsonStr, toJson(issues, { title: "테스트", scanId: "abc" }));

  await assert.rejects(() => exportScan(issues, "pdf"), /지원하지 않는/);
});

test("export xlsx: 수식 주입 문자열은 텍스트로 고정된다", async () => {
  const issues = [{ file: "a.prog.abap", line: 1, severity: "Error", rule: "x", message: "=1+1", status: "open", note: "" }];
  const xlsx = await exportScan(issues, "xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsx);
  const cell = workbook.worksheets[0].getRow(2).getCell(6).value;
  assert.equal(cell, "'=1+1");
});

test("store: saveScan/getScan/updateIssue 로 스캔 결과 상태를 관리한다", () => {
  const scanId = saveScan({ repoUrl: "git@github.com:a/b.git", branch: "main", path: "", issues: [{ file: "a.prog.abap", line: 1, col: 1, severity: "Error", rule: "x", message: "m", quickfixAvailable: false }], fileCount: 1 });
  const scan = getScan(scanId);
  assert.equal(scan.issues.length, 1);
  assert.equal(scan.issues[0].status, "open");
  const updated = updateIssue(scanId, scan.issues[0].id, { status: "held", note: "다음 스프린트" });
  assert.equal(updated.status, "held");
  assert.equal(getScan(scanId).issues[0].note, "다음 스프린트");
  assert.throws(() => updateIssue("nope", "nope", { status: "held" }), /찾을 수 없습니다/);
});
