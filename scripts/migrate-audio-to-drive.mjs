#!/usr/bin/env node
// scripts/migrate-audio-to-drive.mjs — OCI 로컬 디스크에 남아 있는 음성 파일을 Google Drive 보관 폴더로 이전.
//
// 사용법(OCI 서버, 컨테이너 안 또는 .env 로드된 쉘에서):
//   node scripts/migrate-audio-to-drive.mjs            # ① 드라이런: 목록 + 총 용량만 보고(기본값, 아무것도 안 옮김)
//   node scripts/migrate-audio-to-drive.mjs --apply    # ② 실제 이전: Drive 업로드 성공 확인 후 로컬 삭제
//
// 도커 예:
//   docker exec stella-clover node scripts/migrate-audio-to-drive.mjs
//   docker exec stella-clover node scripts/migrate-audio-to-drive.mjs --apply
//
// 동작:
//   · CHUNK_DIR(기본 /app/data/chunks) 의 세션 폴더들을 스캔해 파일 목록/크기를 보고한다.
//   · --apply 시: 진행 중 잡(transcribe_jobs 비종료 상태)의 세션은 건드리지 않고,
//     나머지 파일을 Drive 보관 폴더(DRIVE_AUDIO_FOLDER_ID) 아래 legacy/<세션>/ 에 업로드한다.
//     업로드 성공(파일 id 확인) 후에만 로컬 파일을 삭제한다. 실패한 파일은 보존하고 목록에 남긴다.
import fs from "fs";
import path from "path";
import { CHUNK_DIR } from "../lib/chunkStore.js";
import { getDrive, uploadFileStream } from "../api/_drive.js";
import { AUDIO_DRIVE_FOLDER_ID } from "../lib/jobs-runtime.js";
import { getPool, hasDbConfig } from "../api/_db.js";

const APPLY = process.argv.includes("--apply");

const MIME = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm", ".ogg": "audio/ogg", ".aac": "audio/aac", ".wav": "audio/wav" };

function fmtMB(b) { return (b / 1024 / 1024).toFixed(2) + "MB"; }

async function listAll() {
  const sessions = [];
  let entries;
  try { entries = await fs.promises.readdir(CHUNK_DIR, { withFileTypes: true }); }
  catch (e) { return sessions; }
  for (const s of entries) {
    if (!s.isDirectory()) continue;
    const dir = path.join(CHUNK_DIR, s.name);
    const files = [];
    const walk = async (d) => {
      for (const e of await fs.promises.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else files.push({ path: p, size: (await fs.promises.stat(p)).size });
      }
    };
    try { await walk(dir); } catch (e) { /* 세션 스캔 실패는 건너뜀 */ }
    sessions.push({ name: s.name, dir, files, bytes: files.reduce((a, f) => a + f.size, 0) });
  }
  return sessions;
}

// 진행 중 잡이 참조하는 세션(삭제/이동 금지 대상).
async function activeSessions() {
  if (!hasDbConfig()) return new Set();
  try {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT session_id, chunk_refs FROM transcribe_jobs
      WHERE status IN ('preparing','processing','correcting','summarizing','uploading')`);
    const set = new Set();
    for (const row of r.recordset || []) {
      if (row.session_id) set.add(String(row.session_id));
      for (const m of String(row.chunk_refs || "").matchAll(/local:([A-Za-z0-9_.-]+)\//g)) set.add(m[1]);
    }
    return set;
  } catch (e) {
    console.warn("⚠️ DB 조회 실패 — 진행 중 잡 보호를 위해 이전을 중단합니다:", e.message);
    return null;
  }
}

const sessions = await listAll();
const totalBytes = sessions.reduce((a, s) => a + s.bytes, 0);
const totalFiles = sessions.reduce((a, s) => a + s.files.length, 0);

console.log(`\n📁 CHUNK_DIR: ${CHUNK_DIR}`);
console.log(`세션 ${sessions.length}개 · 파일 ${totalFiles}개 · 총 ${fmtMB(totalBytes)}\n`);
for (const s of sessions) {
  console.log(`  ${s.name}  파일 ${s.files.length}개  ${fmtMB(s.bytes)}`);
  for (const f of s.files) console.log(`    - ${path.relative(CHUNK_DIR, f.path)}  ${fmtMB(f.size)}`);
}

if (!sessions.length) { console.log("이전할 파일이 없습니다."); process.exit(0); }

if (!APPLY) {
  console.log("\n드라이런(보고만). 실제 이전은 --apply 로 실행:");
  console.log("  node scripts/migrate-audio-to-drive.mjs --apply");
  process.exit(0);
}

const skip = await activeSessions();
if (skip === null) process.exit(1);

const drive = getDrive();
let moved = 0, movedBytes = 0, failed = 0;
for (const s of sessions) {
  if (skip.has(s.name)) { console.log(`⏭  ${s.name}: 진행 중 잡 세션 — 건너뜀`); continue; }
  let folderId;
  try {
    // 보관 폴더 하위 legacy/<세션> 폴더 (보관 폴더 자체를 루트로 사용).
    folderId = await ensurePathRootedById(drive, AUDIO_DRIVE_FOLDER_ID, ["legacy", s.name]);
  } catch (e) { console.warn(`❌ ${s.name}: Drive 폴더 생성 실패 — ${e.message}`); failed += s.files.length; continue; }
  for (const f of s.files) {
    try {
      const ext = path.extname(f.path).toLowerCase();
      const up = await uploadFileStream(drive, folderId, path.basename(f.path), MIME[ext] || "application/octet-stream", fs.createReadStream(f.path));
      if (!up || !up.id) throw new Error("업로드 응답에 id 없음");
      await fs.promises.unlink(f.path);
      moved++; movedBytes += f.size;
      console.log(`✅ ${path.relative(CHUNK_DIR, f.path)} → Drive(${up.id})`);
    } catch (e) {
      failed++;
      console.warn(`❌ ${path.relative(CHUNK_DIR, f.path)}: ${e.message} (로컬 보존)`);
    }
  }
  try { await fs.promises.rm(path.join(s.dir, "parts"), { recursive: true, force: true }); } catch (e) {}
  try { if (!(await fs.promises.readdir(s.dir)).length) await fs.promises.rmdir(s.dir); } catch (e) {}
}
console.log(`\n완료: ${moved}개(${fmtMB(movedBytes)}) 이전, 실패 ${failed}개(로컬 보존).`);

// 지정 폴더 ID 를 루트로 하위 경로 보장(이름 기반 루트 탐색 없이).
async function ensurePathRootedById(drive, rootId, parts) {
  let p = rootId;
  for (const part of parts.filter(Boolean)) {
    const q = `name='${String(part).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${p}' in parents and trashed=false`;
    const r = await drive.files.list({ q, fields: "files(id)", pageSize: 1 });
    if (r.data.files?.[0]) { p = r.data.files[0].id; continue; }
    const c = await drive.files.create({ requestBody: { name: part, mimeType: "application/vnd.google-apps.folder", parents: [p] }, fields: "id" });
    p = c.data.id;
  }
  return p;
}
