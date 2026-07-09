# Stella Clover — 진행 기록

## [2026-07-09] 노트 탭 추가 — Google Drive 저장, Stella GPT와 노트 공유 (완료, main 직푸시 `100e531`)
- **요청**: Stella GPT(별도 앱)의 노트 기능을 Stella Clover에도 추가. 저장/검색은 Google Drive를 단일 소스로,
  Stella GPT 노트와 같은 폴더·같은 파일 포맷을 공유해 두 앱에서 같은 노트를 보고 편집할 수 있어야 함.
- **레퍼런스 조사**: `stella-ai-workspace`(Stella GPT) `api/note.js` + `lib/drive-utils.js` 분석 →
  Drive 폴더 `1Gd_4isQFTIQi0DjaDfE85IZM-tG1cClZ`, 파일명 `{id}.json`(플랫, 하위폴더 없음),
  JSON 스키마 `{id,userId,title,body,category:"노트",createdAt,updatedAt,deleted,savedAt}`(소프트 삭제) 확인.
  Drive 인증은 이미 Clover 자체 `api/_drive.js`가 동일 env(GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN)로 보유 —
  별도 인증 이관 불필요, `getDrive()` 그대로 재사용(신규 키/인프라 없음).
- **구현**:
  - `api/_drive.js`: `saveJsonToDrive`(있으면 update, 없으면 create)/`listJsonInFolder`(페이지네이션)/`readJsonById`/
    `findFileByName` 추가(순수 추가, 기존 export 무변경).
  - `api/notes.js`(신규): `list`(검색 q, deleted 제외, updatedAt desc 정렬)/`save`(id 있으면 createdAt 보존)/
    `delete`(소프트 삭제) — 항상 JSON 응답(에러도 200+ok:false), 프로젝트 절대 규칙 준수.
  - `note/index.html`(신규): 검색+목록+에디터 모달 UI. Clover 테마 토큰(`cl_theme`) 공유, `esc()`로 XSS 방어.
  - `index.html`: 앱바에 "📝 노트" 탭 버튼 추가(Chart/Rate와 동일하게 `location.href` 네비게이션).
  - `server.mjs`: `/notes`, `/stella-notes` → `note/index.html` rewrite 추가.
  - `sw.js`: 캐시 v21→v22(프론트 변경 필수 규칙).
  - `.env.example`: `STELLA_NOTES_FOLDER_ID`(선택, 기본값 Stella GPT와 동일 폴더) 문서화.
- **주의(작업 중 발견)**: 저장소 루트에 기존 개발 로그 폴더 `NOTES/`(대문자, md 3개)가 이미 존재 —
  Windows 대소문자 무시 파일시스템 때문에 최초 작성 시 `notes/index.html`이 그 폴더 안으로 잘못 들어갔다가
  발견 즉시 `note/`(단수, 대소문자 충돌 없는 이름)로 옮기고 `NOTES/`는 원상 복구. 배포 서버(OCI 우분투)는
  대소문자 구분이므로 이 정정이 없었으면 `/notes` 라우팅이 실서버에서 404 났을 것.
- **검증**: `node --check` 전체 통과, 로컬 `npm test` 83 pass/3 skip(회귀 없음), `node server.mjs` 로컬 구동 후
  `/notes`·`/stella-notes` 200 확인, `/api/notes` list/save/delete를 Drive 자격증명 없음/가짜 자격증명(invalid_client)
  두 경우 모두 curl로 직접 호출해 매번 200+JSON(`ok:false`, 스택트레이스 미노출) 확인. fresh-context 검증
  서브에이전트(oh-my-claudecode:verifier) 리뷰 결과 SHIP(blocker 0).
- **미검증(사용자 확인 필요)**: 실제 OCI 프로덕션 서버에서의 Drive 저장/조회 동작(로컬에 실제 Drive 자격증명 없어
  invalid_client 이상은 재현 불가) 및 GitHub Actions `deploy-oci.yml` 실배포 성공 여부(이 세션에 GitHub/OCI
  접근 권한 없음 — `gh` CLI 미설치, 서버 SSH 불가).

## [2026-06-28] STT `invalid_client` 근본 수정 + Stella Flow 신규 앱 (완료, 브랜치 `claude/lucid-ptolemy-xx3viy`)
- **STT 수정**: 청크를 Google Drive 왕복 → **로컬 디스크 저장**(`lib/chunkStore.js`). Drive OAuth(`invalid_client`) 와 무관하게 전사 동작.
  - 변경: `chunk-upload.js`·`jobs-runtime.js`·`audio.js`·`cleanup.js`·`deploy/run-stella-oci.sh`(볼륨)·`.env.example`·`.gitignore`.
