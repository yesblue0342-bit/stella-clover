// lib/cbo-precheck/scan.js — abaplint 라이브러리(@abaplint/core) 프로그래매틱 스캔 엔진.
//
// CLI spawn 대신 라이브러리 직접 호출(GATE 1 요구사항) — 오류 처리·유닛 테스트가 쉽고 프로세스 오버헤드가 없다.
//
// 네이밍 어댑터(WORK_REPORT.md 2026-07-14 Phase 0/1 세션 참고, architect 검증으로 근본 원인 서술 정정):
//   abaplint(@abaplint/core `registry.js` `_addFiles()`)는 파일명을 "."으로 split했을 때 조각이 2개
//   이하(`isNotAbapgitFile = filename.split(".").length <= 2`)면 그 파일을 **오브젝트로 등록조차 하지
//   않고 continue로 완전히 건너뛴다**(`UnknownObject`로 떨어지는 게 아니라 애초에 Registry에 안 들어감
//   — `AbstractFile.getObjectType()`가 파일명 두 번째 조각을 대문자 타입으로 쓰는 것도 사실이지만,
//   그 이전에 이 조각 수 검사에서 먼저 걸러진다). `ZAQMR0130.abap`은 split 결과 2조각이라 이 조건에
//   걸려 스캔에서 완전히 사라진다 — **항상 이슈 0건**이 나온다(실측: 440건 vs 0건, 코드가 깨끗해서가
//   아니라 이 필터에 조용히 걸러진 것). `virtualizeFiles()`가 이런 파일을 스캔 직전 가상 abapGit
//   파일명(`<원본>.prog.abap`/`.clas.abap`, 3조각 이상)으로만 매핑해 Registry에 넘기고, 결과의
//   `issue.file`은 다시 원본 파일명으로 역치환한다 — 실제 디스크/메모리 사본은 만들지 않고 Registry
//   안에서만 이름을 바꾸므로(기존 MemoryFile 기반 인메모리 구조 재사용) 정리할 임시 디렉토리 자체가
//   없다.
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

// 이미 abapGit 정식 네이밍(.prog.abap/.clas.abap/.intf.abap/.fugr.*.abap)인지 — 맞으면 어댑터를 거치지
// 않고 그대로 둔다(기존 정상 동작 회귀 방지).
export function isAbapGitNamed(name) {
  return /\.(prog|clas|intf|fugr)\.[\w.]*abap$/i.test(String(name || ""));
}

function stripComments(content) {
  return String(content || "").split("\n").filter((l) => !/^\s*\*/.test(l)).join("\n");
}

// REPORT/PROGRAM 문이 있으면 메인 프로그램, 없으면 INCLUDE(어댑터가 남 프로그램 스코프에 편입시켜야
// 하는 대상) — detectAbapGitType()과 virtualizeFiles()의 include-XML 판단이 이 하나의 규칙을 공유한다.
function hasReportStatement(content) {
  return /(^|\n)\s*(REPORT|PROGRAM)\s+\S/i.test(stripComments(content));
}

// 오브젝트 타입 판별 — 실측(WORK_REPORT.md): REPORT/PROGRAM 문이 있으면 prog, `CLASS x DEFINITION PUBLIC`
// 처럼 클래스 레벨 PUBLIC 속성이 붙은(독립 컴파일 가능한 글로벌 클래스로 보이는) 경우만 clas, 그 외
// (TOP/F01/I01/O01/S01 같은 INCLUDE, `CLASS lcl_x DEFINITION.` 형태의 로컬 클래스)는 실제 0Program
// 저장소에서 전부 prog로 등록돼야 INCLUDE 관계·로컬 클래스의 리포트 전역 변수 참조가 정상 해석됨을
// 확인했다 — 기본값도 prog.
// preview.js(단일 파일 미리보기)도 동일한 타입 판별이 필요해 export한다.
export function detectAbapGitType(content) {
  if (hasReportStatement(content)) return "prog";
  if (/\bCLASS\s+\S+\s+DEFINITION\s+PUBLIC\b/i.test(stripComments(content))) return "clas";
  return "prog";
}

