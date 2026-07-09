# Stella Clover — 재설계 + 오류 근본 수정 TEST RESULTS

## [2026-07-09] 노트 목록: Stella GPT 대비 체감 속도 비교 진단 + 커넥션 풀 분리/인덱스 보강

- **배경**: 직전 개선(`8634f78`)으로 `action=list`는 이미 `notes_meta`(Postgres)만 SELECT하고
  Drive OAuth 왕복을 타지 않는다. 그런데도 실사용 체감상 Stella GPT(`stella-ai-workspace`)의
  Note 패널보다 Clover `/notes` 가 느리다는 리포트 → 두 코드베이스를 실제로 열어 1:1 비교.
- **비교 대상**: Stella GPT `api/note.js`(action=list) vs Clover `api/notes.js`(action=list, 기본).
  로컬 경로 `C:\workspace\stella-ai-workspace`(origin 최신 커밋 기준 확인).

### 코드 비교로 확인한 사실
1. **Stella GPT `note.js` list는 오히려 Clover보다 구조적으로 훨씬 무겁다** — DB를 전혀 쓰지 않고
   매 요청마다 (a) 고정 폴더 Drive 파일 목록 조회 + 개별 `readJsonFromDrive`(N+1, 10개씩 배치),
   (b) `users/*/notes` 전수 스윕(`sweepScatteredUserNotes`), (c) 레거시 `Board/boards` 루트 전체
   스캔까지 수행한다. `lib/drive-utils.js`의 `getDrive()`는 **호출마다 새 OAuth2 클라이언트를
   생성**(refresh_token→access_token 재교환, 캐시 없음) — 한 번의 list 요청 안에서 이 왕복이
   수십 번 반복될 수 있는 구조. 즉 API 자체 처리량은 Clover(단일 인덱스 SELECT)가 이미 압도적으로
   가볍다 — Drive 커넥션 풀링/쿼리 인덱스 문제는 GPT 쪽에도 없고(애초에 DB 미사용), Clover
   쪽에도 이미 없음(직전 개선으로 해소).
2. **진짜 차이는 "페이지 이동 비용"**: Stella GPT 의 노트는 이미 로드된 `gpt.html` SPA 안의
   슬라이드 패널(`openNotePanel()`)로, 페이지 이동이 전혀 없다. Clover 는 `index.html` 의
   "📝 노트" 버튼이 `location.href='/notes'`로 **완전히 새 문서**(`note/index.html`)를 새로
   내려받는다 — HTML/CSS 파싱, 인라인 스크립트 재실행, SW 재등록까지 치른 "다음에야" API
   호출이 시작된다. 게다가 `note/index.html`의 SWR 메모리 캐시(`_cache`)는 **문서 인스턴스
   스코프라 매 이동마다 빈 상태로 리셋** — 매번 "불러오는 중…" 플레이스홀더 후 네트워크
   응답을 기다리는 구조였다(반면 GPT 패널은 세션 중 한 번이라도 열었으면 이후엔 사실상
   이미 열려있는 문서 위에서 API만 다시 부르는 형태이고, 최초 오픈조차 페이지 이동 지연이 없음).
   → 체감 차이의 실제 원인은 API 처리 시간이 아니라 **네비게이션 비용 + 캐시가 페이지 이동을
   못 넘는 구조**로 결론.
3. **부수 점검**(요청된 체크리스트 전부 확인): DB 풀은 이미 프로세스당 싱글턴 재사용(`getPool()`,
   `api/_db.js`) — 매 요청 새 커넥션 아님. `notes_meta.updated_at`엔 이미 `idx_notes_meta_updated_at`
   인덱스가 있었음(단, `WHERE deleted_at IS NULL` 조건과 정확히 맞는 partial index는 없었음 →
   아래 보강). 응답 페이로드는 이미 preview(200자)만 반환, `body` 없음. 인증/미들웨어 체인은
   Clover·GPT 모두 얇음(둘 다 무상태 헤더 기반, 추가 미들웨어 없음). 두 앱은 별개 OCI 컨테이너/
   프로세스라 콜드스타트 상호간섭 없음. 5분 주기 백그라운드 동기화(`lib/notesSync.js`)는 목록
   조회와 **같은 풀**(`getPool()`, max 5)을 공유하고 있었음 — 실사용 노트 수에선 미미하지만,
   요청 지침대로 분리(아래).
4. **실서버 직접 측정은 이번에도 불가**(샌드박스는 프로덕션 OCI 인스턴스에 네트워크 접근
   불가 — CLAUDE.md 개발 워크플로 7 그대로 재확인, Tailscale 경유로 접근 가능한 호스트들도
   OCI Clover 컨테이너가 아님을 확인함). 대신 임시 로컬 Postgres 16(도커, 작업 종료 후 삭제)에
   실제 스키마를 붙여 `api/notes.js` 핸들러를 직접 호출하는 방식으로 서버측 처리시간을 측정.

### 적용한 수정
1. `api/_db.js`: `notes_meta`에 **partial index** `idx_notes_meta_list ON notes_meta (updated_at DESC)
   WHERE deleted_at IS NULL` 추가(list 쿼리의 WHERE 절과 정확히 일치, 기존 `idx_notes_meta_updated_at`
   보다 더 좁고 빠름). 스키마는 기존 관례대로 `CREATE_NOTES_META`(idempotent, 기동 시 자동 적용) —
   별도 `migrations/` 디렉토리가 없는 이 저장소의 기존 패턴을 따름.
2. `api/_db.js`: **`getSyncPool()`** 신규 — 5분 백그라운드 동기화(`lib/notesSync.js`) 전용 소형
   풀(max 2), 사용자 요청용 메인 풀(`getPool()`, max 5)과 완전히 분리된 별도 `pg.Pool` 인스턴스.
   `connectWithRetry()`에 pool-config override 인자 추가해 재사용.
3. `lib/notesSync.js`: `getPool()` → `getSyncPool()`로 전환(`fullScanToMeta`/`incrementalSync`
   양쪽, `action=rebuildIndex` 수동 재스캔도 내부적으로 같은 함수라 자동 적용).
4. `note/index.html`: SWR 메모리 캐시(`_cache`)를 **localStorage(`cl_notes_cache_v1`)에도 영속화**
   — 검색어 없는 첫 화면(page 0)만 대상. 스크립트 시작 시 저장된 캐시를 `_cache`에 미리 채워
   넣어, 같은 세션에서 `/notes`를 다시 열 때 네트워크 없이 즉시 첫 렌더(그 뒤 조용히 최신으로
   갱신). 저장/삭제 시 메모리 캐시와 함께 localStorage 캐시도 비움(옛 목록 재노출 방지).
5. `index.html`: `<link rel="prefetch" href="/notes">` 추가(문서 자체 프리페치) + 유휴 시간
   (`requestIdleCallback`, 폴백 `setTimeout` 1.5s)에 `/api/notes?action=list`를 백그라운드로 먼저
   호출해 **같은 localStorage 키**(`cl_notes_cache_v1`)에 채워둠 — 메인 화면을 켠 뒤 한 번도
   `/notes`를 연 적 없어도, 이후 "📝 노트" 클릭 시 이미 캐시가 따뜻한 상태. 이 두 가지가 GPT의
   "이미 로드된 패널" 체감과 가장 가깝게 Clover의 "새 문서 이동" 구조적 한계를 상쇄한다.
