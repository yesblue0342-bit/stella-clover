// lib/cbo-review/reviewExport.js — 코드 리뷰 결과(지적 목록)를 문서로 내보내기.
//
// 프런트가 검토 결과(reviewResult.files/summary)를 그대로 POST하면 Markdown/Excel로 변환한다(서버 상태 의존 없음).
// ★ Markdown 은 "지적사항을 한 번에 프롬프트로 반영"하려는 요구를 위해 상단에 지시문을 넣고 각 항목의
//   Before/After 를 코드펜스로 감싸, 그대로 AI에 붙여 일괄 수정 지시로 쓸 수 있게 한다.
// exceljs 는 워크북 생성 시에만 동적 import — Markdown 경로/모듈 로드는 exceljs 없이도 동작(테스트 용이).

const SEV = { High: 0, Mid: 1, Low: 2 };
const MAX_FINDINGS = 2000; // 병리적 대량 입력 방어(문서·응답 크기 상한)

function fenceFor(text) {
  return String(text || "").includes("```") ? "~~~~" : "```";
}
function langHint(language) {
  const l = String(language || "").toLowerCase();
  if (l.includes("abap")) return "abap";
  if (l.includes("javascript") || l.includes("typescript")) return "js";
  if (l.includes("python")) return "python";
  if (l.includes("java")) return "java";
  if (l.includes("sql")) return "sql";
  return "";
}

// files(검토 결과) → 지적 1건 = 1행. 파일명/언어를 각 행에 붙인다.
export function flattenFindings(files) {
  const rows = [];
  for (const file of Array.isArray(files) ? files : []) {
    const name = String(file?.name || "(파일명 없음)");
    const language = String(file?.language || "");
    for (const f of Array.isArray(file?.findings) ? file.findings : []) {
      rows.push({
        file: name, language,
        line: Number(f?.line || 0),
        severity: ["High", "Mid", "Low"].includes(f?.severity) ? f.severity : "Low",
        reason: String(f?.reason || ""),
        before: String(f?.before || ""),
        after: String(f?.after || ""),
      });
      if (rows.length >= MAX_FINDINGS) return rows;
    }
  }
  return rows;
}

function summaryLine(summary, count) {
  const s = summary || {};
  const sev = s.severities || {};
  const parts = [
    `파일 ${s.fileCount ?? "?"}`,
    `지적 ${s.findingCount ?? count}`,
    `High ${sev.High ?? 0}`, `Mid ${sev.Mid ?? 0}`, `Low ${sev.Low ?? 0}`,
  ];
  if (s.failed) parts.push(`부분 실패 ${s.failed}`);
  return parts.join(" · ");
}

export function reviewToMarkdown({ title, files, summary } = {}) {
  const rows = flattenFindings(files);
  const out = [];
  out.push(`# 코드 리뷰 결과 — ${String(title || "CBO 코드 리뷰")}`);
  out.push(`> ${summaryLine(summary, rows.length)}`);
  out.push("");
  out.push("아래 지적사항을 모두 반영해 소스를 수정해줘. 각 항목은 **Before** 코드를 **After** 코드로 교체한다. 확인되지 않은 SAP 오브젝트/필드는 임의로 만들지 말고 '확인 필요'로 남긴다.");
  out.push("");

  const byFile = new Map();
  for (const r of rows) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r); }
  const fileMeta = new Map((Array.isArray(files) ? files : []).map((f) => [String(f?.name || ""), f]));

  for (const [file, list] of byFile) {
    const meta = fileMeta.get(file) || {};
    out.push(`## ${file}${meta.language ? ` (${meta.language})` : ""}`);
    if (meta.summary) out.push(`_요약: ${String(meta.summary).replace(/\s*\n+\s*/g, " ")}_`);
    out.push("");
    list.sort((a, b) => (SEV[a.severity] - SEV[b.severity]) || (a.line - b.line));
    for (const r of list) {
      const lang = langHint(r.language);
      const bf = fenceFor(r.before);
      const af = fenceFor(r.after);
      out.push(`### [${r.severity}] Line ${r.line}`);
      if (r.reason) out.push(`- 사유: ${r.reason.replace(/\s*\n+\s*/g, " ")}`);
      out.push("");
      out.push("**Before**");
      out.push(`${bf}${lang}`);
      out.push(r.before);
      out.push(bf);
      out.push("**After**");
      out.push(`${af}${lang}`);
      out.push(r.after);
      out.push(af);
      out.push("");
    }
  }
  if (!rows.length) out.push("_지적사항이 없습니다._");
  return out.join("\n");
}

export async function reviewToWorkbook({ title, files, summary } = {}) {
  const { default: ExcelJS } = await import("exceljs");
  const rows = flattenFindings(files);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Stella Clover CBO Review";

  const info = workbook.addWorksheet("요약");
  info.columns = [{ header: "항목", key: "k", width: 20 }, { header: "값", key: "v", width: 90 }];
  headerStyle(info);
  info.addRow({ k: "제목", v: String(title || "CBO 코드 리뷰") });
  info.addRow({ k: "요약", v: summaryLine(summary, rows.length) });
  info.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; });

  const sheet = workbook.addWorksheet("지적사항");
  sheet.columns = [
    { header: "파일", key: "file", width: 32 },
    { header: "라인", key: "line", width: 8 },
    { header: "심각도", key: "severity", width: 10 },
    { header: "사유", key: "reason", width: 50 },
    { header: "Before", key: "before", width: 55 },
    { header: "After", key: "after", width: 55 },
  ];
  headerStyle(sheet);
  for (const r of rows) {
    sheet.addRow({ file: r.file, line: r.line, severity: r.severity, reason: cell(r.reason), before: cell(r.before), after: cell(r.after) });
  }
  sheet.eachRow((row, n) => { if (n > 1) row.alignment = { vertical: "top", wrapText: true }; });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function headerStyle(sheet) {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF136F63" } };
}
// Excel 수식 인젝션 방지 — =,+,-,@ 로 시작하는 셀은 앞에 ' 를 붙인다(markdownToWorkbook 과 동일 규칙).
function cell(value) {
  const text = String(value || "");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}