- **Stella Flow**(`/flow`): 표/엑셀→편집형 Mermaid 플로우차트 + 이미지 Figure Lab. Drive `stellagpt/flow` 저장 + OCI `cl_flows` 메타.
  - 신규: `flow/index.html`·`api/flow.js`·`lib/flowBuild.js`. 추가: `_drive.ensurePathRooted/folderLink`·`_db.cl_flows`·`server.mjs(/flow)`·`sw v14`.
- **검증**: 단위 56 PASS/2 skip, 서버 스모크(청크 로컬 왕복·flow structure/save·audio 화이트리스트) OK, 적대적 리뷰 4차원 → 핵심 수정 반영.
- 상세: `TEST_RESULTS.md` 최상단 참조.

---

# (이전) 메타데이터 OCI Postgres 이관

> 직전 PROGRESS.md(STT 정확도)는 별개 작업 → 본 이관 작업 기록으로 대체
> (STT 작업물은 git 이력 + lib/sttTerms·sttMerge·test 에 그대로 존재).

## 1단계: 현황 (완료)
MSSQL/Azure SQL 의존은 **DB 계층에 국한**. 파이프라인(잡 큐·워커·재시작 복구·Drive 청크)은 DB 호출만 사용.

| 파일 | DB 사용 | 포팅 내용 |
|------|---------|-----------|
| `api/_db.js` | **핵심**: `import sql from "mssql"` + ConnectionPool + T-SQL DDL | → `pg.Pool` + Postgres DDL + **mssql 호환 셰임**(`request().input().query()`) |
| `lib/jobs-runtime.js` | transcribe_jobs CAS 루프(resume/idempotent) | `@p`→`$n`(셰임), `SYSUTCDATETIME()`→`now()`, `${CREATE_JOBS}` 프리픽스 제거 |
| `api/jobs.js` | transcribe_jobs INSERT(OUTPUT)/list(TOP)/detail | `OUTPUT INSERTED.job_id`→`RETURNING job_id`, `TOP n`→`LIMIT n` |
| `api/worker.js` | transcribe_jobs 상태 SELECT | 프리픽스 제거 |
| `api/meetings.js` | cl_meetings list/search/detail/rename/delete | `TOP`→`LIMIT`, `LIKE`(T-SQL `[]`이스케이프)→`ILIKE`(백슬래시 이스케이프) |
| `api/summarize.js` | cl_meetings 멱등 INSERT(T-SQL IF NOT EXISTS) | `INSERT…SELECT…WHERE NOT EXISTS` (Postgres) |

비-DB: cleanup/chunk-upload/transcribe/audio/autosave → DB 미사용(변경 없음).

## 재사용 Postgres 조사
- `guac-postgres`(postgres:16-alpine) 존재하나 **`guacamole_internal` 네트워크**(npm_default 아님), 5432 비공개.
  → stella-clover(--network npm_default)에서 직접 도달 불가. 사용자가 택1:
  1) 전용 Postgres 컨테이너를 npm_default 에 기동(권장), 또는
  2) guac-postgres 를 npm_default 에도 연결 + `stella_clover` DB 생성.
  어느 쪽이든 **DATABASE_URL** 만 .env 에 채우면 됨(코드는 연결문자열만 봄). 코드에 호스트 하드코딩 없음.

## 설계 결정 (가정)
- **mssql 호환 셰임 유지**: 규칙 "DB 호출부만 교체, 시그니처 유지" 충족.
  `getPool().request().input(name,type,val).query(tsql)` / `r.recordset` / `r.rowsAffected[0]` 그대로.
  내부에서 `@name`→`$n`(중복 이름은 동일 `$n` 재사용) 변환 후 `pg.Pool.query` 실행.
  타입 인자(`sql.Int` 등)는 무시(Proxy 마커). → 호출부 diff 최소, 회귀 위험 최소.
- **스키마 자동생성은 기동/최초 getPool 시 1회**(`ensureSchema`). 기존엔 매 쿼리에 `${CREATE_*}` 프리픽스로
  self-heal 했지만 **pg 확장 프로토콜은 멀티스테이트먼트+파라미터 불가** → 프리픽스 제거하고 getPool 보장으로 대체
  (getPool 은 모든 쿼리 직전 await 되므로 등가).
- **jobs 테이블 = 기존 `transcribe_jobs` 유지**(컬럼 그대로). PROMPT 3항의 `jobs(id UUID, file_name…)` 스키마는
  파이프라인이 실제로 쓰는 컬럼(chunk_refs/segments_json/speakers_json/summary_json/chunks_done CAS…)과 불일치.
  규칙 "파이프라인 재작성 금지/시그니처 유지/파이프라인 깨지 말 것" 우선 → **이름·컬럼 보존**, 요청된
  `status`·`created_at` 인덱스만 추가. (BIGSERIAL id, 멱등 CREATE IF NOT EXISTS.)
