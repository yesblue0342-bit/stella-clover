// lib/cbo-review/hub.js — CBO Review "Hub 전송": 스펙 저장 + 폴더 생성/삭제/이름변경/목록을
// GitHub REST Contents/Git-Data API 로 처리한다(로컬 git clone 미사용).
//
// ★ 왜 REST 인가(회귀 방지): 기존 lib/cbo-review/repository.js 는 0Program 을 로컬로 clone/push 했는데,
//   HTTPS remote + `http.extraHeader: Authorization: Bearer <token>` 조합은 GitHub git-over-HTTPS 에서
//   거부되어 "could not read Username for 'https://github.com': terminal prompts disabled" 로 실패했다.
//   REST API(api.github.com)는 Bearer 토큰이 정식 인증 수단이라 확실히 동작한다(lib/cbo-precheck/github.js·
//   Stella Hub api/github.js 와 동일 패턴). Hub 전송은 임시 파일/디스크 없이 서버에서 직접 커밋한다.
//
// ★ 절대 규칙: 토큰은 오직 Authorization 헤더에만 싣고 URL/로그/에러메시지/반환값에 절대 노출하지 않는다.
//   대상 저장소는 CBO_GITHUB_* 로 고정(0Program) — 임의 owner/repo 입력을 받지 않아 서버 config 우회 불가.
import path from "node:path";
import { specFileName } from "./core.js";

const API = "https://api.github.com";
const OWNER = process.env.CBO_GITHUB_OWNER || "yesblue0342-bit";
const REPO = process.env.CBO_GITHUB_REPO || "0Program";
const BRANCH = process.env.CBO_GITHUB_BRANCH || "main";
// 재귀 삭제/이름변경 시 한 번에 처리할 최대 파일 수(대량 트리 오작동·레이트리밋 방지).
const MAX_BATCH = 200;

// PAT 는 이미 서버 환경변수에 존재(신규 발급 금지). 이름 폴백만 맞춘다.
export function hubToken() {
  return String(
    process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.STELLA_GITHUB_TOKEN || "",
  ).trim();
}
export function hasHubToken() { return !!hubToken(); }
export const hubRepoInfo = { owner: OWNER, repo: REPO, branch: BRANCH };

// ── 경로 안전 검증 ──────────────────────────────────────────────
//  · traversal(..)·현재경로(.)·빈 세그먼트 금지, 숨김/시스템 세그먼트(.git·.env 등 '.' 로 시작) 금지,
//    민감 파일(키/자격증명) 금지, 절대경로 금지. mkdir 의 내부 `.gitkeep` 은 검증 후 코드가 직접 붙인다.
function assertSafeHubPath(input, { allowRoot = false } = {}) {
  const value = String(input || "").replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!value) {
    if (allowRoot) return "";
    throw Object.assign(new Error("대상 경로가 필요합니다."), { status: 400 });
  }
  if (value.includes("\0")) throw Object.assign(new Error("허용되지 않은 경로입니다."), { status: 400 });
  if (/^[a-z]:/i.test(value)) throw Object.assign(new Error("절대 경로는 허용되지 않습니다."), { status: 400 });
  for (const part of value.split("/")) {
    if (!part || part === "." || part === "..") throw Object.assign(new Error("허용되지 않은 경로입니다."), { status: 400 });
    if (part.startsWith(".")) throw Object.assign(new Error("숨김/시스템 경로(.git·.env 등)는 사용할 수 없습니다."), { status: 400 });
  }
  if (/(?:^|\/)(?:id_rsa|id_ed25519|credentials|secrets?)(?:\/|$)/i.test(value) || /\.(?:key|pem|p12|pfx)$/i.test(value)) {
    throw Object.assign(new Error("민감 파일/폴더는 조작할 수 없습니다."), { status: 400 });
  }
  return value;
}

function encPath(rel) {
  return String(rel || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}
function blobUrl(rel) { return `https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/${encPath(rel)}`; }
function treeUrl(rel) { return `https://github.com/${OWNER}/${REPO}/tree/${BRANCH}/${encPath(rel)}`; }

function ghHeaders(withBody) {
  const token = hubToken();
  if (!token) throw Object.assign(new Error("GITHUB_TOKEN 이 설정되지 않아 Hub 전송을 사용할 수 없습니다."), { status: 503 });
  const h = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "stella-clover-cbo-review",
  };
  if (withBody) h["Content-Type"] = "application/json";
  return h;
}

