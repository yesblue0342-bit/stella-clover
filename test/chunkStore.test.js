// lib/chunkStore.js — 로컬 청크 저장/읽기 + 경로탈출 방어 회귀.
// (Drive invalid_client 회귀 해소: 청크를 Drive 대신 로컬 디스크에 저장하는 모듈)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// 테스트 전용 임시 CHUNK_DIR 을 환경변수로 지정한 뒤 동적 import(모듈 로드시 CHUNK_DIR 고정).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clover-chunk-"));
process.env.CHUNK_DIR = TMP;
const mod = await import("../lib/chunkStore.js");
const { saveChunk, readChunk, isLocalRef, cleanupOlderThan, CHUNK_DIR } = mod;

test("CHUNK_DIR 은 환경변수를 따른다", () => {
  assert.equal(CHUNK_DIR, TMP);
});

test("saveChunk → ref 포맷 'local:<sess>/<NNN><ext>' + round-trip 읽기", async () => {
  const buf = Buffer.from("hello-audio");
  const id = await saveChunk({ sessionId: "sess_AB-1", index: 2, ext: ".wav", buffer: buf });
  assert.ok(isLocalRef(id), "local: 접두사");
  assert.equal(id, "local:sess_AB-1/002.wav");
  const back = await readChunk(id);
  assert.deepEqual(back, buf);
});

test("saveChunk: 비허용 확장자/세션은 안전화", async () => {
  const id = await saveChunk({ sessionId: "../../etc", index: 0, ext: ".sh", buffer: Buffer.from("x") });
  // 슬래시/점만 남기는 게 아니라 영숫자/._- 만 허용 → "....etc" 형태로 무해화, ext 화이트리스트 밖 → .wav
  assert.match(id, /^local:[A-Za-z0-9_.-]+\/000\.wav$/);
  assert.ok(!id.includes("/etc/"), "경로 탈출 세그먼트 없음");
});

test("readChunk: 경로 탈출 ref 거부", async () => {
  await assert.rejects(() => readChunk("local:../../../etc/passwd"), /범위|잘못된|ref/);
  await assert.rejects(() => readChunk("not-a-local-ref"), /로컬 청크 ref/);
});

test("isLocalRef: 레거시 Drive id(순수 파일 id)는 false", () => {
  assert.equal(isLocalRef("1AbCdEf_DriveFileId"), false);
  assert.equal(isLocalRef("local:sess/000.wav"), true);
  assert.equal(isLocalRef(null), false);
});

test("cleanupOlderThan: 오래된 파일만 삭제(보존기간 내 파일 유지)", async () => {
  const id = await saveChunk({ sessionId: "old", index: 0, ext: ".wav", buffer: Buffer.from("old") });
  const rel = id.slice("local:".length);
  const abs = path.join(TMP, rel);
  // mtime 을 20일 전으로 되돌림
  const past = Date.now() - 20 * 24 * 60 * 60 * 1000;
  fs.utimesSync(abs, new Date(past), new Date(past));
  const fresh = await saveChunk({ sessionId: "new", index: 0, ext: ".wav", buffer: Buffer.from("new") });
  const deleted = await cleanupOlderThan(10);
  assert.ok(deleted >= 1, "오래된 파일 1개 이상 삭제");
  assert.ok(!fs.existsSync(abs), "오래된 파일 삭제됨");
  assert.ok(fs.existsSync(path.join(TMP, fresh.slice("local:".length))), "최근 파일 유지");
});
