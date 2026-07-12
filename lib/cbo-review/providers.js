import fs from "node:fs/promises";
import path from "node:path";
import { PROVIDER_MODELS, validateProviderModel } from "./core.js";

const DATA_DIR = process.env.CBO_DATA_DIR || path.resolve(process.cwd(), "data/cbo-review");
const SETTINGS_FILE = path.join(DATA_DIR, "providers.json");

const ENV_KEYS = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

async function readStored() {
  try { return JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")); }
  catch { return {}; }
}

export async function saveProviderKey(provider, key) {
  if (!ENV_KEYS[provider]) throw new Error("지원하지 않는 AI 제공자입니다.");
  const clean = String(key || "").trim();
  if (clean.length < 12) throw new Error("API 키 형식이 올바르지 않습니다.");
  await listModels(provider, clean);
  const current = await readStored();
  current[provider] = clean;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}

export async function deleteProviderKey(provider) {
  const current = await readStored();
  delete current[provider];
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}

export async function getProviderKey(provider) {
  const fromEnv = process.env[ENV_KEYS[provider]];
  if (fromEnv) return fromEnv;
  return (await readStored())[provider] || "";
}

export async function providerStatus() {
  const providers = [];
  for (const [provider, fallbackModels] of Object.entries(PROVIDER_MODELS)) {
    const key = await getProviderKey(provider);
    let models = fallbackModels;
    if (key) {
      try { models = await listModels(provider, key); } catch {}
    }
    providers.push({ provider, connected: !!key, models: models.length ? models : fallbackModels });
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
