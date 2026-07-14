import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { collectAbapFiles, withClonedRepo } from "../lib/cbo-precheck/repoFetch.js";
import { isScannable } from "../lib/cbo-precheck/scan.js";

const exec = promisify(execFile);

async function mktemp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "cbo-precheck-test-"));
}

test("collectAbapFiles: 하위 폴더를 폴더명/깊이와 무관하게 재귀적으로 전부 탐색한다", async () => {
  const root = await mktemp();
  try {
    // 대상 폴더 바로 밑에 파일이 있는 기존 케이스(회귀 확인용)
    await fs.writeFile(path.join(root, "TOP.abap"), "REPORT ztop.\n");
    // 1단계 하위 폴더 — 0Program 저장소 관례(`_abap/`)와 동일한 모양이지만 폴더명에 의존하면 안 된다
    await fs.mkdir(path.join(root, "_abap"), { recursive: true });
    await fs.writeFile(path.join(root, "_abap", "ZAQMR0130.abap"), "REPORT zaqmr0130.\n");
    // 2단계 하위 폴더(임의 폴더명 — `_abap` 하드코딩 가정이 없어야 함)
    await fs.mkdir(path.join(root, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(root, "a", "b", "DEEP.abap"), "REPORT zdeep.\n");
    // DDIC XML(타입 해석용 컨텍스트) — 수집은 되지만 isScannable 대상은 아니다
    await fs.mkdir(path.join(root, "dictionary"), { recursive: true });
    await fs.writeFile(path.join(root, "dictionary", "qals.tabl.xml"), "<xml/>");
    // 무관 폴더 — 제외 대상
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules", "pkg", "SKIP.abap"), "REPORT zskip.\n");
    await fs.mkdir(path.join(root, ".git", "objects"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "objects", "SKIP2.abap"), "REPORT zskip2.\n");
    // 대상 확장자가 아닌 파일(0Program `_abap/ZAQMR0130_DDIC.txt` 관례) — 수집 대상 아님
    await fs.writeFile(path.join(root, "_abap", "ZAQMR0130_DDIC.txt"), "note\n");

    const files = await collectAbapFiles(root);
    const names = files.map((f) => f.name).sort();
    assert.deepEqual(names, ["TOP.abap", "_abap/ZAQMR0130.abap", "a/b/DEEP.abap", "dictionary/qals.tabl.xml"].sort());
    assert.ok(!names.some((n) => n.includes("node_modules")), "node_modules 제외");
    assert.ok(!names.some((n) => n.includes(".git")), ".git 제외");
    assert.ok(!names.some((n) => n.endsWith(".txt")), ".txt 확장자는 수집 대상 아님");

    const ddic = files.find((f) => f.name === "dictionary/qals.tabl.xml");
    assert.equal(ddic.isDdic, true);

    // 단순 확장자(비 abapGit 네이밍) 파일도 isScannable(스캔 대상)로 인식되어야 한다 — 이번 수정의 핵심.
    assert.ok(isScannable("_abap/ZAQMR0130.abap"));
    assert.ok(isScannable("a/b/DEEP.abap"));
    assert.ok(!isScannable("dictionary/qals.tabl.xml"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("collectAbapFiles: path가 폴더가 아니라 단일 파일이면 그 파일 하나만 대상으로 처리한다(엣지케이스)", async () => {
  const root = await mktemp();
  try {
    const filePath = path.join(root, "SINGLE.abap");
    await fs.writeFile(filePath, "REPORT zsingle.\n");
    const files = await collectAbapFiles(filePath);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, "SINGLE.abap");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// GATE 1 (d): 실제 저장소 통합 확인. SSH(배포키) 접근이 없는 환경(예: CI)에서는 네트워크 제약으로 skip —
// 이 세션에서는 실제 clone 으로 수동 검증 완료(WORK_REPORT.md/TEST_RESULTS.md 참고).
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
  "실제 0Program 저장소: 260707_QM023_ZAQMR0130/_abap 하위 .abap 파일이 전부 스캔 대상에 포함된다",
  { skip: sshOk ? false : "SSH(배포키) 접근 불가 — 네트워크 제약으로 skip" },
  async () => {
    const files = await withClonedRepo(
      { repoUrl: LIVE_REPO, branch: "main", path: "260707_QM023_ZAQMR0130" },
      (root) => collectAbapFiles(root)
    );
    const abapInSub = files.filter((f) => f.name.startsWith("_abap/") && f.name.endsWith(".abap"));
    assert.ok(abapInSub.length >= 6, `_abap/ 안의 .abap 파일이 최소 6개 검출되어야 함(실측 ${abapInSub.length}건)`);
    assert.ok(abapInSub.every((f) => isScannable(f.name)), "단순 확장자 파일도 isScannable=true 여야 함");
  }
);
