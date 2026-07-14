import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scanFiles } from "../lib/cbo-precheck/scan.js";
import { applyEdits, applyIssuesToFile } from "../lib/cbo-precheck/applyFix.js";
import {
  hasGithubToken, parseGithubSshUrl, getBranchSha, createBranch, getFile, putFile,
  createPullRequest, closePullRequest, openFixPullRequest,
} from "../lib/cbo-precheck/github.js";
import { hasAnthropicKey, suggestFix } from "../lib/cbo-precheck/anthropic.js";

const bad = fs.readFileSync("fixtures/zaqmr0130_bad.prog.abap", "utf8");

test("applyEdits: abaplint의 실제 obsolete_statement/sql_escape fix를 정확히 적용한다", () => {
  const { issues } = scanFiles({ files: [{ name: "zaqmr0130_bad.prog.abap", content: bad }] });
  const { content, applied, skipped } = applyIssuesToFile(bad, issues);
  assert.match(content, /gv_matnr = ls_out-matnr\./);
  assert.doesNotMatch(content, /MOVE ls_out-matnr TO gv_matnr\./);
  assert.match(content, /prueflos IN @s_pruef/);
  assert.match(content, /INTO CORRESPONDING FIELDS OF TABLE @gt_out/);
  assert.equal(applied.length, 3);
  assert.equal(skipped.length, issues.length - 3, "unknown_types/check_syntax 는 fix가 없어 skipped 로 분류된다");
});

test("applyEdits: 범위가 원본과 맞지 않으면(원본 변경) 명확한 오류를 던진다", () => {
  assert.throws(
    () => applyEdits("short", [{ range: { start: { row: 1, col: 1 }, end: { row: 1, col: 999 } }, newText: "x" }]),
    /맞지 않습니다/
  );
});

test("github.js: parseGithubSshUrl / hasGithubToken", () => {
  assert.deepEqual(parseGithubSshUrl("git@github.com:yesblue0342-bit/0Program.git"), { owner: "yesblue0342-bit", repo: "0Program" });
  assert.deepEqual(parseGithubSshUrl("git@github.com:owner/repo"), { owner: "owner", repo: "repo" });
  assert.throws(() => parseGithubSshUrl("https://github.com/a/b"), /파싱할 수 없습니다/);
  const before = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  assert.equal(hasGithubToken(), false);
  process.env.GITHUB_TOKEN = "test-token";
  assert.equal(hasGithubToken(), true);
  if (before === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = before;
});

// GitHub API를 mock한 유닛 테스트(GATE 2 요구사항 — 실제 PR 남발 금지). fetch 호출을 가로채 canned 응답을 준다.
function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : undefined });
    const route = routes.find((r) => r.method === (opts.method || "GET") && r.test(url));
    if (!route) throw new Error(`mock 되지 않은 요청: ${opts.method || "GET"} ${url}`);
    return {
      ok: route.status < 400,
      status: route.status,
      text: async () => JSON.stringify(route.body),
    };
  };
  return { fetchImpl, calls };
}

