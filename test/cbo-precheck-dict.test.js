import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseMarkdownDict, parseHtmlDict, parseDictDoc, isDictionaryDoc,
} from "../lib/cbo-precheck/dictParser.js";
import { dictToTablXml } from "../lib/cbo-precheck/dictToTabl.js";
import { scanFiles } from "../lib/cbo-precheck/scan.js";
import { collectAbapFiles, withClonedRepo } from "../lib/cbo-precheck/repoFetch.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const md = fs.readFileSync("fixtures/dictionary/ZDEMOT001.md", "utf8");
const html = fs.readFileSync("fixtures/dictionary/zdemot002.html", "utf8");
const lockMd = fs.readFileSync("fixtures/dictionary/ZDEMOLOCK.md", "utf8");
const ddic = fs.readFileSync("fixtures/ddic/qals.tabl.xml", "utf8");

test("isDictionaryDoc: dictionary/ 하위 .md·.html만 인식하고 그 외는 false", () => {
  assert.ok(isDictionaryDoc("dictionary/ZDEMOT001.md"));
  assert.ok(isDictionaryDoc("some/nested/dictionary/x.html"));
  assert.ok(!isDictionaryDoc("dictionary/qals.tabl.xml"));
  assert.ok(!isDictionaryDoc("_abap/ZAQMR0130.abap"));
  assert.ok(!isDictionaryDoc("ZDEMOT001.md"), "dictionary/ 폴더 밖이면 대상 아님");
});

test("parseMarkdownDict: DDIC Table 표를 필드 배열로 정확히 파싱한다", () => {
  const dict = parseMarkdownDict(md);
  assert.equal(dict.tableName, "ZDEMOT001");
  assert.equal(dict.deliveryClass, "A");
  assert.equal(dict.fields.length, 4);
  assert.deepEqual(dict.fields.map((f) => f.name), ["MANDT", "RUNID", "WERKS", "STATUS"]);
  assert.deepEqual(dict.fields.filter((f) => f.key).map((f) => f.name), ["MANDT", "RUNID"]);
  const werks = dict.fields.find((f) => f.name === "WERKS");
  assert.equal(werks.type, "CHAR");
  assert.equal(werks.len, 4);
  assert.equal(werks.rollname, "WERKS_D");
  const status = dict.fields.find((f) => f.name === "STATUS");
  assert.equal(status.rollname, "ZDE_DEMO_FLAG", "괄호 폴백 표기는 제거하고 주 데이터 엘리먼트만 취한다");
});

test("parseHtmlDict: '테이블 필드' HTML 표를 정확히 파싱한다(메타 표와 혼동하지 않음)", () => {
  const dict = parseHtmlDict(html);
  assert.equal(dict.tableName, "ZDEMOT002");
  assert.equal(dict.deliveryClass, "A");
  assert.equal(dict.fields.length, 4);
  assert.deepEqual(dict.fields.filter((f) => f.key).map((f) => f.name), ["MANDT", "RUNID", "SEQNR"]);
  const matnr = dict.fields.find((f) => f.name === "MATNR");
  assert.equal(matnr.type, "CHAR");
  assert.equal(matnr.len, 40);
});

test("parseDictDoc: DDIC Table 헤더가 없는 문서(Lock Object)는 null", () => {
  assert.equal(parseDictDoc("dictionary/ZDEMOLOCK.md", lockMd), null);
});

test("parseDictDoc: 확장자로 md/html 파서를 올바르게 분기한다", () => {
  assert.equal(parseDictDoc("dictionary/ZDEMOT001.md", md).tableName, "ZDEMOT001");
  assert.equal(parseDictDoc("dictionary/zdemot002.html", html).tableName, "ZDEMOT002");
});

test("dictToTablXml: abapGit TABL XML 스키마(DD02V/DD09L/DD03P_TABLE)로 생성된다", () => {
  const dict = parseMarkdownDict(md);
  const xml = dictToTablXml(dict);
  assert.match(xml, /<TABNAME>ZDEMOT001<\/TABNAME>/);
  assert.match(xml, /<FIELDNAME>WERKS<\/FIELDNAME>/);
  assert.match(xml, /<DATATYPE>CHAR<\/DATATYPE>/);
  assert.match(xml, /<LENG>000004<\/LENG>/);
  assert.match(xml, /<KEYFLAG>X<\/KEYFLAG>/);
});

test("dictToTablXml: fields가 없으면 명확한 오류를 던진다", () => {
  assert.throws(() => dictToTablXml({ tableName: "X", fields: [] }));
  assert.throws(() => dictToTablXml(null));
});

