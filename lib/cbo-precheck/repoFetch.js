// lib/cbo-precheck/repoFetch.js — GitHub repo SSH clone(임시 폴더) + ABAP/DDIC 파일 수집.
//
// ★ 절대 규칙 6: remote 는 SSH 만 사용. lib/cbo-review/repository.js 는 GITHUB_TOKEN 이 있으면 HTTPS 로
// 전환하지만(그 모듈 고유 정책), CBO Pre-Check 스캔은 임의 repo/branch/path 입력을 받으므로 항상 SSH 로만
// clone 한다(OCI 서버에 배포키가 설정되어 있어야 함) — 서버 config 를 우회하는 URL 조작을 막기 위해 형식을 검증한다.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const MAX_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function assertSshUrl(url) {
  const value = String(url || "").trim();
  if (!/^git@[\w.-]+:[\w.-]+\/[\w.-]+(\.git)?$/.test(value)) {
    throw new Error("SSH 형식 GitHub URL만 허용됩니다 (예: git@github.com:owner/repo.git).");
  }
  return value;
}

function assertSafeBranch(branch) {
  const value = String(branch || "main").trim() || "main";
  if (!/^[\w.\-/]{1,200}$/.test(value)) throw new Error("허용되지 않는 브랜치명입니다.");
  return value;
}

function assertSafeSubPath(input) {
  if (!input) return "";
  const value = String(input).replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!value) return "";
  if (value.includes("\0") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("허용되지 않는 경로입니다.");
  }
  return value;
}

// repoUrl/branch/path 를 검증한 뒤 임시 폴더에 clone하고, fn(root, tmpDir) 를 실행한 후 반드시 정리한다.
export async function withClonedRepo({ repoUrl, branch, path: subPath }, fn) {
  const url = assertSshUrl(repoUrl);
  const safeBranch = assertSafeBranch(branch);
  const safeSubPath = assertSafeSubPath(subPath);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cbo-precheck-"));
  try {
    try {
      await exec("git", ["clone", "--depth", "1", "--branch", safeBranch, url, tmpDir], {
        timeout: 120000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" },
      });
    } catch (e) {
      throw new Error(`저장소 clone 실패: ${String(e?.stderr || e?.message || e).slice(0, 500)}`);
    }
    const root = safeSubPath ? path.join(tmpDir, safeSubPath) : tmpDir;
    try { await fs.access(root); } catch { throw new Error(`경로를 찾을 수 없습니다: ${safeSubPath || "/"}`); }
    return await fn(root, tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function isTargetFile(name) {
  const isAbap = /\.abap$/i.test(name);
  const isDdic = /\.(tabl|dtel|doma|ttyp|shlp|view)\.xml$/i.test(name);
  return { isAbap, isDdic, isTarget: isAbap || isDdic };
}

// ABAP 소스(.abap) + DDIC XML(abapGit TABL/DTEL/DOMA/...)만 수집. 그 외 파일은 스캔 대상이 아니다.
// `root` 이하 모든 깊이의 하위 폴더를 재귀적으로 탐색한다(0Program 저장소의 `_abap/` 같은 하위 폴더 관례에
// 의존하지 않음 — 폴더명·깊이 무관하게 대상 확장자 파일을 전부 찾는다). `root` 이 폴더가 아니라 단일
// 파일이면 그 파일 자체를 대상으로 처리한다.
export async function collectAbapFiles(root) {
  const files = [];

  const rootStat = await fs.stat(root).catch(() => null);
  if (rootStat && rootStat.isFile()) {
    const { isTarget, isDdic } = isTargetFile(path.basename(root));
    if (isTarget && rootStat.size <= MAX_FILE_BYTES) {
      const content = await fs.readFile(root, "utf8");
      files.push({ name: path.basename(root), content, isDdic });
    }
    return files;
  }

  async function walk(dir) {
    if (files.length >= MAX_FILES) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      const { isTarget, isDdic } = isTargetFile(entry.name);
      if (!isTarget) continue;
      const stat = await fs.stat(full);
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(full, "utf8");
      files.push({ name: path.relative(root, full).replaceAll("\\", "/"), content, isDdic });
    }
  }
  await walk(root);
  return files;
}
