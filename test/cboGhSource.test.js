// lib/cbo-review/ghSource.js — GitHub 링크 리뷰 소스(URL 정규화 + 텍스트 파일 수집) 회귀 테스트.
// clone 은 하지 않는다 — parseGitHubTarget 은 순수 함수, collectReviewFiles 는 임시 폴더로 검증.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseGitHubTarget, collectReviewFiles } from "../lib/cbo-review/ghSource.js";

test("parseGitHubTarget: SSH 형식", () => {
  const t = parseGitHubTarget("git@github.com:yesblue0342-bit/0Program.git", { branch: "dev", path: "src" });
  assert.deepEqual(t, { owner: "yesblue0342-bit", repo: "0Program", sshUrl: "git@github.com:yesblue0342-bit/0Program.git", branch: "dev", path: "src" });
});

test("parseGitHubTarget: https repo 루트(.git 유무) — 기본 브랜치 main", () => {
  for (const u of ["https://github.com/owner/repo", "https://github.com/owner/repo.git", "https://github.com/owner/repo/"]) {
    const t = parseGitHubTarget(u);
    assert.equal(t.sshUrl, "git@github.com:owner/repo.git");
    assert.equal(t.branch, "main");
    assert.equal(t.path, "");
  }
});

test("parseGitHubTarget: blob/tree 링크에서 브랜치·경로 추출(필드 값이 있으면 필드 우선)", () => {
  const t = parseGitHubTarget("https://github.com/o/r/tree/develop/a/b%20c");
  assert.equal(t.branch, "develop");
  assert.equal(t.path, "a/b c");
  const t2 = parseGitHubTarget("https://github.com/o/r/blob/develop/x.abap", { branch: "main", path: "y" });
  assert.equal(t2.branch, "main"); // 필드 우선
  assert.equal(t2.path, "y");
});

test("parseGitHubTarget: 비허용 입력 거부(빈 값·타 호스트·owner/repo 불명)", () => {
  assert.throws(() => parseGitHubTarget(""), /필요/);
  assert.throws(() => parseGitHubTarget("https://gitlab.com/o/r"), /github\.com/);
  assert.throws(() => parseGitHubTarget("https://github.com/"), /owner\/repo/);
  assert.throws(() => parseGitHubTarget("not a url"), /형식/);
});

test("collectReviewFiles: 텍스트 확장자만, 숨김/node_modules/민감/과대 제외, 폴더 재귀", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ghsrc-"));
  try {
    await fs.mkdir(path.join(tmp, "sub"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
    await fs.mkdir(path.join(tmp, "node_modules/x"), { recursive: true });
    await fs.writeFile(path.join(tmp, "a.abap"), "REPORT za.");
    await fs.writeFile(path.join(tmp, "sub/b.js"), "console.log(1)");
    await fs.writeFile(path.join(tmp, "sub/c.png"), Buffer.from([137, 80, 78, 71])); // 비텍스트 확장자
    await fs.writeFile(path.join(tmp, "server.pem"), "PEMPEM");                       // 민감
    await fs.writeFile(path.join(tmp, ".env"), "SECRET=1");                           // 숨김
    await fs.writeFile(path.join(tmp, ".git/config"), "x");
    await fs.writeFile(path.join(tmp, "node_modules/x/d.js"), "x");
    await fs.writeFile(path.join(tmp, "big.md"), "x".repeat(500001));                 // 과대
    const files = await collectReviewFiles(tmp);
    assert.deepEqual(files.map((f) => f.name).sort(), ["a.abap", "sub/b.js"]);
    assert.equal(files.find((f) => f.name === "a.abap").content, "REPORT za.");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("collectReviewFiles: 단일 파일 루트도 지원", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ghsrc-"));
  try {
    const file = path.join(tmp, "z.abap");
    await fs.writeFile(file, "REPORT zz.");
    const files = await collectReviewFiles(file);
    assert.deepEqual(files, [{ name: "z.abap", content: "REPORT zz." }]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