// abapGit은 REPORT/PROGRAM 프로그램의 include를 오브젝트 메타(`.prog.xml`)의 `<SUBC>I</SUBC>`로 표시한다.
// abaplint(Program.isInclude())는 이 플래그로만 "이 오브젝트는 include"를 판단하고, include로 인식된
// 오브젝트만 메인 프로그램(INCLUDE 문으로 참조하는 쪽)의 전역 스코프에 편입시켜 교차 참조를 해석한다.
// 실측: 이 XML 없이 8개 파일을 그대로(REPORT 문 없는 파일도 독립 오브젝트로) 넣으면 TOP에 선언된
// 변수를 F01/CLS가 "not found"로 오탐한다(440건 중 상당수가 이 오탐) — XML을 붙이면 진짜 결함만 남는다.
// REPORT/PROGRAM 문이 있는 파일(메인 프로그램)에는 이 메타를 붙이지 않는다(SUBC 기본값 실행프로그램).
function includeMetaXml() {
  return '<?xml version="1.0" encoding="utf-8"?>\n<abapGit version="v1.0.0" serializer="LCL_OBJECT_PROG" serializer_version="v1.0.0">\n' +
    ' <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">\n  <asx:values>\n' +
    "   <PROGDIR><SUBC>I</SUBC></PROGDIR>\n  </asx:values>\n </asx:abap>\n</abapGit>";
}

// abapGit 네이밍이 아닌 .abap 파일 하나의 가상 파일명(원본 디렉토리 유지, 베이스네임만
// `<원본>.<타입>.abap`)을 계산한다. abapGit 네이밍이면 원본 그대로 반환(어댑터 미적용). 실제 사본은
// 만들지 않음 — 호출부는 이 이름만 Registry에 넘긴다. preview.js(단일 파일 미리보기)도 재사용한다.
export function virtualizeName(name, content) {
  if (!isAbapSource(name) || isAbapGitNamed(name)) return name;
  const lastSlash = name.lastIndexOf("/");
  const dir = lastSlash >= 0 ? name.slice(0, lastSlash + 1) : "";
  const base = name.slice(lastSlash + 1).replace(/\.abap$/i, "");
  return `${dir}${base}.${detectAbapGitType(content)}.abap`;
}

// 배치 스캔용: 목록 전체를 가상 이름으로 매핑하고, prog 타입인데 REPORT/PROGRAM 문이 없는 파일
// (=include)에는 가상 `.prog.xml`을 함께 등록한다(cross-include 교차참조 해석용).
function virtualizeFiles(list) {
  const virtualByOriginal = new Map();
  const originalByVirtual = new Map();
  const virtualXml = [];
  for (const f of list) {
    const virtualName = virtualizeName(f.name, f.content);
    // 같은 폴더에 plain 네이밍 파일과 이미 그 가상 이름과 동일한 abapGit 네이밍 파일이 함께 있으면
    // Registry에서 같은 오브젝트로 합쳐져 한쪽 내용이 사라진다(architect 검증 지적) — 조용히 덮어쓰지
    // 않고 명확한 오류로 막는다(혼용 네이밍 저장소는 이번 범위 밖, 발견 시 사용자가 직접 정리해야 함).
    if (originalByVirtual.has(virtualName)) {
      throw new Error(`파일명 충돌: "${f.name}"과 "${originalByVirtual.get(virtualName)}"가 같은 abapGit 오브젝트("${virtualName}")로 매핑됩니다. 두 파일 중 하나의 이름을 바꿔주세요.`);
    }
    virtualByOriginal.set(f.name, virtualName);
    originalByVirtual.set(virtualName, f.name);
    if (virtualName !== f.name && virtualName.endsWith(".prog.abap") && !hasReportStatement(f.content)) {
      virtualXml.push(virtualName.replace(/\.abap$/i, ".xml"));
    }
  }
  return { virtualByOriginal, originalByVirtual, virtualXml };
}

// files: [{ name, content }] — ABAP 소스(.abap) + DDIC XML(.xml) 전부 여기로 전달.
// scan 대상이 아닌 DDIC/의존성 파일도 같은 Registry 에 추가해야 타입 해석이 된다.
export function scanFiles({ files, config } = {}) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return { issues: [], fileCount: 0 };

  const { virtualByOriginal, originalByVirtual, virtualXml } = virtualizeFiles(list);

  const reg = new Registry(new Config(JSON.stringify(config || buildConfig())));
  for (const f of list) {
    reg.addFile(new MemoryFile(virtualByOriginal.get(f.name), f.content));
  }
  for (const xmlName of virtualXml) {
    reg.addFile(new MemoryFile(xmlName, includeMetaXml()));
  }

  const scannedNames = new Set(list.filter((f) => isScannable(f.name)).map((f) => f.name));
  const issues = reg.findIssues()
    .map(normalizeIssue)
    .map((issue) => ({ ...issue, file: originalByVirtual.get(issue.file) ?? issue.file }))
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
