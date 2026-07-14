// lib/cbo-precheck/preview.js — Selection Screen / ALV 화면 미리보기 파서(Phase 3).
//
// @abaplint/core AST(문장 단위 토큰 스트림)를 우선 사용하고, ALV fieldcatalog의 `VALUE #( ... )` 생성자
// 패턴만 정규식으로 보조 파싱한다(미션 문서: "AST로 못 얻는 항목만 정규식 보조"). 파싱 불가 구문은 건너뛰지
// 않고 unparsed 항목으로 목록화한다.
import abaplint from "@abaplint/core";
import { virtualizeName, hasReportStatement } from "./scan.js";
import { isTextsDoc, parseTextsDoc, EMPTY_TEXTS_MAP } from "./textSymbols.js";
import { extractScreenNumbers, findAllModules, buildScreenInfo } from "./dynproPreview.js";

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

// 변수명(s_werks, p_disp 등) → `*_TEXTS.txt`의 Selection Text 라벨. 매핑이 없으면 null(호출부가 조용히
// 심볼/변수명 표시로 폴백 — GATE 1 (c) 회귀 없음 요구사항).
function resolveFieldLabel(name, selectionTexts) {
  if (!name) return null;
  return selectionTexts?.[String(name).toUpperCase()] || null;
}

function parseParameter(tokens, textsMap) {
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
  el.label = resolveFieldLabel(el.name, textsMap?.selectionTexts);
  return el;
}

function parseSelectOption(tokens, textsMap) {
  const upper = tokens.map((t) => t.toUpperCase());
  const forIdx = upper.indexOf("FOR");
  const name = forIdx > 0 ? tokens[forIdx - 1] : tokens[tokens.length - 2];
  const forField = forIdx >= 0 ? joinChain(tokens, forIdx + 1, new Set()) : null;
  return { type: "select-options", name, forField, obligatory: upper.includes("OBLIGATORY"), label: resolveFieldLabel(name, textsMap?.selectionTexts) };
}

// TEXT-xxx 심볼 참조를 찾는다(위치 지정자 /1(40) 등을 건너뛰고 TEXT 토큰부터 시작 — USER-COMMAND 앞에서 멈춤).
function findTextRef(tokens, upper) {
  const idx = upper.indexOf("TEXT");
  if (idx < 0) return null;
  return joinChain(tokens, idx, new Set(["USER"])) || null;
}

// "TEXT-001"/"TEXT-b01" 형태의 심볼 참조를 `*_TEXTS.txt`의 Text Symbol 값으로 치환한다. 매핑이 없거나
// ref 자체가 TEXT-xxx 형태가 아니면(예: 이미 알 수 없는 구문) null — 호출부가 원본 심볼을 그대로 표시.
function resolveTextSymbol(ref, textSymbols) {
  const m = String(ref || "").match(/^TEXT-(\w+)$/i);
  if (!m) return null;
  return textSymbols?.[m[1].toUpperCase()] || null;
}

// findTextRef + resolveTextSymbol 조합(원본 심볼 찾기 → 실제 텍스트 치환)은 block/comment/pushbutton
// 세 곳에서 동일하게 쓰인다.
function resolveRef(tokens, upper, textSymbols) {
  const symbol = findTextRef(tokens, upper);
  return { symbol, resolved: resolveTextSymbol(symbol, textSymbols) };
}

