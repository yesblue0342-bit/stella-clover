// lib/audioPrep.js — 무음 정렬 분할 계획(순수 함수) + ffmpeg 통합(합성 오디오) 테스트.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 테스트 전용 임시 CHUNK_DIR 을 환경변수로 지정한 뒤 동적 import(모듈 로드시 CHUNK_DIR 고정).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clover-prep-"));
process.env.CHUNK_DIR = path.join(TMP, "chunks");
const { prepareAudio, planCutPoints, chunkSpans, parseSilences, SPLIT_OPTS } = await import("../lib/audioPrep.js");
const { readChunk } = await import("../lib/chunkStore.js");

const hasFfmpeg = (() => {
  try { return spawnSync("ffmpeg", ["-version"]).status === 0; } catch (e) { return false; }
})();

test("parseSilences: silencedetect stderr 파싱 + 짝 없는 start 는 totalSec 로 닫음", () => {
  const err = [
    "[silencedetect @ 0x1] silence_start: 95.01",
    "[silencedetect @ 0x1] silence_end: 96.52 | silence_duration: 1.51",
    "[silencedetect @ 0x1] silence_start: 290.2",
  ].join("\n");
  assert.deepEqual(parseSilences(err, 300), [
    { start: 95.01, end: 96.52 },
    { start: 290.2, end: 300 },
  ]);
  assert.deepEqual(parseSilences("", 100), []);
});

test("planCutPoints: 짧은 오디오(≤maxSec)는 분할 없음(끝점 하나)", () => {
  assert.deepEqual(planCutPoints([], 90), [90]);
  assert.deepEqual(planCutPoints([{ start: 40, end: 41 }], 114), [114]);
});

test("planCutPoints: 창 안의 무음에서 자르고, 무음 없으면 maxSec 강제 분할", () => {
  // 총 300초, 무음이 95~97초와 200~202초에 있음 → 그 근처에서 잘라야 한다.
  const cuts = planCutPoints([{ start: 95, end: 97 }, { start: 200, end: 202 }], 300);
  assert.equal(cuts.length, 3);
  assert.ok(Math.abs(cuts[0] - 96) <= 1.5, "첫 분할점이 무음(95~97) 안: " + cuts[0]);
  assert.ok(Math.abs(cuts[1] - 201) <= 1.5, "둘째 분할점이 무음(200~202) 안: " + cuts[1]);
  assert.equal(cuts[2], 300);

  // 무음이 전혀 없으면 고정 간격(maxSec) 폴백.
  const fixed = planCutPoints([], 300);
  assert.equal(fixed[0], SPLIT_OPTS.maxSec);
  assert.equal(fixed[fixed.length - 1], 300);
});

test("planCutPoints: 분할점 단조 증가 + 각 청크 길이 ≤ maxSec (5MB 절대 규칙 전제)", () => {
  const silences = Array.from({ length: 40 }, (_, i) => ({ start: i * 50 + 20, end: i * 50 + 21 }));
  const cuts = planCutPoints(silences, 2000);
  let prev = 0;
  for (const c of cuts) {
    assert.ok(c > prev, "단조 증가");
    assert.ok(c - prev <= SPLIT_OPTS.maxSec + 1e-9, `청크 길이 초과: ${c - prev}`);
    prev = c;
  }
  assert.equal(prev, 2000);
});

test("chunkSpans: 둘째 청크부터 overlap 만큼 앞당김 + 길이 상한(max+overlap=120s)", () => {
  const spans = chunkSpans([100, 210, 300], 6);
  assert.deepEqual(spans[0], { start: 0, end: 100 });
  assert.deepEqual(spans[1], { start: 94, end: 210 });
  assert.deepEqual(spans[2], { start: 204, end: 300 });
  for (const s of spans) assert.ok(s.end - s.start <= SPLIT_OPTS.maxSec + SPLIT_OPTS.overlapSec + 1e-9);
});

test("prepareAudio: 합성 오디오(무음 포함) → loudnorm+16k mono 청크가 무음 근처에서 분할된다", { skip: !hasFfmpeg && "ffmpeg 없음" }, async () => {
  // 300초 합성: 톤(0~95) + 무음(95~97) + 톤(97~200) + 무음(200~202) + 톤(202~300). 낮은 볼륨(0.05) → loudnorm 검증.
  const src = path.join(TMP, "src.wav");
  const filt = "sine=frequency=440:duration=300,volume=0.05,volume=enable='between(t,95,97)':volume=0,volume=enable='between(t,200,202)':volume=0";
  const gen = spawnSync("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", filt, "-ac", "1", "-ar", "16000", src], { encoding: "utf8" });
  assert.equal(gen.status, 0, "합성 오디오 생성 실패: " + (gen.stderr || "").slice(-200));

  const { refs, durationSec } = await prepareAudio({ sessionId: "testsess", sourcePath: src });
  assert.ok(Math.abs(durationSec - 300) < 2, "길이 ~300초: " + durationSec);
  assert.equal(refs.length, 3, "무음 2곳 기준 3청크: " + JSON.stringify(refs.map(r => [r.startSec, r.durationSec])));

  // 분할점이 무음 근처(95~97)인지 + startSec 오버랩 반영 + ref 포맷.
  const cut1 = refs[0].durationSec; // 첫 청크 끝 = 첫 분할점
  assert.ok(cut1 > 93 && cut1 < 99, "첫 분할점이 무음 근처: " + cut1);
  assert.ok(refs[1].startSec < cut1 && cut1 - refs[1].startSec <= SPLIT_OPTS.overlapSec + 0.5, "오버랩 반영");
  for (const r of refs) {
    assert.match(r.id, /^local:testsess\/\d{3}\.wav$/);
    const buf = await readChunk(r.id);
    assert.ok(buf.length <= 120 * 16000 * 2 + 100, "청크 ≤ 3.84MB(120초) 절대 규칙: " + buf.length);
    // 16kHz mono 16bit WAV 헤더 확인
    assert.equal(buf.toString("ascii", 0, 4), "RIFF");
    assert.equal(buf.readUInt32LE(24), 16000, "16kHz");
    assert.equal(buf.readUInt16LE(22), 1, "mono");
  }

  // loudnorm 이 저볼륨(0.05≈-26dB) 입력을 끌어올렸는지: 첫 청크 피크가 원본 피크(≈1638)보다 커야 함.
  const c0 = await readChunk(refs[0].id);
  let peak = 0;
  for (let i = 44; i + 1 < c0.length; i += 2) { const v = Math.abs(c0.readInt16LE(i)); if (v > peak) peak = v; }
  assert.ok(peak > 4000, "loudnorm 증폭 확인(peak=" + peak + ")");

  fs.rmSync(TMP, { recursive: true, force: true });
});
