// lib/cbo-review/ghSource.js — 소스 코드 리뷰의 "GitHub 링크" 소스: 임의 GitHub 저장소를
// cbo-precheck 방식(SSH clone, lib/cbo-precheck/repoFetch.withClonedRepo 재사용)으로 받아
// 리뷰 가능한 텍스트 파일을 수집한다.
//
// ★ 배경(회귀 방지): 기존 GitHub 링크 리뷰는 parseGitHubUrl 이 0Program blob/tree 링크만 허용하고
//   로컬 0Program clone(repository.js)에서 읽었다 — clone 인증이 깨지면 기능 전체가 죽고,
//   다른 저장소는 아예 리뷰할 수 없었다. cbo-precheck 처럼 URL+브랜치+경로를 받아 임시 폴더에
//   SSH clone(배포키, GITHUB_TOKEN 불필요) 후 수집·정리하므로 0Program 사본 상태와 무관하다.
// ★ GitHub 링크 리뷰는 읽기 전용 — "보완 및 반영"은 수정본 다운로드로 제공(저장소 커밋 없음).
//   0Program 커밋 반영이 필요하면 "로컬" 소스(서버 0Program 사본)를 사용한다.
import fs from "node:fs/promises";
import path from "node:path";
import { withClonedRepo } from "../cbo-precheck/repoFetch.js";
import { TEXT_EXTENSIONS } from "./core.js";

const MAX_FILES = 100;          // readRepoPath(로컬 소스)와 동일 상한
const MAX_FILE_BYTES = 500000;  // readRepoPath 와 동일(500KB 초과 스킵)

// https://github.com/owner/repo(.git)?, https://github.com/owner/repo/(blob|tree)/branch/path...,
// git@github.com:owner/repo(.git) 세 형태를 모두 받아 SSH clone 대상으로 정규화한다.
// blob/tree 링크면 브랜치·경로도 추출(입력 필드 값이 있으면 필드 우선).
export function parseGitHubTarget(input, { branch, path: subPath } = {}) {
  const raw = String(input || "").trim();
  if (!raw) throw Object.assign(new Error("GitHub 저장소 주소가 필요합니다."), { status: 400 });
  let owner = "", repo = "";
  let br = String(branch || "").trim();
  let rel = String(subPath || "").trim();

  const ssh = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(raw);
  if (ssh) {
    owner = ssh[1]; repo = ssh[2];
  } else {
    let url;
    try { url = new URL(raw); } catch {
      throw Object.assign(new Error("GitHub 주소 형식이 올바르지 않습니다 (예: https://github.com/owner/repo 또는 git@github.com:owner/repo.git)."), { status: 400 });
    }
    if (url.hostname !== "github.com") throw Object.assign(new Error("github.com 주소만 허용됩니다."), { status: 400 });
    const parts = url.pathname.split("/").filter(Boolean);
    owner = parts[0] || "";
    repo = (parts[1] || "").replace(/\.git$/, "");
    if ((parts[2] === "blob" || parts[2] === "tree") && parts[3]) {
      if (!br) br = decodeURIComponent(parts[3]);
      if (!rel) rel = parts.slice(4).map((p) => decodeURIComponent(p)).join("/");
    }
  }
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    throw Object.assign(new Error("GitHub 주소에서 owner/repo 를 확인할 수 없습니다."), { status: 400 });
  }
  return { owner, repo, sshUrl: `git@github.com:${owner}/${repo}.git`, branch: br || "main", path: rel };
}

function isSensitive(rel) {
  return rel.split("/").some((p) => p.startsWith(".")) ||
    /(?:^|\/)(?:id_rsa|id_ed25519|credentials|secrets?)$|\.(?:key|pem|p12|pfx)$/i.test(rel);
}
function isReviewableName(rel) {
  if (isSensitive(rel)) return false;
  return TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

// root(파일 또는 폴더) 이하에서 리뷰 가능한 텍스트 파일만 수집 — 숨김/시스템·node_modules·
// 민감 파일·비텍스트 확장자·과대 파일 제외. name 은 root 기준 상대 경로.
export async function collectReviewFiles(root) {
  const files = [];
  const rootStat = await fs.stat(root).catch(() => null);
  if (rootStat && rootStat.isFile()) {
    const base = path.basename(root);
    if (isReviewableName(base) && rootStat.size <= MAX_FILE_BYTES) {
      files.push({ name: base, content: await fs.readFile(root, "utf8") });
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
      const rel = path.relative(root, full).replaceAll("\\", "/");
      if (!isReviewableName(rel)) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;
      try { files.push({ name: rel, content: await fs.readFile(full, "utf8") }); } catch { /* 바이너리/읽기 실패 스킵 */ }
    }
  }
  await walk(root);
  return files;
}

// URL+브랜치+경로 → SSH clone(임시 폴더, 종료 시 정리) → 텍스트 파일 수집.
export async function fetchGitHubFiles({ repoUrl, branch, path: subPath }) {
  const target = parseGitHubTarget(repoUrl, { branch, path: subPath });
  const files = await withClonedRepo(
    { repoUrl: target.sshUrl, branch: target.branch, path: target.path },
    (root) => collectReviewFiles(root),
  );
  return { target, files };
}
