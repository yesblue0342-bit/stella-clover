# LESSONS — 재발 방지 기록

동일 오류를 2번 이상 만났을 때만 기록한다(1회성 실수는 기록하지 않음).

## 2026-07-14 — abaplint 룰 이름은 문서/직관이 아니라 `ArtifactsRules.getRules()` 실측으로 확정한다

**증상**: CBO Pre-Check 미션 문서(`PROMPT_CBO_PRECHECK_260714.md`)가 지정한 룰 이름 중 `check_variables`는
`@abaplint/core@2.119.66`에 아예 존재하지 않는 키였고(`ArtifactsRules.getRules()`에 없음, `.find()` →
`undefined`), `check_ddic`은 이름과 달리 "DDIC 오브젝트 자신의 정의"만 검사할 뿐 "ABAP 소스에서 DDIC 필드를
잘못 참조하는 경우"는 검사하지 않았다(그 케이스는 `unknown_types`가 담당). 룰 이름만 보고 추측해서 설정하면
그 룰이 조용히 아무것도 잡지 못하거나(`unknown rule key` 무시), 의도와 다른 걸 검사한다.

**원인**: SAP/abaplint 생태계 문서·블로그의 룰 이름 표기가 실제 npm 패키지 버전별 룰 키와 어긋날 수 있다.
설정 객체에 존재하지 않는 룰 키를 넣어도 abaplint는 에러 없이 그냥 무시한다(무음 실패) — 그래서 "설정했는데
왜 안 잡히지"를 스캔 결과가 텅 빈 채로 알아차리기 쉽다.

**방지책**: 새 abaplint 룰을 설정에 추가할 때는 항상 다음을 스캔 코드 작성 **전에** 먼저 한다.
1. `node -e "console.log(require('@abaplint/core').ArtifactsRules.getRules().map(r=>r.getMetadata().key))"`
   로 실제 룰 키 목록을 확인한다(문서의 이름과 대조).
2. 실제로 검출하고 싶은 시나리오를 최소 fixture로 만들어 `Registry.findIssues()`를 실행해 어떤 `getKey()`가
   나오는지 실측한다(원하는 이름이 아니라 실제로 나온 이름을 신뢰한다).
3. 여러 이슈를 "한 파일에서 동시에" 검출하고 싶다면, 그중 하나가 `SyntaxLogic`을 throw 시키는 종류(미선언
   식별자 등)가 아닌지 확인한다 — `unused_variables`처럼 "다른 syntax 오류가 있으면 조용히 스킵"하는 룰이
   있다(WORK_REPORT.md "CBO Pre-Check" 섹션 참고). 필요하면 격리된 샘플로 룰별로 나눠 검증한다.

**참고**: 관련 상세 근거는 `WORK_REPORT.md`의 "CBO Pre-Check — 작업 보고 → Phase 1" 절 참고.

## 2026-07-14 — "완료 보고"와 실제 배포 동작이 달랐다: GATE에 실제 환경 검증을 넣지 않으면 재발한다

**증상**: 8번 미션(`stella_clover_260714_8.md`)이 GATE를 전부 통과했다며 `RALPH_DONE`을 커밋했지만,
배포된 실제 앱에서는 세 가지 목표(SAP 표준 심볼 오탐 제거, 미리보기 폴더 경로 지원, Dynpro Screen 렌더링)
**전부 미구현 상태였다.** 사용자가 배포 후 직접 확인하고서야 드러났다 — 이 프로젝트에서 "AI가 완료를
보고했지만 실제로는 동작하지 않았다"는 유형의 문제가 2회 이상 반복됐다(과거 `CACHE` 버전 미갱신으로 인한
캐시 문제, 이번 CBO Pre-Check 미구현 등).

**원인**: 8번 미션은 코드 리뷰·유닛 테스트·fixture 통과만으로 GATE를 통과시켰고, "실제 대상 저장소를
clone해 실제 UI 흐름대로 재현"하는 단계가 없었다. `README_CBO_PRECHECK.md`에 스스로 "icon_create 등...
진짜 결함처럼 보고합니다"라고 알려진 한계로 적어두고도, 그 문장이 "구현 안 함"의 증거라는 걸 놓쳤다 —
문서화된 한계와 미해결 버그를 구분하지 못하면 "기록은 했으니 인지는 하고 있다"는 착각으로 GATE를
통과시키게 된다.

**방지책**:
1. **GATE 통과 기준에 "실제 최종 산출물(배포된 앱 또는 그와 동일한 코드 경로)로 재현"을 반드시 포함한다.**
   fixture/mock 테스트가 전부 녹색이어도 그것만으로 완료를 선언하지 않는다 — 이번 재작업은 GATE마다
   실제 `git@github.com:yesblue0342-bit/0Program.git`을 SSH clone해 API 핸들러(`handler()`)를 직접
   호출하는 라이브 통합 테스트를 추가해 고정했다(`test/cbo-precheck-dynpro.test.js`,
   `test/cbo-precheck-preview-direct.test.js`의 "GATE" 표시 테스트들).
2. **"README/주석에 한계로 적어뒀다"는 "의도적으로 미룬 것"과 "잊어버린 것"을 구분해 기록한다.** 전자면
   왜 미뤘는지 근거가 있어야 하고, 후자라면 다음 세션이 바로 알아챌 수 있도록 명시적으로 "미구현"이라고
   써야 한다 — 애매하게 "기대된 한계"라고만 적으면 다음 세션도 "이미 검토된 것"으로 오인하고 넘어간다.
3. **재작업 미션을 받으면 "이미 되어 있다"고 판단하기 전에 반드시 실제 코드를 열어 확인한다** — 이전
   세션의 보고를 신뢰하지 않고 코드 자체를 근거로 삼는다(`stella_clover_260714_9.md` Phase 0의 명시적
   규칙과 동일한 원칙).

**참고**: 상세 근거는 `WORK_REPORT.md`의 "2026-07-14 '8번 미션 실패 재작업' 세션" 절(결론 요약 + Phase 0)
참고.
