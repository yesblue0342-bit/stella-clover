// lib/cbo-precheck/auth.js — 개인용 접근 게이트(HMAC 서명 토큰, 서버 세션 저장 없음).
//
// 미션 문서에는 명시되지 않았지만, 이 모듈은 임의 GitHub repo SSH clone + GITHUB_TOKEN으로 branch/PR
// 생성 + ANTHROPIC_API_KEY 과금 호출을 트리거할 수 있어 인증 없이 인터넷에 노출하면 위험하다(비용/오남용).
// 같은 위험 프로필을 가진 기존 "CBO Spec & Code Review"(lib/cbo-review/auth.js)가 이미
// `CBO_ACCESS_PW` 게이트를 쓰고 있으므로, 같은 시크릿을 재사용한다(절대 규칙 2: 신규 API 키 발급 금지,
// 기존 인프라 재사용) — lib/cbo-review 파일을 import/수정하지 않고 동일 패턴을 독립 구현한다.
import crypto from "node:crypto";

const TTL_MS = 24 * 60 * 60 * 1000;

function secret() {
  return process.env.CBO_ACCESS_PW || "";
}

function sign(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function login(password) {
  const configured = secret();
  if (!configured) throw new Error("CBO_ACCESS_PW가 설정되지 않았습니다.");
  const given = Buffer.from(String(password || ""));
  const wanted = Buffer.from(configured);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) throw new Error("비밀번호가 올바르지 않습니다.");
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TTL_MS, nonce: crypto.randomUUID() })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(value) {
  if (!secret()) return false;
  const token = String(value || "").replace(/^Bearer\s+/i, "");
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(sign(payload));
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp > Date.now(); }
  catch { return false; }
}

export function hasAccessPassword() {
  return Boolean(secret());
}

export function requireAuth(req, res) {
  if (!hasAccessPassword()) return true;
  if (verifyToken(req.headers.authorization)) return true;
  res.status(401).json({ ok: false, message: "CBO Pre-Check 로그인 후 이용하세요." });
  return false;
}
