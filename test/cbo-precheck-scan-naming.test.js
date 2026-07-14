import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanFiles, isAbapGitNamed } from "../lib/cbo-precheck/scan.js";
import { withClonedRepo, collectAbapFiles } from "../lib/cbo-precheck/repoFetch.js";

const exec = promisify(execFile);

const bad = fs.readFileSync("fixtures/zaqmr0130_bad.prog.abap", "utf8");
const good = fs.readFileSync("fixtures/zaqmr0130_good.prog.abap", "utf8");
const ddic = fs.readFileSync("fixtures/ddic/qals.tabl.xml", "utf8");

const plainMain = fs.readFileSync("fixtures/plain-naming/PLAINMAIN.abap", "utf8");
const plainTop = fs.readFileSync("fixtures/plain-naming/PLAINMAIN_TOP.abap", "utf8");
const plainF01 = fs.readFileSync("fixtures/plain-naming/PLAINMAIN_F01.abap", "utf8");

// GATE 1 (a): 언더스코어(비abapGit) 네이밍 fixture로 스캔 → 이슈가 정상 검출된다(root cause 실측: 어댑터
// 없이는 항상 0건 — 이 fixture는 0Program 저장소의 실제 REPORT+INCLUDE 구조를 축소 재현한다).
test("GATE 1 (a): plain 네이밍(REPORT+INCLUDE) fixture 스캔 시 실제 결함이 검출된다", () => {
  const files = [
    { name: "PLAINMAIN.abap", content: plainMain },
    { name: "PLAINMAIN_TOP.abap", content: plainTop },
    { name: "PLAINMAIN_F01.abap", content: plainF01 },
    { name: "qals.tabl.xml", content: ddic },
  ];
  const { issues, fileCount } = scanFiles({ files });
  assert.equal(fileCount, 3, "DDIC XML은 fileCount에 포함되지 않는다");
  assert.ok(issues.length > 0, "언더스코어 네이밍이어도 실제 결함(check_ddic/sql_escape/obsolete_statement)이 검출되어야 한다");

  const byRule = {};
  for (const i of issues) byRule[i.rule] = (byRule[i.rule] || 0) + 1;
  assert.ok(byRule.sql_escape_host_variables >= 2, "TOP에 선언된 s_pruef/p_werks를 F01에서 참조하는 SQL host variable 이슈가 검출되어야 함(cross-include 해석 포함)");
  assert.ok(byRule.obsolete_statement >= 1, "MOVE 문 obsolete_statement 검출");
  assert.ok(!("check_syntax" in byRule), "cross-include XML 메타 덕분에 TOP 선언 변수를 F01/CLS에서 '찾을 수 없음' 오탐이 나오면 안 된다");
});

// GATE 1 (b): 결과의 file 필드는 원본 파일명이어야 한다(가상 abapGit 이름이 새어나오면 안 됨).
test("GATE 1 (b): 스캔 결과 file 필드는 원본 파일명이고 가상 이름(.prog.abap 등)이 노출되지 않는다", () => {
  const files = [
    { name: "PLAINMAIN.abap", content: plainMain },
    { name: "PLAINMAIN_TOP.abap", content: plainTop },
    { name: "PLAINMAIN_F01.abap", content: plainF01 },
    { name: "qals.tabl.xml", content: ddic },
  ];
  const { issues } = scanFiles({ files });
  assert.ok(issues.length > 0);
  const original = new Set(["PLAINMAIN.abap", "PLAINMAIN_TOP.abap", "PLAINMAIN_F01.abap"]);
  for (const i of issues) {
    assert.ok(original.has(i.file), `issue.file="${i.file}"는 원본 파일명이어야 함`);
    assert.ok(!/\.(prog|clas)\.abap$/i.test(i.file), "가상 abapGit 이름이 결과에 노출되면 안 됨");
  }
});

