# OPENAI_BASE_URL 가짜 서버로 시크릿 없이 전체 파이프라인 E2E 검증 가능

- openai SDK(v4)는 `OPENAI_BASE_URL` 환경변수를 읽는다. 로컬 http 서버로
  /v1/audio/transcriptions(평문)과 /v1/chat/completions(JSON)만 흉내내면
  업로드→조립→ffmpeg 전처리→STT→교정→회의록→이력저장→Drive 실패 경로까지
  실제 서버 프로세스로 검증할 수 있다(OpenAI/Drive 시크릿 불필요).
- 이번 세션에서 검증한 시나리오: 파트 업로드 3개→잡 생성→무음 분할 3청크→
  사전 교정(검사 로트→검사로트, 에이밥→ABAP)→회의록/제목/키워드→cl_meetings 저장(브라우저 없이)→
  Drive 자격증명 없음 → "원본 오디오 Drive 보관 실패(회의록은 저장됨)" + 파일 보존 + retry=1 멱등.
- 로컬 Postgres 는 샌드박스에서 apt 로 설치해 사용(ffmpeg 도 apt). 재현 절차는 TEST_RESULTS.md 참조.
