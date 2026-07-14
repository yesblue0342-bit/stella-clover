// lib/cbo-precheck/github.js — GitHub REST API 클라이언트(브랜치 생성 → 파일 커밋 → PR 생성/close).
//
// ★ main 직접 커밋 경로는 존재하지 않는다(항상 branch → PR). GITHUB_TOKEN 없으면 모든 함수가 명확한
// 오류를 던지고, 호출부(api/cbo-precheck.js)가 이를 UI 비활성 사유로 그대로 전달한다(절대 규칙 5).
const API = "https://api.github.com";

export function hasGithubToken() {
  return !!String(process.env.GITHUB_TOKEN || "").trim();
}

export function parseGithubSshUrl(repoUrl) {
  const match = /^git@[\w.-]+:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(String(repoUrl || "").trim());
  if (!match) throw new Error("SSH 형식 GitHub URL에서 owner/repo를 파싱할 수 없습니다.");
  return { owner: match[1], repo: match[2] };
}

async function ghFetch(path, { method = "GET", body, token, fetchImpl = fetch } = {}) {
  if (!token) throw new Error("GITHUB_TOKEN이 설정되지 않았습니다.");
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "stella-clover-cbo-precheck",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`GitHub API 오류(${res.status}): ${json.message || text || "알 수 없는 오류"}`);
  return json;
}

export async function getBranchSha(owner, repo, branch, opts) {
  const ref = await ghFetch(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, opts);
  return ref.object.sha;
}

export async function createBranch(owner, repo, newBranch, fromSha, opts) {
  return ghFetch(`/repos/${owner}/${repo}/git/refs`, {
    ...opts, method: "POST",
    body: { ref: `refs/heads/${newBranch}`, sha: fromSha },
  });
}

export async function getFile(owner, repo, filePath, ref, opts) {
  const data = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath).replaceAll("%2F", "/")}?ref=${encodeURIComponent(ref)}`, opts);
  return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
}

export async function putFile(owner, repo, filePath, branch, content, message, sha, opts) {
  return ghFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath).replaceAll("%2F", "/")}`, {
    ...opts, method: "PUT",
    body: { message, content: Buffer.from(content, "utf8").toString("base64"), branch, sha },
  });
}

export async function createPullRequest(owner, repo, { title, head, base = "main", body }, opts) {
  return ghFetch(`/repos/${owner}/${repo}/pulls`, {
    ...opts, method: "POST",
    body: { title, head, base, body },
  });
}

export async function closePullRequest(owner, repo, number, opts) {
  return ghFetch(`/repos/${owner}/${repo}/pulls/${number}`, {
    ...opts, method: "PATCH",
    body: { state: "closed" },
  });
}

// 브랜치 생성 → 대상 파일들 커밋 → PR 생성까지 한 번에. files: [{ path, content, originalSha }].
export async function openFixPullRequest({ owner, repo, base = "main", branchName, files, title, body }, opts) {
  const baseSha = await getBranchSha(owner, repo, base, opts);
  await createBranch(owner, repo, branchName, baseSha, opts);
  for (const file of files) {
    await putFile(owner, repo, file.path, branchName, file.content, `fix(cbo-precheck): ${file.path}`, file.originalSha, opts);
  }
  return createPullRequest(owner, repo, { title, head: branchName, base, body }, opts);
}
