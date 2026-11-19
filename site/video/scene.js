/*
 * The promo's timeline. `render(t)` puts the page in the exact state for time t (seconds), so
 * render.mjs can capture any frame on demand; nothing on the page animates by itself.
 *
 * Every moving part is a pure function of time and moves in whole steps, like the pixel art:
 * a key sinks into its shadow in two frames and springs back in three.
 */
'use strict';

const FPS = 30;
const ICONS = ['plus', 'wifi', 'square-chevron-right', 'play', 'bug', 'git-merge', 'server', 'external-link', 'stop', 'check'];

/** Half the length of the pixel wipe that covers each cut. */
const WIPE_HALF = 0.2;
const WIPE_BLOCK = 120;
const WIPE_COLOR = '#14161b';

const CURSOR_PERIOD = 1.0;
const TYPE_STEP = 0.035;

const STAGE_SCENES = { keys: 'keys', codes: 'codes', env: 'env' };

/**
 * The storyboard. Times inside a scene are seconds from its start; `presses` are the taps,
 * which also place the click sounds.
 */
const SCENES = [
  { id: 'intro', start: 0, end: 5.0, presses: [{ at: 0.5, target: 'intro-mark' }] },
  { id: 'keys', start: 5.0, end: 12.4, presses: [{ at: 1.0, target: 'key-palette' }, { at: 3.0, target: 'key-tests' }] },
  { id: 'codes', start: 12.4, end: 18.2, presses: [{ at: 1.6, target: 'row-github' }] },
  { id: 'env', start: 18.2, end: 25.6, presses: [{ at: 3.5, target: 'sheet-allow' }] },
  { id: 'end', start: 25.6, end: 31.6, presses: [{ at: 3.75, target: 'end-mark' }] },
];
const END_FINAL_AT = 3.3;
const DURATION = SCENES[SCENES.length - 1].end;
const WIPES = [...SCENES.slice(1).map((s) => s.start), SCENES[4].start + END_FINAL_AT];

const KEYS_TIMES = { paletteOpen: 1.07, paletteClose: 2.7, typeTest: 3.1, testHeader: 3.5, testsDone: 4.6, caption2: 3.7 };
const CODES_TIMES = { firstDigit: 1.8, digitStep: 0.09, signedIn: 2.7 };
const ENV_TIMES = { typeCmd: 0.4, check: 1.75, ask: 2.05, sheetIn: 2.2, sheetOut: 3.75, allowed: 3.8, output: 4.1, server: 4.5 };
const SHEET_TRAVEL = 520;

const OTP = '482913';
/** Seconds already gone in each code's 30 s window at t = 0, chosen so no code rolls over on screen. */
const TIMER_OFFSETS = { github: 27, cloud: 20, steam: 0, aws: 9 };
const TOTP_PERIOD = 30;

const $ = (id) => document.getElementById(id);

/* ---------- Small pure helpers ---------- */

function typed(text, startAt, t) {
  if (t < startAt) return '';
  return text.slice(0, Math.floor((t - startAt) / TYPE_STEP) + 1);
}

function isCursorOn(t) {
  return Math.floor(t / (CURSOR_PERIOD / 2)) % 2 === 0;
}

/** Key travel in px for a press `dt` seconds ago: down in two frames, a small overshoot, rest. */
function keyTravel(dt, sink) {
  if (dt < 0 || dt >= 0.166) return { y: 0, isDown: false };
  if (dt < 0.025) return { y: sink / 2, isDown: true };
  if (dt < 0.1) return { y: sink, isDown: true };
  return { y: -3, isDown: false };
}

