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
