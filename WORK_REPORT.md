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
