# Stella Clover — 개발 레퍼런스

> AI 음성 회의록 자동 생성 PWA. **이 문서는 Stella Clover 개발 시 먼저 읽는다.**
> 레포: `yesblue0342-bit/stella-clover` (★비공개★ — Claude Code에서 레포 선택해 작업, 채팅/raw 접근 불가)
> 배포: stella-clover.vercel.app (Vercel, GitHub main 연동 자동 배포)

## 아키텍처
- **배포 현실**: ★ **OCI 우분투 Docker(`server.mjs`, 포트 8971) 단일 장수 프로세스** — Vercel 미사용.
  `api/*.js`(export default handler)를 자체 Express 서버가 실행. main push → `deploy-oci.yml` → SSH 재빌드.
- **프론트(단일 파일)**: `index.html`(변환/마이 SPA). `talk.html`·`db.html`·**`flow/index.html`(Stella Flow)** 는 별개 앱.
- **백엔드 `api/`** (OCI 인프로세스, 함수 시간제한 없음):
  | 파일 | 역할 |
  |------|------|
  | `chunk-upload.js` | 오디오 청크 1개를 **로컬 디스크**(lib/chunkStore)에 저장 → ref `local:<sess>/<NNN>.wav` 반환. ★Drive 미사용 |
  | `jobs.js` / `worker.js` | 백그라운드 전사 잡 생성·상태조회 / 워치독(재펌프). 처리는 `lib/jobs-runtime.js` |
  | `audio.js` | 청크 재생 스트리밍(로컬 ref → 디스크, 레거시 ref → Drive) |
  | `transcribe.js` | (레거시 직접 호출) Whisper STT. 공통 모듈 `_stt.js` |
  | `summarize.js` | gpt-4o-mini 구조화 회의록 + Drive 백업 + cl_meetings. Drive 실패해도 graceful(warnings) |
  | `meetings.js` | cl_meetings 목록/검색/상세/삭제. **항상 JSON** |
  | `flow.js` | ★ **Stella Flow**: 표→Mermaid 구조화(structure) / Drive `stellagpt/flow` 저장(save) / 목록(list). 공통 `lib/flowBuild.js` |
  | `cleanup.js` | 매일 1회 보존기간(10일) 지난 청크 정리(로컬 주, Drive 레거시 베스트에포트) |
  | `_db.js` | OCI Postgres 공유 풀 + 스키마(`cl_meetings`/`transcribe_jobs`/`cl_flows`) + mssql 호환 셰임 |
  | `_drive.js` | Google Drive 헬퍼(`ensurePath`=stellaclover 루트, `ensurePathRooted`=임의 루트, `folderLink`) |
- **오디오 청크 저장**: ★ **OCI 서버 로컬 디스크**(`CHUNK_DIR`=기본 `/app/data/chunks`, 도커 명명 볼륨 `stella-clover-data:/app/data`).
  과거 Drive 왕복 → `invalid_client`(Drive OAuth 거절) 시 전사 전체 실패하던 회귀를 제거. Drive 인증과 무관하게 전사 동작.
- **저장소**: Google Drive(회의록 `stellaclover/Meeting/YYYY/YYYYMM`, 전사 `AI_Report`, 메타 `Metadata`; Flow `stellagpt/flow/<생성시각_제목>`)
  + OCI Postgres(`cl_meetings`·`cl_flows` 메타+검색). Drive 는 **백업/공유용** — 실패해도 결과는 DB 로 보존.
- **클라이언트 전용(localStorage/IndexedDB)**: 폴더·태그·프로필·내 AI 지침·세션·최근 녹음 캐시.

## ★ 절대 규칙 (어기면 장애 재발) ★
1. **청크 크기 = 120초 / 16kHz mono WAV ≈ 3.84MB. 절대 5MB로 올리지 말 것.**
   Vercel 본문 한도 ~4.5MB → 초과 시 **413**. moyo(self-hosted)는 5MB지만 우리는 아님.
   UI 문구는 "청크 분할 업로드"처럼만, 깨지는 숫자 박지 말 것.
