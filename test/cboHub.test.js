// lib/cbo-review/hub.js — Hub 전송(GitHub REST) 회귀 테스트.
// fetch 를 목킹해 실제 GitHub 호출 없이 REST 호출 형태·base64 인코딩·버전링·재귀·경로안전을 검증한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { specFileName } from "../lib/cbo-review/core.js";
import {
  saveSpecToHub, listHub, mkdirHub, deleteHub, renameHub, hasHubToken, hubRepoInfo,
} from "../lib/cbo-review/hub.js";

const OWNER = hubRepoInfo.owner, REPO = hubRepoInfo.repo, BRANCH = hubRepoInfo.branch;
const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");
const deB64 = (s) => Buffer.from(String(s), "base64").toString("utf8");
// 샌드박스에 GITHUB_TOKEN/GH_TOKEN 이 미리 있을 수 있으므로, 토큰 유무를 검사하는 테스트는 폴백 이름 전부를 제어한다.
const TOKEN_ENVS = ["GITHUB_TOKEN", "GH_TOKEN", "STELLA_GITHUB_TOKEN"];
function clearTokens() { const saved = {}; for (const k of TOKEN_ENVS) { saved[k] = process.env[k]; delete process.env[k]; } return saved; }
function restoreTokens(saved) { for (const k of TOKEN_ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
function setToken(v) { clearTokens(); process.env.GITHUB_TOKEN = v; }

// route: (method, pathname, search, body) => { status?, json } | throws to signal "unexpected"
function installFetch(route) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method, pathname: u.pathname, search: u.search, body, headers: opts.headers });
    const r = route(method, u.pathname, u.search, body) || {};
    const status = r.status || 200;
    const text = JSON.stringify(r.json ?? {});
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return calls;
}

test("hasHubToken: 토큰 유무 반영", () => {
  const saved = clearTokens();
  assert.equal(hasHubToken(), false);
  process.env.GITHUB_TOKEN = "tkn";
  assert.equal(hasHubToken(), true);
  restoreTokens(saved);
});

test("saveSpecToHub: 빈 폴더 → PUT 1회, 내용 base64 왕복, sha 없음", async () => {
  process.env.GITHUB_TOKEN = "tkn";
  const calls = installFetch((method, pathname) => {
    if (method === "GET" && pathname.endsWith("/contents/spec")) return { json: [] }; // 빈 폴더
    if (method === "PUT") return { json: { content: { html_url: "https://gh/blob" }, commit: { sha: "c0" } } };
    throw new Error("unexpected " + method + " " + pathname);
  });
  const out = await saveSpecToHub({ folder: "spec", title: "ZAQMR0130", extension: "md", content: Buffer.from("hello", "utf8") });
  assert.match(out.filename, /^spec_\d{8}_ZAQMR0130\.md$/);
  assert.equal(out.commit, "c0");
  assert.equal(out.url, "https://gh/blob");
  const put = calls.find((c) => c.method === "PUT");
  assert.equal(deB64(put.body.content), "hello");
  assert.equal(put.body.branch, BRANCH);
  assert.equal(put.body.sha, undefined); // 신규 파일이라 sha 없음
  assert.match(put.body.message, /^feat\(spec\): add spec_\d{8}_ZAQMR0130\.md$/);
  assert.ok(put.pathname.includes(`/repos/${OWNER}/${REPO}/contents/spec/`));
});

test("saveSpecToHub: 동명 존재 → _v2 로 버전업", async () => {
  process.env.GITHUB_TOKEN = "tkn";
  const wanted = specFileName({ title: "ZTEST", extension: "md" });
  installFetch((method, pathname) => {
    if (method === "GET" && pathname.endsWith("/contents/spec")) return { json: [{ name: wanted, type: "file" }] };
    if (method === "PUT") return { json: { content: {}, commit: { sha: "c1" } } };
    throw new Error("unexpected");
  });
  const out = await saveSpecToHub({ folder: "spec", title: "ZTEST", extension: "md", content: Buffer.from("x") });
  assert.equal(out.filename, wanted.replace(/\.md$/, "_v2.md"));
});

test("saveSpecToHub: 새 폴더(404 목록)여도 PUT 진행", async () => {
  process.env.GITHUB_TOKEN = "tkn";
  const calls = installFetch((method, pathname) => {
    if (method === "GET" && pathname.endsWith("/contents/spec/new")) return { status: 404, json: { message: "Not Found" } };
    if (method === "PUT") return { json: { content: {}, commit: { sha: "c2" } } };
    throw new Error("unexpected " + method + " " + pathname);
  });
  const out = await saveSpecToHub({ folder: "spec/new", title: "Z", extension: "md", content: Buffer.from("y") });
  assert.equal(out.folder, "spec/new");
  assert.ok(calls.some((c) => c.method === "PUT"));
});

test("경로 안전: traversal/.git/.env/민감파일/절대경로 거부(fetch 호출 없음)", async () => {
  process.env.GITHUB_TOKEN = "tkn";
  const calls = installFetch(() => { throw new Error("fetch must not be called"); });
  await assert.rejects(() => mkdirHub({ path: "../evil" }), /허용되지 않은/);
  await assert.rejects(() => deleteHub({ path: ".git" }), /숨김\/시스템/);
  await assert.rejects(() => deleteHub({ path: "a/.env" }), /숨김\/시스템/);
  await assert.rejects(() => saveSpecToHub({ folder: "a/../b", title: "z", extension: "md", content: Buffer.from("z") }), /허용되지 않은/);
  await assert.rejects(() => renameHub({ path: "spec/a.md", dest: "keys/server.pem" }), /민감/);
  await assert.rejects(() => mkdirHub({ path: "C:/win" }), /절대 경로/);
  assert.equal(calls.length, 0);
});

