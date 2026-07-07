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
import { saveChunk, savePart } from "../lib/chunkStore.js";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST only" });

  const form = formidable({ maxFileSize: 30 * 1024 * 1024, keepExtensions: true });
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ ok: false, message: "업로드 오류: " + err.message });
    const audioFile = files.audio?.[0] || files.audio;
    if (!audioFile) return res.status(400).json({ ok: false, message: "음성 청크가 없습니다." });

    const filePath = audioFile.filepath;
    const sessionId = String(fields.sessionId?.[0] || fields.sessionId || "sess").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "sess";
    const index = parseInt(fields.index?.[0] || fields.index || "0", 10) || 0;
    const kind = String(fields.kind?.[0] || fields.kind || "");

    try {
      const buffer = fs.readFileSync(filePath);
      fs.unlink(filePath, () => {});

      // ★ 신규 기본: 원본 파일 바이트 파트(kind=part). 서버가 조립 후 ffmpeg 전처리 —
      //   브라우저 전체 디코딩(모바일 메모리 폭주)이 사라진다. 저장은 로컬 디스크(lib/chunkStore) 그대로.
      if (kind === "part") {
        await savePart({ sessionId, index, buffer });
        return res.status(200).json({ ok: true, kind: "part", index });
      }

      // 레거시: 클라이언트가 만든 16kHz WAV 오디오 청크(구버전 앱 캐시 호환).
      const originalName = audioFile.originalFilename || "chunk.wav";
      let ext = path.extname(originalName).toLowerCase() || ".wav";
      const allowed = [".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm", ".ogg", ".aac"];
      if (!allowed.includes(ext)) ext = ".wav";
      const durationSec = Number(fields.durationSec?.[0] || fields.durationSec || 0) || 0;
      const id = await saveChunk({ sessionId, index, ext, buffer });
      return res.status(200).json({ ok: true, id, index, durationSec, ext });
    } catch (e) {
      fs.unlink(filePath, () => {});
      return res.status(200).json({ ok: false, message: "청크 저장 실패: " + e.message });
    }
  });
}
