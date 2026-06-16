// api/transcribe.js - 음성 파일 → 텍스트 (OpenAI Whisper)
import formidable from "formidable";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

export const config = { api: { bodyParser: false }, maxDuration: 120 };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 재시도 함수
async function retry(fn, times = 3) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST only" });

  const form = formidable({ maxFileSize: 100 * 1024 * 1024, keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ ok: false, message: err.message });

    const audioFile = files.audio?.[0] || files.audio;
    if (!audioFile) return res.status(400).json({ ok: false, message: "음성 파일이 없습니다." });

    const filePath = audioFile.filepath;
    const originalName = audioFile.originalFilename || "audio.webm";
    const ext = path.extname(originalName).toLowerCase() || ".webm";
    const allowedExts = [".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm", ".ogg", ".aac"];

    if (!allowedExts.includes(ext)) {
      return res.status(400).json({ ok: false, message: `지원하지 않는 형식: ${ext}` });
    }

    try {
      const text = await retry(async () => {
        const fileStream = fs.createReadStream(filePath);
        fileStream.path = `audio${ext}`; // Whisper가 확장자로 형식 판별
        const response = await openai.audio.transcriptions.create({
          file: fileStream,
          model: "whisper-1",
          language: "ko",
          response_format: "text"
        });
        return typeof response === "string" ? response : response.text || "";
      });

      // 임시 파일 삭제
      fs.unlink(filePath, () => {});

      return res.status(200).json({ ok: true, text, length: text.length });
    } catch (e) {
      fs.unlink(filePath, () => {});
      return res.status(500).json({ ok: false, message: "Whisper 변환 실패: " + e.message });
    }
  });
}
