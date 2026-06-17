// 프론트 에러 처리 테스트: 비-JSON 응답을 받아도 크래시 없이 메시지 표시.
// index.html 에 실제로 들어있는 safeJson 함수를 그대로 추출해서 검증한다(이중 관리 방지).
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "..", "index.html"), "utf-8");

// async function safeJson(r){ ... } 블록 추출
const m = html.match(/async function safeJson\(r\)\{[\s\S]*?\n\}/);
if (!m) { console.log("safeJson 함수를 index.html 에서 찾지 못함"); process.exit(1); }
const safeJson = eval("(" + m[0].replace(/^async function safeJson/, "async function") + ")");

// 가짜 fetch Response
function res(text, status = 200) {
  return { status, text: async () => text };
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + e.message); }
}

console.log("safeJson (프론트 방어적 파싱)");

await test("정상 JSON 배열 응답을 그대로 파싱", async () => {
  const d = await safeJson(res(JSON.stringify({ ok: true, items: [{ id: 1 }] })));
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.items.length, 1);
});

await test("비-JSON 평문('An error o...')에도 크래시 없이 메시지 반환", async () => {
  const d = await safeJson(res("An error occurred with your deployment", 500));
  assert.strictEqual(d.ok, false);
  assert.ok(Array.isArray(d.items) && d.items.length === 0, "items 빈 배열");
  assert.match(d.message, /An error occurred/);
});

await test("HTML 에러 페이지의 태그를 제거하고 사람이 읽을 메시지로", async () => {
  const d = await safeJson(res("<html><body>502 Bad Gateway</body></html>", 502));
  assert.strictEqual(d.ok, false);
  assert.ok(!d.message.includes("<"), "태그가 제거되어야 함");
  assert.match(d.message, /Bad Gateway/);
});

await test("빈 본문이면 상태코드 기반 메시지", async () => {
  const d = await safeJson(res("", 504));
  assert.strictEqual(d.ok, false);
  assert.match(d.message, /504/);
});

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
