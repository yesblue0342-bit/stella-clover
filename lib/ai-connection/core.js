// lib/ai-connection/core.js — AI 제공자 공용 모델 카탈로그 + 검증.
//
// CBO Review와 CBO Pre-Check가 공유하는 provider/model 상수만 여기 둔다. CBO Review 전용 프롬프트
// 빌더 등은 lib/cbo-review/core.js에 그대로 남는다(이 파일에서 재-export).
export const PROVIDER_MODELS = Object.freeze({
  openai: ["gpt-5.6", "gpt-5.5", "gpt-5.4"],
  anthropic: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  gemini: ["gemini-3.5-pro", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
});

export function validateProviderModel(provider, model) {
  const patterns = {
    openai: /^gpt-[a-z0-9][a-z0-9._-]{1,80}$/i,
    anthropic: /^claude-[a-z0-9][a-z0-9._-]{1,80}$/i,
    gemini: /^gemini-[a-z0-9][a-z0-9._-]{1,80}$/i,
  };
  if (!patterns[provider]?.test(String(model || ""))) throw new Error("허용되지 않은 AI 모델입니다.");
  return { provider, model };
}
