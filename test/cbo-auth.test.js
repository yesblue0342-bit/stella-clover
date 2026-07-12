import test from "node:test";
import assert from "node:assert/strict";

process.env.CBO_ACCESS_PW = "test-password-long";
const { login, verifyToken } = await import("../lib/cbo-review/auth.js");

test("올바른 비밀번호로만 만료시간이 있는 서명 토큰을 발급한다", () => {
  const token = login("test-password-long");
  assert.equal(verifyToken(`Bearer ${token}`), true);
  assert.equal(verifyToken(`${token}x`), false);
  assert.throws(() => login("wrong-password"), /올바르지/);
});
