import test from "node:test";
import assert from "node:assert/strict";

process.env.CBO_ACCESS_PW = "test-password-long";
const { login, verifyToken, hasAccessPassword } = await import("../lib/cbo-precheck/auth.js");
const handler = (await import("../api/cbo-precheck.js")).default;

function mockRes() {
  const res = { _status: 200, setHeader() {}, status(c) { this._status = c; return this; }, json(o) { this._body = o; return this; } };
  return res;
}

test("올바른 비밀번호로만 만료시간이 있는 서명 토큰을 발급한다", () => {
  assert.equal(hasAccessPassword(), true);
  const token = login("test-password-long");
  assert.equal(verifyToken(`Bearer ${token}`), true);
  assert.equal(verifyToken(`${token}x`), false);
  assert.throws(() => login("wrong-password"), /올바르지/);
});

test("CBO_ACCESS_PW 설정 시 로그인 없이 scan/capabilities 등은 401을 반환한다", async () => {
  const res = mockRes();
  await handler({ method: "GET", query: { action: "capabilities" }, headers: {}, body: {} }, res);
  assert.equal(res._status, 401);
});

test("올바른 토큰으로는 인증을 통과한다(capabilities 정상 응답)", async () => {
  const token = login("test-password-long");
  const res = mockRes();
  await handler({ method: "GET", query: { action: "capabilities" }, headers: { authorization: `Bearer ${token}` }, body: {} }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
});

test("action=login: 잘못된 비밀번호는 401 JSON", async () => {
  const res = mockRes();
  await handler({ method: "POST", query: { action: "login" }, headers: {}, body: { password: "wrong" } }, res);
  assert.equal(res._status, 401);
});
