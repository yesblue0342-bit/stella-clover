// server.js — Stella Clover 독립 실행 서버 (raw Node, 의존성 0)
//
// OCI(Ubuntu) 등에서 Vercel 없이 그대로 구동: `node server.js` (또는 `npm start`).
// api/*.js 의 Vercel 스타일 핸들러 `export default (req,res)` 를 그대로 재사용하도록
// req.query / req.body / res.status().json() 를 채워주는 얇은 어댑터.
//
// ★ 반복 오류 근본 차단 ★
//  - 413(대용량): 본문 한도를 MAX_BODY_BYTES(기본 25MB)로 넉넉히 — Vercel 4.5MB 제약 없음.
//    (단, 앞단 리버스 프록시 nginx `client_max_body_size` / OCI LB 한도도 함께 키워야 함 — 문서 참고)
//  - "Unexpected token …"(평문 에러): /api/* 는 import/throw/타임아웃 어떤 경우에도 **항상 JSON** 반환.
//  - 함수 타임아웃 콜드컷: raw Node 라 인위적 함수 타임아웃 없음(서버 requestTimeout만 넉넉히).

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024); // 25MB
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 600000);   // 10분 (긴 전사/요약 커버)

// ── .env 최소 로더(의존성 0): 존재 시 로드, 기존 env 는 덮지 않음 ──
function loadDotEnvOnce() {
  try {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const i = s.indexOf("=");
      if (i < 0) continue;
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch (e) { /* best-effort */ }
}

// ── 정적 파일 ──
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8", ".map": "application/json; charset=utf-8",
};
// 소스 노출 방지: 루트의 정적 자산만 화이트리스트로 서빙.
const STATIC_ALLOW_EXT = new Set([".html", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp", ".css", ".txt"]);
const STATIC_ALLOW_FILE = new Set(["sw.js", "manifest.json", "manifest.webmanifest", "favicon.ico", "robots.txt"]);

function isSafeStatic(name) {
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\") || name.startsWith(".")) return false;
  if (STATIC_ALLOW_FILE.has(name)) return true;
  return STATIC_ALLOW_EXT.has(path.extname(name).toLowerCase());
}

// ── API 라우트 화이트리스트: api/ 의 공개 핸들러(_ 접두 공유모듈 제외) ──
function listApiRoutes() {
  try {
    return new Set(
      fs.readdirSync(path.join(__dirname, "api"))
        .filter(f => f.endsWith(".js") && !f.startsWith("_"))
        .map(f => f.slice(0, -3))
    );
  } catch (e) { return new Set(); }
}
const API_ROUTES = listApiRoutes();
const _handlerCache = new Map();
async function loadHandler(name) {
  if (_handlerCache.has(name)) return _handlerCache.get(name);
  const mod = await import(pathToFileURL(path.join(__dirname, "api", name + ".js")).href);
  const fn = mod.default;
  if (typeof fn !== "function") throw new Error(`handler ${name} has no default export`);
  // bodyParser:false (예: transcribe) 면 본문을 미리 읽지 않고 raw 스트림으로 전달
  const rawBody = !!(mod.config && mod.config.api && mod.config.api.bodyParser === false);
  const entry = { fn, rawBody };
  _handlerCache.set(name, entry);
  return entry;
}

// ── req.query 파싱 (Vercel 호환: 단일=string, 중복=string[]) ──
function buildQuery(searchParams) {
  const q = {};
  for (const key of searchParams.keys()) {
    const all = searchParams.getAll(key);
    q[key] = all.length > 1 ? all : all[0];
  }
  return q;
}

// ── res 보강: Vercel 호환 status()/json()/send() ──
function augmentRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.headersSent && !res.getHeader("Content-Type")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (data) => {
    if (data == null) return res.end();
    if (Buffer.isBuffer(data) || typeof data === "string") return res.end(data);
    if (typeof data === "object") return res.json(data);
    return res.end(String(data));
  };
  return res;
}

// ── 본문 수집 (JSON / urlencoded 만; 한도 초과 시 413 JSON) ──
function readBody(req, res) {
  return new Promise((resolve) => {
    const ct = String(req.headers["content-type"] || "");
    const method = (req.method || "GET").toUpperCase();
    const hasBody = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
    const isJson = ct.includes("application/json");
    const isForm = ct.includes("application/x-www-form-urlencoded");
    if (!hasBody || !(isJson || isForm)) { req.body = req.body || {}; return resolve(true); }

    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        // keep-alive 소켓을 req.destroy()로 RST 하면 다음 재사용 요청이 'socket hang up'.
        // Connection: close 로 정상 종료 → 본문은 전달되고 소켓은 FIN 으로 깔끔히 닫힘.
        if (!res.headersSent) {
          res.statusCode = 413;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Connection", "close");
          res.end(JSON.stringify({ ok: false, message: `요청 본문이 너무 큽니다 (최대 ${Math.floor(MAX_BODY_BYTES / 1048576)}MB).` }));
        }
        return resolve(false);
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        if (!raw) req.body = {};
        else if (isJson) req.body = JSON.parse(raw);
        else req.body = Object.fromEntries(new URLSearchParams(raw));
      } catch (e) {
        sendJson(res, 400, { ok: false, message: "잘못된 요청 본문(JSON 파싱 실패)." });
        return resolve(false);
      }
      resolve(true);
    });
    req.on("error", () => {
      if (aborted) return;
      sendJson(res, 400, { ok: false, message: "요청 본문 수신 오류." });
      resolve(false);
    });
  });
}

