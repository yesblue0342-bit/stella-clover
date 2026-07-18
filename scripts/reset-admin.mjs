#!/usr/bin/env node
// scripts/reset-admin.mjs — 오너/관리자 비밀번호 강제 재설정(로그인 못해도 복구되는 안전망).
//
// 언제: 관리자(yesblue0342/admin)가 비밀번호를 잊었거나 로그인 게이트에 갇혔을 때.
//   앱 로그인 없이 서버에서 직접 DB 를 갱신하므로 어떤 락아웃 상태에서도 복구된다.
//
// 사용(OCI 서버, .env 가 주입된 컨테이너 안):
//   docker exec stella-clover node scripts/reset-admin.mjs <아이디> <새비밀번호>
//   예) docker exec stella-clover node scripts/reset-admin.mjs yesblue0342 'MyNewStrongPw!'
//
// 동작: 대상 계정을 upsert 로 role=admin·status=approved 로 만들고 비밀번호를 새 값으로 설정,
//   기존 세션을 전부 무효화한다. (계정이 없으면 새로 관리자 계정으로 생성)
import { getPool } from "../api/_db.js";
import { ensureAuthSchema, hashPassword, normUsername, MAX_PW_LEN } from "../api/_auth.js";

const username = normUsername(process.argv[2]);
const newpw = String(process.argv[3] || "");

if (!username || newpw.length < 4 || newpw.length > MAX_PW_LEN) {
  console.error("사용법: node scripts/reset-admin.mjs <아이디(3~32자 영숫자._-)> <새비밀번호(4~256자)>");
  process.exit(1);
}

try {
  const pool = await getPool();
  await ensureAuthSchema(pool._pg || pool);
  // upsert: 있으면 비번/역할/상태 갱신, 없으면 관리자 계정으로 생성.
  await pool._pg.query(
    `INSERT INTO cl_users (username, pw_hash, role, status, display_name, approved_at, approved_by)
     VALUES ($1,$2,'admin','approved',$1, now(), 'reset-script')
     ON CONFLICT (username) DO UPDATE
       SET pw_hash=EXCLUDED.pw_hash, role='admin', status='approved', approved_at=now(), approved_by='reset-script'`,
    [username, hashPassword(newpw)]
  );
  await pool._pg.query(`DELETE FROM cl_sessions WHERE username=$1`, [username]);
  console.log(`✅ '${username}' 비밀번호를 재설정하고 관리자·승인 상태로 만들었습니다. 기존 로그인은 모두 해제됐습니다.`);
  process.exit(0);
} catch (e) {
  console.error("❌ 재설정 실패:", e && e.message || e);
  process.exit(1);
}