- BIGINT(int8) 타입파서 → Number(mssql BigInt 동작 유지: `job_id` 숫자 비교/`Number(x.job_id)` 무회귀).
- SSL 기본 off(도커 내부망). `sslmode=require`/`DB_SSL` 시 on(자체서명 허용, `DB_SSL_VERIFY=true`로 검증 강제).

## 작업 항목 상태
- [x] 1. 현황 식별 + 재사용 PG 조사
- [x] 2. `_db.js` mssql→pg 교체 + 셰임 + DATABASE_URL 우선
- [x] 3. 스키마 자동생성(cl_meetings + transcribe_jobs, status/created_at 인덱스)
- [x] 4. 소비자 쿼리 포팅(jobs/worker/meetings/summarize/jobs-runtime)
- [x] 5. .env.example Postgres 기준(PORT=8971, MSSQL 제거, DATABASE_URL) + deploy .env 검증
- [x] 6. 테스트(셰임 단위 + jobs CRUD/상태전이/복구 통합[DATABASE_URL 가드]) + node --check + SW bump
- [ ] 7. 배포(OCI Docker 재빌드 8971) — **사용자 작업**: Postgres 컨테이너를 npm_default 에 기동 +
      `stella_clover` DB 생성 → .env 에 DATABASE_URL 채우고 `bash deploy/run-stella-oci.sh`

## 변경 요약 (이번 이관)
- `api/_db.js`: `import sql from "mssql"` → `import pg`. `pg.Pool` + mssql 호환 셰임(`ShimRequest`:
  `.input(name,[type],value)` → `@name`을 첫 등장 순서대로 `$n`으로 변환, 중복 이름은 동일 `$n` 재사용,
  타입 인자 무시). `recordset`(=rows)/`rowsAffected[0]`(=rowCount) 매핑. BIGINT(OID 20)→Number 파서.
  `getPool`이 `ensureSchema`(CREATE IF NOT EXISTS + status/created_at 인덱스)를 1회 보장. `connectWithRetry`
  Postgres 코드(28xxx 인증=즉시중단, ECONNREFUSED/57P03 등=재시도). DATABASE_URL 우선, 없으면 DB_*/CL_DB_*.
  SSL 기본 off(내부망), `DB_SSL`/`sslmode=require`로 on, `DB_SSL_VERIFY`/`verify-full`로 검증 강제.
  `resolveTlsOptions`/`hasDbConfig`는 호환 위해 유지(+DATABASE_URL 인식). `sql`은 no-op 타입 마커 Proxy.
- `api/jobs.js`: `OUTPUT INSERTED.job_id`→`RETURNING job_id`, `TOP 20`→`LIMIT 20`, `${CREATE_JOBS}` 프리픽스 제거.
- `api/worker.js` / `lib/jobs-runtime.js`: `${CREATE_JOBS}` 제거, `SYSUTCDATETIME()`→`now()`. CAS/복구 로직 불변.
- `api/meetings.js`: `TOP 50`→`LIMIT 50`, `LIKE`(T-SQL `[]`)→`ILIKE`(백슬래시 이스케이프), 프리픽스 제거.
- `api/summarize.js`: T-SQL `IF NOT EXISTS … INSERT` → Postgres `INSERT … SELECT … WHERE (@asession='' OR NOT EXISTS…)`.
- `.env.example`/`.env`: PORT 8971, MSSQL 키 제거, `DATABASE_URL`(+개별 DB_* 대안) 기준. deploy 스크립트 .env 검증 Postgres화.
- `sw.js`: 캐시 v12→v13. `package.json`: 이미 `pg` 의존(`mssql` 제거됨).

## 테스트 결과
- 단위/회귀(DATABASE_URL 없음): `node --test test/*.test.js` → **39 pass / 2 skip(통합)** , 0 fail.
  - 신규 `test/db-shim.test.js`(6): `@name→$n`(중복 재사용·첫등장 순서), 2-인자 input, recordset/rowsAffected,
    parseJson, sql 마커 안전성.
  - 기존 `db-config.test.js`: DATABASE_URL 단독 true 케이스 추가(나머지 회귀 유지). `jobs-runtime`/`meeting`/`stt*` 무회귀.
- 통합(실 Postgres 16, `postgresql://…/stella_clover`): `test/jobs-db.test.js` **2 pass**.
  - transcribe_jobs: INSERT…RETURNING / READ / chunks_done CAS(성공 1행·중복 0행) / 복구 선택(summarizing 포함·done 제외) / DELETE.
  - cl_meetings: 같은 audio_session 멱등 INSERT(첫 1행, 재삽입 0행, COUNT=1).
- 핸들러 스모크(실 Postgres): POST/GET/list jobs, worker kick, meetings list/search 모두 200·정상 JSON.
- `node --check api/*.js lib/*.js server.mjs test/*.test.js` 전체 통과. `bash -n deploy/run-stella-oci.sh` 통과.

RALPH_DONE
