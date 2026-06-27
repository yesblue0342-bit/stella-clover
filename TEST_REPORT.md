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

## 회차 2 — 항목 3/4 (오디오 정규화 + 청크 오버랩 디듀프)
- `index.html` `encodeWavSlice`: 피크 볼륨 정규화(게인 상한 8x, 무음 미증폭) — 타이밍 불변.
- `index.html` `audioToChunks`: i>0 청크 시작을 overlap(3s)만큼 앞당겨 겹쳐 자름. 청크 수 불변.
- 신규 `lib/sttMerge.js`: `dedupOverlapTokens`(꼬리/머리 토큰 겹침 제거) + index.html 인라인 복제.
- 병합 루프에 dedup 적용(첫 청크 원형, 이후 중복 제거).
- SW 캐시 v9 → **v10** bump(프런트 변경 반영).

| 항목 | 결과 |
|------|------|
| index.html 인라인 JS (`new Function`) | 통과(1 block) |
| node --check (sw.js, lib/sttMerge.js) | 통과 |
| node --test (전체 4 파일) | **27/27 pass, 0 fail** |
| 청크 크기(123s≈3.94MB<4.5MB) | 한도 내 |
