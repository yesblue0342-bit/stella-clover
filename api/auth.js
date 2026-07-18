// api/auth.js — 인증 엔드포인트 (게이트 예외: 로그인 전에도 접근 가능한 유일한 /api 경로).
//   POST ?action=signup  {username,password}         → 가입 신청(status=pending, 관리자 승인 대기)
//   POST ?action=login   {username,password}         → 승인된 계정만 로그인 → 세션 쿠키
//   POST ?action=logout                              → 세션 파기 + 쿠키 삭제
//   GET  ?action=me                                  → 현재 로그인 사용자(없으면 authed:false)
//   POST ?action=password {current,next}             → 본인 비밀번호 변경(관리자 기본 비번 교체용)
//   [관리자 전용]
//   GET  ?action=pending                             → 승인 대기 목록
//   GET  ?action=users                               → 전체 사용자 목록
//   POST ?action=approve {username}                  → 승인
//   POST ?action=reject  {username}                  → 거부(계정 삭제)
// 항상 JSON. 관리자 액션은 요청자가 admin 세션인지 검증(그렇지 않으면 403).
import { getPool, sql, hasDbConfig } from "./_db.js";
import {
  ensureAuthSchema, hashPassword, verifyPassword, normUsername,
  createSession, deleteSession, deleteUserSessions, tokenFromReq, getUser, isAdmin,
  sessionCookie, clearCookie, isHttps, MAX_PW_LEN,
} from "./_auth.js";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (!hasDbConfig()) return res.status(200).json({ ok: false, message: "DB 환경변수 미설정" });

  const action = String(req.query.action || "");
  try {
    const pool = await getPool();
    await ensureAuthSchema(pool._pg || pool); // ensureAuthSchema 는 pg.Pool 을 받는다(멀티스테이트먼트 DDL)

    // ── 현재 사용자 ──
    if (action === "me") {
      const u = await getUser(req, pool);
      return res.status(200).json({ ok: true, authed: !!u, user: u });
    }

    // ── 회원가입(승인 대기) ──
    if (action === "signup" && req.method === "POST") {
      const b = req.body || {};
      const username = normUsername(b.username);
      const password = String(b.password || "");
      if (!username) return res.status(200).json({ ok: false, message: "아이디는 3~32자 영문/숫자/._- 만 가능합니다." });
      if (password.length < 4 || password.length > MAX_PW_LEN) return res.status(200).json({ ok: false, message: "비밀번호는 4~256자여야 합니다." });
      const exists = await pool.request().input("u", sql.NVarChar(64), username)
        .query(`SELECT 1 FROM cl_users WHERE username=@u`);
      if (exists.recordset.length) return res.status(200).json({ ok: false, message: "이미 사용 중인 아이디입니다." });
      await pool.request()
        .input("u", sql.NVarChar(64), username)
        .input("h", sql.NVarChar(256), hashPassword(password))
        .input("d", sql.NVarChar(64), String(b.displayName || username).slice(0, 64))
        .query(`INSERT INTO cl_users (username, pw_hash, role, status, display_name) VALUES (@u,@h,'user','pending',@d)`);
      return res.status(200).json({ ok: true, pending: true, message: "가입 신청 완료 — 관리자(yesblue0342) 승인 후 로그인할 수 있습니다." });
    }

    // ── 로그인 ──
    if (action === "login" && req.method === "POST") {
      const b = req.body || {};
      const username = normUsername(b.username);
      const password = String(b.password || "").slice(0, MAX_PW_LEN + 1);
      if (!username) return res.status(200).json({ ok: false, message: "아이디 또는 비밀번호가 올바르지 않습니다." });
      const r = await pool.request().input("u", sql.NVarChar(64), username)
        .query(`SELECT username, pw_hash, role, status FROM cl_users WHERE username=@u`);
      const row = r.recordset[0];
      // 사용자 부재/비번 불일치 모두 동일 메시지(계정 존재 여부 노출 방지)
      if (!row || !verifyPassword(password, row.pw_hash)) {
        return res.status(200).json({ ok: false, message: "아이디 또는 비밀번호가 올바르지 않습니다." });
      }
      if (row.status === "pending") return res.status(200).json({ ok: false, pending: true, message: "아직 승인 대기 중입니다. 관리자(yesblue0342) 승인 후 이용할 수 있습니다." });
      if (row.status !== "approved") return res.status(200).json({ ok: false, message: "이 계정은 접근이 거부되었습니다." });
      const { token, expires } = await createSession(pool, username);
      res.setHeader("Set-Cookie", sessionCookie(token, expires, isHttps(req)));
      return res.status(200).json({ ok: true, user: { username: row.username, role: row.role } });
    }

    // ── 로그아웃 (CSRF 강제 로그아웃 방지: POST 만 허용) ──
    if (action === "logout") {
      if (req.method !== "POST") return res.status(200).json({ ok: false, message: "POST only" });
      await deleteSession(pool, tokenFromReq(req));
      res.setHeader("Set-Cookie", clearCookie(isHttps(req)));
      return res.status(200).json({ ok: true });
    }

    // ── 본인 비밀번호 변경 (기본 관리자 비번 admin 교체용) ──
    if (action === "password" && req.method === "POST") {
      const u = await getUser(req, pool);
      if (!u) return res.status(200).json({ ok: false, authRequired: true, message: "로그인이 필요합니다." });
      const b = req.body || {};
      const next = String(b.next || "");
      if (next.length < 4 || next.length > MAX_PW_LEN) return res.status(200).json({ ok: false, message: "새 비밀번호는 4~256자여야 합니다." });
      const r = await pool.request().input("u", sql.NVarChar(64), u.username).query(`SELECT pw_hash FROM cl_users WHERE username=@u`);
      if (!r.recordset[0] || !verifyPassword(String(b.current || "").slice(0, MAX_PW_LEN + 1), r.recordset[0].pw_hash)) {
        return res.status(200).json({ ok: false, message: "현재 비밀번호가 올바르지 않습니다." });
      }
      await pool.request().input("u", sql.NVarChar(64), u.username).input("h", sql.NVarChar(256), hashPassword(next))
        .query(`UPDATE cl_users SET pw_hash=@h WHERE username=@u`);
      // 기존 세션 전부 무효화(탈취 세션 제거) 후 현재 사용자에게 새 세션 발급.
      await deleteUserSessions(pool, u.username);
      const s = await createSession(pool, u.username);
      res.setHeader("Set-Cookie", sessionCookie(s.token, s.expires, isHttps(req)));
      return res.status(200).json({ ok: true, message: "비밀번호가 변경되었습니다. 다른 기기의 로그인은 해제되었습니다." });
    }

    // ── 관리자 전용 ──────────────────────────────────────────────
    const me = await getUser(req, pool);
    if (["pending", "users", "approve", "reject"].includes(action)) {
      if (!isAdmin(me)) return res.status(200).json({ ok: false, message: "관리자만 사용할 수 있습니다.", authRequired: !me });

      if (action === "pending") {
        const r = await pool.request().query(`SELECT username, display_name, created_at FROM cl_users WHERE status='pending' ORDER BY created_at ASC`);
        return res.status(200).json({ ok: true, users: r.recordset || [] });
      }
      if (action === "users") {
        const r = await pool.request().query(`SELECT username, display_name, role, status, created_at, approved_at, approved_by FROM cl_users ORDER BY created_at ASC`);
        return res.status(200).json({ ok: true, users: r.recordset || [] });
      }
      if (action === "approve" && req.method === "POST") {
        const target = normUsername((req.body || {}).username);
        if (!target) return res.status(200).json({ ok: false, message: "잘못된 아이디" });
        const r = await pool.request().input("u", sql.NVarChar(64), target).input("by", sql.NVarChar(64), me.username)
          .query(`UPDATE cl_users SET status='approved', approved_at=now(), approved_by=@by WHERE username=@u AND status<>'approved'`);
        return res.status(200).json({ ok: true, updated: (r.rowsAffected && r.rowsAffected[0]) || 0 });
      }
      if (action === "reject" && req.method === "POST") {
        const target = normUsername((req.body || {}).username);
        if (!target) return res.status(200).json({ ok: false, message: "잘못된 아이디" });
        if (target === "admin" || target === "yesblue0342") return res.status(200).json({ ok: false, message: "관리자 계정은 거부/삭제할 수 없습니다." });
        await pool.request().input("u", sql.NVarChar(64), target).query(`DELETE FROM cl_sessions WHERE username=@u`);
        await pool.request().input("u", sql.NVarChar(64), target).query(`DELETE FROM cl_users WHERE username=@u`);
        return res.status(200).json({ ok: true });
      }
    }

    return res.status(200).json({ ok: false, message: "알 수 없는 요청" });
  } catch (e) {
    return res.status(200).json({ ok: false, message: "인증 처리 오류: " + e.message });
  }
}
