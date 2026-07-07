#!/usr/bin/env node
// scripts/stt-compare.mjs — STT 정확도 개선 전/후 비교 하니스.
//
// 같은 음성 파일을 두 파이프라인으로 전사해 비교 파일(md)을 남긴다:
//   [BEFORE] 개선 전 재현: 전처리 없음(원본 그대로 120초 고정 분할) + whisper-1 + 교정 없음
//   [AFTER]  개선 후:      ffmpeg(loudnorm+16k mono+무음 분할·오버랩) + gpt-4o-transcribe(폴백 whisper-1)
//                          + 용어 프롬프트 + LLM 교정 1패스
//
// 사용법(OPENAI_API_KEY 필요 — OCI 서버 또는 로컬 .env 쉘):
//   node scripts/stt-compare.mjs <음성파일> [출력.md]
//   docker exec stella-clover node scripts/stt-compare.mjs /app/data/sample.m4a /app/data/compare.md
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY 가 필요합니다(서버 .env 로드된 쉘/컨테이너에서 실행).");
  process.exit(1);
}
const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) {
  console.error("사용법: node scripts/stt-compare.mjs <음성파일> [출력.md]");
  process.exit(1);
}
const OUT = process.argv[3] || path.join(path.dirname(SRC), path.basename(SRC).replace(/\.[^.]+$/, "") + "_stt_비교.md");

// CHUNK_DIR 을 임시 폴더로 격리(운영 청크와 섞이지 않게) — 모듈 로드 전에 설정.
process.env.CHUNK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stt-compare-"));
const { prepareAudio } = await import("../lib/audioPrep.js");
const { readChunk } = await import("../lib/chunkStore.js");
const { transcribeBuffer } = await import("../api/_stt.js");
const { correctTranscript } = await import("../lib/transcriptFix.js");
const { dedupOverlapTokens } = await import("../lib/sttMerge.js");

function runFf(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("ffmpeg 실패: " + (r.stderr || "").slice(-300));
}

async function sttOverChunks(files, { model, withPrompt, dedup }) {
  let acc = "";
  for (let i = 0; i < files.length; i++) {
    const buffer = typeof files[i] === "string" ? fs.readFileSync(files[i]) : await readChunk(files[i].id);
    const prevText = withPrompt ? acc.slice(-200) : "";
    let text = "";
    try {
      const r = await transcribeBuffer({ buffer, ext: ".wav", lang: "ko", model, prevText, offsetSec: 0 });
      text = r.text || "";
    } catch (e) { text = `[구간 ${i + 1} 실패: ${e.message}]`; }
    if (dedup && acc) text = dedupOverlapTokens(acc.slice(-300), text);
    acc = (acc + " " + text).trim();
    console.log(`  구간 ${i + 1}/${files.length} 완료 (${text.length}자)`);
  }
  return acc;
}

const t0 = Date.now();
console.log("▶ [BEFORE] 개선 전 파이프라인: 16kHz 변환만(정규화·무음분할 없음, 120s 고정) + whisper-1");
const beforeDir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-before-"));
// 개선 전과 동일 조건: 16kHz mono 변환 후 120초 고정 분할(오버랩·loudnorm 없음).
const beforeWav = path.join(beforeDir, "plain.wav");
runFf(["-i", SRC, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", beforeWav]);
runFf(["-i", beforeWav, "-f", "segment", "-segment_time", "120", "-c", "copy", path.join(beforeDir, "seg_%03d.wav")]);
const beforeFiles = fs.readdirSync(beforeDir).filter(f => f.startsWith("seg_")).sort().map(f => path.join(beforeDir, f));
const beforeText = await sttOverChunks(beforeFiles, { model: "whisper-1", withPrompt: false, dedup: false });
const tBefore = Date.now();

console.log("▶ [AFTER] 개선 후 파이프라인: loudnorm+무음 분할(6s 오버랩) + gpt-4o-transcribe + 용어 프롬프트 + LLM 교정");
const { refs } = await prepareAudio({ sessionId: "cmp", sourcePath: SRC });
const rawAfter = await sttOverChunks(refs, { model: "gpt-4o-transcribe", withPrompt: true, dedup: true });
const fix = await correctTranscript(rawAfter);
const tAfter = Date.now();

const md = `# STT 전/후 비교 — ${path.basename(SRC)}

- 생성: ${new Date().toISOString()}
- BEFORE: 전처리 없음(16kHz 변환·120s 고정 분할) · whisper-1 · 용어 프롬프트/교정 없음 — ${(tBefore - t0) / 1000}s
- AFTER: ffmpeg loudnorm+무음 분할(청크 ${refs.length}개, 6s 오버랩) · gpt-4o-transcribe(+용어 프롬프트) · LLM 교정(창 ${fix.windows}개, 실패 ${fix.failedWindows}) — ${(tAfter - tBefore) / 1000}s

## BEFORE (${beforeText.length}자)

${beforeText}

## AFTER — STT 원문 (${rawAfter.length}자)

${rawAfter}

## AFTER — LLM 교정본 (${fix.corrected.length}자)

${fix.corrected}
`;
fs.writeFileSync(OUT, md);
fs.rmSync(beforeDir, { recursive: true, force: true });
fs.rmSync(process.env.CHUNK_DIR, { recursive: true, force: true });
console.log(`\n✅ 비교 파일 저장: ${OUT}`);
