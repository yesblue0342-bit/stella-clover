# STT 정확도 개선 진행 (ralph)

## 0단계: 대상 코드 식별 (완료)
전사 코드가 이 저장소에 존재함. NO_CLOVER_CODE_HERE 아님.

| 파일 | 역할 |
|------|------|
| `api/_stt.js` | **STT 핵심 호출부.** `transcribeBuffer()` — OpenAI `audio.transcriptions.create`. 모델 `whisper-1`(기본), `verbose_json` 세그먼트, 글로벌 offset 보정, `temperature:0`, SAP 프롬프트, prevText 연속성. |
| `api/transcribe.js` | 레거시 직접 호출 엔드포인트(청크 1개 업로드 → `_stt.js`). |
| `api/worker.js` | 백그라운드 전사 워커(Drive 청크 → `_stt.js`, resume/idempotent). |
| `api/_meeting.js` | 전처리 순수 함수: `collapseRepeats`, `isHallucinatedSegment`, prompt 빌더. 단위 테스트 대상. |
| `index.html` | 클라이언트 청크 분할: `audioToChunks`(120s/16kHz mono WAV) + `encodeWavSlice`. 순차 STT 호출·재시도. |
| `test/meeting.test.js` | 단위 테스트(16개). 실행: `node --test test/meeting.test.js`. |

**사용 모델: `whisper-1`** (verbose_json/timestamps 지원). temperature=0 이미 적용.

## 가정 (모호 → 합리적 결정)
- `package.json`에 test 스크립트 없음 → `node --test test/meeting.test.js`로 검증.
- 기존 진행 문서는 `STELLA_CLOVER_*`, `TEST_RESULTS.md`. ralph 지침대로 `PROGRESS.md` + `TEST_REPORT.md` 신규 사용.
- 7항목 중 **이미 구현된 것**: 1(language 고정, lang!=="auto"일 때 명시), 5 일부(temperature=0, verbose_json), 7(청크 3회 재시도+부분성공 표시). → 미비점만 보강.
- 청크 오버랩(항목4)은 offset/dedup 로직 위험 → 순수함수+테스트로 보수적 구현.

## 작업 항목 상태
- [x] 0. 코드 식별
- [ ] 2. 도메인 프롬프트 `lib/sttTerms.js` 분리 + 교정 사전
- [ ] 6. 후처리 교정 사전 일괄 치환
- [ ] 5. avg_logprob 낮은 구간 로깅
- [ ] 3. 오디오 전처리(피크 정규화 + 보수적 무음 트리밍)
- [ ] 4. 청크 경계 오버랩 + 병합 디듀프
- [x] 1. language="ko" 고정 (기존 구현 확인)
- [x] 7. 청크 실패 재시도/부분성공 (기존 구현 확인)
