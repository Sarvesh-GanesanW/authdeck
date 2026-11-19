/**
 * Builds the promo's soundtrack with ffmpeg: the music bed cut to the video, the effects on top
 * with the taps ducking the music, then a two-pass loudness normalisation and the AAC encode.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SAMPLE_RATE, wav } from './sound.mjs';

/** Where the music bed sits before the final normalisation, leaving the effects on top. */
const MUSIC_LUFS = -24;
const TARGET_LUFS = -14;
const TARGET_TRUE_PEAK = -1;
const TARGET_LRA = 11;
/** Limiter ceilings to try, highest first; well under TARGET_TRUE_PEAK because AAC overshoots. */
const LIMIT_CEILINGS_DB = [-3, -3.5, -4, -4.5, -5, -6];
const AAC_BITRATE = '192k';
/** Above what AAC at 192k keeps anyway; band-limiting first stops the encoder ringing past the ceiling. */
const LOWPASS_HZ = 16500;
/** Light ducking: about 3 dB off the music for the length of a click. */
const DUCKING = 'sidechaincompress=threshold=0.02:ratio=3:attack=2:release=160:knee=4';
/** Butt splices get a few milliseconds of fade so they never click. */
const SPLICE_FADE = 0.004;

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-hide_banner', '-nostats', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => reject(new Error(`Could not start ffmpeg (${err.message}). Install it, e.g. brew install ffmpeg.`)));
    child.on('exit', (code) => (code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg failed (code ${code}):\n${stderr.slice(-2000)}`))));
  });
}

/** loudnorm's measurement JSON, printed at the end of its stderr. */
async function measureLoudness(path) {
  const filter = `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK}:LRA=${TARGET_LRA}:print_format=json`;
  const stderr = await ffmpeg(['-i', path, '-af', filter, '-f', 'null', '-']);
  const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1);
  return JSON.parse(json);
}

const STEREO_48K = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;

/**
 * The music cut to the video: from `offset` (a bar line in the track) until the closing hit, then
 * a jump to the track's own ending at `ending` so its last hit lands on the logo press. Fades out
 * over `fade` seconds at the end when the track would ring on.
 */
async function buildBed({ music, offset, ending, finalHit, duration, fade, outPath }) {
  const head = ending === undefined ? duration : finalHit;
  const parts = [`[0:a]atrim=start=${offset}:duration=${head},asetpts=PTS-STARTPTS,${STEREO_48K}[head]`];
  let last = 'head';
  if (ending !== undefined) {
    const tail = duration - finalHit;
    parts.push(
      `[head]afade=t=out:st=${head - SPLICE_FADE}:d=${SPLICE_FADE}[headf]`,
      `[0:a]atrim=start=${ending}:duration=${tail},asetpts=PTS-STARTPTS,${STEREO_48K},afade=t=in:d=${SPLICE_FADE}[tail]`,
      '[headf][tail]concat=n=2:v=0:a=1[spliced]',
    );
    last = 'spliced';
  }
  // Pad with silence in case the track ends before the video does.
  parts.push(`[${last}]apad=whole_dur=${duration}${fade > 0 ? `,afade=t=out:st=${duration - fade}:d=${fade}` : ''}[bed]`);
  await ffmpeg(['-i', music, '-filter_complex', parts.join(';'), '-map', '[bed]', '-t', String(duration), '-c:a', 'pcm_f32le', outPath]);
}

/** Mixes bed, taps and effects, ducking the bed under the taps. */
async function mix({ bedPath, tapsPath, fxPath, bedGain, outPath }) {
  const graph = [
    `[0:a]volume=${bedGain}dB[bed]`,
    `[1:a]${STEREO_48K},asplit[key][taps]`,
    `[bed][key]${DUCKING}[ducked]`,
    `[2:a]${STEREO_48K}[fx]`,
    '[ducked][taps][fx]amix=inputs=3:normalize=0[mix]',
  ].join(';');
  await ffmpeg(['-i', bedPath, '-i', tapsPath, '-i', fxPath, '-filter_complex', graph, '-map', '[mix]', '-c:a', 'pcm_f32le', outPath]);
}

/**
 * Gain to the target loudness with the peaks held under a 4x-oversampled limiter at `ceilingDb`
 * (close to a true-peak limiter), then loudnorm's second, linear pass to land on the target.
 */
async function normalise({ inPath, outPath, work, ceilingDb }) {
  const first = await measureLoudness(inPath);
  const gain = TARGET_LUFS - Number(first.input_i);
  const limitedPath = join(work, 'limited.wav');
  const limiter = `alimiter=limit=${10 ** (ceilingDb / 20)}:attack=1:release=60:level=false`;
  await ffmpeg(['-i', inPath, '-af', `lowpass=f=${LOWPASS_HZ},volume=${gain}dB,aresample=${SAMPLE_RATE * 4},${limiter},${STEREO_48K}`, '-c:a', 'pcm_f32le', limitedPath]);
  const m = await measureLoudness(limitedPath);
  const filter = `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK}:LRA=${TARGET_LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}`
    + `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,${STEREO_48K}`;
  await ffmpeg(['-i', limitedPath, '-af', filter, '-c:a', 'pcm_s16le', outPath]);
}

function encodeAac(wavPath, outPath) {
  return ffmpeg(['-i', wavPath, '-c:a', 'aac', '-b:a', AAC_BITRATE, '-ar', String(SAMPLE_RATE), '-ac', '2', outPath]);
}

/** Integrated loudness and true peak of a file, from ffmpeg's EBU R128 summary. */
async function measureDelivered(path) {
  const stderr = await ffmpeg(['-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  return { lufs: Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)[1]), truePeak: Number(summary.match(/Peak:\s+(-?[\d.]+|-inf) dBFS/)[1]) };
}

/**
 * Normalises and encodes to AAC, then checks the decoded true peak: AAC overshoots sharp
 * (chiptune) peaks by a varying amount, so the limiter ceiling steps down until the encoded file
 * itself is under TARGET_TRUE_PEAK.
 */
async function normaliseAndEncode({ mixPath, work }) {
  const wavPath = join(work, 'soundtrack.wav');
  const aacPath = join(work, 'soundtrack.m4a');
  for (const ceilingDb of LIMIT_CEILINGS_DB) {
    await normalise({ inPath: mixPath, outPath: wavPath, work, ceilingDb });
    await encodeAac(wavPath, aacPath);
    const delivered = await measureDelivered(aacPath);
    console.log(`Soundtrack: ${delivered.lufs} LUFS, true peak ${delivered.truePeak} dBTP (limiter at ${ceilingDb} dB).`);
    if (delivered.truePeak <= TARGET_TRUE_PEAK) return aacPath;
  }
  throw new Error(`The AAC soundtrack stays above ${TARGET_TRUE_PEAK} dBTP even with the limiter at ${LIMIT_CEILINGS_DB.at(-1)} dB. Lower the music level or add a lower ceiling to LIMIT_CEILINGS_DB.`);
}

/**
 * Writes the finished soundtrack as AAC and returns its path, ready to mux. Without `music.path`
 * the soundtrack is the effects alone.
 */
export async function buildSoundtrack({ work, duration, effects, music, finalHit }) {
  const tapsPath = join(work, 'taps.wav');
  const fxPath = join(work, 'fx.wav');
  await writeFile(tapsPath, wav([effects.taps]));
  await writeFile(fxPath, wav([effects.fx]));
  const bedPath = join(work, 'bed.wav');
  if (music.path) {
    await buildBed({ ...music, music: music.path, finalHit, duration, outPath: bedPath });
  } else {
    await ffmpeg(['-f', 'lavfi', '-i', `anullsrc=r=${SAMPLE_RATE}:cl=stereo`, '-t', String(duration), '-c:a', 'pcm_f32le', bedPath]);
  }
  const bedGain = music.path ? MUSIC_LUFS - Number((await measureLoudness(bedPath)).input_i) : 0;
  const mixPath = join(work, 'mix.wav');
  await mix({ bedPath, tapsPath, fxPath, bedGain, outPath: mixPath });
  if (music.path) return normaliseAndEncode({ mixPath, work });
  // Effects alone are too sparse to normalise to a programme loudness; they keep their own level.
  const aacPath = join(work, 'soundtrack.m4a');
  await encodeAac(mixPath, aacPath);
  return aacPath;
}
