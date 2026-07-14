// Stella Clover — OCI 우분투 서버 구동 Express 서버
//
// api/*.js(export default handler(req,res))를 자체 Node 서버에서 실행한다.
// 정적 파일 + 깔끔한 URL rewrites + CSP + /api 라우팅 + 내부 스케줄러(크론 대체)를 여기서 처리.
// (★ Vercel 미사용 — 전부 OCI 우분투 서버로 이관. 함수 시간 제한 없어 긴 전사/요약·인프로세스 워커 가능.)
//
// 실행: node server.mjs   (PORT 기본 8971)
// 환경변수(시크릿)는 .env 로 주입: docker run --env-file .env ...
import express from "express";
import { existsSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const API_DIR = resolve(ROOT, "api");
const PORT = Number(process.env.PORT || 8971);

const app = express();
app.disable("x-powered-by");

// ── CSP (OCI 표준 보안 헤더) ─────────────────────────────────
const CSP =
  "default-src 'self' https: data: blob:; " +
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https:; " +
  "style-src 'self' 'unsafe-inline' https:; " +
  "img-src 'self' data: blob: https:; " +
  "font-src 'self' data: https:; " +
  "connect-src 'self' https:; " +
  "media-src 'self' data: blob: https:; " +
  "worker-src 'self' blob:; frame-src 'self' https:";
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  next();
});

// ── body 파싱 (JSON/폼/텍스트) — multipart/form-data 는 통과(formidable이 직접 읽음) ──
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(express.text({ type: ["text/*"], limit: "25mb" }));

// ── /api/* CORS (단순 허용 — 동일 출처 PWA + 진단용) ──
app.use("/api", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ── /api/* → api 파일의 default(req,res) 호출 ─────────────────
//  · 언더스코어(_db/_drive/_stt/_analyze/_meeting)·디렉토리 탈출은 404 (공유 모듈 비노출).
const handlerCache = new Map();
app.use("/api", async (req, res) => {
  const sub = req.path.replace(/^\/+/, "").split("?")[0];
  // 단일 세그먼트 + 비-언더스코어만 허용 (공유 모듈 _db/_drive/... 비노출, 경로탈출 차단).
  if (!sub || sub.startsWith("_") || sub.includes("/") || sub.includes("..")) {
    return res.status(404).json({ ok: false, error: `API not found: ${sub || ""}` });
  }

  const abs = resolve(ROOT, `api/${sub}.js`);
  if (!abs.startsWith(API_DIR) || !existsSync(abs)) {
    return res.status(404).json({ ok: false, error: `API not found: ${sub}` });
  }
  try {
    let handler = handlerCache.get(abs);
    if (!handler) {
      const mod = await import(pathToFileURL(abs).href);
      handler = mod.default;
      if (typeof handler !== "function") {
        return res.status(404).json({ ok: false, error: `API not found: ${sub}` });
      }
      handlerCache.set(abs, handler);
    }
    return await handler(req, res);
  } catch (err) {
    console.error(`[api/${sub}]`, err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ── 깔끔한 URL rewrites → .html ──────────────────────────────
const REWRITES = {
  "/": "index.html",
  "/talk": "talk.html", "/stella-talk": "talk.html",
  "/db": "db.html", "/stella-db": "db.html",
  "/flow": "flow/index.html", "/stella-flow": "flow/index.html",
  "/rate": "rate/index.html", "/stella-rate": "rate/index.html", "/currency": "rate/index.html",
  "/notes": "note/index.html", "/stella-notes": "note/index.html",
  "/cbo-review": "cbo-review/index.html", "/stella-cbo-review": "cbo-review/index.html",
  "/cbo-precheck": "cbo-precheck/index.html", "/stella-cbo-precheck": "cbo-precheck/index.html",
};
app.get(/.*/, (req, res, next) => {
  const target = REWRITES[req.path];
  if (target && existsSync(join(ROOT, target))) return res.sendFile(join(ROOT, target));
  next();
});

// ── 정적 파일 (HTML/JS/CSS/icons/manifest 등) ────────────────
app.use(express.static(ROOT, { extensions: ["html"], index: "index.html" }));

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).send("Not Found"));