6. `sw.js`: `v25` → **`v26`**(프론트 변경 규칙에 따른 필수 캐시 버전 bump).

### 검증
- `node --check api/_db.js api/notes.js lib/notesSync.js server.mjs` 전체 통과.
- `note/index.html`·`index.html` 인라인 `<script>` `new Function()` 파싱 통과(문법 오류 없음).
- `npm test`: **83 pass / 6 skip(DATABASE_URL 미설정 통합 테스트, 무관) / 0 fail** — 기존 회귀 없음.
- 임시 로컬 Postgres 16(도커, `postgres:16-alpine`, 작업 종료 후 컨테이너 삭제)에 실제 스키마를
  붙여 `notes_meta` 500건 시드 후 확인:
  - `EXPLAIN`: 목록 쿼리가 신규 `idx_notes_meta_list`를 **Bitmap Index Scan**으로 사용(순차
    스캔 아님).
  - `api/notes.js` 핸들러를 직접 호출(mock req/res)해 `action=list` 서버측 처리시간 5회 측정:
    **1~2ms**(로그: `[notes] list 1ms rows=30 page=0 q=no`) — 이전 세션 로컬 측정치(`2ms`, 3건)와
    500건 규모에서도 동일 수준 유지, DB 쿼리 자체는 병목이 전혀 아님을 재확인.
  - `getPool()`과 `getSyncPool()`이 **서로 다른 `pg.Pool` 인스턴스**임을 확인. 동기화 풀에서
    커넥션 하나를 1.5초간 붙잡아둔(`pg_sleep(1.5)`) 상태에서도 메인 풀을 쓰는 `action=list`
    요청은 **2ms**로 즉시 응답 — 풀 분리가 실제로 동기화 작업의 커넥션 점유로부터 목록 조회를
    보호함을 검증.
- **미실행(이번에도 불가, 다음 확인 필요)**: 프로덕션 OCI TTFB 실측(`curl -w
  '%{time_starttransfer}'`) 전/후 비교. 배포 후 `[notes] list Nms` 컨테이너 로그로 서버측
  처리시간만 우선 확인 가능(코드상 1~2ms대 유지가 기대치), 클라이언트 체감(네비게이션+프리페치
  효과)은 실제 브라우저에서 "📝 노트" 클릭 시 로딩 없이 바로 목록이 보이는지로 확인 필요.
- 기존 기능 회귀 없음 확인: `action=save/delete/get`는 이번 변경(메인 `getPool()` 유지)과
  무관, `note/index.html` 편집/저장/삭제 로직은 캐시 무효화 지점만 보강(로직 흐름 동일),
  `server.mjs`의 5분 동기화 스케줄·전사→노트 자동저장(`pushMeetingNote`, `index.html`)도 호출
  경로 변경 없음(내부적으로 쓰는 풀만 교체).

### 남은 한계(참고, 이번 범위 밖)
- Stella GPT `api/note.js`는 이번 지시(읽기 전용) 때문에 손대지 않았다 — 위 1번 관찰대로 GPT
  쪽이 오히려 구조적으로 더 무거우므로, "GPT보다 느리다"는 체감은 API 처리량 문제가 아니라
  Clover의 별개-SPA 네비게이션 구조 문제였다는 결론이 이번 조사의 핵심. 만약 배포 후에도
  체감 차이가 남는다면 다음 유력 후보는 note/index.html 자체의 정적 자산(CSS/JS 인라인 크기)
  전송 시간 — 현재는 단일 HTML 파일이라 크지 않지만 확인 필요.

## [2026-07-09] 노트 목록 5초 병목 — Postgres notes_meta 캐시로 근본 개선

- **진단(계측 우선, 추측 배제)**: 직전 작업(아래 "노트 목록 인덱스 캐시" 항목)에서 Drive 전체 스캔
  N+1 병목은 이미 제거했지만, 실서버 TTFB 가 여전히 평균 3.206s 로 남아 있었다(응답은 인덱스
  파일 1건만 읽는데도). 그 항목 말미에 "남은 병목"으로 `getDrive()` 가 **매 요청마다 새
  OAuth2 클라이언트를 만들어 refresh_token→access_token 을 새로 교환**하는 왕복이 Drive API
  호출 자체보다 클 가능성을 남겨뒀다 — 이번 작업의 실제 원인이 바로 이것이었다(의심 순위 (d)).
  list 요청이 Drive 를 **전혀** 타지 않게 만들지 않는 한 이 OAuth 왕복은 구조적으로 계속 남는다.
- **적용한 수정(요청 아키텍처 그대로)**:
  1. `api/_db.js`: `notes_meta`(id, drive_file_id, title, preview, keywords, source, updated_at,
     deleted_at) + `notes_sync_state`(증분 동기화 커서) 테이블 추가, `updated_at DESC` 인덱스.
     `withTransaction(fn)` 헬퍼 추가 — mssql 호환 셰임(`request().query()`)은 호출마다 풀에서
     커넥션을 새로 빌리므로 BEGIN/COMMIT 이 다른 커넥션에 걸릴 수 있어 트랜잭션에 안전하지
     않다는 걸 확인, `pool._pg`(원본 pg.Pool)에서 커넥션 하나를 고정해 사용하도록 별도 구현.
  2. `api/notes.js` 전면 재작성: **목록/검색(`action=list`, 기본)은 `notes_meta` 만 SELECT —
     핸들러 전체에서 이 경로만 `getDrive()` 를 호출하지 않는다**(OAuth 왕복 자체가 발생하지
     않음). 페이지네이션(30건, `LIMIT 31 OFFSET`으로 `hasMore` 판별) 추가.
  3. `action=get`(본문 lazy load)은 notes_meta 에서 `drive_file_id` 를 먼저 찾아 Drive 호출을
     1회(다운로드만)로 줄임(기존엔 `findFileByName`+`readJsonById` 2회). 프런트(`note/index.html`)
     는 이미 모달을 먼저 열고 "불러오는 중…" 표시 후 본문을 채우는 구조라 별도 수정 없음.
  4. `action=save`/`delete`: `notes_meta` upsert 와 Drive 저장을 `withTransaction` 한 흐름으로
     묶어 Drive 저장이 실패하면 메타 변경이 자동 ROLLBACK 되도록 함(Drive 저장 함수에
     `knownFileId` 힌트를 넘겨 `findFileByName` 왕복도 1회 생략).
  5. `lib/notesSync.js`(신규): Drive→notes_meta 동기화 공용 로직. `incrementalSync` 는
     `modifiedTime > 커서` 만 조회해 반영(전체 재스캔 아님), 커서는 `notes_sync_state` 에 영속화
     (서버 재시작에도 유지). 커서가 없는 최초 1회만 `fullScanToMeta` 전체 스캔으로 부트스트랩.
     `server.mjs` 부팅 시 1회 + 5분 간격 실행(Stella GPT 가 Drive 를 직접 건드린 변경분도 반영).
  6. `scripts/backfill-notes-meta.mjs`(신규): 기존 노트 1회 백필(멱등, 여러 번 실행해도 안전).
  7. `note/index.html`: 목록 응답 메모리 캐시(stale-while-revalidate) — 캐시 있으면 즉시 렌더 후
     조용히 갱신, 저장/삭제 직후엔 캐시를 비워 옛 목록으로 되돌아가지 않게 함. "더 보기" 버튼으로
     페이지네이션. `sw.js` v24→v25.
