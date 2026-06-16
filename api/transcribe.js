// api/transcribe.js - 음성 청크 → 텍스트 (OpenAI Whisper)
// 클라이언트가 분할/압축한 청크를 받아 처리
import formidable from "formidable";
import fs from "fs";
import path from "path";
import OpenAI, { toFile } from "openai";

export const config = { api: { bodyParser: false }, maxDuration: 300 };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// SAP/ERP 전문용어 - Whisper 인식 정확도 향상용 프롬프트
const SAP_PROMPT = "SAP, ERP, ABAP, BAPI, IDoc, BOM, MRP, QM, PP, MM, SD, FI, CO, WM, PM, S/4HANA, ECC, 모듈, 트랜잭션, 인터페이스, 배치, 마스터데이터, 자재마스터, 구매오더, 생산오더, 품질검사, 검사로트, 입고, 출고, 재고, 워크플로우, 커스터마이징, 컨피그, 스프린트, 고도화, 인터페이스, 마이그레이션, 롤아웃.";

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

    try {
      const text = await retry(async () => {
        const buffer = fs.readFileSync(filePath);
        const file = await toFile(buffer, `audio${ext}`);
        const response = await openai.audio.transcriptions.create({
          file,
          model: "whisper-1",
          language: "ko",
          prompt: SAP_PROMPT + (prevText ? " " + prevText : ""),
          response_format: "text"
        });
        return typeof response === "string" ? response : (response.text || "");
      });

      fs.unlink(filePath, () => {});
      return res.status(200).json({ ok: true, text: text || "", length: (text || "").length });
    } catch (e) {
      fs.unlink(filePath, () => {});
      return res.status(500).json({ ok: false, message: "Whisper 변환 실패: " + e.message });
    }
  });
}
