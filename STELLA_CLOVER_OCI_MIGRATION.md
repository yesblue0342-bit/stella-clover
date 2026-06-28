# Stella Clover — Vercel 제거 → OCI 서버 이관 (진행/결과)

> 지시: "우리는 vercel을 사용하지 않는다. Stella Clover가 vercel에 의존하고 있다면 해당 로직 삭제 후 OCI 서버로 이관."
> stella-ai-workspace가 이미 거친 동일 이관(Vercel→OCI Docker/Express)을 같은 패턴으로 적용.

## 무엇이 Vercel 의존이었나 → 어떻게 제거했나
| Vercel 의존 | 제거/대체 |
|------|------|
| `vercel.json` (rewrites + cron) | **삭제**. rewrites는 `server.mjs`로, cron(0 18 * * *)은 서버 내부 스케줄러로 이관 |
| `package.json` `"dev":"vercel dev"` | `"start":"node server.mjs"` + `"test"`로 교체 |
| 각 핸들러 `export const config={maxDuration/bodyParser}` | **제거**(OCI 장수 프로세스는 시간 제한 없음). multipart는 server.mjs가 body 파싱을 건너뛰어 formidable이 직접 읽음 |
| `worker.js`의 "한 청크 처리 후 HTTP로 자기재호출" (Vercel 함수모델 우회) | **인프로세스 워커**(`lib/jobs-runtime.js`)로 전환 — 한 잡의 남은 청크를 끝까지 루프 처리 |
| Azure SQL 전제(`_db.js` encrypt+검증 고정) | 호스트 자동판별 TLS — OCI 동거 `stella-mssql`(자체서명 허용) **또는** Azure(검증 유지) 모두 지원 |

## 추가/변경 파일
| 파일 | 내용 |
|------|------|
| `server.mjs` (신규) | Express 어댑터: 정적 서빙 + `/`,`/talk`,`/db` rewrite + CSP + `/api/*`→`api/<name>.js` default(req,res) 호출. `_언더스코어`·경로탈출 404. 부팅 시 미완료 잡 복구 + 일일 오디오 정리 스케줄(전부 dynamic import+try/catch라 DB/Drive 미설정이어도 정적 서버는 동작) |
| `Dockerfile` (신규) | node:22-slim + `npm install --omit=dev` + PORT 8971 + curl 헬스체크 |
| `.github/workflows/deploy-oci.yml` (신규) | main push → SSH로 OCI에서 `git reset --hard` + `deploy/run-stella-oci.sh`. 시크릿 미설정 시 green skip |
| `deploy/run-stella-oci.sh` (신규) | docker build/run (`--network npm_default`, `--env-file .env`, `--restart unless-stopped`) + 헬스체크 |
| `.env.example`/`.dockerignore`/`.gitignore` (신규) | 환경변수 템플릿(시크릿 값 없음) + 빌드/시크릿 제외 |
| `lib/jobs-runtime.js` (신규) | 인프로세스 백그라운드 워커: 동시상한(JOBS_CONCURRENCY, 기본 2)+대기큐, chunks_done CAS 가드(멱등), 청크별 진행률 DB 영속, 한 청크 실패해도 계속, 완료 시 화자+요약, **부팅 복구(recover)** |
| `api/chunk-upload.js` (신규) | 클라이언트가 분할한 청크를 Drive(`Audio` 폴더)에 업로드하고 file id 반환 → `chunkRefs` 구성용 |
| `api/worker.js` | 워치독 엔드포인트로 축소(인프로세스 `kick`에 위임) |
| `api/jobs.js` | worker HTTP 트리거 → 인프로세스 `kick` |
| `api/_db.js` | 호스트 자동판별 TLS + `DB_*`(별칭 `CL_DB_*`) + `hasDbConfig()` |
| `api/cleanup.js` | Vercel Cron 프레이밍 제거(서버 내부 스케줄러가 호출) |
| `api/{summarize,meetings,audio,autosave,drive-search,transcribe}.js` | `export const config` 제거(동작 동일) |

## 테스트 결과 (샌드박스, Node 22)
| # | 항목 | 결과 |
|---|------|------|
| 1 | `node --check` server.mjs + api/*.js + lib/*.js (20개) | **20/20 OK** ✅ |
| 2 | 전체 핸들러 dynamic import (의존성 설치 후) | **11/11 OK** (잘못된 import 없음) ✅ |
| 3 | `server.mjs` 부팅 → `GET /` index.html 서빙 | **200, "Stella Clover"** ✅ |
| 4 | `/api/_db` 언더스코어 가드 | **404 JSON**(공유 모듈 비노출) ✅ |
| 5 | `/api/meetings`·`/api/jobs`·`/api/worker` DB 미설정 | **graceful JSON**(평문 에러 없음) ✅ |
| 6 | `/api/drive-search` Drive 미설정 | **graceful JSON** ✅ |
| 7 | `/talk` rewrite | **200** ✅ |
| 8 | 부팅 작업(잡 복구·정리 스케줄) DB 없이도 서버 유지 | ✅ (복구 try/catch, 정적 서버 정상) |
| 9 | 순수 함수: `computeOffsetSec([120,118],2)=238` / TLS(stella-mssql=trust, azure=verify) / `hasDbConfig` | ✅ |
| 10 | 시크릿 스캔 | 0 ✅ |

## 한계 (정직)
- **실 파이프라인 미검증**: DB/Drive/OpenAI 자격증명은 배포 환경에만 존재 → 실제 전사·요약 end-to-end는 샌드박스 실행 불가. 어댑터/라우팅/가드/부팅까지 런타임 검증, 핵심 로직은 정적+단위 검증.
- **무회귀**: 기존 동기 전사 흐름(`/api/transcribe`)은 그대로 OCI에서 동작 → 이관만으로 사용자 영향 없음. 백그라운드 잡 클라이언트 연동은 후속 증분(아래).
- 배포 트리거는 **main push**. 본 작업은 개발 브랜치에 푸시 → 실제 OCI 배포는 main 병합 시.

## 후속 증분 (index.html 클라이언트 연동 — 별도 커밋)
분할→`/api/chunk-upload`→`POST /api/jobs`→폴링→렌더, 탭 닫힘/재접속 자동 재개, 모델 선택, "내 변환" 목록, SW bump.
