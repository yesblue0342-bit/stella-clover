// api/chunk-upload.js - 오디오 청크 1개를 서버 로컬 디스크에 저장하고 ref id 를 돌려준다.
//   POST multipart: audio(청크 파일) + sessionId, index, durationSec
//   → { ok, id, index, durationSec, ext }
//
// ★ 변경(invalid_client 회귀 해소): 과거에는 청크를 Google Drive 에 업로드했으나, Drive OAuth 가 어긋나면
//   `invalid_client` 로 전사가 통째로 막혔다. OCI 는 장수 프로세스 + 동일 파일시스템이므로 Drive 왕복이 불필요.
//   → lib/chunkStore 로 로컬 저장(=Drive 인증과 무관하게 동작). 워커(jobs-runtime)가 같은 디스크에서 읽는다.
//   청크는 cleanup 크론이 보존기간 후 정리. (최종 회의록 텍스트만 Drive 백업; 그 단계는 실패해도 graceful.)
import formidable from "formidable";
import fs from "fs";
import path from "path";
import { saveChunk } from "../lib/chunkStore.js";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST only" });

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
      const id = await saveChunk({ sessionId, index, ext, buffer });
      fs.unlink(filePath, () => {});
      return res.status(200).json({ ok: true, id, index, durationSec, ext });
    } catch (e) {
      fs.unlink(filePath, () => {});
      return res.status(200).json({ ok: false, message: "청크 저장 실패: " + e.message });
    }
  });
}
