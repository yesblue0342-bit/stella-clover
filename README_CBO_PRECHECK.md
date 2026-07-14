# CBO Pre-Check

SAP 개발서버에 반영하기 전, GitHub에 올라간 ABAP 소스를 미리 점검하는 모듈입니다.

- 라우트: `/cbo-precheck` (메인 화면 상단 "CBO Pre-Check" 탭)
- ① **검증(Lint)**: [abaplint](https://abaplint.org)를 라이브러리로 직접 호출해 스캔하고, 결과를
  xlsx/md/txt/json 으로 내보냅니다.
- ② **처리(Review)**: 검출 항목별로 [자동 수정 PR] / [Claude 수정 PR] / [보류] 를 선택합니다. 모든 수정은
  **항상 branch → PR** 로만 반영되며, main에 직접 커밋되는 경로는 코드상 존재하지 않습니다.
- ③ **화면(Preview)**: 대상 프로그램의 Selection Screen / ALV 화면을 SAP GUI와 비슷한 톤으로 미리 봅니다.

기존 "CBO Spec & Code Review"(`/cbo-review`)와는 별개 기능입니다. CBO Review는 스펙 생성·코드 리뷰용이고,
CBO Pre-Check은 abaplint 정적 검증·PR 자동화·화면 목업 전용입니다. 단, **AI 연결 설정(API 키/ChatGPT·Claude
계정 로그인)은 두 모듈이 완전히 동일한 공용 모듈(`lib/ai-connection/`)을 공유**합니다 — 한쪽에서 연결하면
다른 쪽에서도 즉시 사용할 수 있습니다(2026-07-14 통합 세션).

## 사용 방법

1. `/cbo-precheck` 접속 → GitHub SSH URL(`git@github.com:owner/repo.git`) / 브랜치 / 경로(선택) 입력 후
   **스캔 시작**. 스캔 대상은 지정 경로 이하 모든 하위 폴더를 재귀적으로 포함합니다(폴더 깊이·이름과 무관 —
   예: `0Program` 저장소의 `<날짜>_QM<번호>_<프로그램명>/_abap/` 처럼 실제 소스가 하위 폴더에 있어도 정상
   검출됩니다). 대상 확장자는 `.abap`로 끝나는 모든 파일(abapGit 네이밍 `.prog.abap`/`.clas.abap`뿐 아니라
   `ZAQMR0130.abap`처럼 단순 확장자만 쓰는 파일도 포함)과 DDIC XML(`.tabl.xml` 등)입니다.
2. ① 검증 탭에서 결과를 확인·필터링·내보내기 합니다. 스캔을 아직 안 했으면 "위에서 저장소를 스캔하세요"가,
   스캔을 마쳤는데 이슈가 0건이면 "스캔 완료 — 발견된 이슈가 없습니다 🎉"가 표시됩니다(두 상태는 서로
   다른 문구입니다 — 스캔 전 상태와 혼동되지 않도록 구분).
3. ② 처리 탭에서 항목별로 PR을 생성하거나 보류 처리합니다. 이슈가 0건이면 "처리할 항목이 없습니다"가
   표시됩니다(스캔 자체를 안 한 경우와 다른 문구).
4. ③ 화면 탭에서 대상 파일을 골라 미리보기를 생성합니다. **스캔을 먼저 하지 않아도** 같은 탭의
   "스캔 없이 바로 미리보기" 카드에서 저장소/브랜치/단일 파일 경로만 입력하면 그 파일 하나만 즉시 가져와
   렌더링합니다(아래 "스캔 없이 화면 미리보기" 절 참고). 두 방식은 같은 렌더링 영역을 공유하며 서로
   방해하지 않습니다.

### 비abapGit 네이밍(단순 확장자) 저장소의 스캔 정확도

abaplint는 파일명(`<이름>.<타입>.abap`)으로 ABAP 오브젝트 타입(PROG/CLAS/...)을 판별합니다.
`ZAQMR0130.abap`처럼 단순 확장자만 쓰는 저장소(`0Program`의 `_abap/` 관례 등)는 이 타입을 인식하지 못해,
과거에는 스캔이 "파일은 수집되지만 이슈는 항상 0건"으로 조용히 실패했습니다(원인 실측은
`WORK_REPORT.md` 2026-07-14 세션 참고). 지금은 스캔 직전 이런 파일을 내부적으로만 임시 abapGit 이름으로
매핑해 abaplint에 넘기고, 결과 화면·내보내기에는 항상 **원본 파일명**만 표시합니다(디스크에 실제 사본을
만들지 않는 인메모리 처리 — 실제 GitHub 소스 파일명은 어떤 경우에도 변경되지 않습니다). `REPORT`/`PROGRAM`
문이 있는 파일은 메인 프로그램으로, 없는 파일(`INCLUDE`로만 쓰이는 서브루틴/로컬 클래스 등)은 include로
처리되어 서로의 전역 변수·상수를 정상적으로 교차 참조합니다.

### 스캔 없이 화면 미리보기(독립 실행)

검증(Lint) 스캔을 먼저 돌리지 않아도, ③ 화면(Preview) 탭의 "스캔 없이 바로 미리보기" 카드에서 GitHub SSH
URL / 브랜치 / **단일 파일 경로**(예: `260707_QM023_ZAQMR0130/_abap/ZAQMR0130_S01.abap`)를 입력하고
[미리보기 생성]을 누르면, 그 파일 하나만 즉시 clone해 Selection Screen/ALV 목업을 렌더링합니다
(`action=preview-direct`). `GITHUB_TOKEN` 없이도 동작합니다(SSH 배포키 clone만 사용 — 스캔과 동일한
전제). 비abapGit 네이밍 파일도 위와 동일한 어댑터가 적용되어 정상 파싱됩니다.

## 환경변수 (OCI `.env`)

기존 인프라를 재사용하며, 이 모듈만을 위한 신규 API 키는 없습니다.

| 변수 | 용도 | 미설정 시 동작 |
|---|---|---|
| `CBO_ACCESS_PW` | 개인용 접근 게이트 비밀번호(★ **CBO Spec & Code Review와 동일 값 재사용**) | 게이트 없이 누구나 접근(로컬 개발 전제) |
| `GITHUB_TOKEN` | 저장소 SSH clone과 별개로, PR 생성/파일 조회에 사용하는 fine-grained PAT(대상 repo Contents+Pull requests read/write) | [자동 수정 PR]/[Claude 수정 PR] 버튼이 회색으로 비활성(툴팁 안내), 검증/미리보기는 정상 동작 |

**"Claude 수정 PR" 제안 생성**은 더 이상 `ANTHROPIC_API_KEY` 환경변수 하나로 게이트되지 않습니다. 화면 상단
**[AI 연결 설정]** 버튼(CBO Spec & Code Review와 완전히 동일한 모달·동일한 저장소)에서 아래 세 수단 중
**하나라도** 연결하면 활성화됩니다.

1. **API 키 등록** — `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` 환경변수는 그대로 폴백으로 동작하며(설정돼 있으면
   자동 인식), 화면에서 직접 키를 입력해 서버 로컬 데이터 영역에 저장할 수도 있습니다.
2. **ChatGPT 구독 인증** — 서버에 Codex CLI(`codex login`)가 1회 로그인돼 있으면 "계정으로 로그인 사용"으로
   연결. API 키를 발급/저장하지 않고 본인 ChatGPT 구독 한도로 호출됩니다.
3. **Claude 구독 인증** — 서버에 Claude Code CLI(`claude login`)가 1회 로그인돼 있으면 동일한 방식으로 연결.

**우선순위**(이 기능 전용 — 하나만 선택해 실제 호출에 사용): 구독 인증(Claude 우선, 없으면 ChatGPT/Codex)
**>** API 키(Claude 우선, 없으면 ChatGPT). 아무 수단도 연결되지 않으면 [Claude 수정 PR] 버튼이 비활성되고
상단에 "AI 연결 필요 — [AI 연결 설정]에서 로그인하세요"가 표시됩니다.

**SSH 배포키**: 저장소 clone/브랜치 push는 서버의 SSH 설정(예: `~/.ssh/id_ed25519` + GitHub Deploy Key 또는
계정 키)을 사용합니다. HTTPS/PAT 기반 clone은 지원하지 않습니다(절대 규칙: remote는 SSH만).

`CBO_ACCESS_PW`가 이미 설정되어 있다면(CBO Review를 쓰고 있다면) 추가 설정 없이 같은 비밀번호로
CBO Pre-Check에도 로그인됩니다. **AI 연결**도 마찬가지로 CBO Review에서 이미 연결해 두었다면 CBO
Pre-Check에서 별도 설정 없이 바로 사용됩니다(동일한 공용 저장소를 공유하기 때문).

## DDIC 정의 넣는 법 (`check_ddic` 검증용)

`abaplint`가 `TYPE qals-존재하지않는필드` 같은 DDIC 필드 오참조를 잡으려면(`unknown_types` 룰), 대상 저장소에
해당 테이블의 DDIC 정의(abapGit TABL XML)가 있어야 합니다. 스캔 대상 저장소에 다음과 같이 넣어두세요.

1. SAP GUI에서 `SE11` → 대상 테이블(예: `QALS`, `QAMV`, `QPMK`, `QAVE`) 조회.
2. [abapGit](https://abapgit.org)로 해당 테이블을 `.tabl.xml`로 export(예: `ddic/qals.tabl.xml`).
3. 저장소의 스캔 대상 폴더(스캔 시 지정한 `path`) 아래 `ddic/` 폴더에 커밋.
4. 이후 스캔부터 자동으로 인식됩니다(파일명이 `*.tabl.xml`/`*.dtel.xml`/`*.doma.xml`/`*.ttyp.xml`/`*.shlp.xml`/`*.view.xml` 패턴이면 인식).

DDIC XML이 없어도 스캔 자체는 정상 동작하며, 이 경우 `check_ddic`/DDIC 필드 참조 검증만 건너뜁니다(다른
룰은 그대로 적용).

## 알려진 한계

- **저장소에 없는 DDIC/타입풀 의존성은 "찾을 수 없음"으로 보고됩니다.** `ICON` 타입풀(`icon_create` 등)이나
  스캔 대상 저장소에 export되지 않은 커스텀 테이블(예: 실제 존재하지만 저장소엔 DDIC XML이 없는
  Z테이블)을 참조하면 abaplint가 진짜 결함처럼 보고합니다 — 이 도구가 SAP 시스템 전체 DDIC/타입풀에
  접근할 수 없어서 생기는 기대된 한계입니다("DDIC 정의 넣는 법" 절 참고, 필요한 만큼 export해 넣으면
  해소됩니다).
- **런타임 오류·권한·인터페이스·성능은 검증하지 않습니다.** abaplint는 정적 분석 도구이며, 실제 SAP
  런타임에서만 드러나는 문제(권한 부족, BAdI/사용자exit 동작, DB 락, 성능)는 이 도구의 범위 밖입니다.
- **화면 미리보기의 `TEXT-xxx` 라벨은 실제 번역 텍스트가 아닙니다.** SAP 텍스트 풀(`SE38`의 텍스트 심볼)은
  소스 코드만으로는 해석할 수 없어, 심볼명을 그대로 라벨로 표시합니다.
- **ALV fieldcatalog 인식은 두 가지 패턴만 지원합니다**: `APPEND` 루프 방식과 `VALUE #( ( ... ) )` 생성자
  방식. `cl_salv_table` 자동 컬럼 추정(SELECT 필드 목록 기반)은 정확도가 낮아 v1에서 제외했습니다 —
  필요시 후속 작업으로 추가할 수 있습니다.
- **스캔 결과는 서버 메모리에만 보관됩니다**(최대 30건, 서버 재시작 시 소실). 재현이 필요하면 다시
  스캔하세요.
- **자동 수정 PR/Claude 수정 PR은 항상 한 파일 단위로 branch+PR을 새로 만듭니다.** 여러 파일을 한 PR로
  묶는 기능은 없습니다(v1 단순화).
- **실제 GitHub PR 생성 E2E는 개발 세션에서 mock으로만 검증했습니다** — `GITHUB_TOKEN`/SSH 배포키가 없는
  샌드박스 환경이었기 때문입니다. `GITHUB_TOKEN`을 설정한 뒤, 아래 순서로 1회 수동 확인을 권장합니다.
  1. `/cbo-precheck`에서 실제 저장소를 스캔.
  2. `quickfixAvailable=true`인 항목에 [자동 수정 PR] 클릭 → 생성된 PR 링크 확인.
  3. PR 내용(변경 파일, diff)이 의도대로인지 확인 후 **close(병합하지 않음)**.
  4. 문제가 있으면 `LESSONS.md`에 기록.
