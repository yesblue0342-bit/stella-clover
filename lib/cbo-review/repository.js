import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertSafeRelativePath, specFileName } from "./core.js";

const exec = promisify(execFile);
const OWNER = process.env.CBO_GITHUB_OWNER || "yesblue0342-bit";
const REPO = process.env.CBO_GITHUB_REPO || "0Program";
const BRANCH = process.env.CBO_GITHUB_BRANCH || "main";
const REPO_PATH = path.resolve(process.env.CBO_REPO_PATH || (process.platform === "win32" ? "C:/codex/0Program" : "/app/data/0Program"));
const REMOTE = `https://github.com/${OWNER}/${REPO}.git`;
let repoQueue = Promise.resolve();
const withRepoLock = (work) => {
  const run = repoQueue.then(work, work);
  repoQueue = run.catch(() => {});
  return run;
};

function gitEnv() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return process.env;
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  };
}

async function git(args, cwd = REPO_PATH) {
  return exec("git", args, { cwd, env: gitEnv(), timeout: 120000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 });
}

export async function ensureRepo() {
  try { await fs.access(path.join(REPO_PATH, ".git")); }
  catch {
    await fs.mkdir(path.dirname(REPO_PATH), { recursive: true });
    await exec("git", ["clone", "--branch", BRANCH, REMOTE, REPO_PATH], { env: gitEnv(), timeout: 120000, windowsHide: true });
  }
  const hasName = await git(["config", "--get", "user.name"]).then(({ stdout }) => !!stdout.trim()).catch(() => false);
  const hasEmail = await git(["config", "--get", "user.email"]).then(({ stdout }) => !!stdout.trim()).catch(() => false);
  if (!hasName) await git(["config", "user.name", process.env.CBO_GIT_USER_NAME || "Stella Clover CBO Review"]);
  if (!hasEmail) await git(["config", "user.email", process.env.CBO_GIT_USER_EMAIL || "cbo-review@localhost"]);
  return REPO_PATH;
}

function insideRepo(relative) {
  const safe = assertSafeRelativePath(relative);
  const target = path.resolve(REPO_PATH, safe);
  if (target !== REPO_PATH && !target.startsWith(`${REPO_PATH}${path.sep}`)) throw new Error("0Program 외부 경로는 허용되지 않습니다.");
  return { safe, target };
}

async function assertRealInside(target) {
  const [rootReal, targetReal] = await Promise.all([fs.realpath(REPO_PATH), fs.realpath(target)]);
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) throw new Error("symlink로 저장소 외부에 접근할 수 없습니다.");
}

function assertReviewable(relative) {
  const parts = String(relative).replaceAll("\\", "/").split("/");
  if (parts.some((part) => part.startsWith(".")) || /(?:^|\/)(?:id_rsa|id_ed25519|credentials|secrets?|.*\.(?:key|pem|p12|pfx))$/i.test(relative)) throw new Error("민감 파일은 리뷰할 수 없습니다.");
}

async function assertCleanRepo() {
  const { stdout } = await git(["status", "--porcelain"]);
  if (stdout.trim()) throw new Error("0Program 작업 폴더에 미커밋 변경이 있습니다. 정리 후 다시 실행하세요.");
}

export async function readRepoPath(relative) {
  return withRepoLock(async () => {
  await ensureRepo(); await assertCleanRepo(); await pull();
  const { safe, target } = insideRepo(relative); assertReviewable(safe); await assertRealInside(target);
  const stat = await fs.stat(target);
  if (stat.isFile()) return [{ name: safe.replaceAll("\\", "/"), content: await fs.readFile(target, "utf8") }];
  const results = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || results.length >= 100) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && (await fs.stat(full)).size <= 500000) {
        try { results.push({ name: path.relative(REPO_PATH, full).replaceAll("\\", "/"), content: await fs.readFile(full, "utf8") }); } catch {}
      }
    }
  }
  await walk(target);
  return results;
  });
}

