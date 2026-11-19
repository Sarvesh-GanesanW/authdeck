#!/usr/bin/env node
/**
 * Renders the AuthDeck promo (scene.html) to an MP4, frame by frame, in headless Chrome.
 *
 *   node site/video/render.mjs                 effects only, into site/video/out/authdeck-promo.mp4
 *   node site/video/render.mjs --music FILE --bpm 140 --offset 0 --ending 147.42 --key D --out chiptune
 *                                              cut to that track's beat grid, into out/authdeck-promo-chiptune.mp4
 *   node site/video/render.mjs --stills 1,6.2  PNG frames at those (output) times into site/video/out/stills/
 *   node site/video/render.mjs --serve         serve the scene for a browser preview (?t=6.2 or ?play)
 *
 * Music options: --offset is the track time of the bar line that plays at 0 s; --ending is the
 * track time of its closing hit, which the video jumps to so it lands on the end-card logo press;
 * --key sets the success blips' key; --fade is the closing fade in seconds (default 1, 0 for none).
 *
 * The page exposes `promo.render(t)`, which sets the exact state for story time t, so frames never
 * depend on how fast the machine is. beat-sync.mjs maps output time to story time.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { planTimeline } from './beat-sync.mjs';
import { effectTracks, tonicFor } from './sound.mjs';
import { buildSoundtrack } from './soundtrack.mjs';

const VIDEO = dirname(fileURLToPath(import.meta.url));
const SITE = dirname(VIDEO);
const REPO = dirname(SITE);
const ICON_DIR = join(REPO, 'app', 'node_modules', 'pixelarticons', 'svg');
const OUT = join(VIDEO, 'out');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTH = 1920;
const HEIGHT = 1080;

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

/* ---------- Static server: the scene, the site's fonts and the app's pixel icons ---------- */

function resolveRequest(url) {
  const path = decodeURIComponent(new URL(url, 'http://x').pathname);
  const iconMatch = path.match(/^\/icons\/([a-z0-9-]+\.svg)$/);
  if (iconMatch) return join(ICON_DIR, iconMatch[1]);
  const file = normalize(join(SITE, path));
  // Only files inside site/ are served.
  return file.startsWith(SITE + sep) ? file : null;
}

function startServer() {
  const server = createServer(async (request, response) => {
    const file = resolveRequest(request.url);
    try {
      if (!file) throw new Error('outside site/');
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---------- Chrome over the DevTools protocol ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchChrome(profileDir) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, [
    '--headless=new', '--mute-audio', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, `--window-size=${WIDTH},${HEIGHT}`, 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 75; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return { chrome, page };
    } catch {
      // Chrome is still starting.
    }
    await sleep(200);
  }
  chrome.kill();
  throw new Error(`Chrome did not open its debugging port. Check that ${CHROME} exists, or set CHROME.`);
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, errors, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`Page error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  return result.result.value;
}

async function openScene(url, profileDir) {
  const { chrome, page } = await launchChrome(profileDir);
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 100 && !(await evaluate(cdp, 'Boolean(window.promo)')); i++) await sleep(100);
  await evaluate(cdp, 'window.promo.ready');
  if (cdp.errors.length) throw new Error(`The scene failed to load: ${cdp.errors.join('; ')}`);
  const timeline = await evaluate(cdp, '({ fps: promo.fps, duration: promo.duration, presses: promo.presses, cues: promo.cues })');
  const frame = async (t) => {
    await evaluate(cdp, `promo.render(${t})`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(shot.data, 'base64');
  };
  const close = () => {
    cdp.close();
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    return exited;
  };
  return { timeline, frame, close };
}

/* ---------- Encoding ---------- */

function startEncoder({ fps, duration, audioPath, outPath }) {
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-i', audioPath,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-tune', 'animation',
    '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'copy',
    '-t', String(duration), '-movflags', '+faststart', outPath,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    ffmpeg.on('error', (err) => reject(new Error(`Could not start ffmpeg (${err.message}). Install it, e.g. brew install ffmpeg.`)));
    ffmpeg.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}.`))));
  });
  const write = (buffer) => (ffmpeg.stdin.write(buffer) ? Promise.resolve() : new Promise((r) => ffmpeg.stdin.once('drain', r)));
  const finish = () => {
    ffmpeg.stdin.end();
    return done;
  };
  return { write, finish };
}


