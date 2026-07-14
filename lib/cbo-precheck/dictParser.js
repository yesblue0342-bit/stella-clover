// lib/cbo-precheck/dictParser.js — dictionary/*.md · dictionary/*.html DDIC 테이블 문서 파서.
//
// 0Program repo의 프로그램 폴더는 커스텀 DDIC 테이블 정의를 abapGit TABL XML이 아니라 사람이 읽는
// 문서(마크다운 표 또는 HTML 표)로만 제공하는 경우가 있다(WORK_REPORT.md 2026-07-14 세션 실측: 이
// 때문에 abaplint가 해당 테이블 필드 참조를 unknown_types로 오탐한다). 이 모듈은 두 문서 포맷을
// 공통 구조({tableName, ddtext, deliveryClass, tabClass, fields:[...]})로 파싱만 한다 — 원본 문서
// 파일은 절대 수정하지 않고, synthetic TABL XML 생성은 dictToTabl.js가 담당한다(관심사 분리).
//
// "DDIC Table"/"테이블명" 문서만 대상 — Lock Object/Message Class 문서(EZAQM0130.md, ZCQMM1.md 등)는
// 필드 구조가 없어 unknown_types와 무관하므로 parseDictDoc()이 null을 반환해 자연히 걸러진다.

function stripParenSuffix(value) {
  // "ZDE_QM_FLAG(XFELD)" 처럼 데이터 엘리먼트 뒤에 표준 타입 폴백이 괄호로 붙는 표기 — 주 엘리먼트명만 취한다.
  return String(value || "").replace(/\(.*$/, "").trim();
}

function normalizeType(value) {
  return String(value || "").trim().toUpperCase();
}

function toLeng(value) {
  const n = parseInt(String(value || "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isKeyMarked(value) {
  return /^(x|✔|✓|o|y)$/i.test(String(value || "").trim());
}

// 마크다운 표 한 행을 셀 배열로 분리 (`| a | b |` → ["a","b"], 이스케이프된 파이프 `\|`는 보존).
function splitMdRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

export function parseMarkdownDict(content) {
  const text = String(content || "");
  const headerMatch = text.match(/^#\s*DDIC Table:\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:—|-)?\s*(.*)$/im);
  if (!headerMatch) return null;
  const tableName = headerMatch[1].toUpperCase();
  const ddtext = headerMatch[2].trim().slice(0, 60) || tableName;

  const deliveryMatch = text.match(/\*\*Delivery Class:\*\*\s*([A-Za-z])/i);
  const tabClassMatch = text.match(/\*\*Type:\*\*[^\n]*?(Transparent Table|Pooled Table|Cluster Table)/i);

  const lines = text.split("\n");
  const fields = [];
  let inTable = false;
  let headerCells = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("|")) { if (inTable && !line) break; continue; }
    const cells = splitMdRow(line);
    if (!headerCells) { headerCells = cells.map((c) => c.toLowerCase()); inTable = true; continue; }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
    const idx = (label) => headerCells.findIndex((h) => h.includes(label));
    const fieldIdx = idx("field");
    const keyIdx = idx("key");
    const deIdx = idx("data element");
    const typeIdx = idx("type");
    const lenIdx = idx("len");
    const descIdx = headerCells.findIndex((h) => h.includes("description"));
    if (fieldIdx < 0 || !cells[fieldIdx]) continue;
    const name = cells[fieldIdx].toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    fields.push({
      name,
      key: keyIdx >= 0 && isKeyMarked(cells[keyIdx]),
      rollname: deIdx >= 0 ? stripParenSuffix(cells[deIdx]).toUpperCase() : name,
      type: typeIdx >= 0 ? normalizeType(cells[typeIdx]) : "CHAR",
      len: lenIdx >= 0 ? toLeng(cells[lenIdx]) : 0,
      desc: descIdx >= 0 ? cells[descIdx] : "",
    });
  }
  if (!fields.length) return null;

  return {
    tableName,
    ddtext,
    deliveryClass: deliveryMatch ? deliveryMatch[1].toUpperCase() : "A",
    tabClass: tabClassMatch ? "TRANSP" : "TRANSP",
    fields,
  };
}

function stripHtmlTags(value) {
  return String(value || "").replace(/<[^>]*>/g, "").trim();
}

function htmlCells(rowHtml) {
  const cells = [];
  const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m;
  while ((m = re.exec(rowHtml))) cells.push(stripHtmlTags(m[1]));
  return cells;
}

export function parseHtmlDict(content) {
  const html = String(content || "");
  const titleMatch = html.match(/<title>\s*([A-Za-z_][A-Za-z0-9_]*)/i);
  const nameCellMatch = html.match(/테이블명[^<]*<\/td>\s*<td>\s*<b>\s*([A-Za-z_][A-Za-z0-9_]*)/i);
  const tableName = (nameCellMatch?.[1] || titleMatch?.[1] || "").toUpperCase();
  if (!tableName) return null;

  const deliveryMatch = html.match(/Delivery Class<\/td>\s*<td>\s*([A-Za-z])/i);
  const ddtextMatch = html.match(/Short Description<\/td>\s*<td>\s*([^<]+)</i);

  // "테이블 필드" 표만 대상 — 상단 메타 표(항목/값)와 헤더 표(Pos/Field/Key/...)를 구분한다.
  const fieldSectionMatch = html.match(/테이블\s*필드[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!fieldSectionMatch) return null;
  const rows = fieldSectionMatch[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  if (rows.length < 2) return null;

  const headerCells = htmlCells(rows[0]).map((c) => c.toLowerCase());
  const idx = (label) => headerCells.findIndex((h) => h.includes(label));
  const posIdx = idx("pos");
  const fieldIdx = idx("field");
  const keyIdx = idx("key");
  const deIdx = idx("data element");
  const typeIdx = idx("type");
  const lenIdx = idx("len");
  const descIdx = headerCells.findIndex((h) => h.includes("설명") || h.includes("desc"));
  if (fieldIdx < 0) return null;

  const fields = [];
  for (const row of rows.slice(1)) {
    const cells = htmlCells(row);
    if (!cells.length) continue;
    const name = (cells[fieldIdx] || "").toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    fields.push({
      name,
      key: keyIdx >= 0 && isKeyMarked(cells[keyIdx]),
      rollname: deIdx >= 0 ? stripParenSuffix(cells[deIdx]).toUpperCase() : name,
      type: typeIdx >= 0 ? normalizeType(cells[typeIdx]) : "CHAR",
      len: lenIdx >= 0 ? toLeng(cells[lenIdx]) : 0,
      desc: descIdx >= 0 ? cells[descIdx] : "",
    });
  }
  if (!fields.length) return null;
  void posIdx;

  return {
    tableName,
    ddtext: (ddtextMatch?.[1] || tableName).trim().slice(0, 60),
    deliveryClass: deliveryMatch ? deliveryMatch[1].toUpperCase() : "A",
    tabClass: "TRANSP",
    fields,
  };
}

// repo 내 경로가 "dictionary/" 폴더 밑의 .md 또는 .html(.htm)인지 — 이 두 포맷만 파싱 대상.
export function isDictionaryDoc(name) {
  return /(^|\/)dictionary\/[^/]+\.(md|html?|htm)$/i.test(String(name || ""));
}

// name 확장자로 포맷을 골라 파싱한다. "DDIC Table" 구조가 없는 문서(Lock Object/Message Class 등)는
// null을 반환 — 호출부가 조용히 건너뛴다.
export function parseDictDoc(name, content) {
  if (/\.md$/i.test(name)) return parseMarkdownDict(content);
  if (/\.html?$/i.test(name)) return parseHtmlDict(content);
  return null;
}