export function parseGitHubUrl(value) {
  const url = new URL(String(value || ""));
  if (url.hostname !== "github.com") throw new Error("github.com 링크만 허용됩니다.");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== OWNER || parts[1] !== REPO) throw new Error(`${OWNER}/${REPO} 링크만 허용됩니다.`);
  if (parts[2] === "blob" || parts[2] === "tree") {
    if (parts[3] !== BRANCH) throw new Error(`${BRANCH} 브랜치만 허용됩니다.`);
    return assertSafeRelativePath(parts.slice(4).join("/"));
  }
  return "README.md";
}

async function pull() {
  await git(["pull", "--rebase", "--autostash", "origin", BRANCH]);
}

async function commitAndPush(relative, message) {
  await git(["add", "--", relative]);
  const diff = await git(["diff", "--cached", "--quiet"]).then(() => false).catch(() => true);
  if (!diff) return { commit: "", pushed: false };
  await git(["commit", "-m", message]);
  const { stdout } = await git(["rev-parse", "HEAD"]);
  await git(["push", "origin", BRANCH]);
  return { commit: stdout.trim(), pushed: true };
}

async function saveSpecUnlocked({ title, extension, content }) {
  await ensureRepo();
  await assertCleanRepo(); await pull();
  await fs.mkdir(path.join(REPO_PATH, "spec"), { recursive: true });
  const wanted = specFileName({ title, extension });
  const ext = path.extname(wanted);
  const base = wanted.slice(0, -ext.length);
  let filename = wanted;
  let version = 2;
  while (true) {
    try { await fs.access(path.join(REPO_PATH, "spec", filename)); filename = `${base}_v${version++}${ext}`; }
    catch { break; }
  }
  const relative = `spec/${filename}`;
  await fs.writeFile(path.join(REPO_PATH, relative), content);
  const result = await commitAndPush(relative, `feat(spec): add ${filename}`);
  return { ...result, filename, path: relative, url: `https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/${relative}` };
}
export const saveSpec = (input) => withRepoLock(() => saveSpecUnlocked(input));

async function applyToRepoUnlocked({ relative, originalHash, content, backup = true }) {
  await ensureRepo();
  await assertCleanRepo(); await pull();
  const { safe, target } = insideRepo(relative);
  assertReviewable(safe); await assertRealInside(target);
  const current = await fs.readFile(target, "utf8");
  const { sha256 } = await import("./core.js");
  if (originalHash && sha256(current) !== originalHash) throw new Error("원본이 리뷰 후 변경되었습니다. 다시 리뷰하세요.");
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const backupRelative = `${safe}.bak.${stamp}`;
  if (backup) await fs.copyFile(target, path.join(REPO_PATH, backupRelative));
  await fs.writeFile(target, content, "utf8");
  await git(["add", "--", safe, backupRelative]);
  await git(["commit", "-m", `fix(cbo-review): apply review to ${path.basename(safe)}`]);
  const { stdout } = await git(["rev-parse", "HEAD"]);
  await git(["push", "origin", BRANCH]);
  return { commit: stdout.trim(), backup: backupRelative, url: `https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/${safe}` };
}
export const applyToRepo = (input) => withRepoLock(() => applyToRepoUnlocked(input));

async function restoreBackupUnlocked({ relative, backup }) {
  await ensureRepo();
  await assertCleanRepo(); await pull();
  const target = insideRepo(relative);
  const source = insideRepo(backup);
  if (!source.safe.startsWith(`${target.safe}.bak.`)) throw new Error("해당 파일에 연결된 CBO 백업만 복원할 수 있습니다.");
  await assertRealInside(target.target); await assertRealInside(source.target);
  await fs.copyFile(source.target, target.target);
  const result = await commitAndPush(target.safe, `fix(cbo-review): restore ${path.basename(target.safe)}`);
  return { ...result, url: `https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/${target.safe}` };
}
export const restoreBackup = (input) => withRepoLock(() => restoreBackupUnlocked(input));

export const repoInfo = { owner: OWNER, repo: REPO, branch: BRANCH, root: REPO_PATH };
