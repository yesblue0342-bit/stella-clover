#!/usr/bin/env node
// scripts/backfill-notes-meta.mjs — 기존 Drive 노트를 Postgres notes_meta 로 1회 백필.
//
// 사용법(OCI 서버, 컨테이너 안 또는 .env 로드된 쉘에서):
//   node scripts/backfill-notes-meta.mjs
//   docker exec stella-clover node scripts/backfill-notes-meta.mjs
//
// 동작: Drive 노트 폴더(STELLA_NOTES_FOLDER_ID/NOTES_FOLDER_ID)를 전체 스캔해 notes_meta 를
//   upsert 한다(lib/notesSync.fullScanToMeta 와 동일 로직, 멱등 — 몇 번을 다시 돌려도 안전).
//   서버가 이미 부팅 시 증분 동기화 커서가 없으면 자동으로 같은 전체 스캔을 1회 수행하므로,
//   이 스크립트는 배포 전 수동으로 미리 백필해 두거나 진행 상황을 즉시 확인하고 싶을 때 쓴다.
import { getDrive } from "../api/_drive.js";
import { hasDbConfig } from "../api/_db.js";
import { fullScanToMeta } from "../lib/notesSync.js";

if (!hasDbConfig()) {
  console.error("❌ DB 환경변수 미설정(DATABASE_URL 또는 DB_SERVER/DB_NAME/DB_USER/DB_PASSWORD) — 중단");
  process.exit(1);
}
if (!process.env.GOOGLE_REFRESH_TOKEN) {
  console.error("❌ Google Drive 환경변수 미설정(GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN) — 중단");
  process.exit(1);
}

console.log("노트 전체 스캔 → notes_meta 백필 시작...");
const t0 = Date.now();
const drive = getDrive();
const count = await fullScanToMeta(drive);
console.log(`✅ 완료: ${count}건 반영, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
