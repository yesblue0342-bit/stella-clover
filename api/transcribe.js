// api/transcribe.js - 음성 파일 → 텍스트 (OpenAI Whisper)
import formidable from "formidable";
import fs from "fs";
import path from "path";
import OpenAI, { toFile } from "openai";

export const config = { api: { bodyParser: false }, maxDuration: 120 };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    let ext = path.extname(originalName).toLowerCase() || ".webm";
    const allowedExts = [".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm", ".ogg", ".aac"];
    if (!allowedExts.includes(ext)) ext = ".webm"; // 알 수 없으면 webm으로 시도

    // 언어 지정: "auto"(또는 미지정)면 Whisper 자동 감지에 맡김
    const langRaw = fields.lang?.[0] ?? fields.lang ?? "ko";
    const lang = String(langRaw).trim().toLowerCase();
    // 직전 청크 전사 일부를 prompt로 전달해 문맥/용어(SAP) 연속성 확보
    const prevRaw = fields.prevText?.[0] ?? fields.prevText ?? "";
    const prevText = String(prevRaw).slice(0, 800);

    try {
      const text = await retry(async () => {
        // toFile로 안정적으로 파일 객체 생성 (확장자 명시)
        const buffer = fs.readFileSync(filePath);
        const file = await toFile(buffer, `audio${ext}`);
        const params = {
          file,
          model: "whisper-1",
          response_format: "text"
        };
        if (lang && lang !== "auto") params.language = lang;
        if (prevText.trim()) params.prompt = prevText;
        const response = await openai.audio.transcriptions.create(params);
        return typeof response === "string" ? response : (response.text || "");
      });

      fs.unlink(filePath, () => {});

      if (!text || !text.trim()) {
        return res.status(200).json({ ok: false, message: "음성에서 텍스트를 추출하지 못했습니다. (무음이거나 너무 짧은 파일)" });
      }
      return res.status(200).json({ ok: true, text, length: text.length });
    } catch (e) {
      fs.unlink(filePath, () => {});
      return res.status(500).json({ ok: false, message: "Whisper 변환 실패: " + e.message });
    }
  });
}
