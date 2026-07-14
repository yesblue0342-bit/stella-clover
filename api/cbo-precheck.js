// api/cbo-precheck.js — CBO Pre-Check: abaplint 스캔 + 내보내기.
//
// server.mjs 라우팅은 /api/<단일세그먼트> 만 허용(하위 경로 없음) — 미션 문서의
// `POST /api/cbo-precheck/scan` 형태 대신 기존 cbo-review.js 관례(action 쿼리 파라미터)를 따른다.
import crypto from "node:crypto";
import { scanFiles, buildConfig, isScannable } from "../lib/cbo-precheck/scan.js";
import { withClonedRepo, collectAbapFiles } from "../lib/cbo-precheck/repoFetch.js";
import { saveScan, getScan, updateIssue } from "../lib/cbo-precheck/store.js";
import { exportScan, CONTENT_TYPES } from "../lib/cbo-precheck/exportFormats.js";
import { applyIssuesToFile } from "../lib/cbo-precheck/applyFix.js";
import { hasGithubToken, parseGithubSshUrl, getFile, openFixPullRequest } from "../lib/cbo-precheck/github.js";
import { hasAnthropicKey, suggestFix } from "../lib/cbo-precheck/anthropic.js";
import { hasAccessPassword, login, requireAuth } from "../lib/cbo-precheck/auth.js";
import { parsePreview } from "../lib/cbo-precheck/preview.js";

function json(res, status, value) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json(value);
}

async function handleScan(req, res) {
  const repoUrl = String(req.body?.repoUrl || "").trim();
  const branch = String(req.body?.branch || "main").trim();
  const subPath = String(req.body?.path || "").trim();
  if (!repoUrl) return json(res, 400, { ok: false, message: "repoUrl이 필요합니다." });

  let files;
  try {
    files = await withClonedRepo({ repoUrl, branch, path: subPath }, (root) => collectAbapFiles(root));
  } catch (e) {
    return json(res, 400, { ok: false, message: String(e?.message || e) });
  }
  if (!files.length) return json(res, 200, { ok: true, scanId: null, issues: [], fileCount: 0, message: "ABAP 소스 또는 DDIC 파일을 찾지 못했습니다." });

  const hasDdic = files.some((f) => f.isDdic);
  const config = buildConfig({ rules: { ...buildConfig().rules, check_ddic: hasDdic } });
  const { issues, fileCount } = scanFiles({ files, config });
  const scannable = files.filter((f) => isScannable(f.name));
  const scannedFiles = scannable.map((f) => f.name);
  const fileContents = Object.fromEntries(scannable.map((f) => [f.name, f.content]));
  const scanId = saveScan({ repoUrl, branch, path: subPath, issues, fileCount, files: scannedFiles, fileContents });
  const scan = getScan(scanId);
  return json(res, 200, { ok: true, scanId, issues: scan.issues, fileCount, files: scannedFiles, repoUrl, branch, path: subPath });
}

async function handleExport(req, res) {
  const scanId = String(req.query.scanId || "");
  const format = String(req.query.format || "xlsx");
  const scan = getScan(scanId);
  if (!scan) return json(res, 404, { ok: false, message: "스캔 결과를 찾을 수 없습니다(만료되었을 수 있습니다)." });
  if (!["xlsx", "md", "txt", "json"].includes(format)) return json(res, 400, { ok: false, message: `지원하지 않는 포맷: ${format}` });

  let body;
  try {
    body = await exportScan(scan.issues, format, { title: `CBO Pre-Check — ${scan.repoUrl}`, scanId });
  } catch (e) {
    return json(res, 500, { ok: false, message: String(e?.message || e) });
  }
  res.setHeader("Content-Type", CONTENT_TYPES[format]);
  res.setHeader("Content-Disposition", `attachment; filename="cbo-precheck-${scanId}.${format}"`);
  return res.status(200).send(body);
}

async function handleIssueUpdate(req, res) {
  const scanId = String(req.body?.scanId || "");
  const issueId = String(req.body?.issueId || "");
  const status = req.body?.status !== undefined ? String(req.body.status) : undefined;
  const note = req.body?.note !== undefined ? String(req.body.note) : undefined;
  try {
    const issue = updateIssue(scanId, issueId, { status, note });
    return json(res, 200, { ok: true, issue });
  } catch (e) {
    return json(res, 400, { ok: false, message: String(e?.message || e) });
  }
}

