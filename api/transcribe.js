// api/transcribe.js - 음성 청크 → 텍스트 (OpenAI Whisper)
// 클라이언트가 분할/압축한 청크를 받아 처리
import formidable from "formidable";
import fs from "fs";
import path from "path";
import { getDrive, ensurePath, uploadBuffer } from "./_drive.js";
import { transcribeBuffer } from "./_stt.js";

// (Vercel config 제거 — OCI 서버에선 시간 제한 없음. multipart는 server.mjs가 body 파싱을 건너뛰어
//  formidable이 원시 스트림을 직접 읽는다.)

// SAP 프롬프트·재시도·교정은 _stt.js(→ lib/sttTerms.js)로 단일화. 여기선 transcribeBuffer만 호출.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST only" });

  const form = formidable({ maxFileSize: 30 * 1024 * 1024, keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ ok: false, message: "업로드 오류: " + err.message });

    const audioFile = files.audio?.[0] || files.audio;
    if (!audioFile) return res.status(400).json({ ok: false, message: "음성 파일이 없습니다." });

    const filePath = audioFile.filepath;
    const originalName = audioFile.originalFilename || "audio.webm";
    let ext = path.extname(originalName).toLowerCase() || ".webm";
    const allowed = [".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm", ".ogg", ".aac"];
    if (!allowed.includes(ext)) ext = ".wav";

    // 이전 청크의 마지막 텍스트 (문맥 연결용)
    const prevText = (fields.prevText?.[0] || fields.prevText || "").slice(-200);
    let lang = (fields.lang?.[0] || fields.lang || "ko").toString();
    // 세션/청크 식별 (오디오 Drive 보관용)
    const sessionId = (fields.sessionId?.[0] || fields.sessionId || "").toString().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    const index = parseInt(fields.index?.[0] || fields.index || "0", 10) || 0;
    // 모델 선택(기본 whisper-1) + 글로벌 타임라인 offset(앞 청크 누적 길이)
    const model = (fields.model?.[0] || fields.model || "whisper-1").toString();
    const offsetSec = Number(fields.offsetSec?.[0] || fields.offsetSec || 0) || 0;

    try {
      const buffer = fs.readFileSync(filePath);
      const stt = await transcribeBuffer({ buffer, ext, lang, model, prevText, offsetSec });
      const text = stt.text;

      // 오디오 청크를 Drive에 보관 (10일 후 cleanup 크론이 삭제). 실패해도 변환은 성공 처리.
      if (sessionId && process.env.GOOGLE_REFRESH_TOKEN) {
        try {
          const drive = getDrive();
          const folderId = await ensurePath(drive, ["Audio"]);
          await uploadBuffer(drive, folderId, `${sessionId}_${String(index).padStart(3, "0")}${ext}`, "audio/wav", buffer);
        } catch (e2) { /* 보관 실패는 무시 */ }
      }

      fs.unlink(filePath, () => {});
      // A2: timestamps 있으면 segments 동봉(없으면 빈 배열 → 프런트는 일반 transcript)
      return res.status(200).json({ ok: true, text: text || "", length: (text || "").length, model, segments: stt.segments || [], hasTimestamps: !!stt.hasTimestamps, duration: stt.duration || 0 });
    } catch (e) {
      fs.unlink(filePath, () => {});
      return res.status(500).json({ ok: false, message: "Whisper 변환 실패: " + e.message });
    }
  });
}