function parseSelectionScreen(tokens, textsMap) {
  const upper = tokens.map((t) => t.toUpperCase());
  const textSymbols = textsMap?.textSymbols;
  if (upper.includes("BEGIN") && upper.includes("BLOCK")) {
    const name = tokens[upper.indexOf("BLOCK") + 1];
    const { symbol, resolved } = resolveRef(tokens, upper, textSymbols);
    return { type: "block-begin", name, title: resolved || symbol, titleSymbol: resolved ? symbol : null, withFrame: upper.includes("FRAME") };
  }
  if (upper.includes("END") && upper.includes("BLOCK")) {
    return { type: "block-end", name: tokens[upper.indexOf("BLOCK") + 1] };
  }
  if (upper.includes("COMMENT")) {
    const { symbol, resolved } = resolveRef(tokens, upper, textSymbols);
    return { type: "comment", text: resolved || symbol, textSymbol: resolved ? symbol : null };
  }
  if (upper.includes("PUSHBUTTON")) {
    const userCommandIdx = upper.indexOf("COMMAND");
    const { symbol, resolved } = resolveRef(tokens, upper, textSymbols);
    return {
      type: "pushbutton",
      text: resolved || symbol,
      textSymbol: resolved ? symbol : null,
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
export function parsePreview(source, fileName = "source.prog.abap", textsMap = EMPTY_TEXTS_MAP) {
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
      if (name === "Parameter") { elements.push(parseParameter(tokens, textsMap)); parsed++; }
      else if (name === "SelectOption") { elements.push(parseSelectOption(tokens, textsMap)); parsed++; }
      else if (name === "SelectionScreen") {
        const el = parseSelectionScreen(tokens, textsMap);
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

  return { file: fileName, elements, coverage: { parsed, unparsed }, programTitle: textsMap?.title || null };
}

function dirOf(name) {
  const n = String(name || "");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(0, i) : "";
}

// 메인 프로그램(REPORT/PROGRAM 문 포함)이 INCLUDE 하는 파일을 같은 폴더의 형제 파일에서 찾아 원본
// `INCLUDE xxx.` 문 자리에 그대로 이어붙인다 — 병합된 텍스트 하나를 parsePreview()에 넘기면 abaplint
// 토큰 스트림이 파일 경계 없이 이어지므로(문장 단위 파싱), 별도의 cross-file Registry 조합 없이도
// include에만 있던 선택화면 정의가 그대로 해석 대상에 들어간다. 이 파일 자체가 include(예: `_S01.abap`
// 단독 지정 — REPORT/PROGRAM 문 없음)면 손대지 않고 그대로 반환한다(GATE 2 (b) 회귀 없음). 대응 파일을
// 못 찾은 INCLUDE는 그 줄만 건너뛰고 경고를 남긴다(부분 실패 허용 — GATE 2 (c)). 병합은 1단계까지만
// 따라간다(형제 파일 안에 또 다른 INCLUDE가 있어도 재귀 추적하지 않음) — 실측한 0Program 관례(메인 →
// TOP/S01/CLS/O01/I01/F01 평면 구조)에는 충분하고, 2단계 이상 중첩된 저장소라면 이 지점을 확장해야 한다.
export function mergeIncludes(mainName, mainContent, siblingFiles = []) {
  if (!hasReportStatement(mainContent)) {
    return { source: mainContent, mergedFiles: [], warnings: [] };
  }
  const byKey = new Map();
  for (const f of siblingFiles) {
    if (!f || f.name === mainName || !/\.abap$/i.test(f.name)) continue;
    const base = f.name.slice(f.name.lastIndexOf("/") + 1).replace(/\.abap$/i, "");
    byKey.set(base.toUpperCase(), f);
  }

  const mergedFiles = [];
  const warnings = [];
  // CRLF 원본(0Program 저장소 실측 — Windows 개행)의 줄 끝 "\r"는 JS 정규식에서 개행 취급이라 `.`가
  // 건너뛰지 못해 `$` 앵커까지 매치가 실패한다(실측으로 발견) — 분리 전에 정규화한다.
  const outLines = String(mainContent || "").replace(/\r\n/g, "\n").split("\n").map((line) => {
    // `INCLUDE name.`(실측한 0Program 관례 — 전부 이 형태 뒤에 ABAP 인라인 주석 `" ...`이 붙어 있음)와
    // ABAP 문법상 유효한 `INCLUDE name IF FOUND.`를 인식한다. 종결 뒤에는 공백과 `" 주석`만 허용하고
    // (실측 그대로), 그 외 내용(다른 실행문 등)이 있으면 일반 프로그램 INCLUDE로 보지 않는다.
    // `INCLUDE STRUCTURE`/`INCLUDE TYPE`(TYPES/DATA 선언 안에서 구조를 이어붙이는 문법 — 프로그램
    // INCLUDE가 아님)은 애초에 이 정규식과 무관하다(이름 자리에 STRUCTURE/TYPE가 오면 아래 loose 가드가 배제).
    const strict = line.match(/^\s*INCLUDE\s+(\w+)\s*(?:\.|\s+IF\s+FOUND\s*\.)\s*(?:".*)?$/i);
    if (strict) {
      const sibling = byKey.get(strict[1].toUpperCase());
      if (!sibling) { warnings.push(`INCLUDE ${strict[1].toUpperCase()} 파일을 찾지 못해 건너뜁니다.`); return line; }
      mergedFiles.push(sibling.name);
      return `\n* ---- BEGIN INCLUDE ${sibling.name} ----\n${sibling.content}\n* ---- END INCLUDE ${sibling.name} ----\n`;
    }
    // 형식은 INCLUDE로 시작하지만 위 두 형태와 다른 줄(드문 변형)은 자동 처리하지 않는다 — 조용히
    // 건너뛰면 "선택화면 자체가 없는 프로그램"과 구별이 안 되므로 반드시 경고로 남긴다.
    const loose = line.match(/^\s*INCLUDE\s+(\w+)\b/i);
    if (loose && !/^(STRUCTURE|TYPE)$/i.test(loose[1])) {
      warnings.push(`INCLUDE 문 형식을 인식하지 못해 건너뜁니다: ${line.trim()}`);
    }
    return line;
  });
  return { source: outLines.join("\n"), mergedFiles, warnings };
}

// action=preview(캐시된 스캔 재사용)와 action=preview-direct(독립 clone) 양쪽이 공유하는 미리보기 생성
// 진입점. `siblingFiles`는 저장소 전체에서 수집된 파일 목록이어도 되고(같은 폴더가 아닌 파일은 이 함수가
// 걸러낸다), 대상 파일과 같은 폴더 안에서만 TEXTS 문서/INCLUDE 형제를 찾는다.
export function buildPreview(fileName, source, siblingFiles = []) {
  const dir = dirOf(fileName);
  const sameDirSiblings = siblingFiles.filter((f) => f && f.name !== fileName && dirOf(f.name) === dir);

  const textsFile = sameDirSiblings.find((f) => isTextsDoc(f.name));
  const textsMap = textsFile ? parseTextsDoc(textsFile.content) : EMPTY_TEXTS_MAP;

  const { source: mergedSource, mergedFiles, warnings } = mergeIncludes(fileName, source, sameDirSiblings);
  const result = parsePreview(mergedSource, fileName, textsMap);

  // Dynpro Screen(실행 후 화면, Phase 3) — Selection Screen과 별개로 CALL SCREEN/SET SCREEN/LEAVE TO
  // SCREEN이 있으면 전부 찾아 렌더 정보를 조립한다. 없는 프로그램(Selection Screen만 있음)은 screens:[]
  // 로 기존 동작과 동일 — 회귀 없음.
  const alvColumnsByTable = new Map();
  for (const el of result.elements) {
    if (el.type === "alv" && el.table && !alvColumnsByTable.has(el.table)) alvColumnsByTable.set(el.table, el.columns);
  }
  const modules = findAllModules(mergedSource);
  const screenNumbers = extractScreenNumbers(mergedSource);
  const screens = screenNumbers.map((screenNo) => buildScreenInfo({ screenNo, source: mergedSource, textsMap, modules, alvColumnsByTable }));
  const flow = screens.length ? ["Selection Screen(1000)", ...screenNumbers.map((n) => `Screen ${n}`)] : [];

  return { ...result, mergedFiles, warnings, screens, flow };
}