2. **신규 API 키·신규 라우트 만들지 말 것 (청구 중복 0).** 기존 인프라 재사용.
3. **모든 api 핸들러는 에러 시에도 항상 JSON 반환** (try/catch 래핑 + `Content-Type: application/json`).
   프런트는 **`safeJson(res.text()→JSON.parse)`** 로 방어 — 평문에도 "Unexpected token" 금지.
4. **HTML 내장 JS를 GitHub Contents API(PUT)로 패치할 때** 정규식/문자열의 `\n`→`\\n`, 백틱/`${}`/따옴표 이스케이프 주의. (Write 툴로 직접 파일 쓰면 해당 없음)
5. 커밋 전 검증: `node --check api/*.js`, 인라인 JS는 `new Function`으로 파싱, `vercel.json`은 **`JSON.parse`**(node --check는 JSON 검증 아님).
6. **시크릿(OpenAI 키, GitHub PAT, DB 비번)을 코드·로그·커밋·CLAUDE.md에 절대 노출 금지.** 노출 시 즉시 폐기.

## 환경변수 (OCI `.env`, `deploy/run-stella-oci.sh`)
- Postgres: `DATABASE_URL` 단독 또는 `DB_SERVER`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`(+ `DB_PORT`). (구 `CL_DB_*` 도 인식)
- OpenAI: `OPENAI_API_KEY` (Whisper + gpt-4o-mini + gpt-4.1-mini 공용 — Flow AI 정리도 동일 키 재사용)
- Google Drive: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (회의록/Flow 결과 백업·저장용. 청크는 Drive 미사용)
- 청크 저장 경로(선택): `CHUNK_DIR`(기본 `/app/data/chunks`) — 도커 볼륨 매핑
- 동시 전사 상한: `JOBS_CONCURRENCY`(기본 2) · 크론 보호: `CRON_SECRET`

## 알려진 오류 플레이북 (재발 시 여기부터)
1. **"Failed to fetch" / 413 (대용량)**: 청크 3.84MB 유지 점검. 청크당 3회 재시도, **한 청크 실패해도 전체 중단 금지**(`[구간 N 변환 실패]` 표시 후 계속, 전부 실패 시만 throw). 413은 재시도 무의미.
2. **Azure SQL 타임아웃 ("Failed to connect ... in Nms")**: serverless **auto-pause** 콜드스타트. `_db.js`에 `connectionTimeout/requestTimeout: 30000` + `connectWithRetry`(3회/3s, **타임아웃·연결오류만** 재시도, 인증오류 `ELOGIN`/18456은 즉시 중단). 호출 함수 maxDuration ≥ 60 확보.
3. **이력 JSON parse 실패 ("Unexpected token … is not valid JSON")**: 함수 타임아웃 시 Vercel 평문 에러 페이지. → api 항상 JSON + 프런트 `safeJson`. cl_meetings 스키마 ↔ SELECT 컬럼 정렬(`_db.js` `CREATE_TABLE`에 ALTER ADD 가드).
4. **Vercel 배포 실패**: `vercel.json` 검증(`JSON.parse`). stella-clover는 flat `api/*.js` + per-file `export const config = { maxDuration }` 사용(functions 블록 없음). **중복 Vercel 프로젝트**가 빨강 찍으면 대시보드에서 그 프로젝트만 정리(코드 문제 아님).
5. **일반 fetch 오류**: `fmtErr(e)` 사용 — `err.name`+message, "Failed to fetch"→네트워크 설명, 응답 status+본문 일부 surface.
6. **"청크 업로드 실패: invalid_client"(전사 전부 실패)**: Google OAuth 토큰 교환 거절(client_id/secret/refresh_token 불일치·만료).
   ★ 해결됨 — 청크는 더 이상 Drive 로 안 올린다(`lib/chunkStore` 로컬 저장). Drive 인증 깨져도 전사는 동작.
   재발 시: chunk-upload/audio/jobs-runtime 이 다시 Drive 경로로 회귀했는지 확인. (최종 회의록 Drive 백업 실패는 warnings 로 graceful.)

## 개발 워크플로
1. 큰 작업 전 **백업 브랜치** `backup-clover-<YYYYMMDD-HHMMSS>` 생성·푸시.
2. `index.html`/`api/` 현황 파악 → 수정 → `node --check`/`new Function` 검증.
3. 작은 단위 incremental 커밋, **main 푸시**(태스크 기본값; Vercel 자동 배포).
4. **SW 캐시 버전 bump** (`sw.js` `const CACHE='stella-clover-vNN'`) — 프론트 변경 시 필수. 현재 **v14**.
5. 시크릿 스캔 후 커밋.
6. 작업 종료 시 `TEST_RESULTS.md` 갱신.
7. ※ 샌드박스는 Vercel Deployment Protection(403)으로 라이브 URL 직접 확인 불가 → 코드 정적 검증까지. 실제 동작은 사용자 브라우저에서.

## 프론트 구조 (index.html)
- 앱바: 🍀 음성 텍스트 로고 + 탭(변환/마이) + 사용자칩 + 🌙 다크토글 + 로그아웃.
- **변환 탭**: 4단계 카드(번호+상태뱃지 대기/진행중/완료) — 1 파일선택(녹음/드래그)+회의언어 13개+고급옵션(OCR) / 2 업로드중(%) / 3 AI변환중 / 4 완료(요약+TXT+복사·키워드·표·링크·Drive). 하단 회의록 이력.
- **마이 탭**: 통계 4종(파일수/총글자/AI분석/지침개수) + 내 AI 지침(CRUD→summarize `userInstruction`) + 검색·필터 + 폴더 칩 + 타입 탭(전체/STT/회의록/AI요약) + 파일 카드(공유/이동/태그/정보/STT/삭제).
- **테마**: CSS 변수 토큰(`:root` 라이트 / `[data-theme=dark]` 다크), `prefers-color-scheme` 초기 기본, `localStorage('cl_theme')`.
- **회의 언어 13개**: 다국어(auto)/ko/en/ja/zh/vi/th/es/fr/de/id/ru/ar. summarize `LANG_NAMES`와 일치 유지.

## Stella Flow (`flow/index.html`, `/flow` 경로)
- 별개 SPA(Clover 테마/다크 공유 `localStorage('cl_theme')`). 앱바: 🔀 로고 + 탭(표→플로우 / 이미지 다듬기) + 🍀 Clover 링크 + 🌙.
- **표→플로우차트**: 엑셀(.xlsx/.xls, SheetJS CDN)·CSV·붙여넣기 → `POST /api/flow?action=structure`(AI gpt-4o-mini 정리, 실패/키없음 시 `lib/flowBuild.rowsToMermaid` 로컬 폴백) → **편집 가능한 Mermaid 텍스트**(입력 시 자동 재렌더, Mermaid CDN `securityLevel:strict`, `htmlLabels:false`) → PNG/SVG/복사/Drive 저장.
- **이미지 다듬기(Figure Lab)**: 붙여넣기(Ctrl+V)/드래그/선택 → 캔버스 파이프라인(자동 여백 트림·패딩·밝기/대비·라운드·그림자 프레임·캡션, 과대 이미지 1400px 다운스케일) → PNG/Drive 저장.
- **저장**: `POST /api/flow?action=save` → Drive `stellagpt/flow/<YYYYMMDD_HHMM_제목>`(생성마다 새 폴더) 에 `.mmd/.svg/.png/.json` 업로드 + OCI `cl_flows` 메타 INSERT. **Drive·DB 어느 쪽이 실패해도 나머지는 저장**(warnings 반환).
- 변환 핵심은 순수함수 `lib/flowBuild.js`(클라이언트·서버 공유 규칙) — 테스트 `test/flowBuild.test.js`.

## 브랜딩
- "Stella Clover" 유지. 참고 앱(clover.moyo.pw)은 서드파티 → **소스/이름/로고/푸터 문구 복제 금지**, UI·플로우만 재현.
