// cbo-precheck/index.html은 별도 SPA(빌드 파이프라인 없음) — 브라우저/jsdom 없이 GATE 2 검증하려고
// 실제 인라인 <script> 소스에서 렌더 함수만 추출해 `new Function` 샌드박스로 직접 호출한다(CLAUDE.md
// 5번 규칙 "인라인 JS는 new Function으로 파싱" 방식을 회귀 테스트로 고정). 함수 본문은 index.html에서
// 그대로 추출하므로 중복 구현으로 인한 드리프트가 없다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync("cbo-precheck/index.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function extractFn(name) {
  let startIdx = script.indexOf(`function ${name}(`);
  if (startIdx < 0) throw new Error(`function ${name}(...) 을 index.html에서 찾지 못함`);
  const asyncIdx = script.lastIndexOf("async ", startIdx);
  if (asyncIdx >= 0 && script.slice(asyncIdx + 6, startIdx).trim() === "") startIdx = asyncIdx;
  const braceStart = script.indexOf("{", startIdx);
  let depth = 0, i = braceStart;
  for (; i < script.length; i++) {
    if (script[i] === "{") depth++;
    else if (script[i] === "}") { depth--; if (depth === 0) break; }
  }
  return script.slice(startIdx, i + 1);
}

function makeEl() {
  return { hidden: false, innerHTML: "", textContent: "", disabled: false, value: "" };
}

function loadFn(name, scope) {
  const src = extractFn(name);
  const argNames = Object.keys(scope);
  const factory = new Function(...argNames, `${src}\nreturn ${name};`);
  return factory(...argNames.map((k) => scope[k]));
}

const escSrc = extractFn("esc");
const esc = new Function(`${escSrc}\nreturn esc;`)();

function makeDom(ids) {
  const els = {};
  for (const id of ids) els[id] = makeEl();
  return els;
}

// GATE 2 (a)(b): 스캔 전/스캔 완료+이슈 0건 문구가 서로 달라야 한다.
test("GATE 2: renderLint — 스캔 전과 스캔완료+이슈0건 문구가 서로 다르다", () => {
  const els = makeDom(["lintEmpty", "lintBody"]);
  const $ = (id) => els[id];

  let scan = null;
  loadFn("renderLint", { $, scan, esc })();
  const neverScannedText = els.lintEmpty.textContent;
  assert.equal(els.lintEmpty.hidden, false);
  assert.equal(els.lintBody.hidden, true);

  scan = { issues: [] };
  loadFn("renderLint", { $, scan, esc })();
  const cleanScanText = els.lintEmpty.textContent;
  assert.equal(els.lintEmpty.hidden, false);
  assert.notEqual(neverScannedText, cleanScanText, "스캔 전/스캔완료(이슈 0건) 문구가 동일하면 안 됨(버그 재현 조건)");
  assert.match(cleanScanText, /이슈가 없습니다|0건/);
});

test("GATE 2: renderReview — 스캔 전과 스캔완료+이슈0건 문구가 서로 다르다", () => {
  const els = makeDom(["reviewEmpty", "reviewTable"]);
  const $ = (id) => els[id];

  let scan = null;
  loadFn("renderReview", { $, scan, esc, capabilities: {} })();
  const neverScannedText = els.reviewEmpty.textContent;

  scan = { issues: [] };
  loadFn("renderReview", { $, scan, esc, capabilities: {} })();
  const cleanScanText = els.reviewEmpty.textContent;

  assert.notEqual(neverScannedText, cleanScanText, "스캔 전/스캔완료(이슈 0건) 문구가 동일하면 안 됨(버그 재현 조건)");
});

// GATE 2 (c): 스캔 완료 후 화면 탭 드롭다운에 스캔된 파일이 전부 나타난다(실제 백엔드 응답 형태 재현:
// files: ["_abap/ZAQMR0130.abap", ...] 8개).
test("GATE 2: renderPreviewFileList — 스캔된 8개 파일이 드롭다운에 전부 채워진다", () => {
  const els = makeDom(["previewFile", "previewBtn"]);
  const $ = (id) => els[id];
  const files = [
    "_abap/ZAQMR0130.abap", "_abap/ZAQMR0130_CLS.abap", "_abap/ZAQMR0130_F01.abap",
    "_abap/ZAQMR0130_I01.abap", "_abap/ZAQMR0130_O01.abap", "_abap/ZAQMR0130_S01.abap",
    "_abap/ZAQMR0130_TOP.abap", "_abap/ZAQMR0131.abap",
  ];
  const scan = { files };
  loadFn("renderPreviewFileList", { $, scan, esc })();

  const optionCount = (els.previewFile.innerHTML.match(/<option/g) || []).length;
  assert.equal(optionCount, files.length + 1, "플레이스홀더 1개 + 파일 8개 = 9개 option이어야 함");
  for (const f of files) assert.ok(els.previewFile.innerHTML.includes(esc(f)), `드롭다운에 ${f}가 있어야 함`);
});

