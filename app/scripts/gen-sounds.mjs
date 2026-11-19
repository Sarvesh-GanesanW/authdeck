// Synthesises the mechanical key sounds into assets/sounds/ (16-bit mono 44.1 kHz WAV).
// Each sound is filtered noise for the contact and damped sine modes for the plastic ringing.
// The PRNG is seeded, so running it again writes byte-identical files.
// Run: node scripts/gen-sounds.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 44100;
const PEAK_DBFS = -3;
const FADE_IN_S = 0.0004;
const FADE_OUT_S = 0.006;
const VARIANTS = 3;

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RBJ cookbook biquad, run once over a whole buffer. */
function biquad(input, type, freq, q) {
  const w = (2 * Math.PI * freq) / RATE;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lowpass') [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  else if (type === 'highpass') [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  else [b0, b1, b2] = [alpha, 0, -alpha];
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const out = new Float64Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

function noise(rand, n) {
  return Float64Array.from({ length: n }, () => rand() * 2 - 1);
}

/** Adds noise shaped by a filter and an exponential decay, starting `delay` seconds in. */
function addNoiseBurst(buf, rand, { type, freq, q = 0.8, gain, decay, delay = 0 }) {
  const shaped = biquad(noise(rand, buf.length), type, freq, q);
  const start = Math.round(delay * RATE);
  for (let i = start; i < buf.length; i++) {
    const t = (i - start) / RATE;
    buf[i] += shaped[i] * gain * Math.exp(-t / decay);
  }
}

/** Adds a damped sine whose pitch slides down by `drop` (a ratio) as it rings out. */
function addMode(buf, rand, { freq, gain, decay, delay = 0, drop = 0 }) {
  const start = Math.round(delay * RATE);
  let phase = rand() * Math.PI * 2;
  for (let i = start; i < buf.length; i++) {
    const t = (i - start) / RATE;
    const f = freq * (1 + drop * Math.exp(-t / (decay * 0.5)));
    phase += (2 * Math.PI * f) / RATE;
    buf[i] += Math.sin(phase) * gain * Math.exp(-t / decay);
  }
}

function finish(buf) {
  const cleaned = biquad(buf, 'highpass', 40, 0.7);
  const fadeIn = Math.round(FADE_IN_S * RATE);
  const fadeOut = Math.round(FADE_OUT_S * RATE);
  for (let i = 0; i < cleaned.length; i++) {
    const fromEnd = cleaned.length - 1 - i;
    if (i < fadeIn) cleaned[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn);
    if (fromEnd < fadeOut) cleaned[i] *= 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / fadeOut);
  }
  const peak = cleaned.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  const scale = 10 ** (PEAK_DBFS / 20) / peak;
  return cleaned.map((x) => x * scale);
}

/** Jitters a value by up to ±amount (a fraction). */
const jitter = (rand, value, amount) => value * (1 + (rand() * 2 - 1) * amount);

// "Ka": the stem bottoming out. A hard click, then the low thock of cap and plate.
function keyDown(rand) {
  const buf = new Float64Array(Math.round(0.064 * RATE));
  const pitch = jitter(rand, 1, 0.06);
  addNoiseBurst(buf, rand, { type: 'highpass', freq: 3200, gain: 1.1, decay: 0.0009 });
  addMode(buf, rand, { freq: 4300 * pitch, gain: 0.35, decay: 0.0018 });
  addMode(buf, rand, { freq: 1350 * pitch, gain: 0.3, decay: 0.006, delay: 0.0006 });
  addNoiseBurst(buf, rand, { type: 'bandpass', freq: jitter(rand, 750, 0.1), q: 1.4, gain: 0.9, decay: 0.009, delay: 0.0008 });
  addMode(buf, rand, { freq: 210 * pitch, gain: 0.85, decay: 0.016, delay: 0.001, drop: 0.35 });
  addMode(buf, rand, { freq: 470 * pitch, gain: 0.35, decay: 0.009, delay: 0.001 });
  return finish(buf);
}

// "Chak": the stem springing back up. Brighter and lighter, with only a hint of body.
function keyUp(rand) {
  const buf = new Float64Array(Math.round(0.04 * RATE));
  const pitch = jitter(rand, 1, 0.07);
  addNoiseBurst(buf, rand, { type: 'highpass', freq: 4200, gain: 0.8, decay: 0.0007 });
  addNoiseBurst(buf, rand, { type: 'bandpass', freq: jitter(rand, 2800, 0.12), q: 2, gain: 1, decay: 0.004 });
  addMode(buf, rand, { freq: 2300 * pitch, gain: 0.45, decay: 0.0035 });
  addMode(buf, rand, { freq: 5200 * pitch, gain: 0.25, decay: 0.0015 });
  addMode(buf, rand, { freq: 380 * pitch, gain: 0.3, decay: 0.006, delay: 0.0005, drop: 0.2 });
  return finish(buf);
}

// A soft, small tick for tabs, buttons and switches: rounded off, no thock.
function tick(rand) {
  const buf = new Float64Array(Math.round(0.024 * RATE));
  addNoiseBurst(buf, rand, { type: 'bandpass', freq: 1900, q: 1.6, gain: 0.7, decay: 0.0018 });
  addMode(buf, rand, { freq: 1700, gain: 0.6, decay: 0.0032 });
  addMode(buf, rand, { freq: 3100, gain: 0.15, decay: 0.0012 });
  return finish(biquad(buf, 'lowpass', 5000, 0.7));
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((x, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x)) * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

mkdirSync(outDir, { recursive: true });
const rand = mulberry32(0xdecc);
const files = {};
for (let v = 1; v <= VARIANTS; v++) {
  files[`key-down-${v}.wav`] = keyDown(rand);
  files[`key-up-${v}.wav`] = keyUp(rand);
}
files['tick.wav'] = tick(rand);
for (const [name, samples] of Object.entries(files)) {
  writeFileSync(join(outDir, name), wav(samples));
  console.log(`${name}  ${Math.round((samples.length / RATE) * 1000)} ms`);
}
