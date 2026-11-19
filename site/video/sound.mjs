/**
 * The promo's sound effects, synthesised from code so they sound the same on every render:
 * key clicks for taps, soft ticks for typing, a pixel swish on each wipe and a two-note blip for
 * each success. Also the WAV writer the renderer and the composer share.
 */

export const SAMPLE_RATE = 48000;

const TICK_GAIN = 0.16;
const SWISH_GAIN = 0.07;
const BLIP_GAIN = 0.1;
/** Default blip notes, MIDI: a fifth then the octave, which sits on most major and minor keys. */
const DEFAULT_TONIC = 62; // D4

/** A small seeded generator, so every render is identical. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export const midiToHz = (note) => 440 * 2 ** ((note - 69) / 12);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** "D", "F#" or "Bb" to a pitch class 0..11. */
function pitchClass(name) {
  const flats = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };
  const index = NOTE_NAMES.indexOf(flats[name] ?? name);
  if (index < 0) throw new Error(`Unknown key "${name}". Use a note name such as D, F# or Bb.`);
  return index;
}

/** Adds `length` seconds of `voice(seconds since start)` into `samples` from `at`. */
function addVoice(samples, at, length, voice) {
  const start = Math.round(at * SAMPLE_RATE);
  const count = Math.round(length * SAMPLE_RATE);
  for (let i = Math.max(0, -start); i < count && start + i < samples.length; i++) {
    samples[start + i] += voice(i / SAMPLE_RATE);
  }
}

/** A short keycap click: a noise transient, a bright ping and a low body, each decaying fast. */
function addClick(samples, at, random) {
  const ping = 3000 + random() * 500;
  const body = 170 + random() * 40;
  let smoothed = 0;
  addVoice(samples, at, 0.06, (s) => {
    smoothed = 0.6 * smoothed + 0.4 * (random() * 2 - 1);
    const value = smoothed * Math.exp(-s / 0.0018) * 0.55
      + Math.sin(2 * Math.PI * ping * s) * Math.exp(-s / 0.006) * 0.22
      + Math.sin(2 * Math.PI * body * s) * Math.exp(-s / 0.016) * 0.4;
    return value * 0.5;
  });
  // The softer tick of the key coming back up.
  addVoice(samples, at + 0.1, 0.02, (s) => (random() * 2 - 1) * Math.exp(-s / 0.0012) * 0.12);
}

/** A soft, high typing tick: a few milliseconds of bright noise and a faint ping. */
function addTick(samples, at, random) {
  const ping = 4200 + random() * 900;
  let previous = 0;
  addVoice(samples, at, 0.018, (s) => {
    const noise = random() * 2 - 1;
    const bright = noise - previous; // a one-pole high-pass keeps it light
    previous = noise;
    return (bright * Math.exp(-s / 0.0009) * 0.6 + Math.sin(2 * Math.PI * ping * s) * Math.exp(-s / 0.0025) * 0.3) * TICK_GAIN;
  });
}

/**
 * A pixel swish across a wipe: noise held for a stepped number of samples (a sample-rate crush),
 * getting finer as the blocks cover the frame and coarser as they clear, swelling into the cut.
 */
function addSwish(samples, cut, wipeHalf, random) {
  const length = 2 * wipeHalf;
  let held = 0;
  let holdLeft = 0;
  let smoothed = 0;
  addVoice(samples, cut - wipeHalf, length, (s) => {
    const progress = s / length;
    const closeness = 1 - Math.abs(progress - 0.5) * 2; // 0 at the edges, 1 at the cut
    const hold = Math.max(1, Math.round(28 - 24 * closeness)); // whole steps, like the wipe
    if (holdLeft-- <= 0) {
      held = random() * 2 - 1;
      holdLeft = hold;
    }
    smoothed += (held - smoothed) * 0.35;
    const envelope = Math.sin(Math.PI * progress) ** 2;
    return smoothed * envelope * SWISH_GAIN;
  });
}

/** Two short soft-square notes, a fifth then the octave above the key's tonic. */
function addBlip(samples, at, tonic) {
  const notes = [tonic + 12 + 7, tonic + 24];
  notes.forEach((note, i) => {
    const hz = midiToHz(note);
    let smoothed = 0;
    addVoice(samples, at + i * 0.075, 0.11, (s) => {
      const square = (s * hz) % 1 < 0.5 ? 1 : -1;
      smoothed += (square - smoothed) * 0.25; // round the edges so it stays gentle
      return smoothed * Math.exp(-s / 0.04) * BLIP_GAIN;
    });
  });
}

/**
 * The two effect tracks in output time: `taps` (the key clicks, which also duck the music) and
 * `fx` (ticks, swishes and blips). `toOut` maps story time to output time.
 */
export function effectTracks({ duration, presses, cues, toOut, tonic = DEFAULT_TONIC }) {
  const length = Math.ceil(duration * SAMPLE_RATE);
  const taps = new Float32Array(length);
  const fx = new Float32Array(length);
  const random = seededRandom(47474);
  for (const press of presses) addClick(taps, toOut(press.at), random);
  for (const at of cues.typing) addTick(fx, toOut(at), random);
  for (const cut of cues.cuts) addSwish(fx, toOut(cut), cues.wipeHalf, random);
  for (const at of cues.successes) addBlip(fx, toOut(at), tonic);
  return { taps, fx };
}

/** Tonic MIDI note (octave 4) for a key name such as "D" or "F#". */
export function tonicFor(key) {
  return 60 + pitchClass(key);
}

/** 16-bit PCM WAV from one Float32Array per channel. */
export function wav(channels) {
  const channelCount = channels.length;
  const frames = channels[0].length;
  const data = Buffer.alloc(frames * channelCount * 2);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      data.writeInt16LE(Math.round(v * 32767), (i * channelCount + c) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * channelCount * 2, 28);
  header.writeUInt16LE(channelCount * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