- **검증**: 실제 사용 불가한 샌드박스 제약(§CLAUDE.md 개발 워크플로 7 — 라이브 URL 직접 확인 불가)
  때문에 프로덕션 TTFB 는 이 세션에서 직접 측정하지 못했다. 대신 임시 로컬 Postgres 컨테이너
  (`postgres:16-alpine`, 작업 종료 후 삭제)에 실제 스키마를 붙여 `test/notes-meta.test.js` 로
  종단 검증: `action=list` 핸들러가 Drive 를 호출하지 않고 `notes_meta` 만으로 검색·정렬
  (`updated_at DESC`)·페이지네이션에 성공, 응답에 `body` 필드가 없음(미리보기만) 확인.
  `withTransaction` 은 콜백이 throw 하면 ROLLBACK(행 없음), 성공하면 COMMIT(행 유지)을 각각
  확인. 서버 로그: `[notes] list 2ms rows=3 page=0 q=yes`(로컬 Postgres, 인덱스 3건 검색) —
  Drive OAuth 왕복이 아예 빠지므로 DB 쿼리 자체는 목표(300ms) 대비 압도적으로 여유 있다.
  `npm test` 88 pass / 1 skip(무관한 `db-config` 환경변수 테스트) / `node --check` 전체 통과.
  **실서버 확정 수치(배포 후 사용자 확인 필요)**: `curl -w '%{time_starttransfer}\n' -o /dev/null -s
  'https://<서버>/api/notes?action=list'` 로 TTFB 측정, 또는 컨테이너 로그의 `[notes] list Nms`
  라인으로 서버측 처리시간만 분리 확인 가능(핵심 타이밍 로그는 프로덕션에도 유지했다).
- **남은 한계(참고)**: `action=get`/`save`/`delete`는 여전히 `getDrive()`(OAuth 왕복)를 타므로
  개별 노트 열기/저장/삭제는 이번 개선 범위 밖(요청 스펙상 목록만 300ms 목표). Stella GPT 가
  Drive 파일을 완전히 하드 삭제(trash 아님, 소프트삭제 필드도 없이)하는 경우는 목록 스캔
  결과에서 사라지므로 `fullScanToMeta` 전체 재스캔에서도 감지되지 않는 알려진 한계(소프트
  삭제 규약을 벗어난 외부 조작 케이스, 두 앱 모두 규약을 지키는 한 발생하지 않음).

## [2026-07-09] 노트 목록 인덱스 캐시 — 실서버 TTFB 개선 측정

- 방식: `stellaclover/notes-index/_index.json`(공유 노트 폴더 밖, Stella GPT 영향 없음)에
  `{id,title,preview(200자),date,updatedAt}` 요약만 캐시. list 액션은 이 인덱스 1회만 읽음
  (과거: 노트 개수만큼 Drive `files.get` 반복 — 59건 기준 6배치 순차 다운로드).
- fresh-context 검증(oh-my-claudecode:verifier)에서 실제 데이터 유실 버그 발견·수정:
  편집 진입 시 본문을 `action=get`으로 재조회하는 동안 플레이스홀더 "불러오는 중…"이
  textarea에 그대로 들어가 있어, 그 사이 저장을 누르면 본문이 플레이스홀더 문자열로
  덮어써지는 경합이 있었음 → 본문 로딩 중 저장 버튼 비활성화로 수정.
- 배포: `main` 푸시(`62c1282`) → OCI 자동 재배포 → `sw.js v23` 실서버 반영 확인 →
  `action=rebuildIndex` 1회 호출로 인덱스 사전 생성(64건, 10.37초 — 이번만 발생하는 1회성 비용).
- **실서버 `GET /api/notes?action=list` TTFB 3회 측정 비교**:

  | | 개선 전(전체 스캔) | 개선 후(인덱스 캐시) |
  |---|---|---|
  | 평균 TTFB | 7.146s | 3.206s |
  | 평균 total | 7.625s | 3.206s(starttransfer와 거의 동일) |
  | 응답 크기 | 385,733 bytes(전체 body 포함) | 30,007 bytes(preview만) |

  TTFB **약 55% 감소**(7.146s → 3.206s), 응답 크기도 약 92% 감소. 응답 검증: `items[0]` 키가
  `id/title/preview/date/updatedAt`이고 어떤 항목도 `body` 필드를 포함하지 않음(캐시가 실제로
  쓰이고 있음을 확인, 과거 전체 스캔 경로로 새지 않음).
- **남은 병목(참고, 이번 작업 범위 밖)**: 인덱스 1개 파일만 읽는데도 3초대가 남는 건, `getDrive()`가
  매 요청마다 새 OAuth2 클라이언트를 만들어 refresh_token으로 access_token을 매번 새로 교환하기
  때문으로 보임(Drive API 호출 자체보다 OAuth 왕복이 더 클 가능성) — 토큰 캐싱/재사용은 별도 최적화
  과제로 남겨둠.

## [2026-07-09] 노트 탭 (Google Drive, Stella GPT 공유) — TEST RESULTS

- `node --check server.mjs api/notes.js api/_drive.js` + 나머지 `api/*.js lib/*.js` 전체: 통과.
- `note/index.html` 인라인 `<script>` `new Function()` 파싱: 통과. `index.html` 기존 인라인 스크립트도 추가 버튼 반영 후 재파싱 통과(회귀 없음).
- `npm test`: **83 pass / 3 skip(기존 DB 통합 스킵, 무관) / 0 fail** — 기존 회귀 없음.
- 로컬 서버 기동(`node server.mjs`, PORT 8973/8974/8975 순차):
  - `GET /`, `/notes`, `/stella-notes` → 200.
  - `GET /api/notes?action=list` (Drive env 미설정) → `200 {"ok":false,"items":[],"message":"Google Drive 환경변수 미설정 ..."}` — 크래시/평문 없음.
  - `GET /api/notes?action=list`, `POST /api/notes?action=save` (가짜 GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN, 실제 OAuth 거부 유도) → `200 {"ok":false,"items":[],"message":"Drive 오류: invalid_client"}` — 서버 크래시 없음, 스택트레이스 미노출, 항상 JSON 규칙 준수.
  - `GET /NOTES/index.html`(정정 후) → 404 확인(기존 개발로그 폴더에 UI 파일이 더는 섞여있지 않음).
- fresh-context 검증(서브에이전트, oh-my-claudecode:verifier, 이 세션 맥락 없이 코드만 보고 재검토):
  API 항상-JSON 규칙, save/delete 로직, Drive 쿼리 인젝션, Stella GPT와의 포맷 바이트 단위 비교(폴더ID/파일명/필드명 일치 확인), 라우팅 대소문자, XSS(`esc()` 적용 범위), 시크릿 하드코딩 여부 — **blocker 0, 권고: SHIP**.
