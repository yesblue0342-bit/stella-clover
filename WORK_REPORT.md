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