function ghOpts() {
  return { token: process.env.GITHUB_TOKEN };
}

function issueBranchName(prefix, scanId) {
  return `precheck/${prefix}-${scanId.slice(0, 8)}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
}

function scanAndFileIssues(req) {
  const scanId = String(req.body?.scanId || "");
  const file = String(req.body?.file || "");
  const scan = getScan(scanId);
  if (!scan) throw new Error("스캔 결과를 찾을 수 없습니다(만료되었을 수 있습니다).");
  const issueIds = Array.isArray(req.body?.issueIds) ? req.body.issueIds.map(String) : null;
  const issues = scan.issues.filter((i) => i.file === file && i.status === "open" && (!issueIds || issueIds.includes(i.id)));
  if (!issues.length) throw new Error("대상 이슈가 없습니다(이미 처리되었거나 존재하지 않습니다).");
  return { scan, issues };
}

// [자동 수정 PR]: abaplint 자체 quickfix(fixEdits)만 적용 — AI 호출 없음, 결정적(deterministic).
async function handleFixAuto(req, res) {
  if (!hasGithubToken()) return json(res, 503, { ok: false, message: "GITHUB_TOKEN이 설정되지 않아 PR 생성을 사용할 수 없습니다." });
  let scan, issues;
  try { ({ scan, issues } = scanAndFileIssues(req)); } catch (e) { return json(res, 400, { ok: false, message: String(e.message) }); }

  const fixable = issues.filter((i) => i.quickfixAvailable && i.fixEdits);
  if (!fixable.length) return json(res, 400, { ok: false, message: "선택된 이슈 중 자동 수정 가능한 항목이 없습니다." });

  const { owner, repo } = parseGithubSshUrl(scan.repoUrl);
  const targetPath = scan.path ? `${scan.path}/${fixable[0].file}` : fixable[0].file;
  try {
    const { content: current, sha } = await getFile(owner, repo, targetPath, scan.branch, ghOpts());
    const { content, applied, skipped } = applyIssuesToFile(current, fixable);
    const branchName = issueBranchName("auto", scan.scanId);
    const ruleList = [...new Set(fixable.map((i) => i.rule))].join(", ");
    const pr = await openFixPullRequest({
      owner, repo, base: scan.branch, branchName,
      files: [{ path: targetPath, content, originalSha: sha }],
      title: `fix(cbo-precheck): auto-fix ${fixable[0].file} (${ruleList})`,
      body: `CBO Pre-Check 자동 수정 PR입니다.\n\n적용된 abaplint quickfix:\n${fixable.map((i) => `- L${i.line} [${i.rule}] ${i.message}`).join("\n")}\n\n이 PR은 자동 생성되었습니다 — 병합 전 리뷰가 필요합니다.`,
    }, ghOpts());
    for (const issue of fixable) updateIssue(scan.scanId, issue.id, { status: "resolved", note: `PR #${pr.number}` });
    return json(res, 200, { ok: true, pr: { number: pr.number, url: pr.html_url }, applied, skipped });
  } catch (e) {
    return json(res, 502, { ok: false, message: String(e?.message || e) });
  }
}

// [Claude 수정 PR] 1단계: AI 제안만 생성해 diff 미리보기로 반환(PR 생성 없음 — 사용자가 확정해야 진행).
async function handleFixClaudePreview(req, res) {
  if (!hasAnthropicKey()) return json(res, 503, { ok: false, message: "ANTHROPIC_API_KEY가 설정되지 않아 Claude 수정 제안을 사용할 수 없습니다." });
  let scan, issues;
  try { ({ scan, issues } = scanAndFileIssues(req)); } catch (e) { return json(res, 400, { ok: false, message: String(e.message) }); }

  const { owner, repo } = parseGithubSshUrl(scan.repoUrl);
  const targetPath = scan.path ? `${scan.path}/${issues[0].file}` : issues[0].file;
  try {
    const { content: original, sha } = await getFile(owner, repo, targetPath, scan.branch, ghOpts());
    const suggested = await suggestFix({ fileName: issues[0].file, source: original, issues });
    return json(res, 200, { ok: true, file: issues[0].file, originalSha: sha, original, suggested });
  } catch (e) {
    return json(res, 502, { ok: false, message: String(e?.message || e) });
  }
}

