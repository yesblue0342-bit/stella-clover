# Stella Clover — 클로바식 출력 + 서버 백그라운드 변환 (진행)

> ⚠️ 가정 로그: 태스크 헤더 repo가 `stella-ai-workspace`로 적혔으나, 목표("Stella Clover")·기능
> (Whisper 청크 전사·Drive 음원·Azure `cl_meetings`·"기존 클라이언트 전사 로직")은 전부
> **stella-clover** 앱의 것이고 stella-ai-workspace엔 전사 파이프라인이 없음. "충돌 시 [A] 우선" +
> 명시된 목표에 따라 **stella-clover**에서 진행함.
> 시작 시 [A]/[B] 기존 구현 0건 확인(transcribe.js=text only, summarize=plain, 잡 테이블 없음) → 신규 빌드.

## 이번 증분 = 서버 파이프라인 (검증 완료, main 푸시)
| 파일 | 역할 | 사양 |
|------|------|------|
| `api/_stt.js` | 청크 전사 공통 | A1/A2/A6: model 선택(기본 whisper-1), whisper-1만 `verbose_json`→segments, **글로벌 offset 보정**, timestamps 유무는 **응답 데이터 기반**(모델 하드코딩 X), SAP 프롬프트 확장 |
| `api/_analyze.js` | 분석 | A4 `labelSpeakers`(voiceprint 불가 → LLM 턴 추정 "참석자 N", 근사치 명시) + A5 `structuredSummary`(JSON: oneLine/topics/decisions/actionItems/keywords) — gpt-4.1-mini, parse 방어 |
| `api/transcribe.js` | 레거시 청크 엔드포인트 | `_stt` 재사용, `model`/`offsetSec` 수신, **segments 반환**(A2) |
| `api/_db.js` | DB | B1 `transcribe_jobs` 테이블(JSON 컬럼) + `parseJson` 가드. 기존 30s 타임아웃 + `connectWithRetry` 재사용(cold-start) |
| `api/_drive.js` | Drive | `downloadFileById`(worker가 청크 재취득) |
| `api/jobs.js` | B3 | POST 생성(+worker 트리거)→`job_id` / GET 상태(진행률·segments·speakers·summary) / GET `?action=list`(재진입 "내 변환"). 항상 JSON |
| `api/worker.js` | B3/B4 | **resumable**: DB `chunks_done` 커서 재계산, **CAS 가드**(동시 워커 중복 방지), 청크 1개 전사→offset→append→재트리거; 완료 시 status=summarizing→화자+요약→done. maxDuration 300. 한 청크 실패해도 전체 중단 안 함 |
| `api/audio.js` | A3 | Drive 음원 스트리밍(재진입 재생) |
| `vercel.json` | 라우팅 | `/api/jobs`,`/api/worker`,`/api/audio`를 catch-all(`/(.*)→index.html`) **앞에** 추가(미추가 시 index.html로 리라이트됨) |

### API 계약 (클라이언트 연동용)
- `POST /api/jobs` body `{userId,language,model,chunkRefs:[{id,index,durationSec,ext}],audioRef,title}` → `{ok,job_id}`
- `GET /api/jobs?id=N` → `{ok,job:{status,progress,chunks_done/total,segments:[{start,end,text,speaker?}],summary:{...},audioRef,error}}`
- `GET /api/jobs?action=list&userId=` → `{ok,jobs:[...]}` (processing/summarizing)
- `POST /api/worker?id=N` (자동 트리거; 워치독용 수동 호출 가능)
- `GET /api/audio?id=<driveFileId>` → audio/wav 스트림

## 남은 증분 = 클라이언트 통합 (다음 단계, index.html)
아직 미반영(현재 index.html은 기존 동기 전사 흐름). 다음 작업:
1. **흐름 전환(B2)**: 기존 Web Audio 청크 분할 유지 → 각 청크를 **Drive 업로드**(작업 폴더, 재생용 ref 보관) → `POST /api/jobs`(chunkRefs) → 업로드 끝나면 **탭 닫아도 됨**.
2. **폴링(B2-5)**: `GET /api/jobs?id=` 진행률 표시, 완료 시 [A2~A5] 렌더.
3. **세그먼트 뷰(A2/A3)**: `[mm:ss] 텍스트` 리스트(+화자 라벨), 클릭→`<audio src="/api/audio?id=">` seek, 재생 중 현재 세그먼트 하이라이트. (timestamps 없으면 일반 transcript)
4. **구조화 요약 카드(A5)**: oneLine/주제/결정/액션/키워드.
5. **모델 선택 UI**: whisper-1(기본·타임스탬프) / gpt-4o-mini-transcribe(빠름·무타임스탬프) / gpt-4o-transcribe.
6. **재진입 "내 변환"(B3 list)** + 폴링 워치독(processing인데 chunks_done 60초 정지 시 `POST /api/worker?id=` 재트리거).
7. SW 캐시 bump(프런트 변경 시).
- 선택: Vercel Cron 워치독(`/api/worker` 스캔 엔드포인트) — 현재는 클라이언트 워치독으로 커버.

