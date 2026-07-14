// Phase 3: action=preview-direct — 사전 스캔 없이 GitHub SSH URL/브랜치/단일 파일 경로만으로 미리보기.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import handler from "../api/cbo-precheck.js";

const exec = promisify(execFile);

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

test("GATE 3 (a): repoUrl 없이 호출하면 400 JSON", async () => {
  const res = mockRes();
  await handler({ method: "POST", query: { action: "preview-direct" }, body: { path: "a.abap" } }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.message, /repoUrl/);
});

test("GATE 3 (a): path(파일 경로) 없이 호출하면 400 JSON", async () => {
  const res = mockRes();
  await handler({ method: "POST", query: { action: "preview-direct" }, body: { repoUrl: "git@github.com:owner/repo.git" } }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.message, /경로/);
});

test("GATE 3 (b): 존재하지 않는 repo/경로는 명확한 오류를 반환한다(평문 아님)", async () => {
  const res = mockRes();
  await handler({
    method: "POST",
    query: { action: "preview-direct" },
    body: { repoUrl: "git@github.com:owner/definitely-does-not-exist-xyz.git", branch: "main", path: "a.abap" },
  }, res);
  assert.equal(res._status, 400);
  assert.equal(typeof res._body, "object");
  assert.equal(res._body.ok, false);
});

// GATE 3 (d): 실제 저장소의 plain 네이밍 단일 파일(Selection Screen 포함 _S01.abap)로 스캔 없이
// 독립 미리보기 생성 → Selection Screen 요소가 실제로 렌더링됨을 확인. SSH 불가 환경은 skip.
const LIVE_REPO = "git@github.com:yesblue0342-bit/0Program.git";
const sshEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5",
};
let sshOk = false;
try {
  await exec("git", ["ls-remote", LIVE_REPO, "HEAD"], { timeout: 8000, windowsHide: true, env: sshEnv });
  sshOk = true;
} catch { sshOk = false; }

test(
  "GATE 3 (d): 실제 0Program 저장소 — 스캔 없이 ZAQMR0130_S01.abap 단일 파일 미리보기 → Selection Screen 요소 렌더링",
  { skip: sshOk ? false : "SSH(배포키) 접근 불가 — 네트워크 제약으로 skip" },
  async () => {
    const res = mockRes();
    await handler({
      method: "POST",
      query: { action: "preview-direct" },
      body: { repoUrl: LIVE_REPO, branch: "main", path: "260707_QM023_ZAQMR0130/_abap/ZAQMR0130_S01.abap" },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    assert.equal(res._body.ok, true);
    assert.ok(res._body.elements.length > 0, "plain 네이밍 단일 파일도 Selection Screen 요소가 파싱되어야 함(스캔 배치 없이도)");
    assert.ok(
      res._body.elements.some((e) => e.type === "parameter" || e.type === "select-options"),
      "PARAMETERS/SELECT-OPTIONS 요소가 최소 하나는 있어야 함"
    );
    assert.equal(res._body.file, "ZAQMR0130_S01.abap", "결과의 file은 원본 파일명이어야 함(가상 abapGit 이름 노출 금지)");
  }
);

test(
  "GATE 3 (c): 존재하지 않는 파일 경로는 명확한 404 오류(회귀 없음 — 기존 scan 경로는 무변경)",
  { skip: sshOk ? false : "SSH(배포키) 접근 불가 — 네트워크 제약으로 skip" },
  async () => {
    const res = mockRes();
    await handler({
      method: "POST",
      query: { action: "preview-direct" },
      body: { repoUrl: LIVE_REPO, branch: "main", path: "260707_QM023_ZAQMR0130/_abap/NOPE_NOT_REAL.abap" },
    }, res);
    assert.equal(res._status, 400);
    assert.equal(res._body.ok, false);
  }
);
