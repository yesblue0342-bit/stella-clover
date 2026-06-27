# Stella Clover — 재설계 + 오류 근본 수정 TEST RESULTS

생성일: 2026-06-19 · 백업 브랜치: `backup-clover-20260619-045010`

## (A) 고친 오류 — 원인 · 조치
| # | 오류 | 원인 | 조치 | 상태 |
|---|------|------|------|------|
| 1 | 대용량 "Failed to fetch" / 413 | 청크 1개 실패 시 전체 중단 / 5MB 초과 시 413 | 청크 120s/16kHz mono WAV(≈3.84MB) **유지**(5MB 금지). 청크당 3회 재시도 + **한 청크 실패해도 `[구간 N 변환 실패]` 표시 후 계속**, 전부 실패할 때만 throw. 413은 재시도 안 함. 슬라이스 인코딩으로 전체를 메모리에 안 올림 | ✅ |
| 2 | Azure SQL auto-pause 콜드스타트 타임아웃 | serverless DB 재개 전 짧은 타임아웃에 끊김 | `_db.js` connection/requestTimeout **30s** + `connectWithRetry`(3회/3s, 타임아웃·연결오류만 재시도, 인증오류 즉시 중단). `meetings.js maxDuration 60` | ✅ (이전 커밋 7d2e09d) |
| 3 | 이력 JSON parse 실패 (Unexpected token) | 함수 타임아웃 시 Vercel 평문 에러 페이지를 `r.json()`이 파싱 | `meetings.js` 모든 분기·catch가 **항상 JSON**(+Content-Type). 프런트 `safeJson(res.text()→JSON.parse)` 전 fetch 적용 → 평문에도 한국어 메시지 | ✅ |
| 4 | Vercel 배포 실패 | functions glob 불일치 | stella-clover `vercel.json`은 functions 블록 없이 **per-file `export const config` maxDuration** 사용(flat api/). `JSON.parse`로 검증 통과, rewrites 실제 라우트와 매칭 | ✅ |
| 5 | 일반 "Failed to fetch" 노출 | err 그대로 표시 | `fmtErr(e)`: `err.name`+message, TypeError/failed to fetch→"네트워크 연결 실패", 응답 status+본문 일부 surface | ✅ |

## (B) 참고 화면 재현 — 체크리스트
**메인(변환) 화면**
- [x] 헤더: 좌 "🍀 음성 텍스트" 로고 + 탭(변환/마이) + 사용자명 칩 + 🌙 다크토글 + ⎋ 로그아웃
- [x] 타이틀 "음성을 텍스트로" + 부제(자동 압축·분할 / 모바일·대용량 끊김없이)
- [x] 4단계 카드(번호 뱃지 + 상태 뱃지 대기/진행중/완료)
  - [x] 1 파일 선택(드래그/탭 + 녹음), 포맷(mp3·m4a·wav·mp4·webm·ogg·flac·aac), "최대 수 GB · 청크 분할 업로드", 회의 언어 13개, 고급옵션(OCR) 접기/펼치기, 변환 시작
  - [x] 2 업로드 중("청크 분할 전송" % 진행)
  - [x] 3 AI 변환 중("Whisper API 처리 → 회의록 작성" 진행)
  - [x] 4 변환 완료(요약 + TXT 다운로드 + 복사/키워드/표/링크/Drive)
- [x] 회의 언어 13개: 다국어/한국어/English/日本語/中文/Việt/ไทย/Español/Français/Deutsch/Indonesia/Русский/العربية (기존 12 + `ar` 보강)

**MY PAGE(마이)**
- [x] "OOO님의 이력" + 이메일 + "변환 이력과 AI 분석 결과를 관리합니다"
- [x] 통계 카드 4종: 변환 파일 수 / 총 글자수 / AI 분석 건수 / 내 AI 지침 개수 (이력 데이터에서 계산)
- [x] [내 AI 지침] 카드(개수 뱃지) — 추가/삭제, 요약 시 `userInstruction`으로 전달
- [x] 검색바: 파일명/주제/참석자 + 태그(쉼표) + 필터 드롭다운 2개(폴더·정렬) + 초기화

