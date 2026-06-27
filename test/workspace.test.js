// Stella Clover — 워크스페이스 소유권 스코프 + 워치독 회귀 가드.
// DB 없이 검증: 보안 불변식(모든 id 기반 read/write가 user_id 로 스코프됨)을 소스에서 고정.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ws = readFileSync(new URL("../api/workspace.js", import.meta.url), "utf8");
const cl = readFileSync(new URL("../api/cleanup.js", import.meta.url), "utf8");

test("소유권 스코프: id 기반 SELECT/UPDATE 는 user_id=@u 동반", () => {
  assert.match(ws, /SELECT \* FROM ws_sessions WHERE id=@id AND user_id=@u/);          // 세션 조회
  assert.ok(ws.includes("WHERE id=@id AND user_id=@u")); // 공통
  assert.match(ws, /UPDATE ws_sessions SET messages=@msgs[^]*WHERE id=@id AND user_id=@u/); // chat 저장
  assert.match(ws, /UPDATE ws_sessions SET title=@t, updated_at=now\(\) WHERE id=@id AND user_id=@u/); // 세션 제목
  assert.match(ws, /UPDATE ws_notes SET title=@t, content=@c, updated_at=now\(\) WHERE id=@id AND user_id=@u/); // 노트
});

test("소유권 스코프: id 기반 액션은 user 필수 가드", () => {
  const guards = (ws.match(/'id, user required'/g) || []).length;
  assert.ok(guards >= 3, `id+user 필수 가드 ≥3 (session/update_session/update_note), 실제 ${guards}`);
});

test("소유권 스코프: 위험한 무방비 패턴(WHERE id=@id 단독, user_id 없이) 부재", () => {
  // ws_sessions/ws_notes 를 id 단독으로 건드리는 쿼리가 없어야 함(delete_* 는 user_id 포함).
  const bad = ws.match(/FROM ws_(sessions|notes) WHERE id=@id(?! AND user_id)/g) || [];
  assert.deepEqual(bad, [], "id 단독 접근 쿼리가 남아있음: " + bad.join(" | "));
});

test("cleanup: 멈춘 전사 잡 워치독 포함", () => {
  assert.match(cl, /transcribe_jobs/);
  assert.match(cl, /\/api\/worker/);
  assert.match(cl, /status IN \('processing','summarizing'\)/);
});

test("전역 검색: 채팅(제목+메시지)·노트(제목+내용) 모두 + user_id 스코프", () => {
  assert.match(ws, /action === 'search'/);
  // 채팅: 제목 + 메시지 내용 검색, 본인 스코프
  assert.match(ws, /FROM ws_sessions\s+WHERE user_id=@u AND \(title ILIKE @q OR messages ILIKE @q\)/);
  // 노트: 제목 + 내용 검색, 본인 스코프
  assert.match(ws, /FROM ws_notes\s+WHERE user_id=@u AND \(title ILIKE @q OR content ILIKE @q\)/);
  // 검색도 user 필수
  assert.match(ws, /action === 'search'[^]*?if \(!user\) return err/);
});
