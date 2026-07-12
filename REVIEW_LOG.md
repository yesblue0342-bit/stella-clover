# CBO Spec & Code Review — 결정 로그

- 2026-07-12: 기존 Stella Clover에는 서버 인증이 없어 CBO 라우트에만 `CBO_ACCESS_PW` 기반 24시간 서명 토큰 게이트를 적용했다.
- 2026-07-12: ChatGPT/Claude/Gemini 소비자 웹 세션 재사용은 제외하고, 각 계정에서 발급한 API 키를 서버 환경변수 또는 `data/cbo-review/providers.json`에 저장하는 방식으로 통일했다.
- 2026-07-12: 모델 목록은 연결된 제공자의 공식 Models API에서 동적으로 조회하고, 조회 실패 시 공식 문서 기준 fallback 목록을 사용한다.
- 2026-07-12: `0Program` 쓰기는 persistent volume의 `/app/data/0Program` clone을 기준으로 직렬화하여 `clean check → pull --rebase --autostash → backup/write → commit → push`하며, GitHub 링크와 서버 경로는 `yesblue0342-bit/0Program/main`으로 제한했다.
- 2026-07-12: 브라우저 업로드 파일은 브라우저 보안상 원본 경로를 직접 덮어쓸 수 없으므로 수정본 다운로드로 제공하고, 서버 경로/GitHub 입력은 백업 후 즉시 반영한다.
- 2026-07-12: 기존 OCI 배포 workflow와 Docker 설정은 변경하지 않고 main push 기반 자동 배포 계약을 유지했다.
- 2026-07-12 (UI 수정 세션): "AI 연결 설정"을 API 키 입력 방식에서 provider별 OAuth "계정 연결"로 바꾸는 안을 재검토했으나
  보류했다. OpenAI·Anthropic·Gemini 어느 쪽도 제3자 앱이 최종 사용자의 API 키를 OAuth로 발급받는 공개 플로우를
  제공하지 않고, 실제로 구현하려면 provider별 OAuth 앱(client_id/secret) 신규 등록과 콜백 라우트 신설이 필요해
  "신규 API 키·신규 라우트 생성 금지" 절대 규칙과 정면으로 충돌한다. 현재의 서버측 API 키 저장(`providers.json`,
  0600 권한, 클라이언트에는 절대 재노출 안 함) 방식이 이미 "키를 하드코딩하지 않고 서버 시크릿 스토리지로만 관리"
  요건을 충족하므로 이를 유지하기로 했다. Google만은 Google Identity(OAuth)로 사용자 동의를 받아 Generative
  Language API를 호출하는 방식이 이론상 가능하지만, OpenAI/Anthropic 두 곳에서 동일 UX를 제공할 수 없어 provider
  간 일관성이 깨지므로 이번 세션에서는 세 provider 모두 API 키 연결 방식으로 통일한 현행 구조를 그대로 둔다.
  실제 OAuth 계정 연결을 원하면 각 provider 개발자 콘솔에서 OAuth 앱을 만들고 client_id/secret을 발급받아
  `.env`에 추가하는 것부터 시작해야 하며, 이는 사람이 직접 승인·등록해야 하는 외부 작업이라 무인 세션에서 대신할
  수 없다.
- 2026-07-12 (UI 수정 세션): "공통 AI 모델" 드롭다운에 Anthropic Claude 전체 라인업을 추가하는 항목은 이미 구현되어
  있음을 확인했다(`lib/cbo-review/core.js`의 `PROVIDER_MODELS.anthropic` fallback 목록 + `providers.js`의
  `listModels()`가 Anthropic Models API(`/v1/models`)에서 `claude-` 접두 모델을 전량 동적 조회). 추가 코드 변경 없음.

- 2026-07-12 (계정 로그인 세션, `stella_clover_improvement_260712_2.md`): 작업 1 진단 — "공통 AI 모델" 드롭다운에
  Claude/Gemini가 안 보인다는 현상의 원인은 (b) fetch 실패가 아니라 **(a) `renderModels()`가
  `providers.filter(p=>p.connected)`로 미연결 provider를 통째로 걸러내는 의도된 필터링**이었다
  (`cbo-review/index.html` 확인, `lib/cbo-review/providers.js`의 `listModels()`/fallback 로직 자체는 정상).
  수정: 미연결 provider도 `<optgroup label="provider (연결 필요)">`로 표시하되 옵션 자체는 회색(`color:graytext`)
  스타일만 주고 `disabled` 속성은 주지 않았다 — HTML `disabled` 옵션은 브라우저가 네이티브하게 선택을 막아버려서
  "미연결 모델 선택 시 AI 연결 설정 모달을 연다"는 요구사항을 구현할 수 없기 때문. 대신 `onchange` 핸들러
  (`saveModel()`)에서 선택된 옵션에 `data-locked` 플래그가 있으면 직전 유효값으로 되돌리고 설정 모달을 연다.
  Gemini는 동일 렌더 로직을 공유하므로 자동 적용됨.