**파일 목록**
- [x] 폴더 칩: +새 폴더 / 전체 파일 / 폴더 없음 / 사용자 폴더
- [x] 타입 탭: 전체 / STT 원본 / 회의록 / AI 요약
- [x] 파일 카드: 🎙️ + 파일명 + (날짜·글자수[·요약자수]) + 상태아이콘(📋 회의록, ✨ AI요약, ☁️ Drive) + 액션[공유/이동/태그/정보/STT/삭제]

**공통**
- [x] 다크/라이트 토글(🌙) — CSS 변수 토큰, `prefers-color-scheme` 초기 기본, localStorage 저장
- [x] 푸터 "POWERED BY OPENAI WHISPER · Stella Clover" (moyo 문구 미복제, 브랜딩 유지)
- [x] 모바일 우선 반응형(통계 2열↔4열, 카드 가로 여유)

## (C) 백엔드 — 유지·안정화
- [x] transcribe: Whisper + SAP 프롬프트 + lang + prevText 연속성 (변경 없음)
- [x] summarize: gpt-4o-mini 구조화 회의록 + 선택 언어 + **"내 AI 지침"(userInstruction) 반영**(신규 라우트 0, 기존 라우트 재사용)
- [x] 저장: Drive(Meeting/AI_Report/Metadata) + **PostgreSQL** cl_meetings (2026-06-27 Azure SQL→PostgreSQL 마이그레이션, 아래 (E) 참조)
- [x] 신규 API 키·라우트 0 → **청구 중복 0**