// 모든 GitHub 호출 공통 래퍼 — 실패해도 토큰은 노출하지 않고 status/message 만 담아 던진다.
async function gh(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method, headers: ghHeaders(!!body), body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(`GitHub API 오류(${res.status}): ${data.message || "알 수 없는 오류"}`), { status: res.status });
  return data;
}

async function getContents(rel) {
  const enc = encPath(rel);
  const base = enc ? `/repos/${OWNER}/${REPO}/contents/${enc}` : `/repos/${OWNER}/${REPO}/contents`;
  return gh(`${base}?ref=${encodeURIComponent(BRANCH)}`);
}
async function putFile(rel, contentB64, message, sha) {
  const body = sha
    ? { message, content: contentB64, branch: BRANCH, sha }
    : { message, content: contentB64, branch: BRANCH };
  return gh(`/repos/${OWNER}/${REPO}/contents/${encPath(rel)}`, { method: "PUT", body });
}
async function deleteFile(rel, sha, message) {
  return gh(`/repos/${OWNER}/${REPO}/contents/${encPath(rel)}`, { method: "DELETE", body: { message, sha, branch: BRANCH } });
}
// 파일이면 { sha }, 폴더면 null(디렉토리), 없으면 undefined(404) 로 정규화.
async function statEntry(rel) {
  try {
    const d = await getContents(rel);
    if (Array.isArray(d)) return { type: "dir" };
    return { type: "file", sha: d.sha, contentB64: String(d.content || "").replace(/\s/g, "") };
  } catch (e) {
    if (e.status === 404) return undefined;
    throw e;
  }
}
// prefix(폴더) 이하 모든 blob(파일)의 {path, sha} 목록 — Git Trees API 재귀 1회 호출.
async function blobsUnder(prefix) {
  const data = await gh(`/repos/${OWNER}/${REPO}/git/trees/${encodeURIComponent(BRANCH)}?recursive=1`);
  const pfx = `${prefix.replace(/\/+$/, "")}/`;
  return (data.tree || [])
    .filter((t) => t.type === "blob" && t.path.startsWith(pfx))
    .map((t) => ({ path: t.path, sha: t.sha }));
}

// ── 스펙 파일 저장(Hub 전송) — folder 하위에 spec_YYYYMMDD_제목.(md|xlsx) 커밋(동명 존재 시 _vN) ──
export async function saveSpecToHub({ folder, title, extension, content }) {
  const dir = folder ? assertSafeHubPath(folder) : "spec";
  const wanted = specFileName({ title, extension });
  const ext = path.extname(wanted);
  const base = wanted.slice(0, -ext.length);

  const existing = new Set();
  try {
    const d = await getContents(dir);
    if (Array.isArray(d)) for (const x of d) existing.add(x.name);
  } catch (e) { if (e.status !== 404) throw e; } // 새 폴더면 404 — PUT 시 자동 생성

  let filename = wanted; let version = 2;
  while (existing.has(filename)) filename = `${base}_v${version++}${ext}`;
  const relative = `${dir}/${filename}`;
  const contentB64 = (Buffer.isBuffer(content) ? content : Buffer.from(String(content || ""), "utf8")).toString("base64");
  const put = await putFile(relative, contentB64, `feat(spec): add ${filename}`);
  return {
    filename, path: relative, folder: dir, pushed: true,
    commit: put.commit?.sha || "",
    url: put.content?.html_url || blobUrl(relative),
  };
}

// ── 폴더 목록(대상 폴더 선택용) — 404/빈 레포는 빈 목록으로 정규화. .gitkeep 은 숨긴다. ──
export async function listHub({ path: p = "" } = {}) {
  const rel = assertSafeHubPath(p, { allowRoot: true });
  let data;
  try {
    data = await getContents(rel);
  } catch (e) {
    if (e.status === 404) return { path: rel, items: [] };
    if ((e.status === 409 || e.status === 404) && /empty/i.test(e.message)) return { path: rel, items: [], empty: true };
    throw e;
  }
  if (!Array.isArray(data)) {
    return { path: rel, file: true, items: [{ name: data.name, path: data.path, type: "file", sha: data.sha, size: data.size || 0 }] };
  }
  const items = data
    .map((x) => ({ name: x.name, path: x.path, type: x.type, sha: x.sha, size: x.size || 0 }))
    .filter((x) => x.name !== ".gitkeep")
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: rel, items };
}