- 2026-07-12 (계정 로그인 세션): 작업 2 조사 — 이 서버(Windows 개발 환경)에 `@anthropic-ai/claude-code`(`claude`
  bin)와 `@openai/codex`(`codex` bin)가 이미 npm 전역 설치·로그인되어 있음을 확인
  (`~/.claude/.credentials.json`, `~/.codex/auth.json` 존재 — **내용은 읽지 않고 존재 여부만 확인**).
  `claude --help`/`codex exec --help`로 비대화식 호출 문법을 확인:
  - `claude -p --model <model> --output-format json --system-prompt <system> <user>` → stdout이
    `{"type":"result","is_error":bool,"result":"..."}` JSON. 실제 호출로 `"PONG"` 왕복 확인.
  - `codex exec -s read-only --skip-git-repo-check -o <file> "<prompt>"` → 최종 응답을 파일에 기록.
    실제 호출로 인증/샌드박스까지는 정상 도달했으나 계정 사용량 한도(usage limit)로 응답 생성은 막힘 —
    메커니즘 자체(인증 재사용, 비대화식 실행, read-only 샌드박스)는 정상 동작 확인됨.
  이는 지시서가 명시한 **경로 A(기존 CLI 인증 재사용)**이며, 지난 세션에 보류했던 "provider별 OAuth 앱
  신규 등록"(경로 B의 일부, "신규 라우트/키 금지" 규칙과 충돌)과는 다른 접근이다 — 경로 A는 이미 인증된
  공식 CLI 바이너리를 subprocess로 호출할 뿐, 새 API 키·새 OAuth 클라이언트·새 서버리스 라우트를 전혀
  만들지 않는다(`api/cbo-review.js`의 기존 단일 핸들러에 `action=cli-connect`/`cli-disconnect` 브랜치만 추가 —
  기존 `action=provider-save`/`review-repo` 등과 동일 패턴, "신규 라우트"에 해당하지 않는다고 판단).
  → **경로 A를 채택**해 구현했다. 구현 내역:
  - `lib/cbo-review/providers.js`: `providers.json`에 `__mode__` 서브키로 provider별 `apikey`/`cli` 선택을
    저장(기존 평문 키 저장 포맷은 완전히 그대로 유지 — 하위 호환). `detectCli()`는 CLI 바이너리 존재 + 인증
    파일 존재만 확인(토큰 내용은 절대 읽지 않음). `callModel()`은 "계정 로그인 → 없으면 API 키" 순서로 시도.
  - CLI 서브프로세스는 `child_process.spawn`에 배열 인자만 사용(`shell:false`) — 프롬프트에 첨부파일 원문이
    그대로 들어가므로 셸 인젝션 여지를 원천 차단. Windows npm `.cmd` 셰임은 `shell:false`로 직접 실행 불가
    (Node가 EINVAL 거부)하므로 셰임을 파싱해 실제 `.exe`/`node.exe+.js` 대상을 찾아 셸 없이 직접 실행하도록
    별도 처리(로컬 Windows 개발 편의용 — 실제 OCI 배포는 Linux라 이 분기를 타지 않고 바로 동작).
  - 프롬프트 인젝션이 CLI 에이전트의 파일/셸 접근으로 번지지 않도록 `claude -p`에는
    `--disallowedTools Bash,...,Read,Write,...` 전체 차단 + `--disable-slash-commands`를 강제하고, `codex exec`는
    `-s read-only`(모델이 생성한 셸 명령도 읽기 전용) + `--skip-git-repo-check`로 제한했다. codex는 `-m`(모델)을
    강제하지 않고 서버측 codex 설정 기본 모델을 그대로 쓴다 — codex CLI 내부 모델 네이밍이 direct API(`gpt-*`)와
    다를 수 있어(실측 불가, 계정 사용량 한도로 확인 못함) 잘못된 `-m` 값으로 매 호출이 실패하는 것을 피하기
    위한 보수적 선택(WORK_REPORT.md 남은 과제 참조).
  - Gemini는 서드파티 CLI/공개 OAuth가 없어 이번에도 API 키 전용으로 유지(지난 세션 결론과 동일).
  - Docker/배포: `Dockerfile`에 `@anthropic-ai/claude-code`/`@openai/codex` 전역 설치 추가(선택 기능 —
    로그인 안 해도 기존 API 키 경로는 100% 그대로 동작). `deploy/run-stella-oci.sh`는 매 `main` push마다
    컨테이너를 완전히 새로 만들므로(`docker rm -f` + `docker run`), 인증 파일이 재배포마다 사라지지 않도록
    `${NAME}-claude-home:/root/.claude`, `${NAME}-codex-home:/root/.codex` 명명 볼륨을 추가했다. 최초 1회
    `docker exec -it stella-clover claude login`/`codex login`은 사람이 SSH로 직접 실행해야 한다(대화형 OAuth
    승인 — 무인 세션이 대신할 수 없음, WORK_REPORT.md에 정확한 절차 기록).
