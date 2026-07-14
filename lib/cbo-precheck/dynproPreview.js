// lib/cbo-precheck/dynproPreview.js — Dynpro Screen(실행 후 화면, 예 Screen 0100) 렌더 정보 추출(Phase 3).
//
// WORK_REPORT.md 2026-07-14 "실패 재작업" 세션 Phase 0 참고: 직전 세션은 이 모듈 자체가 없어(preview.js가
// Selection Screen(PARAMETERS/SELECT-OPTIONS/SelectionScreen 문)만 파싱) `CALL SCREEN 0100`으로 진입하는
// ALV 화면이 미리보기에 전혀 나오지 않았다. 소스에 없는 것(Screen Flow Logic, Screen Painter 픽셀 배치)은
// 재현하지 않고, 소스에 있는 것(모듈 구현/GUI Status·Titlebar 이름/ALV 툴바·필드카탈로그)만 추출한다.
//
// AST 대신 정규식 기반(preview.js의 extractValueConstructorAlv와 동일한 접근) — Screen/MODULE/PERFORM
// 호출은 abaplint 문장 파서가 별도 statement 타입으로 구분해주지 않고, 여기서 다루는 항목은 전부 "실제
// 존재 여부와 리터럴 값"만 필요한 미리보기 목적이라 정규식 스캔으로 충분하다(파싱 실패해도 다른 항목/
// Selection Screen 렌더에 영향 없음 — Phase 3 요구사항 "부분 실패 허용").
function stripQuotes(value) {
  const s = String(value || "");
  return s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1) : s;
}

// CALL SCREEN/SET SCREEN/LEAVE TO SCREEN nnnn — "LEAVE TO SCREEN 0"은 "현재 화면 종료"를 뜻하는 관용구로
// 실제 Dynpro가 아니므로 제외한다.
const SCREEN_REF_RE = /\b(?:CALL\s+SCREEN|SET\s+SCREEN|LEAVE\s+TO\s+SCREEN)\s+'?(\d{1,4})'?\b/gi;

export function extractScreenNumbers(source) {
  const found = [];
  const seen = new Set();
  let m;
  const re = new RegExp(SCREEN_REF_RE);
  while ((m = re.exec(source))) {
    const no = stripQuotes(m[1]).padStart(4, "0");
    if (no === "0000" || seen.has(no)) continue;
    seen.add(no);
    found.push(no);
  }
  return found;
}

const MODULE_RE = /\bMODULE\s+(\w+)\s+(OUTPUT|INPUT)\b/gi;

export function findAllModules(source) {
  const mods = [];
  let m;
  const re = new RegExp(MODULE_RE);
  while ((m = re.exec(source))) mods.push({ name: m[1], kind: m[2].toUpperCase() });
  return mods;
}

// 화면번호가 이름에 포함된 모듈을 우선 매칭(status_0100 → "0100" 포함) — 미션 요구사항: 매칭 실패 시
// 전체 OUTPUT/INPUT 모듈을 목록으로 표시(fallback:true로 표시해 호출부가 안내 문구를 낼 수 있게 한다).
export function matchScreenModules(screenNo, modules) {
  const output = modules.filter((m) => m.kind === "OUTPUT" && m.name.includes(screenNo));
  const input = modules.filter((m) => m.kind === "INPUT" && m.name.includes(screenNo));
  if (output.length || input.length) return { output, input, fallback: false };
  return {
    output: modules.filter((m) => m.kind === "OUTPUT"),
    input: modules.filter((m) => m.kind === "INPUT"),
    fallback: true,
  };
}

export function extractModuleBody(source, moduleName) {
  const re = new RegExp(`MODULE\\s+${moduleName}\\s+(?:OUTPUT|INPUT)\\b([\\s\\S]*?)ENDMODULE\\s*\\.`, "i");
  const m = re.exec(source);
  return m ? m[1] : "";
}

// SET PF-STATUS 'xxx' [EXCLUDING ...] / SET TITLEBAR 'xxx' [WITH v1 v2 ...] — 둘 다 "SET <키워드>
// '이름'" 공통 형태라 키워드만 바꿔 재사용한다.
export function extractSetDirective(body, keyword) {
  const re = new RegExp(`SET\\s+${keyword}\\s+'([^']*)'(?:\\s+WITH\\s+([\\s\\S]*?))?\\s*\\.`, "i");
  const m = re.exec(body || "");
  if (!m) return null;
  const withVars = m[2] ? m[2].trim().split(/\s+/).filter(Boolean) : [];
  return { name: m[1], withVars };
}

// "GUI Title" 문서 항목(예: "[QM] Assign Inspection Type to QM View — &1 (&2)")의 &1/&2 자리표시자를
// `SET TITLEBAR ... WITH v1 v2` 의 실제 변수명으로 치환한다 — 런타임 값은 알 수 없으므로(정적 미리보기)
// 변수명 자체를 «» 로 감싸 표시해 "이 자리에 이 변수 값이 들어간다"는 것만 안내한다.
export function resolveTitlebarText(titleTemplate, withVars) {
  if (!titleTemplate) return null;
  return titleTemplate.replace(/&(\d)/g, (whole, idx) => {
    const v = withVars[Number(idx) - 1];
    return v ? `«${v}»` : whole;
  });
}

