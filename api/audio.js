// api/audio.js - Drive에 저장된 음원(청크/원본)을 스트리밍 (A3 재진입 재생). 기존 Drive 인증 재사용.
import { getDrive, downloadFileById } from "./_drive.js";

// (Vercel maxDuration 제거 — OCI 서버는 시간 제한 없음)

export default async function handler(req, res) {
  const id = String(req.query.id || "").trim();
  if (!id) { res.setHeader("Content-Type", "application/json; charset=utf-8"); return res.status(400).json({ ok: false, message: "id 필요" }); }
  try {
    const drive = getDrive();
    const buf = await downloadFileById(drive, id);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Accept-Ranges", "none");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(buf.length));
    return res.status(200).send(buf);
  } catch (e) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({ ok: false, message: "오디오 로드 실패: " + e.message });
  }
}
