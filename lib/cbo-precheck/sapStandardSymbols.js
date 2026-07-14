// lib/cbo-precheck/sapStandardSymbols.js — SAP 표준 타입풀 심볼 오탐 방지(WORK_REPORT.md 2026-07-14
// "Phase 0 실패 원인" 세션 참고: 직전 세션은 이 모듈 자체를 만들지 않아 check_syntax 오탐이 그대로였다).
//
// abaplint는 SAP 표준 타입풀(`TYPE-POOLS: icon.` 등)의 실제 상수 정의를 갖고 있지 않아, `ls_btn-icon =
// icon_create.` 처럼 값으로 참조하면 check_syntax 룰이 "not found"로 오탐한다. abaplint 공식 config
// 옵션 `syntax.globalConstants`(문자열 배열, `_current_scope.js` CurrentScope.buildDefault → addBuiltIn →
// BuiltIn.get(extras) 에서 각 이름을 read-only VoidType 내장 식별자로 등록 — 하드코딩 파서 우회가 아니라
// abaplint가 "외부에 정의된 상수"를 다루도록 제공하는 정식 확장점)로 해결하는 것이 정석이다.
//
// 개별 아이콘 이름을 전부 나열하는 대신(SAP ICON 타입풀은 수백 개) **명명 규칙(패턴)** 으로 인식한다 —
// 0Program 전체에서 실측한 이 저장소의 Z 프로그램 변수는 예외 없이 gc_/gv_/gt_/gs_/go_/lt_/ls_ 같은
// 헝가리안 접두사를 쓰고 icon_ 접두사를 쓰는 커스텀 변수는 한 건도 없었다(scan.js 상단 주석·WORK_REPORT.md
// Phase 0 전수조사 참고) — 따라서 `icon_` 접두사 패턴은 오탐 제거 목적으로 낮은 위험도로 사용할 수 있다.
// 새로운 표준 타입풀 오탐이 발견되면(예: `abap_true`/`abap_false`, ALV `col_*` 색상 상수) 이 배열에
// 패턴만 추가하면 되고 scan.js/preview.js 수정은 필요 없다.
export const SAP_STANDARD_SYMBOL_PATTERNS = [
  {
    pool: "icon",
    re: /^icon_[a-z0-9_]+$/i,
    note: "TYPE-POOLS: icon 상수 — ALV 툴바/필드캐탈로그 등에서 값으로 참조(실측: icon_create/icon_change/icon_delete/icon_history/icon_alert/icon_system_save/icon_select_all/icon_deselect_all/icon_mass_change(s)/icon_delete_row/icon_save/icon_exit/icon_green_light/icon_yellow_light/icon_red_light/icon_led_inactive 등).",
  },
  {
    pool: "abap",
    re: /^abap_(true|false|undefined)$/i,
    note: "TYPE-POOLS: abap 상수(ABAP 불리언) — 이 저장소 실측 표본에서는 미발견이나 표준 타입풀이라 선제 등록.",
  },
  {
    pool: "col",
    re: /^col_(background|group|heading|key|negative|normal|positive|total)$/i,
    note: "TYPE-POOLS: col(ALV 색상) 상수 — 이 저장소 실측 표본에서는 미발견이나 표준 타입풀이라 선제 등록.",
  },
];

export function isKnownSapStandardSymbol(name) {
  const value = String(name || "");
  return SAP_STANDARD_SYMBOL_PATTERNS.some((p) => p.re.test(value));
}

// check_syntax 이슈 메시지에서 식별자를 뽑아낸다 — 실측 포맷: `"icon_create" not found, findTop` /
// `"gv_modified" not found, Target`. 둘 다 큰따옴표로 감싼 식별자가 메시지 맨 앞에 온다.
const NOT_FOUND_RE = /^"([^"]+)" not found\b/;

export function extractNotFoundSymbol(message) {
  const m = NOT_FOUND_RE.exec(String(message || ""));
  return m ? m[1] : null;
}

// ALV 툴바 버튼 아이콘 근사 표시(Phase 3 Dynpro Screen 렌더 — 미션 문서 "아이콘 상수는 근사 표시(이모지/
// 유니코드) 하거나 매핑 없으면 텍스트만 표시" 요구사항). 실측한 0Program 표본(icon_create/change/delete/
// history/alert 등)만 우선 매핑 — 매핑 없는 아이콘은 호출부가 조용히 텍스트만 표시(크래시/추측 없음).
export const ICON_GLYPHS = Object.freeze({
  icon_create: "➕", icon_change: "✏️", icon_delete: "🗑️", icon_history: "🕘",
  icon_alert: "⚠️", icon_system_save: "💾", icon_select_all: "☑️", icon_deselect_all: "⬜",
  icon_mass_change: "✏️", icon_mass_changes: "✏️", icon_delete_row: "➖", icon_save: "💾",
  icon_exit: "🚪", icon_green_light: "🟢", icon_yellow_light: "🟡", icon_red_light: "🔴",
  icon_led_inactive: "⚪",
});

export function iconGlyph(name) {
  return ICON_GLYPHS[String(name || "").toLowerCase()] || null;
}