// CASE sy-ucomm./CASE e_ucomm. 블록의 WHEN 'X' [OR 'Y']. 절에서 기능코드 문자열을 전부 뽑는다(PAI의
// 표준 GUI 기능코드 목록 — 미션 "GUI Status + 기능코드" 요구사항).
export function extractWhenCodes(body) {
  const codes = [];
  const seen = new Set();
  const re = /WHEN\s+((?:'[^']*'\s*(?:OR\s+)?)+)\s*\./gi;
  let m;
  while ((m = re.exec(body || ""))) {
    const lits = m[1].match(/'[^']*'/g) || [];
    for (const lit of lits) {
      const code = stripQuotes(lit);
      if (!code || seen.has(code)) continue;
      seen.add(code);
      codes.push(code);
    }
  }
  return codes;
}

// ALV 툴바 버튼 — `on_toolbar` 이벤트 핸들러 METHOD 안에서 `<ws>-function/-icon/-text/-quickinfo = ...`를
// 누적하다가 `APPEND <ws> TO ...`를 만나면 버튼 하나로 확정한다(preview.js의 extractAppendLoopAlv와 같은
// "누적 후 APPEND로 확정" 패턴이나, 대상 테이블이 `e_object->mt_toolbar`처럼 `->` 를 포함해 단순
// `APPEND ws TO table.`의 토큰 인덱싱을 재사용할 수 없어 별도 구현). `-butn_type = 3`(구분선, function
// 없음)은 separator로 표시한다.
export function extractToolbarButtons(source) {
  const methodRe = /METHOD\s+on_toolbar\b[\s\S]*?\.([\s\S]*?)ENDMETHOD\s*\./i;
  const methodMatch = methodRe.exec(source);
  if (!methodMatch) return [];
  const body = methodMatch[1];

  const appendRe = /APPEND\s+\w+\s+TO\s+[\w>\-]+\s*\.\s*/gi;
  const buttons = [];
  let lastIndex = 0;
  let m;
  while ((m = appendRe.exec(body))) {
    const chunk = body.slice(lastIndex, m.index);
    lastIndex = appendRe.lastIndex;
    const fn = /-function\s*=\s*'([^']*)'/i.exec(chunk)?.[1] || null;
    const icon = /-icon\s*=\s*(\w+)/i.exec(chunk)?.[1] || null;
    const text = /-text\s*=\s*'([^']*)'/i.exec(chunk)?.[1] || null;
    const quickinfo = /-quickinfo\s*=\s*'([^']*)'/i.exec(chunk)?.[1] || null;
    const butnType = /-butn_type\s*=\s*(\d+)/i.exec(chunk)?.[1] || null;
    if (!fn && !text) {
      if (butnType) buttons.push({ separator: true });
      continue;
    }
    buttons.push({ function: fn, icon, text, quickinfo });
  }
  return buttons;
}

// ALV 필드카탈로그 — 세 번째 실측 패턴: `PERFORM <form> USING '필드명' '컬럼텍스트' 길이 ...`처럼 리터럴을
// 헬퍼 FORM(내부에서 `<ws>-fieldname = <파라미터>.`로 필드카탈로그 워크에어리어를 채우고 APPEND하는 FORM)에
// 넘기는 관용구(preview.js의 append-loop/VALUE 생성자 패턴 둘 다와 다름 — WORK_REPORT.md "Phase 3 실측"
// 참고, 260707_QM023_ZAQMR0130이 바로 이 패턴). FORM의 USING 파라미터 중 어떤 위치가 fieldname/coltext/
// outputlen로 쓰이는지는 FORM 본문에서 역추적하고, 그 위치 그대로 각 PERFORM 호출의 리터럴을 읽는다.
function findFieldcatForms(source) {
  const forms = [];
  const formRe = /FORM\s+(\w+)\s+USING\s+([\s\S]*?)\.\s*([\s\S]*?)ENDFORM\s*\./gi;
  let m;
  while ((m = formRe.exec(source))) {
    const [, name, paramsRaw, body] = m;
    const paramNames = [...paramsRaw.matchAll(/(\w+)\s+TYPE\b/gi)].map((pm) => pm[1]);
    if (!paramNames.length) continue;

    const fieldMatch = /(\w+)-fieldname\s*=\s*(\w+)\s*\./i.exec(body);
    if (!fieldMatch) continue; // 필드카탈로그를 채우는 FORM이 아님 — 대다수 FORM은 여기서 걸러짐
    const ws = fieldMatch[1];
    const fieldParamIdx = paramNames.indexOf(fieldMatch[2]);
    if (fieldParamIdx < 0) continue;

    const coltextMatch = new RegExp(`${ws}-(?:coltext|scrtext_l|scrtext_m|scrtext_s|seltext_l|seltext_m|seltext_s|reptext)\\s*=\\s*(\\w+)\\s*\\.`, "i").exec(body);
    const coltextParamIdx = coltextMatch ? paramNames.indexOf(coltextMatch[1]) : -1;
    const outputlenMatch = new RegExp(`${ws}-outputlen\\s*=\\s*(\\w+)`, "i").exec(body);
    const outputlenParamIdx = outputlenMatch ? paramNames.indexOf(outputlenMatch[1]) : -1;
    const appendMatch = new RegExp(`APPEND\\s+${ws}\\s+TO\\s+(\\w+)\\s*\\.`, "i").exec(body);
    if (!appendMatch) continue;

    forms.push({ name, table: appendMatch[1], fieldParamIdx, coltextParamIdx, outputlenParamIdx });
  }
  return forms;
}

