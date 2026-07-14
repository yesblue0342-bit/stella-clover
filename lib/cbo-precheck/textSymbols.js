// lib/cbo-precheck/textSymbols.js — ABAP Text Symbol / Selection Text 문서(`*_TEXTS.txt`) 파서.
//
// 0Program 저장소 실측(WORK_REPORT.md Phase 0 참고): 이 파일은 소스에 포함되지 않는 순수 문서로,
// SE38 > Goto > Text Elements 에 사람이 직접 입력해야 화면에 반영된다. 실측한 3개 샘플 중 2개
// (ZAQMR0130, ZAQMR0100)는 장식 문자만 다를 뿐 공통적으로 "섹션 헤더(Text Symbol(s)/Selection
// Text(s) 키워드 포함) + 줄마다 KEY  VALUE(2칸 이상 간격)" 구조를 따른다 — 이 파서는 그 공통 구조만
// 다룬다. 세 번째 샘플(ZAQMR0110)은 EN:/KO: 인용부호·콜론 기반의 산문형 구조라 줄 단위 KEY-VALUE로
// 표현되지 않으므로 v1 범위 밖(README_CBO_PRECHECK.md "알려진 한계" 참고) — 매핑 없이 빈 결과를
// 반환해 호출부가 조용히 심볼 표시로 폴백하게 한다(크래시/오탐 없음).

export function isTextsDoc(name) {
  return /_texts\.txt$/i.test(String(name || ""));
}

// 값 뒤에 붙는 주석/주의 표기 제거. ZAQMR0130 포맷은 "★" 강조표시로, ZAQMR0100 포맷은 ABAP 인라인
// 주석(`"`)으로 부가설명을 붙인다 — 실측: 두 표시가 한 줄에 같이 나오면(예: `P_DISP ... ★미입력 시
// 화면에 "P_DISP" 로 노출됨`) ★ 표시가 항상 부가설명 쪽에서 먼저 나오므로 ★ 를 먼저 잘라야 그 뒤에 오는
// 인용부호가 실제 값을 오염시키지 않는다(순서를 바꾸면 "Display" 대신 빈 문자열이 남는 것을 실측 확인).
function stripAnnotation(value) {
  let v = String(value || "");
  const starIdx = v.indexOf("★");
  if (starIdx >= 0) v = v.slice(0, starIdx);
  const quoteIdx = v.indexOf('"');
  if (quoteIdx >= 0) v = v.slice(0, quoteIdx);
  return v.trim();
}

// 섹션 헤더 인식 — 장식(`*===`, `------`, `[N]`)은 무시하고 키워드만 본다. key:null 인 항목은 "이 다음
// 줄부터는 우리가 다루지 않는 섹션"이라는 표시로, 이전 섹션(textSymbols/selectionTexts)의 항목 추출이
// 뒤이어지는 GUI Status/Message 등 무관 섹션까지 새어 들어가는 것을 막는다.
const SECTION_PATTERNS = [
  { key: "textSymbols", re: /text\s*symbols?/i },
  { key: "selectionTexts", re: /selection\s*texts?/i },
  { key: "title", re: /gui\s*title/i },
  { key: null, re: /gui\s*status/i },
  { key: null, re: /cbo\s*transaction/i },
  { key: null, re: /screen\s+\d/i },
];

// 선행 `*`(ABAP 주석) 옵션 + 공백 다음 KEY(문자/숫자/밑줄, 숫자로 시작 가능 — 텍스트 심볼은 "001"처럼
// 순수 숫자 코드도 흔하다), 2칸 이상 공백(또는 탭 1개 이상) 후 VALUE. 공백 1칸(탭 아님)은 의도적으로
// 매치 실패시켜 산문 주석 속 "A / B" 같은 표기의 오탐을 줄인다.
const ENTRY_RE = /^\*?\s*([A-Za-z0-9][A-Za-z0-9_]*)(?:\s{2,}|\t+)(.+)$/;

export function parseTextsDoc(content) {
  const textSymbols = {};
  const selectionTexts = {};
  const titles = {};
  let title = null;
  let section = null;

  for (const rawLine of String(content || "").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const sectionHit = SECTION_PATTERNS.find((p) => p.re.test(line));
    if (sectionHit) { section = sectionHit.key; continue; }
    if (!section) continue;

    const m = line.match(ENTRY_RE);
    if (!m) continue;
    const value = stripAnnotation(m[2]);
    if (!value) continue;
    // "*   P_ALL  / P_RANGE — 조회조건 All/Range 라디오 제거…" 같은 산문 주석 continuation 줄이
    // 우연히 2칸 간격을 만족해 오탐되는 경우(값이 "/"나 "-"로 시작) 방지 — 실측으로 발견한 케이스.
    if (/^[/\-—]/.test(value)) continue;

    if (section === "textSymbols") textSymbols[m[1].toUpperCase()] = value;
    else if (section === "selectionTexts") selectionTexts[m[1].toUpperCase()] = value;
    else if (section === "title") {
      // "GUI Title" 섹션은 `SET TITLEBAR 'xxx'`의 xxx마다 한 줄씩 있을 수 있다(Dynpro Screen이 여러 개면
      // 타이틀도 여러 개 — Phase 3 참고). 식별자별로 titles 맵에 전부 모으고, 기존 단일 `title`(Selection
      // Screen 상단 배너, 회귀 보호 대상)은 첫 항목만 그대로 유지한다.
      titles[m[1].toUpperCase()] = value;
      if (!title) title = value;
    }
  }

  return { textSymbols, selectionTexts, title, titles };
}

export const EMPTY_TEXTS_MAP = Object.freeze({ textSymbols: Object.freeze({}), selectionTexts: Object.freeze({}), title: null, titles: Object.freeze({}) });
