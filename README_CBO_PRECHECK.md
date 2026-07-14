# CBO Pre-Check

SAP 개발서버에 반영하기 전, GitHub에 올라간 ABAP 소스를 미리 점검하는 모듈입니다.

- 라우트: `/cbo-precheck` (메인 화면 상단 "CBO Pre-Check" 탭)
- ① **검증(Lint)**: [abaplint](https://abaplint.org)를 라이브러리로 직접 호출해 스캔하고, 결과를
  xlsx/md/txt/json 으로 내보냅니다.
- ② **처리(Review)**: 검출 항목별로 [자동 수정 PR] / [Claude 수정 PR] / [보류] 를 선택합니다. 모든 수정은
  **항상 branch → PR** 로만 반영되며, main에 직접 커밋되는 경로는 코드상 존재하지 않습니다.
- ③ **화면(Preview)**: 대상 프로그램의 Selection Screen / ALV 화면을 SAP GUI와 비슷한 톤으로 미리 봅니다.

기존 "CBO Spec & Code Review"(`/cbo-review`)와는 별개 기능입니다. CBO Review는 스펙 생성·코드 리뷰용이고,
CBO Pre-Check은 abaplint 정적 검증·PR 자동화·화면 목업 전용입니다. 두 모듈은 파일을 공유하지 않습니다.

## 사용 방법

1. `/cbo-precheck` 접속 → GitHub SSH URL(`git@github.com:owner/repo.git`) / 브랜치 / 경로(선택) 입력 후
   **스캔 시작**.
2. ① 검증 탭에서 결과를 확인·필터링·내보내기 합니다.
3. ② 처리 탭에서 항목별로 PR을 생성하거나 보류 처리합니다.
4. ③ 화면 탭에서 대상 파일을 골라 미리보기를 생성합니다.

## 환경변수 (OCI `.env`)

기존 인프라를 재사용하며, 이 모듈만을 위한 신규 API 키는 없습니다.

| 변수 | 용도 | 미설정 시 동작 |
|---|---|---|
| `CBO_ACCESS_PW` | 개인용 접근 게이트 비밀번호(★ **CBO Spec & Code Review와 동일 값 재사용**) | 게이트 없이 누구나 접근(로컬 개발 전제) |
| `GITHUB_TOKEN` | 저장소 SSH clone과 별개로, PR 생성/파일 조회에 사용하는 fine-grained PAT(대상 repo Contents+Pull requests read/write) | [자동 수정 PR]/[Claude 수정 PR] 버튼이 회색으로 비활성(툴팁 안내), 검증/미리보기는 정상 동작 |
| `ANTHROPIC_API_KEY` | "Claude 수정 PR" 제안 생성(모델: `claude-sonnet-5`) | [Claude 수정 PR] 버튼만 비활성 |

**SSH 배포키**: 저장소 clone/브랜치 push는 서버의 SSH 설정(예: `~/.ssh/id_ed25519` + GitHub Deploy Key 또는
계정 키)을 사용합니다. HTTPS/PAT 기반 clone은 지원하지 않습니다(절대 규칙: remote는 SSH만).

`CBO_ACCESS_PW`가 이미 설정되어 있다면(CBO Review를 쓰고 있다면) 추가 설정 없이 같은 비밀번호로
CBO Pre-Check에도 로그인됩니다.

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