// architect 검증 후속 권고 1: 문서 필드에 XML 특수문자가 섞여도 이스케이프되어 태그가 깨지지 않아야 한다
// (dictionary 문서는 클론된 저장소의 제3자 콘텐츠 — 신뢰할 수 없는 입력으로 취급).
test("dictToTablXml: 설명/데이터 엘리먼트에 XML 특수문자가 있어도 이스케이프되어 유효한 XML로 남는다", () => {
  const dict = {
    tableName: "ZDEMOT003",
    ddtext: "Demo <script>&\"quote\"",
    deliveryClass: "A",
    fields: [
      { name: "MANDT", key: true, rollname: "MANDT", type: "CLNT", len: 3 },
      { name: "FLAG", key: false, rollname: 'A&B<C>"D"', type: "CHAR", len: 1 },
    ],
  };
  const xml = dictToTablXml(dict);
  assert.ok(!/<script>/.test(xml), "이스케이프되지 않은 <script> 태그가 그대로 남으면 안 됨");
  assert.match(xml, /<DDTEXT>Demo &lt;script&gt;&amp;&quot;quote&quot;<\/DDTEXT>/);
  assert.match(xml, /<ROLLNAME>A&amp;B&lt;C&gt;&quot;D&quot;<\/ROLLNAME>/);
  // 각 태그가 정확히 한 쌍(열기/닫기)만 있는지 - 이스케이프 실패로 태그가 추가 생성되지 않았는지 확인.
  assert.equal((xml.match(/<DD03P>/g) || []).length, 2);
  assert.equal((xml.match(/<\/DD03P>/g) || []).length, 2);
});

// ── scanFiles 통합: dictionary 문서만으로 unknown_types가 해소되는지 실제 스캔으로 확인 ──

test("scanFiles: dictionary/*.md 문서만 있어도 해당 테이블 필드 참조가 unknown_types 없이 해석된다", () => {
  const abap = `REPORT ztest.
DATA: lv_werks TYPE zdemot001-werks,
      lv_status TYPE zdemot001-status,
      lv_bogus TYPE zdemot001-nonexistent_field.
`;
  const files = [
    { name: "ztest.prog.abap", content: abap },
    { name: "dictionary/ZDEMOT001.md", content: md },
  ];
  const { issues } = scanFiles({ files });
  const unknownTypes = issues.filter((i) => i.rule === "unknown_types");
  assert.equal(unknownTypes.length, 1, "실제 존재하지 않는 필드만 unknown_types로 남아야 함");
  assert.match(unknownTypes[0].message, /NONEXISTENT_FIELD/);
});

test("scanFiles: dictionary/*.html 문서로도 동일하게 unknown_types가 해소된다", () => {
  const abap = `REPORT ztest2.
DATA: lv_matnr TYPE zdemot002-matnr,
      lv_seqnr TYPE zdemot002-seqnr.
`;
  const files = [
    { name: "ztest2.prog.abap", content: abap },
    { name: "dictionary/zdemot002.html", content: html },
  ];
  const { issues } = scanFiles({ files });
  assert.equal(issues.filter((i) => i.rule === "unknown_types").length, 0);
});

test("scanFiles: dictionary 문서는 결과(issues)에 스캔 대상 파일로 노출되지 않는다", () => {
  const abap = `REPORT ztest3.\nDATA lv_x TYPE zdemot001-werks.\n`;
  const files = [
    { name: "ztest3.prog.abap", content: abap },
    { name: "dictionary/ZDEMOT001.md", content: md },
  ];
  const { issues, fileCount } = scanFiles({ files });
  assert.equal(fileCount, 1, "dictionary 문서는 fileCount에 포함되지 않는다");
  assert.ok(issues.every((i) => i.file !== "dictionary/ZDEMOT001.md"));
});

