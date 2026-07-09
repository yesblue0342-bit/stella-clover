// api/notes.js - 노트 목록/검색/생성/수정/삭제 (Google Drive 저장)
// Stella GPT 노트(api/note.js)와 같은 Drive 폴더·같은 JSON 포맷을 공유 → 두 앱이 같은 노트를 본다.
// 포맷: { id, userId, title, body, category, createdAt, updatedAt, deleted, savedAt }
import { getDrive, saveJsonToDrive, listJsonInFolder, readJsonById } from "./_drive.js";

// Stella GPT(lib/drive-utils.js DEFAULT_NOTES_FOLDER_ID)와 동일한 기본 폴더.
const NOTES_FOLDER_ID = process.env.STELLA_NOTES_FOLDER_ID || process.env.NOTES_FOLDER_ID || "1Gd_4isQFTIQi0DjaDfE85IZM-tG1cClZ";

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

  const action = req.query.action || (req.body && req.body.action) || "list";

  try {
    const drive = getDrive();

    // 생성/수정 — id 있으면 갱신(createdAt 유지), 없으면 신규 생성.
    if (action === "save") {
      const id = String((req.body && req.body.id) || "").trim() || genId();
      const title = String((req.body && req.body.title) || "").trim() || "제목 없음";
      const body = String((req.body && req.body.body) || "");
      const now = new Date().toISOString();

      let createdAt = now;
      const files = await listJsonInFolder(drive, NOTES_FOLDER_ID);
      const existingMeta = files.find(f => f.name === `${id}.json`);
      if (existingMeta) {
        try {
          const prev = await readJsonById(drive, existingMeta.id);
          if (prev && prev.createdAt) createdAt = prev.createdAt;
        } catch { /* 읽기 실패 시 새 createdAt으로 계속 */ }
      }

      const data = { id, userId: "clover", title, body, category: "노트", createdAt, updatedAt: now, deleted: false };
      await saveJsonToDrive(drive, NOTES_FOLDER_ID, id, data);
      return res.status(200).json({ ok: true, item: data });
    }

    // 삭제 — 소프트 삭제(deleted:true). Stella GPT 쪽 파일도 동일 규칙이라 서로 호환.
    if (action === "delete") {
      const id = String((req.body && req.body.id) || req.query.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "id가 필요합니다" });

      const files = await listJsonInFolder(drive, NOTES_FOLDER_ID);
      const meta = files.find(f => f.name === `${id}.json`);
      if (!meta) return res.status(200).json({ ok: false, message: "대상 노트를 찾을 수 없습니다" });

      const prev = await readJsonById(drive, meta.id);
      const now = new Date().toISOString();
      const data = { ...prev, deleted: true, deletedAt: now, updatedAt: now };
      await saveJsonToDrive(drive, NOTES_FOLDER_ID, id, data);
      return res.status(200).json({ ok: true });
    }

    // 기본: 목록 + 검색(q, 제목+본문 부분일치)
    const q = String(req.query.q || "").trim().toLowerCase();
    const files = await listJsonInFolder(drive, NOTES_FOLDER_ID);
    const items = [];
    const BATCH = 10;
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const notes = await Promise.all(batch.map(f => readJsonById(drive, f.id).catch(() => null)));
      for (const n of notes) if (n && !n.deleted) items.push(n);
    }
    const filtered = q ? items.filter(n => ((n.title || "") + (n.body || "")).toLowerCase().includes(q)) : items;
    filtered.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return res.status(200).json({ ok: true, items: filtered });

  } catch (e) {
    return res.status(200).json({ ok: false, items: [], message: "Drive 오류: " + e.message });
  }
}
