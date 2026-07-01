# Stella Clover — 재설계 + 오류 근본 수정 TEST RESULTS

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