// ── 새 폴더 생성 — GitHub 은 빈 폴더가 없으므로 <dir>/.gitkeep 을 커밋한다. ──
export async function mkdirHub({ path: p }) {
  const dir = assertSafeHubPath(p);
  const keep = `${dir}/.gitkeep`;
  const cur = await statEntry(keep);
  const put = await putFile(keep, Buffer.from("", "utf8").toString("base64"), `chore(hub): create folder ${dir}`, cur?.sha);
  return { path: dir, created: true, url: treeUrl(dir), commit: put.commit?.sha || "" };
}

// ── 삭제 — 파일 1개 또는 폴더(하위 전체 재귀). 부분 실패는 errors 로 보고. ──
export async function deleteHub({ path: p }) {
  const rel = assertSafeHubPath(p);
  const entry = await statEntry(rel);
  if (!entry) throw Object.assign(new Error("삭제할 대상을 찾을 수 없습니다."), { status: 404 });

  if (entry.type === "file") {
    await deleteFile(rel, entry.sha, `chore(hub): delete ${rel}`);
    return { path: rel, type: "file", deleted: 1, total: 1 };
  }
  const blobs = await blobsUnder(rel);
  if (!blobs.length) return { path: rel, type: "dir", deleted: 0, total: 0 };
  if (blobs.length > MAX_BATCH) throw Object.assign(new Error(`폴더에 파일이 너무 많습니다(${blobs.length}). ${MAX_BATCH}개 이하만 한 번에 삭제할 수 있습니다.`), { status: 400 });
  let deleted = 0; const errors = [];
  for (const b of blobs) {
    try { await deleteFile(b.path, b.sha, `chore(hub): delete ${b.path}`); deleted += 1; }
    catch (e) { errors.push({ path: b.path, error: e.message }); }
  }
  return { path: rel, type: "dir", deleted, total: blobs.length, errors: errors.length ? errors : undefined };
}

// 파일 1개 이동(대상 생성 후 원본 삭제). srcSha 주면 재조회 생략(트리 기반 배치용).
async function moveOneFile(src, dest, srcSha) {
  const meta = srcSha ? { sha: srcSha } : await statEntry(src);
  if (!meta || meta.type === "dir") throw new Error(`이동할 파일을 찾을 수 없습니다: ${src}`);
  // 원본 내용(base64) — srcSha 경로에서도 내용이 필요하므로 항상 contents 조회.
  const file = await getContents(src);
  if (Array.isArray(file)) throw new Error(`이동 대상이 폴더입니다: ${src}`);
  const contentB64 = String(file.content || "").replace(/\s/g, "");
  const destExist = await statEntry(dest);
  await putFile(dest, contentB64, `chore(hub): move ${src} -> ${dest}`, destExist?.type === "file" ? destExist.sha : undefined);
  await deleteFile(src, file.sha, `chore(hub): move cleanup ${src}`);
}

// ── 이름 변경/이동 — 파일 또는 폴더(하위 전체 재귀 이동). ──
export async function renameHub({ path: p, dest }) {
  const src = assertSafeHubPath(p);
  const dst = assertSafeHubPath(dest);
  if (src === dst) throw Object.assign(new Error("원본과 대상 경로가 같습니다."), { status: 400 });
  const entry = await statEntry(src);
  if (!entry) throw Object.assign(new Error("이름을 변경할 원본을 찾을 수 없습니다."), { status: 404 });

  if (entry.type === "file") {
    await moveOneFile(src, dst, entry.sha);
    return { src, dest: dst, type: "file", moved: 1, total: 1, url: blobUrl(dst) };
  }
  const blobs = await blobsUnder(src);
  if (blobs.length > MAX_BATCH) throw Object.assign(new Error(`폴더에 파일이 너무 많습니다(${blobs.length}).`), { status: 400 });
  const pfx = `${src.replace(/\/+$/, "")}/`;
  let moved = 0; const errors = [];
  for (const b of blobs) {
    const target = assertSafeHubPath(`${dst}/${b.path.slice(pfx.length)}`);
    try { await moveOneFile(b.path, target, b.sha); moved += 1; }
    catch (e) { errors.push({ path: b.path, error: e.message }); }
  }
  return { src, dest: dst, type: "dir", moved, total: blobs.length, errors: errors.length ? errors : undefined, url: treeUrl(dst) };
}
