// lib/notesSync.js - Drive(노트 원본) → Postgres notes_meta(읽기 캐시) 동기화.
//
// 노트는 Clover(api/notes.js)와 Stella GPT(별개 앱, api/note.js)가 같은 Drive 폴더를 공유해서
// 쓴다. Clover 쪽 쓰기는 api/notes.js 가 notes_meta 를 직접 upsert 하지만, Stella GPT 가 쓴
// 변경분은 이 동기화가 아니면 notes_meta 에 반영될 길이 없다 — 그래서 5분 간격 백그라운드로
// Drive modifiedTime 증분만 읽어 반영한다(전체 재스캔은 최초 부트스트랩/수동 복구 때만).
import { listJsonInFolder, listJsonInFolderSince, readJsonById } from "../api/_drive.js";
import { getPool } from "../api/_db.js";

const NOTES_FOLDER_ID = process.env.STELLA_NOTES_FOLDER_ID || process.env.NOTES_FOLDER_ID || "1Gd_4isQFTIQi0DjaDfE85IZM-tG1cClZ";
const SYNC_STATE_KEY = "notes_last_sync";
const BATCH = 10;

function idFromFileName(name) {
  return String(name || "").replace(/\.json$/i, "");
}

async function upsertRow(pool, row) {
  await pool.request()
    .input("id", row.id)
    .input("driveFileId", row.driveFileId)
    .input("title", row.title)
    .input("preview", row.preview)
    .input("source", row.source)
    .input("updatedAt", row.updatedAt)
    .input("deletedAt", row.deletedAt)
    .query(`
      INSERT INTO notes_meta (id, drive_file_id, title, preview, source, updated_at, deleted_at)
      VALUES (@id, @driveFileId, @title, @preview, @source, @updatedAt, @deletedAt)
      ON CONFLICT (id) DO UPDATE SET
        drive_file_id = @driveFileId, title = @title, preview = @preview,
        source = @source, updated_at = @updatedAt, deleted_at = @deletedAt
    `);
}

function toRow(file, note) {
  const id = (note && note.id) || idFromFileName(file.name);
  return {
    id,
    driveFileId: file.id,
    title: (note && note.title) || "제목 없음",
    preview: String((note && note.body) || "").slice(0, 200),
    source: (note && note.userId) || "drive",
    updatedAt: (note && (note.updatedAt || note.createdAt)) || new Date().toISOString(),
    deletedAt: note && note.deleted ? (note.deletedAt || new Date().toISOString()) : null,
  };
}

async function readSyncCutoff(pool) {
  const r = await pool.request().query(`SELECT value FROM notes_sync_state WHERE key='${SYNC_STATE_KEY}'`);
  return r.recordset?.[0]?.value || null;
}

async function writeSyncCutoff(pool, iso) {
  await pool.request().input("v", iso).query(`
    INSERT INTO notes_sync_state (key, value) VALUES ('${SYNC_STATE_KEY}', @v)
    ON CONFLICT (key) DO UPDATE SET value = @v
  `);
}

// 전체 재스캔 — 최초 부트스트랩(증분 커서 없음) 또는 수동 복구(action=rebuildIndex)에서만 사용.
export async function fullScanToMeta(drive) {
  const files = await listJsonInFolder(drive, NOTES_FOLDER_ID);
  const pool = await getPool();
  let count = 0;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const notes = await Promise.all(batch.map(async f => {
      try { return { file: f, note: await readJsonById(drive, f.id) }; } catch { return null; }
    }));
    for (const entry of notes) {
      if (!entry) continue;
      await upsertRow(pool, toRow(entry.file, entry.note));
      count++;
    }
  }
  await writeSyncCutoff(pool, new Date().toISOString());
  return count;
}

// 증분 동기화 — modifiedTime 이 마지막 커서 이후인 파일만 반영. 커서가 없으면(최초 1회) 전체 스캔.
export async function incrementalSync(drive) {
  const pool = await getPool();
  const sinceIso = await readSyncCutoff(pool);
  if (!sinceIso) {
    const count = await fullScanToMeta(drive);
    return { mode: "full", count };
  }

  // Drive 목록 조회 시작 "전" 시각을 다음 커서로 쓴다 — 조회~커서기록 사이에 생긴 변경도
  // 다음 회차 modifiedTime > cutoff 조건에 걸리도록(누락 방지, 중복 반영은 upsert 라 안전).
  const runStartIso = new Date().toISOString();
  const files = await listJsonInFolderSince(drive, NOTES_FOLDER_ID, sinceIso);
  let count = 0;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const notes = await Promise.all(batch.map(async f => {
      try { return { file: f, note: await readJsonById(drive, f.id) }; } catch { return null; }
    }));
    for (const entry of notes) {
      if (!entry) continue;
      await upsertRow(pool, toRow(entry.file, entry.note));
      count++;
    }
  }
  await writeSyncCutoff(pool, runStartIso);
  return { mode: "incremental", count };
}