## 테스트 결과 (이번 증분)
| # | 테스트 | 결과 |
|---|--------|------|
| 1 | `node --check` 8개 backend(_stt,_analyze,_db,_drive,jobs,worker,audio,transcribe) | **8/8 OK** ✅ |
| 2 | `vercel.json` `JSON.parse` + 새 api 라우트 catch-all 앞 배치 | ✅ |
| 3 | JSON 컬럼 직렬화/파싱 가드(`parseJson` try/catch) | ✅ |
| 4 | 워커 idempotent(CAS `WHERE chunks_done=@cur`) | ✅ |
| 5 | 시크릿 스캔 | 0 ✅ |

## 한계 (정직)
- **런타임 미검증**: Azure SQL/Drive/OpenAI 자격증명이 배포 환경에만 있어 실제 생성→처리→완료 플로우는 샌드박스 실행 불가. 구문(node --check)·구조·계약까지 정적 검증.
- **클라이언트 미연동**이라 현재 사용자 화면엔 아직 안 보임 → 위 "남은 증분"이 다음 작업.
- 화자 라벨은 voiceprint 없는 **LLM 근사치**(UI/주석에 명시 필요).

## [2026-06-28 업데이트] Vercel 제거 → OCI 이관 + 클라이언트 연동 완료
- **워커 모델 변경**: Vercel 함수모델의 "한 청크 처리 후 `/api/worker` HTTP 자기재호출"을 제거하고
  **인프로세스 워커**(`lib/jobs-runtime.js`)로 전환. 동시상한(`JOBS_CONCURRENCY`)+큐, `chunks_done` CAS 멱등,
  **부팅 복구(`recover`)**로 서버 재시작에도 미완료 잡 자동 재개. `worker.js`는 워치독 엔드포인트로 축소.
- **구동/배포**: Vercel → OCI Docker/Express(`server.mjs`). 자세한 내용 `STELLA_CLOVER_OCI_MIGRATION.md`.
- **클라이언트 연동(index.html) 완료**(위 "남은 증분"):
  1. 분할 → `POST /api/chunk-upload`(Drive 업로드) → `POST /api/jobs(chunkRefs)` → 업로드 끝나면 탭 닫아도 됨.
  2. 3초 폴링(`GET /api/jobs?id=`) 진행률 → 완료 시 transcript로 **기존 `/api/summarize`+렌더+`cl_meetings` 이력** 그대로.
  3. **자동 재개**: `clover_active_jobs` localStorage + `resumeActiveJobs()`(로드 시) → 탭/서버 재시작 무관 이어서 완료.
  4. 모델 선택 UI(whisper-1/gpt-4o-mini-transcribe/gpt-4o-transcribe), 60초 정지 워치독 → `POST /api/worker?id=`.
  5. SW 캐시 v10→v11.
## [2026-06-28 추가증분] 클라이언트 리치 UI 완료 (BG_CLIENT)
> ⚠️ 가정: 지시 파일 `PROMPT_BG_CLIENT.md`가 환경에 실재하지 않아(=빈 프롬프트), 파일명·기존 "남은 증분"·
> 원 PROMPT step3 사양에 근거해 **세그먼트 뷰 / 구조화 요약 카드 / "내 변환" 목록**을 구현함(질문 없이 진행).
- **세그먼트 뷰(A2/A3)**: 결과 영역에 접이식 "🕐 타임라인" — `[mm:ss] 화자: 텍스트` 리스트. 행 클릭 → 해당
  global time이 속한 청크를 `/api/audio?id=`로 재생 + 청크 내 offset seek, 재생 중 현재 세그먼트 하이라이트.
  (`jobs.js` GET에 `chunkRefs` 추가 → 청크별 재생 가능.)
- **구조화 요약 카드(A5)**: job.summary(oneLine/주제/결정/액션/키워드)를 요약 위 카드로 렌더.
- **"내 변환" 목록(B3)**: `GET /api/jobs?action=list&userId=` → 진행 중(processing/summarizing) 잡 카드 + "이어보기"
  (수동 재개). 로드 시/생성 시/완료 시 갱신.
- 검증: 인라인 JS `new Function` 0 errors, **jsdom 렌더 테스트**(structCard·segView·_findChunk·재생 src·fmtTime) 통과,
  node --check 20/20, npm test 34/34. SW v11→v12.
