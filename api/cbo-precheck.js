// api/cbo-precheck.js — CBO Pre-Check: abaplint 스캔 + 내보내기.
//
// server.mjs 라우팅은 /api/<단일세그먼트> 만 허용(하위 경로 없음) — 미션 문서의
// `POST /api/cbo-precheck/scan` 형태 대신 기존 cbo-review.js 관례(action 쿼리 파라미터)를 따른다.
import { scanFiles, buildConfig } from "../lib/cbo-precheck/scan.js";
import { withClonedRepo, collectAbapFiles } from "../lib/cbo-precheck/repoFetch.js";
import { saveScan, getScan, updateIssue } from "../lib/cbo-precheck/store.js";
import { exportScan, CONTENT_TYPES } from "../lib/cbo-precheck/exportFormats.js";

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
  const scanId = saveScan({ repoUrl, branch, path: subPath, issues, fileCount });
  const scan = getScan(scanId);
  return json(res, 200, { ok: true, scanId, issues: scan.issues, fileCount, repoUrl, branch, path: subPath });
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

export default async function handler(req, res) {
  const action = String(req.query.action || "scan");
  try {
    if (req.method === "POST" && action === "scan") return await handleScan(req, res);
    if (req.method === "GET" && action === "export") return await handleExport(req, res);
    if (req.method === "POST" && action === "issue-update") return await handleIssueUpdate(req, res);
    if (req.method === "GET" && action === "scan-get") {
      const scan = getScan(String(req.query.scanId || ""));
      if (!scan) return json(res, 404, { ok: false, message: "스캔 결과를 찾을 수 없습니다." });
      return json(res, 200, { ok: true, ...scan });
    }
    return json(res, 404, { ok: false, message: `알 수 없는 action: ${action}` });
  } catch (e) {
    console.error("[api/cbo-precheck]", e);
    return json(res, 500, { ok: false, message: String(e?.message || e) });
  }
}

export const config = { maxDuration: 300 };
