// api/drive-search.js - Google Drive 내 회의록/전사 텍스트 파일 검색
import { getDrive, searchText } from "./_drive.js";

// (Vercel maxDuration 제거 — OCI 서버는 시간 제한 없음)

export default async function handler(req, res) {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    return res.status(200).json({ ok: false, items: [], message: "Google Drive 미설정" });
  }
  const q = (req.query.q || "").trim().slice(0, 100);
  if (!q) return res.status(200).json({ ok: true, items: [] });

  try {
    const drive = getDrive();
    const items = await searchText(drive, q, 30);
    return res.status(200).json({ ok: true, items });
  } catch (e) {
    return res.status(200).json({ ok: false, items: [], message: "Drive 검색 오류: " + e.message });
  }
}
