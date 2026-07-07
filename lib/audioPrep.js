// lib/audioPrep.js — ffmpeg 기반 서버측 오디오 전처리 (STT 정확도 개선의 1단계).
//
// 왜: 과거에는 브라우저가 오디오 전체를 디코딩해 120초 고정 WAV 청크로 잘랐다.
//   · 모바일(S22)에서 장시간 회의 파일 디코딩 시 메모리 폭주 → 업로드 자체가 실패.
//   · 고정 간격 분할이라 문장 중간이 잘려 경계 인식률이 떨어짐.
//   → 원본 파일을 서버가 받아 ffmpeg 로 (1) 모노 16kHz 변환 + 음량 정규화(loudnorm),
//     (2) 무음(silencedetect) 위치에 맞춰 분할(청크 간 오버랩), (3) 청크를 chunkStore 에 저장한다.
//
// ★ 절대 규칙 준수: 청크 최대 길이 = maxSec(114) + overlap(6) = 120초 → 16kHz mono WAV ≈ 3.84MB (5MB 금지 규칙 내).
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { CHUNK_DIR, saveChunk } from "./chunkStore.js";

// ffmpeg 실행 시간 상한(기본 30분) — 손상 파일로 인한 좀비 프로세스 방지.
const FFMPEG_TIMEOUT_MS = Math.max(60000, Number(process.env.FFMPEG_TIMEOUT_MS || 30 * 60 * 1000));

// 분할 파라미터. targetSec 근처의 무음에서 자르고, 무음이 없으면 maxSec 에서 강제 분할.
export const SPLIT_OPTS = { targetSec: 100, maxSec: 114, minSec: 45, overlapSec: 6 };

// 자식 프로세스 실행 → { code, stdout, stderr }. ffmpeg 는 진행 로그를 stderr 로 낸다.
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const to = setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) {} reject(new Error(`${cmd} 시간 초과(${Math.round(FFMPEG_TIMEOUT_MS / 60000)}분)`)); }, FFMPEG_TIMEOUT_MS);
    p.stdout.on("data", (d) => { out += d; if (out.length > 1e6) out = out.slice(-5e5); });
    p.stderr.on("data", (d) => { err += d; if (err.length > 4e6) err = err.slice(-2e6); });
    p.on("error", (e) => { clearTimeout(to); reject(new Error(`${cmd} 실행 실패: ${e.message}`)); });
    p.on("close", (code) => { clearTimeout(to); resolve({ code, stdout: out, stderr: err }); });
  });
}

