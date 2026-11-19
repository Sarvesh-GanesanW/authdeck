#!/usr/bin/env node
/**
 * "Keys Up": an original chiptune for the AuthDeck promo, composed and synthesised in code.
 *
 *   node site/video/compose.mjs     writes site/video/out/authdeck-original-chiptune.wav
 *   node site/video/render.mjs --music site/video/out/authdeck-original-chiptune.wav --bpm 132 --key D --fade 0 --out original
 *
 * D major, 132 BPM, 18 bars, four NES-style voices: a 25% pulse lead, a 12.5% pulse arpeggio, a
 * stepped triangle bass and LFSR noise drums. The form follows the video as beat-sync.mjs places
 * it at this tempo:
 *
 *   bars  0-1   intro: tonic stab, arpeggios, a fill into the hook   (logo, headline)
 *   bars  2-5   hook over D Bm G A                                    (keys)
 *   bars  6-9   pre-chorus over G A F#m Bm-A, a snare roll lifts it  (2FA, from bar 6 beat 3)
 *   bars 10-13  chorus: the hook an octave up, 16th arps              (env sets, from bar 10)
 *   bars 14-15  breakdown over G A, building                          (end card, from bar 14)
 *   bar  16     the tonic hit on the logo press, ringing out to bar 18
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_RATE, midiToHz, wav } from './sound.mjs';

export const BPM = 132;
const BEAT = 60 / BPM;
const BARS = 18;
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'out', 'authdeck-original-chiptune.wav');

/** Chord per bar as MIDI notes (root in octave 3); bar 9 changes chord halfway. */
const D = [50, 54, 57];
const Bm = [47, 50, 54];
const G = [43, 47, 50];
const A = [45, 49, 52];
const Fsm = [42, 45, 49];
const CHORDS = [[D], [A], [D], [Bm], [G], [A], [G], [A], [Fsm], [Bm, A], [D], [Bm], [G], [A], [G], [A], [D], [D]];

/** Notes are [beat in bar, MIDI note, length in beats]. */
const HOOK = [
  [[0, 74, 0.5], [0.5, 78, 0.5], [1, 81, 1], [2, 78, 0.5], [2.5, 81, 0.5], [3, 83, 1]],
  [[0, 81, 1.5], [1.5, 78, 0.5], [2, 76, 0.5], [2.5, 78, 1.5]],
  [[0, 74, 0.5], [0.5, 79, 0.5], [1, 83, 1], [2, 81, 0.5], [2.5, 79, 0.5], [3, 81, 1]],
  [[0, 76, 1.5], [1.5, 73, 0.5], [2, 76, 0.5], [2.5, 81, 1.5]],
];
const PRE_CHORUS = [
  [[0, 83, 2], [2, 81, 1], [3, 79, 1]],
  [[0, 76, 1], [1, 81, 1], [2, 85, 2]],
  [[0, 85, 2], [2, 81, 1], [3, 78, 1]],
  [[0, 86, 1.5], [1.5, 85, 0.5], [2, 83, 0.5], [2.5, 85, 0.5], [3, 86, 0.5], [3.5, 88, 0.5]],
];
const BREAKDOWN = [[[0, 83, 4]], [[0, 85, 3], [3, 88, 1]]];

const LEAD_BY_BAR = {
  2: HOOK[0], 3: HOOK[1], 4: HOOK[2], 5: HOOK[3],
  6: PRE_CHORUS[0], 7: PRE_CHORUS[1], 8: PRE_CHORUS[2], 9: PRE_CHORUS[3],
  14: BREAKDOWN[0], 15: BREAKDOWN[1],
};
/** The chorus plays the hook an octave up on a rounder pulse, doubled by the hook where it was. */
const CHORUS_FIRST_BAR = 10;

function octaveUp(bar) {
  return bar.map(([at, note, length]) => [at, note + 12, length]);
}

/* ---------- Voices ---------- */

const pulse = (phase, duty) => (phase % 1 < duty ? 1 : -1);
/** The NES triangle: 32 steps, so it has that slightly buzzy edge. */
const triangle = (phase) => {
  const step = Math.floor((phase % 1) * 32);
  return (step < 16 ? step : 31 - step) / 7.5 - 1;
};
/** Volume in 16 steps, like the 2A03's 4-bit envelope. */
const stepped = (level) => Math.round(level * 15) / 15;

/** Attack, a short decay to `sustain`, and a release after `length` seconds. */
function envelope(s, length, { sustain = 0.65, decay = 0.09, release = 0.04 } = {}) {
  if (s > length) return stepped(Math.max(0, sustain * (1 - (s - length) / release)));
  const attack = Math.min(1, s / 0.003);
  return stepped(attack * (sustain + (1 - sustain) * Math.exp(-s / decay)));
}

class Mix {
  constructor(seconds) {
    const length = Math.ceil(seconds * SAMPLE_RATE);
    this.left = new Float32Array(length);
    this.right = new Float32Array(length);
  }

