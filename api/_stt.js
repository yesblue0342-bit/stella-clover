// api/_stt.js - 청크 전사 공통 모듈 (모델 선택 + verbose_json 세그먼트 + 글로벌 offset 보정)
// transcribe.js(레거시 직접 호출)와 worker.js(백그라운드)가 공유. 토큰은 env에서만.
import OpenAI, { toFile } from "openai";
import { collapseRepeats, isHallucinatedSegment } from "./_meeting.js";
import { SAP_PROMPT, applyCorrections } from "../lib/sttTerms.js";

// 지연 생성: 모듈 import 시점에 OPENAI_API_KEY가 없어도 throw하지 않게(핸들러의 graceful 가드가 동작).
let _openai;
export function getOpenAI() { if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); return _openai; }

// SAP/ERP 전문용어 프롬프트 + 후처리 교정 사전은 lib/sttTerms.js로 단일화(중복 출처 제거).
export { SAP_PROMPT };

// 타임스탬프 지원 여부는 모델명 하드코딩이 아니라 "응답에 segments 있는지"로 최종 판정한다.
// 다만 요청 시 verbose_json은 timestamps 지원 모델에만 보낸다(현재 whisper-1).
export function modelSupportsTimestamps(model) {
  return String(model || "whisper-1") === "whisper-1";
}

// A5: avg_logprob가 임계값보다 낮은(=신뢰도 낮은) 세그먼트를 로깅. 텍스트는 건드리지 않음.
// LOGPROB_WARN 임계는 환경변수로 조정 가능(기본 -0.9). Whisper는 보통 -0.5↑이 정상.
const LOGPROB_WARN = Number(process.env.STT_LOGPROB_WARN || -0.9);
function logLowConfidence(segments, off = 0) {
  try {
    if (!Array.isArray(segments)) return;
    const low = segments.filter(s => Number(s && s.avg_logprob) < LOGPROB_WARN);
    if (!low.length) return;
    const sample = low.slice(0, 5).map(s => ({
      t: `${(Number(s.start || 0) + off).toFixed(1)}s`,
      lp: Number(s.avg_logprob || 0).toFixed(2),
      txt: String(s.text || "").trim().slice(0, 40),
    }));
    console.warn(`[STT] 저신뢰 세그먼트 ${low.length}개(avg_logprob<${LOGPROB_WARN})`, JSON.stringify(sample));
  } catch (e) { /* 로깅 실패는 무시 */ }
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
    const resp = await getOpenAI().audio.transcriptions.create(params);

    // 모델이 verbose_json을 안 줬거나 text만 온 경우(데이터 기반 판정) — 반복 환각 축소 + 교정.
    if (typeof resp === "string") return { text: applyCorrections(collapseRepeats(resp)), segments: [], duration: 0, hasTimestamps: false };
    const hasSegs = Array.isArray(resp.segments) && resp.segments.length > 0;
    if (!hasSegs) return { text: applyCorrections(collapseRepeats(resp.text || "")), segments: [], duration: Number(resp.duration || 0), hasTimestamps: false };

    const off = Number(offsetSec) || 0;
    // A5: 저신뢰(avg_logprob 낮음) 구간 로깅 — 운영 로그에서 재학습/프롬프트 보강 단서. (텍스트는 보존)
    logLowConfidence(resp.segments, off);
    // 무음/반복 환각 세그먼트 제거 → 남은 세그먼트에서 텍스트 재구성 + 반복 축소 + 교정.
    const kept = resp.segments.filter(s => !isHallucinatedSegment(s));
    const segments = kept.map(s => ({
      start: Number(s.start || 0) + off,
      end: Number(s.end || 0) + off,
      text: applyCorrections(collapseRepeats(String(s.text || "").trim())),
    })).filter(s => s.text);
    const text = applyCorrections(collapseRepeats(segments.map(s => s.text).join(" ")));
    return { text, segments, duration: Number(resp.duration || 0), hasTimestamps: true };
  });
}

// getOpenAI는 위에서 export됨(_analyze.js가 사용).
