# Stella Clover 개선 — TODO (RALPH autopilot)

## 사전 조사
- [x] Clover 앱 파일 위치: index.html(프론트), api/summarize.js(회의록), api/_analyze.js(AI 요약), api/worker.js(백그라운드 잡).
- [x] STT 합본: index.html generate()가 청크 STT를 fullText로 순서대로 concat → /api/summarize에 transcript=fullText(전체) 전달(잘림 없음).
- [x] LLM 입력 추적: 회의록=summarize.js(전체 사용), AI 요약=_analyze.structuredSummary → **transcript.slice(0,24000) 잘림 발견**.

## TODO
- [x] 1. STT 원본 전체가 회의록/요약에 들어가게 — _analyze.js의 24000자 잘림 제거(전체 사용). summarize.js는 전사 전체 입력 + 너무 길면 map-reduce(부분요약→통합, 누락 0). 전처리/분할은 api/_meeting.js로 분리, 단위테스트로 "잘림 없음" 보장.
- [x] 2. 회의록/요약 정확도 — 한국어 비즈니스 회의록 형식(①기본정보 일시/장소/주제/작성일 ②참석자 ③안건별 논의 ④결정사항 ⑤Action Item(담당/기한) ⑥일정 + 핵심요약 3~5줄). 본문 없는 사실 창작 금지(없는 일시/장소=미확인), 본문 날짜·일정(8월/9월·마이그레이션 단계·리허설) 빠짐없이. 작성일=파일 메타(fileDate). 프롬프트 빌더 api/_meeting.js 분리.
- [x] 3. 제품명 "음성 텍스트" → "Stella Clover" — <title>, 헤더 로고(🍀 유지), apple/manifest. 기능 설명문("음성을 텍스트로")은 유지.

## Stella Clover 원문오픈·태그필터·정확도 (autopilot)
- [x] CL-A. 키워드/태그 클릭 필터 — 마이 탭 파일카드+상세의 🔑키워드·🏷태그를 클릭형 .kw-chip으로(escAttr 안전), filterByKeyword/filterByTag가 마이탭 전환+검색/태그 필터 적용. (jsdom 검증)
- [x] CL-B. 원문 파일 오픈 — 상세(showDetail)에 "🎙 STT 원본"(showSTT)+"☁️ 원본 파일"(Drive) 버튼 추가, 키워드 칩 클릭 가능. 원문/요약/회의록 한 화면에서 접근.
- [x] CL-C. 회의록 정확도 — 파일명 날짜(예 260612→2026-06-12) 추출(meetingDateFromName)해 회의 일시 미확인 대신 파일 날짜 사용. (유닛 2건)

## 인프라 이관 (RALPH team, 2026-06-27)
- [x] INF-1. Stella Workspace(채팅/노트/프로젝트) — 모바일 검색 클릭 불가 수정 + 기기 간 동기화(Azure SQL → 이후 PostgreSQL 일원화). workspace.html + api/workspace.js.
- [x] INF-2. Azure SQL(mssql) 전면 제거 → PostgreSQL(OCI). _db.js 재작성 + mssql 호환 셰임(_sqlshim.js) + 방언 변환(meetings/summarize/jobs/worker/workspace). (셰임 단위테스트)
- [x] INF-3. Vercel 의존 제거 → 배포 환경 중립. VERCEL_URL 제거(PUBLIC_BASE_URL), vercel dev 제거, npm test 추가, 문서 OCI화.
- [x] INF-4. raw Node 독립 실행 진입점 server.js — 정적+/api 어댑터, 본문 한도 25MB(413 차단), /api 항상 JSON(평문 파싱오류 차단), 헬스체크. (부팅 스모크 테스트)
- [x] INF-5. 반복 오류 구조적 차단 — 413(서버+nginx 한도), Unexpected token(항상 JSON), 함수 타임아웃(raw Node), 배포(OCI) 플레이북 갱신.
- [x] INF-6. 워크스페이스 서버측 소유권 스코프 — session 조회/chat/update_session/update_note 를 모두 `user_id=@u` 로 스코프 + `user` 필수 가드. 프런트(get-session·update_note)에 user 전달. (소스 회귀 테스트 4건)
- [x] INF-7. 워커 워치독 — cleanup 크론이 멈춘(>10분) transcribe_jobs 를 worker 재트리거(best-effort). 오디오 정리와 독립.