test("github.js: getBranchSha/createBranch/getFile/putFile/createPullRequest/closePullRequest (mock)", async () => {
  const { fetchImpl, calls } = mockFetch([
    { method: "GET", test: (u) => u.includes("/git/ref/heads/main"), status: 200, body: { object: { sha: "base-sha" } } },
    { method: "POST", test: (u) => u.endsWith("/git/refs"), status: 201, body: { ref: "refs/heads/precheck/auto-1" } },
    { method: "GET", test: (u) => u.includes("/contents/") && u.includes("ref=main"), status: 200, body: { content: Buffer.from("REPORT ztest.").toString("base64"), sha: "file-sha" } },
    { method: "PUT", test: (u) => u.includes("/contents/"), status: 200, body: { commit: { sha: "new-commit-sha" } } },
    { method: "POST", test: (u) => u.endsWith("/pulls"), status: 201, body: { number: 42, html_url: "https://github.com/o/r/pull/42" } },
    { method: "PATCH", test: (u) => u.includes("/pulls/42"), status: 200, body: { number: 42, state: "closed" } },
  ]);
  const opts = { token: "fake", fetchImpl };

  assert.equal(await getBranchSha("o", "r", "main", opts), "base-sha");
  await createBranch("o", "r", "precheck/auto-1", "base-sha", opts);
  const file = await getFile("o", "r", "src/z.prog.abap", "main", opts);
  assert.equal(file.content, "REPORT ztest.");
  assert.equal(file.sha, "file-sha");
  await putFile("o", "r", "src/z.prog.abap", "precheck/auto-1", "REPORT ztest2.", "fix: x", "file-sha", opts);
  const pr = await createPullRequest("o", "r", { title: "t", head: "precheck/auto-1", base: "main", body: "b" }, opts);
  assert.equal(pr.number, 42);
  const closed = await closePullRequest("o", "r", 42, opts);
  assert.equal(closed.state, "closed");

  assert.equal(calls.length, 6);
  assert.equal(calls[1].body.sha, "base-sha");
  assert.equal(calls[4].body.title, "t");
});

test("github.js: openFixPullRequest 는 branch 생성 → 파일 커밋 → PR 생성을 순서대로 수행한다(mock)", async () => {
  const { fetchImpl, calls } = mockFetch([
    { method: "GET", test: (u) => u.includes("/git/ref/heads/main"), status: 200, body: { object: { sha: "base-sha" } } },
    { method: "POST", test: (u) => u.endsWith("/git/refs"), status: 201, body: {} },
    { method: "PUT", test: (u) => u.includes("/contents/"), status: 200, body: {} },
    { method: "POST", test: (u) => u.endsWith("/pulls"), status: 201, body: { number: 7, html_url: "https://github.com/o/r/pull/7" } },
  ]);
  const pr = await openFixPullRequest({
    owner: "o", repo: "r", base: "main", branchName: "precheck/auto-x",
    files: [{ path: "src/z.prog.abap", content: "REPORT z.", originalSha: "sha1" }],
    title: "fix", body: "body",
  }, { token: "fake", fetchImpl });
  assert.equal(pr.number, 7);
  assert.deepEqual(calls.map((c) => c.method), ["GET", "POST", "PUT", "POST"]);
});

test("github.js: 토큰 없으면 명확한 오류(main 직접 커밋 경로가 없으므로 조용히 실패하지 않는다)", async () => {
  await assert.rejects(() => getBranchSha("o", "r", "main", { token: "", fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }) }), /GITHUB_TOKEN/);
});

test("github.js: GitHub API 오류 응답은 message를 그대로 전달한다", async () => {
  const fetchImpl = async () => ({ ok: false, status: 422, text: async () => JSON.stringify({ message: "Reference already exists" }) });
  await assert.rejects(() => createBranch("o", "r", "dup", "sha", { token: "fake", fetchImpl }), /Reference already exists/);
});

test("anthropic.js: hasAnthropicKey + suggestFix(mock 성공/실패)", async () => {
  const before = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(hasAnthropicKey(), false);
  await assert.rejects(() => suggestFix({ fileName: "a.abap", source: "x", issues: [{ line: 1, col: 1, rule: "x", severity: "Error", message: "m" }], apiKey: "" }), /ANTHROPIC_API_KEY/);

  const fetchImplOk = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: "text", text: "```abap\nREPORT zfixed.\n```" }] }) });
  const fixed = await suggestFix({ fileName: "a.abap", source: "REPORT zbad.", issues: [{ line: 1, col: 1, rule: "obsolete_statement", severity: "Error", message: "m" }], apiKey: "fake", fetchImpl: fetchImplOk });
  assert.equal(fixed, "REPORT zfixed.");

  const fetchImplErr = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "invalid x-api-key" } }) });
  await assert.rejects(() => suggestFix({ fileName: "a.abap", source: "x", issues: [{ line: 1, col: 1, rule: "x", severity: "Error", message: "m" }], apiKey: "bad", fetchImpl: fetchImplErr }), /invalid x-api-key/);

  if (before === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = before;
});