/** The output timeline for these options: story time as is, or fitted to the music's beats. */
function planFor(timeline, options) {
  const plan = planTimeline({ cues: timeline.cues, presses: timeline.presses, storyDuration: timeline.duration, bpm: options.bpm });
  const lastStoryFrame = timeline.duration - 1 / timeline.fps;
  // Past the logo press the end card is still, so the video can hold it until the music's bar line.
  return { ...plan, frameAt: (out) => Math.min(plan.toStory(out), lastStoryFrame) };
}

function describePlan(plan) {
  if (!plan.grid) return;
  console.log(`At ${plan.grid.bpm} BPM (beat ${plan.grid.beat.toFixed(3)} s, bar ${plan.grid.bar.toFixed(3)} s), ${plan.duration.toFixed(2)} s long:`);
  for (const point of plan.points.slice(1)) {
    const beats = point.out / plan.grid.beat;
    console.log(`  ${point.label.padEnd(24)} story ${point.story.toFixed(2).padStart(6)} -> ${point.out.toFixed(3).padStart(7)} s  (beat ${beats.toFixed(2)}, bar ${(plan.grid.beat * beats / plan.grid.bar).toFixed(2)})`);
  }
}

async function renderVideo(scene, work, options) {
  const { fps, presses, cues } = scene.timeline;
  const plan = planFor(scene.timeline, options);
  describePlan(plan);
  const tonic = options.key ? tonicFor(options.key) : undefined;
  const effects = effectTracks({ duration: plan.duration, presses, cues, toOut: plan.toOut, tonic });
  const audioPath = await buildSoundtrack({ work, duration: plan.duration, effects, music: options.music, finalHit: plan.finalHit });
  await mkdir(OUT, { recursive: true });
  const outPath = join(OUT, options.out ? `authdeck-promo-${options.out}.mp4` : 'authdeck-promo.mp4');
  const encoder = startEncoder({ fps, duration: plan.duration, audioPath, outPath });
  const frames = Math.round(plan.duration * fps);
  for (let i = 0; i < frames; i++) {
    await encoder.write(await scene.frame(plan.frameAt(i / fps)));
    if (i % fps === 0) process.stdout.write(`\rFrame ${i}/${frames}`);
  }
  await encoder.finish();
  console.log(`\rWrote ${outPath} (${frames} frames). Taps at ${presses.map((p) => plan.toOut(p.at).toFixed(2)).join(', ')} s.`);
}

async function renderStills(scene, times, options) {
  const plan = planFor(scene.timeline, options);
  const dir = join(OUT, 'stills');
  await mkdir(dir, { recursive: true });
  for (const t of times) {
    const path = join(dir, `t-${t.toFixed(2)}.png`);
    await writeFile(path, await scene.frame(plan.frameAt(t)));
    console.log(`Wrote ${path}`);
  }
}

function readOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      serve: { type: 'boolean' },
      stills: { type: 'string' },
      music: { type: 'string' },
      bpm: { type: 'string' },
      offset: { type: 'string', default: '0' },
      ending: { type: 'string' },
      key: { type: 'string' },
      fade: { type: 'string', default: '1' },
      out: { type: 'string' },
    },
  });
  const number = (name) => {
    const value = Number(values[name]);
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got "${values[name]}".`);
    return value;
  };
  if (values.music && !values.bpm) throw new Error('--music needs --bpm (and usually --offset) so the cuts can follow the beat.');
  if (values.out && !/^[a-z0-9-]+$/.test(values.out)) throw new Error('--out takes a short name such as "chiptune" (letters, digits, dashes).');
  return {
    serve: values.serve,
    stills: values.stills?.split(',').map(Number),
    bpm: values.bpm ? number('bpm') : undefined,
    key: values.key,
    out: values.out,
    music: {
      path: values.music ? resolve(values.music) : undefined,
      offset: number('offset'),
      ending: values.ending === undefined ? undefined : number('ending'),
      fade: number('fade'),
    },
  };
}

async function main() {
  const options = readOptions(process.argv.slice(2));
  const server = await startServer();
  const url = `http://127.0.0.1:${server.address().port}/video/scene.html`;
  if (options.serve) {
    console.log(`Preview at ${url}?play or ${url}?t=6.2 (Ctrl+C to stop).`);
    return;
  }
  const work = await mkdtemp(join(tmpdir(), 'authdeck-video-'));
  let scene;
  try {
    scene = await openScene(url, join(work, 'chrome'));
    if (options.stills) await renderStills(scene, options.stills, options);
    else await renderVideo(scene, work, options);
  } finally {
    await scene?.close();
    server.close();
    await rm(work, { recursive: true, force: true });
  }
}

await main();