// ── 에러 핸들러(4-arg): 잘못된/과대 JSON 본문 등을 평문 대신 항상 JSON으로 (always-JSON 규칙) ──
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err && (err.status || err.statusCode) || 400;
  res.status(status).json({ ok: false, error: String((err && err.message) || err) });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Stella Clover (OCI) listening on :${PORT}`);
  bootTasks();
});

// ── 부팅 작업: 미완료 전사 잡 복구 + 일일 오디오 정리 스케줄 ──
// (DB/Drive 라이브러리 적재 실패해도 정적 서버는 계속 동작하도록 전부 dynamic import + try/catch.)
async function bootTasks() {
  // 1) 미완료 잡 인프로세스 재개 — 탭/서버 재시작과 무관하게 이어서 처리.
  //    부팅 시 1회 + 매시간 재실행: 부팅 시점 DB 미가동/일시 오류로 kick 이 드랍된 잡도
  //    다음 주기에 자동 재개된다(kick 은 멱등 — 실행 중인 잡은 무시).
  try {
    const { recover } = await import("./lib/jobs-runtime.js");
    await recover();
    setInterval(() => { recover().catch(() => {}); }, 60 * 60 * 1000);
  } catch (e) { console.warn("[boot] 잡 복구 스킵:", e && e.message); }

  // 1-b) CBO Review(스펙 생성/코드 리뷰) 잡 복구 — running으로 남은 좀비 잡은 failed 처리,
  //      queued로 남은 잡(아직 CLI 실행 전이라 유실 없음)은 재투입. 부팅 시 1회면 충분(재개형 아님).
  try {
    const { recover: recoverCboJobs } = await import("./lib/cbo-review/jobRuntime.js");
    await recoverCboJobs();
  } catch (e) { console.warn("[boot] CBO 잡 복구 스킵:", e && e.message); }

  // 2) 일일 오디오 정리(과거 Vercel Cron 0 18 * * * 대체). 다음 18:00 UTC에 첫 실행 후 24h 간격.
  scheduleDailyCleanup();

  // 3) 노트 목록 캐시(notes_meta) 증분 동기화 — Stella GPT 등 외부에서 Drive 를 직접 건드린
  //    변경분을 5분 간격으로 반영(전체 재스캔 아님, modifiedTime 증분만). 부팅 시 1회 + 5분 간격.
  scheduleNotesSync();
}

function runNotesSyncOnce() {
  Promise.all([import("./lib/notesSync.js"), import("./api/_drive.js")])
    .then(([{ incrementalSync }, { getDrive }]) => incrementalSync(getDrive()))
    .then(r => console.log(`[notes-sync] ${r.mode} count=${r.count}`))
    .catch(e => console.warn("[notes-sync] 실행 실패(무시, 다음 주기 재시도):", e && e.message));
}

function scheduleNotesSync() {
  const FIVE_MIN = 5 * 60 * 1000;
  runNotesSyncOnce();
  setInterval(runNotesSyncOnce, FIVE_MIN);
}

function runCleanupOnce() {
  import("./api/cleanup.js").then(({ default: handler }) => {
    const mockReq = { method: "POST", headers: { authorization: process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "" }, query: {} };
    const mockRes = {
      setHeader() {}, _s: 200,
      status(c) { this._s = c; return this; },
      json(o) { console.log("[cleanup]", this._s, JSON.stringify(o).slice(0, 200)); return this; },
      send(x) { console.log("[cleanup]", this._s, String(x).slice(0, 200)); return this; },
      end() {},
    };
    return handler(mockReq, mockRes);
  }).catch(e => console.warn("[cleanup] 실행 실패(무시):", e && e.message));
}

function scheduleDailyCleanup() {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(18, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setTime(next.getTime() + DAY);
  const delay = next.getTime() - now.getTime();
  setTimeout(() => { runCleanupOnce(); setInterval(runCleanupOnce, DAY); }, delay);
  console.log(`[boot] 오디오 정리 스케줄: ${Math.round(delay / 3600000)}h 후 첫 실행, 이후 24h 간격`);
}