- **미실행(로컬에서 불가)**: 실제 Google Drive 자격증명으로의 실제 파일 생성/조회/삭제 라운드트립(로컬에 프로덕션 자격증명 없음), OCI 프로덕션 배포 후 동작 확인.

## [2026-07-07] 백그라운드 파이프라인 서버 완결 + 원본 Drive 보관 + STT 정확도 개선 (브랜치 `claude/eager-meitner-d3dp7i`)

### 근본 원인 수정: "창 닫으면 회의록이 안 생김"
- **원인**: 전사 잡은 서버가 완료해도, 회의록 생성(/api/summarize)과 cl_meetings 이력 저장은 **폴링하던 브라우저**가 트리거 — 탭이 다시 열리지 않으면 영영 실행되지 않음.
- **수정**: `lib/minutes.js`(회의록/백업/이력 코어) 분리 → `lib/jobs-runtime.js` finalizeJob 이 서버에서
  correcting(LLM 교정) → summarizing(회의록+이력 저장) → uploading(원본 Drive 보관) → done 까지 완결.
  산출물 컬럼(corrected_text/minutes_md/meeting_id/audio_drive_id) 체크포인트로 재시작/재시도 멱등.

### 업로드 재설계: 브라우저 디코딩 제거(모바일 메모리 폭주 해소)
- 클라이언트 decodeAudioData 전체 디코딩 → **File.slice 바이트 조각(3.5MB) 업로드**로 교체.
- 서버 조립(assembleSource, 누락 파트 검출·512MB 상한) → **ffmpeg 전처리**(loudnorm -16LUFS, 모노 16kHz, silencedetect 무음 정렬 분할 + 6초 오버랩, 청크 ≤120초=3.84MB 절대 규칙 준수).

### STT 정확도: 용어 사전 JSON + gpt-4o-transcribe + LLM 교정 1패스
- `config/stt-terms.json`: 프롬프트 용어(QM/EWM/HU/MIC/Usage Decision/CBO/검사로트/검사계획/핸들링유닛/Celltrion/BISON/US11/US1N 등)와 교정 정규식 — 사용자 편집 가능, 로드 실패 시 내장 폴백.
- 기본 모델 gpt-4o-transcribe(계정 미지원 404 시 whisper-1 자동 폴백). language=ko 명시(기존 유지).
- `lib/transcriptFix.js`: gpt-4.1-mini 교정 1패스 — "교정만" 엄격 프롬프트 + 길이 편차 가드(65~140% 밖이면 원문 유지) + 창 실패 시 원문 유지(비차단). 원문(transcript_raw)과 교정본 둘 다 저장.
- 전/후 비교 하니스 `scripts/stt-compare.mjs`(OPENAI_API_KEY 필요 — 서버에서 실행).

### 원본 오디오 Drive 보관(디스크 잔존 0)
- 잡 완료 시 원본을 Drive 폴더 `1ap3oDMkYlTnK5YXI2yR0-ZiHlrgp-1r8`(env DRIVE_AUDIO_FOLDER_ID)로 스트리밍 업로드(지수 백오프 3회) → 성공 시 로컬 임시 전량 삭제, 실패 시 잡 실패 표시(회의록은 저장됨) + 파일 보존 + '다시 시도' 버튼(/api/worker?retry=1).
- cl_meetings 에 audio_drive_id/link 저장 → 상세 모달 🎧 원본 오디오, 완료 잡 타임라인 재생은 보관 원본 스트리밍(/api/audio 화이트리스트).
- 잔여 파일 이전: `scripts/migrate-audio-to-drive.mjs`(드라이런 기본 — 목록/용량 보고, `--apply` 시 이전+삭제, 진행 중 잡 세션 보호).

### 검증 (이 세션에서 실제 실행한 것)
- 단위/통합 테스트 **84 pass / 0 fail** (`npm test`; ffmpeg 통합 포함 — 합성 300초 오디오 무음 2곳에서 3분할·오버랩·loudnorm 증폭 검증).
- **로컬 E2E(실서버 프로세스 + 로컬 Postgres16 + 가짜 OpenAI(OPENAI_BASE_URL))**:
  파트 3개 업로드→잡 생성→ffmpeg 전처리(3청크)→STT(사전 교정 '검사 로트→검사로트','에이밥→ABAP' 확인)→LLM 교정 저장→회의록/제목/키워드 생성→**cl_meetings 저장(브라우저 개입 0)**→Drive 자격증명 없음 시 "원본 오디오 Drive 보관 실패(회의록은 저장됨)" + 파일 보존 확인.
- **서버 재시작 복구**: preparing 중 kill -9 → 재기동 로그 "[jobs] 부팅 복구: 미완료 잡 1건 재개" → 파이프라인 이어서 진행 확인.
- **재시도 멱등**: worker?retry=1 후 회의록 중복 저장 없음(1건 유지), 실패 단계만 재실행.
- 키 없는 환경에서 전 구간 STT 실패 시: "[구간 N 변환 실패]" 세그먼트 + 잡 error("음성에서 텍스트를 추출하지 못했습니다") graceful 확인.
- **적대적 코드리뷰(다중 에이전트, 관점별 병렬 + 발견별 2인 검증)**: 확정 결함 6건 수정·검증 —
  (1) 원본 조립 쓰기 스트림 'error' 무리스너 → 프로세스 크래시 위험(파트 append 방식으로 교체),
  (2) [high] cl_meetings 이력 저장 실패를 통과시켜 done 종결 → 이력 영구 유실(error 마킹+재시도로 수정),
  (3) 전 구간 STT 실패 잡의 '다시 시도'가 재전사 없이 같은 오류 반복(chunks 되감기 수정 — E2E 로 장애 복구 후 재시도 1번에 완주 확인),
  (4) 레거시 클라이언트 이중 마무리/이어보기(resume_<jobId>) 중복 이력(멱등 쇼트서킷 + 잡 실세션 치환 — E2E 확인),
  (5) 보존기간 정리 후 재시도 시 원본 유실이 done 으로 은폐(명시적 error 로 수정 — E2E 확인),
  (6) 부팅 recover 원샷 한계(매시간 재실행 추가). 기각 8건(검증 에이전트가 발생 불가/이미 수정으로 반박).
  ※ 리뷰 6관점 중 정합성·동시성 2관점은 완주, 보안·호환·프론트·자원 4관점은 세션 한도로 중단(부분 커버리지) —
  해당 영역은 본 세션의 수동 점검(경로탈출/화이트리스트/esc XSS/레거시 플로우 E2E)으로 보완했다.
- **미검증(시크릿 필요 — 서버에서 확인 필요)**: 실제 OpenAI 모델 호출 품질(gpt-4o-transcribe 실전 정확도), 실제 Drive 업로드 성공 경로, 실 회의 음성 전/후 비교(scripts/stt-compare.mjs 로 실행).


## [2026-07-01] 장시간 회의 업로드 안정화 + 차트/환율 메뉴 탭 (브랜치 `claude/stella-clover-improvements-v35rsr`)

