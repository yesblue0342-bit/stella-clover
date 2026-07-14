import crypto from "node:crypto";

// PROVIDER_MODELS/validateProviderModel은 lib/ai-connection/core.js(CBO Review·CBO Pre-Check 공용)로
// 이동했다 — 기존 이 파일의 import 구문(api/cbo-review.js 등)이 그대로 동작하도록 여기서 재-export한다.
export { PROVIDER_MODELS, validateProviderModel } from "../ai-connection/core.js";

export const TEXT_EXTENSIONS = new Set([
  ".abap", ".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".java", ".cs", ".go",
  ".rs", ".php", ".rb", ".sql", ".html", ".css", ".scss", ".sh", ".ps1", ".properties",
]);

export function sanitizeName(value, fallback = "CBO_SPEC") {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^[_\.\-]+|[_\.\-]+$/g, "")
    .slice(0, 90);
  return cleaned || fallback;
}

export function kstDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date).replaceAll("-", "");
}

export function extractMainTitle({ prompt = "", fileNames = [], generated = "" } = {}) {
  const joined = `${generated}\n${prompt}`;
  const program = joined.match(/\bZ[A-Z0-9_]{4,30}\b/i)?.[0];
  if (program) return program.toUpperCase();
  const heading = generated.match(/^#\s+(.+)$/m)?.[1] || prompt.split(/\r?\n/).find(Boolean);
  if (heading) return sanitizeName(heading);
  if (fileNames.length) return sanitizeName(fileNames[0]);
  return "CBO_SPEC";
}

export function specFileName({ title, extension = "md", date = new Date() }) {
  const ext = extension === "xlsx" ? "xlsx" : "md";
  return `spec_${kstDate(date)}_${sanitizeName(title)}.${ext}`;
}

export function assertSafeRelativePath(input) {
  const value = String(input || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!value || value.includes("\0") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("허용되지 않은 파일 경로입니다.");
  }
  if (/^[a-z]:/i.test(value)) throw new Error("절대 경로는 허용되지 않습니다.");
  return value;
}

export function detectLanguage(name, content = "") {
  const lower = String(name || "").toLowerCase();
  const sample = String(content).slice(0, 12000);
  if (lower.endsWith(".abap") || /\b(REPORT|CLASS|METHOD|FORM|SELECT-OPTIONS|PARAMETERS|DATA:)\b/i.test(sample)) return "ABAP";
  if (/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(lower)) return "JavaScript/TypeScript";
  if (lower.endsWith(".py")) return "Python";
  if (lower.endsWith(".java")) return "Java";
  if (lower.endsWith(".cs")) return "C#";
  if (lower.endsWith(".sql")) return "SQL";
  return "General";
}

export function chunkSource(file, maxChars = 18000) {
  const content = String(file.content || "");
  if (content.length <= maxChars) return [{ ...file, startLine: 1, chunked: false }];
  const lines = content.split("\n");
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && size + lines[end].length + 1 <= maxChars) {
      size += lines[end].length + 1;
      end += 1;
    }
    if (end === start) end += 1;
    chunks.push({ name: file.name, content: lines.slice(start, end).join("\n"), startLine: start + 1, chunked: true });
    start = end;
  }
  return chunks;
}

export function parseJsonObject(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(raw); } catch {}
  const from = raw.indexOf("{");
  const to = raw.lastIndexOf("}");
  if (from >= 0 && to > from) return JSON.parse(raw.slice(from, to + 1));
  throw new Error("AI 응답을 구조화된 결과로 해석할 수 없습니다.");
}

export function normalizeFindings(value, fileName, startLine = 1) {
  const rows = Array.isArray(value?.findings) ? value.findings : [];
  return rows.slice(0, 200).map((row, index) => ({
    id: `${crypto.createHash("sha1").update(`${fileName}:${startLine}:${index}:${row.reason || ""}`).digest("hex").slice(0, 12)}`,
    file: fileName,
    line: Math.max(1, Number(row.line || 1) + startLine - 1),
    severity: ["High", "Mid", "Low"].includes(row.severity) ? row.severity : "Low",
    reason: String(row.reason || "확인 필요").slice(0, 2000),
    before: String(row.before || "").slice(0, 8000),
    after: String(row.after || "").slice(0, 8000),
  })).filter((row) => row.before && row.after && row.before !== row.after);
}

export function applyFindings(content, findings) {
  let next = String(content || "");
  const applied = [];
  const skipped = [];
  const ordered = [...(findings || [])].sort((a, b) => Number(b.line || 1) - Number(a.line || 1));
  for (const finding of ordered) {
    const before = String(finding.before || "");
    if (!before) { skipped.push(finding.id); continue; }
    const expected = next.split("\n").slice(0, Math.max(0, Number(finding.line || 1) - 1)).join("\n").length;
    const positions = []; let cursor = 0;
    while ((cursor = next.indexOf(before, cursor)) >= 0) { positions.push(cursor); cursor += Math.max(1, before.length); }
    if (!positions.length) { skipped.push(finding.id); continue; }
    const position = positions.sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected))[0];
    next = next.slice(0, position) + String(finding.after || "") + next.slice(position + before.length);
    applied.push(finding.id);
  }
  return { content: next, applied, skipped };
}

export function sha256(content) {
  return crypto.createHash("sha256").update(String(content || "")).digest("hex");
}

export function buildSpecPrompt({ prompt, attachments }) {
  const sources = attachments.map((f) => `\n--- ATTACHMENT: ${f.name} ---\n${f.content}`).join("\n");
  return `다음 요구사항과 첨부를 바탕으로 실무용 프로그램 기능 스펙을 Markdown으로 작성하라.
ABAP이면 반드시 다음 섹션을 모두 포함한다: 프로그램 개요, 업무요구(BR), As-Is/To-Be, 화면 설계, 처리 로직, 데이터 매핑, 오류 처리, 권한, 테스트 시나리오(정상/오류혼합/시뮬레이션), 미결사항, 변경 이력.
ABAP이 아니면 기술 스택에 맞춰 섹션 명칭과 세부 내용을 조정하되 동일 수준의 완결성을 유지한다.
확인되지 않은 SAP 테이블/필드/BAPI는 지어내지 말고 '확인 필요'로 표시한다. 출력은 Markdown 본문만 작성한다.

요구사항:
${String(prompt || "(첨부 기준으로 작성)").slice(0, 50000)}
${sources}`;
}

export function buildReviewPrompt({ name, content, language, startLine }) {
  const abap = language === "ABAP" ? `ABAP 기준: SELECT * 금지, LOOP 내 SELECT, FOR ALL ENTRIES empty 검사, READ/SELECT 후 sy-subrc, BAPI RETURN과 commit/rollback, 하드코딩, AUTHORITY-CHECK, COMMIT WORK 위치, GxP before-image 캡처 순서와 변경이력, simulation/ALV를 검토하라.` : `${language}의 최신 일반 코딩·보안·성능·예외처리 기준으로 검토하라.`;
  return `파일 ${name}의 소스를 리뷰하라. 시작 라인은 ${startLine}이다. ${abap}
JSON만 반환하라: {"summary":"한 줄 요약","findings":[{"line":1,"severity":"High|Mid|Low","reason":"이유","before":"원문과 정확히 일치하는 최소 문자열","after":"대체할 전체 문자열"}]}.
존재하지 않는 코드를 만들지 말고, 확실한 수정만 findings에 포함한다. line은 이 조각 기준 1부터 시작한다.

SOURCE:
${content}`;
}
