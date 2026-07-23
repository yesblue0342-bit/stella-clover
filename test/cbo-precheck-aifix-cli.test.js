// test/cbo-precheck-aifix-cli.test.js — aiFix.js의 구독(CLI) 우선순위 로직 검증.
//   lib/ai-connection/providers.js(실제 CLI subprocess spawn을 수행)를 mock.module로 완전히 대체해,
//   실제 claude/codex CLI 없이도 "구독 연결 시 CLI 경로를 탄다"를 확정적으로 검증한다
//   (node --experimental-test-module-mocks 필요 — package.json test 스크립트에 이미 반영,
//   test/notes-body-cache.test.js와 동일 패턴).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const calls = [];
let providers = [];

mock.module("../lib/ai-connection/providers.js", {
  exports: {
    async providerStatus() { return providers; },
    async callModelWithFallback(args) { calls.push(args); return "```abap\nREPORT zfixed_cli.\n```"; },
  },
});

const { hasAiConnection, pickAiConnection, suggestFix } = await import("../lib/cbo-precheck/aiFix.js");

function providerRow(provider, { mode = "apikey", authenticated = false, hasKey = false } = {}) {
  return { provider, connected: mode === "cli" ? authenticated : hasKey, mode, hasKey, cli: { available: true, authenticated }, models: ["m"] };
}

test("aiFix.js: Claude/ChatGPT 둘 다 구독 연결이면 Claude(anthropic) 구독을 우선 사용한다", async () => {
  calls.length = 0;
  providers = [
    providerRow("openai", { mode: "cli", authenticated: true }),
    providerRow("anthropic", { mode: "cli", authenticated: true }),
    providerRow("gemini"),
  ];
  assert.equal(await hasAiConnection(), true);
  assert.deepEqual(await pickAiConnection(), { provider: "anthropic", model: "claude-sonnet-5", via: "claude-subscription" });
  const fixed = await suggestFix({ fileName: "a.abap", source: "REPORT zbad.", issues: [{ line: 1, col: 1, rule: "x", severity: "Error", message: "m" }] });
  assert.equal(fixed, "REPORT zfixed_cli.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "anthropic");
  assert.equal(calls[0].model, "claude-sonnet-5");
});

test("aiFix.js: Claude 구독 없이 ChatGPT(Codex) 구독만 있으면 openai 구독을 사용한다", async () => {
  calls.length = 0;
  providers = [
    providerRow("openai", { mode: "cli", authenticated: true }),
    providerRow("anthropic"),
    providerRow("gemini"),
  ];
  assert.deepEqual(await pickAiConnection(), { provider: "openai", model: "gpt-5.6", via: "chatgpt-subscription" });
  await suggestFix({ fileName: "a.abap", source: "REPORT zbad.", issues: [{ line: 1, col: 1, rule: "x", severity: "Error", message: "m" }] });
  assert.equal(calls[0].provider, "openai");
});

test("aiFix.js: 구독 연결이 전혀 없고 API 키만 있으면 구독보다 API 키가 후순위로 사용된다(Claude 우선)", async () => {
  providers = [
    providerRow("openai", { hasKey: true }),
    providerRow("anthropic", { hasKey: true }),
    providerRow("gemini"),
  ];
  assert.deepEqual(await pickAiConnection(), { provider: "anthropic", model: "claude-sonnet-5", via: "api-key" });
});

test("aiFix.js: 구독(CLI)이 연결돼 있으면 API 키가 있어도 구독 경로가 우선한다", async () => {
  providers = [
    providerRow("openai", { hasKey: true }),
    providerRow("anthropic", { mode: "cli", authenticated: true, hasKey: true }),
    providerRow("gemini"),
  ];
  assert.deepEqual(await pickAiConnection(), { provider: "anthropic", model: "claude-sonnet-5", via: "claude-subscription" });
});

// 회귀 가드: mode="cli"인데 로그인이 만료(authenticated=false)된 provider는, 같은 provider에 저장된 API 키가
// 있어도 그 키로 폴백하지 않는다 — 공용 모듈 callModel()이 mode="cli"면 미인증이어도 API 키 경로로 절대
// 새지 않기 때문에(providers.js), pickAiConnection이 여기서 "api-key"를 골라버리면 버튼은 활성인데
// 실제 호출은 "로그인 만료" 오류로 실패하는 불일치가 생긴다(architect 리뷰에서 지적됨).
test("aiFix.js: cli 모드인데 로그인 만료면, 같은 provider의 저장된 API 키로 폴백하지 않는다", async () => {
  providers = [
    providerRow("openai"),
    providerRow("anthropic", { mode: "cli", authenticated: false, hasKey: true }),
    providerRow("gemini"),
  ];
  assert.equal(await pickAiConnection(), null);
  assert.equal(await hasAiConnection(), false);
});
