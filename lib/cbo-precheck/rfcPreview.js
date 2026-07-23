// lib/cbo-precheck/rfcPreview.js — SAP RFC Function Module technical preview parser.
import { detectAbapObject, isRfcDdicDoc, stripAbapComments } from "./abapObject.js";

const SECTIONS = ["IMPORTING", "EXPORTING", "CHANGING", "TABLES", "EXCEPTIONS"];

function cleanInterfaceLine(line) {
  return String(line || "")
    .replace(/^[\s*"]+/, "")
    .trim();
}

function emptyInterface() {
  return { importing: [], exporting: [], changing: [], tables: [], exceptions: [] };
}

function sectionKey(section) {
  return String(section || "").toLowerCase();
}

function parseParameter(section, raw) {
  let text = String(raw || "").trim().replace(/\.$/, "");
  if (!text) return null;
  const optional = /\bOPTIONAL\b/i.test(text);
  const defaultMatch = text.match(/\bDEFAULT\s+(.+)$/i);
  const defaultValue = defaultMatch ? defaultMatch[1].replace(/\bOPTIONAL\b/i, "").trim() : null;
  text = text.replace(/\bOPTIONAL\b/ig, "").replace(/\bDEFAULT\s+.+$/i, "").trim();

  let match = text.match(/^(?:VALUE|REFERENCE)\(\s*([A-Za-z_][\w]*)\s*\)\s+(TYPE|LIKE|STRUCTURE)\s+(.+)$/i)
    || text.match(/^([A-Za-z_][\w]*)\s+(TYPE|LIKE|STRUCTURE)\s+(.+)$/i)
    || text.match(/^([A-Za-z_][\w]*)\b(?:\s+(.+))?$/i);
  if (!match) return null;
  const name = match[1].toUpperCase();
  const typing = match[2] ? match[2].toUpperCase() : "";
  const dataType = String(match[3] || "").trim().split(/\s+/)[0] || "";
  return { section, name, typing, dataType, optional, defaultValue };
}

export function parseRfcInterface(source) {
  const lines = String(source || "").split(/\r?\n/);
  const out = emptyInterface();
  const warnings = [];
  let inInterface = false;
  let current = null;
  let foundLocalInterface = false;

  for (const line of lines) {
    const cleaned = cleanInterfaceLine(line);
    if (!inInterface) {
      if (/^Local Interface:/i.test(cleaned) || /^"\*Local Interface:/i.test(cleaned)) {
        inInterface = true;
        foundLocalInterface = true;
      }
      continue;
    }
    if (/^-{5,}$/.test(cleaned) || /^ENDFUNCTION\b/i.test(cleaned)) break;
    const section = SECTIONS.find((s) => new RegExp(`^${s}\\b`, "i").test(cleaned));
    if (section) {
      current = section;
      continue;
    }
    if (!current || !cleaned) continue;
    const param = parseParameter(current, cleaned);
    if (param) out[sectionKey(current)].push(param);
  }

  if (!foundLocalInterface) warnings.push("Local Interface 주석을 찾지 못해 인터페이스는 가능한 범위만 표시합니다.");
  if (foundLocalInterface && !Object.values(out).some((items) => items.length)) {
    warnings.push("Local Interface 주석은 있으나 파라미터를 해석하지 못했습니다.");
  }
  return { interface: out, warnings };
}

function stripStringsAndComments(source) {
  return stripAbapComments(source).replace(/'(?:''|[^'])*'/g, "''");
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map((v) => String(v).toUpperCase()))].sort();
}

function extractProcessingSteps(source) {
  const steps = [];
  for (const line of String(source || "").split(/\r?\n/)) {
    const match = line.match(/^\s*\*\s*(\d{1,2})\.\s+(.+?)\s*$/);
    if (match) steps.push({ no: Number(match[1]), text: match[2].trim() });
  }
  return steps;
}

function extractForms(cleaned) {
  return uniqueSorted([...cleaned.matchAll(/\bFORM\s+([A-Za-z_][\w]*)\b/gi)].map((m) => m[1]));
}

function extractCalls(cleaned) {
  return uniqueSorted([...cleaned.matchAll(/\bCALL\s+FUNCTION\s+(?:'([^']+)'|([A-Za-z_][\w]*|`[^`]+`))/gi)]
    .map((m) => String(m[1] || m[2] || "").replace(/[`'"]/g, "")));
}

function extractTables(cleaned) {
  const read = [];
  const written = [];
  for (const match of cleaned.matchAll(/\bSELECT\b[\s\S]*?\bFROM\s+([A-Za-z_][\w/]*)/gi)) read.push(match[1]);
  for (const match of cleaned.matchAll(/\b(?:INSERT|UPDATE|MODIFY|DELETE)\s+([A-Za-z_][\w/]*)/gi)) {
    const table = match[1];
    if (!/^(TABLE|FROM|ADJACENT|DATASET|HANDLER|VALUE|TASK)$/i.test(table)) written.push(table);
  }
  return { readTables: uniqueSorted(read), writtenTables: uniqueSorted(written) };
}

export function extractRfcTechnicalSummary(source) {
  const commentStripped = stripAbapComments(source);
  const cleaned = commentStripped.replace(/'(?:''|[^'])*'/g, "''");
  const tables = extractTables(cleaned);
  return {
    calledFunctions: extractCalls(commentStripped),
    readTables: tables.readTables,
    writtenTables: tables.writtenTables,
    forms: extractForms(cleaned),
    commits: /\bCOMMIT\s+WORK\b/i.test(cleaned),
    rollbacks: /\bROLLBACK\s+WORK\b/i.test(cleaned),
    processingSteps: extractProcessingSteps(source),
  };
}

function dirOf(name) {
  const n = String(name || "").replaceAll("\\", "/");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(0, i) : "";
}

export function findRelatedDdicFile(fileName, objectName, siblingFiles = []) {
  const dir = dirOf(fileName);
  const expected = `${String(objectName || "").toUpperCase()}_DDIC.TXT`;
  const found = siblingFiles.find((f) => {
    const name = String(f?.name || "").replaceAll("\\", "/");
    if (!isRfcDdicDoc(name) || dirOf(name) !== dir) return false;
    return name.split("/").pop().toUpperCase() === expected;
  });
  return found ? found.name : null;
}

export function buildRfcPreview(fileName, source, siblingFiles = []) {
  const object = detectAbapObject(source, fileName);
  const parsed = parseRfcInterface(source);
  const relatedDdicFile = findRelatedDdicFile(fileName, object.name, siblingFiles);
  const warnings = [
    ...parsed.warnings,
    "RFC Function Module에는 SAP GUI Selection Screen이 없어 기술 미리보기로 표시합니다.",
  ];
  if (!relatedDdicFile) warnings.push("관련 DDIC 참고 문서를 찾지 못했습니다.");
  return {
    file: fileName,
    objectType: "function-module",
    objectName: object.name,
    elements: [],
    coverage: { parsed: Object.values(parsed.interface).reduce((sum, items) => sum + items.length, 0), unparsed: 0 },
    rfcInterface: parsed.interface,
    technicalSummary: extractRfcTechnicalSummary(source),
    relatedDdicFile,
    warnings,
  };
}
