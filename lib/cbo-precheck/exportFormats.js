// lib/cbo-precheck/exportFormats.js — 스캔 결과를 xlsx/md/txt/json 으로 변환.
import ExcelJS from "exceljs";

const COLUMNS = ["No", "파일", "라인", "심각도", "룰", "메시지", "처리상태", "메모"];

function statusLabel(status) {
  if (status === "held") return "보류";
  if (status === "resolved") return "해결";
  return "미처리";
}

// 수식 주입 방지(=,+,-,@ 로 시작하는 셀은 텍스트로 고정) — lib/cbo-review/extract.js 와 동일 패턴.
function safeCell(value) {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function rows(issues) {
  return issues.map((issue, index) => [
    index + 1,
    issue.file,
    issue.line,
    issue.severity,
    issue.rule,
    issue.message,
    statusLabel(issue.status),
    issue.note || "",
  ]);
}

export async function toXlsx(issues, { title = "CBO Pre-Check" } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Stella Clover CBO Pre-Check";
  const sheet = workbook.addWorksheet(title.slice(0, 31) || "Scan");
  sheet.columns = COLUMNS.map((header, i) => ({ header, key: `c${i}`, width: i === 5 ? 60 : 16 }));
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF136F63" } };
  for (const row of rows(issues)) sheet.addRow(row.map(safeCell));
  sheet.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function toMarkdown(issues, { title = "CBO Pre-Check" } = {}) {
  const lines = [`# ${title}`, "", `검출 ${issues.length}건`, "", `| ${COLUMNS.join(" | ")} |`, `| ${COLUMNS.map(() => "---").join(" | ")} |`];
  for (const row of rows(issues)) lines.push(`| ${row.map((v) => String(v).replaceAll("|", "\\|").replaceAll("\n", " ")).join(" | ")} |`);
  return lines.join("\n") + "\n";
}

export function toTxt(issues, { title = "CBO Pre-Check" } = {}) {
  const lines = [title, `검출 ${issues.length}건`, ""];
  for (const row of rows(issues)) lines.push(row.join("\t"));
  return lines.join("\n") + "\n";
}

export function toJson(issues, { title = "CBO Pre-Check", scanId } = {}) {
  return JSON.stringify({ title, scanId, count: issues.length, issues }, null, 2);
}

export const CONTENT_TYPES = Object.freeze({
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
});

export async function exportScan(issues, format, opts = {}) {
  if (format === "xlsx") return toXlsx(issues, opts);
  if (format === "md") return toMarkdown(issues, opts);
  if (format === "txt") return toTxt(issues, opts);
  if (format === "json") return toJson(issues, opts);
  throw new Error(`지원하지 않는 export 포맷: ${format}`);
}
