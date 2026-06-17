// 파이프라인 최소 검증용 16kHz mono WAV 생성기.
// 사용: node test-assets/make-wav.mjs
// 결과: test-assets/silence-2s.wav (무음), test-assets/tone-2s.wav (440Hz 톤)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const RATE = 16000, SECS = 2;

function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, samples[i] | 0)), 44 + i * 2);
  return buf;
}

const silence = new Array(RATE * SECS).fill(0);
const tone = Array.from({ length: RATE * SECS }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / RATE) * 8000);

writeFileSync(join(dir, "silence-2s.wav"), wav(silence));
writeFileSync(join(dir, "tone-2s.wav"), wav(tone));
console.log("생성 완료: test-assets/silence-2s.wav, test-assets/tone-2s.wav");