test("mkdirHub: <dir>/.gitkeep PUT(빈 내용)", async () => {
  process.env.GITHUB_TOKEN = "tkn";
  const calls = installFetch((method, pathname) => {
    if (method === "GET" && pathname.endsWith("/.gitkeep")) return { status: 404, json: { message: "Not Found" } };
    if (method === "PUT") return { json: { content: {}, commit: { sha: "k" } } };
    throw new Error("unexpected " + method + " " + pathname);
  });
  const out = await mkdirHub({ path: "spec/qm" });
  assert.equal(out.path, "spec/qm");
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put.pathname.endsWith("/contents/spec/qm/.gitkeep"));
  assert.equal(deB64(put.body.content), "");
  assert.match(put.body.message, /create folder spec\/qm/);
});

test("deleteHub: 파일 1개 → GET(stat) 후 DELETE(sha 포함)", async () => {
  process.env.GITHUB_TOKEN = "tkn";
  const calls = installFetch((method) => {
    if (method === "GET") return { json: { name: "a.md", sha: "s1", content: b64("data") } };
    if (method === "DELETE") return { json: {} };
    throw new Error("unexpected");
  });
  const out = await deleteHub({ path: "spec/a.md" });
  assert.deepEqual({ type: out.type, deleted: out.deleted }, { type: "file", deleted: 1 });
  const del = calls.find((c) => c.method === "DELETE");
  assert.equal(del.body.sha, "s1");
});

test("deleteHub: 폴더 → 트리로 하위 blob 열거 후 각 DELETE(prefix 매칭)", async () => {
  process.env.GITHUB_TOKEN = "tkn";
  const calls = installFetch((method, pathname) => {
    if (method === "GET" && pathname.includes("/git/trees/")) {
      return { json: { tree: [
        { type: "blob", path: "spec/old/a.md", sha: "a" },
        { type: "blob", path: "spec/old/sub/b.md", sha: "b" },
        { type: "blob", path: "spec/older/c.md", sha: "c" }, // prefix 유사하지만 spec/old/ 아님 → 제외
      ] } };
    }
    if (method === "GET") return { json: [] }; // stat → 배열(dir)
    if (method === "DELETE") return { json: {} };
    throw new Error("unexpected " + method + " " + pathname);
  });
  const out = await deleteHub({ path: "spec/old" });
  assert.equal(out.type, "dir");
  assert.equal(out.deleted, 2);
  assert.equal(out.total, 2);
  const deleted = calls.filter((c) => c.method === "DELETE").map((c) => decodeURIComponent(c.pathname.split("/contents/")[1]));
  assert.deepEqual(deleted.sort(), ["spec/old/a.md", "spec/old/sub/b.md"]);
});

test("renameHub: 파일 → dest PUT(내용 유지) + src DELETE", async () => {
  process.env.GITHUB_TOKEN = "tkn";
  const calls = installFetch((method, pathname) => {
    if (method === "GET" && pathname.endsWith("/contents/spec/a.md")) return { json: { name: "a.md", sha: "s1", content: b64("keep-me") } };
    if (method === "GET" && pathname.endsWith("/contents/spec/b.md")) return { status: 404, json: { message: "Not Found" } };
    if (method === "PUT") return { json: { content: { html_url: "https://gh/b" } } };
    if (method === "DELETE") return { json: {} };
    throw new Error("unexpected " + method + " " + pathname);
  });
  const out = await renameHub({ path: "spec/a.md", dest: "spec/b.md" });
  assert.equal(out.moved, 1);
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put.pathname.endsWith("/contents/spec/b.md"));
  assert.equal(deB64(put.body.content.replace(/\s/g, "")), "keep-me");
  const del = calls.find((c) => c.method === "DELETE");
  assert.ok(del.pathname.endsWith("/contents/spec/a.md"));
  assert.equal(del.body.sha, "s1");
});

test("listHub: 404 → 빈 목록, .gitkeep 숨김 + dir 우선 정렬", async () => {
  process.env.GITHUB_TOKEN = "tkn";
  installFetch((method, pathname) => {
    if (pathname.endsWith("/contents/none")) return { status: 404, json: { message: "Not Found" } };
    if (pathname.endsWith("/contents/spec")) return { json: [
      { name: "z.md", path: "spec/z.md", type: "file", sha: "1", size: 3 },
      { name: ".gitkeep", path: "spec/.gitkeep", type: "file", sha: "2", size: 0 },
      { name: "qm", path: "spec/qm", type: "dir", sha: "3", size: 0 },
    ] };
    throw new Error("unexpected");
  });
  const empty = await listHub({ path: "none" });
  assert.deepEqual(empty.items, []);
  const listed = await listHub({ path: "spec" });
  assert.deepEqual(listed.items.map((x) => x.name), ["qm", "z.md"]); // dir 먼저, .gitkeep 제외
});

test("토큰 없음 → 503 에러(호출 차단)", async () => {
  const saved = clearTokens();
  installFetch(() => ({ json: {} }));
  await assert.rejects(() => saveSpecToHub({ folder: "spec", title: "z", extension: "md", content: Buffer.from("z") }), (e) => {
    assert.equal(e.status, 503);
    assert.match(e.message, /GITHUB_TOKEN/);
    return true;
  });
  restoreTokens(saved);
});