test("scanFiles: 실제 ddic/*.tabl.xml이 이미 있는 테이블은 dictionary 합성이 덮어쓰지 않는다(충돌 방지)", () => {
  // qals.tabl.xml은 QALS 테이블(PRUEFLOS/MATNR/WERK)만 정의 — 같은 테이블명의 dictionary 문서를
  // 함께 넣어도 실제 XML이 존재하면 합성을 건너뛰어 Registry 중복 등록 오류가 나지 않아야 한다.
  const qalsDictMd = `# DDIC Table: QALS — 합성 시도 금지 대상 (실제 XML 존재)

**Type:** Transparent Table (CBO) · **Package:** ZZ · **Delivery Class:** A

| # | Field | Key | Data Element | Type | Len | Description |
|---|-------|-----|--------------|------|-----|-------------|
| 1 | MANDT | X | MANDT | CLNT | 3 | Client |
| 2 | PRUEFLOS | X | QPRUEFLOS | CHAR | 12 | Lot |

Key: MANDT+PRUEFLOS.
`;
  const abap = `REPORT ztest4.\nDATA lv_x TYPE qals-werk.\n`;
  const files = [
    { name: "ztest4.prog.abap", content: abap },
    { name: "ddic/qals.tabl.xml", content: ddic },
    { name: "dictionary/QALS.md", content: qalsDictMd },
  ];
  assert.doesNotThrow(() => scanFiles({ files }));
  const { issues } = scanFiles({ files });
  assert.equal(issues.filter((i) => i.rule === "unknown_types").length, 0, "실제 XML의 WERK 필드로 정상 해석되어야 함");
});

// ── repoFetch 통합: dictionary 문서가 실제로 수집되고 isDict 플래그가 붙는지 ──

async function mktemp() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "cbo-precheck-dict-test-"));
}

test("collectAbapFiles: dictionary/*.md·*.html 문서를 isDict:true로 수집한다", async () => {
  const root = await mktemp();
  try {
    await fsp.mkdir(path.join(root, "dictionary"), { recursive: true });
    await fsp.writeFile(path.join(root, "dictionary", "ZDEMOT001.md"), md);
    await fsp.writeFile(path.join(root, "dictionary", "zdemot002.html"), html);
    await fsp.mkdir(path.join(root, "_abap"), { recursive: true });
    await fsp.writeFile(path.join(root, "_abap", "ZTEST.abap"), "REPORT ztest.\n");

    const files = await collectAbapFiles(root);
    const dictFiles = files.filter((f) => f.isDict);
    assert.equal(dictFiles.length, 2);
    assert.ok(dictFiles.every((f) => f.name.startsWith("dictionary/")));
    const abapFile = files.find((f) => f.name === "_abap/ZTEST.abap");
    assert.equal(abapFile.isDict, false, "ABAP 소스는 isDict가 아니어야 함");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// GATE 1 (e) — 실제 저장소 before/after 측정: dictionary 문서 합성 적용 전(dictionary 문서 제외) 대비
// 적용 후(dictionary 문서 포함) unknown_types 건수가 실제로 줄어드는지 실측 확인(추측 금지).
const LIVE_REPO = "git@github.com:yesblue0342-bit/0Program.git";
const sshEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5",
};
let sshOk = false;
try {
  await exec("git", ["ls-remote", LIVE_REPO, "HEAD"], { timeout: 8000, windowsHide: true, env: sshEnv });
  sshOk = true;
} catch { sshOk = false; }

test(
  "GATE 1 (e): 실제 260707_QM023_ZAQMR0130 — dictionary 문서 합성 적용 후 unknown_types가 실측 감소한다",
  { skip: sshOk ? false : "SSH(배포키) 접근 불가 — 네트워크 제약으로 skip" },
  async () => {
    const files = await withClonedRepo(
      { repoUrl: LIVE_REPO, branch: "main", path: "260707_QM023_ZAQMR0130" },
      (root) => collectAbapFiles(root)
    );
    const countByRule = (issues, rule) => issues.filter((i) => i.rule === rule).length;

    const withoutDict = files.filter((f) => !f.isDict);
    const before = scanFiles({ files: withoutDict });
    const after = scanFiles({ files });

    assert.equal(before.fileCount, after.fileCount, "dictionary 문서는 fileCount에 영향을 주지 않는다");
    const beforeUnknown = countByRule(before.issues, "unknown_types");
    const afterUnknown = countByRule(after.issues, "unknown_types");
    assert.ok(afterUnknown < beforeUnknown, `unknown_types가 감소해야 함(합성 전 ${beforeUnknown} → 합성 후 ${afterUnknown})`);
    // 저장소에 dictionary 문서가 있는 ZAQMT0130/0131/0132 관련 참조는 전부 해소되고, dictionary 문서가
    // 없는 ZACMS0005 참조만 기대된 잔여 한계로 남아야 한다(README_CBO_PRECHECK.md에 명시).
    assert.ok(after.issues.filter((i) => i.rule === "unknown_types").every((i) => /ZACMS0005/.test(i.message)),
      "dictionary 문서가 있는 테이블(ZAQMT013x)은 unknown_types에서 전부 사라져야 함");
  }
);
