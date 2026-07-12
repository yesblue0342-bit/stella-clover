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

export function requireAuth(req, res) {
  if (verifyToken(req.headers.authorization)) return true;
  res.status(401).json({ ok: false, message: "CBO 로그인 후 이용하세요." });
  return false;
}