function sendJson(res, code, obj) {
  if (res.headersSent) { try { res.end(); } catch (e) {} return; }
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

async function serveStatic(res, name) {
  const file = path.join(__dirname, name);
  try {
    const data = await fsp.readFile(file);
    res.statusCode = 200;
    res.setHeader("Content-Type", STATIC_TYPES[path.extname(name).toLowerCase()] || "application/octet-stream");
    // sw.js / html 은 항상 최신(네트워크 우선 SW와 정합), 정적 자산은 캐시 허용
    if (name === "sw.js" || name.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    res.end(data);
    return true;
  } catch (e) {
    return false;
  }
}

async function handle(req, res) {
  augmentRes(res);
  let url;
  try { url = new URL(req.url, "http://localhost"); }
  catch (e) { return sendJson(res, 400, { ok: false, message: "잘못된 URL." }); }
  const pathname = decodeURIComponent(url.pathname);
  req.query = buildQuery(url.searchParams);

  // 헬스체크 (OCI LB)
  if (pathname === "/healthz" || pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, service: "stella-clover", ts: new Date().toISOString() });
  }

  // ── /api/* ── 항상 JSON 보장
  if (pathname.startsWith("/api/")) {
    const name = pathname.slice(5).replace(/\/+$/, "");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name) || !API_ROUTES.has(name)) {
      return sendJson(res, 404, { ok: false, message: `알 수 없는 API: /api/${name}` });
    }
    let entry;
    try { entry = await loadHandler(name); }
    catch (e) { return sendJson(res, 500, { ok: false, message: "핸들러 로드 실패: " + (e && e.message || e) }); }

    if (!entry.rawBody) {
      const proceed = await readBody(req, res);
      if (!proceed) return; // 413/400 이미 응답됨
    }
    try {
      // 핸들러가 응답을 책임진다. transcribe 처럼 form.parse(req, cb) 콜백으로 나중에
      // 응답하는 경우 fn 은 즉시 resolve 되므로 여기서 자동 응답(204)을 하면 안 된다
      // (조기 응답 + 콜백의 이중 전송 버그). 진짜로 멈춘 요청은 server.requestTimeout 가 정리.
      await entry.fn(req, res);
    } catch (e) {
      sendJson(res, 500, { ok: false, message: "서버 오류: " + (e && e.message || String(e)) });
    }
    return;
  }

  // ── 정적 파일 ──
  if (req.method === "GET" || req.method === "HEAD") {
    const name = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    if (isSafeStatic(name) && await serveStatic(res, name)) return;
    // SPA 폴백: 그 외 GET 은 index.html
    if (await serveStatic(res, "index.html")) return;
    return sendJson(res, 404, { ok: false, message: "Not found" });
  }

  return sendJson(res, 405, { ok: false, message: "Method Not Allowed" });
}

export function createServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => sendJson(res, 500, { ok: false, message: "치명적 오류: " + (e && e.message || e) }));
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;       // 긴 전사/요약 중간컷 방지
  server.headersTimeout = Math.max(60000, REQUEST_TIMEOUT_MS + 5000);
  return server;
}

// 직접 실행 시에만 listen (테스트에서 import 시엔 listen 안 함)
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  loadDotEnvOnce();
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`[stella-clover] listening on :${PORT} · routes=[${[...API_ROUTES].sort().join(", ")}] · maxBody=${Math.floor(MAX_BODY_BYTES / 1048576)}MB`);
  });
}