function extractPerformFieldcatCalls(source, forms) {
  const alvByTable = new Map();
  for (const f of forms) {
    const callRe = new RegExp(`PERFORM\\s+${f.name}\\s+USING\\s+([^\\n]*?)\\.\\s*(?:\\r?\\n|$)`, "gi");
    const columns = [];
    let m;
    while ((m = callRe.exec(source))) {
      const args = m[1].match(/'[^']*'|\S+/g) || [];
      const fieldnameRaw = f.fieldParamIdx >= 0 ? args[f.fieldParamIdx] : null;
      if (!fieldnameRaw) continue;
      const fieldname = stripQuotes(fieldnameRaw);
      const coltext = f.coltextParamIdx >= 0 && args[f.coltextParamIdx] ? stripQuotes(args[f.coltextParamIdx]) : "";
      const outputlenRaw = f.outputlenParamIdx >= 0 ? args[f.outputlenParamIdx] : null;
      const outputlen = outputlenRaw && /^\d+$/.test(outputlenRaw) ? Number(outputlenRaw) : null;
      columns.push({ fieldname, coltext, outputlen });
    }
    if (columns.length) alvByTable.set(f.table, columns);
  }
  return alvByTable;
}

export function extractFormFieldcat(source) {
  const forms = findFieldcatForms(source);
  if (!forms.length) return new Map();
  return extractPerformFieldcatCalls(source, forms);
}

// ALV 그리드 존재 여부 — 미션 문서는 `cl_gui_custom_container`를 예시로 들었지만 실측 저장소는
// `cl_gui_docking_container`도 쓴다(260707_QM023_ZAQMR0130). 컨테이너 구현 클래스를 하드코딩하지 않고
// "cl_gui_alv_grid 타입 참조가 있는가"만으로 판단한다 — ALV 그리드 자체가 이 화면의 핵심이므로 이 타입이
// 없으면 ALV 화면이 아니다(다른 컨테이너 클래스가 미래에 추가돼도 이 판단은 그대로 유효).
export function hasAlvGrid(source) {
  return /cl_gui_alv_grid/i.test(source);
}

// 하나의 Screen 번호에 대한 렌더 정보를 전부 조립한다. alvColumnsByTable(preview.js의 기존 append-loop/
// VALUE 생성자 추출 결과)와 이 파일의 PERFORM 패턴 결과를 합쳐(같은 테이블명이면 나중 결과 우선하지 않고
// 병합 소스 우선순위 없이 "먼저 찾은 것"을 쓴다 — 한 화면에 fieldcat 테이블은 보통 하나뿐이라 충돌 드묾)
// 그리드 컬럼을 채운다.
export function buildScreenInfo({ screenNo, source, textsMap, modules, alvColumnsByTable }) {
  const { output, input, fallback } = matchScreenModules(screenNo, modules);
  const outputBody = output.map((m) => extractModuleBody(source, m.name)).join("\n");
  const inputBody = input.map((m) => extractModuleBody(source, m.name)).join("\n");

  const titleDirective = extractSetDirective(outputBody, "TITLEBAR");
  const titleTemplate = titleDirective ? textsMap?.titles?.[titleDirective.name.toUpperCase()] : null;
  const title = titleDirective
    ? { name: titleDirective.name, text: resolveTitlebarText(titleTemplate, titleDirective.withVars) || titleTemplate || null }
    : null;

  const statusDirective = extractSetDirective(outputBody, "PF-STATUS");
  const functionCodes = extractWhenCodes(inputBody);

  const formFieldcat = extractFormFieldcat(source);
  let alvColumns = null;
  for (const [, columns] of formFieldcat) { alvColumns = columns; break; }
  if (!alvColumns && alvColumnsByTable && alvColumnsByTable.size) {
    for (const [, columns] of alvColumnsByTable) { alvColumns = columns; break; }
  }

  return {
    screenNo,
    title,
    pfStatus: statusDirective ? statusDirective.name : null,
    functionCodes,
    modules: { output: output.map((m) => m.name), input: input.map((m) => m.name), fallback },
    hasAlvGrid: hasAlvGrid(source),
    alvColumns: alvColumns || [],
    toolbarButtons: extractToolbarButtons(source),
  };
}
