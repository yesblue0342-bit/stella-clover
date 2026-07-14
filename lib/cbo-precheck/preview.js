// lib/cbo-precheck/preview.js — Selection Screen / ALV 화면 미리보기 파서(Phase 3).
//
// @abaplint/core AST(문장 단위 토큰 스트림)를 우선 사용하고, ALV fieldcatalog의 `VALUE #( ... )` 생성자
// 패턴만 정규식으로 보조 파싱한다(미션 문서: "AST로 못 얻는 항목만 정규식 보조"). 파싱 불가 구문은 건너뛰지
// 않고 unparsed 항목으로 목록화한다.
import abaplint from "@abaplint/core";
import { virtualizeName } from "./scan.js";

const { Config, MemoryFile, Registry } = abaplint;

function tok(statement) {
  return statement.getTokens().map((t) => t.getStr());
}

function stripQuotes(value) {
  const s = String(value || "");
  return s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1) : s;
}

// TYPE 뒤 dash-체인(qals-werk 등)을 공백 없이 이어붙인다. STOP 키워드 전까지가 타입 표현.
function joinChain(tokens, from, stopSet) {
  const parts = [];
  for (let i = from; i < tokens.length; i++) {
    const upper = tokens[i].toUpperCase();
    if (stopSet.has(upper) || tokens[i] === ".") break;
    parts.push(tokens[i]);
  }
  return parts.join("");
}

const PARAM_STOP = new Set(["OBLIGATORY", "DEFAULT", "AS", "LOWER", "CASE", "RADIOBUTTON", "GROUP", "VISIBLE", "MATCHCODE", "MODIF", "LENGTH", "NO-DISPLAY"]);

function parseParameter(tokens) {
  const upper = tokens.map((t) => t.toUpperCase());
  const el = {
    type: "parameter", name: tokens[1], dataType: null,
    checkbox: upper.includes("AS") && upper.includes("CHECKBOX"),
    radioGroup: upper.includes("RADIOBUTTON") && upper.includes("GROUP") ? tokens[upper.indexOf("GROUP") + 1] : null,
    obligatory: upper.includes("OBLIGATORY"),
    lowerCase: upper.includes("LOWER") && upper.includes("CASE"),
    default: upper.includes("DEFAULT") ? stripQuotes(tokens[upper.indexOf("DEFAULT") + 1]) : null,
  };
  const typeIdx = upper.indexOf("TYPE");
  if (typeIdx >= 0) el.dataType = joinChain(tokens, typeIdx + 1, PARAM_STOP);
  return el;
}

function parseSelectOption(tokens) {
  const upper = tokens.map((t) => t.toUpperCase());
  const forIdx = upper.indexOf("FOR");
  const name = forIdx > 0 ? tokens[forIdx - 1] : tokens[tokens.length - 2];
  const forField = forIdx >= 0 ? joinChain(tokens, forIdx + 1, new Set()) : null;
  return { type: "select-options", name, forField };
}

// TEXT-xxx 심볼 참조를 찾는다(위치 지정자 /1(40) 등을 건너뛰고 TEXT 토큰부터 시작 — USER-COMMAND 앞에서 멈춤).
function findTextRef(tokens, upper) {
  const idx = upper.indexOf("TEXT");
  if (idx < 0) return null;
  return joinChain(tokens, idx, new Set(["USER"])) || null;
}

function parseSelectionScreen(tokens) {
  const upper = tokens.map((t) => t.toUpperCase());
  if (upper.includes("BEGIN") && upper.includes("BLOCK")) {
    const name = tokens[upper.indexOf("BLOCK") + 1];
    return { type: "block-begin", name, title: findTextRef(tokens, upper), withFrame: upper.includes("FRAME") };
  }
  if (upper.includes("END") && upper.includes("BLOCK")) {
    return { type: "block-end", name: tokens[upper.indexOf("BLOCK") + 1] };
  }
  if (upper.includes("COMMENT")) {
    return { type: "comment", text: findTextRef(tokens, upper) };
  }
  if (upper.includes("PUSHBUTTON")) {
    const userCommandIdx = upper.indexOf("COMMAND");
    return {
      type: "pushbutton",
      text: findTextRef(tokens, upper),
      userCommand: userCommandIdx >= 0 ? tokens[userCommandIdx + 1] : null,
    };
  }
  return null; // ULINE/POSITION 등 v1 미지원 — unparsed 로 상위에서 표기
}

const FCAT_FIELDS = new Set(["FIELDNAME", "COLTEXT", "SCRTEXT_S", "SCRTEXT_M", "SCRTEXT_L", "OUTPUTLEN", "REPTEXT", "SELTEXT_S", "SELTEXT_M", "SELTEXT_L"]);

function fcatFieldKey(name) {
  const upper = String(name || "").toUpperCase();
  if (upper === "FIELDNAME") return "fieldname";
  if (["COLTEXT", "SCRTEXT_L", "SCRTEXT_M", "SCRTEXT_S", "SELTEXT_L", "SELTEXT_M", "SELTEXT_S", "REPTEXT"].includes(upper)) return "coltext";
  if (upper === "OUTPUTLEN") return "outputlen";
  return null;
}

