# CBO Spec & Code Review — 결정 로그

- 2026-07-12: 기존 Stella Clover에는 서버 인증이 없어 CBO 라우트에만 `CBO_ACCESS_PW` 기반 24시간 서명 토큰 게이트를 적용했다.
- 2026-07-12: ChatGPT/Claude/Gemini 소비자 웹 세션 재사용은 제외하고, 각 계정에서 발급한 API 키를 서버 환경변수 또는 `data/cbo-review/providers.json`에 저장하는 방식으로 통일했다.
- 2026-07-12: 모델 목록은 연결된 제공자의 공식 Models API에서 동적으로 조회하고, 조회 실패 시 공식 문서 기준 fallback 목록을 사용한다.
- 2026-07-12: `0Program` 쓰기는 persistent volume의 `/app/data/0Program` clone을 기준으로 직렬화하여 `clean check → pull --rebase --autostash → backup/write → commit → push`하며, GitHub 링크와 서버 경로는 `yesblue0342-bit/0Program/main`으로 제한했다.
- 2026-07-12: 브라우저 업로드 파일은 브라우저 보안상 원본 경로를 직접 덮어쓸 수 없으므로 수정본 다운로드로 제공하고, 서버 경로/GitHub 입력은 백업 후 즉시 반영한다.
- 2026-07-12: 기존 OCI 배포 workflow와 Docker 설정은 변경하지 않고 main push 기반 자동 배포 계약을 유지했다.
