# STT 정확도 개선 — 테스트 리포트 (ralph 누적)

검증 명령: `node --check api/*.js lib/*.js` + `node --test test/*.test.js`

## 회차 1 — 항목 2/5/6 (도메인 사전 분리 + 후처리 교정 + 저신뢰 로깅)
- 신규 `lib/sttTerms.js`: `SAP_TERMS`, `SAP_PROMPT`, `CORRECTIONS`, `applyCorrections`.
- `api/_stt.js`: 프롬프트/교정 단일화(import), 전사 결과에 `applyCorrections` 적용, `logLowConfidence`(avg_logprob<-0.9) 추가.
- `api/transcribe.js`: 죽은 SAP_PROMPT/retry 제거(중복 출처 제거).
- 신규 `test/sttTerms.test.js`(6) + 기존 `test/meeting.test.js`(16) 회귀.

| 항목 | 결과 |
|------|------|
| node --check (api/*.js, lib/*.js) | 통과 |
| node --test (sttTerms + meeting) | **21/21 pass, 0 fail** |
| 회귀(전사 잘림 없음, prompt 빌더) | 유지 |
