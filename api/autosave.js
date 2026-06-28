// api/autosave.js - 작성 중 회의록을 Google Drive(Drafts)에 자동 저장
import { getDrive, ensurePath, uploadText } from "./_drive.js";

// (Vercel maxDuration 제거 — OCI 서버는 시간 제한 없음)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST only" });
  if (!process.env.GOOGLE_REFRESH_TOKEN) return res.status(200).json({ ok: false, message: "Google Drive 미설정" });

  const { content, name } = req.body || {};
  if (!content || !content.trim()) return res.status(200).json({ ok: true, skipped: true });

  try {
    const drive = getDrive();
    const folderId = await ensurePath(drive, ["Drafts"]);
    const safe = (name || "draft").toString().replace(/[\\/:*?"<>|]/g, "").slice(0, 60) || "draft";
    const up = await uploadText(drive, folderId, `${safe}.txt`, content);
    return res.status(200).json({ ok: true, id: up.id, link: up.webViewLink });
  } catch (e) {
    return res.status(200).json({ ok: false, message: "자동저장 실패: " + e.message });
  }
}