  /** Adds `voice(seconds since start)` from `at` for `length` seconds, panned -1 (left) to 1. */
  add(at, length, pan, voice) {
    const start = Math.round(at * SAMPLE_RATE);
    const left = Math.cos(((pan + 1) * Math.PI) / 4);
    const right = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < length * SAMPLE_RATE && start + i < this.left.length; i++) {
      const v = voice(i / SAMPLE_RATE);
      this.left[start + i] += v * left;
      this.right[start + i] += v * right;
    }
  }
}

function leadNote(mix, at, note, beats, { gain = 0.16, pan = -0.2, duty = 0.25 } = {}) {
  const hz = midiToHz(note);
  const length = beats * BEAT - 0.02;
  mix.add(at, length + 0.05, pan, (s) => {
    // A little delayed vibrato on held notes, as trackers do.
    const vibrato = s > 0.18 ? 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * (s - 0.18)) : 1;
    return pulse(s * hz * vibrato, duty) * envelope(s, length) * gain;
  });
}

function arpNote(mix, at, note, length, gain) {
  const hz = midiToHz(note);
  mix.add(at, length, 0.45, (s) => pulse(s * hz, 0.125) * envelope(s, length * 0.8, { sustain: 0.4, decay: 0.05, release: 0.02 }) * gain);
}

function bassNote(mix, at, note, length) {
  const hz = midiToHz(note);
  // The triangle has no volume control on the NES: full level, then cut.
  mix.add(at, length, 0, (s) => triangle(s * hz) * (s < length - 0.01 ? 0.3 : 0));
}

/** A 15-bit LFSR noise source clocked at `rate`, as the 2A03 noise channel. */
function lfsrNoise(rate, isShort = false) {
  let register = 1;
  let next = 0;
  let value = 1;
  return (s) => {
    while (s * rate >= next) {
      const bit = (register ^ (register >> (isShort ? 6 : 1))) & 1;
      register = (register >> 1) | (bit << 14);
      value = register & 1 ? 1 : -1;
      next++;
    }
    return value;
  };
}

function kick(mix, at, gain = 0.42) {
  let phase = 0;
  mix.add(at, 0.16, 0, (s) => {
    phase += (55 + 140 * Math.exp(-s / 0.025)) / SAMPLE_RATE;
    return triangle(phase) * stepped(Math.exp(-s / 0.06)) * gain;
  });
}

function snare(mix, at, gain = 0.2) {
  const noise = lfsrNoise(9000);
  mix.add(at, 0.18, 0.05, (s) => (noise(s) * stepped(Math.exp(-s / 0.05)) + pulse(s * 190, 0.5) * Math.exp(-s / 0.02) * 0.4) * gain);
}

function hat(mix, at, gain = 0.06, isOpen = false) {
  const noise = lfsrNoise(40000, true);
  mix.add(at, isOpen ? 0.2 : 0.05, 0.25, (s) => noise(s) * stepped(Math.exp(-s / (isOpen ? 0.07 : 0.015))) * gain);
}

function crash(mix, at, gain = 0.13) {
  const noise = lfsrNoise(30000);
  mix.add(at, 2.2, -0.1, (s) => noise(s) * stepped(Math.exp(-s / 0.6)) * gain);
}

/* ---------- Parts ---------- */

const barStart = (bar) => bar * 4 * BEAT;

/** The chord sounding at a beat of a bar. */
function chordAt(bar, beat) {
  const chords = CHORDS[bar];
  return chords.length > 1 && beat >= 2 ? chords[1] : chords[0];
}

function writeLead(mix) {
  for (const [bar, notes] of Object.entries(LEAD_BY_BAR)) {
    for (const [beat, note, beats] of notes) leadNote(mix, barStart(Number(bar)) + beat * BEAT, note, beats);
  }
  HOOK.forEach((notes, i) => {
    const t = barStart(CHORUS_FIRST_BAR + i);
    for (const [beat, note, beats] of octaveUp(notes)) leadNote(mix, t + beat * BEAT, note, beats, { gain: 0.11, duty: 0.5 });
    for (const [beat, note, beats] of notes) leadNote(mix, t + beat * BEAT, note, beats, { gain: 0.07, pan: 0.35 });
  });
}

function writeArps(mix) {
  for (let bar = 0; bar < 16; bar++) {
    const isChorus = bar >= 10 && bar < 14;
    const step = isChorus || bar === 9 ? 0.25 : 0.5;
    const gain = bar < 2 || bar >= 14 ? 0.07 : 0.055;
    for (let beat = 0; beat < 4; beat += step) {
      const chord = chordAt(bar, beat);
      const tones = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[0] + 24];
      const index = Math.round(beat / step) % tones.length;
      arpNote(mix, barStart(bar) + beat * BEAT, tones[index], step * BEAT, gain);
    }
  }
}

