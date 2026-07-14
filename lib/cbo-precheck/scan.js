// lib/cbo-precheck/scan.js — abaplint 라이브러리(@abaplint/core) 프로그래매틱 스캔 엔진.
//
// CLI spawn 대신 라이브러리 직접 호출(GATE 1 요구사항) — 오류 처리·유닛 테스트가 쉽고 프로세스 오버헤드가 없다.
//
// 룰 이름 보정(WORK_REPORT.md Phase 1 기록 참고):
//   - `check_ddic` 은 DDIC 오브젝트 "자신"의 타입 정의만 검사한다(TABL/DOMA/DTEL 등). ABAP 소스에서
//     `TYPE qals-존재하지않는필드` 처럼 DDIC 필드를 잘못 참조하는 건 `unknown_types` 룰이 잡는다.
//   - `check_variables` 는 이 abaplint 버전에 존재하지 않는 룰 키다. 미선언 변수 참조는 `check_syntax`(SyntaxLogic
//     예외를 이슈로 변환하는 룰)가 잡는다.
//   - abaplint `unused_variables` 룰은 설계상 "같은 오브젝트에 다른 syntax 오류가 있으면 보고하지 않는다"
//     (rules/unused_variables.js: syntax.issues.length > 0 → return []). 따라서 미선언 변수 오류가 있는 파일에서는
//     미사용 변수가 동시에 보고되지 않는다 — abaplint 자체 설계이며 이 모듈의 버그가 아니다.
import abaplint from "@abaplint/core";

const { Config, MemoryFile, Registry, Severity } = abaplint;

// GATE 1 §3 fixture 기준으로 실측 검증된 룰 집합.
export const RULES = Object.freeze({
  check_ddic: true,
  unknown_types: true,
  sql_escape_host_variables: true,
  unused_variables: true,
  obsolete_statement: true,
  check_syntax: true,
  "7bit_ascii": false,
});

export function buildConfig({ errorNamespace = "^(Z|Y)", version = "v755", rules = RULES } = {}) {
  return {
    global: {
      files: "/src/**/*.*",
      skipGeneratedGatewayClasses: true,
      skipGeneratedPersistentClasses: true,
      skipGeneratedFunctionGroups: true,
      skipGeneratedProxyClasses: true,
      skipGeneratedProxyInterfaces: true,
      skipGeneratedBOPFInterfaces: true,
    },
    dependencies: [],
    syntax: { version, errorNamespace, globalConstants: [], globalMacros: [], ambigiousVoids: [] },
    rules,
  };
}

function normalizeSeverity(severity) {
  if (severity === Severity.Error) return "Error";
  if (severity === Severity.Warning) return "Warning";
  return "Info";
}

function normalizeIssue(issue) {
  const start = issue.getStart();
  const fix = issue.getDefaultFix();
  // fix 는 { [filename]: Edit[] } 형태 — 이 이슈가 속한 파일의 edit 배열만 보관(다른 파일까지 걸치는
  // fix는 자동 PR 대상에서 제외해 단일 파일 splice 로직을 단순하게 유지한다).
  const edits = fix && fix[issue.getFilename()];
  return {
    file: issue.getFilename(),
    line: start.getRow(),
    col: start.getCol(),
    severity: normalizeSeverity(issue.getSeverity()),
    rule: issue.getKey(),
    message: issue.getMessage(),
    quickfixAvailable: !!(edits && edits.length),
    fixEdits: edits && edits.length ? edits : null,
  };
}

// files: [{ name, content }] — ABAP 소스(.abap) + DDIC XML(.xml) 전부 여기로 전달.
// scan 대상이 아닌 DDIC/의존성 파일도 같은 Registry 에 추가해야 타입 해석이 된다.
export function scanFiles({ files, config } = {}) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return { issues: [], fileCount: 0 };

  const reg = new Registry(new Config(JSON.stringify(config || buildConfig())));
  for (const f of list) {
    reg.addFile(new MemoryFile(f.name, f.content));
  }

  const scannedNames = new Set(list.filter((f) => isScannable(f.name)).map((f) => f.name));
  const issues = reg.findIssues()
    .map(normalizeIssue)
    .filter((issue) => scannedNames.has(issue.file));

  issues.sort((a, b) => {
    const sevOrder = { Error: 0, Warning: 1, Info: 2 };
    if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });

  return { issues, fileCount: scannedNames.size };
}

// DDIC XML(.tabl.xml 등)이나 abapGit 메타(.abapgit.xml, package.devc.xml)는 "스캔 대상"이 아니라
// 타입 해석용 컨텍스트일 뿐이므로 결과 목록에서 제외한다(ABAP 소스 파일만 이슈로 노출).
// `.abap` 로 끝나는 파일이면 전부 대상 — abapGit 네이밍(.prog.abap/.clas.abap/.fugr.*.abap 등)뿐 아니라
// `ZAQMR0130.abap`처럼 단순 확장자만 쓰는 저장소(0Program `_abap/` 관례)도 인식해야 한다.
export function isScannable(name) {
  return isAbapSource(name);
}

export function isDdicXml(name) {
  return /\.(tabl|dtel|doma|ttyp|shlp|view)\.xml$/i.test(String(name || ""));
}

export function isAbapSource(name) {
  return /\.abap$/i.test(String(name || ""));
}
