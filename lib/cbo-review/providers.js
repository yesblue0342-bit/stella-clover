import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { PROVIDER_MODELS, validateProviderModel } from "./core.js";

const DATA_DIR = process.env.CBO_DATA_DIR || path.resolve(process.cwd(), "data/cbo-review");
const SETTINGS_FILE = path.join(DATA_DIR, "providers.json");

const ENV_KEYS = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

// 계정 로그인(CLI) 방식을 지원하는 provider만 등록. Gemini는 서드파티 앱용 공개 OAuth/CLI가 없어 API 키만 지원(REVIEW_LOG.md 참조).
const CLI_BIN = { anthropic: "claude", openai: "codex" };
const CLI_AUTH_FILE = {
  anthropic: () => path.join(process.env.CBO_CLAUDE_HOME || path.join(os.homedir(), ".claude"), ".credentials.json"),
  openai: () => path.join(process.env.CBO_CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json"),
};
// 리뷰/스펙 프롬프트는 첨부파일(소스코드 등) 내용을 그대로 포함하므로, 프롬프트 인젝션이 CLI에이전트의 파일/셸 접근으로
// 번지지 않도록 순수 텍스트 생성 외 도구는 전부 차단한다(계정 로그인 경로 전용 방어, API 키 경로는 애초에 도구가 없음).
const CLI_DISALLOWED_TOOLS = "Bash,BashOutput,KillShell,Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Read,Glob,Grep,Task";

async function readStored() {
  try { return JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")); }
  catch { return {}; }
}

async function writeStored(current) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}

export async function saveProviderKey(provider, key) {
  if (!ENV_KEYS[provider]) throw new Error("지원하지 않는 AI 제공자입니다.");
  const clean = String(key || "").trim();
  if (clean.length < 12) throw new Error("API 키 형식이 올바르지 않습니다.");
  await listModels(provider, clean);
  const current = await readStored();
  current[provider] = clean;
  await writeStored(current);
}

export async function deleteProviderKey(provider) {
  const current = await readStored();
  delete current[provider];
  await writeStored(current);
}

export async function getProviderKey(provider) {
  const fromEnv = process.env[ENV_KEYS[provider]];
  if (fromEnv) return fromEnv;
  return (await readStored())[provider] || "";
}

// __mode__ 서브키에만 CLI 선택 여부를 저장 — 기존 providers.json의 평문 키 저장 포맷/round-trip은 그대로 유지(하위 호환).
export async function getProviderMode(provider) {
  const stored = await readStored();
  return stored.__mode__?.[provider] === "cli" ? "cli" : "apikey";
}

function binaryAvailable(bin, prefixArgs = []) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, [...prefixArgs, "--version"], { shell: false, windowsHide: true, stdio: "ignore" }); }
    catch { return resolve(false); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(true); }, 4000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("exit", () => { clearTimeout(timer); resolve(true); });
  });
}