/** Root on 1, a push on the and of 2, octave and fifth: a driving NES bass line. */
const BASS_PATTERN = [[0, 0, 1], [1, 0, 0.5], [1.5, 12, 0.5], [2, 0, 0.5], [2.5, 0, 0.5], [3, 7, 0.5], [3.5, 12, 0.5]];

function writeBass(mix) {
  for (let bar = 0; bar < 16; bar++) {
    const isSparse = bar < 2 || bar >= 14;
    for (const [beat, interval, beats] of isSparse ? [[0, 0, 2], [2, 0, 2]] : BASS_PATTERN) {
      const root = chordAt(bar, beat)[0] - 12;
      bassNote(mix, barStart(bar) + beat * BEAT, root + interval, beats * BEAT);
    }
  }
}

function writeDrums(mix) {
  // Intro: a kick and crash on the first downbeat, hats in bar 1 and a snare fill into the hook.
  kick(mix, 0);
  crash(mix, 0, 0.09);
  for (let beat = 0; beat < 3; beat += 0.5) hat(mix, barStart(1) + beat * BEAT);
  for (const beat of [3, 3.25, 3.5, 3.75]) snare(mix, barStart(1) + beat * BEAT, 0.15);
  for (let bar = 2; bar < 14; bar++) {
    const isChorus = bar >= 10;
    const t = barStart(bar);
    for (const beat of isChorus ? [0, 1.5, 2, 3.5] : [0, 2, 2.5]) kick(mix, t + beat * BEAT);
    if (bar !== 9) for (const beat of [1, 3]) snare(mix, t + beat * BEAT);
    for (let beat = 0; beat < 4; beat += 0.5) hat(mix, t + beat * BEAT, isChorus ? 0.07 : 0.055, isChorus && beat % 1 === 0.5);
  }
  // The lift: a sixteenth snare roll through bar 9 that swells into the chorus.
  for (let beat = 0; beat < 4; beat += 0.25) snare(mix, barStart(9) + beat * BEAT, 0.08 + 0.12 * (beat / 4));
  kick(mix, barStart(9));
  crash(mix, barStart(10));
  // Breakdown: kick on the bar, then a build in the last two beats.
  for (const bar of [14, 15]) kick(mix, barStart(bar), 0.35);
  for (let beat = 2; beat < 4; beat += 0.25) snare(mix, barStart(15) + beat * BEAT, 0.07 + 0.1 * ((beat - 2) / 2));
}

/** The opening stab: a short D major chord on the first downbeat, so the music starts on a hit. */
function writeIntroStab(mix) {
  for (const [note, pan] of [[62, 0.4], [66, -0.4], [69, 0.2], [74, -0.2]]) {
    const hz = midiToHz(note);
    mix.add(0, 0.5, pan, (s) => pulse(s * hz, 0.5) * envelope(s, 0.3, { sustain: 0.3, decay: 0.08, release: 0.1 }) * 0.07);
  }
}

/** The closing hit: a full D major chord on the logo press, a falling flourish, then it rings out. */
function writeEnding(mix) {
  const t = barStart(16);
  kick(mix, t, 0.45);
  crash(mix, t, 0.16);
  bassNote(mix, t, 38, 3.2);
  const ring = { sustain: 0.55, decay: 0.25, release: 1.2 };
  for (const [note, pan, gain] of [[74, 0.4, 0.07], [78, 0.5, 0.07], [81, -0.5, 0.07], [86, -0.2, 0.1]]) {
    const hz = midiToHz(note);
    mix.add(t, 3.4, pan, (s) => pulse(s * hz, note === 86 ? 0.25 : 0.5) * envelope(s, 2.2, ring) * Math.exp(-s / 1.6) * gain);
  }
  [93, 90, 86, 81, 78, 74].forEach((note, i) => arpNote(mix, t + 0.25 * BEAT * (i + 1), note, 0.25 * BEAT, 0.06 * (1 - i / 8)));
}

const HEADROOM_PEAK = 0.89;

/** Scales both channels by one gain so the voices sum without clipping. */
function withHeadroom(channels) {
  let peak = 0;
  for (const channel of channels) for (const v of channel) peak = Math.max(peak, Math.abs(v));
  const gain = peak > HEADROOM_PEAK ? HEADROOM_PEAK / peak : 1;
  return channels.map((channel) => channel.map((v) => v * gain));
}

export function compose() {
  const mix = new Mix(barStart(BARS));
  writeIntroStab(mix);
  writeLead(mix);
  writeArps(mix);
  writeBass(mix);
  writeDrums(mix);
  writeEnding(mix);
  return withHeadroom([mix.left, mix.right]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, wav(compose()));
  console.log(`Wrote ${OUT_PATH} (${BPM} BPM, D major, ${(barStart(BARS)).toFixed(2)} s).`);
}
