// api/_auth.js — 인증/인가 공유 코어 (회원가입 승인제 + 세션 + 사용자별 컨텐츠 분리).
//
// 왜: Stella Clover 는 회원 시스템이 없어 누구나 접속·열람 가능했다(특히 CBO 화면은 개인 API 키에 연결).
//   → 승인제 회원가입(yesblue0342 가 승인해야 접속) + 로그인 세션 + 컨텐츠 owner 분리를 도입한다.
//   비밀번호는 평문 저장 금지(PBKDF2 해시+솔트). 세션은 DB 저장(취소 가능, 시크릿 없이 동작).
//
// 언더스코어 파일명 → server.mjs 라우터가 /api 로 노출하지 않음(공유 모듈).
import crypto from "crypto";
import { getPool, sql } from "./_db.js";

export const COOKIE_NAME = "clover_sid";
const SESSION_DAYS = 30;
const PBKDF2_ITER = 600000;       // OWASP 2023 권고(PBKDF2-HMAC-SHA256). 로그인은 드물어 동기 비용 허용.
export const MAX_PW_LEN = 256;    // pbkdf2 입력 상한(초장문 비번으로 이벤트루프 blocking DoS 방지)

// ── 스키마 + 관리자 시드 (멱등) ────────────────────────────────
// 관리자 2명: admin / yesblue0342 (둘 다 비밀번호 admin, 승인 완료). yesblue0342 는 승인자·기존데이터 소유자.
let _authReady = false;
export async function ensureAuthSchema(pgPool) {
  if (_authReady) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS cl_users (
      username TEXT PRIMARY KEY,
      pw_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',        -- 'admin' | 'user'
      status TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'approved' | 'rejected'
      display_name TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      approved_at TIMESTAMPTZ,
      approved_by TEXT
    );
    CREATE TABLE IF NOT EXISTS cl_sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cl_sessions_username ON cl_sessions (username);
  `);
  // 관리자 시드 — 이미 있으면 건드리지 않음(비번 변경분 보존).
  for (const u of ["admin", "yesblue0342"]) {
    await pgPool.query(
      `INSERT INTO cl_users (username, pw_hash, role, status, display_name, approved_at, approved_by)
       VALUES ($1,$2,'admin','approved',$3, now(), 'system')
       ON CONFLICT (username) DO NOTHING`,
      [u, hashPassword("admin"), u]
    );
  }
  _authReady = true;
}

// ── 비밀번호 해시(PBKDF2-SHA256) ───────────────────────────────
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(pw), salt, PBKDF2_ITER, 32, "sha256").toString("hex");
  return `pbkdf2$${PBKDF2_ITER}$${salt}$${hash}`;
}
export function verifyPassword(pw, stored) {
  try {
    const [algo, iterStr, salt, hash] = String(stored || "").split("$");
    if (algo !== "pbkdf2" || !salt || !hash) return false;
    const iter = parseInt(iterStr, 10) || PBKDF2_ITER;
    const got = crypto.pbkdf2Sync(String(pw), salt, iter, 32, "sha256").toString("hex");
    const a = Buffer.from(got, "hex"), b = Buffer.from(hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

// username 규칙: 3~32자 영숫자/._- (소문자화). 반환 정규화값 또는 null.
export function normUsername(raw) {
  const u = String(raw || "").trim().toLowerCase();
  return /^[a-z0-9._-]{3,32}$/.test(u) ? u : null;
}

// ── 세션 ───────────────────────────────────────────────────────
export async function createSession(pool, username) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await pool.request()
    .input("t", sql.NVarChar(128), token)
    .input("u", sql.NVarChar(64), username)
    .input("e", sql.NVarChar(64), expires.toISOString())
    .query(`INSERT INTO cl_sessions (token, username, expires_at) VALUES (@t,@u,@e::timestamptz)`);
  return { token, expires };
}
export async function deleteSession(pool, token) {
  if (!token) return;
  try { await pool.request().input("t", sql.NVarChar(128), token).query(`DELETE FROM cl_sessions WHERE token=@t`); } catch (e) { /* ignore */ }
}
// 사용자의 모든 세션 파기(비밀번호 변경 시 — 탈취 세션 무효화).
export async function deleteUserSessions(pool, username) {
  try { await pool.request().input("u", sql.NVarChar(64), username).query(`DELETE FROM cl_sessions WHERE username=@u`); } catch (e) { /* ignore */ }
}

// 요청 쿠키에서 세션 토큰 추출(HttpOnly 쿠키 clover_sid).
export function tokenFromReq(req) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k === COOKIE_NAME) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// 현재 요청의 인증 사용자(승인된 계정만). 반환 { username, role, status } 또는 null.
// 만료 세션은 무시(그리고 정리). DB 오류 시 null(게이트가 401 처리).
export async function getUser(req, pool) {
  const token = tokenFromReq(req);
  if (!token) return null;
  try {
    const r = await pool.request().input("t", sql.NVarChar(128), token).query(`
      SELECT u.username, u.role, u.status, s.expires_at
      FROM cl_sessions s JOIN cl_users u ON u.username = s.username
      WHERE s.token=@t`);
    const row = r.recordset[0];
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) { await deleteSession(pool, token); return null; }
    if (row.status !== "approved") return null;
    return { username: row.username, role: row.role, status: row.status };
  } catch (e) { return null; }
}

export function isAdmin(user) { return !!(user && user.role === "admin"); }

// 요청이 https(브라우저↔프록시)로 들어왔는지 — NPM 프록시가 X-Forwarded-Proto 를 세팅한다.
//  https 면 Secure 쿠키(https 로만 전송)로 탈취 위험↓, 직접 http(IP:8971) 접근 시엔 생략해 락아웃 방지.
export function isHttps(req) {
  const xf = String((req.headers && req.headers["x-forwarded-proto"]) || "").toLowerCase();
  return xf.split(",")[0].trim() === "https";
}
// Set-Cookie 헤더 값 구성(HttpOnly, SameSite=Lax, 30일, https 면 Secure).
export function sessionCookie(token, expires, secure) {
  const exp = expires ? new Date(expires).toUTCString() : new Date(0).toUTCString();
  return `${COOKIE_NAME}=${encodeURIComponent(token || "")}; Path=/; HttpOnly; SameSite=Lax; Expires=${exp}${secure ? "; Secure" : ""}`;
}
export function clearCookie(secure) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(0).toUTCString()}${secure ? "; Secure" : ""}`;
}
