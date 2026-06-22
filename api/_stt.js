// api/_stt.js - 청크 전사 공통 모듈 (모델 선택 + verbose_json 세그먼트 + 글로벌 offset 보정)
// transcribe.js(레거시 직접 호출)와 worker.js(백그라운드)가 공유. 토큰은 env에서만.
import OpenAI, { toFile } from "openai";
import { collapseRepeats, isHallucinatedSegment } from "./_meeting.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// SAP/ERP 전문용어 - Whisper 인식 정확도 향상용 프롬프트 (A6: 기존 유지·확장)
export const SAP_PROMPT = "SAP, ERP, ABAP, BAPI, IDoc, BOM, MRP, QM, PP, MM, SD, FI, CO, WM, PM, S/4HANA, ECC, 모듈, 트랜잭션, 인터페이스, 배치, 마스터데이터, 자재마스터, 구매오더, 생산오더, 품질검사, 검사로트, 입고, 출고, 재고, 워크플로우, 커스터마이징, 컨피그, 스프린트, 고도화, 마이그레이션, 롤아웃, 표준화, 단위테스트, 통합테스트, 컷오버, 운영이관.";

// 타임스탬프 지원 여부는 모델명 하드코딩이 아니라 "응답에 segments 있는지"로 최종 판정한다.
// 다만 요청 시 verbose_json은 timestamps 지원 모델에만 보낸다(현재 whisper-1).
export function modelSupportsTimestamps(model) {
  return String(model || "whisper-1") === "whisper-1";
}

async function retry(fn, times = 3) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  throw lastErr;
}

// buffer 1개 전사 → { text, segments:[{start,end,text}], duration, hasTimestamps }
// offsetSec: 앞 청크들의 누적 실제 길이 → 세그먼트 start/end를 글로벌 타임라인으로 보정 (A1)
export async function transcribeBuffer({ buffer, ext = ".wav", lang = "ko", model = "whisper-1", prevText = "", offsetSec = 0 }) {
  const useTs = modelSupportsTimestamps(model);
  return await retry(async () => {
    const file = await toFile(buffer, `audio${ext}`);
    // prevText는 반복 환각을 제거해 다음 청크 프롬프트로 전파되지 않게 한다(연쇄 반복 차단).
    const cleanPrev = collapseRepeats(String(prevText || "")).slice(-200);
    const params = { file, model, prompt: SAP_PROMPT + (cleanPrev ? " " + cleanPrev : ""), temperature: 0 }; // 정확도: 결정적(greedy) 디코딩
    if (lang && lang !== "auto") params.language = lang;
    params.response_format = useTs ? "verbose_json" : "text";
    const resp = await openai.audio.transcriptions.create(params);

    // 모델이 verbose_json을 안 줬거나 text만 온 경우(데이터 기반 판정) — 반복 환각 축소.
    if (typeof resp === "string") return { text: collapseRepeats(resp), segments: [], duration: 0, hasTimestamps: false };
    const hasSegs = Array.isArray(resp.segments) && resp.segments.length > 0;
    if (!hasSegs) return { text: collapseRepeats(resp.text || ""), segments: [], duration: Number(resp.duration || 0), hasTimestamps: false };

    const off = Number(offsetSec) || 0;
    // 무음/반복 환각 세그먼트 제거 → 남은 세그먼트에서 텍스트 재구성 + 반복 축소.
    const kept = resp.segments.filter(s => !isHallucinatedSegment(s));
    const segments = kept.map(s => ({
      start: Number(s.start || 0) + off,
      end: Number(s.end || 0) + off,
      text: collapseRepeats(String(s.text || "").trim()),
    })).filter(s => s.text);
    const text = collapseRepeats(segments.map(s => s.text).join(" "));
    return { text, segments, duration: Number(resp.duration || 0), hasTimestamps: true };
  });
}

export { openai };
