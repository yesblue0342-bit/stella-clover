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
    let files = [];
    try { files = await fs.promises.readdir(sessDir); } catch (e) { continue; }
    // 세션의 최신 mtime 계산
    let newest = 0;
    const stats = [];
    for (const f of files) {
      try { const st = await fs.promises.stat(path.join(sessDir, f)); stats.push({ f, st }); if (st.mtimeMs > newest) newest = st.mtimeMs; }
      catch (e) { /* ignore */ }
    }
    if (!stats.length) { try { await fs.promises.rmdir(sessDir); } catch (e) {} continue; } // 빈 폴더 정리
    if (newest >= cutoff) continue; // 최근 활동 있는 세션 → 보존(진행 중 잡 보호)
    for (const { f } of stats) {
      try { await fs.promises.unlink(path.join(sessDir, f)); deleted++; } catch (e) { /* ignore */ }
    }
    try { await fs.promises.rmdir(sessDir); } catch (e) { /* ignore */ }
  }
  return deleted;
}