function flashOpacity(dt) {
  if (dt < 0 || dt >= 0.15) return 0;
  return 0.75 * (1 - Math.floor(dt / 0.05) / 3);
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The press in `scene` nearest before `local` (allowing a short lead for the finger), as seconds since it. */
function sincePress(scene, target, local) {
  let best = null;
  for (const press of scene.presses) {
    if (press.target !== target) continue;
    const dt = local - press.at;
    if (dt >= -0.1 && (best === null || dt < best)) best = dt;
  }
  return best;
}

/* ---------- DOM state setters (each frame sets everything it shows) ---------- */

function show(el, isShown) {
  // An attribute, not el.hidden: SVG elements have no hidden property.
  el.toggleAttribute('hidden', !isShown);
}

const htmlCache = new Map();
function setHtml(el, html) {
  if (htmlCache.get(el) === html) return;
  htmlCache.set(el, html);
  el.innerHTML = html;
}

function setCaption(text, shownFor) {
  const caption = $('caption');
  caption.textContent = text;
  // Captions cut in with a three-frame stepped reveal from the left.
  const step = Math.min(3, Math.floor(shownFor * FPS) + 1);
  caption.style.clipPath = `inset(0 ${100 - (step * 100) / 3}% 0 0)`;
}

function pressKey(el, dt, sink) {
  const travel = dt === null ? { y: 0, isDown: false } : keyTravel(dt, sink);
  el.style.transform = travel.y ? `translateY(${travel.y}px)` : '';
  el.classList.toggle('is-down', travel.isDown);
  const flash = el.querySelector('.key-flash');
  if (flash) flash.style.opacity = dt === null ? 0 : flashOpacity(dt);
}

function pressMark(svg, dt) {
  const travel = dt === null ? { y: 0, isDown: false } : keyTravel(dt, 1);
  // In mark units: one voxel down, a quarter voxel of overshoot.
  const y = travel.y === -3 ? -0.25 : travel.y;
  svg.querySelector('.mark-cap').setAttribute('transform', `translate(0 ${y})`);
  svg.querySelector('.mark-shadow').style.visibility = travel.isDown ? 'hidden' : 'visible';
}

function placeTap(target, dt) {
  const tap = $('tap');
  const isTouching = dt !== null && dt < 0.3;
  show(tap, isTouching);
  if (!isTouching) return;
  const box = target.getBoundingClientRect();
  tap.style.transform = `translate(${Math.round(box.left + box.width / 2)}px, ${Math.round(box.top + box.height / 2)}px)`;
  show($('tap-dot'), dt < 0.22);
  const ring = $('tap-ring');
  const ringStep = dt < 0 ? -1 : Math.floor(dt / 0.067);
  show(ring, ringStep >= 0 && ringStep < 3);
  const size = 52 + ringStep * 20;
  Object.assign(ring.style, { width: `${size}px`, height: `${size}px`, left: `${-size / 2}px`, top: `${-size / 2}px`, opacity: [0.7, 0.45, 0.2][ringStep] ?? 0 });
}

function drawTimers(t) {
  for (const bar of document.querySelectorAll('[data-timer]')) {
    const gone = (t + TIMER_OFFSETS[bar.dataset.timer]) % TOTP_PERIOD;
    const left = 1 - gone / TOTP_PERIOD;
    bar.style.width = `${Math.floor(left * 60) / 0.6}%`;
  }
}

/* ---------- Terminal ---------- */

const PROMPT = '<span class="term-prompt">~/code/web</span> ';
const CURSOR = '<span class="cursor"></span>';

function promptLine(command, hasCursor) {
  return `${PROMPT}<span class="term-cmd">${escapeHtml(command)}</span>${hasCursor ? CURSOR : ''}`;
}
const dim = (text) => `<span class="term-dim">${escapeHtml(text)}</span>`;
const ok = (text) => `<span class="term-ok">${escapeHtml(text)}</span>`;

function testTerminal(l) {
  const T = KEYS_TIMES;
  const cursorOn = isCursorOn(l);
  if (l < T.typeTest) return promptLine('', cursorOn);
  const command = typed('npm test', T.typeTest, l);
  const lines = [promptLine(command, l < T.testHeader)];
  if (l >= T.testHeader) lines.push(dim('> web@2.3.0 test'), dim('> vitest run'), '');
  if (l >= T.testsDone) lines.push(ok('✓ 24 tests passed in 1.6 s'), '', promptLine('', cursorOn));
  return lines.join('\n');
}

function envTerminal(l) {
  const T = ENV_TIMES;
  if (l < T.typeCmd) return promptLine('', isCursorOn(l));
  const lines = [promptLine(typed('authdeck env run -- npm run dev', T.typeCmd, l), l < T.check)];
  if (l >= T.check) lines.push(dim('web: 12 variables, signatures check out (rev 7, epoch 2)'));
  if (l >= T.ask) lines.push(dim('Asking Pixel 8 to release them… waiting 0:03'));
  if (l >= T.allowed) lines.push(ok('Pixel 8 allowed web for 15 minutes (until 11:58).'));
  if (l >= T.output) lines.push('', dim('> web@2.3.0 dev'), dim('> vite'));
  if (l >= T.server) lines.push('', '  Local: http://localhost:5173/');
  return lines.join('\n');
}

/* ---------- Scenes ---------- */

function drawIntro(scene, l) {
  const isLockup = l >= 0.85;
  const big = $('intro').querySelector('.mark-big');
  show(big, !isLockup);
  show($('intro-lockup'), isLockup);
  show($('intro-headline'), l >= 1.0);
  // Power on like the deck: off, on, dim, on.
  big.style.opacity = l < 0.1 ? 0 : l < 0.2 ? 1 : l < 0.27 ? 0.4 : 1;
  pressMark(big, sincePress(scene, 'intro-mark', l));
}

function setStage(view) {
  const isCodes = view === STAGE_SCENES.codes;
  show($('phone-deck'), !isCodes);
  show($('phone-codes'), isCodes);
  show($('ide'), !isCodes);
  show($('signin'), isCodes);
  $('window-title').textContent = isCodes ? 'Sign in' : 'web';
  show($('palette'), false);
  show($('sheet'), false);
  show($('scrim'), false);
  for (const el of $('stage').querySelectorAll('.key, .btn')) pressKey(el, null, 0);
}

function drawKeys(scene, l) {
  const T = KEYS_TIMES;
  setStage(STAGE_SCENES.keys);
  if (l < T.caption2) setCaption('Tap a key on your phone.', l);
  else setCaption('Your computer does it.', l - T.caption2);

  show($('palette'), l >= T.paletteOpen && l < T.paletteClose);
  show($('palette-cursor'), isCursorOn(l - T.paletteOpen));

  const isRunning = l >= T.typeTest - 0.05 && l < T.testsDone;
  setTestsKey({ isRunning, isOk: l >= T.testsDone, l });

  setHtml($('term'), testTerminal(l));
  drawStagePresses(scene, l, ['key-palette', 'key-tests']);
}

function drawCodes(scene, l) {
  const T = CODES_TIMES;
  setStage(STAGE_SCENES.codes);
  setCaption('2FA codes type themselves.', l);

  const dt = sincePress(scene, 'row-github', l);
  const row = $('row-github');
  row.classList.toggle('is-flash', dt !== null && dt >= 0 && dt < 0.2);
  row.classList.toggle('is-flash-2', dt !== null && dt >= 0 && dt < 0.067);

  const count = l < T.firstDigit ? 0 : Math.min(OTP.length, Math.floor((l - T.firstDigit) / T.digitStep) + 1);
  [...$('otp').children].forEach((cell, i) => {
    const isActive = i === count;
    cell.classList.toggle('is-active', isActive);
    setHtml(cell, i < count ? OTP[i] : isActive && isCursorOn(l) ? CURSOR : '');
  });
  $('signed-in').style.visibility = l >= T.signedIn ? 'visible' : 'hidden';
  placeTap(row, dt);
}

function drawEnv(scene, l) {
  const T = ENV_TIMES;
  setStage(STAGE_SCENES.env);
  setCaption('.env secrets, released from your phone.', l);
  setHtml($('term'), envTerminal(l));
  setTestsKey({ isRunning: false, isOk: true, l });

  // The sheet steps up in four frames and back down in three.
  let offset = SHEET_TRAVEL;
  if (l >= T.sheetIn && l < T.sheetOut) offset = SHEET_TRAVEL * Math.max(0, 1 - (Math.floor((l - T.sheetIn) * FPS) + 1) / 4);
  else if (l >= T.sheetOut) offset = SHEET_TRAVEL * Math.min(1, (Math.floor((l - T.sheetOut) * FPS) + 1) / 3);
  const isSheetShown = offset < SHEET_TRAVEL;
  show($('sheet'), isSheetShown);
  show($('scrim'), isSheetShown);
  $('sheet').style.transform = `translateY(${Math.round(offset)}px)`;

  drawStagePresses(scene, l, ['sheet-allow']);
}

/** The Run tests key's status pixel and marching border; the tests stay passed after scene 2. */
function setTestsKey({ isRunning, isOk, l }) {
  const tests = $('key-tests');
  tests.classList.toggle('is-running', isRunning);
  tests.classList.toggle('is-blink-off', isRunning && Math.floor(l / 0.3) % 2 === 1);
  tests.classList.toggle('is-ok', isOk);
  tests.style.setProperty('--march', `${(Math.floor(l / 0.105) % 4) * 2}px`);
}

/** Taps on raised blocks in the stage: the marker, then the key's travel and flash. */
function drawStagePresses(scene, l, targets) {
  let latest = null;
  for (const id of targets) {
    const el = $(id);
    el.style.transform = '';
    const dt = sincePress(scene, id, l);
    if (dt !== null && (latest === null || dt < latest.dt)) latest = { el, dt };
  }
  placeTap(latest?.el ?? document.body, latest?.dt ?? null);
  for (const id of targets) {
    const el = $(id);
    pressKey(el, sincePress(scene, id, l), el.classList.contains('btn') ? 4 : 6);
  }
}

function drawEnd(scene, l) {
  const isFinal = l >= END_FINAL_AT;
  show($('end-facts'), !isFinal);
  show($('end-final'), isFinal);
  $('end-systems').style.visibility = l >= 0.5 ? 'visible' : 'hidden';
  pressMark($('end-final').querySelector('.mark'), sincePress(scene, 'end-mark', l));
}

const DRAW = { intro: drawIntro, keys: drawKeys, codes: drawCodes, env: drawEnv, end: drawEnd };

/* ---------- Wipe ---------- */

function drawWipe(t) {
  const canvas = $('wipe');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const cut = WIPES.find((b) => t >= b - WIPE_HALF && t < b + WIPE_HALF);
  if (cut === undefined) return;
  // Cover then uncover along the diagonal, in whole frames.
  const frame = Math.floor((t - (cut - WIPE_HALF)) * FPS + 1e-6);
  const half = Math.round(WIPE_HALF * FPS);
  const cols = canvas.width / WIPE_BLOCK;
  const rows = canvas.height / WIPE_BLOCK;
  const span = cols + rows - 2;
  ctx.fillStyle = WIPE_COLOR;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const d = (c + r) / span;
      const isCovered = frame < half ? d <= (frame + 1) / half : d > (frame - half + 1) / half;
      if (isCovered) ctx.fillRect(c * WIPE_BLOCK, r * WIPE_BLOCK, WIPE_BLOCK, WIPE_BLOCK);
    }
  }
}

