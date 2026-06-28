// lib/flowBuild.js — 표(행 배열) → Mermaid 플로우차트 정의 (순수 함수, 단위 테스트 대상)
//
// Stella Flow 의 핵심 변환. 클라이언트(엑셀/CSV 파싱)·서버(api/flow.js AI 정리 폴백) 양쪽에서 공유.
// 입력 rows: 2차원 배열(행×열). 첫 행이 헤더로 보이면 자동 제외.
// 모드 자동판별:
//   · 헤더에 from→to 관계 컬럼이 있으면 "엣지 모드"(각 행 = 간선 [출발, 도착, (라벨)])
//   · 헤더 없고 2열 이상이면 엣지 모드(col0→col1, label=col2)
//   · 1열이면 "스텝 모드"(행 순서대로 A→B→C 선형 연결)
// 출력: { mermaid, nodeCount, edgeCount, mode }

const FROM_KEYS = ["from", "source", "src", "start", "이전", "출발", "prev", "상위", "parent"];
const TO_KEYS = ["to", "target", "dst", "dest", "end", "다음", "도착", "next", "하위", "child"];
const LABEL_KEYS = ["label", "edge", "relation", "관계", "조건", "라벨", "설명", "action", "비고", "note"];
// 단일 열 표의 헤더(정확 일치만). "조건"처럼 데이터 값과 겹칠 수 있는 단어는 제외.
const STEP_HEADER_KEYS = ["step", "steps", "단계", "작업", "task", "tasks", "순서", "절차", "process", "활동", "activity", "node", "노드", "항목"];

function cell(v) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim(); }

// 행렬 정규화: 각 셀 문자열화, 완전 공백 행 제거.
function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map(r => (Array.isArray(r) ? r.map(cell) : [cell(r)]))
    .filter(r => r.some(c => c !== ""));
}

function keyMatch(value, keys) {
  const v = cell(value).toLowerCase();
  return keys.some(k => v === k || v.includes(k));
}

// 헤더 감지 → { hasHeader, fromIdx, toIdx, labelIdx } (없으면 hasHeader:false)
//  · 다열: from·to 컬럼이 둘 다 보일 때만 헤더로 인정(데이터 값과의 우연한 충돌 방지).
//  · 단일열: 첫 셀이 STEP_HEADER_KEYS 와 정확히 일치할 때만 헤더.
function detectHeader(rows) {
  if (!rows.length) return { hasHeader: false };
  const head = rows[0];
  const width = head.length;
  if (width === 1) {
    const v = cell(head[0]).toLowerCase();
    return { hasHeader: STEP_HEADER_KEYS.includes(v), fromIdx: -1, toIdx: -1, labelIdx: -1 };
  }
  let fromIdx = -1, toIdx = -1, labelIdx = -1;
  head.forEach((c, i) => {
    if (fromIdx < 0 && keyMatch(c, FROM_KEYS)) fromIdx = i;
    else if (toIdx < 0 && keyMatch(c, TO_KEYS)) toIdx = i;
    else if (labelIdx < 0 && keyMatch(c, LABEL_KEYS)) labelIdx = i;
  });
  const hasHeader = fromIdx >= 0 && toIdx >= 0; // 다열은 from·to 둘 다 있어야 헤더
  return hasHeader ? { hasHeader, fromIdx, toIdx, labelIdx } : { hasHeader: false, fromIdx: -1, toIdx: -1, labelIdx: -1 };
}

