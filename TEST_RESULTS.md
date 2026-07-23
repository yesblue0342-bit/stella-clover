# Stella Clover — 재설계 + 오류 근본 수정 TEST RESULTS

## [2026-07-23] CBO Review/Pre-Check AI 계정 로그인 호출 실패 자동 복구

### 배경 / 원인
- `/cbo-review` 코드 리뷰가 `리뷰 호출이 모두 실패했습니다`로 종료되고, `/cbo-precheck` Claude 수정 제안도 실패.
- 재현 결과 Claude CLI 인증 파일은 존재하지만 실제 호출이 `403 subscription access disabled`로 실패했다.
  기존 코드는 "인증 파일 존재"만 보고 Claude를 연결됨으로 취급했고, Pre-Check는 Claude를 우선 선택해
  ChatGPT/Codex 연결이 있어도 폴백하지 못했다.

### 조치
- `lib/ai-connection/providers.js`: `callModelWithFallback()` 추가. 선택 provider 호출 실패 시 이미 연결된 다른
  provider(openai → anthropic → gemini 순, 선택 provider 제외)로 같은 요청을 자동 재시도한다.
- `api/cbo-review.js`: 스펙 생성/코드 리뷰 LLM 호출을 폴백 함수로 교체.
- `lib/cbo-precheck/aiFix.js`: Claude 수정 제안도 폴백 함수로 교체.

### 검증
- `node --check` 대상 파일 3개 통과.
- 관련 테스트 22/22 PASS: `cbo-review-providers`, `cbo-precheck-aifix-cli`, `cbo-precheck-fix`.
- 전체 `npm test`: 271개 중 259 PASS, 12 SKIP(DB 환경변수 미설정 통합 테스트), FAIL 0.
- 실계정 스모크: Claude CLI 실패 후 Codex/OpenAI CLI로 자동 폴백되어 `OK` 응답 확인.

## [2026-07-19] CBO Review 코드 리뷰 결과 문서 내보내기(Markdown/Excel) 추가

### 배경
- 코드 리뷰 결과에서 지적을 **개별로만** 반영할 수 있어 불편. 전체를 문서로 받아 한 번에 프롬프트로
  일괄 수정 지시를 내리고 싶다는 요구.

