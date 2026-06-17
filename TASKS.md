# Stella Clover — 작업 체크리스트

## BUG-1 (최우선) 회의록 이력 목록 로드 실패
근본 원인: 서버 함수가 valid JSON을 못 내려보낼 때(Azure SQL 서버리스 콜드스타트가
함수 `maxDuration`을 초과 → Vercel이 평문 "An error occurred…" 페이지 반환) 프론트의
`r.json()`이 `Unexpected token 'A'`로 크래시. 이력 영역만 빨간 에러.

- [x] 프론트 fetch+.json() 위치 식별 (index.html `renderList`, `doDriveSearch`, `showDetail`)
- [x] 서버 엔드포인트 식별 (api/meetings.js)
- [x] 원인 진단 (엔드포인트는 내부 try/catch로 JSON 반환하나, DB 콜드스타트로 함수가
      kill되면 Vercel 평문 에러 → 프론트 크래시)
- [x] 엔드포인트가 모든 경우 valid JSON 반환 (DB connect/query 타임아웃을 maxDuration 이내로 단축)
- [x] 프론트 방어적 수정 (safeJson: 비-JSON 응답도 사람이 읽을 메시지로 표시, 빈 목록=기록 없음)
- 인수 조건:
  - [x] 이력 목록 정상 로드 / 데이터 없으면 "회의록 없음"
  - [x] 엔드포인트 직접 호출 시 성공·실패 모두 valid JSON
  - [x] 일부러 에러 유발해도 화면 안 깨지고 사람이 읽을 메시지 노출

## BUG-2 회귀 확인
- [x] git log/diff 분석: api/meetings.js, api/_db.js 는 최근 12개 커밋 동안 미변경.
      최근 커밋(다국어 STT/요약)은 transcribe·summarize·index 언어 기능만 수정.
      => 코드 회귀 아님. 런타임(DB 콜드스타트) 재발이 "또 오류"의 원인.
      => 방어적 프론트 + 빠른 실패(타임아웃)로 항구적 처리.

## TASK-3 초기 화면 문구 제거
- [x] "AI 음성 회의록 자동 생성" 태그라인 제거 + 레이아웃 정리

## 테스트
- [x] 이력 엔드포인트 응답 스키마 검증 (성공/실패 JSON)
- [x] 프론트 safeJson 비-JSON 응답 처리 단위 테스트
- [x] 전사 파이프라인 회귀 없음(청크/3회 재시도/prevText 미변경 확인)
</content>
</invoke>
