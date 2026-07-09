// api/notes.js - 노트 목록/검색/생성/수정/삭제 (원본은 Google Drive, 목록/검색은 Postgres notes_meta)
// Stella GPT 노트(api/note.js)와 같은 Drive 폴더·같은 JSON 포맷을 공유 → 두 앱이 같은 노트를 본다.
// 노트 포맷: { id, userId, title, body, category, createdAt, updatedAt, deleted, savedAt }
//
// 성능: list/검색은 notes_meta(Postgres) 만 SELECT — Drive API 를 절대 타지 않는다.
//   본문은 노트 클릭(action=get) 시에만 lazy load. 쓰기(save/delete)는 notes_meta upsert 와
//   Drive 저장을 한 트랜잭션 흐름으로 처리(Drive 실패 시 메타 롤백, withTransaction 참고).
//   Stella GPT 등 외부에서 Drive 를 직접 건드린 변경분은 5분 간격 백그라운드 증분 동기화
//   (lib/notesSync.incrementalSync, server.mjs 부팅 스케줄)가 notes_meta 에 반영한다.
import { getDrive, saveJsonToDrive, findFileByName, readJsonById } from "./_drive.js";
import { getPool, hasDbConfig, withTransaction } from "./_db.js";
import { fullScanToMeta } from "../lib/notesSync.js";

// Stella GPT(lib/drive-utils.js DEFAULT_NOTES_FOLDER_ID)와 동일한 기본 폴더(공유).
const NOTES_FOLDER_ID = process.env.STELLA_NOTES_FOLDER_ID || process.env.NOTES_FOLDER_ID || "1Gd_4isQFTIQi0DjaDfE85IZM-tG1cClZ";
const PAGE_SIZE = 30;

