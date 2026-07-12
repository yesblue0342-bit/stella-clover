import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

// providers.js는 모듈 로드 시점에 CBO_DATA_DIR을 읽으므로, 정적 import보다 먼저 격리된 임시 디렉터리로
// 지정한 뒤 동적 import한다(다른 테스트 파일의 데이터 디렉터리와 절대 공유하지 않기 위함).
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cbo-providers-test-"));
process.env.CBO_DATA_DIR = tmpDir;
const {
  getProviderKey, getProviderMode, connectCli, disconnectCli, detectCli, providerStatus, callModel,
} = await import("../lib/cbo-review/providers.js");

test.after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

test("연결 방식(mode)이 없으면 기본값은 apikey", async () => {
  assert.equal(await getProviderMode("anthropic"), "apikey");
});

test("계정 로그인을 지원하지 않는 provider는 connectCli가 거부한다", async () => {
  await assert.rejects(() => connectCli("gemini"), /지원하지 않습니다/);
});

test("레거시 providers.json(평문 키 문자열) 포맷과 호환된다", async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(path.join(tmpDir, "providers.json"), JSON.stringify({ anthropic: "sk-ant-legacy-0000" }));
  assert.equal(await getProviderKey("anthropic"), "sk-ant-legacy-0000");
  assert.equal(await getProviderMode("anthropic"), "apikey");
});

test("detectCli는 available/authenticated 불리언 쌍을 반환하고, 미가용이면 미인증이다", async () => {
  for (const provider of ["openai", "anthropic", "gemini"]) {
    const status = await detectCli(provider);
    assert.equal(typeof status.available, "boolean");
    assert.equal(typeof status.authenticated, "boolean");
    if (!status.available) assert.equal(status.authenticated, false);
  }
});

test("connectCli/disconnectCli는 실제 detectCli 결과와 일관된 방식으로 동작한다", async () => {
  const status = await detectCli("anthropic");
  if (status.authenticated) {
    await connectCli("anthropic");
    assert.equal(await getProviderMode("anthropic"), "cli");
    await disconnectCli("anthropic");
    assert.equal(await getProviderMode("anthropic"), "apikey");
  } else {
    await assert.rejects(() => connectCli("anthropic"));
  }
});

test("[회귀] cli 모드인데 미인증이면 API 키 검증/에러 경로로 새지 않는다", async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  // connectCli()를 거치지 않고 저장 포맷을 직접 만들어, 서버에 실제 CLI 로그인이 없는 CI 환경에서도
  // "mode=cli, 미인증" 상태를 재현한다(API 키는 일부러 저장하지 않음 — 폴백 경로 진입 여부를 검증).
  await fs.writeFile(path.join(tmpDir, "providers.json"), JSON.stringify({ __mode__: { anthropic: "cli" } }));
  assert.equal(await getProviderMode("anthropic"), "cli");
  assert.equal(await getProviderKey("anthropic"), "");

  const status = await detectCli("anthropic");
  if (status.authenticated) return; // 실제 CLI가 로그인된 환경이면 이 회귀 케이스를 재현할 수 없어 스킵.

  await assert.rejects(
    () => callModel({ provider: "anthropic", model: "claude-sonnet-5", system: "s", user: "u" }),
    (error) => {
      assert.ok(!/API 키/.test(error.message), `cli 모드 오류에 API 키 문구가 섞이면 안 된다: ${error.message}`);
      assert.match(error.message, /CLI|login/);
      return true;
    },
  );
});

test("providerStatus는 provider마다 mode/cli/connected 필드를 포함한다", async () => {
  const providers = await providerStatus();
  assert.equal(providers.length, 3);
  for (const p of providers) {
    assert.ok(["apikey", "cli"].includes(p.mode));
    assert.equal(typeof p.connected, "boolean");
    assert.ok(p.cli && typeof p.cli.available === "boolean");
    assert.ok(Array.isArray(p.models) && p.models.length > 0);
  }
});
