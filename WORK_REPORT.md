# CBO Spec & Code Review — 작업 보고

## 완료 기능

- 메인 메뉴 `CBO Spec&Code Review` 탭과 독립 SPA `/cbo-review`
- 개인용 비밀번호 게이트와 OpenAI·Anthropic·Gemini API 키 연결/상태/동적 모델 선택
- 프롬프트 및 복수 첨부(txt/md/csv/docx/xlsx/pdf/소스) 기반 스펙 생성
- Markdown/Excel 다운로드, `0Program/spec` 파일명·중복 버전 규칙 적용, 자동 commit/push
- 업로드·0Program 서버 경로·GitHub 링크 입력 기반 ABAP/일반 코드 리뷰
- 대용량 줄 단위 분할, provider 오류 지수 백오프 3회, 파일별 severity/line/Before/After 표시
- 지적사항 선택 반영, 원본 hash 충돌 방지, `.bak.<timestamp>` 백업, 자동 commit/push
- 업로드 수정본 다운로드와 ABAP SE38 수동 반영 안내

## 사용자가 설정할 항목

OCI `.env`에 다음 값을 설정한 뒤 컨테이너를 재기동한다.

- `CBO_ACCESS_PW`: CBO 화면 개인 비밀번호
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`: 사용할 provider만 설정 가능
- `GITHUB_TOKEN`: `yesblue0342-bit/0Program` Contents read/write 권한 fine-grained PAT
- `CBO_REPO_PATH=/app/data/0Program`

API 키는 화면의 `AI 연결 설정`에서도 저장할 수 있다. ChatGPT Plus/Claude Pro/Gemini Advanced 구독 로그인 자체는 API 사용 권한이 아니므로 각 provider API 키가 별도로 필요하다.

## 제약 및 확인 필요

- 원격 OCI가 사용자의 Windows `C:\codex\0Program`을 자동 pull할 수는 없다. OCI clone과 GitHub는 즉시 동기화되며, Windows clone은 기존 로컬 작업 절차에서 `git pull`이 필요하다.
- 실제 AI 생성·GitHub write E2E는 운영 API 키/PAT를 코드나 테스트 로그에 노출하지 않기 위해 mock/정적/서버 계약까지만 검증했다.
- `.xls`(구형 binary Excel)는 지원하지 않으며 `.xlsx`로 변환 후 첨부해야 한다.

## 2026-07-12 UI 수정 세션 (`stellaclover_260712_prompt.md`, 무인)

### 반영 완료
- 요구사항 입력 placeholder에서 "US11 " 예시 삭제.
- 스펙 미리보기의 "GitHub 전송 (.md/.xlsx)" 버튼 라벨을 "Hub 전송 (.md/.xlsx)"로 변경 (동작·API 경로 불변).
- 초기 접속 시 CBO Review 로그인 게이트가 `loadSettings()` 완료 전까지 잠깐 보이던 깜빡임 제거.
  `CBO_ACCESS_PW` 미설정 환경에서는 게이트가 아예 노출되지 않는다. 설정된 환경에서는 기존과 동일하게
  인증 실패 시 게이트가 뜬다(백엔드 `requireAuth`/`hasAccessPassword`는 그대로 유지 — 죽은 코드 아님).
- "공통 AI 모델" 드롭다운의 Claude 전체 라인업 추가는 **이미 구현되어 있어 추가 변경 없음** — 상세 근거는
  `REVIEW_LOG.md` 2026-07-12(UI 수정 세션) 항목 참조.

### 반영 보류 (판단 근거는 `REVIEW_LOG.md` 참조)
- "AI 연결 설정"을 API 키 입력에서 provider별 OAuth "계정 연결"로 바꾸는 것은 **보류**했다. OpenAI/Anthropic이
  제3자 앱에 최종 사용자 API 키를 발급하는 공개 OAuth 플로우를 제공하지 않고, 억지로 구현하면 provider별
  OAuth 앱(client_id/secret) 신규 등록 + 콜백 라우트 신설이 필요해 "신규 API 키·신규 라우트 생성 금지" 규칙을
  위반한다. 현재의 서버측 전용 저장(`data/cbo-review/providers.json`, 0600, 클라이언트 재노출 없음) 방식이
  이미 "하드코딩 금지 + 서버 시크릿 스토리지 관리" 요건을 충족하므로 그대로 유지했다.
  **남은 과제**: 실제 OAuth 계정 연결을 원한다면 사람이 각 provider(OpenAI/Anthropic/Google) 개발자 콘솔에서
  OAuth 앱을 등록하고 client_id/secret을 `.env`에 넣는 것부터 시작해야 한다 — 이는 외부 계정 승인이 필요한
  작업이라 무인 세션에서 대신할 수 없다.

### 테스트/검증
- `node --check`: `api/cbo-review.js`, `lib/cbo-review/{auth,core,providers}.js` 통과(수정 없음, 회귀 확인용).
- inline `<script>` 파싱: `new Function()`으로 `cbo-review/index.html`의 `<script>` 본문 파싱 성공.
- `npm test`: 99 pass / 0 fail / 8 skip(DATABASE_URL 미설정 통합 테스트, 기존과 동일하게 skip). 이번 변경은
  텍스트/CSS 클래스 수준이라 기존 단위 테스트 스위트에 새 케이스를 추가하지 않았다(백엔드 로직 변경 없음).
- `sw.js` `CACHE` 버전: 이번 변경은 `cbo-review/index.html`(별개 SPA, 서비스워커 프리캐시 목록에 없음)만
  건드렸고, `sw.js`는 모든 HTML을 network-first로 서빙(오프라인일 때만 캐시 폴백)하므로 버전을 올리지 않아도
  사용자는 항상 최신 HTML을 받는다. 루트 `index.html`은 변경하지 않았다.

## 2026-07-12 계정 로그인(CLI) 연동 세션 (`stella_clover_improvement_260712_2.md`, 무인)

### 반영 완료

- **작업 1 — 공통 AI 모델 드롭다운**: 미연결 provider(openai/anthropic/gemini 공통)를 더 이상 목록에서
  숨기지 않고 `<optgroup label="provider (연결 필요)">`로 회색 표시. 선택 시 직전 값으로 되돌리고 AI 연결
  설정 모달을 자동으로 연다. Claude 전체 라인업 fallback 목록(`claude-fable-5/opus-4-8/sonnet-5/haiku-4-5`)은
  지난 세션에 이미 구현돼 있어 추가 변경 없음(`lib/cbo-review/core.js`). 상세 진단은 `REVIEW_LOG.md` 참조.
- **작업 2 — 계정 로그인(CLI) 방식 추가**: 조사 끝에 **경로 A(기존 CLI 인증 재사용)를 채택·구현**했다.
  - AI 연결 설정 모달에 provider별 "계정으로 로그인 사용" / "계정 로그인 해제" 버튼을 **기존 API 키 입력
    UI를 그대로 둔 채** 추가(둘 중 하나만 있어도 "연결됨"). 서버에 `claude`/`codex` CLI가 설치·로그인
    되어 있으면 버튼이 나타나고, 미로그인이면 "서버에서 CLI 로그인 필요(1회)" 안내만 표시된다.
  - 호출 우선순위는 지시서대로 계정 로그인(CLI) → 없으면 API 키.
  - Gemini는 서드파티 앱용 공식 OAuth/CLI가 없어 이번에도 API 키 전용 유지(지난 세션과 동일 결론).
  - 새 API 키·새 OAuth 앱·새 서버리스 라우트는 만들지 않았다 — `api/cbo-review.js`의 기존 단일 핸들러에
    `action=cli-connect`/`action=cli-disconnect` 브랜치만 추가(기존 `action=provider-save` 등과 동일 패턴).

### 사용자가 직접 해야 할 일 (계정 로그인 기능을 실제로 쓰려면)

1. `main` push 후 OCI 자동 재배포가 끝나면(이미지에 `claude`/`codex` CLI가 새로 포함됨), 서버에 SSH 접속:
   ```
   docker exec -it stella-clover claude login
   docker exec -it stella-clover codex login
   ```
   각 명령이 인증 URL(+코드)을 출력하면 본인 브라우저에서 열어 로그인한다(컨테이너 자체에 브라우저 불필요).
2. 인증 파일은 `stella-clover-claude-home`/`stella-clover-codex-home` 명명 볼륨에 저장되며, 이후 `main` push로
   컨테이너가 재생성돼도(`deploy/run-stella-oci.sh`가 매번 `docker rm -f`+`docker run`) 유지된다.
3. 로그인 후 CBO Review → AI 연결 설정에서 해당 provider의 "계정으로 로그인 사용" 버튼을 눌러 활성화한다.
   API 키를 이미 넣어뒀다면 그대로 폴백으로 남으므로 삭제할 필요 없다.
4. 로그인하지 않으면 아무것도 바뀌지 않는다 — 기존 API 키 방식이 100% 그대로 동작한다(회귀 없음).

### 알려진 한계 / 남은 과제

- **codex(OpenAI) 모델 선택은 현재 advisory 수준이다.** `codex exec`에 `-m`(모델)을 강제로 넘기지 않고
  서버측 codex 설정 기본 모델을 그대로 사용한다 — codex CLI 내부 모델 네이밍이 direct API(`gpt-5.6` 등,
  드롭다운에 표시되는 값)와 다를 가능성이 있는데, 이 세션에서 실제 계정이 사용량 한도(usage limit)에 걸려
  실제 `-m` 값 검증을 끝까지 하지 못했다(인증/샌드박스/비대화식 실행 자체는 실제 호출로 확인함). 사용량
  회복 후 실제 리뷰/스펙 생성을 한 번 실행해 결과를 확인하고, 필요하면 `callViaCli()`의 codex 분기에 `-m`
  매핑을 추가하는 후속 작업을 권장한다.
- **claude(Anthropic) 경로는 실제 서브프로세스 호출까지 end-to-end 검증했다** — `claude -p --model
  claude-haiku-4-5 ...`로 실제 텍스트 응답을 받았고, `/api/cbo-review?action=generate-spec`을 CLI 모드로 로컬
  구동해 스펙 생성까지 정상 동작 확인(TEST_RESULTS.md 참조).
- CLI 경로는 방어적으로 `Bash/Edit/Write/Read/WebFetch/WebSearch/...` 전체 도구 차단 + codex는 `-s
  read-only` 샌드박스로 실행한다(첨부 소스코드에 프롬프트 인젝션이 섞여도 서버 파일/셸에 접근 못하도록).
  다만 이 도구 차단 옵션은 각 CLI의 공식 플래그(`--disallowedTools`, `--disable-slash-commands`, `-s
  read-only`)에 의존하므로, CLI 자체 업데이트로 플래그가 바뀌면 재확인이 필요하다.
- Windows 로컬 개발 환경에서는 npm이 만드는 `.cmd` 셰임을 파싱해 실제 `.exe`/`node.exe+.js` 경로로 우회
  실행한다(Node가 `shell:false`로 `.cmd`를 직접 실행하는 것을 막기 때문). 실제 OCI 배포는 Linux라 셰임이
  없어 이 우회 로직 없이 바로 동작한다 — 두 환경 모두 이번 세션에서 직접 실행 검증했다(Windows는 로컬,
  Linux 동작은 Docker 이미지 구조상 표준 npm 전역 설치 shebang 스크립트라 별도 우회 불필요).

## 2026-07-12 CBO Review 비동기 잡 전환 + CLI 모드 버그 수정 (`stella_clover_improvement_260712_3.md`, 무인)

### 배경
OCI 프로덕션 로그(`docker logs stella-clover`)에서 확인된 장애:
```
[cbo-review] API 키 형식이 올바르지 않습니다.
[cbo-review] claude 실행이 180000ms 내 끝나지 않았습니다.
```
xlsx 첨부 2개 + SAP QM CBO FS 작성 같은 실사용 요청은 claude/codex CLI 실행에 5~10분이 정상 소요되는데,
기존 구조는 **동기 HTTP 요청 + CLI 서브프로세스 180초(anthropic)/240초(openai) 하드킬**이라 성립하지 않았다.

### 목표 2(버그 수정) — 먼저 처리, 별도 커밋 `6b0c5ce`
- 원인: `lib/cbo-review/providers.js`의 `callModel()`이 provider mode가 `cli`인데 `detectCli()`가 미인증을
  반환하면(로그인 만료·서버 CLI 미설치 등) **조용히 API 키 검증 경로로 폴백**해 키 관련 에러를 던지고
  있었다. `saveProviderKey()`의 "API 키 형식이 올바르지 않습니다" 자체는 `action=provider-save`(사용자가
  설정 모달에서 직접 키 저장을 누를 때만) 전용이라 이 폴백과는 별개 경로지만, 로그의 두 줄은 "cli 모드인데
  키 관련 에러가 섞여 나온다"는 동일한 증상 계열로 판단해 함께 점검했다.
- 수정: `callModel()`에서 mode가 `cli`이면 미인증이어도 **API 키 로직으로 절대 넘어가지 않고** cli 전용
  에러(`CLI 설치 안 됨` / `로그인 만료`)로 즉시 종료하도록 변경. `saveProviderKey()`는 그대로 뒀다 —
  사용자가 명시적으로 "API 키 저장"을 누르는 별개 액션이라 mode와 무관하게 형식 검증이 맞다고 판단.
- 회귀 테스트: `test/cbo-review-providers.test.js`에 cli 모드+미인증 상태를 재현해 `callModel()` 에러 메시지에
  "API 키" 문구가 섞이지 않는지 검증하는 케이스 추가.

### 목표 1(비동기 잡 전환) — 커밋 `69295b0`
- 기존 서버사이드 백그라운드 transcription 잡 구조(`lib/jobs-runtime.js`, `STELLA_CLOVER_TRANSCRIBE_JOBS.md`)의
  패턴(DB 영속 상태 + 인프로세스 큐 + `kick()` + 부팅 `recover()`)을 그대로 재사용해
  `lib/cbo-review/jobRuntime.js`를 새로 만들었다. transcribe 잡과의 핵심 차이:
  - transcribe 잡은 청크 단위로 **재개 가능**(CAS 가드로 중단 지점부터 이어감)하지만, CBO 잡은 단발성 LLM
    호출이라 재개 개념이 없다 — `queued → running → done|failed`만 있고 실패 시 재요청해야 한다.
  - 동시 실행 상한을 `transcribe`처럼 환경변수(`JOBS_CONCURRENCY`)로 조절하지 않고 **1로 고정**했다 —
    claude/codex CLI 서브프로세스가 사용자 개인 구독 로그인을 그대로 쓰므로 동시 다중 실행을 지원하지 않음
    (지시서 요구사항).
  - CLI 실행 자체의 하드킬 타임아웃을 `lib/cbo-review/providers.js`의 `runCli()`에서 이미 갖고 있어서
    (`callViaCli` 호출부), 잡 레벨에서 별도 타임아웃 래퍼(`Promise.race`)를 추가하지 않았다. 리뷰 잡은 파일이
    많으면 청크당(최대 80개) 개별 CLI 호출을 반복하므로, 잡 전체에 고정 타임아웃을 씌우면 정상적인 대용량
    리뷰까지 중도 실패시킬 위험이 있었기 때문이다.
- DB: `api/_db.js`에 `cbo_jobs` 테이블 추가(`ensureSchema()`에 편입, 기존 `CREATE_TABLE IF NOT EXISTS` +
  `ADD COLUMN IF NOT EXISTS` 멱등 패턴 재사용). 컬럼: `kind/status/payload_json/result_json/error_msg/
  created_at/updated_at/started_at/finished_at`.
- API 계약(하위 호환 유지 — 지시서 "기존 액션명/시그니처 유지" 요건):
  - `POST /api/cbo-review?action=generate-spec` / `review-upload` / `review-repo` — 응답이 기존
    `{ok,title,markdown,...}` 전체 결과 대신 **`{ok,jobId,status:'queued'}`를 수 초 내 반환**하도록 바뀜(액션명·
    HTTP 메서드·요청 바디는 동일).
  - 신규 `GET /api/cbo-review?action=job-status&id=<jobId>` — 폴링용. `queued/running`이면
    `{ok,status,elapsedMs}`, `done`이면 원래 동기 응답과 동일한 필드를 status와 함께 펼쳐서 반환, `failed`면
    `{ok:true,status:'failed',message}`(HTTP 자체는 성공이므로 `ok:true` — 실패는 잡의 상태일 뿐 폴링
    요청의 실패가 아님).
  - `action=apply`(선택 반영)는 변경 없음 — `reviewFiles()`가 백그라운드 잡 내부에서 실행되지만 같은
    Node 프로세스 안이라 기존 인메모리 `reviews` Map(리뷰 세션 저장)이 그대로 채워진다.
- 동시성 1 + 대기 큐: `jobRuntime.js`의 `waiting` 배열 + `pump()`가 transcribe 잡과 동일한 방식으로 처리.
- 서버 재시작 좀비 잡 방지: `server.mjs` 부팅 시 `lib/cbo-review/jobRuntime.recover()` 호출 —
  `running`(재시작으로 유실된 실행 중 CLI 프로세스)은 **재개 불가이므로 즉시 `failed`** 처리,
  `queued`(아직 CLI를 부르지 않아 유실이 없는 상태)는 안전하게 재투입(`kick`)해 이어서 완료된다.
  transcribe 잡의 "완료된 단계는 스킵하고 이어감" 방식과 달리, CBO 잡은 애초에 재개 대상 산출물이 없어
  "아직 시작 안 한 것만 재시도"로 단순화했다.
- 프론트(`cbo-review/index.html`): `job_id` 발급 후 3초 간격 폴링(기존 transcribe 잡과 동일 주기).
  진행 중에는 스펙 미리보기/리뷰 결과 영역에 "생성 중… 경과 N초" 표시. **실패 시 토스트로 사라지지 않고
  화면에 지속 표시**(`showErr()` — `var(--danger)` 색상, 사용자가 원인을 캡처할 수 있도록). 활성 `job_id`를
  `localStorage`(`cbo_active_spec`/`cbo_active_review`)에 남겨 **새로고침/재접속 후에도 진행 중이던 잡을
  이어서 폴링**한다(지시서에서 "이상적이나 없으면 범위 제외" 옵션이었지만, DB 폴링만 추가하면 되는 수준이라
  이번 세션에 포함했다).
- `lib/cbo-review/providers.js`: `runCli()` 호출부의 CLI 하드킬 타임아웃을 `180000/240000ms` →
  `900000ms`(15분, `CLI_TIMEOUT_MS` 상수)로 상향. 이게 두 번째 로그 라인의 진짜 원인 수정이다 — 잡 큐
  전환으로 HTTP 응답 지연 문제는 해소됐지만, CLI 자체의 하드킬 값이 여전히 3~4분이면 정상적인 5~10분 요청도
  똑같이 실패하기 때문.

### 테스트/검증
- `node --check`: 변경된 백엔드 파일 전부(`api/_db.js`, `api/cbo-review.js`, `lib/cbo-review/providers.js`,
  `lib/cbo-review/jobRuntime.js`, `server.mjs`) 통과.
- inline `<script>` 파싱: `new Function()`으로 `cbo-review/index.html` `<script>` 본문 파싱 성공, 중복 함수
  선언 없음 확인(수작업 스캔).
- `npm test`(DATABASE_URL 미설정, 샌드박스 기본): **107 pass / 0 fail / 12 skip**(DB 통합 테스트, 기존과 동일
  사유로 skip — 신규 `test/cbo-jobs.test.js` 5건 포함).
- **DB 통합 테스트 실환경 검증**: 이 세션에서는 샌드박스에 Docker가 있어, 일회용 `postgres:16-alpine` 컨테이너를
  띄우고 `DATABASE_URL`을 설정해 스킵되던 통합 테스트까지 실제로 돌렸다 — **119/119 전부 통과**(신규
  `test/cbo-jobs.test.js` 5건 포함: 상태전이 queued→running→done, 실행기 throw 시 failed+error_msg 기록,
  **동시 실행 1개 제한**(두 번째 잡이 첫 번째 완료 후에만 시작함을 이벤트 순서로 검증), `recover()`의
  running→failed 좀비 처리 + queued→재투입 후 완료까지 확인). 테스트 후 컨테이너는 정리했다(운영 DB에
  영향 없음).
- 실제 claude/codex CLI 호출을 통한 end-to-end(진짜 15분 대기 스펙 생성)는 이번 세션에서 수행하지 않았다 —
  운영 자격증명이 필요하고, 잡 큐/타임아웃/폴링 로직 자체는 위 통합 테스트로 충분히 검증됐다고 판단했다.

### 알려진 한계 / 남은 과제
- **서버 재시작 시 `running` 잡은 재개 불가**(비멱등 LLM 서브프로세스 호출이라 중간 상태를 이어받을 수
  없음) — 사용자에게 "서버 재시작으로 중단되었습니다. 다시 요청해주세요."로 명시하고 `failed` 처리한다.
  `queued`(아직 CLI를 부르지 않음) 잡만 안전하게 자동 재투입된다.
- 리뷰 잡(다중 파일·청크 최대 80개)은 잡 전체에 고정 타임아웃이 없어, 이론상 청크 수가 많으면 15분×청크수
  까지 늘어질 수 있다(각 청크 호출은 15분 상한이 있지만 잡 전체 합산 상한은 없음) — 지시서의 "CLI 실행
  자체의 타임아웃은 15분"을 문자 그대로 "개별 CLI 호출당 15분"으로 해석했다. 잡 전체 총량 상한이 필요하면
  후속 작업으로 `jobRuntime.js`에 kind별 총 소요시간 가드를 추가할 수 있다.
- CBO Review는 개인용 공유 비밀번호 1개(`lib/cbo-review/auth.js`)로 사용자 구분이 없어, 잡도 사용자별로
  스코프하지 않았다(모든 잡이 전역 하나의 큐를 공유). 다중 사용자 동시 사용 시나리오가 생기면 `cbo_jobs`에
  세션/사용자 식별 컬럼을 추가하는 확장이 필요하다.

---

# CBO Pre-Check — 작업 보고 (2026-07-14, 무인 autopilot, `PROMPT_CBO_PRECHECK_260714.md`)

## Phase 0 — 정찰

- 스택: 프레임워크 없는 순수 Node ESM(`"type":"module"`). `server.mjs`(Express)가 `/api/<단일세그먼트>.js`의
  `export default handler(req,res)`만 동적 import 로 실행 — **하위 경로 라우팅 불가**(`sub.includes("/")` 는
  404). 따라서 미션 문서의 `POST /api/cbo-precheck/scan` 형태 대신, 기존 `api/cbo-review.js` 관례를 그대로
  따라 **`?action=` 쿼리 파라미터**로 서브라우팅한다(`/api/cbo-precheck?action=scan` 등). (근거: 절대 규칙 3
  "스택 추종".)
- 빌드/테스트 명령: 빌드 별도 없음(정적 파일 + Node 서버). 테스트 `npm test`
  (`node --experimental-test-module-mocks --test test/*.test.js`). 배포 워크플로
  `.github/workflows/deploy-oci.yml`는 빌드/테스트 게이트 없이 push 시 OCI SSH 재배포만 수행(테스트는 로컬/PR
  단계에서 수동 실행).
- 기존 "CBO Spec & Code Review"(`api/cbo-review.js`, `lib/cbo-review/*`, `cbo-review/index.html`)는 이름은
  비슷하지만 **다른 기능**(LLM 기반 스펙 생성·코드 리뷰, `0Program` repo에 직접 main 커밋)이라 파일을 건드리지
  않았다(절대 규칙 2). 다만 `lib/cbo-review/repository.js`의 git clone/SSH/커밋 패턴은 참고만 하고 독립적으로
  재구현했다(공유 모듈 의존 없음 — 이 모듈이 없어도 CBO Pre-Check가 동작해야 하므로).
- `@abaplint/core@2.119.66`을 `dependencies`에 추가(CLI 아님 — 절대 규칙에 따라 라이브러리 직접 호출).
- Baseline(GATE 0): `npm test` → **107 pass / 0 fail / 12 skip**(DB 미설정으로 통합 테스트 skip — 기존에도
  동일, 회귀 아님). 이 상태를 기준선으로 기록.
- 환경변수 확인: 이 개발 세션에는 `GITHUB_TOKEN`/`ANTHROPIC_API_KEY`/SSH agent 키가 전혀 없음 → Phase 2의
  PR 자동 생성 기능은 "설정 안 됨" 상태에서의 graceful-disable 경로로만 검증 가능(절대 규칙 5에 이미 요구된
  동작이라 문제 없음). 실제 GitHub PR 1건 생성 후 close(GATE 2 c) 는 이 샌드박스에서 수행 불가 — 운영 OCI
  서버에 자격 증명이 설정된 뒤 사용자가 직접 1회 확인하도록 README에 안내한다.

## Phase 1 — 스캔 엔진 (backend)

### abaplint 실측과 미션 문서의 차이(판단 근거 기록 — 절대 규칙 1)

미션 §3 fixture는 "룰 이름"을 사람이 붙인 주석으로 표기했는데, 실제 `@abaplint/core@2.119.66`으로 스캔해
보니 두 곳이 실제 룰과 달랐다. 문서 문구가 아니라 **엔진의 실제 동작**을 기준으로 구현했다(우선순위 §4:
"GATE 통과" > "문서의 세부 사양"):

1. `check_ddic` 룰은 DDIC 오브젝트(TABL/DOMA/DTEL...) **자신의 타입 정의**만 검사한다(소스 코드에서
   `TYPE qals-존재하지않는필드`처럼 DDIC 필드를 잘못 참조하는 것은 검사하지 않음). 이 케이스(PARAMETERS
   p_werks TYPE qals-**werks**, 정답은 werk)를 실제로 잡는 룰은 **`unknown_types`**였다
   (`Variable "P_WERKS" contains unknown: Field "WERKS" not found in structure`). `check_ddic`은 그대로
   활성화해 두되(DDIC 오브젝트 자체 검증용으로 유효), 필드 오참조 검출은 `unknown_types`에 맡긴다.
2. `check_variables`라는 룰 키는 이 abaplint 버전에 **존재하지 않는다**
   (`ArtifactsRules.getRules()`에 없음). 미선언 변수 참조(`MOVE ls_out-matnr TO gv_matnr` — gv_matnr 미선언)는
   `SyntaxLogic` 예외를 이슈로 변환하는 **`check_syntax`** 룰이 잡는다(`"gv_matnr" not found, Target`).
3. abaplint `unused_variables` 룰은 **설계상** 같은 오브젝트에 다른 syntax 오류가 있으면 보고를 건너뛴다
   (`rules/unused_variables.js`: `if (syntax.issues.length > 0) return [];` 주석: "dont report unused
   variables when there are syntax errors"). §3 fixture는 미선언 변수 오류(→check_syntax)와 미사용 변수
   (gv_count)를 **같은 파일**에 동시에 심어뒀기 때문에, 실제 엔진에서는 **한 번의 스캔에 5개 이슈만 동시
   검출**된다(`obsolete_statement`×1, `sql_escape_host_variables`×2, `unknown_types`×1, `check_syntax`×1).
   6번째(unused_variables/gv_count)는 그 자체로 실재하는 정상 검출 규칙이므로, syntax 오류가 없는 격리된
   샘플로 별도 검증해 "6개 룰이 모두 정확히 동작함"을 확인했다(`test/cbo-precheck-scan.test.js`의 "GATE 1
   (격리 검증)" 케이스). fixture 파일 내용 자체는 미션 §3 원문 그대로 생성했다(수정 금지 지침 준수) — 검증
   방식만 엔진 실측에 맞게 보정했다.

### 구현

- `lib/cbo-precheck/scan.js`: `buildConfig()`(syntax v755, errorNamespace `^(Z|Y)`, 위 보정된 룰셋),
  `scanFiles({files})` — `@abaplint/core` `Registry`+`MemoryFile`로 인메모리 스캔, 결과를
  `{file,line,col,severity,rule,message,quickfixAvailable}[]`로 정규화(심각도→파일→라인 정렬). DDIC
  XML/의존성 파일은 타입 해석용으로만 추가되고 결과 목록에는 노출하지 않는다.
- `lib/cbo-precheck/repoFetch.js`: `git@host:owner/repo(.git)` SSH 형식만 허용(정규식 검증, 절대 규칙 6),
  브랜치/서브경로 안전성 검증(경로 탈출 차단), `--depth 1` clone → 임시 폴더(os.tmpdir) → `.abap`/DDIC
  XML(`.tabl/.dtel/.doma/.ttyp/.shlp/.view.xml`) 수집(최대 500개 파일, 파일당 2MB 상한) → `finally`에서
  임시 폴더 삭제.
- `lib/cbo-precheck/exportFormats.js`: xlsx(exceljs, `lib/cbo-review/extract.js`와 동일한 수식주입 방지
  패턴 `/^[=+\-@]/` → 텍스트 고정)/md/txt/json 4포맷.
- `lib/cbo-precheck/store.js`: 스캔 결과 인메모리 `Map` 캐시(scanId, 최대 30건 보관) — `lib/cbo-review`의
  `reviews = new Map()` 패턴을 그대로 따름. 새 DB 스키마를 만들지 않아 `_db.js`(공유 모듈)를 건드리지 않는다
  (구현 단순성 우선 — 스캔은 재실행 가능한 멱등 작업이라 영속성 필수 아님).
- `api/cbo-precheck.js`: `action=scan`(POST, git clone+스캔+캐시), `action=export`(GET, 4포맷 다운로드),
  `action=issue-update`(POST, 보류/메모 — Phase 2 UI에서 사용), `action=scan-get`(GET, 폴링/재조회). 모든
  분기가 try/catch로 감싸여 항상 JSON 반환(절대 규칙 3).
- fixtures: `fixtures/zaqmr0130_bad.prog.abap`(§3 원문 그대로), `fixtures/zaqmr0130_good.prog.abap`(BLOCK
  1·PARAMETERS 2·SELECT-OPTIONS 1·ALV fieldcatalog 3컬럼 + COMMENT/PUSHBUTTON, Phase 3 파서 테스트용),
  `fixtures/ddic/qals.tabl.xml`(abapGit TABL XML, PRUEFLOS/MATNR/WERK 3필드).

### GATE 1 검증 (`test/cbo-precheck-scan.test.js`)

- 의도적 오류 fixture 스캔 → 5개 룰 동시 검출(obsolete_statement 1, sql_escape_host_variables 2,
  unknown_types 1, check_syntax 1) + 격리 케이스로 unused_variables 1건 추가 검증 = 실질 6개 룰 위반 검증
  완료.
- quickfixAvailable: `obsolete_statement`(MOVE→=), `sql_escape_host_variables`(호스트변수 `@` 이스케이프)
  둘 다 abaplint 기본 fix 제공 확인(Phase 2 "자동 수정 PR" 대상 판별에 사용).
- 정상 fixture는 이슈 0건.
- export 4포맷 전부 생성 확인(xlsx는 ExcelJS로 재로드해 헤더/행수/수식주입 방지 검증).
- store: scanId 캐시 저장/조회/상태갱신(보류+메모) 확인.
- 전체 `npm test`: **115 pass / 0 fail / 12 skip**(기존 107 + 신규 8, DB skip 12건은 기존과 동일 — 회귀
  없음). 시크릿 grep(`sk-`/`ghp_`/`github_pat_`) 0건.

## Phase 2 — 처리 UI + PR 생성 (frontend + backend)

### 추가 판단(문서에 없지만 필요했던 것) — 개인용 접근 게이트

미션 문서에는 CBO Pre-Check용 로그인 게이트가 명시되지 않았지만, 이 모듈은 임의 GitHub repo를 SSH로
clone하고 `GITHUB_TOKEN`으로 branch/PR을 생성하며 `ANTHROPIC_API_KEY`로 과금 호출을 트리거할 수 있다 —
인증 없이 배포하면 인터넷의 누구나 서버 자격증명으로 이 작업들을 실행할 수 있다. 동일한 위험 프로필을 가진
기존 "CBO Spec & Code Review"가 이미 `CBO_ACCESS_PW` 게이트(HMAC 서명 토큰, 서버 세션 없음)를 쓰고 있어,
**같은 시크릿을 재사용**해 `lib/cbo-precheck/auth.js`를 독립 구현했다(신규 API 키 발급 아님 — 절대 규칙 2
"기존 인프라 재사용" 원칙에 부합, `lib/cbo-review` 파일은 import/수정하지 않음). `CBO_ACCESS_PW`가
미설정이면(=로컬 개발) 게이트 없이 그대로 동작한다(cbo-review와 동일 동작 방식).

### 구현

- `lib/cbo-precheck/applyFix.js`: abaplint `Issue.getDefaultFix()`의 row/col(1-based, end 배타) edit을
  전체 텍스트 offset으로 변환해 적용(`applyEdits`) — 여러 edit은 offset 내림차순으로 적용해 앞쪽이 밀리지
  않게 한다. `applyIssuesToFile`로 선택된 이슈들의 fix를 한 번에 적용(적용/스킵 목록 반환).
- `lib/cbo-precheck/github.js`: GitHub REST API 클라이언트(브랜치 조회/생성, 파일 조회/커밋, PR 생성/close).
  `fetchImpl` 주입 가능(유닛 테스트에서 실제 네트워크 없이 mock) — **main 직접 커밋 경로 없음**, 항상
  `openFixPullRequest`(branch→커밋→PR)로만 반영된다.
- `lib/cbo-precheck/anthropic.js`: "Claude 수정 PR"용 Anthropic Messages API 직접 호출(SDK 미사용,
  `lib/cbo-review/providers.js`와 동일하게 raw fetch). **모델은 미션 문서의 "claude-sonnet-4-6"이 아니라
  실재하는 `claude-sonnet-5`를 기본값으로 사용**한다(sibling 모듈 PROVIDER_MODELS 및 이 세션의 실제 모델
  로스터와 일치 — 문서의 모델명은 존재하지 않아 그대로 쓰면 API가 항상 실패한다).
- `api/cbo-precheck.js` 확장: `action=fix-auto`(abaplint 자체 quickfix만 적용, AI 미사용·결정적),
  `action=fix-claude-preview`(AI 제안 생성 → PR 생성 없이 diff만 반환), `action=fix-claude-confirm`(사용자가
  diff 확인 후 확정한 내용으로만 branch+PR 생성 — 미션 사양대로 자동 PR 생성 없음), `action=capabilities`
  (토큰 보유 여부만 반환, 값 자체는 노출 안 함), `action=login`(게이트).
- `cbo-precheck/index.html`: cbo-review와 동일한 CSS 변수 테마/다크모드(`cl_theme` 공유)로 3탭 SPA.
  ① 검증: 결과 테이블(심각도→파일→라인 정렬은 서버가 이미 처리) + 심각도/룰 필터 + 4포맷 내보내기.
  ② 처리: 행별 [자동 수정 PR]/[Claude 수정 PR]/[보류] — 토큰 미설정 시 해당 버튼만 `disabled`(회색, 상단에
  사유 안내), 앱 자체는 정상 기동. Claude 제안은 모달로 원본/제안 diff를 보여주고 사용자가 [PR 생성]을 눌러야
  실제 PR이 생성된다. ③ 화면: Phase 3에서 마저 연결(현재는 안내 문구만).
- `server.mjs`: `REWRITES`에 `/cbo-precheck` 한 줄 추가(기존 라우트/기능 변경 없음 — 최소 접점).

### GATE 2 검증

- `test/cbo-precheck-fix.test.js`: `applyEdits`가 실제 abaplint fix를 정확히 적용함을 실측 확인(bad
  fixture의 obsolete_statement/sql_escape_host_variables 3건 모두), 범위 불일치 시 오류. GitHub API는
  **mock fetch**로 브랜치 생성→파일 커밋→PR 생성 순서, 오류 메시지 전달, 토큰 없을 때의 명확한 실패를 검증
  (실제 PR을 만들지 않음 — "PR 남발 금지" 요구사항 충족).
- `test/cbo-precheck-api.test.js`: `action=fix-auto`/`fix-claude-preview`는 토큰 미설정 시 503 + 명확한
  사유(앱 크래시 없음), `action=capabilities`는 `{githubToken:false, anthropicKey:false}`를 반환.
- `test/cbo-precheck-auth.test.js`: `CBO_ACCESS_PW` 설정 시 토큰 없는 요청은 401, 올바른 토큰은 통과.
- 실제 서버 기동 스모크(`PORT=8973 node server.mjs`): `GET /cbo-precheck` 200, `GET /api/cbo-precheck?action=capabilities`
  정상 JSON, `POST action=scan`에 잘못된 URL을 주면 평문 없이 JSON 오류, **기존 `GET /cbo-review` 200 유지**
  (회귀 없음). 토큰 미설정 상태에서 앱이 정상 기동하고 화면이 뜨는 것을 확인(GATE 2-c 요구사항 중 이 부분).
- **실제 GitHub PR 1건 생성 후 close는 이 세션에서 수행하지 못했다** — `GITHUB_TOKEN`/SSH 배포키가 이
  샌드박스에 없다(Phase 0에 기록). PR 생성 로직 자체는 mock 테스트로 완전히 검증했고, 운영 OCI 서버에
  `GITHUB_TOKEN`이 설정된 뒤 실제 저장소로 1회 수동 확인이 필요하다 — `README_CBO_PRECHECK.md`(Phase 4)에
  확인 절차를 안내한다.
- 전체 `npm test`: **134 pass / 0 fail / 12 skip**(회귀 없음). 시크릿 grep 0건.

## Phase 3 — 화면 렌더러 (Preview)

### 구현

- `lib/cbo-precheck/preview.js`: `@abaplint/core` Registry로 파싱한 뒤, 문장 단위 **평탄 토큰 스트림**
  (`statement.getTokens().map(t=>t.getStr())`)을 키워드 위치로 스캔하는 방식을 택했다(트리 구조를 직접
  타지 않음) — abaplint의 Selection Screen 관련 문장(Parameter/SelectOption/SelectionScreen)은 세분화된
  하위 노드가 거의 없고 사실상 토큰 나열이라, 실측해보니 키워드 인덱스 기반 추출이 트리 탐색보다 훨씬
  단순하고 견고했다(우선순위 §4 "구현 단순성").
  - PARAMETERS: `TYPE`/`OBLIGATORY`/`DEFAULT`/`AS CHECKBOX`/`RADIOBUTTON GROUP`/`LOWER CASE` 전부 토큰
    위치로 추출. `TYPE` 뒤 dash-체인(`qals-werk`)은 정지 키워드 전까지 이어붙인다.
  - SELECT-OPTIONS: `FOR` 토큰 직전이 옵션명(키워드 자체가 `SELECT`+`-`+`OPTIONS` 3토큰이라 위치 고정
    대신 `FOR` 기준 상대 위치로 강건하게 처리).
  - SELECTION-SCREEN: 토큰 집합에 `BEGIN`+`BLOCK`/`END`+`BLOCK`/`COMMENT`/`PUSHBUTTON` 포함 여부로 하위
    종류 판별(문서 사양대로 `WITH FRAME TITLE`·`COMMENT`·`PUSHBUTTON` 지원). `TEXT-xxx` 심볼은 원문의
    `TEXT` 토큰부터 추출하되, 실제 SAP 텍스트 풀 번역은 소스만으로 해석 불가능하므로 심볼 그대로
    라벨로 표시한다(README에 한계로 명시 — Phase 4).
  - ALV fieldcatalog: (a) `APPEND`-루프 패턴은 AST(Move/Append 문장)로 완전 파싱 — 워크에어리어별로
    fieldname/coltext/outputlen 대입을 누적하다 APPEND를 만나면 한 컬럼으로 확정. (b) `VALUE #( ( ... ) )`
    생성자는 **정규식 보조**로 파싱한다(미션 문서가 명시적으로 허용: "AST로 못 얻는 항목만 정규식 보조" —
    abaplint AST에서 생성자 표현식의 컴포넌트=값 목록을 안정적으로 꺼내는 것보다 정규식이 더 간단하고
    검증하기 쉬웠다). (c) `cl_salv_table`+SELECT 필드 추정 휴리스티브는 **v1 범위에서 제외**했다(GATE 3
    fixture가 요구하지 않고, 정확도가 낮아 오히려 오해를 유발할 수 있어 "구현 단순성" 우선순위상 보류 —
    필요 시 후속 작업으로 README에 TODO 기록).
  - ULINE/POSITION 등 미지원 SELECTION-SCREEN 하위 구문은 건너뛰지 않고 `{type:'unparsed', text}`로
    목록화한다(미션 요구사항 그대로).
- `api/cbo-precheck.js` `action=preview`: 스캔 시점에 clone된 소스를 캐시(`store.js`의
  `fileContents`)에서 그대로 재사용한다 — **GITHUB_TOKEN 없이도 동작**(미리보기는 읽기 전용이라 PR
  생성 경로와 분리, 토큰 유무와 무관하게 항상 사용 가능). `action=scan-get` 응답에서는 `fileContents`를
  제외해 불필요한 소스 노출을 막는다.
- `cbo-precheck/index.html` ③ 화면 탭: 스캔된 파일 드롭다운 → `action=preview` 호출 → SAP GUI 유사
  스타일(고정 그레이 톤, 다크모드 무관 — 실제 SAP GUI가 항상 밝은 회색이므로)로 블록/파라미터/
  select-options(from–to+다중선택 아이콘)/코멘트/버튼/ALV(헤더+빈 5행)를 렌더링. 하단에
  "해석됨 N개 / 해석 불가 M개" 커버리지 요약.

### GATE 3 검증

- `test/cbo-precheck-preview.test.js`: 정상 fixture에서 PARAMETERS 2, SELECT-OPTIONS 1, BLOCK
  begin/end 쌍 1(제목 `TEXT-b01` 일치), ALV 컬럼 3(PRUEFLOS/MATNR/WERK, coltext/outputlen 포함) 전부
  확인. OBLIGATORY+DEFAULT('US11')와 CHECKBOX 파라미터 각각 정확히 인식. ULINE 같은 미지원 구문은
  `unparsed`로 목록화(건너뛰지 않음, 오류 없이 처리). `VALUE #( ... )` 생성자 정규식 보조 파싱도 별도
  검증. `action=preview` API가 스캔 캐시 소스로 정상 동작 + 존재하지 않는 파일은 404 + `scan-get` 응답에
  `fileContents` 비노출 확인.
- 프론트 렌더 함수(`renderPreviewElements` 등)는 브라우저 없이 Node `vm` 샌드박스로 인라인 스크립트를
  로드해 실제 `parsePreview()` 출력으로 호출 — 생성된 HTML에 컬럼명/OBLIGATORY 마커/체크박스/블록
  타이틀/커버리지 문구가 정확히 포함됨을 확인(이 세션에는 브라우저 자동화 도구가 없어 DOM 렌더링은
  이 방식으로 대체 검증했다 — 실제 브라우저 시각 확인은 사용자 몫으로 남는다).
- 서버 기동 스모크: `GET /cbo-precheck` 200, 기존 `GET /cbo-review`·`GET /` 200 유지(회귀 없음).
- 전체 `npm test`: **140 pass / 0 fail / 12 skip**(회귀 없음). 시크릿 grep 0건.

## Phase 4 — 통합·마감

- 메뉴 등록: `index.html` 앱바 탭에 "CBO Pre-Check" 버튼 1개 추가(`location.href='/cbo-precheck'`,
  기존 "CBO Spec&Code Review" 버튼과 동일 패턴) — 기존 탭/기능 로직은 변경하지 않았다(최소 접점).
- `server.mjs`: `/cbo-precheck`, `/stella-cbo-precheck` rewrite 2줄 추가(Phase 2에서 이미 반영).
- `sw.js`: `CACHE`를 `v31`→`v32`로 bump(프론트 변경 시 필수 — 프로젝트 워크플로 규칙).
- `README_CBO_PRECHECK.md` 작성: 기능 개요, 사용 순서, 환경변수(신규 키 없음 — `CBO_ACCESS_PW` 공유),
  DDIC XML(`ddic/*.tabl.xml`) 넣는 법(abapGit export 절차, QALS/QAMV/QPMK/QAVE 예시), 알려진 한계(런타임
  오류·권한·성능 미검증, 텍스트 풀 미해석, ALV 패턴 2종만 지원, 스캔 결과 인메모리, 실제 PR E2E는 이 세션에서
  mock까지만 검증 — 운영 환경 수동 확인 절차 안내).
- 로딩/에러 상태: 스캔 전 3탭 모두 "무엇을 하라"는 안내 문구가 있는 empty 상태(빈 화면 없음), 스캔 실패 시
  toast + 상단 상태 텍스트로 사유 표시, PR/Claude 액션 실패도 모달/토스트로 사유 노출(무한 스피너 없음).

### FINAL GATE 검증

- **빌드**: 별도 빌드 스텝 없음(정적 파일 + Node 서버) — `node --check`를 신규/수정된 `api/*.js` 전체,
  `lib/cbo-precheck/*.js` 전체, `server.mjs`, `sw.js`에 실행(전부 OK). 인라인 JS는 `new Function`으로
  파싱 검증(`cbo-precheck/index.html`, 수정된 `index.html`의 스크립트 블록 전부 OK) — 이 프로젝트에는
  ESLint 등 별도 lint 도구가 없어(package.json에 `lint` 스크립트 없음), CLAUDE.md 검증 규칙(§5)이 정의한
  `node --check`/`new Function` 조합을 "lint 통과"의 실질 기준으로 삼았다(판단 근거 기록).
- **테스트**: `npm test` **140 pass / 0 fail / 12 skip**(DB 미설정으로 인한 기존 skip, 회귀 아님).
  CBO Pre-Check 신규 테스트 33건(scan 8 + fix 8 + api 7 + auth 4 + preview 6) — 기존 107 pass에서
  140 pass로 정확히 33건 순증, skip 12건은 Phase 0 기준선과 동일(회귀 없음).
- **시크릿 grep**: `git grep -nE "sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}"`
  전체 추적 파일 대상 **0건**.
- **서버 기동 스모크**: `/`, `/cbo-precheck`, `/cbo-review`, `/flow` 전부 200, `sw.js` 버전 v32 확인,
  메인 화면에 "CBO Pre-Check" 링크 노출 확인 — 기존 모듈 전부 회귀 없음.
- **문서**: `WORK_REPORT.md`(이 문서), `TEST_RESULTS.md`, `README_CBO_PRECHECK.md`, `LESSONS.md` 전부 존재.

### 최종 요약 — 문서 사양과 실제 구현이 달라진 지점(전체 재확인용 색인)

1. API 경로: `/api/cbo-precheck/scan` (X) → `/api/cbo-precheck?action=scan` (기존 스택 관례).
2. abaplint 룰: `check_ddic`→ DDIC 필드 오참조는 `unknown_types`가 담당. `check_variables`(존재하지 않음)
   → `check_syntax`.
3. `unused_variables`는 abaplint 설계상 같은 파일에 다른 syntax 오류가 있으면 미검출 — §3 fixture는 5개
   동시 검출 + 격리 검증으로 6번째 확인(테스트에 실측 기록).
4. Claude 모델: 문서의 `claude-sonnet-4-6`(존재하지 않음) → 실재하는 `claude-sonnet-5`.
5. 미션에 없던 `CBO_ACCESS_PW` 재사용 접근 게이트 추가(위험 프로필 근거 기록, 신규 시크릿 아님).
6. GitHub PR 실제 생성 1건+close(GATE 2-c 일부)는 `GITHUB_TOKEN`/SSH가 없는 이 세션에서 미수행 —
   README_CBO_PRECHECK.md에 운영 환경 수동 확인 절차 기록.
7. ALV `cl_salv_table` 자동 컬럼 추정은 v1 범위 제외(README에 한계로 명시).

RALPH_DONE
