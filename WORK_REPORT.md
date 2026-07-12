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
