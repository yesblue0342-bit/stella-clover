// lib/transcriptFix.js — STT 원문 LLM 교정 1패스 (STT 정확도 개선의 3단계).
//
// 원칙(태스크 요구): "교정만" — 용어 사전을 참고해 오인식된 전문용어 복원, 문장부호/문단 정리.
//   요약·창작·삭제 금지. 원문(raw)과 교정본을 둘 다 저장한다(호출부 책임).
// 안전장치:
//   · 창(window) 단위 처리(초장문 컨텍스트 초과 방지) — 문장 경계 분할(_meeting.splitTranscript 재사용).
//   · 교정 결과 길이가 원문 창의 [65%, 140%] 를 벗어나면(=요약/창작 의심) 그 창은 원문 유지.
//   · 어떤 창이 실패해도 전체를 실패시키지 않고 원문 유지 — 교정은 부가 단계, 전사를 볼모로 잡지 않는다.
import { getOpenAI } from "../api/_stt.js";
import { SAP_TERMS } from "./sttTerms.js";
import { splitTranscript } from "../api/_meeting.js";

const MODEL = "gpt-4.1-mini";
const WINDOW_CHARS = 6000;

function buildSystemPrompt() {
  return `당신은 한국어 회의 STT(음성 인식) 전사 교정기입니다. 아래 규칙을 엄격히 지키세요.

[허용되는 작업 — 이것만]
1. 음성 인식 오류로 보이는 단어를 문맥에 맞게 교정 (특히 아래 용어 사전의 전문용어).
2. 문장 부호(마침표/쉼표/물음표) 보정과 문단 나누기.
3. 명백한 중복 더듬음("그 그 그")의 최소 정리.

[금지 — 위반 시 실패]
- 요약하거나 문장을 짧게 줄이지 마세요. 내용 순서를 바꾸지 마세요.
- 원문에 없는 문장/정보를 추가(창작)하지 마세요.
- 발언 내용을 다듬어 다른 표현으로 바꾸지 마세요(원 단어 유지, 오인식 교정만).
- 설명/머리말/코드블록 없이 교정된 본문 텍스트만 출력하세요.

[용어 사전 — 오인식 교정 시 우선 참고]
${SAP_TERMS.join(", ")}`;
}

// 창 1개 교정. 실패/이상 출력 시 null 반환(호출부가 원문 유지).
async function correctWindow(text) {
  const resp = await getOpenAI().chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 8000,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: text },
    ],
  });
  const out = (resp.choices?.[0]?.message?.content || "").trim();
  if (!out) return null;
  const ratio = out.length / Math.max(1, text.length);
  if (ratio < 0.65 || ratio > 1.4) return null; // 요약/창작 의심 → 원문 유지
  return out;
}

// 전사 전체 교정. 반환: { corrected, windows, failedWindows }.
// 모든 창이 실패해도 corrected 는 항상 유효(실패 창은 원문 그대로) — 교정 단계가 파이프라인을 막지 않는다.
export async function correctTranscript(rawText) {
  const raw = String(rawText == null ? "" : rawText).trim();
  if (!raw) return { corrected: raw, windows: 0, failedWindows: 0 };
  const parts = splitTranscript(raw, WINDOW_CHARS);
  const out = [];
  let failed = 0;
  for (const p of parts) {
    let fixed = null;
    try { fixed = await correctWindow(p); } catch (e) { fixed = null; }
    if (fixed == null) { failed++; out.push(p); }
    else out.push(fixed);
  }
  return { corrected: out.join("\n"), windows: parts.length, failedWindows: failed };
}

export default { correctTranscript };