/* ---------- Public API ---------- */

function sceneAt(t) {
  return SCENES.find((s) => t < s.end) ?? SCENES[SCENES.length - 1];
}

function render(t) {
  const scene = sceneAt(t);
  const isStage = scene.id in STAGE_SCENES;
  show($('intro'), scene.id === 'intro');
  show($('stage'), isStage);
  show($('end'), scene.id === 'end');
  drawTimers(t);
  DRAW[scene.id](scene, t - scene.start);
  drawWipe(t);
}

async function loadIcons() {
  const symbols = await Promise.all(ICONS.map(async (name) => {
    const response = await fetch(`/icons/${name}.svg`);
    if (!response.ok) throw new Error(`Icon ${name} failed to load (${response.status}). Serve the page with render.mjs --serve.`);
    const svg = await response.text();
    const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    return `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`;
  }));
  $('icon-sprite').innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" hidden>${symbols.join('')}</svg>`;
}

async function loadFonts() {
  const faces = ['400 20px Pixelify', '600 20px Pixelify', '400 20px Plex', '500 20px Plex', '600 20px Plex'];
  await Promise.all(faces.map((face) => document.fonts.load(face)));
  await document.fonts.ready;
}

const ready = Promise.all([loadIcons(), loadFonts()]).then(() => render(0));

/** Taps as absolute times, for the click track. */
const presses = SCENES.flatMap((s) => s.presses.map((p) => ({ at: s.start + p.at, target: p.target })));

window.promo = { fps: FPS, duration: DURATION, presses, ready, render };

// Preview in a browser: ?t=12.5 shows one frame, ?play plays it in real time.
const params = new URLSearchParams(location.search);
ready.then(() => {
  if (params.has('t')) render(Number(params.get('t')));
  if (params.has('play')) {
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      render(Math.floor(Math.min(t, DURATION - 1 / FPS) * FPS) / FPS);
      if (t < DURATION) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
});
