# PROGRESS — 무인 자동 진행 로그

## 가정 (autopilot, 질문 금지 → 합리적 가정 기록 후 진행)
- **DB 타깃**: 사용자가 "Azure(azsure) 걷어내고 우분투로 교체, OCI에서 배포"라고 명시. 자체 호스팅 관계형 DB의 가장 일반적·합리적 선택인 **PostgreSQL**로 가정하고 마이그레이션. 드라이버는 `pg`(node-postgres).
  - **[2026-06-27 확정]** 사용자 OCI 서버 점검 결과: 앱은 Docker 컨테이너(`seoblue0342:8842`, nginx-proxy-manager 라우팅), DB는 `stella-mssql`=azure-sql-edge 컨테이너였음. 사용자가 **"PostgreSQL로 전환, azure-sql-edge 삭제, OCI Ubuntu만 사용"** 확정 → pg 마이그레이션 방향 **정답**으로 확정. Docker 배포 일습(Dockerfile/docker-compose: postgres+app) 추가.
  - **데이터 이관 주의**: 기존 메타데이터가 azure-sql-edge(SQL Server)에 있다면 삭제 전 Postgres로 이관 필요(SQL Server→PG 크로스 방언). 신규 시작이면 스키마는 `ensureSchema`가 자동 생성.
- **연결 설정**: `DATABASE_URL` 우선, 없으면 표준 `PG*` 변수. SSL은 `PGSSL`로 제어(원격 OCI는 `require` 권장). 구 Azure 변수(`CL_DB_*`)는 완전히 제거.
- **메타데이터 일원화**: "메타데이터만 azure에서 읽어옴" 증상의 원인은 `_db.js`가 여전히 `mssql`이었던 것. 모든 DB 소비자(`meetings/summarize/jobs/worker/workspace`)를 단일 PostgreSQL 풀로 통일 → 기기·엔드포인트 무관 단일 진실원천.
- **소비자 호환**: 호출부 변경 최소화를 위해 `_db.js`에 mssql 스타일(`pool.request().input(@name).query()`) 호환 셰임 유지. 셰임이 `@name`→`$n` 변환. SQL **방언만** PostgreSQL로 재작성.
- **배포**: **Vercel에서 독립 → OCI(Ubuntu) 배포**. 소스=GitHub, 데이터/파일=Google Drive, 메타데이터=OCI PostgreSQL. 시크릿은 더 이상 Vercel 스토어 아님 → OCI env/.env/Vault 주입(`process.env.*` 그대로). 샌드박스는 배포 자격증명 없음 → 지정 브랜치 push(파이프라인/직접 pull로 OCI 반영). `VERCEL_URL` 의존 제거(`PUBLIC_BASE_URL`/forwarded 헤더). `vercel.json`은 레거시 호환용으로 보존(삭제하지 않음 — OCI에선 무시).

## 변경 요약 (Azure SQL → PostgreSQL)
- `_db.js`: `pg` 풀 + 호환 셰임 + `ensureSchema`(콜드스타트 1회) + PostgreSQL 방언 스키마(`cl_meetings`/`transcribe_jobs`/`ws_*`).
- `_sqlshim.js`(신규): `@name`→`$n` 변환 + `sql` 타입 토큰(pg 비의존, 단위 테스트).
- `meetings.js`: `TOP 50`→`LIMIT 50`, `LIKE`+대괄호→`ILIKE`+`\` 이스케이프, 쿼리별 `CREATE_TABLE` 프리픽스 제거, env 가드 `hasDbConfig()`.
- `summarize.js`: 인라인 T-SQL `CREATE+INSERT`→순수 `INSERT`(스키마는 풀에서 보장).
- `jobs.js`: `OUTPUT INSERTED`→`RETURNING`, `TOP 20`→`LIMIT 20`, env 가드.
- `worker.js`: `SYSUTCDATETIME()`→`now()`, `CREATE_JOBS` 프리픽스 제거.
- `workspace.js`: 자체 `INIT_SQL/ensureDb` 제거(스키마 중앙화), `SYSUTCDATETIME()`→`now()`, env 가드 추가.
- `package.json`: `mssql` 제거, `pg` 추가.
- `vercel.json`: 누락됐던 `/api/workspace` rewrite 추가.
- `CLAUDE.md`: Azure SQL 플레이북·환경변수·아키텍처를 PostgreSQL/OCI로 갱신.

## 보류 `[!]`
- (없음) — 전 항목 구현·테스트 통과.