// [Claude 수정 PR] 2단계: 사용자가 diff 확인 후 확정한 내용으로만 branch+PR 생성.
async function handleFixClaudeConfirm(req, res) {
  if (!hasGithubToken()) return json(res, 503, { ok: false, message: "GITHUB_TOKEN이 설정되지 않아 PR 생성을 사용할 수 없습니다." });
  const scanId = String(req.body?.scanId || "");
  const file = String(req.body?.file || "");
  const content = req.body?.content;
  const originalSha = String(req.body?.originalSha || "");
  const scan = getScan(scanId);
  if (!scan) return json(res, 400, { ok: false, message: "스캔 결과를 찾을 수 없습니다." });
  if (typeof content !== "string" || !content.trim()) return json(res, 400, { ok: false, message: "확정할 소스 내용이 필요합니다." });

  const { owner, repo } = parseGithubSshUrl(scan.repoUrl);
  const targetPath = scan.path ? `${scan.path}/${file}` : file;
  const relatedIssues = scan.issues.filter((i) => i.file === file && i.status === "open");
  try {
    const branchName = issueBranchName("claude", scan.scanId);
    const pr = await openFixPullRequest({
      owner, repo, base: scan.branch, branchName,
      files: [{ path: targetPath, content, originalSha }],
      title: `fix(cbo-precheck): AI-assisted fix ${file}`,
      body: `CBO Pre-Check "Claude 수정 PR" 기능으로 생성되었습니다(사용자 확인 후 생성) — 병합 전 리뷰가 필요합니다.\n\n대상 이슈:\n${relatedIssues.map((i) => `- L${i.line} [${i.rule}] ${i.message}`).join("\n")}`,
    }, ghOpts());
    for (const issue of relatedIssues) updateIssue(scan.scanId, issue.id, { status: "resolved", note: `PR #${pr.number}` });
    return json(res, 200, { ok: true, pr: { number: pr.number, url: pr.html_url } });
  } catch (e) {
    return json(res, 502, { ok: false, message: String(e?.message || e) });
  }
}

async function handlePreview(req, res) {
  const scanId = String(req.body?.scanId || "");
  const file = String(req.body?.file || "");
  const scan = getScan(scanId);
  if (!scan) return json(res, 404, { ok: false, message: "스캔 결과를 찾을 수 없습니다(만료되었을 수 있습니다)." });
  const source = scan.fileContents?.[file];
  if (source === undefined) return json(res, 404, { ok: false, message: "해당 파일의 소스를 찾을 수 없습니다(스캔 결과에 없는 파일)." });
  try {
    const result = parsePreview(source, file);
    return json(res, 200, { ok: true, ...result });
  } catch (e) {
    return json(res, 500, { ok: false, message: String(e?.message || e) });
  }
}

export default async function handler(req, res) {
  const action = String(req.query.action || "scan");
  try {
    if (req.method === "POST" && action === "login") {
      if (!hasAccessPassword()) return json(res, 200, { ok: true, token: null });
      try { return json(res, 200, { ok: true, token: login(req.body?.password) }); }
      catch (e) { return json(res, 401, { ok: false, message: String(e?.message || e) }); }
    }
    if (!requireAuth(req, res)) return;

    if (req.method === "POST" && action === "scan") return await handleScan(req, res);
    if (req.method === "GET" && action === "export") return await handleExport(req, res);
    if (req.method === "POST" && action === "issue-update") return await handleIssueUpdate(req, res);
    if (req.method === "POST" && action === "fix-auto") return await handleFixAuto(req, res);
    if (req.method === "POST" && action === "fix-claude-preview") return await handleFixClaudePreview(req, res);
    if (req.method === "POST" && action === "fix-claude-confirm") return await handleFixClaudeConfirm(req, res);
    if (req.method === "GET" && action === "capabilities") {
      return json(res, 200, { ok: true, githubToken: hasGithubToken(), anthropicKey: hasAnthropicKey() });
    }
    if (req.method === "GET" && action === "scan-get") {
      const scan = getScan(String(req.query.scanId || ""));
      if (!scan) return json(res, 404, { ok: false, message: "스캔 결과를 찾을 수 없습니다." });
      const { fileContents, ...safe } = scan;
      return json(res, 200, { ok: true, ...safe });
    }
    if (req.method === "POST" && action === "preview") return await handlePreview(req, res);
    return json(res, 404, { ok: false, message: `알 수 없는 action: ${action}` });
  } catch (e) {
    console.error("[api/cbo-precheck]", e);
    return json(res, 500, { ok: false, message: String(e?.message || e) });
  }
}

export const config = { maxDuration: 300 };
