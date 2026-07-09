// api/notes.js - 노트 목록/검색/생성/수정/삭제 (Google Drive 저장)
// Stella GPT 노트(api/note.js)와 같은 Drive 폴더·같은 JSON 포맷을 공유 → 두 앱이 같은 노트를 본다.
// 노트 포맷: { id, userId, title, body, category, createdAt, updatedAt, deleted, savedAt }
//
// 성능: list 액션은 노트 개별 파일을 매번 다 읽지 않고, Clover 전용 인덱스 파일
// (stellaclover/notes-index/_index.json — 공유 노트 폴더 밖, Stella GPT는 이 폴더를 모름)
// 하나만 읽어 응답한다. 인덱스에는 미리보기(본문 200자)만 있어 상세/편집 진입 시엔
// action=get 으로 그 노트 1건만 개별 조회한다.
import { getDrive, saveJsonToDrive, listJsonInFolder, readJsonById, findFileByName, ensurePath } from "./_drive.js";

// Stella GPT(lib/drive-utils.js DEFAULT_NOTES_FOLDER_ID)와 동일한 기본 폴더(공유).
const NOTES_FOLDER_ID = process.env.STELLA_NOTES_FOLDER_ID || process.env.NOTES_FOLDER_ID || "1Gd_4isQFTIQi0DjaDfE85IZM-tG1cClZ";

const INDEX_FOLDER_PARTS = ["notes-index"];
const INDEX_FILE = "_index";

function genId() {
  return "note_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function toIndexEntry(note) {
  return {
    id: note.id,
    title: note.title || "제목 없음",
    preview: String(note.body || "").slice(0, 200),
    date: note.createdAt || note.updatedAt || null,
    updatedAt: note.updatedAt || null,
  };
}

async function getIndexFolderId(drive) {
  return ensurePath(drive, INDEX_FOLDER_PARTS);
}

// 인덱스 읽기 — 없거나 형식이 깨졌으면 null(호출부가 재생성 판단).
async function readIndex(drive) {
  const folderId = await getIndexFolderId(drive);
  const fileId = await findFileByName(drive, folderId, `${INDEX_FILE}.json`);
  if (!fileId) return null;
  try {
    const data = await readJsonById(drive, fileId);
    if (!data || !Array.isArray(data.items)) return null;
    return data.items;
  } catch {
    return null;
  }
}

async function writeIndex(drive, items) {
  const folderId = await getIndexFolderId(drive);
  await saveJsonToDrive(drive, folderId, INDEX_FILE, { items, rebuiltAt: new Date().toISOString() });
}

// 느린 전체 스캔(과거 list 로직) — 인덱스가 없거나 깨졌을 때만 실행하고, 결과로 인덱스를 재생성한다.
async function rebuildIndexFromScan(drive) {
  const files = await listJsonInFolder(drive, NOTES_FOLDER_ID);
  const items = [];
  const BATCH = 10;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const notes = await Promise.all(batch.map(f => readJsonById(drive, f.id).catch(() => null)));
    for (const n of notes) if (n && !n.deleted) items.push(toIndexEntry(n));
  }
  items.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  await writeIndex(drive, items);
  return items;
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

    // 상세 조회 — 목록엔 없는 전체 본문. 편집기 진입 시에만 호출.
    if (action === "get") {
      const id = String(req.query.id || (req.body && req.body.id) || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "id가 필요합니다" });
      const fileId = await findFileByName(drive, NOTES_FOLDER_ID, `${id}.json`);
      if (!fileId) return res.status(200).json({ ok: false, message: "대상 노트를 찾을 수 없습니다" });
      const note = await readJsonById(drive, fileId);
      if (!note || note.deleted) return res.status(200).json({ ok: false, message: "대상 노트를 찾을 수 없습니다" });
      return res.status(200).json({ ok: true, item: note });
    }

    // 인덱스 강제 재생성(수동 복구용).
    if (action === "rebuildIndex") {
      const items = await rebuildIndexFromScan(drive);
      return res.status(200).json({ ok: true, count: items.length });
    }

    // 생성/수정 — id 있으면 갱신(createdAt 유지), 없으면 신규 생성. 인덱스도 함께 갱신.
    if (action === "save") {
      const id = String((req.body && req.body.id) || "").trim() || genId();
      const title = String((req.body && req.body.title) || "").trim() || "제목 없음";
      const body = String((req.body && req.body.body) || "");
      const now = new Date().toISOString();

      let createdAt = now;
      const existingId = await findFileByName(drive, NOTES_FOLDER_ID, `${id}.json`);
      if (existingId) {
        try {
          const prev = await readJsonById(drive, existingId);
          if (prev && prev.createdAt) createdAt = prev.createdAt;
        } catch { /* 읽기 실패 시 새 createdAt으로 계속 */ }
      }

      const data = { id, userId: "clover", title, body, category: "노트", createdAt, updatedAt: now, deleted: false };
      await saveJsonToDrive(drive, NOTES_FOLDER_ID, id, data);

      let items = await readIndex(drive);
      if (!items) {
        items = await rebuildIndexFromScan(drive); // 방금 저장한 노트도 스캔에 포함됨
      } else {
        const entry = toIndexEntry(data);
        const i = items.findIndex(x => x.id === id);
        if (i >= 0) items[i] = entry; else items.unshift(entry);
        await writeIndex(drive, items);
      }
      return res.status(200).json({ ok: true, item: data });
    }

    // 삭제 — 소프트 삭제(deleted:true). Stella GPT 쪽 파일도 동일 규칙이라 서로 호환. 인덱스에서도 제거.
    if (action === "delete") {
      const id = String((req.body && req.body.id) || req.query.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, message: "id가 필요합니다" });

      const fileId = await findFileByName(drive, NOTES_FOLDER_ID, `${id}.json`);
      if (!fileId) return res.status(200).json({ ok: false, message: "대상 노트를 찾을 수 없습니다" });

      const prev = await readJsonById(drive, fileId);
      const now = new Date().toISOString();
      const data = { ...prev, deleted: true, deletedAt: now, updatedAt: now };
      await saveJsonToDrive(drive, NOTES_FOLDER_ID, id, data);

      let items = await readIndex(drive);
      if (!items) {
        items = await rebuildIndexFromScan(drive); // 스캔 자체가 deleted 노트를 걸러냄
      } else {
        items = items.filter(x => x.id !== id);
        await writeIndex(drive, items);
      }
      return res.status(200).json({ ok: true });
    }

    // 기본: 목록 + 검색(q, 제목+미리보기 부분일치) — 인덱스 1회만 읽는다.
    const q = String(req.query.q || "").trim().toLowerCase();
    let items = await readIndex(drive);
    if (!items) items = await rebuildIndexFromScan(drive); // 최초 1회/손상 시에만 느린 전체 스캔

    const filtered = q ? items.filter(n => ((n.title || "") + (n.preview || "")).toLowerCase().includes(q)) : items;
    const sorted = [...filtered].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return res.status(200).json({ ok: true, items: sorted });

  } catch (e) {
    return res.status(200).json({ ok: false, items: [], message: "Drive 오류: " + e.message });
  }
}
