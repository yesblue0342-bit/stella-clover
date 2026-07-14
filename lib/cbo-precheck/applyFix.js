// lib/cbo-precheck/applyFix.js — abaplint Issue.getDefaultFix() 의 edit(row/col, 1-based, end 배타)를
// 소스 텍스트에 적용한다. "자동 수정 PR"(Phase 2) 이 사용.
function lineOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function toOffset(offsets, row, col) {
  const lineStart = offsets[row - 1];
  if (lineStart === undefined) throw new Error(`edit 대상 라인(${row})이 소스 범위를 벗어났습니다.`);
  return lineStart + (col - 1);
}

// edits: [{ range: { start:{row,col}, end:{row,col} }, newText }] — 한 파일 안의 edit들.
// 겹치는/역순 edit 은 뒤에서부터(offset 내림차순) 적용해 앞쪽 offset이 흔들리지 않게 한다.
export function applyEdits(text, edits) {
  if (!Array.isArray(edits) || !edits.length) return text;
  const offsets = lineOffsets(text);
  const resolved = edits
    .map((edit) => ({
      start: toOffset(offsets, edit.range.start.row, edit.range.start.col),
      end: toOffset(offsets, edit.range.end.row, edit.range.end.col),
      newText: edit.newText,
    }))
    .sort((a, b) => b.start - a.start);

  let result = text;
  for (const edit of resolved) {
    if (edit.start < 0 || edit.end > result.length || edit.start > edit.end) {
      throw new Error("edit 범위가 소스 텍스트와 맞지 않습니다(원본이 변경되었을 수 있습니다).");
    }
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  return result;
}

// 여러 이슈(같은 파일)의 fixEdits 를 한 번에 적용. 적용 가능한 이슈만 사용, 나머지는 skipped 로 보고.
export function applyIssuesToFile(text, issues) {
  const applicable = issues.filter((i) => i.fixEdits && i.fixEdits.length);
  const skipped = issues.filter((i) => !i.fixEdits || !i.fixEdits.length).map((i) => i.id || i.rule);
  const allEdits = applicable.flatMap((i) => i.fixEdits);
  const content = applyEdits(text, allEdits);
  return { content, applied: applicable.map((i) => i.id || i.rule), skipped };
}