### A. 1~2시간 회의 업로드/변환 중단 방지 (탭 닫아도 이어짐)
- **근본 원인**: 잡(job)은 서버에서 자동 재개되지만, **잡 생성 전 청크 업로드 단계**(1~2시간 = 수십 청크)에서 탭을 닫으면 잡이 아직 없어 전부 유실. 또 한 청크가 재시도를 모두 실패하면 업로드 전체가 throw 되어 중단.
- **수정 (`index.html`)**:
  - 업로드 시작 **전에** 오디오를 IndexedDB 저장 + `clover_pending_upload`(localStorage) 복구 레코드 생성. 청크 하나 올릴 때마다 `uploadedRefs` 갱신.
  - 페이지 로드 시 `resumePendingUpload()`: 끊긴 업로드가 있으면 캐시 오디오를 다시 청크로 나눠 **남은 구간만** 이어서 업로드 → 잡 생성. `chunk-upload` 은 `(sessionId,index)` 로 멱등이라 재업로드 안전.
  - 청크 재시도 3→5회 + 지수 백오프(≤8s). 업로드 진행 중에만 `beforeunload` 이탈 경고(잡 생성 후엔 서버가 이어서 처리하므로 경고 없음).
  - 절대 규칙 준수: 청크 120초/16kHz mono WAV(≈3.84MB) 유지, 신규 API 키·라우트 0.

### B. 장시간 회의 요약 정확도 (`api/_analyze.js`)
- 구조화 요약(`structuredSummary`)이 초장문 전사에서 컨텍스트 초과로 통째 실패(=summary null)하지 않도록 `clampForStruct`(기본 90k자, 앞 60%+뒤 40% 표본화·중략 표기) 추가. 최종 회의록은 `summarize.js` map-reduce 로 전체 반영(기존 유지).

### C. 차트 만들기 + 환율 계산기 메뉴 탭
- **차트**: Clover 앱바에 `📊 차트` 탭 추가 → 기존 Stella Flow(`/flow`, 표→플로우차트) 로 이동.
- **환율 계산기(신규 `rate/index.html`, `/rate`·`/currency`·`/stella-rate`)**: 대상국가 **한국(₩)·미국($)·일본(¥)·베트남(₫)**. 금액 입력 시 4개 통화 동시 환산, 3D 그라디언트 카드(광택·호버 rotateX/Y). 무키(no-key) 공개 환율 API(open.er-api.com → exchangerate.host 폴백) + localStorage 캐시 + 오프라인 근사 폴백. 신규 키 0.
- Clover 앱바에 `💱 환율` 탭, Flow 앱바에 `💱 환율` 링크, Rate 앱바에 🍀 Clover·🔀 Flow 링크(상호 이동). 테마(`cl_theme`) 공유. `server.mjs` rewrite + `sw.js` v14→**v15**.

### 테스트 결과 (샌드박스, Node)
| # | 항목 | 결과 |
|---|------|------|
| 1 | `node --check` 전체 api/lib/server | **전부 OK** ✅ |
| 2 | 인라인 JS `new Function` 파싱: index/flow/**rate**/talk/db | **전부 OK** ✅ |
| 3 | `npm test`(node --test) | **56 PASS / 2 skip(라이브 DB) / 0 fail** ✅ |
| 4 | 서버 부팅 → `/`, `/rate`, `/currency`, `/flow` | **전부 200** ✅ |
| 5 | Clover 앱바 `📊 차트`·`💱 환율` 탭 렌더 | ✅ |
| 6 | 환율 환산 로직(KRW↔USD↔JPY↔VND, 항등변환) | ✅ 정상 |
| 7 | `clampForStruct` 초장문 표본화 길이 | ✅ 한도 준수 |
| 8 | 시크릿 스캔 | 0 ✅ |

> 참고: 라이브 URL 은 배포 후 사용자 브라우저에서 확인(샌드박스는 정적/기동 검증까지). 재개 로직은 잡 생성 전 새로고침 시 남은 구간부터 업로드됨을 코드 경로로 검증.

### D. 환율 계산기 레이아웃 → 계산기 스타일 + 사칙연산 지원 (후속)
- 참고 이미지(통화 행 스택 + 숫자 키패드) 형태로 `rate/index.html` 전면 재구성. 통화 행(🇰🇷🇺🇸🇯🇵🇻🇳) 위, 하단에 숫자 키패드(C · ← · ↕ · ÷ × − + = %).
- **핵심: 사칙연산 실제 동작**(참고 앱은 안 됨). `eval` 미사용 자체 파서(× ÷ 우선순위 → + −), 물리 키보드 입력 지원, `=` 계산, `←` 지우기, `%` 백분율, `↕` 기준통화 순환, 통화 행 탭 시 환산값 이어받아 기준 전환.
- 상태바: 환율 새로고침(↻) · `1 KRW = … USD` + 갱신시각 · 정보(ⓘ). `sw.js` v15→**v16**.

| # | 항목(후속) | 결과 |
|---|------|------|
| 9 | 인라인 JS `new Function` 파싱(rate 재작성) | OK ✅ |
| 10 | `evalExpr` 사칙연산 12케이스(우선순위·연쇄·소수·꼬리연산자) | **전부 정답** ✅ |
| 11 | `1,000,000 KRW → USD/JPY/VND` 환산 | ✅ 정상 |
| 12 | 서버 `/rate` 200 + 키패드 렌더 | ✅ |

### E. 반복 재발 `invalid_client` 청크 업로드 오류 — 영구 재발 차단 (후속)
- **증상(사용자 스크린샷)**: "구간 1/12 업로드 실패: 청크 업로드 실패: invalid_client" → 전사 전부 실패.
- **진단**: 이 오류 문구("청크 업로드 실패")는 **옛 Drive 기반 chunk-upload** 에만 존재. 현재 main/OCI 배포본(`bd7e82a`, 배포 로그상 Docker 재빌드·헬스체크 통과 확인)은 이미 로컬 저장(`lib/chunkStore`)으로 고쳐져 이 문구를 낼 수 없음 → **구버전 캐시(오래된 PWA)** 가 옛 화면/응답을 계속 서빙해 재발.
- **영구 수정(재발 방지 가드)**:
  1. `test/no-drive-in-upload.test.js` — `chunk-upload.js` 가 `_drive`/`getDrive`/Drive API 를 다시 부르면 **테스트 실패**(회귀 즉시 차단). 옛 "청크 업로드 실패" 문구 잔존도 금지. `jobs-runtime` 로컬 ref 우선 처리 확인.
  2. `sw.js` v16→**v17**: 앱 셸(HTML/네비게이션) **network-first** 로 항상 최신 프론트 수신 + 오래된 캐시 삭제. 정적 자산만 캐시 폴백.
  3. `index.html`: 새 SW가 제어 넘겨받으면 **1회 자동 새로고침**(고친 프론트 즉시 반영). 업로드 중 `invalid_client` 응답(구버전) 감지 시 재시도 중단 + "완전 새로고침 안내" + SW 강제 갱신.

| # | 항목(후속 E) | 결과 |
|---|------|------|
| 13 | `no-drive-in-upload` 가드 3케이스(클린 통과) | ✅ |
| 14 | 회귀 시뮬레이션(getDrive() 재도입) → 가드 검출 | ✅ 실패로 잡힘 |
| 15 | `npm test` 전체 | **59 PASS / 2 skip / 0 fail** ✅ |
| 16 | 서버 `/sw.js` = `stella-clover-v17` 서빙 | ✅ |