function genId() {
  return "note_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  // 항상 JSON 응답(에러 시에도) — 프런트 safeJson 방어와 짝.
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    return res.status(200).json({ ok: false, items: [], message: "Google Drive 환경변수 미설정 (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN 확인)" });
  }
  if (!hasDbConfig()) {
    return res.status(200).json({ ok: false, items: [], message: "DB 환경변수 미설정 — 노트 목록은 Postgres(notes_meta) 필요" });
  }

  const action = req.query.action || (req.body && req.body.action) || "list";

  try {
    // 상세 조회 — 목록엔 없는 전체 본문. 편집기 진입 시에만 호출.
    if (action === "get") {
      const id = String(req.query.id || (req.body && req.body.id) || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "id가 필요합니다" });

      const t0 = Date.now();
      const drive = getDrive();
      const pool = await getPool();
      const metaR = await pool.request().input("id", id)
        .query(`SELECT drive_file_id AS "driveFileId" FROM notes_meta WHERE id=@id AND deleted_at IS NULL`);
      let fileId = metaR.recordset?.[0]?.driveFileId || null;
      if (!fileId) fileId = await findFileByName(drive, NOTES_FOLDER_ID, `${id}.json`); // 메타에 아직 없는 구노트 폴백

      if (!fileId) return res.status(200).json({ ok: false, message: "대상 노트를 찾을 수 없습니다" });
      const note = await readJsonById(drive, fileId);
      console.log(`[notes] get id=${id} ${Date.now() - t0}ms`);
      if (!note || note.deleted) return res.status(200).json({ ok: false, message: "대상 노트를 찾을 수 없습니다" });
      return res.status(200).json({ ok: true, item: note });
    }

    // 인덱스 강제 재생성(수동 복구용) — Drive 전체 재스캔 → notes_meta 재구성.
    if (action === "rebuildIndex") {
      const t0 = Date.now();
      const drive = getDrive();
      const count = await fullScanToMeta(drive);
      console.log(`[notes] rebuildIndex(full scan) ${Date.now() - t0}ms count=${count}`);
      return res.status(200).json({ ok: true, count });
    }

    // 생성/수정 — id 있으면 갱신(createdAt 유지), 없으면 신규 생성.
    //  notes_meta upsert + Drive 저장을 한 트랜잭션으로: Drive 저장 실패 시 메타 upsert 롤백.
    if (action === "save") {
      const id = String((req.body && req.body.id) || "").trim() || genId();
      const title = String((req.body && req.body.title) || "").trim() || "제목 없음";
      const body = String((req.body && req.body.body) || "");
      const now = new Date().toISOString();
      const t0 = Date.now();

      const drive = getDrive();
      const pool = await getPool();
      const metaR = await pool.request().input("id", id)
        .query(`SELECT drive_file_id AS "driveFileId" FROM notes_meta WHERE id=@id`);
      let prevDriveFileId = metaR.recordset?.[0]?.driveFileId || null;
      if (!prevDriveFileId) prevDriveFileId = await findFileByName(drive, NOTES_FOLDER_ID, `${id}.json`);

      let createdAt = now;
      if (prevDriveFileId) {
        try {
          const prev = await readJsonById(drive, prevDriveFileId);
          if (prev && prev.createdAt) createdAt = prev.createdAt;
        } catch { /* 읽기 실패 시 새 createdAt으로 계속 */ }
      }

      const data = { id, userId: "clover", title, body, category: "노트", createdAt, updatedAt: now, deleted: false };
      const preview = body.slice(0, 200);

      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO notes_meta (id, drive_file_id, title, preview, source, updated_at, deleted_at)
           VALUES ($1, $2, $3, $4, 'clover', $5, NULL)
           ON CONFLICT (id) DO UPDATE SET
             title = $3, preview = $4, source = 'clover', updated_at = $5, deleted_at = NULL`,
          [id, prevDriveFileId, title, preview, now]
        );
        const up = await saveJsonToDrive(drive, NOTES_FOLDER_ID, id, data, prevDriveFileId); // 실패 시 throw → 트랜잭션 롤백(메타 되돌림)
        if (up.id !== prevDriveFileId) {
          await client.query(`UPDATE notes_meta SET drive_file_id=$1 WHERE id=$2`, [up.id, id]);
        }
      });

      console.log(`[notes] save id=${id} ${Date.now() - t0}ms`);
      return res.status(200).json({ ok: true, item: data });
    }

    // 삭제 — 소프트 삭제(deleted:true). Stella GPT 쪽 파일도 동일 규칙이라 서로 호환.
    //  notes_meta.deleted_at 세팅 + Drive 저장을 한 트랜잭션으로: Drive 실패 시 메타 롤백(삭제 취소).
    if (action === "delete") {
      const id = String((req.body && req.body.id) || req.query.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "id가 필요합니다" });
      const t0 = Date.now();

      const drive = getDrive();
      const pool = await getPool();
      const metaR = await pool.request().input("id", id)
        .query(`SELECT drive_file_id AS "driveFileId" FROM notes_meta WHERE id=@id`);
      let fileId = metaR.recordset?.[0]?.driveFileId || null;
      if (!fileId) fileId = await findFileByName(drive, NOTES_FOLDER_ID, `${id}.json`);
      if (!fileId) return res.status(200).json({ ok: false, message: "대상 노트를 찾을 수 없습니다" });

      const prev = await readJsonById(drive, fileId);
      const now = new Date().toISOString();
      const data = { ...prev, deleted: true, deletedAt: now, updatedAt: now };

      await withTransaction(async (client) => {
        await client.query(`UPDATE notes_meta SET deleted_at=$1, updated_at=$1 WHERE id=$2`, [now, id]);
        await saveJsonToDrive(drive, NOTES_FOLDER_ID, id, data, fileId); // 실패 시 throw → 트랜잭션 롤백(삭제 취소)
      });

      console.log(`[notes] delete id=${id} ${Date.now() - t0}ms`);
      return res.status(200).json({ ok: true });
    }

    // 기본: 목록 + 검색(q, 제목+미리보기 부분일치) + 페이지네이션. notes_meta 만 SELECT(Drive 미접근).
    const q = String(req.query.q || "").trim();
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const offset = page * PAGE_SIZE;

    const t0 = Date.now();
    const pool = await getPool();
    const request = pool.request().input("limit", PAGE_SIZE + 1).input("offset", offset);
    let where = "deleted_at IS NULL";
    if (q) { request.input("q", `%${q}%`); where += " AND (title ILIKE @q OR preview ILIKE @q)"; }
    const r = await request.query(`
      SELECT id, title, preview, updated_at AS "updatedAt"
      FROM notes_meta
      WHERE ${where}
      ORDER BY updated_at DESC
      LIMIT @limit OFFSET @offset
    `);
    const rows = r.recordset || [];
    const hasMore = rows.length > PAGE_SIZE;
    const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    console.log(`[notes] list ${Date.now() - t0}ms rows=${items.length} page=${page} q=${q ? "yes" : "no"}`);
    return res.status(200).json({ ok: true, items, page, hasMore });

  } catch (e) {
    return res.status(200).json({ ok: false, items: [], message: "노트 처리 오류: " + e.message });
  }
}