test("GATE 2: renderPreviewFileList — 스캔 전(scan=null)에는 플레이스홀더만 있다", () => {
  const els = makeDom(["previewFile", "previewBtn"]);
  const $ = (id) => els[id];
  loadFn("renderPreviewFileList", { $, scan: null, esc })();
  const optionCount = (els.previewFile.innerHTML.match(/<option/g) || []).length;
  assert.equal(optionCount, 1);
  assert.equal(els.previewBtn.disabled, true);
});

// Phase 3: 스캔 없이 바로 미리보기 — 입력값 검증과 API 호출 배선을 헤드리스로 확인.
test("Phase 3: runPreviewDirect — repoUrl/path가 비어있으면 fetch 없이 toast만 표시", async () => {
  const els = makeDom(["directRepoUrl", "directBranch", "directPath", "directPreviewBtn", "directPreviewStatus"]);
  const $ = (id) => els[id];
  let toastMsg = null, fetchCalled = false;
  const fn = loadFn("runPreviewDirect", {
    $,
    fetch: async () => { fetchCalled = true; return {}; },
    safeJson: async (r) => r,
    authHeaders: (h) => h,
    busy: () => {},
    toast: (m) => { toastMsg = m; },
    renderPreviewElements: () => {},
  });
  await fn();
  assert.equal(fetchCalled, false, "필수값이 비어있으면 fetch를 호출하면 안 됨");
  assert.ok(toastMsg, "toast로 안내 메시지가 떠야 함");
});

test("Phase 3: runPreviewDirect — 값 입력 시 action=preview-direct로 호출하고 결과를 렌더링한다", async () => {
  const els = makeDom(["directRepoUrl", "directBranch", "directPath", "directPreviewBtn", "directPreviewStatus"]);
  els.directRepoUrl.value = "git@github.com:owner/repo.git";
  els.directBranch.value = "main";
  els.directPath.value = "260707_QM023_ZAQMR0130/_abap/ZAQMR0130_S01.abap";
  const $ = (id) => els[id];
  let calledUrl = null, calledBody = null, renderedArgs = null;
  const fn = loadFn("runPreviewDirect", {
    $,
    fetch: async (url, opts) => { calledUrl = url; calledBody = JSON.parse(opts.body); return {}; },
    safeJson: async () => ({ file: "ZAQMR0130_S01.abap", elements: [{ type: "comment", text: "x" }], coverage: { parsed: 1, unparsed: 0 } }),
    authHeaders: (h) => h,
    busy: () => {},
    toast: () => {},
    renderPreviewElements: (elements, coverage) => { renderedArgs = { elements, coverage }; },
  });
  await fn();
  assert.match(calledUrl, /action=preview-direct/);
  assert.deepEqual(calledBody, {
    repoUrl: "git@github.com:owner/repo.git",
    branch: "main",
    path: "260707_QM023_ZAQMR0130/_abap/ZAQMR0130_S01.abap",
  });
  assert.ok(renderedArgs && renderedArgs.elements.length === 1, "미리보기 결과가 렌더링 함수로 전달되어야 함");
  assert.match(els.directPreviewStatus.textContent, /ZAQMR0130_S01\.abap/);
});

// Phase 2 (dictionary→DDIC 미션): 화면(Preview) 탭의 "스캔 없이 바로 미리보기" GitHub SSH URL 입력란은
// placeholder만이 아니라 실제 value로 채워져 있어야, 사용자가 아무것도 입력하지 않고 바로 버튼을 눌러도
// 동작한다(기존에는 메인 "스캔 대상" 입력만 값이 채워져 있고 이 입력은 placeholder만 있던 GAP).
test("Phase 2: 화면(Preview) 탭 GitHub SSH URL 입력란(directRepoUrl)은 실제 value로 기본값이 채워져 있다", () => {
  const m = html.match(/<input id="directRepoUrl"([^>]*)>/);
  assert.ok(m, "directRepoUrl input을 찾지 못함");
  const attrs = m[1];
  const valueMatch = attrs.match(/\bvalue="([^"]*)"/);
  assert.ok(valueMatch && valueMatch[1].trim(), "value 속성이 비어있지 않아야 함(placeholder만 있으면 안 됨)");
  assert.equal(valueMatch[1], "git@github.com:yesblue0342-bit/0Program.git");
  // 브랜치 기본값도 main 유지(미션 요구사항)
  const branchMatch = html.match(/<input id="directBranch"[^>]*value="([^"]*)"/);
  assert.equal(branchMatch?.[1], "main");
});
