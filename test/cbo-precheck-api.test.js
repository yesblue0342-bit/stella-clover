import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/cbo-precheck.js";

function mockRes() {
  const res = {
    _status: 200,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(c) { this._status = c; return this; },
    json(o) { this._body = o; return this; },
    send(b) { this._body = b; return this; },
  };
  return res;
}

test("action=capabilities: GITHUB_TOKEN/AI 연결 미설정 시 false를 반환한다(그레이스풀 비활성)", async () => {
  const beforeGh = process.env.GITHUB_TOKEN;
  const beforeAn = process.env.ANTHROPIC_API_KEY;
  const beforeOp = process.env.OPENAI_API_KEY;
  delete process.env.GITHUB_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const res = mockRes();
    await handler({ method: "GET", query: { action: "capabilities" }, body: {} }, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { ok: true, githubToken: false, aiConnected: false });
  } finally {
    if (beforeGh !== undefined) process.env.GITHUB_TOKEN = beforeGh;
    if (beforeAn !== undefined) process.env.ANTHROPIC_API_KEY = beforeAn;
    if (beforeOp !== undefined) process.env.OPENAI_API_KEY = beforeOp;
  }
});

test("action=fix-auto: GITHUB_TOKEN 미설정 시 503 + 명확한 사유(앱은 계속 정상 동작)", async () => {
  const before = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const res = mockRes();
    await handler({ method: "POST", query: { action: "fix-auto" }, body: { scanId: "nope" } }, res);
    assert.equal(res._status, 503);
    assert.match(res._body.message, /GITHUB_TOKEN/);
  } finally {
    if (before !== undefined) process.env.GITHUB_TOKEN = before;
  }
});

test("action=fix-claude-preview: AI 연결 수단이 없으면 503", async () => {
  const beforeAn = process.env.ANTHROPIC_API_KEY;
  const beforeOp = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const res = mockRes();
    await handler({ method: "POST", query: { action: "fix-claude-preview" }, body: { scanId: "nope" } }, res);
    assert.equal(res._status, 503);
    assert.match(res._body.message, /AI 연결/);
  } finally {
    if (beforeAn !== undefined) process.env.ANTHROPIC_API_KEY = beforeAn;
    if (beforeOp !== undefined) process.env.OPENAI_API_KEY = beforeOp;
  }
});

test("알 수 없는 action은 항상 JSON 404를 반환한다(평문 금지)", async () => {
  const res = mockRes();
  await handler({ method: "GET", query: { action: "nope" }, body: {} }, res);
  assert.equal(res._status, 404);
  assert.equal(typeof res._body, "object");
});

test("scan: repoUrl 없이 호출하면 400 JSON", async () => {
  const res = mockRes();
  await handler({ method: "POST", query: { action: "scan" }, body: {} }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.message, /repoUrl/);
});

test("export: 존재하지 않는 scanId는 404 JSON", async () => {
  const res = mockRes();
  await handler({ method: "GET", query: { action: "export", scanId: "nope", format: "xlsx" }, body: {} }, res);
  assert.equal(res._status, 404);
});

test("issue-update: 존재하지 않는 scanId는 400 JSON(throw가 새어나가지 않는다)", async () => {
  const res = mockRes();
  await handler({ method: "POST", query: { action: "issue-update" }, body: { scanId: "nope", issueId: "nope", status: "held" } }, res);
  assert.equal(res._status, 400);
});