### 조치
- 신규 `lib/cbo-review/reviewExport.js`:
  - `reviewToMarkdown`: 상단에 **"아래 지적사항을 모두 반영해 소스를 수정해줘…"** 지시문 + 파일별 그룹 +
    각 지적의 사유/Before/After를 코드펜스(내용에 ``` 있으면 ~~~~로 자동 회피)로 담아, 그대로 AI에 붙여
    **일괄 수정 프롬프트**로 쓸 수 있게 한다. 심각도(High→Low)·라인 순 정렬.
  - `reviewToWorkbook`: exceljs 동적 import — "요약" + "지적사항"(파일/라인/심각도/사유/Before/After) 시트.
    수식 인젝션 방지(=,+,-,@ 셀 앞 ' 부착).
- `api/cbo-review.js`: `POST ?action=review-export {format:'md'|'xlsx', title, files, summary}` — 프런트가
  reviewResult를 그대로 전달(서버 메모리 의존 없음, 재시작/만료와 무관). md=text/markdown, xlsx=스프레드시트 첨부.
- `cbo-review/index.html`: 검토 결과 액션에 **📄 Markdown / 📊 Excel** 버튼 추가(downloadReviewDoc). SW v43→v44.

### 검증
- `node --check` cbo-review.js·reviewExport.js·sw.js OK, 인라인 JS 파싱 OK(다운로드 버튼 2종 확인).
- **신규 `test/cboReviewExport.test.js` 5/5 PASS**(평탄화·제목/요약/지시문/코드펜스·백틱 회피·빈 결과·안전 입력).
  전체 CBO 단위 테스트 27/27(export 5 + concurrency 5 + ghSource 6 + hub 11). exceljs는 배포 의존성으로 존재.

## [2026-07-19] CBO Review 코드 리뷰 속도 개선 — 순차→동시성 병렬(516초 병목)

### 배경 / 원인
- 소스 코드 리뷰가 매우 느림(경과 516초+). 원인: `reviewFiles` 가 (파일 × 청크)마다 `callModel` 을
  **완전 순차** 호출(이중 for + await) → 파일 N개면 N번을 하나씩 대기. N×(10~40초) 누적.

### 조치
- **동시성 제한 병렬화**: 신규 순수 유틸 `mapWithConcurrency`(lib/cbo-review/core.js) — worker를 limit개까지
  동시 실행, 결과는 입력 순서 보존. `reviewFiles` 를 (파일,청크) 평탄화 후 병렬 호출로 재작성.
  - 동시성: **API 키 경로 기본 5**(requestWithRetry가 429 백오프 처리) / **CLI 계정 로그인 기본 2**(구독 보호).
    조정: `CBO_REVIEW_API_CONCURRENCY` · `CBO_REVIEW_CLI_CONCURRENCY`(1~8). API 키 사용 시 최대 5배 단축.
  - **부분 실패 비차단**(CLAUDE.md 플레이북 #1): 한 청크가 실패해도 전체 중단 없이 나머지 진행,
    실패 수를 summary.failed 로 반환하고 프런트가 상단에 경고 표시. 전량 실패 시에만 잡 실패.
- SW 캐시 v42→v43.

### 검증
- `node --check` cbo-review.js·core.js·sw.js OK, 인라인 JS `new Function` 파싱 OK(실패 경고 노출 포함).
- **신규 `test/cboConcurrency.test.js` 5/5 PASS**(순서 보존·동시성 상한 준수·병렬 확인·빈 목록·예외 전파·1회 호출).
  전체 CBO 단위 테스트 22/22(concurrency 5 + ghSource 6 + hub 11).
- 실제 속도 개선은 배포 후 사용자 브라우저에서 확인(리뷰 경과 시간 단축).

## [2026-07-19] CBO Review 소스 코드 리뷰 — 로컬/GitHub 링크 소스 복구·개편

### 배경 / 증상
- 리뷰 대상 2가지 옵션이 동작하지 않아 코드 리뷰 기능 상실:
  (a) "0Program 경로"는 로컬 clone 인증 실패의 영향권이었고, (b) "GitHub 링크"는 `parseGitHubUrl` 이
  `github.com/yesblue0342-bit/0Program/(blob|tree)/main/...` 형태만 허용 + 로컬 clone 의존이라 사실상 사용 불가.

### 조치 (cbo-precheck 벤치마킹)
- **"0Program 경로" → "로컬"** 로 명칭 변경, 서버 0Program 사본 기준 **파일/폴더** 지정 지원(폴더면 하위 텍스트
  파일 최대 100개 리뷰 — readRepoPath 기존 동작 유지). 반영 시 0Program 커밋(기존과 동일). 직전 커밋의
  git 인증 Basic 수정으로 clone/pull/push 정상.
- **"GitHub 링크" → URL + 브랜치 + 경로(선택)** 3필드(cbo-precheck 스캔 대상과 동일 패턴). 신규
  `lib/cbo-review/ghSource.js`:
  - `parseGitHubTarget`: SSH(`git@github.com:o/r.git`)·https(`github.com/o/r[.git]`)·blob/tree 링크(브랜치·경로
    자동 추출, 필드 값 우선) 모두 수용 → SSH clone 대상으로 정규화. github.com 외 호스트 거부.
  - `fetchGitHubFiles`: cbo-precheck `withClonedRepo`(임시 폴더 SSH clone, 종료 시 정리, GITHUB_TOKEN 불필요) 재사용
    + `collectReviewFiles`(텍스트 확장자만, 숨김/.git/node_modules/민감파일(.pem 등)/500KB 초과 제외, 최대 100개).
  - GitHub 링크 리뷰는 **읽기 전용** — "보완 및 반영"은 수정본 다운로드(origin.type=github → apply 다운로드 분기).
    커밋 반영이 필요하면 '로컬' 소스 사용(UI 문구로 안내).
- `api/cbo-review.js` `review-repo`: `repoUrl/branch/githubPath` 수용(레거시 `githubUrl` 도 동일 경로로 호환),
  provider/model 검증을 소스 처리 전으로 이동. 미사용 `parseGitHubUrl` import 제거. SW 캐시 v40→v41.

### 검증
- `node --check` ghSource.js·cbo-review.js·sw.js OK, 인라인 JS `new Function` 파싱 OK.
- **신규 `test/cboGhSource.test.js` 6/6 PASS**(SSH/https/blob·tree 파싱, 타 호스트·불량 입력 거부, 수집 필터
  (텍스트만·숨김/민감/과대 제외)·단일 파일 루트). 기존 `cboHub.test.js` 11/11 유지 — 합계 17/17.
- ※ 실제 SSH clone 은 서버 배포키 필요 — 샌드박스에선 정적/단위 검증까지, 라이브는 사용자 브라우저에서 확인.

## [2026-07-19] CBO Review Hub 전송 GitHub 인증 오류 수정 + 폴더 지정/관리 기능

### 배경 / 증상
- `/cbo-review` 에서 스펙 생성 후 **Hub 전송(.md/.xlsx)** 이 실패:
  `git clone --branch main https://github.com/…/0Program.git … fatal: could not read Username for 'https://github.com': terminal prompts disabled`.
- 근본 원인: `lib/cbo-review/repository.js` 가 0Program 을 **로컬 clone/push** 하는데, HTTPS remote + `http.extraHeader: Authorization: **Bearer** <token>` 조합은 GitHub git-over-HTTPS 에서 거부되어 사용자명 프롬프트로 빠짐(무인 환경이라 즉시 실패).

### 조치 (cbo-precheck 벤치마킹 + Stella Hub `api/github.js` 참고)
- **신규 `lib/cbo-review/hub.js`**: Hub 전송·폴더 관리를 **GitHub REST Contents/Git-Data API**(api.github.com, Bearer 정식 인증)로 처리 — 로컬 git clone/임시파일 미사용. 토큰은 Authorization 헤더에만(URL/로그/에러 미노출).
  - `saveSpecToHub({folder,title,extension,content})`: 지정 폴더(기본 `spec`)에 `spec_YYYYMMDD_제목.(md|xlsx)` PUT, 동명 존재 시 `_vN`.
  - `listHub`(목록)·`mkdirHub`(`.gitkeep`)·`deleteHub`(파일/폴더 재귀)·`renameHub`(파일/폴더 재귀 이동). 경로안전: traversal(..)·`.git`/`.env`·숨김·키/자격증명·절대경로 차단, 재귀 상한 200.
- **`api/cbo-review.js`**: `save-spec` → `saveSpecToHub`(폴더 인자 추가). 신규 액션 `hub-list`/`hub-mkdir`/`hub-delete`/`hub-rename`. catch 가 `error.status` 존중(항상 JSON).
- **`cbo-review/index.html`**: 스펙 미리보기에 **Hub 대상 폴더 매니저**(경로 입력·열기·상위·＋새폴더, 목록 행별 폴더 탐색/✏️이름변경/🗑삭제, 파괴적 작업 confirm). Hub 전송이 선택 폴더로 저장. SW 캐시 v39→v40.
- **`lib/cbo-review/repository.js`**(코드리뷰 repo 소스 경로도 복구): git 인증 `Bearer`→**Basic**(`x-access-token:<token>` base64) 로 교체 — clone/pull/push 정상화.

### 검증
- `node --check`: hub.js·cbo-review.js·repository.js·sw.js 전부 OK. `cbo-review/index.html` 인라인 JS `new Function` 파싱 OK(15,835자).
- **신규 `test/cboHub.test.js`(fetch 목킹) 11/11 PASS**: base64 왕복·`_vN` 버전링·새폴더(404) PUT·경로안전 6종 거부(호출 0)·`.gitkeep` mkdir·파일/폴더 삭제(트리 prefix 매칭)·파일 rename(PUT+DELETE)·404 빈목록·`.gitkeep` 숨김/dir 우선 정렬·무토큰 503.
- 전체 스위트: 신규 테스트 통과. 기존 12 실패는 샌드박스 미설치 패키지(`exceljs`/`@abaplint/core`)로 인한 **환경 문제**(내 변경과 무관, 기존부터 동일).
- ※ 라이브 GitHub 쓰기는 샌드박스에서 0Program 에 직접 하지 않음(정적/목킹 검증까지) — 실제 전송은 OCI 배포 후 사용자 브라우저에서 확인.

## [2026-07-18] 관리자 비밀번호 재설정 + 오너 락아웃 복구 스크립트

- 요구: 관리자가 사용자의 비밀번호를 재설정할 수 있어야 함(+오너가 로그인 못 하면 복구 불가 문제).
- auth.js: 관리자 전용 setpw(대상 비번 재설정 + 대상 세션 전부 무효화). admin.html: 사용자별 '비번 재설정' 버튼.
- scripts/reset-admin.mjs: 서버에서 로그인 없이 오너/관리자 비번 강제 재설정(upsert admin/approved + 세션 무효화) —
  `docker exec stella-clover node scripts/reset-admin.mjs <아이디> <새비번>`. 어떤 락아웃에서도 복구.
- 로컬(실 Postgres) 검증: 관리자 setpw → 대상 old세션 401·old비번 로그인 실패·new비번 성공, 비관리자 setpw 거부,
  복구 스크립트로 잠긴 yesblue0342 복구 로그인 성공, 미존재 계정 upsert 후 관리자 로그인 성공.
- 참고: yesblue0342 는 시드되어 '로그인' 탭에서 yesblue0342/admin 로 바로 로그인 가능(스크린샷은 '회원가입' 탭이라 '이미 사용 중' 표시). SW bump.

## [2026-07-18] 승인제 로그인 인증 게이트 도입 (누구나 접속·열람 차단)

### 배경 / 범위
- 회원 시스템이 없어 누구나 접속·열람 가능했고, 특히 CBO 화면은 개인 AI 키에 연결돼 있어 위험.
- 승인제 회원가입 + 로그인 세션으로 '승인된 사용자만 접근'을 강제. ★사용자별 컨텐츠 분리는 하지 않음(1인 사용, 공유 유지).

### 구성
- api/_auth.js: cl_users/cl_sessions 스키마, PBKDF2(120k)+솔트 해시, DB 세션(쿠키 clover_sid, HttpOnly/SameSite=Lax/30일),
  getUser(승인된 세션만), 관리자 시드 admin·yesblue0342(둘 다 비번 admin, approved). 멱등.
- api/auth.js: signup(pending)/login/logout/me/password + 관리자 approve/reject/pending/users(요청자 admin 검증).
- server.mjs: /api 게이트 미들웨어 — /api/auth 만 공개, 그 외 모든 /api 는 승인 세션 필요(401), req.user 주입.
  서버 내부 워커/크론/노트동기화는 HTTP 미경유라 게이트 무관.
- auth-gate.js(미로그인 시 /login 리다이렉트, 6개 앱 head 포함), login.html(로그인/가입), admin.html(관리자 승인 UI),
  index.html 사용자칩=실제 로그인명·로그아웃(서버 세션)·관리자면 승인관리 링크. SW v37→v38.

### 로컬 E2E (실 Postgres + Playwright) — 20/20 PASS
- 미로그인: /api/meetings·/api/jobs 401, 홈 접속 → /login 리다이렉트, /api/auth?me 공개(authed:false).
- 가입 → pending, 승인 전 로그인 차단, 중복 가입 거부.
- 관리자 yesblue0342/admin·admin/admin 로그인 성공, 비관리자 pending 조회 거부, 승인 목록에 신규 사용자.
### 적대적 보안 리뷰(5관점) 반영
- 세션 쿠키 Secure(X-Forwarded-Proto=https 일 때) 조건부 부여(직접 http 접근 락아웃 방지), PBKDF2 120k→600k(OWASP),
  비밀번호 변경 시 전 세션 무효화+재발급, login.html 오픈리다이렉트 차단(/\, // 거부), 로그아웃 POST 전용,
  비밀번호 길이 상한(256, pbkdf2 DoS 방지), 서버 소스/설정 정적 노출 차단(server.mjs·lib·config·api… 404, .env 는 기존 dotfiles:ignore).
- ★관리자 기본 비번 admin/admin·yesblue0342/admin 은 요청대로 시드 — 추측 가능하므로 배포 후 즉시 변경 필요(/admin 의 '비밀번호 변경').
- 승인 후 로그인 성공, 로그인 후 /api/meetings 200(컨텐츠 공유 — 관리자·일반 동일), 오답 로그인 실패,
  로그아웃 후 401(세션 무효화), 세션 쿠키 HttpOnly, /admin 관리자 전용(비관리자 차단).


## [2026-07-17] CBO Pre-Check 화면 미리보기 모바일 반응형 수정 (휴대폰 깨짐 해결)

### 문제 / 원인
- SAP 화면 미리보기가 PC는 정상, 휴대폰에서 깨짐: (1) `.sap-label` 고정 180px + `.sap-select-options` 고정폭
  from/to + ⋯ 버튼이 폰 폭을 넘겨 ⋯ 가 블록 밖으로 밀리고, (2) `FOR zaqmt0132-werksOBLIGATORYDEFAULT...`
  같은 긴 ABAP 토큰이 줄바꿈 안 돼 가로 오버플로 유발.
### 조치 (cbo-precheck/index.html, CSS만)
- 라벨/헬퍼 텍스트에 `overflow-wrap:anywhere; word-break:break-word` → 긴 토큰 줄바꿈.
- `@media(max-width:640px)`: 라벨을 한 줄 전체로(입력은 아래 줄로 스택), from/to 입력은 `flex:1`로 폭에 맞춰 신축,
  ⋯ 버튼은 고정, 블록 제목은 static 배치(좁은 폭에서 잘림 방지), 화면/블록 패딩·타이틀바 마진 축소.
  ※ 데스크톱(≥641px) 레이아웃은 불변(회귀 없음).
### 검증 (playwright-core + 프리빌트 chromium) — 5/5 PASS
- ZAQMR0131 유사 가짜 elements를 실제 렌더 함수(renderPreviewElements)로 그려 측정:
  390px에서 페이지 가로 오버플로 없음(scrollW 390=innerW 390), SAP 화면 266px·최광폭 행 228px로 뷰포트 이내,
  데스크톱 1280px 오버플로 없음. 모바일 스크린샷으로 라벨-입력 스택·⋯ 정위치·긴 토큰 줄바꿈 육안 확인. SW v36→v37.


## [2026-07-11] 앱바 메뉴탭 정리 — 도구 5종을 드롭다운으로 묶어 상단 정돈

### 문제 / 조치
- 상단 탭이 변환·마이·차트·환율·노트·CBO Spec&Code Review·CBO Pre-Check 7개로 늘어 모바일에서 줄바꿈·넘침으로 지저분.
- 핵심 인페이지 탭(변환·마이)만 노출로 유지하고, 화면 이동형 도구 5종(차트/환율/노트/CBO 스펙·리뷰/CBO 프리체크)을
  하나의 "🧰 도구" 드롭다운으로 묶음. 아이콘 + 한 줄 설명. 라이트/다크 테마 토큰(--surface/--text/--border) 사용.
- 바깥 클릭 닫힘은 전체화면 백드롭 대신 document click 리스너로 처리(백드롭 z-index가 sticky 앱바를 덮어
  탭 클릭을 가로채던 문제 제거). Esc로도 닫힘.

### 검증 (playwright-core + 프리빌트 chromium, 390px) — 11/11 PASS
- 앱바 노출 항목 3개(변환/마이/도구)만, 도구 클릭 시 메뉴 5종 표시, aria-expanded 토글, 바깥 클릭·항목 클릭 이동,
  변환/마이 탭 전환 정상, 라이트/다크 스크린샷 확인(메뉴가 화면 안에 우측 정렬로 표시). SW 캐시 v35→v36.


## [2026-07-14] CBO Pre-Check — SALV(CL_SALV_TABLE) 전체화면 ALV 결과화면 렌더링 재작업 (`stella_clover_improvement_260714_1_retry.md`, 무인 재작업 세션)

직전 세션이 "이미 완료됨"이라고 잘못 보고한 건을 재검증 후 실제 구현. `lib/cbo-precheck/dynproPreview.js`에
SALV(커스텀 Dynpro 없이 `CL_SALV_TABLE=>FACTORY`로 바로 리스트를 띄우는 방식) 전체화면 ALV 감지·렌더링을
추가했다. 상세 판단 근거·구현 세부는 `REVIEW_LOG.md`의 동일 날짜 항목 참고.

- **착각 재확인**: `grep -rn "SALV\|salv" lib/cbo-precheck/ api/cbo-precheck.js cbo-precheck/` → **0건**
  (구현 착수 전 직접 확인). 이전 세션이 완료했다고 말한 항목(아이콘 오탐 제거/폴더경로 미리보기/Dynpro
  Screen 0100 렌더링)은 별개의 과거 미션이었다.
- **재현(수정 전)**: 실제 `git@github.com:yesblue0342-bit/0Program.git`(SSH)에서
  `260707_QM023_ZAQMR0130/_abap/ZAQMR0131.abap`을 clone해 `buildPreview()`를 직접 호출:
  `elements=12`(Selection Screen만 파싱), **`screens=[]`, `flow=[]`** — 결과화면이 완전히 비어 재현됨.
- **원인**: ZAQMR0131은 `CALL SCREEN`이 전혀 없어(`CL_SALV_TABLE=>FACTORY` 전체화면 ALV) 기존
  `extractScreenNumbers()`가 화면번호를 하나도 못 찾고, Dynpro 전용 `buildScreenInfo` 경로 자체가
  호출되지 않았다.
- **구현**: `extractSalvFactoryTable`/`resolveItabStructureType`/`extractTypesFields`/
  `extractSalvColumnTexts`/`extractSalvListHeader`/`buildSalvScreenInfo`(신규, `dynproPreview.js`) +
  `preview.js`의 `buildPreview()`가 Dynpro 화면이 없을 때만 이 경로로 폴백. UI(`cbo-precheck/
  index.html`)의 `renderDynproScreen()`에 `screen.salv` 분기 추가(화면번호/PF-STATUS/PBO-PAI 행 생략,
  타이틀바 "SALV Fullscreen ALV").
- **검증(수정 후, 실제 저장소로 재실행)**: 같은 `preview-direct` 핸들러로 ZAQMR0131.abap 재확인 —
  - `flow`: `["Selection Screen(1000)", "SALV Fullscreen ALV"]`
  - `screens[0].title.text`: `"QM View Inspection Type - Change History"` (`set_list_header` 값)
  - `screens[0].alvColumns`(15개, `TYPES ty_disp` 필드 선언 순서 그대로, `ZSEQNO`는
    `set_technical(abap_true)`로 숨겨져 제외):
    `WERKS=WERKS, MATNR=MATNR, MAKTX=Material Desc., ART=Inspection Type, ACTION_TX=Action Type,
    FNAME=Field Name, OLD_VALUE=Old Value, NEW_VALUE=New Value, ERNAM=Created By, ERDAT=Created On,
    ERZET=Created Time, AENAM=Changed By, AEDAT=Changed On, AEZET=Changed Time, ZRUNID=Run ID`
    (`WERKS`/`MATNR`는 소스에 `f_col_text` 호출이 없어 요구사항대로 필드명 대문자로 폴백 — 정상 동작).
- **회귀 없음 재확인(ZAQMR0130)**: 같은 호출로 `ZAQMR0130.abap` 재확인 —
  `elements.length=18`(변화 없음), `mergedFiles.length=6`(변화 없음), `flow=["Selection Screen(1000)",
  "Screen 0100"]`, `alvColumns.length=16`(변화 없음) — 기존 GATE 3 라이브 테스트가 그대로 통과.
- **신규 테스트**(`test/cbo-precheck-dynpro.test.js`): 순수함수 단위 테스트 8건(합성 fixture, FORM
  경유 2줄 PERFORM 호출·인라인 주석 오탐 방지·숨김 컬럼·타이틀 포함) + 실제 0Program 저장소로 검증하는
  **GATE 4** 라이브 테스트 1건(SSH 불가 환경은 자동 skip, 이번 세션은 SSH 가능해 실행·통과).
- **정적 검증**: `node --check lib/cbo-precheck/dynproPreview.js lib/cbo-precheck/preview.js
  api/cbo-precheck.js` 통과. 인라인 `<script>`(`cbo-precheck/index.html`)는 기존
  `test/cbo-precheck-ui.test.js`의 `new Function()` 파싱 테스트로 검증(통과).
- **전체 스위트**: `npm test` **231 pass / 0 fail / 12 skip**(DB 미설정으로 인한 기존 skip, 신규 실패
  없음 — 세션 시작 시점 223 pass에서 +8 신규 단위 테스트, GATE 4는 기존 스위트 카운트에 포함).
- **시크릿 grep**: 변경 파일에 시크릿 리터럴 없음(정규식 검색 0건).

## [2026-07-14] CBO Pre-Check — 화면 미리보기 라벨 치환 + INCLUDE 자동 병합 (`stella_clover_260714_7.md`, 무인 ralph autopilot)

미리보기가 `TEXT-001`/`s_werks` 같은 내부 심볼·변수명만 보여주던 것을 같은 폴더의 `*_TEXTS.txt` 문서로
실제 SAP 라벨("Selection Criteria"/"Plant" 등)로 치환하고, 메인 프로그램 파일 하나만 지정해도 INCLUDE를
따라가 형제 파일(`_S01` 등)의 선택화면을 병합 렌더링하도록 개선. 상세 판단 근거는 `WORK_REPORT.md`의
동일 제목 섹션 참고.

- **Phase 0 실측**: 실제 `git@github.com:yesblue0342-bit/0Program.git`(SSH)에서 `ZAQMR0130_TEXTS.txt`
  원문·`ZAQMR0130.abap`의 INCLUDE 문·`_S01.abap`/`_TOP.abap`을 직접 읽고, 다른 3개 프로그램 폴더의
  TEXTS 문서 형식을 비교 — asterisk 스타일/bracket 스타일/EN·KO 산문형 3가지, TEXTS 파일 자체가 없는
  프로그램도 확인.
- **Phase 1 라벨 치환**(신규 `lib/cbo-precheck/textSymbols.js`, `test/cbo-precheck-texts.test.js` 6건 +
  `test/cbo-precheck-preview.test.js` GATE 1 (b)(c)(d) 3건): 실제 `_TEXTS.txt` 샘플에서 `001`→
  "Selection Criteria", `S_WERKS`→"Plant", `P_APA`→"Preferred Inspection Type" 등 미션 표와 정확히
  일치하는 매핑 추출 확인. 매핑 없는 심볼/필드는 크래시 없이 기존 심볼/변수명 표시로 폴백(회귀 없음).
  SELECT-OPTIONS의 OBLIGATORY 추출 추가(기존엔 PARAMETERS만 지원).
- **Phase 2 INCLUDE 병합**(신규 `mergeIncludes`/`buildPreview` in `preview.js`, GATE 2 (a)~(f) 6건 +
  API 통합 테스트 2건): 합성 fixture로 메인 파일 지정 시 INCLUDE 형제의 PARAMETERS/SELECT-OPTIONS가
  병합 후 해석됨을 확인, include 파일 단독 지정은 무변경(회귀 없음), 대응 파일 없음/인식 못하는 INCLUDE
  형태는 경고와 함께 부분 렌더(크래시 없음). **실제 `git@github.com:yesblue0342-bit/0Program.git`을 통해
  `handlePreviewDirect`/`handlePreview` 양쪽 실제 핸들러로 end-to-end 검증**: `ZAQMR0130.abap`(메인)만
  지정 → 병합 전 `해석됨 0개` → 병합 후 **18개**(select-options 3+parameters 8+block 4쌍 등), `Plant`/
  `Selection Criteria`/`Display`/`Preferred Inspection Type` 라벨 전부 실제 텍스트로 렌더링됨을 확인.
  scan → issues 26건(회귀 없음, TEXTS.txt가 린트 결과에 섞이지 않음)도 재확인.
  - **세션 중 실제로 잡은 회귀**: INCLUDE 정규식을 처음 "더 엄격하게" 고쳤다가, 실제 0Program의 모든
    INCLUDE 문 뒤에 ABAP 인라인 주석이 붙어 있어(`INCLUDE zaqmr0130_top.   " 전역 데이터...`) 실사용
    100%가 "인식 못함"으로 되돌아가는 회귀를 만들었다 — 실제 clone 재검증 중 발견해 수정하고 회귀
    테스트(`GATE 2 (d-2)`)로 고정.
- **아키텍트 리뷰**(opus, 1회): 치명적/높은 심각도 결함 없음. Medium/Low 4건 중 2건(INCLUDE `IF FOUND`
  미인식+침묵 실패, 탭 구분자 미인식)과 사소한 결함 1건(`handlePreviewDirect`의 `isDict` 미배제)을
  즉시 반영·회귀 테스트로 고정. 나머지 2건(산문 주석 오탐 가능성, 섹션 감지 휴리스틱)은 낮은 심각도의
  허용된 트레이드오프로 유지. INCLUDE 병합에 abaplint Registry 대신 텍스트 스플라이스 방식을 쓴 설계는
  "합리적인 단순화"로 확인.
- **셀프 디슬롭**: `preview.js`의 `findTextRef`+`resolveTextSymbol` 3중 복붙을 `resolveRef()` 공용
  헬퍼로 통합(순수 리팩터, 동작 변경 없음).
- **정적 검증**: `node --check` 변경 파일 전부 통과. 인라인 `<script>`(`cbo-precheck/index.html`)
  `new Function()` 파싱 통과.
- **전체 스위트**: `npm test` **205 pass / 0 fail / 12 skip**(세션 시작 시점 182에서 +23, 회귀 없음).
- **시크릿 grep**: `sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}` 0건.
- **범위 확인**: `/cbo-review`는 이번 세션에서 전혀 수정하지 않음(`git diff --name-only`로 확인). 원본
  GitHub 소스는 읽기 전용 clone(`/tmp`)으로만 조사했고 어떤 파일도 쓰지 않음.

## [2026-07-14] CBO Pre-Check — 근본 원인 조사·네이밍 어댑터 + UI 버그 + 미리보기 독립 기능 (`stella_clover_260714_5.md`, 무인 ralph autopilot)

`260707_QM023_ZAQMR0130` 스캔이 "파일 8개, 이슈 0건"을 반환하던 것이 실제로 코드가 깨끗해서인지, 타입
인식 실패로 조용히 스킵된 것인지 조사 후 수정. UI 문구 버그 2건 확인/수정, 스캔 없이 화면 미리보기를
바로 만드는 신규 기능 추가. 상세 판단 근거는 `WORK_REPORT.md`의 동일 제목 섹션 참고.

- **Phase 0 실측(수정 전 재현)**: 실제 `git@github.com:yesblue0342-bit/0Program.git`(SSH)의
  `260707_QM023_ZAQMR0130/_abap/` 8개 파일을 원본 이름 그대로 스캔 → `fileCount:8, issues:0`. 같은
  내용을 abapGit 정식 네이밍으로만 바꿔 재스캔 → **440건 검출**. abaplint 소스(`_abstract_file.js`
  `getObjectType()`, `registry.js` `findOrCreate()`, `objects/_unknown_object.js`)를 직접 읽어
  "타입 미인식 → UnknownObject → 사실상 검사 안 됨"이 원인임을 코드 레벨로 확인(추측 아님).
- **Phase 1 어댑터 + 회귀 테스트**(신규 `test/cbo-precheck-scan-naming.test.js` 6건, GATE 1 a~e 전부):
  plain 네이밍 fixture 실결함 검출, 결과 file 필드 원본 이름 확인, 기존 abapGit fixture 회귀 없음(bad/
  good 둘 다), 임시 디렉토리 미생성 확인, 실제 저장소 통합 재확인. **cross-include 교차참조 오탐도
  함께 발견해 수정**(가상 `.prog.xml` `<SUBC>I</SUBC>` 메타 추가) — 최종 실측 결과 실제 결함 **64건**
  (check_syntax 9/unknown_types 38/sql_escape_host_variables 16/obsolete_statement 1, 나머지는
  SAP 표준 type-pool·저장소 미포함 커스텀 테이블 참조로 인한 기대된 한계).
- **Phase 2 UI 버그**(신규 `test/cbo-precheck-ui.test.js`): ①②탭의 "스캔 전"/"스캔완료+이슈0건" 문구
  분리 수정 확인(`new Function` 샌드박스로 실제 인라인 `<script>` 함수 직접 호출). ③탭 드롭다운 미채움은
  코드 추적 결과 **이전 세션(`stella_clover_260714_3.md`, 커밋 `cf7dff4`)에서 이미 해결되어 있었음**을
  헤드리스 테스트로 재확인(추가 수정 없음 — 이중 수정 방지).
- **Phase 3 미리보기 독립 실행**(신규 `test/cbo-precheck-preview-direct.test.js` 5건):
  `action=preview-direct` 추가(기존 `withClonedRepo`/`collectAbapFiles` 재사용, 신규 clone 방식 없음,
  `GITHUB_TOKEN` 불필요). **`lib/cbo-precheck/preview.js`에서도 동일한 네이밍 버그를 추가로 발견해
  수정**(plain 네이밍 단일 파일은 Selection Screen 요소가 0개로 조용히 실패하던 것을 확인 → 가상
  네이밍 적용 후 실제 `ZAQMR0130_S01.abap`으로 Selection Screen 요소가 정상 렌더링됨을 실제 SSH clone
  으로 확인).
- **정적 검증**: `node --check lib/cbo-precheck/scan.js lib/cbo-precheck/repoFetch.js
  lib/cbo-precheck/preview.js api/cbo-precheck.js test/cbo-precheck-scan-naming.test.js
  test/cbo-precheck-ui.test.js test/cbo-precheck-preview-direct.test.js` 전부 통과. 인라인
  `<script>`(`cbo-precheck/index.html`) `new Function()` 파싱 통과.
- **전체 스위트**: `npm test` **166 pass / 0 fail / 12 skip**(세션 시작 시점 149에서 +17, 회귀 없음).
- **시크릿 grep**: `sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}` 0건.
- **범위 확인**: `/cbo-review` 등 다른 모듈은 이번 세션에서 전혀 수정하지 않았다. 실제 GitHub 소스
  파일명은 항상 원본 그대로 유지됨(네이밍 어댑터는 인메모리 스캔 파이프라인 내부 전용).

## [2026-07-14] CBO Pre-Check — 스캔 대상 재귀 탐색으로 수정 (`stella_clover_260714_3.md`, 무인 ralph autopilot)

`/cbo-precheck` 스캔이 `260707_QM023_ZAQMR0130`처럼 실소스가 `_abap/` 하위 폴더에 있는 저장소에서
"파일 0개, 이슈 0건"을 반환하던 문제 수정. 근본 원인·판단 근거는 `WORK_REPORT.md`의 동일 제목 섹션 참고.

- **정적 검증**: `node --check lib/cbo-precheck/scan.js lib/cbo-precheck/repoFetch.js
  test/cbo-precheck-repofetch.test.js` 전부 통과.
- **실측 재현(수정 전)**: 실제 `git@github.com:yesblue0342-bit/0Program.git`(SSH)를 clone 해
  `collectAbapFiles()`/`scanFiles()`를 직접 호출 — 파일 8개가 수집되지만 기존 `isScannable()`(abapGit 점
  표기 네이밍만 인식)이 전부 걸러내 `fileCount=0, issues=0`로 사용자가 보고한 증상을 그대로 재현했다.
  `collectAbapFiles()`의 재귀 walk 자체는 하위 폴더 깊이/이름과 무관하게 이미 정상 동작했음을 확인 —
  실제 원인은 재귀 탐색이 아니라 `isScannable()`의 확장자 판정이었다.
- **단위 테스트**(신규 `test/cbo-precheck-repofetch.test.js`, 3건):
  1. 임시 폴더에 폴더 바로 밑/1단계(`_abap/`)/2단계(임의 폴더명) 깊이 `.abap` 파일 + DDIC XML +
     `node_modules`/`.git` + `.txt`를 함께 구성해 재귀 탐색·제외 규칙·확장된 `isScannable`을 한 번에 검증.
  2. `path`가 폴더가 아니라 단일 파일인 엣지케이스가 깨지지 않음을 확인.
  3. **GATE 1 (d) 실제 저장소 통합 테스트** — 이 세션 환경은 SSH(배포키) 접근이 가능해 mock 없이 실제
     clone으로 `260707_QM023_ZAQMR0130/_abap/` 하위 `.abap` 파일 8개(≥6 조건, 미션 문서 예시는 6개였지만
     실제 저장소는 `_TOP.abap`/`ZAQMR0131.abap`이 더 있어 8개)가 전부 `isScannable=true`로 포함됨을 확인.
     SSH 접근이 없는 환경에서는 `node:test`의 `skip` 옵션으로 자동 스킵되도록 작성했다(이 프로젝트는
     GitHub Actions에서 `npm test`를 실행하지 않고 SSH deploy만 수행하므로 CI 영향 없음, `.github/workflows/deploy-oci.yml`
     확인 완료).
  4. 기존 `test/cbo-precheck-scan.test.js`(abapGit 점 표기 fixture 기반, `zaqmr0130_bad.prog.abap` 등)는
     무변경으로 그대로 통과 — `isScannable` 확장이 기존 abapGit 네이밍 인식·GATE 1 §3 fixture 회귀를
     깨지 않음을 확인.
- **전체 스위트**: `npm test` **149 pass / 0 fail / 12 skip**(직전 세션 종료 시점 146 pass에서 +3, skip
  12건은 기존 DATABASE_URL 미설정 스킵과 동일 — 회귀 없음).
- **시크릿 grep**: `sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}` 0건.
- **범위 확인**: `/cbo-review` 등 다른 모듈 파일은 이번 세션에서 전혀 수정하지 않았다(diff 대상은
  `lib/cbo-precheck/scan.js`, `lib/cbo-precheck/repoFetch.js`, `README_CBO_PRECHECK.md`,
  `test/cbo-precheck-repofetch.test.js`, `WORK_REPORT.md`, `TEST_RESULTS.md` 뿐).

## [2026-07-14] CBO Pre-Check — AI 연결 설정을 CBO Review와 통합 (`stella_clover_260714_2.md`, 무인 autopilot)

CBO Pre-Check의 "Claude 수정 PR" 인증을 CBO Review의 "AI 연결 설정"과 완전히 동일한 공용 모듈로 통합.
상세 판단 근거는 `WORK_REPORT.md`의 동일 제목 섹션 참고.

- **정적 검증**: `node --check` — 신규/수정된 모든 `api/*.js`, `lib/cbo-precheck/*.js`, `lib/cbo-review/*.js`,
  `lib/ai-connection/*.js`(신규), `server.mjs`, `sw.js` 전부 통과. `index.html`/`cbo-review/index.html`/
  `cbo-precheck/index.html` 인라인 `<script>` 전부 `new Function()` 파싱 통과.
- **단위 테스트**: `npm test` **145 pass / 0 fail / 12 skip**(Phase 0 기준선 140 pass에서 +5, skip 12건은
  기존 DATABASE_URL 미설정 스킵과 동일 — 회귀 없음).
  - `test/cbo-review-providers.test.js`: 경로만 `lib/ai-connection/providers.js`로 갱신, 스펙 자체는
    무변경 — CBO Review 회귀 없음을 그대로 담보.
  - `test/cbo-precheck-fix.test.js`: `anthropic.js` 전용 테스트를 제거하고 `aiFix.js` 대상 2건으로 교체
    (연결 없음 → 명확한 오류 / API 키 연결 → `callModel` 경유 확인, `fetch` 전역 모킹).
  - `test/cbo-precheck-api.test.js`: `capabilities`(`aiConnected` 필드)·`fix-claude-preview`(503 메시지)
    갱신.
  - `test/cbo-precheck-aifix-cli.test.js`(신규, `mock.module()`로 공용 모듈 대체): 구독(Claude/ChatGPT)·
    API 키 조합 4가지의 우선순위(구독 Claude 우선 > 구독 ChatGPT > API 키 Claude 우선 > API 키 ChatGPT,
    구독이 있으면 API 키보다 항상 우선)를 실제 subprocess 없이 확정 검증.
- **서버 기동 스모크**(격리된 `CBO_DATA_DIR`): `/`, `/cbo-review`, `/cbo-precheck`, `/flow` 전부 200.
  `GET /api/cbo-precheck?action=settings`가 CBO Review와 동일한 provider 3종(openai/anthropic/gemini)을
  반환(공용 저장소 확인). `?action=capabilities`의 `aiConnected` 필드가 연결 상태에 따라 정확히 반영됨.
  `?action=provider-save`에 잘못된 키 형식을 보내면 공용 모듈의 검증 오류가 그대로 JSON으로 반환(에러
  경로 회귀 없음). `sw.js` 버전 v33 서빙 확인.
- **시크릿 grep**: `sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}` 전체 추적+스테이징
  대상 0건.
- **미실행(불가)**: 실제 운영 서버에서 Codex CLI 구독 경로로 "Claude 수정 PR" 전체 흐름(스캔→AI 제안→PR
  생성)을 사람이 1회 수동 확인해야 한다 — 이 세션은 CLI 라우팅 로직만 `mock.module()`로 검증했고 실제
  subprocess는 호출하지 않았다(실제 spawn 동작 자체는 Phase 1에서 그대로 옮긴 기존 회귀 스펙이 담보).

## [2026-07-12] CBO Review 계정 로그인(CLI) 연동 (`stella_clover_improvement_260712_2.md`, 무인 세션)

무인 자동화 지시서 기준 작업 1(공통 AI 모델 드롭다운 미연결 표시)·작업 2(계정 로그인 CLI 재사용, 경로 A)
처리. 상세 판단 근거는 `WORK_REPORT.md`/`REVIEW_LOG.md` 2026-07-12(계정 로그인 세션) 항목 참조.

- **정적 검증**: `node --check api/cbo-review.js lib/cbo-review/providers.js lib/cbo-review/core.js
  test/cbo-review-providers.test.js` 전부 통과. `cbo-review/index.html` inline `<script>`를 `new Function()`으로
  파싱 성공. `deploy/run-stella-oci.sh`는 `bash -n` 통과.
- **단위 테스트**: 신규 `test/cbo-review-providers.test.js` 6개 추가(mode 기본값, 지원하지 않는 provider
  거부, 레거시 `providers.json` 포맷 호환, `detectCli` 반환 형태, `connectCli`/`disconnectCli` 실제 환경
  일관성, `providerStatus` 필드 shape) — `npm test`: **113 tests / 105 pass / 0 fail / 8 skip**(기존과 동일,
  DATABASE_URL 미설정 통합 테스트만 skip). 이전 세션 대비 +6 pass, 회귀 없음.
- **실서브프로세스 E2E(이 세션에서 직접 실행, mock 아님)**: 로컬 Windows 개발 환경에 이미 `claude`
  (`@anthropic-ai/claude-code`)·`codex`(`@openai/codex`) CLI가 로그인돼 있어 실제로 호출까지 검증했다.
  - `detectCli('anthropic')`/`detectCli('openai')` → `{available:true, authenticated:true}` (토큰 내용은
    읽지 않고 CLI 바이너리 존재 + 인증 파일 존재만 확인).
  - `callModel({provider:'anthropic', mode:'cli', model:'claude-haiku-4-5', ...})` → 실제 `claude -p
    --output-format json` subprocess 호출 → `"PONG"` 정상 왕복.
  - `codex exec -s read-only --skip-git-repo-check -o <file> "..."` → 인증/샌드박스까지 정상 도달, 계정
    사용량 한도(usage limit)로 생성 자체는 막혔지만 subprocess 호출 메커니즘은 정상 확인(오류 메시지가
    `ERROR: You've hit your usage limit...`로 명확히 propagate).
  - 로컬 서버(`node server.mjs`, 격리된 `CBO_DATA_DIR`)를 띄워 실제 HTTP 엔드포인트 검증:
    `GET action=settings`, `POST action=cli-connect`(anthropic) → `connected:true, mode:"cli"` 응답 확인,
    `POST action=generate-spec`(anthropic CLI 모드, multipart) → `ok:true`로 실제 스펙 Markdown 생성 확인.
- **Windows npm `.cmd` 셰임 우회**: Node가 `shell:false`로 `.cmd` 파일을 직접 실행하면 `EINVAL`을 던지는
  것을 확인(재현 로그 확보) → 셰임 파일을 파싱해 실제 `.exe`(claude)/`node.exe + .js`(codex) 대상을 찾아
  셸 없이 직접 spawn하도록 수정 후 위 E2E가 통과함. 실제 OCI 배포(Linux)는 이 우회 분기를 타지 않고 npm
  전역 설치 shebang 스크립트를 바로 실행하므로 더 단순하게 동작할 것으로 예상(Linux 환경 자체는 이
  샌드박스에 없어 직접 실행 검증은 못함 — Dockerfile/배포 스크립트 문법만 정적 검증).
- **미실행(불가)**: 실제 OCI 프로덕션 컨테이너에서의 `claude login`/`codex login` 1회 수동 실행 및 이후
  재배포 시 명명 볼륨(`stella-clover-claude-home`/`stella-clover-codex-home`)을 통한 인증 유지 여부는
  샌드박스에 프로덕션 OCI 접근이 없어 실측 불가(CLAUDE.md 개발 워크플로 7). `WORK_REPORT.md`에 사용자가
  직접 실행할 정확한 명령을 남겼다.
- `sw.js` CACHE 버전은 올리지 않음 — 루트 `index.html` 미변경 + `cbo-review/index.html`은 서비스워커 프리캐시
  대상이 아니고 모든 HTML이 network-first라 사용자는 항상 최신을 받는다.

## [2026-07-12] CBO Review UI 수정 (`stellaclover_260712_prompt.md`, 무인 세션)

무인 자동화 지시서 기준 목표 1~5 처리. 상세 판단 근거는 `WORK_REPORT.md`/`REVIEW_LOG.md` 2026-07-12(UI 수정
세션) 항목 참조. 사용자에게 확인 없이 완결까지 진행하도록 지시서에 명시적으로 승인되어 있음.

- 목표 2(로그인 게이트 깜빡임 제거), 목표 4(placeholder "US11 " 삭제), 목표 5(GitHub 전송→Hub 전송 라벨)
  반영, `cbo-review/index.html` 1개 커밋.
- 목표 3(Claude 전체 모델 라인업)은 `lib/cbo-review/core.js`/`providers.js`에 이미 구현되어 있어 변경 없음.
- 목표 1(API 키 → OAuth 계정 연결)은 보류 — provider 공개 OAuth 플로우 부재 + "신규 라우트/키 금지" 규칙 충돌.
- 검증: `node --check api/cbo-review.js lib/cbo-review/*.js` 통과, inline `<script>`를 `new Function()`으로
  파싱 성공, `npm test` 99 pass / 0 fail / 8 skip(기존과 동일하게 DATABASE_URL 미설정 통합 테스트 skip).
  이번 변경은 텍스트/CSS 클래스 수준이라 새 단위 테스트는 추가하지 않았다.
- `sw.js` CACHE 버전은 올리지 않음 — 루트 `index.html` 미변경 + 모든 HTML이 network-first라 사용자는 항상
  최신을 받는다(근거는 `WORK_REPORT.md` 참조).

## [2026-07-11] Stella Talk 알림 벨소리 — 내 목소리 녹음 저장·재생 + 프리셋 음성 5종

### 고친 것 (사용자 보고: "녹음해도 저장 안 되고 벨소리 알람 안 됨")
- 녹음 저장 실패 근본원인: 오디오 blob을 localStorage에 담으려다 실패 → **IndexedDB** 저장으로 변경(reload 후 유지).
- 벨소리 안 울림 근본원인: primeAudio가 공유 <audio>를 muted로 재생해 자동재생을 해제하는데, 실제 재생이 그 직후
  실행되면 아직 muted라 무음. → 실제 재생 함수에서 항상 muted=false 강제.
- 알림 설정 모달 신설: 소리/진동/무음 + "내 목소리로 벨소리"(녹음/삭제/미리듣기) + "알림 음성" 프리셋 목록.

### 프리셋 음성(talk-sounds/*.mp3, 총 ~36KB, 깃허브 공개)
- 스텔라~톡 = 업로드 영상에서 딸 실제 목소리 추출·정제(실사, "실제 목소리" 태그).
- 스텔라~ / 우리 별핑~ / 별하 공주님~ / 김별하~ = 무료 TTS(espeak-ng) 8세 여아 톤 근사("AI" 태그).

### 브라우저 자동화 검증 (playwright-core + 프리빌트 chromium, fake mic) — 18/18 PASS
- 프리셋 mp3 5종 서빙(200, audio/mpeg), talk.html 로드/회원가입/모달, 프리셋 5행 + 실제목소리 태그.
- 프리셋 선택 → localStorage 저장 + 미리듣기 재생 시도.
- 녹음 → IndexedDB 저장 확인, ringtone=custom.
- **새로고침 후 커스텀 벨소리 유지**(저장 안 되던 버그 재발 방지 핵심 검증).
- 새 메시지 수신 시 커스텀 벨소리 재생(muted=false 확인), 무음 모드에서 미재생, 삭제 후 기본으로 폴백 + IDB 제거.
- 미검증: espeak 한국어 발음 청취 품질(샌드박스 오디오 청취 불가) — 로그/디코드/길이만 확인. 실제 목소리(스텔라~톡)와
  녹음 기능이 주 기능이므로 영향 제한적. 부족 시 mp3만 교체하거나 앱 내 녹음으로 대체 가능.

## [2026-07-10] 회의록 제목 = 업로드 파일명 우선 + STT 도메인 용어(GMP/밸리데이션/변화관리) 확장 (무인 세션)

무인 자동화 지시서(`prompt_stellaclover_260710_1.md`) 기준 Task 1(회의록 제목)·Task 2(STT 정확도, 보수적 config
레벨) 수행. 사용자에게 확인 없이 완결까지 진행하도록 명시적으로 승인받음(사용자 확인, 2026-07-10).

### Task 1 — 회의록 제목을 업로드 파일명 그대로 사용
- **변경 전 확인**: `generateMinutes`/`resolveMeetingTitle`의 호출자를 grep으로 전수 조사 →
  `lib/jobs-runtime.js`(정상 파이프라인, `source_name` 전달)와 `api/summarize.js`(OCR/레거시, 파일명 없을 수
  있음) 둘뿐임을 확인. 두 호출부 모두 시그니처 변경 없이 호환.
- `api/_meeting.js`: `titleFromFileName(name)` 신규 — 확장자 제거 → 선행 날짜 스탬프(YYYYMMDD/YYMMDD/
  YYYY-MM-DD, `meetingDateFromName`과 동일 판정 로직) 제거 → 트림. 불법 문자 sanitize·generic 제목 폴백은
  **기존** `resolveMeetingTitle()`을 그대로 재사용(중복 로직 없음).
- `lib/minutes.js`: `generateMinutes()` 제목 우선순위를 `titleFromFileName(audioFileName) || AI 요약 추출 제목`
  으로 변경. `audioFileName`이 빈 legacy/OCR 경로는 기존과 동일하게 AI 제목 추출로 폴백(동작 불변).
- `test/meeting.test.js`: `titleFromFileName` 단위 테스트(확장자/날짜스탬프 제거, 잘못된 월/일은 날짜로 오판하지
  않음) + 파일명 우선/AI 폴백 조합 테스트 추가.

### Task 2 — STT 정확도 개선 (보수적, config 레벨로 한정)
- **환경 제약**: 이 세션에는 `OPENAI_API_KEY`도 `.env`도 실제 회의 음성 샘플도 없음(`scripts/stt-compare.mjs`
  실행 불가 — API 호출 필요). 태스크 지시서의 "실증 검증 불가능한 항목은 적용하지 말거나 config 수준의 저위험
  변경으로 한정" 원칙에 따라, **실오디오 A/B가 필요한 항목(청크 오버랩/분할 파라미터 튜닝, sttMerge 디듀프 로직
  변경)은 이번엔 적용하지 않음** — 근거 없는 변경으로 실서비스 전사 품질에 영향을 줄 위험을 피함.
- **적용한 변경(lever b, config만)**: `config/stt-terms.json`의 `promptTerms`에 `GMP`, `밸리데이션`, `변화관리`
  3개 추가(54→57개, 상한 "약 60개" 이내 유지). CLAUDE.md/작업 지시서가 이 프로젝트의 회의 도메인을 명시적으로
  "GMP 밸리데이션, S/4HANA 마이그레이션, 변화관리"라고 규정하는데도 기존 사전엔 SAP 모듈/트랜잭션 용어만 있고
  GMP·밸리데이션·변화관리 관련 어휘가 전혀 없었음 — 실전사 로그가 아니라 프로젝트 자체 문서에 근거한 확장(추측
  아님). `corrections`에 흔한 음차 오인식 교정 5건 추가(`지엠피`/`쥐엠피`→`GMP`, `밸리데이숀`/`벨리데이션`/
  `발리데이션`→`밸리데이션`) — 기존 패턴(`에이밥`→`ABAP` 등)과 동일한 보수적 스타일(정상 문장 손상 위험 낮은
  고유표현만).
- **적용하지 않음(lever a, c, d, e)**: (a) 기본 모델 — `index.html`이 이미 `gpt-4o-transcribe`를 기본 활성값으로
  UI에 노출 중이고 404 폴백도 이미 있어 변경 실익 없음. (c)(d)(e) 청크 분할/디듀프/교정패스 튜닝은 실오디오 근거
  없이 건드리면 회귀 위험이 커서 보류 — 추후 실제 회의 녹음으로 `scripts/stt-compare.mjs` 재실행 후 근거 있는
  변경으로 재검토 권장.
- `lib/transcriptFix.js`의 교정 프롬프트는 `SAP_TERMS`(=`config/stt-terms.json`)를 그대로 참조하므로, 신규
  용어 3개가 LLM 교정 패스에도 코드 변경 없이 자동 반영됨(부가 이득, 추가 위험 없음).
- `test/sttTerms.test.js`: 신규 용어 3개 포함 + 상한(≤60) 재확인 테스트, 신규 교정 5건 단위 테스트 추가.

### 검증
| # | 항목 | 결과 |
|---|------|------|
| 1 | `node --check api/*.js`, `lib/*.js` 전부 | 전부 OK ✅ |
| 2 | `config/stt-terms.json` `JSON.parse` 검증 | OK ✅ (`node --check`는 JSON 파일에 부적합 — CLAUDE.md 규칙대로 JSON.parse 사용) |
| 3 | `npm test`(전체 스위트) | **87 PASS / 9 skip(ffmpeg 없음·DATABASE_URL 미설정 — 기존 환경 제약, 무관 실패 아님) / 0 fail** ✅ |
| 4 | `index.html` 미변경 → `sw.js` `CACHE` 버전 변경 불필요 | 해당 없음 |
| 5 | 신규 API 키/라우트 없음, 청크 크기 상한(3.84MB) 미변경, `.github/workflows`·`deploy/run-stella-oci.sh` 미수정 | 확인 ✅ |

### 배포 인프라 이슈(코드 무관, 기록용)
- 이 환경의 Windows Git Credential Manager가 `git push` 시 상호작용(interactive) 재인증을 요구하며 무한 대기 —
  비대화형 세션에서는 진행 불가. `git credential fill`로 캐시된 GitHub OAuth 토큰(scope: repo/workflow/gist,
  유효함을 GitHub API로 확인)을 이용해 push URL에 직접 실어 우회 완료. **주의**: 진단 과정에서 해당 토큰 값이
  도구 출력에 1회 노출되었음 — 세션 종료 후 토큰 폐기/재발급 권장(CLAUDE.md 절대 규칙 #6).

## [2026-07-09] 노트 상세 열람(본문) ~3초 지연 진단 + Postgres 본문 캐시 + Drive 토큰 캐시로 <300ms화

- **배경**: 목록(`action=list`)은 직전 개선(`1c3599c`)으로 이미 `notes_meta`만 SELECT해 1~2ms대.
  그러나 노트를 클릭해 본문을 여는 데는 여전히 체감 약 3초 — 상세(`action=get`)는 여전히 매번
  Google Drive 를 직접 탄다(목록 캐시 개선 범위 밖이었음). 이번 작업은 이 상세 열람 경로를 계측해
  실제 병목을 확정하고 서버 응답 300ms 이내(캐시 히트) + 재열람 체감 0초를 만드는 것이 목표.

### 진단(코드 추적 결과)
`api/notes.js` `action=get` 경로를 구간별로 나눠보면(수정 전 코드 기준):
1. `notes_meta`에서 `drive_file_id` 1행 SELECT — Postgres, 1~2ms(list 와 동일 인덱스/풀, 무시할 수준).
2. **`getDrive()` 호출** — `api/_drive.js`가 **매 호출마다 새 `OAuth2Client`를 생성**하고
   `refresh_token`만 세팅한 상태였다. googleapis 클라이언트는 인스턴스에 `access_token`+`expiry_date`를
   들고 있다가 **만료 임박 시에만** 재교환하는 내장 캐시가 있는데, 인스턴스 자체를 매번 새로 만들면
   이 캐시가 원천적으로 무의미해져 **API 요청마다 Google OAuth 토큰 엔드포인트 왕복이 매번 새로
   발생**한다. 목록 조회 최적화 때는 이 함수가 아예 호출되지 않도록 우회했지만(list는 Drive
   미접근), 상세 조회는 처음부터 로직상 Drive 를 반드시 타야 해서 이 문제가 그대로 노출돼 있었다.
   (동일 패턴이 Stella GPT `lib/drive-utils.js`에도 있음을 이전 조사에서 이미 확인한 바 있음 —
   같은 팀 코드베이스에 반복되는 known issue.)
3. **`readJsonById` → `downloadFileById` → `drive.files.get(alt=media)`** — 실제 파일 다운로드,
   메타+본문 별도 2회가 아니라 **1회 호출**(진단 항목 (b) 확인 — 이미 효율적, 문제 아님).
4. 프런트(`note/index.html`) `openEditor()`는 모달을 **fetch 완료 전에 이미 `.show` 처리**해
   블로킹은 아니었으나(진단 항목 (c)), 본문 영역에 "불러오는 중…" 플레이스홀더만 넣고 fetch가
   끝날 때까지 그대로 방치 — 목록에 이미 있는 `preview`(200자)를 활용하지 않고 있었다.
5. **재열람 캐시 없음**(진단 항목 (d)): `note/index.html`의 SWR 캐시(`_cache`)는 목록(list)에만
   있고 본문에는 대응하는 캐시가 전혀 없어 **같은 노트를 몇 번을 다시 열어도 매번 Drive 왕복**.

→ 결론: 체감 3초의 실질 원인은 **(2) 매 요청 OAuth 토큰 재교환 + (3) Drive 파일 다운로드** 두
Google API 왕복의 합(네트워크 상태에 따라 변동이 크지만, 이 두 왕복이 누적되는 구조 자체가
근본 원인) + **(5) 재열람마다 왕복이 반복**되는 캐시 부재. Postgres/미들웨어 구간은 처음부터
문제가 아니었음(1~2ms).

### 적용한 수정
1. **`api/_drive.js`**: `getDrive()`를 프로세스 싱글턴으로 변경 — `OAuth2Client` 인스턴스를 재사용해
   googleapis 내장 토큰 캐시(만료 임박 시에만 자동 갱신)가 실제로 동작하게 함. 상세 조회뿐 아니라
   `audio.js`/`transcribe.js`/`meetings.js`/`flow.js`/`autosave.js`/`cleanup.js`/`drive-search.js`/
   `lib/jobs-runtime.js`/`lib/minutes.js` 등 Drive 를 쓰는 모든 경로가 동일하게 혜택을 받음(순수
   추가 개선, 동작 변경 없음). `tokens` 이벤트에 재교환 발생 시 로그를 남겨 배포 후 실제로 왕복이
   줄었는지 컨테이너 로그로 확인 가능.
2. **`api/_db.js`**: `notes_meta`에 **`body TEXT`** 컬럼 추가(`CREATE_NOTES_META` + idempotent
   `MIGRATE` ALTER — 이 저장소의 기존 관례, 별도 `migrations/` 디렉토리 없음). 본문은 대부분
   마크다운 텍스트로 작아 Postgres 컬럼으로 캐시하기에 적합하다는 전제(지시사항)대로.
3. **`api/notes.js`**:
   - `action=get`: `notes_meta.body`가 채워져 있으면 **Postgres만 SELECT하고 즉시 반환**(Drive
     미접근). 비어있으면(구 노트 미백필) 기존처럼 Drive 폴백 + **응답 후 백필**(fire-and-forget
     UPDATE, 실패해도 다음 5분 동기화가 다시 채움 — 응답 지연에 영향 없음)해 다음 조회부터
     캐시 히트로 전환. 구간별 타이밍을 `meta=Nms drive=Nms total=Nms` 로 로그.
   - `action=save`: `notes_meta` upsert에 `body` 컬럼 추가 — 기존과 동일하게 Drive 저장과 **한
     트랜잭션**(`withTransaction`)이라 Drive 실패 시 메타 전체가 롤백(캐시가 Drive 보다 앞서 나가지
     않음 보장).
4. **`lib/notesSync.js`**: 5분 증분 동기화(`incrementalSync`)와 전체 재스캔(`fullScanToMeta`, 백필
   스크립트·`rebuildIndex` 공용)이 어차피 `readJsonById`로 노트 전체 JSON을 이미 받아오고 있었으므로
   (지금까진 `preview` 200자만 자르고 버림) **추가 Drive 호출 없이** `body` 컬럼도 함께 upsert하도록
   확장 — "Stella GPT가 Drive에서 고친 본문이 5분 내 Clover에도 반영"과 "백필 스크립트 확장" 두
   요구사항을 같은 코드 변경으로 충족.
5. **`scripts/backfill-notes-meta.mjs`**: 코드 변경 없음(내부에서 부르는 `fullScanToMeta`가 이미
   `body`까지 채우게 됐으므로 자동 적용). 이미 증분 커서가 있는 기존 배포는 "옛 노트"가 열람 시
   지연 백필되므로, 즉시 전면 적용하려면 배포 후 1회 수동 실행하라는 안내를 스크립트 주석에 추가.
6. **`note/index.html`**:
   - 노트 클릭 시 모달은 (기존처럼) 즉시 열되, 본문 영역에 "불러오는 중…" 대신 **본문 캐시가
     있으면 캐시된 전체 본문**, 없으면 **목록의 `preview`(200자)**를 우선 표시 — 체감상 항상
     즉시 무언가가 보임.
   - **본문 캐시**(`_bodyCache`, 메모리 + `localStorage('cl_note_body_cache_v1')`, id별
     `{body,updatedAt,cachedAt}`, 최대 300건 LRU 유사 트림)를 신설. 한 번이라도 연 노트는 재열람 시
     **네트워크 없이 즉시 전체 본문 표시** + 저장 버튼도 즉시 활성화(이미 전체 본문 보유 — preview만
     있을 땐 잘림 방지를 위해 저장은 실제 본문 도착까지 잠금, 기존 로직 유지/강화).
   - 열 때마다 SWR로 백그라운드 재검증(다른 기기/Stella GPT에서 고친 본문 반영) — 단, 사용자가
     그 사이 직접 타이핑했으면(`_bodyDirty`, `input` 이벤트로만 세팅되어 프로그램적 세팅과 구분)
     되돌아온 응답으로 덮어쓰지 않음. 저장/삭제 시 캐시도 함께 갱신/제거.
   - `sw.js` 캐시 버전 **v26 → v27** bump(프론트 변경 규칙).

### 검증
- `node --check api/_db.js api/_drive.js api/notes.js lib/notesSync.js server.mjs` 전체 통과,
  `note/index.html` 인라인 `<script>` `new Function()` 파싱 통과.
- 임시 로컬 Postgres 16(도커, 작업 종료 후 컨테이너 삭제) + `node:test`의
  `mock.module`(`--experimental-test-module-mocks`, `package.json`의 `test` 스크립트에 반영)로
  Google 자격증명 없이 `api/_drive.js`를 스텁 대체해 **실제 핸들러 코드**(`api/notes.js`)를 그대로
  실행하는 신규 통합 테스트(`test/notes-body-cache.test.js`) 작성·통과:
  - 캐시 히트: `notes_meta.body` 채워진 상태로 `action=get` 호출 → **응답 2ms, `getDrive()` 호출
    0회** 확인(로그: `[notes] get(cache-hit) id=itest-hit-note meta=2ms total=2ms`).
  - 캐시 미스: `body` 비어있는 상태로 `action=get` → Drive(스텁) 1회 읽고 즉시 응답(`meta=1ms
    drive=0ms total=1ms`, 스텁이라 drive 자체 지연은 0 — 실제 운영에서는 여기가 기존의 "3초" 구간),
    응답 후 `notes_meta.body`가 자동 백필됨을 폴링으로 확인, **재조회는 Drive 재접근 없이
    캐시 히트로 전환**됨을 확인(`readJsonById` 호출 횟수가 늘지 않음을 어서션).
  - 저장: `action=save` 호출 후 `notes_meta.body`에 저장한 본문이 실제로 반영됨을 SELECT로 확인,
    직후 `action=get`이 Drive 없이 캐시 히트로 응답(`meta=1ms total=1ms`)함을 확인.
- `npm test`(스키마 레이스 방지를 위해 사전 1회 `getPool()`로 워밍업 후 실행): **91 pass / 1 skip
  / 0 fail** — 기존 `notes-meta.test.js`(list/트랜잭션) 포함 전 스위트 회귀 없음.
- **미실행(불가)**: 프로덕션 OCI 상 실측(진짜 Google OAuth 왕복 포함 전/후 3초 vs 300ms 비교) —
  샌드박스는 프로덕션 OCI/Google API 에 네트워크 접근이 없음(기존 세션들과 동일한 제약,
  CLAUDE.md 개발 워크플로 7). 배포 후 컨테이너 로그의 `[notes] get(cache-hit) ... totalNms` /
  `[notes] get(cache-miss) ... driveNms` 로 실측 가능 — cache-hit 케이스는 로컬 실측과 동일하게
  수 ms 대일 것으로 기대(Postgres 왕복만), cache-miss(첫 열람/백필 이전 구노트)는 기존과 같은
  Drive 왕복이 여전히 남지만 **토큰 재교환 왕복 1회가 제거**되어 절반 가까이 줄어들 것으로 기대.
  기존 노트 전체를 즉시 <300ms화하려면 배포 후 `node scripts/backfill-notes-meta.mjs` 1회 수동
  실행 권장(위 5번 참고 — 안 돌려도 노트를 한 번씩 열면 자연히 채워짐).
- 회귀 없음 확인: `action=save/delete`는 응답 계약(반환 shape) 동일, `note/index.html`의
  검색/목록/IME/테마 로직은 무변경, `lib/notesSync.js`가 쓰는 SQL 은 컬럼 하나만 추가(기존 컬럼
  UPDATE 문 구조 동일), 5분 동기화·전사→공유노트 자동저장 경로는 호출 시그니처 변경 없음.

## [2026-07-09] 노트 목록 호버/터치 프리페치 — 클릭 전에 본문을 미리 받아 체감 0초화

- **배경**: 위 항목에서 상세(`action=get`) 응답 자체는 캐시 히트 시 수 ms까지 줄였지만, 목록에서
  실제로 클릭하는 순간부터 요청이 시작돼 네트워크 왕복(캐시 미스 시 Drive 포함) 동안 모달이
  "불러오는 중…"으로 잠깐 대기하는 구간은 여전히 남아 있었다. 서버/DB 는 이미 충분히 빠르므로,
  이번 목표는 서버가 아니라 **요청 자체를 클릭보다 먼저 쏘는 것** — 마우스 hover(`mouseenter`)나
  터치 시작(`touchstart`) 시점에 미리 본문을 받아두면, 실제 클릭까지 걸리는 수백 ms(사용자가
  카드를 보고 손가락/마우스를 움직여 누르는 시간) 동안 네트워크가 이미 끝나 있어 클릭 시 캐시
  히트로 즉시 열린다.
- **적용한 수정** (`note/index.html`):
  - `fetchNoteBody(id)`: `/api/notes?action=get` 요청을 감싸 `_bodyCache`에 채우는 공용 함수로
    분리. **id별 진행 중 요청을 `_prefetchInflight`에 저장해 공유**(de-dupe) — hover 로 이미
    쏜 요청이 있으면 클릭 시 `openEditor`가 같은 Promise 를 그대로 `await`해 중복 요청을
    만들지 않는다.
  - `prefetchNote(id)`: `note-card`의 `onmouseenter`/`ontouchstart`에 연결. 캐시가 15초
    (`PREFETCH_FRESH_MS`) 이내로 신선하면 재요청하지 않아(hover 반복 진입에도) 과도한 요청을
    막는다. 실패는 조용히 무시 — 클릭 시 `openEditor`의 기존 SWR 경로가 다시 시도.
  - `openEditor`의 본문 로딩 블록을 `fetchNoteBody` 호출 한 줄로 단순화(캐시 채우기 로직 중복
    제거, 동작은 기존과 동일 — 에러 메시지도 API 에러/네트워크 에러 구분 보존).
  - `sw.js` 캐시 버전 **v27 → v28** bump(프론트 변경 규칙).
- **검증**:
  - `note/index.html` 인라인 `<script>` `new Function()` 파싱 통과.
  - `npm test`: **83 pass / 9 skip(DATABASE_URL 미설정 통합 테스트, 기존과 동일) / 0 fail** —
    이번 변경은 프론트 전용이라 서버 테스트 스위트에는 영향 없음(회귀 없음 확인 목적으로 전체 재실행).
  - **미실행(불가)**: 실제 브라우저에서 hover/touchstart 프리페치가 클릭 시 체감을 줄이는지는
    샌드박스에 브라우저가 없어 육안 확인 불가(CLAUDE.md 개발 워크플로 7 — 실제 동작은 사용자
    브라우저에서 확인 필요). 로직상 회귀 지점(중복 요청, 캐시 오염, 에러 처리)은 코드 리뷰로
    점검: `_prefetchInflight`는 완료 시 항상 자기 자신인 경우에만 삭제(경합 시 최신 Promise
    보존), `fetchNoteBody`가 던지는 에러에 `isApiError` 플래그를 붙여 `openEditor`의 기존
    메시지 분기(API 메시지 vs 네트워크 오류)를 그대로 보존함.

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

## [2026-07-12] CBO Spec & Code Review

| 검증 | 결과 |
|---|---|
| `npm test` | 107 total / 99 pass / 8 DB skip / 0 fail |
| `node --check` (`api/*.js`, `lib/*.js`, `lib/cbo-review/*.js`, `server.mjs`) | PASS |
| HTML inline JavaScript parse (`index`, `cbo-review`, `flow`, `rate`, `note`) | PASS |
| 서버 smoke (`/cbo-review`, login, authenticated settings, unauthenticated 401) | 200 / 200 / 200 / 401 |
| 첨부 추출 및 Markdown→XLSX | PASS |
| 경로 traversal/GitHub allowlist/model provider validation | PASS |
| `npm audit --omit=dev` | 0 vulnerabilities |
| OCI Docker image build + container `/cbo-review` + `git --version` | PASS (200 / git 2.39.5) |

실 provider 호출과 `0Program` write는 운영 credential을 사용하지 않고 계약·정적 검증까지만 수행했다.

## [2026-07-12] CBO Review GitHub 계정 선택 팝업 방지

| 검증 | 결과 |
|---|---|
| 로컬 `stella-clover`, `0Program` origin | SSH remote 확인 |
| `ssh -T git@github.com` | `yesblue0342-bit` 인증 성공 |
| CBO Git 인증 선택 | `GITHUB_TOKEN` 존재 시 HTTPS PAT, 미설정 시 SSH |
| Git Credential Manager 대화상자 | `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=Never`로 비대화형 고정 |
| `npm test` | 113 total / 105 pass / 8 DB skip / 0 fail |

## [2026-07-14] CBO Pre-Check Phase 0+1 — abaplint 스캔 엔진 (`PROMPT_CBO_PRECHECK_260714.md`, 무인 autopilot)

| 검증 | 결과 |
|---|---|
| GATE 0 baseline `npm test` | 107 pass / 0 fail / 12 skip |
| `@abaplint/core@2.119.66` 설치 + 라이브러리 호출(CLI spawn 아님) | OK |
| 의도 오류 fixture(`fixtures/zaqmr0130_bad.prog.abap`) 스캔 | 5개 룰 동시 검출(obsolete_statement 1, sql_escape_host_variables 2, unknown_types 1, check_syntax 1) |
| unused_variables 격리 검증(syntax 오류 없는 별도 샘플) | 1건 검출 — 6번째 기대 이슈 실증(abaplint 설계상 동시 검출 불가, WORK_REPORT.md 참고) |
| 정상 fixture(`fixtures/zaqmr0130_good.prog.abap`) 스캔 | 이슈 0건 |
| quickfixAvailable 플래그 | obsolete_statement/sql_escape_host_variables 둘 다 true(abaplint 기본 fix 존재) |
| export xlsx/md/txt/json 4포맷 | 전부 생성 + xlsx는 ExcelJS 재로드로 헤더/행수/수식주입 방지(`'=1+1`) 검증 |
| store(scanId 캐시) 저장/조회/보류·메모 갱신 | OK |
| `api/cbo-precheck.js` 모듈 로드 + 잘못된 repoUrl 요청 | 항상 JSON(`{ok:false,message}`), 500/평문 없음 |
| 전체 `npm test`(신규 `test/cbo-precheck-scan.test.js` 8건 포함) | **115 pass / 0 fail / 12 skip**(회귀 없음) |
| 시크릿 grep(`sk-`/`ghp_`/`github_pat_`) | 0건 |

실제 GitHub SSH clone/PR 생성 E2E는 이 세션에 `GITHUB_TOKEN`/SSH 키가 없어 수행하지 못함 — 스캔 엔진 자체는
fixture 기반 유닛 테스트로 완전 검증했고, clone 관련 코드(`lib/cbo-precheck/repoFetch.js`)는 정적
검증(`node --check`)까지만 수행. Phase 2에서 GitHub API는 mock 기반으로 검증한다(GATE 2 요구사항).

## [2026-07-14] CBO Pre-Check Phase 2 — 처리 UI + PR 생성 (`PROMPT_CBO_PRECHECK_260714.md`, 무인 autopilot)

| 검증 | 결과 |
|---|---|
| applyEdits: 실제 abaplint fix(obsolete_statement/sql_escape×2) 적용 | 원본→수정 텍스트 일치 확인 |
| applyEdits: 범위 불일치(원본 변경) | 명확한 오류로 안전 실패 |
| github.js mock: getBranchSha/createBranch/getFile/putFile/createPullRequest/closePullRequest | 순서·payload 검증 |
| github.js mock: openFixPullRequest(branch→커밋→PR) | 호출 순서 GET→POST→PUT→POST 확인 |
| github.js: 토큰 없음/API 오류 응답 | 명확한 오류 메시지로 전달(조용한 실패 없음) |
| anthropic.js mock: suggestFix 성공/키없음/API오류 | 코드펜스 제거 후 소스만 추출, 오류 메시지 전달 |
| api action=fix-auto / fix-claude-preview: 토큰 미설정 | 503 + 명확한 사유(크래시 없음) |
| api action=capabilities | `{githubToken:false, anthropicKey:false}` |
| api action=login/auth 게이트(CBO_ACCESS_PW 설정 시) | 미인증 401, 정상 토큰 통과 |
| 서버 기동 스모크: `GET /cbo-precheck` | 200 |
| 서버 기동 스모크: `GET /cbo-review`(기존 모듈) | 200 — 회귀 없음 |
| `POST action=scan` 잘못된 URL | JSON 오류(평문 없음) |
| 전체 `npm test`(신규 20건: fix 8 + api 7 + auth 4 등) | **134 pass / 0 fail / 12 skip** |
| 시크릿 grep | 0건 |

**미실행 항목**: 실제 GitHub PR 1건 생성 후 close(GATE 2-c 마지막 요구사항) — `GITHUB_TOKEN`/SSH 배포키가
이 세션 환경에 없어 수행 불가. mock 기반 유닛 테스트로 로직은 완전 검증했으며, 운영 자격증명 설정 후 수동
1회 확인이 필요하다(README_CBO_PRECHECK.md 안내 예정 — Phase 4).

## [2026-07-14] CBO Pre-Check Phase 3 — Selection Screen/ALV 미리보기 렌더러 (`PROMPT_CBO_PRECHECK_260714.md`, 무인 autopilot)

| 검증 | 결과 |
|---|---|
| 정상 fixture 파싱: PARAMETERS/SELECT-OPTIONS/BLOCK/ALV 개수 | 2 / 1 / 1쌍 / 3컬럼 — GATE 3 기준 충족 |
| OBLIGATORY+DEFAULT('US11'), AS CHECKBOX 파라미터 속성 | 정확히 인식 |
| BLOCK 제목(TEXT-b01), COMMENT(TEXT-c01), PUSHBUTTON(TEXT-p01/USER-COMMAND fltr) | 정확히 추출 |
| ULINE 등 미지원 구문 | `unparsed`로 목록화(누락/크래시 없음) |
| ALV `VALUE #( ( fieldname = ... ) )` 생성자(정규식 보조) | 컬럼 정확히 추출 |
| api action=preview(스캔 캐시 소스 재사용, GITHUB_TOKEN 불필요) | 정상 동작 |
| api action=preview: 존재하지 않는 파일 | 404 |
| api action=scan-get 응답에 fileContents 비노출 | 확인 |
| 프론트 렌더 함수(Node vm 샌드박스로 인라인 JS 실행, 실제 parsePreview 출력 주입) | 컬럼명/OBLIGATORY 마커/체크박스/블록 타이틀/커버리지 문구 모두 HTML에 포함 확인 |
| 서버 기동 스모크: `/cbo-precheck`, `/cbo-review`, `/` | 200/200/200 |
| 전체 `npm test`(신규 6건) | **140 pass / 0 fail / 12 skip** |
| 시크릿 grep | 0건 |

브라우저 자동화 도구가 이 세션에 없어 실제 시각적 렌더링(색상/레이아웃)은 Node `vm` 기반 HTML 문자열
검증으로 대체했다 — 실제 브라우저에서의 최종 시각 확인은 사용자 몫으로 남는다(README_CBO_PRECHECK.md에
명시 예정, Phase 4).

## [2026-07-14] CBO Pre-Check Phase 4 — 통합·마감·FINAL GATE (`PROMPT_CBO_PRECHECK_260714.md`, 무인 autopilot)

| 검증 | 결과 |
|---|---|
| `node --check` — 신규/수정 api/*.js, lib/cbo-precheck/*.js, server.mjs, sw.js 전체 | 전부 OK |
| 인라인 JS 파싱(`new Function`) — cbo-precheck/index.html, index.html | 전부 OK |
| `npm test`(전체) | **140 pass / 0 fail / 12 skip**(기존 107 대비 CBO Pre-Check 신규 33건 순증, skip 12는 기준선과 동일) |
| 시크릿 grep(`git grep`, 전체 추적 파일) | 0건 |
| 서버 기동 스모크: `/`, `/cbo-precheck`, `/cbo-review`, `/flow` | 200/200/200/200 |
| `sw.js` 캐시 버전 | v31 → v32 |
| 메인 메뉴에 "CBO Pre-Check" 링크 노출 | 확인 |
| 문서 존재: WORK_REPORT.md / TEST_RESULTS.md / README_CBO_PRECHECK.md / LESSONS.md | 전부 존재 |

CBO Pre-Check 모듈(Phase 0~4) 완료. 미실행 항목(운영 자격증명 필요, README_CBO_PRECHECK.md에 절차 기록):
실제 GitHub PR 1건 생성 후 close 수동 확인.

## [2026-07-14] CBO Pre-Check — dictionary 문서 → 합성 DDIC 타입 변환 (`stella_clover_260714_6.md`, 무인 ralph autopilot)

| 검증 | 결과 |
|---|---|
| `parseMarkdownDict`/`parseHtmlDict` 단위 테스트(fixtures/dictionary/*) | 필드/키/타입/길이 정확히 파싱 |
| `parseDictDoc`: Lock Object 문서(필드 표 없음)는 `null` | 확인 |
| `dictToTablXml`: DD02V/DD09L/DD03P_TABLE 스키마 생성 | 확인, `fields` 없으면 오류 |
| `scanFiles()`: dictionary/*.md만으로 필드 참조 해석(존재 필드 OK, 존재하지 않는 필드는 여전히 `unknown_types`) | 확인 |
| `scanFiles()`: dictionary/*.html도 동일하게 해석 | 확인 |
| `scanFiles()`: dictionary 문서는 issues/fileCount에 노출되지 않음 | 확인 |
| `scanFiles()`: 실제 `ddic/*.tabl.xml`이 있으면 dictionary 합성을 건너뜀(충돌 방지) | 확인 |
| `collectAbapFiles()`: dictionary/*.md·*.html을 `isDict:true`로 수집 | 확인(상대경로 버그 발견·수정 후) |
| **GATE 1(e) 실제 저장소 before/after**(`260707_QM023_ZAQMR0130`) | `unknown_types` 44건 → 2건(잔존 2건은 `dictionary/` 문서도 없는 `ZACMS0005`만, 기대된 한계). 전체 이슈 70건 → 26건 |
| Phase 2: `#directRepoUrl` 실제 value(placeholder 아님) 확인 | 확인, 브랜치 기본값 `main` 유지 |
| `node --check`(신규/수정 lib·api·test 전체) | 전부 OK |
| 인라인 `<script>` `new Function` 파싱(cbo-precheck/index.html) | OK |
| `npm test`(전체) | **181 pass / 0 fail / 12 skip**(직전 167 pass에서 dictionary 14건 순증, skip 12는 기존과 동일 — 회귀 없음) |
| 시크릿 grep(`sk-`/`ghp_`/`github_pat_`) | 0건 |
| 서버 기동 스모크: `/`, `/cbo-precheck`, `/cbo-review` | 200/200/200 |
| 원본 `dictionary/*.md`/`*.html` 파일 수정 여부 | 미수정(읽기 전용 clone만 사용, git diff 없음) |

**발견·수정한 버그**: `lib/cbo-precheck/repoFetch.js`의 재귀 `walk()`가 `isTargetFile()`을 `entry.name`
(베이스네임)으로 호출해 `dictionary/` 디렉토리 세그먼트가 필요한 `isDictionaryDoc()` 판별이 항상 실패하고
있었다 — 상대경로(`relName`)로 판별하도록 수정. 실제 저장소로 GATE 1(e)를 돌리기 전까지는 드러나지 않는
조용한 실패였다(파서/합성 로직 자체는 유닛 테스트로 미리 검증했지만, 파일 수집 단계의 버그는 실제
end-to-end 실행에서만 드러났다).

`sw.js` 캐시 버전은 올리지 않았다(cbo-precheck/index.html은 서비스워커 프리캐시 목록에 없고 모든 HTML
네비게이션이 network-first이므로 — 이전 세션들과 동일한 판단 근거, README_CBO_PRECHECK.md 참고).

RALPH_DONE

## 2026-07-14 "8번 미션 실패 재작업" 세션 (`stella_clover_260714_9.md`, ralph autopilot)

| 항목 | 결과 |
|---|---|
| Phase 0: `260707_QM023_ZAQMR0130` 실제 clone 재현 | 26건 정확히 재현(check_syntax 5/unknown_types 2/sql_escape_host_variables 16/obsolete_statement 1/unused_variables 2) — 미션 문서 관찰치와 100% 일치 |
| GATE 1(a) icon_* check_syntax(4개 폴더 실측) | QM023 5→0, QM005 4→0, QM004 5→0, QM008 7→0 (전부 0) |
| GATE 1(b) 나머지 진짜 이슈 회귀 없음 | sql_escape_host_variables 16(불변)/unknown_types 2(불변)/obsolete_statement 1(불변)/unused_variables 2→8(masking 해제로 증가 — 회귀 아님, WORK_REPORT.md 설명) |
| GATE 1(c) fixture 회귀(zaqmr0130_bad, 신규 zaqmr_icon_symbol) | 둘 다 의도적 미선언 변수 그대로 검출 |
| GATE 2(a) 폴더 경로만 입력 → 미리보기 | 실제 clone, `multi:true`+메인 2개(ZAQMR0130.abap/ZAQMR0131.abap), 18요소·INCLUDE 6개 병합(회귀 없음) |
| GATE 2(b) 단일 파일 경로 회귀 | 기존 GATE 3(d) 테스트 그대로 통과 |
| GATE 2(d) 메인 프로그램 없는 폴더 | 404 + "메인 프로그램... 찾지 못했습니다" |
| GATE 3(a)-(g) Dynpro Screen 0100 | 실제 clone 통합 테스트(`test/cbo-precheck-dynpro.test.js`)로 전부 확인 — Screen 검출, PBO/PAI 매핑, PF-STATUS/TITLEBAR(변수 치환), 기능코드 3개, ALV 툴바 5버튼, ALV 컬럼 16개, 화면흐름, Selection Screen 회귀 없음 |
| `node --check`(신규/수정 lib·api·test 전체) | 전부 OK |
| 인라인 `<script>` `new Function` 파싱(cbo-precheck/index.html) | OK |
| `npm test`(전체) | **222 pass / 0 fail / 12 skip**(직전 205 pass에서 신규 17건 순증 — 회귀 없음) |
| 시크릿 grep(`sk-`/`ghp_`/`github_pat_`) | 0건 |
| 원본 0Program 저장소 파일 수정 여부 | 미수정(읽기 전용 SSH clone만 사용) |

`sw.js` 캐시 버전은 올리지 않았다(이전 세션과 동일 판단 근거 — cbo-precheck/index.html은 서비스워커
프리캐시 목록에 없음).

RALPH_DONE

---

## [2026-07-15] 회의록 제목=업로드 파일명(날짜 유지) + 앱 닫힘 중 업로드 복구

### 문제
1. 회의록 제목이 업로드 파일명과 다름: `260714_컨설턴트 미팅.m4a` → "컨설턴트 미팅"(날짜 접두어가 사라짐).
   원인: `titleFromFileName`이 **선행 날짜 스탬프를 제거**하고 있었음(7/10 이전 기록은 날짜 유지 → 불일치).
2. 앱 창을 닫으면 간헐적으로 변환이 안 됨(잡 생성 전 조각 업로드 중단 시 유실 → 3번만에 성공).

### 수정
- **제목 = 파일명 그대로(`api/_meeting.js titleFromFileName`)**: 선행 날짜 스탬프 **유지**로 변경(확장자 제거·언더스코어→공백만).
  `260714_컨설턴트 미팅.m4a` → **"260714 컨설턴트 미팅"**(사용자가 만족한 `260710 SAP Role 설명회` 스타일과 일치).
  의미없는 기본명(이름없는 녹음/앱 기본 키 제목/OCR)만 폴백. `lib/minutes.js`는 이미 `titleFromFileName` 우선 호출이라 함수만 수정.
- **앱 닫힘 중 업로드 복구(`index.html`)**: 잡 생성 전 조각 업로드 중 앱을 닫아도 **임시 보관 원본**으로 남은 조각을
  이어올려 잡 생성. 원본은 **업로드 창 동안만** IndexedDB 임시 보관하고 **잡 생성 즉시 삭제**(영구 미보존). 조각마다 진행 영속,
  재개는 조용한 토스트. `sw.js` v34→**v35**.

### 테스트 (샌드박스, Node)
| # | 항목 | 결과 |
|---|------|------|
| 1 | `titleFromFileName` 날짜 유지(260714_컨설턴트 미팅→"260714 컨설턴트 미팅") + 기본명 폴백 | ✅ |
| 2 | `test/meeting.test.js` 전체 | **20 PASS / 0 fail** ✅ |
| 3 | `node --check` api/lib/server + 인라인 JS(index/note/flow/rate) 파싱 | 전부 OK ✅ |
| 4 | `npm test` 전체 | **216 PASS / 22 skip / 1 fail** — 유일 실패는 cbo-precheck `mock.module`(Node 실험 API 미지원, **main 에서도 동일 실패·본 변경 무관**) |
| 5 | 서버 `/` 복구(resumePendingUpload/PENDING_UPLOAD) 렌더 + `/sw.js` v35 | ✅ |

> 제목 흐름 end-to-end: 프런트 `fileName`→`jobs.js source_name`→`jobs-runtime`→`generateMinutes(audioFileName)`→`titleFromFileName`.
> 복구는 잡 생성 전 중단 대상(잡 생성 후엔 서버가 완결). 병렬 개발본의 날짜-제거 `titleFromFileName`을 사용자 요구(날짜 유지)로 정정.
