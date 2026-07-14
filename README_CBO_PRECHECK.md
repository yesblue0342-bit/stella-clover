# CBO Pre-Check

SAP 개발서버에 반영하기 전, GitHub에 올라간 ABAP 소스를 미리 점검하는 모듈입니다.

- 라우트: `/cbo-precheck` (메인 화면 상단 "CBO Pre-Check" 탭)
- ① **검증(Lint)**: [abaplint](https://abaplint.org)를 라이브러리로 직접 호출해 스캔하고, 결과를
  xlsx/md/txt/json 으로 내보냅니다.
- ② **처리(Review)**: 검출 항목별로 [자동 수정 PR] / [Claude 수정 PR] / [보류] 를 선택합니다. 모든 수정은
  **항상 branch → PR** 로만 반영되며, main에 직접 커밋되는 경로는 코드상 존재하지 않습니다.
- ③ **화면(Preview)**: 대상 프로그램의 Selection Screen과, `CALL SCREEN`으로 진입하는 Dynpro Screen(ALV
  화면 등)을 SAP GUI와 비슷한 톤으로 미리 봅니다.

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
   "스캔 없이 바로 미리보기" 카드에서 저장소/브랜치/파일 경로만 입력하면 렌더링합니다(아래 "스캔 없이
   화면 미리보기" 절 참고). 두 방식은 같은 렌더링 영역을 공유하며 서로 방해하지 않습니다. GitHub SSH URL
   입력란(스캔 대상/이 카드 둘 다)은 기본값으로 실제 `0Program` 저장소
   (`git@github.com:yesblue0342-bit/0Program.git`, 브랜치 `main`)가 채워져 있어 바로 버튼을 눌러도
   동작하며, 다른 저장소를 쓰려면 값을 지우고 원하는 SSH URL을 입력하면 됩니다.

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
URL / 브랜치 / **경로(폴더 또는 파일)**를 입력하고 [미리보기 생성]을 누르면 렌더링합니다
(`action=preview-direct`). `GITHUB_TOKEN` 없이도 동작합니다(SSH 배포키 clone만 사용 — 스캔과 동일한 전제).
비abapGit 네이밍 파일도 위와 동일한 어댑터가 적용되어 정상 파싱됩니다.

- **파일 경로**(예: `260707_QM023_ZAQMR0130/_abap/ZAQMR0130_S01.abap`)를 넣으면 기존과 동일하게 그 파일이
  속한 폴더 전체를 clone해 같은 폴더의 형제 파일(TEXTS 문서·INCLUDE 대상)을 찾습니다.
- **폴더 경로**(예: `260707_QM023_ZAQMR0130`)만 넣으면 그 폴더를 통째로 clone해 하위 전체에서 메인
  프로그램(`REPORT`/`PROGRAM` 문이 있는 `.abap` 파일)을 자동으로 찾습니다. 메인 프로그램이 여러 개
  발견되면(예: `ZAQMR0130.abap` + `ZAQMR0131.abap`) 전부 렌더링합니다(선택 UI 없이 한 번에 표시 — 스펙
  문서 작성 시 어차피 전부 확인해야 하므로 구현이 단순한 쪽을 택했습니다). 메인 프로그램을 하나도 찾지
  못하면 명확한 오류 메시지를 표시합니다.

### TEXT 라벨 자동 치환

같은 폴더에 `<프로그램명>_TEXTS.txt`(텍스트 심볼/선택화면 텍스트 문서) 파일이 있으면, 미리보기가 이를
파싱해 `TEXT-001` 같은 심볼과 `s_werks`/`p_disp` 같은 변수명 라벨을 실제 SAP 화면 텍스트("Selection
Criteria", "Plant", "Display" 등)로 치환합니다. 변수명은 라벨 옆에 작게 계속 표시됩니다(개발자가 실제
필드명도 알아야 하므로 완전히 숨기지 않음). PARAMETERS의 `DEFAULT`/`OBLIGATORY`, SELECT-OPTIONS의
`OBLIGATORY`도 화면에 표시됩니다(필수 표시 `*`, 기본값은 입력칸 안의 값).

- 실측(`WORK_REPORT.md` 참고)으로 확인한 두 가지 문서 형식(ABAP 주석 스타일 — `*===` 장식과 `[N]`
  대괄호 장식, 둘 다 "섹션 헤더 + 줄마다 `KEY  값`" 구조는 동일)을 하나의 파서(`lib/cbo-precheck/textSymbols.js`)로 처리합니다.
- **`_TEXTS.txt` 파일이 없거나, 있어도 위 두 형식과 다른 구조(예: `EN:`/`KO:` 인용부호·콜론 기반의
  산문형 문서)이면 조용히 폴백합니다** — 매핑 없이 기존처럼 `TEXT-xxx` 심볼/변수명 그대로 표시되며,
  렌더링이 깨지거나 크래시가 나지 않습니다.
- 텍스트 심볼 파일 자체는 스캔 대상(`.abap` 린트)에 포함되지 않습니다 — 라벨 치환 참고 문서일 뿐입니다.

### INCLUDE 자동 병합

메인 프로그램(`REPORT`/`PROGRAM` 문이 있는 파일)을 미리보기 대상으로 지정하면, 소스의 `INCLUDE zxxx.`
문을 읽어 같은 폴더에서 대응하는 파일(대소문자 무관 이름 매칭)을 찾아 그 자리에 이어붙인 뒤 하나의 화면으로
렌더링합니다 — 예를 들어 `ZAQMR0130.abap`(메인)만 지정해도 `_S01.abap`에 있는 Selection Screen 정의가
전부 반영됩니다(과거에는 메인 파일만 지정하면 "해석됨 0개"였습니다). 화면 상단에 "N개 파일(메인 +
INCLUDE M개)을 합쳐 생성했습니다" 안내가 표시됩니다. 대응하는 INCLUDE 파일을 찾지 못하면 그 INCLUDE만
건너뛰고 경고를 표시하며 나머지는 정상 렌더링됩니다(부분 실패 허용). include 파일(`_S01.abap` 등)을
단독으로 지정하는 기존 방식은 그대로 동작합니다(병합 없이 그 파일만 파싱 — 회귀 없음).

### SAP 표준 심볼(TYPE-POOLS) 오탐 제거

`icon_create` 등 SAP 표준 타입풀(`TYPE-POOLS: icon.`) 상수를 값으로 참조하는 코드는 abaplint가 실제
정의를 갖고 있지 않아 "선언되지 않은 변수"로 오탐했습니다. 이제 스캔이 2단계로 동작합니다 — 1차 스캔에서
"not found" 이슈로 나온 식별자 중 `icon_` 접두사 등 알려진 SAP 표준 타입풀 명명 규칙과 일치하는 것만
abaplint 공식 확장점(`syntax.globalConstants`)에 등록하고 2차로 다시 스캔합니다. 이 저장소의 모든 Z
프로그램 변수는 `gc_`/`gv_`/`gt_`/`gs_`/`go_` 같은 헝가리안 접두사를 쓰므로 `icon_` 접두사 패턴이 실제
미선언 변수를 가려버릴 위험은 낮습니다 — 매칭되지 않는 식별자(진짜 오타·미선언 변수)는 여전히
`check_syntax`로 그대로 검출됩니다. 새로운 표준 타입풀 오탐이 발견되면
`lib/cbo-precheck/sapStandardSymbols.js`의 패턴 배열에 항목만 추가하면 됩니다(코드 수정 불필요).

### Dynpro Screen(실행 후 화면) 렌더링과 한계

Selection Screen 외에 `CALL SCREEN`/`SET SCREEN`/`LEAVE TO SCREEN`으로 진입하는 Dynpro Screen(예: ALV
그리드 화면)도 발견되는 대로 전부 렌더링합니다. 화면 전환 순서는 상단에 "화면 전환 흐름: Selection
Screen(1000) → Screen 0100" 형태로 표시됩니다.

**소스에서 실제로 추출하는 값(정확함)**:
- 화면 번호, `MODULE <이름> OUTPUT`/`INPUT`으로 매핑된 PBO/PAI 모듈(화면번호가 이름에 없으면 발견된
  OUTPUT/INPUT 모듈 전체를 대신 표시하고 "화면번호로 모듈을 매칭하지 못했다"는 안내를 띄웁니다).
- `SET PF-STATUS`/`SET TITLEBAR` 이름, PAI의 `CASE sy-ucomm`/`WHEN` 절에서 뽑은 기능코드 목록.
- `SET TITLEBAR 'xxx' WITH v1 v2` 의 `&1`/`&2` 자리는 실제 런타임 값을 알 수 없으므로 `«v1»`처럼 변수명
  자체를 표시합니다(값이 아니라 "이 자리에 이 변수가 들어간다"는 안내).
- 로컬 클래스 `on_toolbar` 이벤트의 ALV 툴바 버튼(function/icon/text/quickinfo) — 아이콘은 실측된 일부
  상수(`icon_create` 등)만 이모지로 근사 표시하고, 매핑이 없으면 텍스트만 표시합니다
  (`lib/cbo-precheck/sapStandardSymbols.js`의 `ICON_GLYPHS`).
- ALV fieldcatalog 컬럼 — 기존 두 패턴(APPEND 루프, `VALUE #( ( ... ) )` 생성자)에 더해, 필드카탈로그
  워크에어리어를 채우는 헬퍼 FORM에 `PERFORM <form> USING '필드명' '텍스트' 길이 ...`처럼 리터럴을 넘기는
  세 번째 관용구(0Program 실제 프로그램에서 흔한 패턴)도 인식합니다. `cl_gui_alv_grid` 타입 참조가
  있으면 ALV 그리드가 있는 화면으로 판단합니다(컨테이너 구현 클래스는 `cl_gui_custom_container`/
  `cl_gui_docking_container` 등 무엇이든 무방 — 하드코딩하지 않음).

**소스에 없어 재현하지 않는 것(각 화면 렌더 영역에 안내 문구로 명시됨)**:
- Screen Flow Logic(`PROCESS BEFORE OUTPUT.`/`PROCESS AFTER INPUT.`) — Screen 객체에 별도 저장되므로
  `.abap` 소스만으로는 얻을 수 없습니다.
- Screen Painter 픽셀 레이아웃(필드 위치/크기) — 실제 화면과 배치가 다를 수 있습니다.

`CALL SCREEN`이 없는 프로그램(Selection Screen만 있는 경우)은 기존과 동일하게 동작합니다(회귀 없음).

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
해당 테이블의 DDIC 정의(abapGit TABL XML)가 있어야 합니다. 두 가지 방법이 있습니다.

### 방법 1 — abapGit TABL XML 직접 export

1. SAP GUI에서 `SE11` → 대상 테이블(예: `QALS`, `QAMV`, `QPMK`, `QAVE`) 조회.
2. [abapGit](https://abapgit.org)로 해당 테이블을 `.tabl.xml`로 export(예: `ddic/qals.tabl.xml`).
3. 저장소의 스캔 대상 폴더(스캔 시 지정한 `path`) 아래 `ddic/` 폴더에 커밋.
4. 이후 스캔부터 자동으로 인식됩니다(파일명이 `*.tabl.xml`/`*.dtel.xml`/`*.doma.xml`/`*.ttyp.xml`/`*.shlp.xml`/`*.view.xml` 패턴이면 인식).

### 방법 2 — `dictionary/*.md` · `dictionary/*.html` 문서 자동 인식(신규)

abapGit export 없이도, 저장소에 이미 있는 사람이 읽는 DDIC 문서(예: `0Program`의
`<프로그램폴더>/dictionary/ZAQMT0132.md`, `dictionary/zaqmt0100.html`)를 그대로 두면 스캔 시 자동으로
합성 DDIC 정보로 변환되어 적용됩니다 — **문서 파일 자체는 전혀 수정되지 않습니다.**

- 인식 대상: 저장소 어느 깊이든 `dictionary/` 폴더 아래의 `.md` 또는 `.html`(`.htm`) 파일 중, 문서가
  "DDIC Table" 정의(마크다운 `# DDIC Table: <이름>` 헤더 또는 HTML `테이블명`/`테이블 필드` 표)를 담고
  있는 경우만 대상입니다. Lock Object/Message Class 문서(예: `EZAQM0130.md`, `ZCQMM1.md`)처럼 필드 표가
  없는 문서는 자동으로 건너뜁니다.
- 표에서 `Field`/`Key`/`Data Element`/`Type`/`Len` 열을 읽어 abapGit TABL XML과 동일한 구조
  (`DD02V`/`DD09L`/`DD03P_TABLE`)로 합성한 뒤, 스캔 시에만 메모리 상에서 Registry에 추가합니다(실제
  `ddic/` 폴더에 파일을 쓰지 않음 — 저장소에도, 스캔 결과에도 흔적이 남지 않습니다).
- **이미 방법 1의 실제 `ddic/*.tabl.xml`이 있는 테이블은 그 파일이 항상 우선**합니다(같은 테이블명이면
  문서 기반 합성을 건너뜀 — 충돌 방지).
- **문서를 곧이곧대로 신뢰합니다.** `dictionary/` 문서에 실제 테이블과 다른 필드명이 적혀 있으면(오래되어
  갱신되지 않은 문서 등), abaplint가 그 잘못된 필드명을 실재하는 것으로 인식해 오히려 실제 오탈자를
  놓칠 수 있습니다(false negative) — 방법 1(실제 SAP에서 export)보다 신뢰도가 낮은 트레이드오프입니다.
  중요한 저장소는 주기적으로 방법 1로 교체하는 것을 권장합니다.
- 실측(2026-07-14, `git@github.com:yesblue0342-bit/0Program.git`의
  `260707_QM023_ZAQMR0130`): `dictionary/ZAQMT0130.md`/`ZAQMT0131.md`/`ZAQMT0132.md` 문서만으로 해당
  테이블 필드 참조의 `unknown_types` 오탐이 **전부 해소**됨을 실제 스캔으로 확인했습니다(상세 수치는
  `WORK_REPORT.md`/`TEST_RESULTS.md` 참고). 저장소에 문서조차 없는 테이블(예: `ZACMS0005`)은 방법 1로
  export하거나 `dictionary/` 문서를 추가해야 해소됩니다.

DDIC XML/dictionary 문서 둘 다 없어도 스캔 자체는 정상 동작하며, 이 경우 `check_ddic`/DDIC 필드 참조
검증만 건너뜁니다(다른 룰은 그대로 적용).

## 알려진 한계

- **저장소에 DDIC XML도 `dictionary/` 문서도 없는 커스텀 테이블은 "찾을 수 없음"으로 계속 보고됩니다.**
  방법 1/2 어느 쪽으로도 정의되지 않은 Z테이블을 참조하면 abaplint가 진짜 결함처럼 보고합니다 — 이 도구가
  SAP 시스템 전체 DDIC에 접근할 수 없어서 생기는 기대된 한계입니다("DDIC 정의 넣는 법" 절 참고, 방법
  1(export) 또는 방법 2(`dictionary/` 문서 추가) 중 하나로 넣으면 해소됩니다). `ICON` 등 SAP 표준
  타입풀 상수는 이 한계와 무관합니다 — "SAP 표준 심볼(TYPE-POOLS) 오탐 제거" 절 참고, 별도 해법으로
  이미 해소되어 있습니다.
- **런타임 오류·권한·인터페이스·성능은 검증하지 않습니다.** abaplint는 정적 분석 도구이며, 실제 SAP
  런타임에서만 드러나는 문제(권한 부족, BAdI/사용자exit 동작, DB 락, 성능)는 이 도구의 범위 밖입니다.
- **화면 미리보기의 `TEXT-xxx` 라벨은 같은 폴더의 `_TEXTS.txt` 문서가 있어야 실제 텍스트로 치환됩니다**
  (위 "TEXT 라벨 자동 치환" 절 참고). 문서가 없거나 인식 못 하는 형식(예: `EN:`/`KO:` 산문형)이면 SAP
  텍스트 풀(`SE38`의 텍스트 심볼)을 소스 코드만으로는 해석할 수 없어 심볼명/변수명을 그대로 표시합니다 —
  SAP GUI와 픽셀 단위로 동일하지는 않지만, 개발자가 화면 구조와 라벨을 읽고 이해하는 데는 충분합니다.
- **INCLUDE 병합은 같은 폴더 안에서만 형제 파일을 찾습니다.** 다른 폴더에 흩어진 INCLUDE는 대상이
  아닙니다(0Program 저장소의 `_abap/` 단일 폴더 관례 전제).
- **ALV fieldcatalog 인식은 세 가지 패턴만 지원합니다**: `APPEND` 루프 방식, `VALUE #( ( ... ) )` 생성자
  방식, `PERFORM <헬퍼FORM> USING '필드' '텍스트' 길이 ...` 리터럴 전달 방식(Phase 3, "Dynpro Screen 렌더링과
  한계" 절 참고). `cl_salv_table` 자동 컬럼 추정(SELECT 필드 목록 기반)은 정확도가 낮아 v1에서 제외했습니다
  — 필요시 후속 작업으로 추가할 수 있습니다.
- **Dynpro Screen의 Screen Flow Logic과 Screen Painter 픽셀 레이아웃은 재현하지 않습니다** — 소스에
  없는 정보입니다("Dynpro Screen 렌더링과 한계" 절 참고).
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
