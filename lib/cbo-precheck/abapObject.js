// lib/cbo-precheck/abapObject.js — ABAP object classification shared by scan/preview API paths.
// Keep this separate from abaplint virtual naming: preview object type and lint object type are not identical.

function removeInlineComment(line) {
  let out = "";
  let inString = false;
  for (let i = 0; i < String(line || "").length; i++) {
    const ch = line[i];
    if (ch === "'") {
      out += ch;
      if (inString && line[i + 1] === "'") { out += line[i + 1]; i++; continue; }
      inString = !inString;
      continue;
    }
    if (ch === "\"" && !inString) break;
    out += ch;
  }
  return out;
}

export function stripAbapComments(source) {
  return String(source || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\*/.test(line))
    .map(removeInlineComment)
    .join("\n");
}

function firstStatement(source) {
  const cleaned = stripAbapComments(source);
  let buf = "";
  for (const line of cleaned.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    buf += (buf ? " " : "") + text;
    if (text.includes(".")) break;
  }
  const end = buf.indexOf(".");
  return (end >= 0 ? buf.slice(0, end + 1) : buf).trim();
}

function normalizeName(name) {
  return String(name || "").replace(/[."]+$/g, "").toUpperCase();
}

export function detectAbapObject(source, fileName = "") {
  const statement = firstStatement(source);
  const result = { type: "unknown", name: null, previewable: false };
  let match;

  if ((match = statement.match(/^REPORT\s+([A-Za-z_][\w/]*)\b/i))) {
    return { type: "report", name: normalizeName(match[1]), previewable: true };
  }
  if ((match = statement.match(/^PROGRAM\s+([A-Za-z_][\w/]*)\b/i))) {
    return { type: "report", name: normalizeName(match[1]), previewable: true };
  }
  if ((match = statement.match(/^FUNCTION-POOL\s+([A-Za-z_][\w/]*)\b/i))) {
    return { type: "function-pool", name: normalizeName(match[1]), previewable: true };
  }
  if ((match = statement.match(/^FUNCTION\s+([A-Za-z_][\w/]*)\b/i))) {
    return { type: "function-module", name: normalizeName(match[1]), previewable: true };
  }
  if ((match = statement.match(/^CLASS\s+([A-Za-z_][\w/]*)\s+DEFINITION\b/i))) {
    return { type: "class", name: normalizeName(match[1]), previewable: /\bPUBLIC\b/i.test(statement) };
  }
  if ((match = statement.match(/^INTERFACE\s+([A-Za-z_][\w/]*)\b/i))) {
    return { type: "interface", name: normalizeName(match[1]), previewable: true };
  }
  if (/^INCLUDE\s+[A-Za-z_][\w/]*\b/i.test(statement)) {
    return { type: "include", name: normalizeName(statement.split(/\s+/)[1]), previewable: false };
  }

  const base = String(fileName || "").split(/[\\/]/).pop()?.replace(/\.abap$/i, "");
  return { ...result, name: base ? normalizeName(base) : null };
}

export function isRfcDdicDoc(name) {
  return /(^|\/)[A-Za-z0-9_]+_DDIC\.txt$/i.test(String(name || "").replaceAll("\\", "/"));
}
