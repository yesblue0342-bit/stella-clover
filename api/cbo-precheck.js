// api/cbo-precheck.js — CBO Pre-Check: abaplint 스캔 + 내보내기.
//
// server.mjs 라우팅은 /api/<단일세그먼트> 만 허용(하위 경로 없음) — 미션 문서의
// `POST /api/cbo-precheck/scan` 형태 대신 기존 cbo-review.js 관례(action 쿼리 파라미터)를 따른다.
import crypto from "node:crypto";
import { scanFiles, buildConfig, isScannable, isAbapSource, hasReportStatement } from "../lib/cbo-precheck/scan.js";
import { withClonedRepo, collectAbapFiles } from "../lib/cbo-precheck/repoFetch.js";
import { saveScan, getScan, updateIssue } from "../lib/cbo-precheck/store.js";
import { exportScan, CONTENT_TYPES } from "../lib/cbo-precheck/exportFormats.js";
import { applyIssuesToFile } from "../lib/cbo-precheck/applyFix.js";
import { hasGithubToken, parseGithubSshUrl, getFile, openFixPullRequest } from "../lib/cbo-precheck/github.js";
import { hasAiConnection, suggestFix } from "../lib/cbo-precheck/aiFix.js";
import {
  connectCli, deleteProviderKey, disconnectCli, providerStatus, saveProviderKey,
} from "../lib/ai-connection/providers.js";
import { hasAccessPassword, login, requireAuth } from "../lib/cbo-precheck/auth.js";
import { buildPreview } from "../lib/cbo-precheck/preview.js";

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

  const hasDdic = files.some((f) => f.isDdic || f.isDict);
  const config = buildConfig({ rules: { ...buildConfig().rules, check_ddic: hasDdic } });
  const { issues, fileCount } = scanFiles({ files, config });
  const scannable = files.filter((f) => isScannable(f.name));
  const scannedFiles = scannable.map((f) => f.name);
  const fileContents = Object.fromEntries(scannable.map((f) => [f.name, f.content]));
  const scanId = saveScan({ repoUrl, branch, path: subPath, issues, fileCount, files: scannedFiles, fileContents, collectedFiles: files });
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
  if (!(await hasAiConnection())) return json(res, 503, { ok: false, message: "AI 연결이 필요합니다 — [AI 연결 설정]에서 로그인하세요." });
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
    const result = buildPreview(file, source, scan.collectedFiles || []);
    return json(res, 200, { ok: true, ...result });
  } catch (e) {
    return json(res, 500, { ok: false, message: String(e?.message || e) });
  }
}

