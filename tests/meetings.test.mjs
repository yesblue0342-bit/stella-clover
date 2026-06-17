// 이력 엔드포인트 통합 테스트 (네트워크/DB 불필요)
// 핵심 인수 조건: 엔드포인트가 어떤 경우에도 valid JSON 을 반환한다.
import assert from "node:assert";

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log("  ✓ " + name); })
    .catch(e => { fail++; console.log("  ✗ " + name + "\n      " + e.message); });
}

// 핸들러 응답을 캡처하는 가짜 res
function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }
  };
}

console.log("meetings.js 엔드포인트");

// DB 환경변수가 없는 환경(테스트 기본값)에서는 실패 경로를 타지만
// 반드시 valid JSON({ok:false, items:[]})을 반환해야 한다.
const { default: handler } = await import("../api/meetings.js");

await test("DB 미설정 시에도 valid JSON 반환 (ok:false, items 배열, message 존재)", async () => {
  delete process.env.CL_DB_SV; delete process.env.CL_DB_USR; delete process.env.CL_DB_PW;
  const res = mockRes();
  await handler({ query: {} }, res);
  assert.strictEqual(typeof res.body, "object", "body는 객체여야 함");
  assert.strictEqual(res.body.ok, false);
  assert.ok(Array.isArray(res.body.items), "items는 배열");
  assert.ok(typeof res.body.message === "string" && res.body.message.length, "사람이 읽을 message");
  // 직렬화 가능한(=valid) JSON 인지 확인
  JSON.parse(JSON.stringify(res.body));
});

await test("Content-Type 을 application/json 으로 설정", async () => {
  const res = mockRes();
  await handler({ query: {} }, res);
  assert.match(res.headers["content-type"] || "", /application\/json/);
});

await test("detail 액션도 JSON 반환 (잘못된 id → ok:false)", async () => {
  process.env.CL_DB_SV = "x"; process.env.CL_DB_USR = "x"; process.env.CL_DB_PW = "x";
  const res = mockRes();
  await handler({ query: { action: "detail", id: "notanumber" } }, res);
  assert.strictEqual(res.body.ok, false);
  JSON.parse(JSON.stringify(res.body));
  delete process.env.CL_DB_SV; delete process.env.CL_DB_USR; delete process.env.CL_DB_PW;
});

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
