# Stella Clover 개선 — TODO (RALPH autopilot)

## 사전 조사
- [x] Clover 앱 파일 위치: index.html(프론트), api/summarize.js(회의록), api/_analyze.js(AI 요약), api/worker.js(백그라운드 잡).
- [x] STT 합본: index.html generate()가 청크 STT를 fullText로 순서대로 concat → /api/summarize에 transcript=fullText(전체) 전달(잘림 없음).
- [x] LLM 입력 추적: 회의록=summarize.js(전체 사용), AI 요약=_analyze.structuredSummary → **transcript.slice(0,24000) 잘림 발견**.

## TODO
- [x] 1. STT 원본 전체가 회의록/요약에 들어가게 — _analyze.js의 24000자 잘림 제거(전체 사용). summarize.js는 전사 전체 입력 + 너무 길면 map-reduce(부분요약→통합, 누락 0). 전처리/분할은 api/_meeting.js로 분리, 단위테스트로 "잘림 없음" 보장.
- [x] 2. 회의록/요약 정확도 — 한국어 비즈니스 회의록 형식(①기본정보 일시/장소/주제/작성일 ②참석자 ③안건별 논의 ④결정사항 ⑤Action Item(담당/기한) ⑥일정 + 핵심요약 3~5줄). 본문 없는 사실 창작 금지(없는 일시/장소=미확인), 본문 날짜·일정(8월/9월·마이그레이션 단계·리허설) 빠짐없이. 작성일=파일 메타(fileDate). 프롬프트 빌더 api/_meeting.js 분리.
- [x] 3. 제품명 "음성 텍스트" → "Stella Clover" — <title>, 헤더 로고(🍀 유지), apple/manifest. 기능 설명문("음성을 텍스트로")은 유지.
