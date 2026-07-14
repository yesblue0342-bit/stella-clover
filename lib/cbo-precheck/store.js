// lib/cbo-precheck/store.js — 스캔 결과 인메모리 캐시(scanId → 결과).
//
// DB 스키마 추가 없이 lib/cbo-review/cbo-review.js 의 `reviews = new Map()` 패턴을 그대로 따른다
// (기존 모듈 불가침 원칙상 새 테이블을 만들기보다 동일 패턴의 독립 Map 을 쓰는 편이 접점이 작다).
// 서버 재시작 시 초기화되지만, 스캔은 수 초~수십 초 내 재실행 가능한 멱등 작업이라 영속성이 필수는 아니다.
import crypto from "node:crypto";

const MAX_SCANS = 30;
const scans = new Map();

export function saveScan({ repoUrl, branch, path, issues, fileCount }) {
  const scanId = crypto.randomUUID();
  scans.set(scanId, {
    scanId,
    repoUrl,
    branch,
    path,
    fileCount,
    issues: issues.map((issue, i) => ({ ...issue, id: `${scanId}-${i}`, status: "open", note: "" })),
    createdAt: Date.now(),
  });
  while (scans.size > MAX_SCANS) scans.delete(scans.keys().next().value);
  return scanId;
}

export function getScan(scanId) {
  return scans.get(String(scanId || "")) || null;
}

export function updateIssue(scanId, issueId, { status, note }) {
  const scan = getScan(scanId);
  if (!scan) throw new Error("스캔 결과를 찾을 수 없습니다(만료되었을 수 있습니다).");
  const issue = scan.issues.find((i) => i.id === issueId);
  if (!issue) throw new Error("해당 이슈를 찾을 수 없습니다.");
  if (status !== undefined) issue.status = status;
  if (note !== undefined) issue.note = String(note).slice(0, 2000);
  return issue;
}

export function listScans() {
  return [...scans.values()].map(({ issues, ...meta }) => ({ ...meta, issueCount: issues.length }));
}
