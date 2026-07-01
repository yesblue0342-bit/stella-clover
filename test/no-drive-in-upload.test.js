// 회귀 가드: 청크 업로드 경로가 다시 Google Drive 로 회귀하지 못하게 소스 정적 검사.
//
// 왜: "구간 N 업로드 실패: 청크 업로드 실패: invalid_client" 는 과거 chunk-upload 가 청크를
//     Google Drive 에 올리다 OAuth(client_id/secret/refresh_token) 거절(invalid_client)로 전사가
//     통째로 막히던 회귀다. 로컬 디스크 저장(lib/chunkStore)으로 해소했으나 반복적으로 재발했다.
//     → 업로드 핸들러가 Drive 를 import/호출하면 테스트가 실패해 재발을 즉시 차단한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("api/chunk-upload.js 는 Google Drive 를 import/사용하지 않는다(로컬 저장 전용)", () => {
  const src = read("api/chunk-upload.js");
  // 주석은 허용하되(설명용), 실제 코드에서 Drive 를 부르는 토큰은 금지.
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/from\s+["'][^"']*_drive/.test(code), "chunk-upload 에서 _drive import 금지");
  assert.ok(!/getDrive\s*\(/.test(code), "chunk-upload 에서 getDrive() 호출 금지");
  assert.ok(!/ensurePath|uploadBuffer|uploadText|drive\.files/.test(code), "chunk-upload 에서 Drive API 호출 금지");
  assert.ok(/saveChunk/.test(code), "chunk-upload 는 lib/chunkStore.saveChunk 로 로컬 저장해야 함");
});

test("chunk-upload 는 실패해도 항상 JSON(ok:false) 을 반환한다(평문 금지)", () => {
  const src = read("api/chunk-upload.js");
  assert.ok(/application\/json/.test(src), "Content-Type application/json 설정 필요");
  assert.ok(/ok:\s*false/.test(src), "에러 시 ok:false JSON 반환 필요");
  // invalid_client 를 사용자에게 직접 던지던 옛 메시지 문자열이 남아있지 않아야 한다.
  assert.ok(!/청크 업로드 실패/.test(src), "옛 Drive 업로드 에러 문구('청크 업로드 실패') 잔존 금지");
});

test("lib/jobs-runtime.js 는 로컬 ref 를 우선 처리한다(레거시 Drive 는 폴백만)", () => {
  const src = read("lib/jobs-runtime.js");
  assert.ok(/isLocalRef\s*\(/.test(src), "isLocalRef 로 로컬/레거시 분기 필요");
  assert.ok(/readChunk\s*\(/.test(src), "로컬 청크는 readChunk 로 디스크에서 읽어야 함");
});
