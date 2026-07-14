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
