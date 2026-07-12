import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { TEXT_EXTENSIONS } from "./core.js";

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 250000;

export async function extractBuffer(name, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("빈 파일입니다.");
  if (buffer.length > MAX_FILE_BYTES) throw new Error("파일 크기가 15MB를 초과합니다.");
  const ext = path.extname(String(name || "")).toLowerCase();
  let content = "";
  if (TEXT_EXTENSIONS.has(ext) || !ext) {
    content = buffer.toString("utf8").replace(/^\uFEFF/, "");
  } else if (ext === ".xlsx" || ext === ".xlsm") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    content = workbook.worksheets.map((sheet) => {
      const rows = [];
      sheet.eachRow((row) => rows.push(row.values.slice(1).map((cell) => typeof cell === "object" ? JSON.stringify(cell) : String(cell ?? "")).join("\t")));
      return `# Sheet: ${sheet.name}\n${rows.join("\n")}`;
    }).join("\n\n");
  } else if (ext === ".docx") {
    content = (await mammoth.extractRawText({ buffer })).value;
  } else if (ext === ".pdf") {
    const parser = new PDFParse({ data: buffer });
    try { content = (await parser.getText()).text; }
    finally { await parser.destroy(); }
  } else {
    throw new Error("텍스트 추출을 지원하지 않는 파일 형식입니다.");
  }
  if (!content.trim()) throw new Error("추출 가능한 텍스트가 없습니다.");
  return { name: path.basename(name), content: content.slice(0, MAX_TEXT_CHARS), truncated: content.length > MAX_TEXT_CHARS };
}

export async function extractFile(file) {
  return extractBuffer(file.originalFilename || file.name || "attachment", await fs.readFile(file.filepath || file.path));
}

export async function markdownToWorkbook(markdown, title) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Stella Clover CBO Review";
  const sections = String(markdown || "").split(/\n(?=##?\s+)/).filter(Boolean);
  for (const [index, section] of sections.entries()) {
    const lines = section.split(/\r?\n/);
    const heading = lines.shift()?.replace(/^#+\s*/, "") || `Section ${index + 1}`;
    const sheet = workbook.addWorksheet(heading.replace(/[\\/*?:\[\]]/g, "_").slice(0, 31) || `Section ${index + 1}`);
    sheet.columns = [{ header: "구분", key: "type", width: 18 }, { header: "내용", key: "content", width: 100 }];
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF136F63" } };
    sheet.addRow({ type: "제목", content: heading });
    for (const line of lines) sheet.addRow({ type: line.startsWith("|") ? "표" : "본문", content: safeExcelCell(line) });
    sheet.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; });
  }
  if (!workbook.worksheets.length) workbook.addWorksheet("Spec").addRow(["제목", title || "CBO Spec"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function safeExcelCell(value) {
  const text = String(value || "");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}