// Mermaid 라벨 안전화: 따옴표→엔티티, 대괄호/중괄호/파이프 등 파서 충돌 문자 정리, 길이 제한.
export function escapeLabel(s) {
  return cell(s)
    .replace(/"/g, "&quot;")
    .replace(/[[\]{}|<>]/g, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || " ";
}

// 노드 모양: "?"로 끝나거나 판단/확인/여부면 마름모(decision), 그 외 사각형. start/end 는 stadium.
function nodeDecl(id, label, role) {
  const safe = escapeLabel(label);
  const isDecision = /\?$/.test(label.trim()) || /(여부|판단|확인|승인|체크|검토)\s*\??$/.test(label.trim());
  if (role === "start" || role === "end") return `${id}(["${safe}"])`;
  if (isDecision) return `${id}{"${safe}"}`;
  return `${id}["${safe}"]`;
}

// 표 → Mermaid 정의.
export function rowsToMermaid(rows, opts = {}) {
  const direction = /^(TB|TD|BT|LR|RL)$/.test(opts.direction || "") ? opts.direction : "TD";
  let norm = normalizeRows(rows);
  if (!norm.length) {
    return { mermaid: `flowchart ${direction}\n  n0["(데이터 없음)"]`, nodeCount: 0, edgeCount: 0, mode: "empty" };
  }

  const { hasHeader, fromIdx, toIdx, labelIdx } = detectHeader(norm);
  if (hasHeader) norm = norm.slice(1);
  if (!norm.length) {
    return { mermaid: `flowchart ${direction}\n  n0["(데이터 없음)"]`, nodeCount: 0, edgeCount: 0, mode: "empty" };
  }

  const width = norm.reduce((m, r) => Math.max(m, r.length), 1);
  const edgeMode = hasHeader ? (fromIdx >= 0 || toIdx >= 0) : width >= 2;

  // 노드 id 배정(라벨 dedupe, 삽입 순서 보존)
  const idByLabel = new Map();
  const order = [];
  function nodeId(label) {
    const key = cell(label);
    if (!key) return null;
    if (!idByLabel.has(key)) { const id = "n" + order.length; idByLabel.set(key, id); order.push(key); }
    return idByLabel.get(key);
  }

  const edges = []; // { a, b, label }
  if (edgeMode) {
    const fi = hasHeader && fromIdx >= 0 ? fromIdx : 0;
    const ti = hasHeader && toIdx >= 0 ? toIdx : 1;
    const li = hasHeader && labelIdx >= 0 ? labelIdx : (width >= 3 ? 2 : -1);
    for (const r of norm) {
      const a = nodeId(r[fi]);
      const b = nodeId(r[ti]);
      const lbl = li >= 0 ? cell(r[li]) : "";
      if (a && b) edges.push({ a, b, label: lbl });
      else if (a && !b) { /* 단독 노드: 등록만(고립 노드 표시) */ }
    }
  } else {
    // 스텝 모드: 첫 열 기준 순차 연결
    const steps = norm.map(r => r[0]).filter(Boolean);
    steps.forEach(s => nodeId(s));
    for (let i = 0; i < steps.length - 1; i++) {
      edges.push({ a: idByLabel.get(cell(steps[i])), b: idByLabel.get(cell(steps[i + 1])), label: "" });
    }
  }

  // 선언 + 간선 직렬화
  const lines = [`flowchart ${direction}`];
  order.forEach((label, i) => {
    const role = (!edgeMode && i === 0) ? "start" : (!edgeMode && i === order.length - 1 && order.length > 1) ? "end" : "";
    lines.push("  " + nodeDecl("n" + i, label, role));
  });
  for (const e of edges) {
    if (!e.a || !e.b) continue;
    lines.push(e.label ? `  ${e.a} -->|"${escapeLabel(e.label)}"| ${e.b}` : `  ${e.a} --> ${e.b}`);
  }

  return { mermaid: lines.join("\n"), nodeCount: order.length, edgeCount: edges.filter(e => e.a && e.b).length, mode: edgeMode ? "edge" : "step" };
}

// CSV/TSV/붙여넣기 텍스트 → 행 배열. 따옴표 필드 지원(엑셀 복사 호환). 클라이언트·테스트 공용.
export function parseDelimited(text) {
  const src = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  if (!src.trim()) return [];
  // 구분자 자동: 탭이 있으면 탭, 아니면 콤마.
  const delim = src.includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  row.push(field); rows.push(row);
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}

// AI/사용자 입력 Mermaid 정의가 그럴듯한지 최소 검증(렌더 전 가드).
export function looksLikeMermaid(text) {
  return /^\s*(flowchart|graph)\s+(TB|TD|BT|LR|RL)\b/i.test(String(text || ""));
}