## 검증
- `node --check`: 전 api/*.js + sw.js 통과
- index.html 인라인 JS `new Function` 파싱 OK (34,647 chars)
- 기능 체크리스트 13/13 통과(탭·13언어·ar·다크·4단계·통계·지침·userInstruction·safeJson·120s유지·5MB금지·푸터·fmtErr)
- `vercel.json` `JSON.parse` 통과 · 시크릿 스캔 0
- SW 캐시 `stella-clover-v2 → v3`

## 폴더/태그/프로필/지침 = 클라이언트 저장 (가정 로그)
백엔드에 폴더·태그·사용자 계정 라우트가 없고 "신규 라우트 금지" 제약이 있어,
폴더·태그·프로필·AI지침은 **localStorage**(이 기기)로 구현. 회의록 본문/검색은 PostgreSQL/Drive.
로그인은 별도 인증 백엔드가 없어 **로컬 프로필**(이름/이메일)로 대체.
※ 단, Stella Workspace(채팅/노트/프로젝트)는 기기 간 동기화를 위해 **PostgreSQL**(`ws_*`)에 저장한다.

## 배포 상태
- **2026-06-27 이후: OCI(Ubuntu) 배포** (Vercel에서 독립). 소스=GitHub, 데이터=Google Drive, 메타데이터=OCI PostgreSQL.
- (이전: main 푸시 → Vercel 자동 배포 — 레거시.) 샌드박스는 라이브 URL 직접 확인 불가 — 코드/문법/테스트 정적 검증까지. 실제 동작은 OCI 배포본/브라우저에서 확인.

## 2026-06-21 (autopilot) · 재업로드/요약확대/정확도 · pass 6/6
- node --check api/summarize.js·_stt.js·transcribe.js·worker.js·jobs.js OK (5/5)
- index.html 인라인 JS new Function bad=0
- jsdom: 재업로드 시 applyFile → resultArea 숨김·badge2 '대기'·badge1 '완료'·genBtn 활성 / onFileSelect input.value='' 비움(같은 파일 재업로드 가능) ✅
- grep: summarize "상세 논의 내용"·"정확도 최우선"·"10~16줄"·max_tokens 4000·temperature 0.2 / _stt temperature:0 확인
요약 3줄:
1. CV1(재업로드 버그)=핵심: 같은 파일 재선택 change 미발화 + 결과/단계 미초기화 → onFileSelect value 비우기 + applyFile 상태 초기화로 근본 수정.
2. CV2: 요약을 10~16줄+상세 논의 내용(반 페이지) 섹션으로 확대, max_tokens 4000.
3. CV3: 사실충실/창작금지 지침 + 요약 temp 0.2 + Whisper temp 0으로 정확도 향상(모델은 비용상 gpt-4o-mini 유지).

## 2026-06-21 (RALPH clover) · STT 전체 반영 + 한국어 비즈니스 회의록 + 브랜딩 · pass 8/8
- node --check api/_meeting.js·summarize.js·_analyze.js·worker.js OK · node --test test/meeting.test.js 8/8
- 잘림 제거 확인: api/ 내 slice(0,24000) 0건. prepareTranscript 50K/100K 길이 유지, splitTranscript join==원본(누락 0).
- 프롬프트 빌더: 6개 섹션+핵심요약+제목/키워드 마커, 작성일(fileDate) 반영, 창작금지·일정 빠짐없이 지침 포함. 제목/키워드 추출 정규식 호환.
요약 3줄:
1. AI 요약 입력이 24000자에서 잘리던 것 제거 → 전사 전체 사용. summarize는 전체 입력 + >40K는 map-reduce(부분요약→통합)로 누락 0.
2. 회의록을 한국어 비즈니스 형식(기본정보/참석자/안건별/결정/Action Item/일정+핵심요약)으로 재작성, 작성일=파일메타, 본문 없는 사실 창작 금지·본문 일정 전부 반영.
3. 제품명 음성 텍스트→Stella Clover(🍀 유지), 기능 설명문 유지. SW 캐시 v5→v6.

## FINAL (RALPH clover)
- node --test 8/8 PASS. 변경: api/_meeting.js(신규), api/summarize.js, api/_analyze.js, index.html(fileDate+브랜딩), sw.js v6, test/meeting.test.js(신규).
- 한 줄: STT 전사 전체가 회의록·AI요약에 잘림 없이 반영 + 한국어 비즈니스 회의록 정확도 + Stella Clover 브랜딩.

## 2026-06-21 (RALPH clover2) · 원문오픈+태그필터+정확도 · pass 10/10
- node --check api/_meeting.js·summarize.js OK · node --test test/meeting.test.js 10/10(meetingDateFromName 2건 신규) · index 인라인 파싱 bad=0
- jsdom: filterByKeyword→mySearch 반영, filterByTag→myTags 반영+검색 비움, escAttr 따옴표 제거, 에러 0
- meetingDateFromName: 260612/20260612/2026-06-12 추출, 비정상(회의록/261399) "" 거부
요약 3줄:
1. 키워드/태그 칩을 클릭형(.kw-chip)으로 만들고 filterByKeyword/filterByTag로 마이탭 전환+필터 적용 → "태그 클릭 시 필터 안 됨" 해결.
2. 상세 모달에 STT 원본·원본 파일(Drive) 버튼 추가 → 원문/요약/회의록을 한 화면에서 열람.
3. 파일명 날짜를 회의 일시로 활용해 "미확인" 대신 실제 날짜 표기 → 회의록 정확도 개선. SW 캐시 v6→v7.

## FINAL (RALPH clover2)
- node --test 10/10 PASS. 변경: api/_meeting.js(meetingDateFromName), api/summarize.js, index.html(클릭필터+상세버튼+kw-chip CSS), test/meeting.test.js, sw.js v7.
- 한 줄: 키워드/태그 클릭 필터 + 상세에서 원문 파일 오픈 + 파일명 날짜로 회의 일시 정확도 개선.

## (E) 2026-06-27 (RALPH team / autopilot) · Azure SQL → PostgreSQL(Ubuntu/OCI) 마이그레이션 · pass 23/23
> 증상: "azure 걷어내고 우분투로 교체했는데 메타데이터만 azure에서 읽어옴" → 원인은 `_db.js`가 여전히 `mssql`(Azure SQL)이었던 것. 모든 DB 소비자를 단일 PostgreSQL 풀로 일원화.

**검증**
- `node --check api/*.js` 전부 통과(14/14) · `node --test test/meeting.test.js test/db.test.js` **23/23 PASS**(기존 16 + 신규 셰임 7)
- 소비자(meetings/summarize/jobs/worker/workspace)에 잔여 T-SQL(mssql/CL_DB_/SYSUTCDATETIME/NVARCHAR/OUTPUT INSERTED/sys.tables/IDENTITY/TOP N/COL_LENGTH) **0건**
- `vercel.json`/`package.json`/`manifest.json` `JSON.parse` 통과 · 시크릿 스캔 0
- 멀티에이전트 감사 1회(5 스캐너+머지) + 적대적 검증 1회 — 마이그레이션 PG-유효 확인, 발견된 사전 버그 반영

**변경**
- `_db.js`: `mssql`→`pg`. 풀 싱글턴 + mssql 호환 셰임(`request().input(@name).query()` 유지) + `ensureSchema`(콜드스타트 1회, ws_* 포함) + PostgreSQL 방언 DDL(SERIAL/BIGSERIAL·TEXT·TIMESTAMPTZ·IF NOT EXISTS). `int8`(job_id) 타입파서로 Number 반환.
- `_sqlshim.js`(신규): `@name`→`$n` 변환(중복명 동일 $n) + `sql` 타입 토큰. pg 비의존 → 단위 테스트 7건.
- `meetings.js`: `TOP 50`→`LIMIT 50`, `LIKE`+대괄호→`ILIKE`+`\` 이스케이프, CREATE 프리픽스 제거, `hasDbConfig()` 가드.
- `summarize.js`: 인라인 T-SQL CREATE+INSERT → 순수 `INSERT`.
- `jobs.js`: `OUTPUT INSERTED`→`RETURNING`, `TOP 20`→`LIMIT 20`. `worker.js`: `SYSUTCDATETIME()`→`now()`.
- `workspace.js`: 자체 INIT_SQL/ensureDb 제거(중앙화), env 가드 추가, `delete_project` 트랜잭션화, 입력 길이 클램프.
- `package.json` mssql→pg · `vercel.json` `/api/workspace` rewrite 추가(누락 수정).
- 사전 버그 개선: job_id 문자열↔숫자 불일치(타입파서), 워커 self-trigger 호스트 스푸핑(VERCEL_URL 고정), 워크스페이스 입력 검증.

**가정(autopilot)**: "우분투/OCI" 자체호스팅 관계형 DB = PostgreSQL로 가정. 연결은 `DATABASE_URL` 우선, `PG*` 폴백, `PGSSL`로 SSL 제어. 상세 PROGRESS.md.

**환경변수 조치 필요(사용자)**: Vercel/OCI에 `DATABASE_URL`(또는 `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD`) + 필요 시 `PGSSL=require` 설정. 구 `CL_DB_*`는 미사용.

## FINAL (RALPH team / PostgreSQL 마이그레이션)
- node --test **23/23 PASS** · node --check api/*.js 14/14 · 잔여 Azure 추적 0(소비자).
- 변경: api/_db.js(재작성), api/_sqlshim.js(신규), api/{meetings,summarize,jobs,worker,workspace}.js, package.json, vercel.json, CLAUDE.md, PROGRESS.md(신규), test/db.test.js(신규).
- 한 줄: Azure SQL(mssql) 전면 제거 → 자체 호스팅 PostgreSQL(Ubuntu/OCI) 일원화. 메타데이터·워크스페이스 단일 진실원천, 호환 셰임으로 호출부 안정.

## (F) 2026-06-27 (RALPH team) · Vercel 의존 제거 → OCI 배포 정합 · pass 24/24
> 맥락: Vercel 무료화·독립, 배포는 OCI(Ubuntu), 소스=GitHub, 데이터=Google Drive, 메타데이터=OCI PostgreSQL. 직전 SSRF 수정에서 들어간 `VERCEL_URL`을 사용자가 지적 → 배포 환경 중립화.
- **기능 변경(코드)**: `jobs.js`/`worker.js` `baseUrl()` — `VERCEL_URL` 제거 → `PUBLIC_BASE_URL`/`APP_BASE_URL` + forwarded 헤더 폴백(OCI LB 뒤에서 정확). 셀프 트리거가 배포처 무관 동작.
- **비기능/문서**: `cleanup.js` 주석 "Vercel Cron"→OCI crontab(예시 추가) / `package.json` `vercel dev` 제거 + `test` 스크립트 추가(=`node --test test/*.test.js`, `npm test` 동작) / `index.html` 청크 주석 "Vercel 4.5MB"→"서버 본문 한도" + **sw v9→v10** / `CLAUDE.md` 배포·환경변수·플레이북 OCI화.
- **보존(삭제 안 함)**: `vercel.json`, `export const config={maxDuration}` — OCI에선 무시되는 레거시 호환. 삭제 시 가동 중 OCI 설정 파손 위험 → 문서로 무력화 명시.
- **검증**: node --check api/*.js 14/14 · `npm test` **24/24 PASS** · 코드/설정 잔여 Vercel 결합 0(문서 외) · index.html `new Function` 파싱 OK · JSON 설정 `JSON.parse` OK · 시크릿 0.
- **사용자 조치**: OCI에 `DATABASE_URL`(또는 `PG*`)·`OPENAI_API_KEY`·`GOOGLE_*`·`CRON_SECRET`·`PUBLIC_BASE_URL` 주입 / cleanup은 OCI crontab으로 `/api/cleanup` 호출.

## FINAL (RALPH team / Vercel→OCI)
- `npm test` **24/24 PASS** · node --check api/*.js 14/14 · 코드 내 `VERCEL_URL`/`vercel dev` 0건.
- 변경: api/{jobs,worker,cleanup}.js, package.json, index.html, sw.js(v10), CLAUDE.md, PROGRESS.md, TEST_RESULTS.md.
- 한 줄: 배포 의존을 Vercel→OCI로 중립화. 코드는 `PUBLIC_BASE_URL`/forwarded 헤더로 배포처 무관, 크론은 OCI crontab, 시크릿은 OCI 주입. DB는 Google Drive(데이터)+OCI PostgreSQL(메타데이터) 유지.

## (G) 2026-06-27 (RALPH team) · raw Node 독립 서버 + 반복오류 구조적 차단 · pass 31/31
> "raw Node 구조" 발전적 개선 + "반복 오류 재발 방지" 요청 반영. 의존성 0 `server.js`로 OCI 직접 구동.
- **server.js(신규)**: 정적(html/sw/manifest) 화이트리스트 서빙 + SPA 폴백 + `/api/*` 동적 라우팅 어댑터(`req.query`/`req.body`/`res.status().json()` 제공). `/healthz`. `npm start`.
- **반복오류 구조적 차단**:
  · 413 — 본문 한도 `MAX_BODY_BYTES`(25MB), transcribe는 rawBody(formidable)로 우회. 한도 초과 시 **Connection: close** 정상 종료(소켓 RST/'socket hang up' 방지). 앞단 nginx `client_max_body_size 30m` 문서화.
  · "Unexpected token"(평문) — `/api/*`는 import 실패/throw/미응답 어떤 경우에도 **항상 JSON**. (회귀 테스트: 의존성 없는 핸들러 로드 실패도 JSON 응답 확인)
  · 함수 타임아웃 콜드컷 — raw Node라 인위적 함수 타임아웃 없음(`server.requestTimeout` 10분).
- **추가 폴리시(검증 반영)**: transcribe 콜백 응답 보호(자동 204 금지) / `OPENAI_API_KEY` 미설정 시 summarize·workspace chat이 친절한 JSON 메시지(500 대신).
- **검증(적대적 워크플로 verdict=ship, mustFix 0)**: node --check api+server 15/15 · `npm test` **31/31 PASS**(부팅 스모크 7 포함) · 라이브 부팅 curl(`/healthz`·`/`·`/api/*` JSON·정적) OK.
- **알려진 한계(이번 범위 외·기존)**: 워크스페이스/잡 권한은 클라이언트 제공 `user`/`userId` 신뢰(전용 인증 백엔드 없음 — 로컬 프로필 모델). 백그라운드 잡(`/api/jobs·worker`)은 아직 라이브 UI 미연결. → 추후 인증 도입 시 서버측 소유권 검증·워커 워치독 권장.

## FINAL (RALPH team / raw Node 서버 + 반복오류 차단)
- `npm test` **31/31 PASS** · node --check api/*.js + server.js 15/15 · 라이브 부팅 검증 OK · 적대적 검증 verdict=ship.
- 변경: server.js(신규)·test/server.test.js(신규)·api/{summarize,workspace}.js(OpenAI 키 가드)·package.json(start)·CLAUDE.md·TODO.md·TEST_RESULTS.md.
- 한 줄: Vercel 없이 OCI에서 `npm start`로 구동되는 의존성 0 어댑터. 413·평문JSON·타임아웃 콜드컷 등 반복 오류를 인프라 레벨에서 구조적으로 차단.

## (H) 2026-06-27 (RALPH team) · 워크스페이스 소유권 스코프 + 워커 워치독 · pass 35/35
> 검증에서 지적된 "클라이언트 제공 id로 타인 데이터 접근" 갭을 강제 가능한 범위에서 차단. (전용 인증 백엔드는 별도 과제 — 신원=로컬 프로필 이메일.)
- **소유권 스코프(workspace.js)**: `session` 조회·`chat`(세션 SELECT+UPDATE)·`update_session`·`update_note` 를 모두 `WHERE id=@id AND user_id=@u` 로 스코프 + `user` 필수 가드. UUID 미추측성 + user 스코프로 무단 접근 차단.
- **프런트 정합(workspace.html)**: get-session·update_note 호출에 `user` 추가. **sw v10→v11**.
- **워커 워치독(cleanup.js)**: 크론이 `processing/summarizing` 인데 >10분 미갱신 잡을 골라 `/api/worker` 재트리거(best-effort, 오디오 정리와 독립, DB 미설정 시 skip). 탭 닫힘/콜드스타트로 멈춘 전사 자동 복구.
- **검증**: node --check 15/15 · `npm test` **35/35 PASS**(소유권/워치독 회귀 4건 포함: id 단독 무방비 쿼리 부재 가드 포함) · workspace.html 인라인 JS 파싱 OK.
- **남은 한계**: 신원이 클라이언트 제공 이메일이라 완전한 인증(자격증명/세션)은 아님 → 진짜 보안엔 로그인 백엔드 필요(별도 과제). 현재는 UUID+user 스코프로 실질 무단접근만 차단.

## FINAL (RALPH team / 소유권 스코프 + 워치독)
- `npm test` **35/35 PASS** · node --check 15/15 · workspace.html 파싱 OK.
- 변경: api/{workspace,cleanup}.js · workspace.html · sw.js(v11) · test/workspace.test.js(신규) · TODO.md · TEST_RESULTS.md.
- 한 줄: 워크스페이스 모든 id 기반 read/write를 user_id로 서버측 스코프(무단접근 차단) + 멈춘 전사 잡 크론 워치독으로 자동 복구.

## (I) 2026-06-27 (RALPH team) · Stella GPT 전역 검색 + Azure·Vercel 완전 독립 확인 · pass 36/36
> 증상: 사이드바 🔍 검색이 메모만 동작(채팅은 제목만). "채팅 내역" 키워드가 안 나옴. → 채팅 메시지 내용까지 전역 검색 + 결과 클릭 시 해당 위치 이동.
- **전역 검색(workspace.js `action=search`)**: 채팅(`title` + `messages` ILIKE)·노트(`title` + `content` ILIKE) 동시 검색, **본인(user_id) 스코프**, 서버측 스니펫(키워드 ±40자) + updated_at 정렬. ILIKE 와일드카드 `\` 이스케이프 + 파라미터 바인딩(인젝션 안전).
- **프런트(workspace.html)**: `doSearch` 비동기 서버 호출(레이스 가드 `_lastSearchQuery`), 스니펫 표시, `searchSelect`→채팅은 `openSession(id,q)` 후 일치 메시지로 스크롤+하이라이트(`.search-hit`), 노트는 `openNote(id,q)` 후 본문 일치 위치 select. 결과 제목·스니펫 모두 `esc()` XSS 방어. **sw v11→v12**.
- **Azure·Vercel 완전 독립(인라인 grep 확증)**:
  · Azure: `package.json`=pg only(mssql 0) · `import mssql` 0 · `CL_DB_` 코드참조 0 · 쿼리문자열 실 T-SQL 0(`sql.NVarChar`는 무해한 셰임 토큰) · DB env=`DATABASE_URL`/`PG*`.
  · Vercel: `process.env.VERCEL*` 참조 0 · `vercel` CLI 스크립트 0 · `@vercel` 의존 0 · `vercel.app` URL 0. 런타임=`server.js`(`node server.js`) 단독.
  · (잔존은 모두 doc/legacy: `vercel.json` inert, `export const config` off-Vercel 무시, .md 이력)
- **검증**: node --check api+server 15/15 · `npm test` **36/36 PASS**(검색 user 스코프 회귀 포함) · workspace.html 인라인 JS 파싱 OK.

## FINAL (RALPH team / 전역 검색 + 완전 독립)
- `npm test` **36/36 PASS** · node --check 15/15 · 런타임 Azure/Vercel 결합 0.
- 변경: api/workspace.js(action=search+스니펫) · workspace.html(검색/이동/하이라이트) · sw.js(v12) · test/workspace.test.js · TODO.md · TEST_RESULTS.md.
- 한 줄: Stella GPT 사이드바 🔍가 채팅 메시지 내용까지 전역 검색→클릭 시 해당 위치 이동. Azure·Vercel 런타임 의존 0으로 OCI 완전 독립 확인.

## (J) 2026-06-27 (RALPH team) · 검색 "결과 없음" 수정 → 하이브리드 전역 검색(프로젝트 포함) · pass 36/36
> 증상: 돋보기는 눌리나 키워드 검색 결과가 안 나옴(노트/채팅/프로젝트 미조회), 클릭 점프 검증 불가. (라이브는 구버전 풀페이지 뷰 — 백엔드 action=search 미배포 가능성.)
- **근본 원인 2가지**: ① 프로젝트가 검색 대상에서 누락. ② 검색이 서버 `action=search` 단독 의존 → 백엔드 미배포 시 전부 "결과 없음".
- **하이브리드 검색(workspace.html)**: (1) 즉시 — 이미 로드된 `_state`(action=all)로 **프로젝트명 + 채팅 제목 + 노트 제목/내용** 클라이언트 검색(배포 지연 무관 항상 동작). (2) 보강 — 서버 `action=search`로 **채팅 메시지 내용**까지 병합(중복 제거, 실패해도 로컬 결과 유지).
- **점프(클릭 이동)**: 채팅→`openSession`+일치 메시지 스크롤·하이라이트 / 노트→`openNote`+본문 위치 select / **프로젝트→사이드바 열고 펼친 뒤 스크롤·하이라이트**(`.search-hit` 일반 규칙 추가).
- **UX**: 결과 아이콘 💬채팅/📝노트/📁프로젝트 + 스니펫. 빈 결과 문구 `검색 결과 없음: "키워드"`. **sw v12→v13**.
- **검증**: workspace.html 인라인 JS 파싱 OK · `npm test` **36/36 PASS** · node --check 15/15.
- **★ 사용자 조치(중요)**: 라이브(gpt.이후.com)가 구버전이라 결과가 안 나온 것 — **workspace.html + api/workspace.js 둘 다 최신으로 재배포**(OCI: git pull → npm install → 재시작) 필요. SW v13이 캐시 자동 갱신.

## FINAL (RALPH team / 하이브리드 검색)
- `npm test` **36/36 PASS** · node --check 15/15 · workspace.html 파싱 OK.
- 변경: workspace.html(하이브리드 검색+프로젝트 점프) · sw.js(v13) · TODO.md · TEST_RESULTS.md.
- 한 줄: 노트·채팅·프로젝트 전체를 즉시(로컬)+보강(서버 메시지내용) 하이브리드로 검색하고 클릭 시 해당 글로 점프. 백엔드 배포 지연에도 결과가 비지 않음.

## 2026-06-22 · 회의 제목 변경(✏️) + 기본 날짜·시각 제목 + 최신화 · pass 12/12
- node --check api/_meeting·summarize·meetings OK · node --test 12/12(+2) · index.html new Function 파싱 OK · vercel.json JSON.parse OK · 시크릿 0 · sw v7→v8
- T1 제목변경: api/meetings.js action=rename(id+title, CREATE_TABLE 가드, 금지문자 제거, rowsAffected 확인) + index.html renameMeeting()(prompt→POST→캐시 즉시 반영) + 파일카드/이력카드 ✏️ 버튼.
- T2 기본 키 제목: _meeting.js defaultMeetingTitle/resolveMeetingTitle(KST 'YYYY-MM-DD HH:MM 회의록'). summarize.js 제목이 비거나 generic("회의록")이면 날짜+시각으로 대체. 프론트 _title 폴백도 동일.
- T3 최신화: meetings.js Cache-Control: no-store + 프론트 renderList fetch{cache:'no-store'} + 저장/삭제/제목변경 후 invalidateListCache()(stale 목록 선노출 차단).
요약 3줄:
1. 연필(✏️) 클릭으로 회의 저장 제목을 즉시 변경(서버 반영+로컬 캐시 갱신). 기존 라우트(meetings.js) 확장 — 신규 라우트/키 없음.
2. 업로드 기본 제목을 오늘날짜+지금시각 키 제목으로 → 비슷한 회의도 구분되고 최신본 식별 쉬움. 의미있는 AI 제목은 그대로 보존.
3. 목록이 브라우저/CDN 캐시로 오래된 채 보이던 "최신화 안됨"을 no-store + 캐시 무효화로 해소(새 업로드가 바로 최신으로 표시).

## 2026-06-22 · STT 반복 환각("3,3,3,…") 정확도 개선 · pass 16/16
- node --check api/* OK · node --test 16/16(+4) · index.html new Function 파싱 OK · vercel.json OK · 시크릿 0 · sw v8→v9
- _meeting.js collapseRepeats(줄 단위 n-gram 4→1 축소, 개행/정상문장 보존) + isHallucinatedSegment(no_speech_prob/avg_logprob/compression_ratio). prepareTranscript에 축소 적용.
- _stt.js: verbose_json 세그먼트 중 무음/반복 환각 제거 → 텍스트 재구성 + collapseRepeats. text-only도 축소. prevText도 정제해 다음 청크로 반복 전파 차단.
- index.html: showSTT 표시 시 collapseRepeatsClient로 기존 저장분도 깔끔히(미러).
요약 3줄:
1. Whisper가 침묵/잡음 구간에서 "3, 3, 3, …" 토큰을 폭주 반복하던 환각을, 세그먼트 메타(no_speech_prob·압축비)로 걸러내고 n-gram 반복을 maxRepeat개로 축소해 제거.
2. 핵심 원인 중 하나—반복된 청크 텍스트가 prevText(prompt)로 다음 청크에 전파돼 연쇄 반복—을 prevText 정제로 차단.
3. 신규 변환은 저장 단계에서 정제(전사/요약 모두), 기존 저장분은 STT 보기에서 표시-시점 정제. 정상 발화/개행은 보존(단위테스트로 확인).