// [화면 미리보기 독립 실행 — Phase 3, 폴더 경로는 Phase 2] 사전 스캔 없이 GitHub SSH URL/브랜치/경로만으로
// 즉시 미리보기를 생성한다. `path`는 파일(`*.abap`로 끝남) 또는 폴더 둘 다 받는다 — 파일이면 기존과 동일하게
// 그 파일이 속한 폴더 전체를 clone해 같은 폴더의 INCLUDE 형제/TEXTS 문서를 찾아 병합 렌더링한다(회귀 없음).
// 폴더면 그 폴더를 통째로 clone해 하위 전체에서 메인 프로그램(REPORT/PROGRAM 문 포함)을 자동으로 찾는다
// (WORK_REPORT.md 2026-07-14 "실패 재작업" 세션 — 직전 세션은 이 분기 자체가 없어 폴더만 넣으면 항상 404였다).
// GITHUB_TOKEN 불필요(SSH 배포키 clone만, action=scan과 동일).
async function handlePreviewDirect(req, res) {
  const repoUrl = String(req.body?.repoUrl || "").trim();
  const branch = String(req.body?.branch || "main").trim();
  const rawPath = String(req.body?.path || "").trim();
  if (!repoUrl) return json(res, 400, { ok: false, message: "repoUrl이 필요합니다." });
  if (!rawPath) return json(res, 400, { ok: false, message: "미리볼 경로가 필요합니다(폴더 또는 파일)." });

  const normalizedPath = rawPath.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const isFilePath = isAbapSource(normalizedPath);

  if (isFilePath) {
    const slashIdx = normalizedPath.lastIndexOf("/");
    const baseName = slashIdx >= 0 ? normalizedPath.slice(slashIdx + 1) : normalizedPath;
    const dirPath = slashIdx >= 0 ? normalizedPath.slice(0, slashIdx) : "";

    let files;
    try {
      files = await withClonedRepo({ repoUrl, branch, path: dirPath }, (root) => collectAbapFiles(root));
    } catch (e) {
      return json(res, 400, { ok: false, message: String(e?.message || e) });
    }
    const file = files.find((f) => f.name === baseName && !f.isDdic && !f.isTexts && !f.isDict);
    if (!file) return json(res, 404, { ok: false, message: "ABAP 소스 파일을 찾지 못했습니다(경로를 확인하세요)." });

    try {
      const result = buildPreview(file.name, file.content, files);
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 500, { ok: false, message: String(e?.message || e) });
    }
  }

  // 폴더 경로 — 하위 전체를 clone해 메인 프로그램을 자동 탐지한다.
  let files;
  try {
    files = await withClonedRepo({ repoUrl, branch, path: normalizedPath }, (root) => collectAbapFiles(root));
  } catch (e) {
    return json(res, 400, { ok: false, message: String(e?.message || e) });
  }
  const mainFiles = files.filter((f) => isAbapSource(f.name) && !f.isDdic && !f.isTexts && !f.isDict && hasReportStatement(f.content));
  if (!mainFiles.length) return json(res, 404, { ok: false, message: "이 폴더에서 메인 프로그램(REPORT/PROGRAM 문이 있는 .abap 파일)을 찾지 못했습니다." });

  if (mainFiles.length === 1) {
    try {
      const result = buildPreview(mainFiles[0].name, mainFiles[0].content, files);
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 500, { ok: false, message: String(e?.message || e) });
    }
  }

  // 메인 프로그램이 여러 개면(예: ZAQMR0130.abap + ZAQMR0131.abap) 전부 렌더링한다 — 사용자 선택 UI보다
  // 구현이 단순하고, 스펙 문서 작성 시 어차피 전부 확인해야 하므로 한 번에 보여주는 쪽을 택했다.
  const previews = mainFiles.map((file) => {
    try {
      return { ok: true, file: file.name, ...buildPreview(file.name, file.content, files) };
    } catch (e) {
      return { ok: false, file: file.name, message: String(e?.message || e) };
    }
  });
  return json(res, 200, { ok: true, multi: true, previews });
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
      return json(res, 200, { ok: true, githubToken: hasGithubToken(), aiConnected: await hasAiConnection() });
    }
    // AI 연결 설정 — CBO Review(api/cbo-review.js)와 완전히 동일한 공용 모듈(lib/ai-connection/providers.js)을
    // 그대로 호출한다(동일 저장소 공유 — 한쪽에서 연결하면 다른 쪽에도 즉시 반영).
    if (req.method === "GET" && action === "settings") {
      return json(res, 200, { ok: true, providers: await providerStatus() });
    }
    if (req.method === "POST" && action === "provider-save") {
      await saveProviderKey(String(req.body?.provider || ""), req.body?.key);
      return json(res, 200, { ok: true, providers: await providerStatus() });
    }
    if (req.method === "POST" && action === "provider-delete") {
      await deleteProviderKey(String(req.body?.provider || ""));
      return json(res, 200, { ok: true, providers: await providerStatus() });
    }
    if (req.method === "POST" && action === "cli-connect") {
      await connectCli(String(req.body?.provider || ""));
      return json(res, 200, { ok: true, providers: await providerStatus() });
    }
    if (req.method === "POST" && action === "cli-disconnect") {
      await disconnectCli(String(req.body?.provider || ""));
      return json(res, 200, { ok: true, providers: await providerStatus() });
    }
    if (req.method === "GET" && action === "scan-get") {
      const scan = getScan(String(req.query.scanId || ""));
      if (!scan) return json(res, 404, { ok: false, message: "스캔 결과를 찾을 수 없습니다." });
      const { fileContents, collectedFiles, ...safe } = scan;
      return json(res, 200, { ok: true, ...safe });
    }
    if (req.method === "POST" && action === "preview") return await handlePreview(req, res);
    if (req.method === "POST" && action === "preview-direct") return await handlePreviewDirect(req, res);
    return json(res, 404, { ok: false, message: `알 수 없는 action: ${action}` });
  } catch (e) {
    console.error("[api/cbo-precheck]", e);
    return json(res, 500, { ok: false, message: String(e?.message || e) });
  }
}

export const config = { maxDuration: 300 };