### F. 업로드 UX/속도 + OCI 용량 관리 (후속)
- **"이전 업로드를 이어받는 중입니다…" 오류성 메시지 제거**: 잡 생성 전 클라이언트 업로드-재개(pending-upload) 기능 자체를 제거(혼란 문구 + 원본 저장 원인). 서버측 잡 재개(잡 생성 후 탭 닫아도 완료)는 그대로 유지.
- **업로드 속도 향상**: 청크를 **동시 4개 병렬 업로드**(워커풀). 순서·완주 보장, 최대 동시수 ≤ 4. 청크 크기(120초/3.84MB) 절대 규칙 유지. 업로드 끝난 blob 즉시 해제(메모리 절약).
- **원본 오디오 미저장**: 업로드 전 IndexedDB 원본 저장 제거(기기·서버 용량). 청크만 전송 → 텍스트 변환.
- **OCI 디스크 용량 관리**: 전사 **완료 즉시** 해당 세션 로컬 청크 전량 삭제(`chunkStore.deleteSession`, `jobs-runtime` done 직후). 실패해도 일일 cleanup 이 백업 회수.

| # | 항목(후속 F) | 결과 |
|---|------|------|
| 17 | `node --check` 전체 + 인라인 JS(index/flow/rate) 파싱 | OK ✅ |
| 18 | `npm test`(chunkStore deleteSession/sessionOfRefs 3건 추가) | **62 PASS / 2 skip / 0 fail** ✅ |
| 19 | 병렬 업로드 워커풀 시뮬(12·1·37·3청크) — 순서·완주·동시수≤4 | ✅ |
| 20 | pending-upload/원본저장 코드 완전 제거 확인(잔존 0) | ✅ |
| 21 | `deleteSession` 경로탈출/빈세션 거부 | ✅ |
| 22 | `sw.js` v17→**v18** 서빙 | ✅ |

> 주: 전사 완료 후 청크를 지우므로 타임라인 '세그먼트 오디오 재생'은 완료 후 불가(텍스트·요약·타임라인 표시는 유지). 용량 관리 우선 요구에 따른 의도적 트레이드오프.