// npm이 Windows에 생성하는 .cmd 셰임은 batch 스크립트라 `shell:false`로 직접 spawn할 수 없다(Node가 EINVAL로 거부).
// 셰임 내용을 파싱해 실제 실행 대상(.exe 또는 `node <script.js>`)을 찾아 셸 없이 안전하게 직접 호출한다.
async function resolveWindowsCmdShim(cmdPath) {
  let content;
  try { content = await fs.readFile(cmdPath, "utf8"); } catch { return null; }
  const dir = path.dirname(cmdPath);
  const targets = [...content.matchAll(/%dp0%\\([^"%]+)/g)].map((m) => path.join(dir, m[1]));
  const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
  for (const target of targets.filter((p) => /\.exe$/i.test(p))) {
    if (await exists(target)) return { bin: target, prefixArgs: [] };
  }
  for (const target of targets.filter((p) => /\.js$/i.test(p))) {
    if (await exists(target)) return { bin: process.execPath, prefixArgs: [target] };
  }
  return null;
}

async function findOnPath(fileName) {
  const dirs = String(process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, fileName);
    try { await fs.access(candidate); return candidate; } catch {}
  }
  return null;
}

async function resolveCliBin(provider) {
  const base = CLI_BIN[provider];
  if (!base) return null;
  if (process.platform !== "win32") {
    return (await binaryAvailable(base)) ? { bin: base, prefixArgs: [] } : null;
  }
  const cmdPath = await findOnPath(`${base}.cmd`);
  if (!cmdPath) return null;
  const resolved = await resolveWindowsCmdShim(cmdPath);
  if (!resolved) return null;
  return (await binaryAvailable(resolved.bin, resolved.prefixArgs)) ? resolved : null;
}

// 토큰/자격증명 파일 내용은 절대 읽지 않는다 — 존재 여부만 확인(로그인 상태 판별용).
// 응답에는 서버 내부 실행 경로를 노출하지 않는다(available/authenticated만 반환).
export async function detectCli(provider) {
  if (!CLI_BIN[provider]) return { available: false, authenticated: false };
  const resolved = await resolveCliBin(provider);
  let authenticated = false;
  if (resolved) {
    try { await fs.access(CLI_AUTH_FILE[provider]()); authenticated = true; } catch {}
  }
  return { available: !!resolved, authenticated: !!resolved && authenticated };
}

export async function connectCli(provider) {
  if (!CLI_BIN[provider]) throw new Error(`${provider}는 계정 로그인 방식을 지원하지 않습니다.`);
  const status = await detectCli(provider);
  if (!status.available) throw new Error(`서버에 ${CLI_BIN[provider]} CLI가 설치되어 있지 않습니다.`);
  if (!status.authenticated) throw new Error(`서버에서 '${CLI_BIN[provider]} login'을 먼저 1회 실행해 로그인하세요.`);
  const current = await readStored();
  current.__mode__ = { ...(current.__mode__ || {}), [provider]: "cli" };
  await writeStored(current);
}

export async function disconnectCli(provider) {
  const current = await readStored();
  if (current.__mode__) delete current.__mode__[provider];
  await writeStored(current);
}

export async function providerStatus() {
  const providers = [];
  for (const [provider, fallbackModels] of Object.entries(PROVIDER_MODELS)) {
    const mode = await getProviderMode(provider);
    const cli = await detectCli(provider);
    const key = await getProviderKey(provider);
    let models = fallbackModels;
    const useKeyForListing = key && !(mode === "cli" && cli.authenticated);
    if (useKeyForListing) {
      try { models = await listModels(provider, key); } catch {}
    }
    const connected = mode === "cli" ? cli.authenticated : !!key;
    providers.push({ provider, connected, mode, hasKey: !!key, cli, models: models.length ? models : fallbackModels });
  }
  return providers;
}

async function listModels(provider, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    let response;
    if (provider === "openai") response = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
    if (provider === "anthropic") response = await fetch("https://api.anthropic.com/v1/models?limit=1000", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: controller.signal });
    if (provider === "gemini") response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`, { signal: controller.signal });
    if (!response?.ok) throw new Error(`models ${response?.status || "error"}`);
    const data = await response.json();
    if (provider === "openai") return (data.data || []).map((m) => m.id).filter((id) => /^gpt-/.test(id) && !/audio|realtime|transcribe|tts|image|search|chat/i.test(id)).sort().reverse();
    if (provider === "anthropic") return (data.data || []).map((m) => m.id).filter((id) => /^claude-/.test(id));
    return (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => String(m.name || "").replace(/^models\//, "")).filter((id) => /^gemini-/.test(id) && !/image|audio|tts|live|embedding/i.test(id));
  } finally { clearTimeout(timer); }
}

function runCli(bin, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, { shell: false, windowsHide: true, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { return reject(error); }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(reject, new Error(`${bin} 실행이 ${timeoutMs}ms 내 끝나지 않았습니다.`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 5_000_000) { try { child.kill(); } catch {} } });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 200_000) stderr = stderr.slice(-200_000); });
    child.on("error", (error) => finish(reject, error));
    child.on("exit", (code) => {
      if (code !== 0 && !stdout.trim()) return finish(reject, new Error(`${bin} 오류(종료 코드 ${code}): ${stderr.slice(0, 500) || "알 수 없는 오류"}`));
      finish(resolve, stdout);
    });
  });
}

// 계정 로그인(CLI) 경로 — 이미 `claude login`/`codex login`으로 인증된 CLI를 그대로 subprocess 호출해
// 사용자 본인 구독 한도로 응답을 받는다. API 키/토큰을 별도로 발급·저장하지 않는다.
async function callViaCli({ provider, model, system, user }) {
  const resolved = await resolveCliBin(provider);
  if (!resolved) throw new Error(`서버에 ${CLI_BIN[provider]} CLI가 설치되어 있지 않습니다.`);
  const { bin, prefixArgs } = resolved;

  if (provider === "anthropic") {
    const stdout = await runCli(bin, [
      ...prefixArgs,
      "-p", "--model", model,
      "--output-format", "json",
      "--disallowedTools", CLI_DISALLOWED_TOOLS,
      "--disable-slash-commands",
      "--system-prompt", system,
      user,
    ], { timeoutMs: 180000 });
    let data;
    try { data = JSON.parse(stdout); } catch { throw new Error("claude CLI 응답을 해석할 수 없습니다."); }
    if (data.is_error) throw new Error(data.result || "claude CLI 오류");
    return String(data.result || "");
  }

  if (provider === "openai") {
    // codex CLI 자체 모델 네이밍이 direct API(gpt-*)와 다를 수 있어 -m 을 강제하지 않고 서버측 codex 기본 모델을 사용한다
    // (WORK_REPORT.md에 한계로 기록 — 실사용 확인 필요).
    const outFile = path.join(os.tmpdir(), `cbo-codex-${crypto.randomUUID()}.txt`);
    try {
      await runCli(bin, [
        ...prefixArgs,
        "exec", "-s", "read-only", "--skip-git-repo-check",
        "-o", outFile,
        `${system}\n\n${user}`,
      ], { timeoutMs: 240000 });
      return (await fs.readFile(outFile, "utf8")).trim();
    } finally {
      await fs.rm(outFile, { force: true }).catch(() => {});
    }
  }

  throw new Error(`${provider}는 계정 로그인 방식을 지원하지 않습니다.`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestWithRetry(url, init, parse, retries = 3) {
  let last;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const body = await response.text();
      if (response.ok) return parse(JSON.parse(body));
      last = new Error(`AI API ${response.status}: ${body.slice(0, 500)}`);
      if (response.status !== 429 && response.status < 500) throw last;
    } catch (error) {
      last = error;
      if (attempt === retries - 1) throw error;
    } finally { clearTimeout(timer); }
    await wait(800 * (2 ** attempt));
  }
  throw last;
}

export async function callModel({ provider, model, system, user, json = false }) {
  validateProviderModel(provider, model);

  // cli 모드는 API 키 경로로 절대 새지 않는다 — 미인증이어도 cli 전용 에러로 종료(키 검증/키 관련 메시지 금지).
  if (CLI_BIN[provider] && (await getProviderMode(provider)) === "cli") {
    const status = await detectCli(provider);
    if (status.authenticated) return callViaCli({ provider, model, system, user });
    if (!status.available) throw new Error(`서버에 ${CLI_BIN[provider]} CLI가 설치되어 있지 않습니다.`);
    throw new Error(`서버에서 '${CLI_BIN[provider]} login'이 만료되었거나 인증되지 않았습니다. 관리자에게 재로그인을 요청하세요.`);
  }

  const key = await getProviderKey(provider);
  if (!key) throw new Error(`${provider} API 키가 연결되지 않았습니다.`);

  if (provider === "openai") {
    return requestWithRetry("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0.2, response_format: json ? { type: "json_object" } : undefined, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    }, (data) => data.choices?.[0]?.message?.content || "");
  }

  if (provider === "anthropic") {
    return requestWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 8192, temperature: 0.2, system, messages: [{ role: "user", content: user }] }),
    }, (data) => data.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  return requestWithRetry(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { temperature: 0.2, responseMimeType: json ? "application/json" : "text/plain" } }),
  }, (data) => data.candidates?.[0]?.content?.parts?.map((item) => item.text || "").join("\n") || "");
}
