// lib/chunkStore.js — 오디오 청크 로컬 디스크 저장 (OCI 인프로세스 워커 전용)
//
// ★ 왜: 과거에는 청크를 Google Drive 에 올리고(chunk-upload) 워커가 다시 내려받아(jobs-runtime) 전사했다.
//   그런데 Drive OAuth(client_id/secret/refresh_token) 가 하나라도 어긋나면 토큰 교환이 `invalid_client`
//   로 거절되어 **전사 자체가 시작도 못 하고 전부 실패**했다(사용자 보고: "구간 1/N 업로드 실패: invalid_client").
//   OCI 는 Vercel 과 달리 장수(長壽) 프로세스 + 동일 파일시스템이므로, 청크를 Drive 로 왕복시킬 이유가 없다.
//   → 청크는 서버 로컬 디스크에 저장하고 워커가 직접 읽는다. **Drive 인증 장애와 무관하게 전사가 동작**한다.
//   (최종 회의록 텍스트만 Drive 에 백업하며, 그 단계는 이미 실패해도 graceful — summarize.js warnings.)
//
// ref id 포맷: "local:<sessionId>/<NNN><ext>"  (예: "local:abc123/000.wav")
//   - 레거시(Drive) ref(순수 파일 id)와 구분되어 jobs-runtime/audio 가 분기 처리 → 무중단 호환.
//   - 보존: cleanup 이 보존기간 지난 파일 정리(Drive Audio 폴더 정리와 동일 정책).
import fs from "fs";
import path from "path";

// 청크 저장 루트. 기본은 앱 디렉터리 하위 data/chunks. 도커 볼륨 마운트 시 재배포에도 유지(run-stella-oci.sh).
export const CHUNK_DIR = process.env.CHUNK_DIR || path.resolve(process.cwd(), "data", "chunks");
const PREFIX = "local:";

// 경로 세그먼트 안전화: 영숫자/._- 만 허용, 비거나 . / .. 면 fallback (경로 탈출 차단).
function sanitizeSeg(s, fallback) {
  const v = String(s == null ? "" : s).replace(/[^a-zA-Z0-9_.-]/g, "");
  return (v && v !== "." && v !== "..") ? v : fallback;
}

// 오디오 확장자 화이트리스트(chunk-upload 와 동일). 이외(.sh/.js 등)는 .wav 로 강제 — 임의 파일명 방지.
const AUDIO_EXTS = new Set([".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm", ".ogg", ".aac"]);

export function isLocalRef(id) {
  return typeof id === "string" && id.startsWith(PREFIX);
}

// 청크 1개 저장 → ref id 문자열 반환. (index 는 0패딩 3자리, ext 는 오디오 화이트리스트)
export async function saveChunk({ sessionId, index, ext, buffer }) {
  const sess = sanitizeSeg(sessionId, "sess");
  const lower = String(ext || "").toLowerCase();
  const safeExt = AUDIO_EXTS.has(lower) ? lower : ".wav";
  const idx = Math.max(0, parseInt(index, 10) || 0);
  const name = String(idx).padStart(3, "0") + safeExt;
  const dir = path.join(CHUNK_DIR, sess);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, name), buffer);
  return `${PREFIX}${sess}/${name}`;
}

// ref id 로 청크 바이트 읽기. CHUNK_DIR 밖을 가리키면 거부(경로 탈출 방지).
export async function readChunk(id) {
  if (!isLocalRef(id)) throw new Error("로컬 청크 ref 가 아닙니다");
  const rel = String(id).slice(PREFIX.length);
  const slash = rel.indexOf("/");
  const sess = sanitizeSeg(slash >= 0 ? rel.slice(0, slash) : "", "");
  const name = sanitizeSeg(slash >= 0 ? rel.slice(slash + 1) : rel, "");
  if (!sess || !name) throw new Error("잘못된 청크 ref");
  const root = path.resolve(CHUNK_DIR) + path.sep;
  const abs = path.resolve(path.join(CHUNK_DIR, sess, name));
  if (!abs.startsWith(root)) throw new Error("청크 경로 범위 위반");
  return await fs.promises.readFile(abs);
}