### G. STT 원본 텍스트 표시 + 이력 지속성(마이그레이션) (후속)
- **STT 원본 텍스트(전체 원문) 결과에 표시**: 변환 완료(4단계) 카드에 접이식 "🎙 STT 원본 텍스트 (전체 원문)" 섹션 추가 — 요약본 외 전체 원문 확인. 원문 복사/📄 원문 TXT 다운로드. 세션 저장/복원(`_transcript`)·OCR 경로도 원문 표시. (마이 탭 상세의 기존 🎙 STT 원본 버튼도 유지)
- **이전 파일 안 보임 → 목록 상한 상향**: `meetings.js` 목록 `LIMIT 50` 하드캡 제거 → `limit`(기본 500·최대 1000)+`offset` 페이지네이션(`hasMore` 반환). 검색도 50→200.
- **프로그램 개정 시 마이그레이션**: `_db.js` `ensureSchema` 에 idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS`(cl_meetings/transcribe_jobs/cl_flows) 추가 — 옛 배포로 만든 테이블에 신규 컬럼 자동 backfill, 파괴적 구문(DROP/DELETE) 없음. 실패해도 기동 계속. `sw.js` v18→**v19**.

| # | 항목(후속 G) | 결과 |
|---|------|------|
| 23 | `node --check` 전체 + 인라인 JS(index/flow/rate) 파싱 | OK ✅ |
| 24 | `npm test`(history-migration 3건 추가) | **65 PASS / 2 skip / 0 fail** ✅ |
| 25 | 마이그레이션 SQL: 핵심 컬럼 ADD COLUMN IF NOT EXISTS + 파괴적 구문 없음 | ✅ |
| 26 | `meetings.js` LIMIT 50 제거 + offset/hasMore | ✅ |
| 27 | 서버 `/` STT 원본 섹션 렌더 + `/sw.js` v19 + `/api/meetings` graceful JSON | ✅ |

### H. 원본 인식 품질 — Whisper 문장 반복 환각 축소 (후속)
- **증상(사용자 스크린샷)**: STT 원문에 같은 문장("Q. 4,5일에 개발을 시작하겠습니까?", "Q. QM에 대한 리뷰도 중요하지 않겠습니까?")이 15~20회 반복 → 오염된 전사가 회의록 품질을 떨어뜨림.
- **원인**: `collapseRepeats` 반복 축소가 **4토큰 n-gram까지만** 봐서, 5~8토큰짜리 **문장 전체** 반복을 못 잡음.
- **수정**:
  - `_meeting.js collapseLine`: n-gram 최대 4→**20** 확장, **3토큰 이상 구/문장의 연속 중복은 1개만 남김**(1~2토큰 자연 반복은 3개까지 보존). 서로 다른 문장은 병합 안 함(내용 손실 0).
  - `_meeting.js isHallucinatedSegment`: 극단 압축비(cr≥3.2) 세그먼트를 확신도와 무관하게 환각 처리(세그먼트 내 문구 반복).
  - `index.html collapseRepeatsClient`: 서버와 동일 로직으로 확장(상세 STT 뷰 + 결과 STT 원문 표시 모두). 기존 저장분도 표시 시 정리됨.
  - 적용 지점: 청크별 STT(`_stt`) + 최종 회의록 입력(`prepareTranscript`) + 화면 표시. 반복이 줄어 요약/회의록 품질 개선. `sw.js` v19→**v20**.

| # | 항목(후속 H) | 결과 |
|---|------|------|
| 28 | 문장 반복 20회/15회 → 1개 축소 + 앞뒤 실제 발화 보존(서버) | ✅ |
| 29 | 클라이언트 `collapseRepeatsClient` 동일 동작(문장 반복→1) | ✅ |
| 30 | 정상 텍스트/서로 다른 문장 무변형(내용 손실 0) | ✅ |
| 31 | `isHallucinatedSegment` 고압축비 반복 환각 처리 | ✅ |
| 32 | `npm test` 전체(반복 축소 회귀 2건 추가) | **67 PASS / 2 skip / 0 fail** ✅ |

---

## [2026-06-28] STT `invalid_client` 근본 수정 + Stella Flow 신규 앱 (브랜치 `claude/lucid-ptolemy-xx3viy`)

### A. 음성 변환 "청크 업로드 실패: invalid_client" 근본 수정
- **근본 원인**: 오디오 청크를 Google Drive 에 업로드(`chunk-upload`)하고 워커가 다시 내려받아(`jobs-runtime`) 전사하는 구조였다. Drive OAuth(client_id/secret/refresh_token) 가 어긋나면 토큰 교환이 `invalid_client` 로 거절 → **전사가 시작도 못 하고 전부 실패**.
- **수정**: OCI 는 장수 프로세스 + 동일 파일시스템이므로 Drive 왕복이 불필요. 청크를 **서버 로컬 디스크**에 저장(`lib/chunkStore.js`)하고 워커가 직접 읽도록 변경. **Drive 인증 상태와 무관하게 전사 동작**.
  - `chunk-upload.js`: Drive 업로드 → 로컬 저장(ref `local:<sess>/<NNN>.wav`). `jobs-runtime.js`/`audio.js`: 로컬 ref 는 디스크, 레거시 Drive ref 는 Drive(무중단 호환).
  - `deploy/run-stella-oci.sh`: 도커 명명 볼륨 `stella-clover-data:/app/data` 마운트(재배포에도 청크 유지, `recover()` 와 짝). `CHUNK_DIR` 기본 `/app/data/chunks`.
  - `cleanup.js`: 로컬 정리(주) + 레거시 Drive 정리(베스트에포트). 최종 회의록 Drive 백업은 기존대로 실패해도 graceful(warnings).

### B. Stella Flow 신규 앱 (`/flow`)
- **표→플로우차트**: 엑셀(.xlsx, SheetJS)·CSV·붙여넣기 → `lib/flowBuild.js`(순수 변환) / `api/flow.js?action=structure`(AI gpt-4o-mini 정리, 실패·옵트아웃 시 로컬 폴백) → 편집 가능한 Mermaid + 라이브 렌더 → PNG/SVG/복사.
- **이미지 다듬기(Figure Lab)**: 붙여넣기/드래그 → 캔버스(여백 트림·패딩·밝기/대비·라운드·그림자·캡션, 1400px 다운스케일) → PNG.
- **저장**: `?action=save` → Drive `stellagpt/flow/<생성시각_제목>`(생성마다 새 폴더) + OCI `cl_flows` 메타. Drive·DB 어느 쪽이 실패해도 나머지 저장(둘 다 실패 시에만 `ok:false`).
- 인프라 재사용(신규 키 0): OpenAI/Drive/Postgres 공용. `api/_drive.js`(`ensurePathRooted`/`folderLink`), `api/_db.js`(`cl_flows`), `server.mjs`(`/flow` rewrite), `sw.js` v14.

### 테스트 결과 (샌드박스, Node 22)
| # | 항목 | 결과 |
|---|------|------|
| 1 | `node --check` 변경 api/lib/server + 인라인 JS `new Function` | **전부 OK** ✅ |
| 2 | `node --test test/*.test.js`(기존 + 신규 chunkStore 6 + flowBuild 11) | **56 PASS / 2 skip(라이브 DB) / 0 fail** ✅ |
| 3 | 서버 부팅 → `GET /flow` 200(text/html), `/api/flow?action=structure` 유효 Mermaid JSON | ✅ |
| 4 | **chunk-upload → 로컬 저장 → /api/audio 재생** 바이트 일치(왕복) | ✅ |
| 5 | chunk-upload 무파일 → graceful JSON("음성 청크가 없습니다") — **invalid_client 경로 없음** | ✅ |
| 6 | flow save(Drive·DB 미설정) → `ok:false` + message(거짓 "저장 완료" 없음) | ✅ |
| 7 | structure `useAi:false` → OpenAI 미호출(usedAi:false) | ✅ |
| 8 | /api/audio 임의 Drive id(미소유) → 404 JSON(confused-deputy 차단) | ✅ |
| 9 | flow save 8MB 초과 png → 400 JSON | ✅ |
| 10 | 시크릿 스캔 | 0 ✅ |
| 11 | **적대적 코드리뷰**(4 에이전트: STT 정확성·보안·flow 백엔드·flow 프런트) | 13건 발견 → **핵심 전부 반영** ✅ |

### 적대적 리뷰에서 수정한 항목
- **[high] PNG 깨짐**: `useMaxWidth:true` 로 SVG `width="100%"` → `parseFloat`=100px 로 찌그러짐. → **viewBox 우선** + 명시 픽셀 크기 직렬화 + 최대변 2000px 클램프.
- **[high→정책] flow delete/detail IDOR**: `id`만으로 삭제/조회. → `user_id` 스코핑(클라이언트 식별자, best-effort) + 목록도 userId 스코핑. ※ 앱 전역 인증부재 모델(meetings.js 동일)은 사설 단일사용자 전제 — 한계로 명시.
- **[med] flow save 거짓 성공**: Drive·DB 둘 다 실패해도 `ok:true`. → 실제 영속 여부로 `ok` 판정.
- **[med] 메타 누락**: 저장 시 nodeCount/edgeCount 미전송 → 목록 항상 0. → 카운트 캡처·전송.
- **[med] 규칙#2(청구)**: `AI 미사용` 체크해도 OpenAI 호출됨. → `useAi` 플래그 전송, 서버가 false 면 호출 생략.
- **[med] audio confused-deputy**: 임의 Drive id 스트리밍. → 레거시 ref 는 `transcribe_jobs.chunk_refs` 화이트리스트 검증 후에만 Drive 접근(+ MIME 확장자 기반).
- **[low] cleanup**: mtime 단위 삭제로 진행 중 잡 청크 삭제 위험 → **세션 최신 mtime** 기준으로 세션 단위 보존/삭제.
- **[low] pngBase64 디코드 전 상한** 8MB, **다크 토글 시 Mermaid 재테마**, 중복 `_rows` 정리.
- **[low/보류] CSP `unsafe-inline`+`https:`**: 앱 전역과 동일(인덱스 포함) — 기능 영향 없음, SRI/origin 핀은 후속 하드닝으로 보류.


## [2026-06-28] Vercel 제거 → OCI 이관 + 백그라운드 전사 클라이언트 연동 (브랜치 `claude/stella-search-zero-results-21mqvz`)

### 변경 요약
- **Vercel 의존 전면 제거** → OCI 우분투 서버(Docker/Express). `server.mjs` 어댑터로 기존 `api/*.js(req,res)` 그대로 구동. `vercel.json` 삭제, `export const config` 제거, cron→서버 내부 스케줄러.
- **백그라운드 워커 인프로세스화**(`lib/jobs-runtime.js`): worker HTTP 자기재호출 제거 → 동시상한+큐 + CAS 멱등 + **부팅 복구**(서버 재시작에도 미완료 잡 자동 재개).
- **`_db.js` 호스트 자동판별 TLS**: OCI `stella-mssql`(자체서명) / Azure(검증) 동시 지원, `DB_*`(별칭 `CL_DB_*`).
- **index.html 클라이언트 연동**: 분할→`/api/chunk-upload`(Drive)→`POST /api/jobs`→3초 폴링→완료 시 **기존 `/api/summarize`+렌더+이력 그대로**. **`clover_active_jobs` localStorage + `resumeActiveJobs()`로 탭 닫았다 다시 열어도 자동 재개**. 모델 선택 UI + 60초 정지 워치독 + `/api/worker` 재트리거.

### 테스트 결과 (샌드박스, Node 22.22)
| # | 항목 | 결과 |
|---|------|------|
| 1 | `node --check` server.mjs + api/*.js + lib/*.js (20개) | **20/20 OK** ✅ |
| 2 | 핸들러 dynamic import(의존성 설치) — 잘못된 import 0 | **11/11 OK** ✅ |
| 3 | `npm test`(node:test) — 기존 27 + 신규 7(db-config·jobs-runtime) | **34/34 PASS** ✅ |
| 4 | `server.mjs` 부팅 → `GET /` index.html(모델 선택 UI 포함) 서빙 | **200** ✅ |
| 5 | `/api/_db` 언더스코어 가드 → 404 JSON(공유모듈 비노출) | ✅ |
| 6 | `/api/meetings·jobs·worker·chunk-upload·drive-search` 미설정 시 graceful JSON | ✅ |
| 7 | index.html 인라인 JS `new Function` 파싱 | **0 errors** ✅ |
| 8 | 순수함수: computeOffsetSec / TLS(stella-mssql=trust, azure=verify) / hasDbConfig | ✅ |
| 9 | 시크릿 스캔 | 0 ✅ |
| 10 | **적대적 코드리뷰**(18 에이전트, 4 차원 + 검증 패스) | 14건 발견 / **10건 확정**(high 2·med 7·low 1) → **전부 수정** ✅ |
| 11 | 수정 후 재검증: node --check / 키없이 import 9·9 / 인라인 JS / JSON 에러핸들러·graceful 요약 | ✅ |

### 적대적 리뷰에서 수정한 핵심 버그
- **[high] cl_meetings 중복**(탭 재진입/멀티탭에서 finalize 2회) → summarize INSERT `audio_session` 멱등 가드 + 클라이언트 낙관적 제거.
- **[high] gpt-4o-*-transcribe 빈 전사**(워커가 segments만 저장, text 폐기) → text를 세그먼트로 합성.
- [med] server.mjs JSON 에러 핸들러(잘못된 본문도 JSON), OpenAI 지연 생성(키 없을 때 graceful), 워커 finalize try/catch(에러 마킹), 폴링 무한루프/동시실행/not-found 오인 가드. [low] OVERLAP_SEC=0(경계 중복 전사 제거).

### 한계 (정직)
- DB/Drive/OpenAI 자격증명은 배포 환경에만 존재 → 실제 업로드→전사→요약 end-to-end는 샌드박스 실행 불가. 어댑터/라우팅/가드/부팅·인라인 JS·순수로직까지 정적+런타임 검증.
- **수동 검증 절차**: 작은 음성 업로드 → 업로드 완료 토스트 후 **탭 종료** → 잠시 후 재접속 시 "이전 변환을 이어서 진행합니다" 토스트와 함께 진행률이 이어지고 회의록이 완성되는지 확인.
- 배포 트리거는 **main push**. 본 작업은 개발 브랜치 푸시 → 실제 OCI 배포는 main 병합 시.

---

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
- [x] 저장: Drive(Meeting/AI_Report/Metadata) + Azure SQL cl_meetings (변경 없음)
- [x] 신규 API 키·라우트 0 → **청구 중복 0**

## 검증
- `node --check`: 전 api/*.js + sw.js 통과
- index.html 인라인 JS `new Function` 파싱 OK (34,647 chars)
- 기능 체크리스트 13/13 통과(탭·13언어·ar·다크·4단계·통계·지침·userInstruction·safeJson·120s유지·5MB금지·푸터·fmtErr)
- `vercel.json` `JSON.parse` 통과 · 시크릿 스캔 0
- SW 캐시 `stella-clover-v2 → v3`

## 폴더/태그/프로필/지침 = 클라이언트 저장 (가정 로그)
백엔드에 폴더·태그·사용자 계정 라우트가 없고 "신규 라우트 금지" 제약이 있어,
폴더·태그·프로필·AI지침은 **localStorage**(이 기기)로 구현. 회의록 본문/검색은 기존 Azure/Drive 그대로.
로그인은 별도 인증 백엔드가 없어 **로컬 프로필**(이름/이메일)로 대체.

## 배포 상태
- main 푸시 → Vercel 자동 배포. (샌드박스는 Deployment Protection 403으로 라이브 URL 직접 확인 불가 — 코드/문법/체크리스트 정적 검증 완료. 실제 동작은 KH 브라우저에서 확인.)

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

---

## [2026-07-09] 노트 편집 모달 UX + IME 가드 + 전사→노트 자동저장 (브랜치 `claude/stella-clover-improvements-v35rsr`)

전제 정정: 지정된 `stella-ai-workspace/docs/NOTES_API.md`·`STELLA_NOTES_API_KEY`(REST/`:id`/pagination)는 대상에 **부재**.
실제 노트 마스터는 `api/note.js`(무상태 HMAC 세션 인증)이고, **Clover 노트는 이미 main 에 구현돼 있었다**
(`api/notes.js` + `note/index.html`, ★Stella GPT 와 **같은 Google Drive 공유 폴더**에 같은 JSON 포맷으로 저장 →
두 앱이 같은 노트를 봄. 목록은 인덱스 캐시로 TTFB 개선, 상세는 `action=get` lazy). 따라서 CRUD/공유/속도(태스크 1·3)는
충족 상태 → **중복 재작성 없이**, 남은 태스크(4 모달 UX·2 IME)만 기존 코드에 가산.

### 변경 (note/index.html · index.html)
- **편집 모달 풀높이화(태스크 4)**: `.modal-content` 를 flex 컬럼으로 — 모바일(S22) `100dvh` 풀스크린,
  PC `92vh`. 제목 위, **본문 textarea `flex:1`(내부 스크롤 최소화)**, **저장/삭제 버튼 하단 고정**(safe-area 패딩).
- **한글 IME composition 가드(태스크 2)**: 제목/본문/검색에 `compositionstart/end` 바인딩. 조합 중 검색 억제
  (`compositionend` 에서 재개), 저장 시 `blur()` 로 조합 확정 후 값 읽기.
- **전사 → 노트 자동저장(태스크 2)**: 전사 완료(신규 `renderServerResult` + 레거시 `finalizeTranscript`) 시
  회의록(제목+요약)을 `/api/notes?action=save` 로 Stella GPT 공유 노트에 저장(`pushMeetingNote`, 베스트에포트,
  중복 시그니처 스킵). 실패해도 전사 흐름 무영향.
- `sw.js` v23→**v24**.

### 테스트 (샌드박스, Node)
| # | 항목 | 결과 |
|---|------|------|
| 1 | `node --check` api/lib/server + 인라인 JS(index/note/flow/rate) `new Function` | 전부 OK ✅ |
| 2 | `npm test`(기존 스위트) | **83 PASS / 3 skip / 0 fail** ✅ |
| 3 | 서버 `/notes` 200 + 풀높이 모달(`92dvh/editor-scroll`)·IME(`compositionstart/bindIme`) 렌더 | ✅ |
| 4 | 변환 탭 📝 노트 → `/notes` 링크 | ✅ |
| 5 | `/api/notes`(Drive 미설정) → graceful JSON(평문 크래시 없음) | ✅ |

> 양방향 동기화(Clover↔Stella GPT)·1초 로드는 **같은 Drive 공유 폴더 + Drive 자격증명**이 설정된 라이브 서버에서 성립
> (샌드박스는 정적/기동/파싱까지 검증). 파괴적 변경 없음 — Clover 엔 제거할 자체 노트 테이블이 애초에 없고(회의록=cl_meetings 는 별개, 유지).
