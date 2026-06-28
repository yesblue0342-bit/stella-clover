// api/chunk-upload.js - 오디오 청크 1개를 Google Drive에 업로드하고 file id를 돌려준다.
//   POST multipart: audio(청크 파일) + sessionId, index, durationSec, ext
//   → { ok, id, index, durationSec, ext }
//
// 클라이언트는 청크를 분할(Web Audio)해 이 엔드포인트로 업로드 → 받은 id로 chunkRefs를 만들어
// POST /api/jobs 에 넘긴다. worker(jobs-runtime)는 downloadFileById(id)로 청크를 다시 받아 전사한다.
// 업로드만 하고 전사는 안 함(=백그라운드 잡으로 위임). 청크는 cleanup 크론이 10일 후 정리(Audio 폴더 공용).
import formidable from "formidable";
import fs from "fs";
import path from "path";
import { getDrive, ensurePath, uploadBuffer } from "./_drive.js";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST only" });
  if (!process.env.GOOGLE_REFRESH_TOKEN) return res.status(200).json({ ok: false, message: "Google Drive 미설정" });

  const form = formidable({ maxFileSize: 30 * 1024 * 1024, keepExtensions: true });
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ ok: false, message: "업로드 오류: " + err.message });
    const audioFile = files.audio?.[0] || files.audio;
    if (!audioFile) return res.status(400).json({ ok: false, message: "음성 청크가 없습니다." });

    const filePath = audioFile.filepath;
    const originalName = audioFile.originalFilename || "chunk.wav";
    let ext = path.extname(originalName).toLowerCase() || ".wav";
    const allowed = [".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm", ".ogg", ".aac"];
    if (!allowed.includes(ext)) ext = ".wav";

    const sessionId = String(fields.sessionId?.[0] || fields.sessionId || "sess").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "sess";
    const index = parseInt(fields.index?.[0] || fields.index || "0", 10) || 0;
    const durationSec = Number(fields.durationSec?.[0] || fields.durationSec || 0) || 0;

    try {
      const buffer = fs.readFileSync(filePath);
      const drive = getDrive();
      const folderId = await ensurePath(drive, ["Audio"]); // cleanup 크론과 동일 폴더(10일 후 정리)
      const up = await uploadBuffer(drive, folderId, `${sessionId}_${String(index).padStart(3, "0")}${ext}`, "audio/wav", buffer);
      fs.unlink(filePath, () => {});
      if (!up || !up.id) return res.status(200).json({ ok: false, message: "Drive 업로드 응답에 id가 없습니다." });
      return res.status(200).json({ ok: true, id: up.id, index, durationSec, ext });
    } catch (e) {
      fs.unlink(filePath, () => {});
      return res.status(200).json({ ok: false, message: "청크 업로드 실패: " + e.message });
    }
  });
}