// ── 원본 파일 바이트 파트 (신규 업로드 흐름) ─────────────────────────────
// 클라이언트가 원본 오디오 파일을 File.slice 바이트 조각으로 올리면(브라우저 디코딩 불필요 → 모바일 메모리 안전)
// 서버가 순서대로 이어붙여 세션 폴더에 source<ext> 로 조립한다. 이후 ffmpeg 전처리(lib/audioPrep)가 이 파일을 소비.
const PARTS_SUBDIR = "parts";
// 조립 후 원본 총 크기 상한(기본 512MB) — 디스크 보호. 3시간 회의 m4a(≈330MB)도 여유.
export const SOURCE_MAX_BYTES = Math.max(1, Number(process.env.SOURCE_MAX_BYTES || 512 * 1024 * 1024));

// 원본 바이트 파트 1개 저장(멱등: 같은 index 재업로드 시 덮어씀).
export async function savePart({ sessionId, index, buffer }) {
  const sess = sanitizeSeg(sessionId, "sess");
  const idx = Math.max(0, parseInt(index, 10) || 0);
  const dir = path.join(CHUNK_DIR, sess, PARTS_SUBDIR);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `p${String(idx).padStart(4, "0")}.part`), buffer);
  return { sessionId: sess, index: idx };
}

// 파트 0..partsTotal-1 을 순서대로 이어붙여 원본 파일로 조립 → 파트 폴더 삭제 → 절대경로 반환.
// 누락 파트가 있으면 명확한 에러(클라이언트 재업로드 유도).
export async function assembleSource({ sessionId, partsTotal, ext }) {
  const sess = sanitizeSeg(sessionId, "");
  if (!sess) throw new Error("잘못된 세션 아이디");
  const total = parseInt(partsTotal, 10);
  if (!Number.isInteger(total) || total < 1 || total > 4096) throw new Error("잘못된 파트 개수: " + partsTotal);
  const lower = String(ext || "").toLowerCase();
  const safeExt = AUDIO_EXTS.has(lower) ? lower : ".bin"; // ffmpeg 는 내용으로 포맷 감지 — 확장자는 참고용
  const dir = path.join(CHUNK_DIR, sess, PARTS_SUBDIR);
  const outPath = path.join(CHUNK_DIR, sess, "source" + safeExt);

  const missing = [];
  const partPaths = [];
  let totalBytes = 0;
  for (let i = 0; i < total; i++) {
    const p = path.join(dir, `p${String(i).padStart(4, "0")}.part`);
    try {
      const st = await fs.promises.stat(p);
      if (!st.size) { missing.push(i); continue; }
      totalBytes += st.size;
      partPaths.push(p);
    } catch (e) { missing.push(i); }
  }
  if (missing.length) throw new Error(`업로드 파트 누락(${missing.slice(0, 5).join(",")}${missing.length > 5 ? "…" : ""}) — 다시 시도해주세요`);
  if (totalBytes > SOURCE_MAX_BYTES) throw new Error(`파일이 너무 큽니다(${Math.round(totalBytes / 1024 / 1024)}MB > ${Math.round(SOURCE_MAX_BYTES / 1024 / 1024)}MB)`);

  // 파트(각 ≤3.5MB)를 하나씩 읽어 append — 스트림 'error' 무리스너 크래시(디스크 풀/권한) 위험 제거.
  // 실패 시 부분 조립본을 지워 재시도가 손상 파일을 소비하지 않게 한다.
  try {
    await fs.promises.writeFile(outPath, Buffer.alloc(0));
    for (const p of partPaths) {
      await fs.promises.appendFile(outPath, await fs.promises.readFile(p));
    }
  } catch (e) {
    try { await fs.promises.unlink(outPath); } catch (e2) { /* 부분 조립본 정리 실패는 무시 */ }
    throw new Error("원본 조립 중 디스크 오류: " + e.message);
  }
  await fs.promises.rm(dir, { recursive: true, force: true }); // 파트는 조립 즉시 삭제(디스크 이중 점유 방지)
  return { path: outPath, bytes: totalBytes, ext: safeExt };
}

