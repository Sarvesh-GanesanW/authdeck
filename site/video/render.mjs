#!/usr/bin/env node
/**
 * Renders the AuthDeck promo (scene.html) to an MP4, frame by frame, in headless Chrome.
 *
 *   node site/video/render.mjs                 full video into site/video/out/authdeck-promo.mp4
 *   node site/video/render.mjs --stills 1,6.2  PNG frames at those times into site/video/out/stills/
 *   node site/video/render.mjs --serve         serve the scene for a browser preview (?t=6.2 or ?play)
 *
 * The page exposes `promo.render(t)`, which sets the exact state for time t, so frames never
 * depend on how fast the machine is. Click sounds are synthesised here, one per tap.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIDEO = dirname(fileURLToPath(import.meta.url));
const SITE = dirname(VIDEO);
const REPO = dirname(SITE);
const ICON_DIR = join(REPO, 'app', 'node_modules', 'pixelarticons', 'svg');
const OUT = join(VIDEO, 'out');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTH = 1920;
const HEIGHT = 1080;
const SAMPLE_RATE = 48000;

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
  const timeline = await evaluate(cdp, '({ fps: promo.fps, duration: promo.duration, presses: promo.presses })');
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

/* ---------- Click track ---------- */

/** A small seeded generator, so the clicks sound the same on every render. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A short keycap click: a noise transient, a bright ping and a low body, each decaying fast. */
function addClick(samples, at, random) {
  const start = Math.round(at * SAMPLE_RATE);
  const ping = 3000 + random() * 500;
  const body = 170 + random() * 40;
  const length = Math.round(0.06 * SAMPLE_RATE);
  let smoothed = 0;
  for (let i = 0; i < length && start + i < samples.length; i++) {
    const s = i / SAMPLE_RATE;
    smoothed = 0.6 * smoothed + 0.4 * (random() * 2 - 1);
    const value = smoothed * Math.exp(-s / 0.0018) * 0.55
      + Math.sin(2 * Math.PI * ping * s) * Math.exp(-s / 0.006) * 0.22
      + Math.sin(2 * Math.PI * body * s) * Math.exp(-s / 0.016) * 0.4;
    samples[start + i] += value * 0.5;
  }
  // The softer tick of the key coming back up.
  const release = start + Math.round(0.1 * SAMPLE_RATE);
  for (let i = 0; i < 0.02 * SAMPLE_RATE && release + i < samples.length; i++) {
    const s = i / SAMPLE_RATE;
    samples[release + i] += (random() * 2 - 1) * Math.exp(-s / 0.0012) * 0.12;
  }
}

function clickTrack(duration, presses) {
  const samples = new Float32Array(Math.ceil(duration * SAMPLE_RATE));
  const random = seededRandom(47474);
  for (const press of presses) addClick(samples, press.at, random);
  return samples;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
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
    '-c:a', 'aac', '-b:a', '128k', '-ar', String(SAMPLE_RATE),
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

async function renderVideo(scene, work) {
  const { fps, duration, presses } = scene.timeline;
  const audioPath = join(work, 'clicks.wav');
  await writeFile(audioPath, wav(clickTrack(duration, presses)));
  await mkdir(OUT, { recursive: true });
  const outPath = join(OUT, 'authdeck-promo.mp4');
  const encoder = startEncoder({ fps, duration, audioPath, outPath });
  const frames = Math.round(duration * fps);
  for (let i = 0; i < frames; i++) {
    await encoder.write(await scene.frame(i / fps));
    if (i % fps === 0) process.stdout.write(`\rFrame ${i}/${frames}`);
  }
  await encoder.finish();
  console.log(`\rWrote ${outPath} (${frames} frames). Clicks at ${presses.map((p) => p.at.toFixed(2)).join(', ')} s.`);
}

async function renderStills(scene, times) {
  const dir = join(OUT, 'stills');
  await mkdir(dir, { recursive: true });
  for (const t of times) {
    const path = join(dir, `t-${t.toFixed(2)}.png`);
    await writeFile(path, await scene.frame(t));
    console.log(`Wrote ${path}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const server = await startServer();
  const url = `http://127.0.0.1:${server.address().port}/video/scene.html`;
  if (args.includes('--serve')) {
    console.log(`Preview at ${url}?play or ${url}?t=6.2 (Ctrl+C to stop).`);
    return;
  }
  const work = await mkdtemp(join(tmpdir(), 'authdeck-video-'));
  let scene;
  try {
    scene = await openScene(url, join(work, 'chrome'));
    const stillsAt = args.indexOf('--stills');
    if (stillsAt >= 0) await renderStills(scene, args[stillsAt + 1].split(',').map(Number));
    else await renderVideo(scene, work);
  } finally {
    await scene?.close();
    server.close();
    await rm(work, { recursive: true, force: true });
  }
}

await main();
