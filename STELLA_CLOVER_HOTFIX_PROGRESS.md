STATUS: DONE

# Stella Clover — 회의록 목록 로드 오류 핫픽스

## 증상
회의록 히스토리 새로고침/키워드 검색 시:
```
목록 로드 실패: Unexpected token 'A', "An error o"... is not valid JSON
```

## 근본 원인
1. **서버(플랫폼) 타임아웃 → 평문 응답**: `api/meetings.js`의 핸들러는 이미
   try/catch로 JSON을 반환하지만, `mssql` 기본 타임아웃(connection/request ~15s)이
   Vercel 함수 `maxDuration:15`를 넘기면 **함수가 핸들러 도달 전에 죽고** Vercel이
   `An error occurred...` 평문 에러 페이지를 반환한다(= "An error o"). Azure SQL
   콜드스타트 시 재현.
2. **프런트 비방어적 파싱**: `renderList`/`showDetail`/`doDriveSearch`가
   `await r.json()`을 직접 호출 → 평문 응답에서 `Unexpected token` 발생.
3. **스키마 드리프트 가능성**: `_db.js`의 `CREATE_TABLE`은 `IF NOT EXISTS CREATE`만
   있고 ALTER ADD 가드가 없어, 일부 컬럼 누락 시 `SELECT`가 깨질 수 있음.

## 수정 (작은 커밋 단위)
### `fix(db)` — `api/_db.js`
- `connectionTimeout: 10000`, `requestTimeout: 12000` 추가 → mssql이 함수 한도 내에서
  **빠르게 실패**해 핸들러 try/catch가 항상 JSON을 반환.
- `CREATE_TABLE`에 전체 컬럼 ALTER ADD 가드 추가(keywords/summary/transcript/
  transcript_chars/summary_chars/drive_file_id/drive_link/audio_file/audio_session)
  → 스키마 드리프트에도 SELECT 안전.

### `fix(api)` — `api/meetings.js`
- `maxDuration` 15 → 30 (mssql 12s 실패 + 여유 마진).
- 핸들러 진입 시 `res.setHeader('Content-Type','application/json; charset=utf-8')`.
- (기존) 모든 분기 + catch가 `res.status(200).json(...)`로 JSON 보장 — 유지.

### `fix(ui)` — `index.html`
- `safeJson(r)` 헬퍼 추가: `res.text()` → `JSON.parse` 시도, 실패 시 평문 대신
  깔끔한 한국어 메시지(`서버 응답 형식 오류로...`, `서버 오류(NNN)로...`)를 throw.
- `renderList`(목록·검색 공용), `doDriveSearch`, `showDetail`의 `r.json()`을
  `safeJson(r)`으로 교체 → 새로고침·키워드 검색 양쪽 모두 평문에도 안 깨짐.
- `sw.js` 캐시 `v1 → v2` (활성화 시 구버전 캐시 퍼지).

## Test Report (§5)
| # | 테스트 | 결과 |
|---|--------|------|
| 1 | `node --check api/_db.js` | OK ✅ |
| 2 | `node --check api/meetings.js` | OK ✅ |
| 3 | index.html 인라인 스크립트 `new Function` 파싱 (25,283 chars) | OK ✅ |
| 4 | meetings.js: 모든 분기·catch가 `res.json` 반환 (평문 경로 0) | ✅ |
| 5 | meetings.js: 핸들러 진입 시 Content-Type=application/json 설정 | ✅ |
| 6 | _db.js: connection/request 타임아웃 < maxDuration(30s) | 10s/12s ✅ |
| 7 | _db.js: cl_meetings 전 컬럼 ALTER ADD 가드 | 9개 ✅ |
| 8 | index.html: `safeJson` 적용 지점 = renderList·doDriveSearch·showDetail | 3/3 ✅ |
| 9 | index.html: 잔존 비방어 `await r.json()` (목록/검색/상세 경로) | 0 ✅ |
| 10 | 회귀: summarize/transcribe API 문법 유지 | ✅ |

## 한계 (정직)
- 실제 Azure SQL 콜드스타트 타임아웃·평문 응답 재현은 **배포 환경 + DB 자격증명**이
  필요해 샌드박스에서 end-to-end 실행 불가. Vercel 배포 보호(403)로 배포 URL 외부
  확인도 불가. 코드/문법/분기 경로는 모두 정적 검증 완료.
- `transcribe`/`summarize`의 `r.json()`은 POST 응답(자체 try/catch로 JSON 보장)이라
  이번 핫픽스 범위(목록·검색·상세 GET)에서 제외 — 필요 시 후속.

## 가정 로그
1. 평문 "An error o..."는 Vercel 함수 레벨 에러(타임아웃/크래시)로 판단 →
   서버는 "빠른 실패 + 항상 JSON", 프런트는 "방어 파싱"의 이중 방어로 처리.
2. sw.js는 network-first라 HTML은 온라인 시 항상 최신이지만, 캐시 버전을 올려
   오프라인 구버전 캐시도 정리.
3. 푸시 대상 = **main**. 태스크 프롬프트(§0/§6)가 "main 푸시 → Vercel 자동 배포"를
   명시했고, 본 세션의 기존 패턴도 main 직접 푸시였다. 피처 브랜치
   `claude/todo-implementation-ju0mw8`는 origin/main보다 11커밋 뒤처진 stale 상태라
   이 핫픽스(현 main 코드 기반)를 거기에 올리면 다국어 기능이 누락되어 부적합.