// 세션 폴더 안의 원본 파일 경로(존재하면). 조립 이후 재시작 복구 시 사용.
export async function findSource(sessionId) {
  const sess = sanitizeSeg(sessionId, "");
  if (!sess) return null;
  const dir = path.join(CHUNK_DIR, sess);
  try {
    const files = await fs.promises.readdir(dir);
    const f = files.find((x) => x.startsWith("source."));
    return f ? path.join(dir, f) : null;
  } catch (e) { return null; }
}

// 한 세션(=한 잡)의 로컬 파일(청크·파트·원본)을 통째 삭제. 전사·보관 완료 후 호출 → OCI 디스크 용량 관리.
// 경로탈출 방어(sanitize + CHUNK_DIR 범위 확인). 삭제한 파일 개수 반환. 폴더 없거나 잘못된 세션이면 0.
export async function deleteSession(sessionId) {
  const sess = sanitizeSeg(sessionId, "");
  if (!sess) return 0;
  const root = path.resolve(CHUNK_DIR) + path.sep;
  const dir = path.resolve(path.join(CHUNK_DIR, sess));
  if (!dir.startsWith(root)) return 0; // 범위 밖이면 거부
  let n = 0;
  try { n = (await listFilesRecursive(dir)).length; } catch (e) { /* 개수 실패는 무시 */ }
  try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch (e) { return 0; }
  return n;
}

// 디렉터리 내 모든 파일 경로(하위 폴더 포함) — cleanup/deleteSession 공용.
async function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

// ref id("local:<sess>/<NNN><ext>") 목록에서 세션 아이디 추출(첫 로컬 ref 기준). 없으면 null.
export function sessionOfRefs(refs) {
  if (!Array.isArray(refs)) return null;
  for (const r of refs) {
    const id = r && r.id;
    if (isLocalRef(id)) {
      const rel = String(id).slice(PREFIX.length);
      const slash = rel.indexOf("/");
      const sess = sanitizeSeg(slash >= 0 ? rel.slice(0, slash) : "", "");
      if (sess) return sess;
    }
  }
  return null;
}

// 보존기간(일) 지난 청크 정리. 삭제 개수 반환. (cleanup 크론에서 호출)
// ★ 세션 단위로 판단: 세션 폴더의 **가장 최근** 청크가 cutoff 보다 오래됐을 때만 그 세션을 통째 삭제.
//   진행 중/장시간 잡(최근 청크가 계속 쓰이는 세션)의 청크를 워커가 읽기 전에 지워버리는 회귀를 방지.
export async function cleanupOlderThan(retentionDays = 10) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let sessions;
  try { sessions = await fs.promises.readdir(CHUNK_DIR, { withFileTypes: true }); }
  catch (e) { return 0; } // 디렉터리 없음 = 정리할 것 없음
  for (const s of sessions) {
    if (!s.isDirectory()) continue;
    const sessDir = path.join(CHUNK_DIR, s.name);
    // 하위 폴더(parts/) 포함 세션의 최신 mtime 계산
    const files = await listFilesRecursive(sessDir);
    if (!files.length) { try { await fs.promises.rm(sessDir, { recursive: true, force: true }); } catch (e) {} continue; } // 빈 폴더 정리
    let newest = 0;
    for (const f of files) {
      try { const st = await fs.promises.stat(f); if (st.mtimeMs > newest) newest = st.mtimeMs; } catch (e) { /* ignore */ }
    }
    if (newest >= cutoff) continue; // 최근 활동 있는 세션 → 보존(진행 중 잡 보호)
    try { await fs.promises.rm(sessDir, { recursive: true, force: true }); deleted += files.length; } catch (e) { /* ignore */ }
  }
  return deleted;
}
