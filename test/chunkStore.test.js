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
const { saveChunk, readChunk, isLocalRef, cleanupOlderThan, deleteSession, sessionOfRefs, CHUNK_DIR, savePart, assembleSource, findSource } = mod;

test("sessionOfRefs: 첫 로컬 ref 에서 세션 아이디 추출(레거시/빈 값 방어)", () => {
  assert.equal(sessionOfRefs([{ id: "local:sessA/000.wav" }, { id: "local:sessA/001.wav" }]), "sessA");
  assert.equal(sessionOfRefs([{ id: "driveFileId123" }, { id: "local:sessB/000.wav" }]), "sessB"); // 레거시 뒤 로컬
  assert.equal(sessionOfRefs([{ id: "driveOnly" }]), null); // 로컬 ref 없음
  assert.equal(sessionOfRefs([]), null);
  assert.equal(sessionOfRefs(null), null);
});

test("deleteSession: 전사 완료 후 세션 청크 전량 즉시 삭제(OCI 용량 관리)", async () => {
  await saveChunk({ sessionId: "delme", index: 0, ext: ".wav", buffer: Buffer.from("a") });
  await saveChunk({ sessionId: "delme", index: 1, ext: ".wav", buffer: Buffer.from("b") });
  await saveChunk({ sessionId: "keep", index: 0, ext: ".wav", buffer: Buffer.from("c") });
  const n = await deleteSession("delme");
  assert.equal(n, 2, "delme 세션 2개 삭제");
  assert.ok(!fs.existsSync(path.join(CHUNK_DIR, "delme")), "삭제된 세션 폴더 없음");
  assert.ok(fs.existsSync(path.join(CHUNK_DIR, "keep")), "다른 세션은 유지");
});

test("deleteSession: 경로탈출/빈 세션은 거부(0 반환)", async () => {
  assert.equal(await deleteSession(""), 0);
  assert.equal(await deleteSession("../etc"), 0); // sanitize → 'etc' 폴더 없음 → 0 (탈출 안 됨)
  assert.equal(await deleteSession("없는세션999"), 0);
});

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

test("savePart + assembleSource: 파트를 순서대로 조립하고 parts 폴더는 삭제", async () => {
  await savePart({ sessionId: "asm1", index: 1, buffer: Buffer.from("BB") });
  await savePart({ sessionId: "asm1", index: 0, buffer: Buffer.from("AA") });
  await savePart({ sessionId: "asm1", index: 2, buffer: Buffer.from("CC") });
  const r = await assembleSource({ sessionId: "asm1", partsTotal: 3, ext: ".m4a" });
  assert.equal(r.bytes, 6);
  assert.ok(r.path.endsWith("source.m4a"));
  assert.equal(fs.readFileSync(r.path, "utf8"), "AABBCC", "순서대로 조립");
  assert.ok(!fs.existsSync(path.join(TMP, "asm1", "parts")), "parts 폴더 삭제됨");
  assert.equal(await findSource("asm1"), r.path, "findSource 로 재발견 가능(재시작 복구)");
});

test("assembleSource: 누락 파트는 명확한 에러 + 비허용 확장자는 .bin", async () => {
  await savePart({ sessionId: "asm2", index: 0, buffer: Buffer.from("A") });
  await assert.rejects(() => assembleSource({ sessionId: "asm2", partsTotal: 2, ext: ".m4a" }), /파트 누락/);
  const r = await assembleSource({ sessionId: "asm2", partsTotal: 1, ext: ".sh" });
  assert.ok(r.path.endsWith("source.bin"), "화이트리스트 밖 확장자는 .bin: " + r.path);
});

test("deleteSession: source/parts 하위 구조까지 통째 삭제(재귀)", async () => {
  await savePart({ sessionId: "asm3", index: 0, buffer: Buffer.from("A") });
  await saveChunk({ sessionId: "asm3", index: 0, ext: ".wav", buffer: Buffer.from("w") });
  const n = await deleteSession("asm3");
  assert.ok(n >= 2, "파트+청크 삭제: " + n);
  assert.ok(!fs.existsSync(path.join(TMP, "asm3")), "세션 폴더 삭제됨");
});

test("cleanupOlderThan: parts 하위 폴더가 있어도 세션 전체 mtime 기준으로 정리", async () => {
  await savePart({ sessionId: "oldparts", index: 0, buffer: Buffer.from("A") });
  const dir = path.join(TMP, "oldparts");
  const past = Date.now() - 20 * 24 * 60 * 60 * 1000;
  // 하위 파일까지 mtime 과거로
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, String(f));
    try { fs.utimesSync(p, new Date(past), new Date(past)); } catch (e) {}
  }
  const deleted = await cleanupOlderThan(10);
  assert.ok(deleted >= 1, "오래된 세션 정리: " + deleted);
  assert.ok(!fs.existsSync(dir), "세션 폴더(하위 포함) 삭제됨");
});