// APPEND 루프 패턴: <ws>-FIELD = value. 를 누적하다가 APPEND <ws> TO <table>. 를 만나면 한 컬럼으로 확정.
function extractAppendLoopAlv(statements) {
  const pending = new Map(); // workarea → { row, table? }
  const alvByTable = new Map(); // table → columns[]
  for (const st of statements) {
    const name = st.get().constructor.name;
    const tokens = tok(st);
    if (name === "Move" && tokens.length >= 5 && tokens[1] === "-" && tokens[3] === "=") {
      const ws = tokens[0];
      const key = fcatFieldKey(tokens[2]);
      if (!key) continue;
      const value = joinChain(tokens, 4, new Set());
      const row = pending.get(ws) || {};
      row[key] = key === "outputlen" ? Number(value) || value : stripQuotes(value);
      pending.set(ws, row);
    } else if (name === "Append" && tokens[0].toUpperCase() === "APPEND") {
      const ws = tokens[1];
      const table = tokens[3];
      const row = pending.get(ws);
      if (row && row.fieldname) {
        if (!alvByTable.has(table)) alvByTable.set(table, []);
        alvByTable.get(table).push({ fieldname: row.fieldname, coltext: row.coltext || "", outputlen: row.outputlen || null });
        pending.set(ws, {});
      }
    }
  }
  return alvByTable;
}

// VALUE #( ( fieldname = 'X' coltext = 'Y' outputlen = 10 ) ... ) 생성자 — 정규식 보조 파싱(AST로 못 얻는 부분).
function extractValueConstructorAlv(source) {
  const alvByTable = new Map();
  const assignRe = /(\w+)\s*=\s*VALUE\s+#\s*\(([\s\S]*?)\)\s*\.\s*(?=\n|$)/gi;
  let match;
  while ((match = assignRe.exec(source))) {
    const table = match[1];
    const body = match[2];
    const groupRe = /\(([^()]*)\)/g;
    const columns = [];
    let group;
    while ((group = groupRe.exec(body))) {
      const row = {};
      const pairRe = /(\w+)\s*=\s*('(?:[^']|'')*'|\d+)/gi;
      let pair;
      while ((pair = pairRe.exec(group[1]))) {
        const key = fcatFieldKey(pair[1]);
        if (!key) continue;
        row[key] = key === "outputlen" ? Number(stripQuotes(pair[2])) || stripQuotes(pair[2]) : stripQuotes(pair[2]);
      }
      if (row.fieldname) columns.push({ fieldname: row.fieldname, coltext: row.coltext || "", outputlen: row.outputlen || null });
    }
    if (columns.length) alvByTable.set(table, columns);
  }
  return alvByTable;
}

// plain 네이밍(`ZAQMR0130_S01.abap`)이면 abaplint가 타입을 인식 못 해 조용히 건너뛰어 getABAPFiles()가
// 없다(elements:[] 로 조용히 비게 됨 — lib/cbo-precheck/scan.js 상단 주석의 근본 원인과 동일). 단일
// 파일 파싱이라 scanFiles()의 cross-include XML 메타는 필요 없고, scan.js의 `virtualizeName()`(배치
// 스캔과 동일 규칙)으로 가상 abapGit 이름만 바꿔주면 된다. 반환하는 `file`은 항상 원본 fileName 그대로다.
export function parsePreview(source, fileName = "source.prog.abap") {
  const virtualName = virtualizeName(fileName, source);
  const reg = new Registry(new Config(JSON.stringify({
    global: { files: "/src/**/*.*" },
    dependencies: [],
    syntax: { version: "v755", errorNamespace: "^(Z|Y)", globalConstants: [], globalMacros: [] },
    rules: {},
  })));
  reg.addFile(new MemoryFile(virtualName, source));
  reg.findIssues(); // 파싱 강제(비어있는 룰셋 — lint 목적 아님, AST 획득 목적)

  const obj = [...reg.getObjects()].find((o) => o.getType() === "PROG") || [...reg.getObjects()][0];
  const file = obj?.getABAPFiles()?.[0];
  const elements = [];
  let parsed = 0;
  let unparsed = 0;

  if (file) {
    for (const st of file.getStatements()) {
      const name = st.get().constructor.name;
      const tokens = tok(st);
      if (name === "Parameter") { elements.push(parseParameter(tokens)); parsed++; }
      else if (name === "SelectOption") { elements.push(parseSelectOption(tokens)); parsed++; }
      else if (name === "SelectionScreen") {
        const el = parseSelectionScreen(tokens);
        if (el) { elements.push(el); parsed++; }
        else { elements.push({ type: "unparsed", text: tokens.join(" ") }); unparsed++; }
      }
    }

    const appendAlv = extractAppendLoopAlv(file.getStatements());
    for (const [table, columns] of appendAlv) {
      elements.push({ type: "alv", table, columns });
      parsed += columns.length;
    }
  }

  const valueAlv = extractValueConstructorAlv(source);
  for (const [table, columns] of valueAlv) {
    elements.push({ type: "alv", table, columns });
    parsed += columns.length;
  }

  return { file: fileName, elements, coverage: { parsed, unparsed } };
}