// ffprobe 로 길이(초). 실패 시 0.
async function probeDuration(file) {
  try {
    const r = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
    const d = parseFloat(String(r.stdout).trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch (e) { return 0; }
}

// silencedetect stderr 파싱 → [{start,end}] (초). 짝 없는 silence_start 는 totalSec 로 닫는다.
export function parseSilences(stderrText, totalSec = 0) {
  const out = [];
  let open = null;
  for (const m of String(stderrText || "").matchAll(/silence_(start|end):\s*([0-9.]+)/g)) {
    const v = parseFloat(m[2]);
    if (!Number.isFinite(v)) continue;
    if (m[1] === "start") open = v;
    else if (open != null) { if (v > open) out.push({ start: open, end: v }); open = null; }
  }
  if (open != null && totalSec > open) out.push({ start: open, end: totalSec });
  return out;
}

// 순수 함수: 무음 목록 기반 분할점 계획.
// 각 분할점은 이전 분할점 + [minSec, maxSec] 창 안에서 targetSec 에 가장 가까운 무음 지점.
// 창 안에 무음이 없으면 maxSec 에서 강제 분할(고정 간격 폴백). 마지막 원소는 항상 totalSec.
export function planCutPoints(silences, totalSec, opts = {}) {
  const target = opts.targetSec ?? SPLIT_OPTS.targetSec;
  const max = opts.maxSec ?? SPLIT_OPTS.maxSec;
  const min = opts.minSec ?? SPLIT_OPTS.minSec;
  const total = Math.max(0, Number(totalSec) || 0);
  const sil = (Array.isArray(silences) ? silences : [])
    .map((s) => ({ start: Number(s && s.start) || 0, end: Number(s && s.end) || 0 }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const cuts = [];
  let cur = 0;
  while (total - cur > max) {
    const lo = cur + min, hi = cur + max;
    let best = null, bestDist = Infinity;
    for (const s of sil) {
      if (s.end < lo || s.start > hi) continue; // 창과 겹치지 않는 무음
      // 무음 한가운데를 선호하되, 창 & 무음 구간 안으로 클램프.
      const point = Math.min(Math.max((s.start + s.end) / 2, Math.max(lo, s.start)), Math.min(hi, s.end));
      const d = Math.abs(point - (cur + target));
      if (d < bestDist) { bestDist = d; best = point; }
    }
    const cut = best == null ? hi : best;
    cuts.push(cut);
    cur = cut;
  }
  cuts.push(total);
  return cuts;
}

// 순수 함수: 분할점 → 청크 구간. 두 번째 청크부터 시작을 overlapSec 앞당겨 경계 단어 손실을 방지.
// (겹친 구간의 중복 텍스트는 병합 시 dedupOverlapTokens 로 제거.)
export function chunkSpans(cuts, overlapSec = SPLIT_OPTS.overlapSec) {
  const arr = (Array.isArray(cuts) ? cuts : []).filter((c) => Number.isFinite(c) && c > 0);
  const spans = [];
  let prev = 0;
  for (const c of arr) {
    const start = spans.length === 0 ? 0 : Math.max(0, prev - overlapSec);
    if (c > start) spans.push({ start, end: c });
    prev = c;
  }
  return spans;
}

// 원본 오디오 → 정규화 → 무음 정렬 분할 → 청크 저장. 반환: { refs, durationSec }.
// refs: [{ id, index, durationSec, startSec, ext }] — startSec 는 청크 오디오의 글로벌 시작(오버랩 반영, 정확한 타임라인).
export async function prepareAudio({ sessionId, sourcePath, splitOpts = {} }) {
  const opts = { ...SPLIT_OPTS, ...splitOpts };
  const sessDir = path.join(CHUNK_DIR, String(sessionId));
  await fs.promises.mkdir(sessDir, { recursive: true });
  const normPath = path.join(sessDir, "norm.wav");

  // 1) 모노 16kHz + 음량 정규화(loudnorm 단일 패스: I=-16LUFS, TP=-1.5dB).
  const conv = await run("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-i", sourcePath,
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", normPath]);
  if (conv.code !== 0) throw new Error("오디오 변환 실패(ffmpeg): " + String(conv.stderr).slice(-300));

  const durationSec = await probeDuration(normPath);
  if (!durationSec) { try { await fs.promises.unlink(normPath); } catch (e) {} throw new Error("오디오 길이를 판별하지 못했습니다(빈 파일/손상 파일)"); }

  // 2) 정규화본에서 무음 탐지(-35dB 이하 0.6초 이상).
  const det = await run("ffmpeg", ["-hide_banner", "-nostdin", "-i", normPath,
    "-af", "silencedetect=noise=-35dB:d=0.6", "-f", "null", "-"]);
  const silences = parseSilences(det.stderr, durationSec);

  // 3) 분할 계획 → 청크 파일 생성(chunkStore 저장 경로/네이밍 재사용 → 워커/재생과 무중단 호환).
  const cuts = planCutPoints(silences, durationSec, opts);
  const spans = chunkSpans(cuts, opts.overlapSec);
  const refs = [];
  for (let i = 0; i < spans.length; i++) {
    const { start, end } = spans[i];
    const tmp = path.join(sessDir, `cut_${i}.wav`);
    const cut = await run("ffmpeg", ["-hide_banner", "-nostdin", "-y",
      "-ss", start.toFixed(3), "-t", (end - start).toFixed(3), "-i", normPath, "-c", "copy", tmp]);
    if (cut.code !== 0) { try { await fs.promises.unlink(tmp); } catch (e) {} throw new Error(`청크 ${i} 분할 실패: ` + String(cut.stderr).slice(-200)); }
    const buffer = await fs.promises.readFile(tmp);
    await fs.promises.unlink(tmp);
    const id = await saveChunk({ sessionId, index: i, ext: ".wav", buffer });
    refs.push({ id, index: i, durationSec: Math.round((end - start) * 100) / 100, startSec: Math.round(start * 100) / 100, ext: ".wav" });
  }

  try { await fs.promises.unlink(normPath); } catch (e) { /* 정규화 임시본 정리 실패는 무시 */ }
  return { refs, durationSec, silenceCount: silences.length };
}

export default { prepareAudio, planCutPoints, chunkSpans, parseSilences, SPLIT_OPTS };