// GATE 1 (c): 정상 abapGit 네이밍 fixture는 어댑터를 거치지 않고 회귀 없이 그대로 동작해야 한다.
test("GATE 1 (c): 기존 abapGit 네이밍(zaqmr0130_bad.prog.abap) fixture는 회귀 없이 동일하게 5건 검출", () => {
  assert.ok(isAbapGitNamed("zaqmr0130_bad.prog.abap"));
  const { issues, fileCount } = scanFiles({
    files: [
      { name: "zaqmr0130_bad.prog.abap", content: bad },
      { name: "qals.tabl.xml", content: ddic },
    ],
  });
  assert.equal(fileCount, 1);
  assert.equal(issues.length, 5, "어댑터 도입 전과 동일하게 5건 검출되어야 함(회귀 없음)");
});

// architect 검증 지적: 같은 폴더에 plain 네이밍 파일과 그 가상 이름과 동일한 abapGit 네이밍 파일이
// 함께 있으면 Registry에서 같은 오브젝트로 합쳐져 한쪽 내용이 조용히 사라질 수 있다 — 조용히 덮어쓰지
// 않고 명확한 오류를 던지는지 확인한다.
test("virtualizeFiles: plain 네이밍 파일의 가상 이름이 기존 abapGit 네이밍 파일과 충돌하면 명확한 오류를 던진다", () => {
  assert.throws(
    () => scanFiles({
      files: [
        { name: "zaqmr0130_bad.prog.abap", content: bad },
        { name: "zaqmr0130_bad.abap", content: "REPORT zdummy.\n" },
      ],
    }),
    /파일명 충돌/
  );
});

test("GATE 1 (c): 정상 fixture(zaqmr0130_good, abapGit 네이밍)도 회귀 없이 이슈 0건", () => {
  const { issues } = scanFiles({
    files: [
      { name: "zaqmr0130_good.prog.abap", content: good },
      { name: "qals.tabl.xml", content: ddic },
    ],
  });
  assert.deepEqual(issues, []);
});

// GATE 1 (d): 임시 디렉토리를 실제로 만들지 않는 인메모리 설계 — 어댑터가 파일시스템에 어떤 흔적도
// 남기지 않는지 확인(디자인 결정: WORK_REPORT.md 참고 — 실제 mkdtemp 없이 Registry 안에서만 가상 이름 사용).
test("GATE 1 (d): scanFiles는 실제 임시 디렉토리를 만들지 않는다(인메모리 가상 네이밍)", async () => {
  const before = await fs.promises.readdir(os.tmpdir());
  scanFiles({
    files: [
      { name: "PLAINMAIN.abap", content: plainMain },
      { name: "PLAINMAIN_TOP.abap", content: plainTop },
      { name: "PLAINMAIN_F01.abap", content: plainF01 },
    ],
  });
  const after = await fs.promises.readdir(os.tmpdir());
  const newEntries = after.filter((e) => !before.includes(e) && e.startsWith("cbo-precheck"));
  assert.equal(newEntries.length, 0, "scanFiles 호출이 cbo-precheck 임시 디렉토리를 새로 만들면 안 됨");
});

// GATE 1 (e): 실제 0Program 저장소 통합 재확인 — Phase 0 결론(네이밍 문제로 조용히 스킵되고 있었음)과
// 일치하게, 어댑터 적용 후에는 실제 이슈가 검출되어야 한다(SSH 접근 불가 환경은 skip).
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
  "GATE 1 (e): 실제 260707_QM023_ZAQMR0130 통합 스캔 — 어댑터 적용 후 실제 이슈가 검출된다(Phase 0 결론 재확인)",
  { skip: sshOk ? false : "SSH(배포키) 접근 불가 — 네트워크 제약으로 skip" },
  async () => {
    const files = await withClonedRepo(
      { repoUrl: LIVE_REPO, branch: "main", path: "260707_QM023_ZAQMR0130" },
      (root) => collectAbapFiles(root)
    );
    const abapFiles = files.filter((f) => !f.isDdic);
    const { issues, fileCount } = scanFiles({ files: abapFiles });
    assert.equal(fileCount, 8);
    assert.ok(issues.length > 0, "Phase 0 실측(440건 원인 확인, XML 메타 보강 후 64건)과 일치하게 이슈가 0건이면 안 됨");
    for (const i of issues) {
      assert.ok(!/\.(prog|clas)\.abap$/i.test(i.file), "실제 통합 스캔에서도 가상 이름이 노출되면 안 됨");
    }
  }
);
