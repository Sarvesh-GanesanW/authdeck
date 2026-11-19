/**
 * Fits the promo's story timeline onto a music track's beat grid.
 *
 * The scene is drawn in "story time" (scene.js). The video plays in "output time", which starts
 * on a bar line of the music. Anchors (cuts, taps, success moments, the end-card logo press) are
 * moved onto the grid, and story time is stretched linearly between them, so nothing on screen
 * changes except a few hundredths of a second of pace.
 */

/** How far a cut may move to land on a bar line, rather than just a beat. */
const MAX_BAR_SHIFT = 0.3;
/** Story seconds per output second allowed between two anchors (0.7 slows, 1.4 speeds up). */
const MIN_RATE = 0.7;
const MAX_RATE = 1.4;
/** Least time the end card stays after the logo press, then the video runs to the next bar line. */
const MIN_TAIL = 2.2;
/** Reading time a caption needs: this much a word, plus a second. */
const READ_PER_WORD = 0.3;
const READ_BASE = 1.0;

/** Grid steps each anchor kind may land on, most preferred first, with the most it may move. */
const SNAP_RULES = {
  cut: [{ step: 'bar', reach: MAX_BAR_SHIFT }, { step: 'beat', reach: Infinity }],
  tap: [{ step: 'beat', reach: Infinity }],
  hit: [{ step: 'eighth', reach: Infinity }],
  final: [{ step: 'bar', reach: Infinity }],
};
const CANDIDATES_PER_STEP = 3;

const BEATS_PER_BAR = 4;

export function beatGrid(bpm) {
  const beat = 60 / bpm;
  return { bpm, beat, eighth: beat / 2, bar: beat * BEATS_PER_BAR };
}

/** Grid points of one step size near `ideal`, nearest first, within `reach`. */
function gridPointsNear(ideal, step, reach) {
  const below = Math.floor(ideal / step);
  const points = [];
  for (let k = below - CANDIDATES_PER_STEP + 1; k <= below + CANDIDATES_PER_STEP; k++) {
    const at = k * step;
    if (at > 0 && Math.abs(at - ideal) <= reach) points.push(at);
  }
  return points.sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal));
}

function candidates(anchor, ideal, grid) {
  const seen = new Set();
  return SNAP_RULES[anchor.kind]
    .flatMap(({ step, reach }) => gridPointsNear(ideal, grid[step], reach))
    .filter((at) => !seen.has(at.toFixed(6)) && seen.add(at.toFixed(6)));
}

function isRateOk(previous, story, out) {
  if (out <= previous.out) return false;
  const rate = (story - previous.story) / (out - previous.out);
  return rate >= MIN_RATE && rate <= MAX_RATE;
}

/**
 * Places every anchor on the grid, preferring the nearest allowed point to where the story would
 * put it (carrying earlier shifts forward), and backtracking when a choice leaves no room later
 * or the finished placement fails `isAcceptable`.
 */
function place(anchors, grid, isAcceptable) {
  const placed = [{ story: 0, out: 0, kind: 'start', label: 'start' }];
  const search = (index) => {
    if (index === anchors.length) return isAcceptable(placed);
    const anchor = anchors[index];
    const previous = placed[placed.length - 1];
    const ideal = anchor.at + (previous.out - previous.story);
    for (const out of candidates(anchor, ideal, grid)) {
      if (!isRateOk(previous, anchor.at, out)) continue;
      placed.push({ story: anchor.at, out, kind: anchor.kind, label: anchor.label });
      if (search(index + 1)) return true;
      placed.pop();
    }
    return false;
  };
  if (!search(0)) throw new Error(`No beat placement at ${grid.bpm} BPM keeps every caption readable within the pace limits. Check --bpm, or loosen MIN_RATE/MAX_RATE in beat-sync.mjs.`);
  return placed;
}

/** Piecewise-linear map through `points` ({from, to}), slope 1 past the last point. */
function interpolate(points, from, to) {
  return (t) => {
    let i = 1;
    while (i < points.length - 1 && t > points[i][from]) i++;
    const a = points[i - 1];
    const b = points[i];
    if (t > b[from]) return b[to] + (t - b[from]);
    return a[to] + ((t - a[from]) * (b[to] - a[to])) / (b[from] - a[from]);
  };
}

/** Whether every caption stays on screen for its reading time under this time map. */
function isReadable(captions, toOut) {
  return captions.every((caption) => {
    const words = caption.text.trim().split(/\s+/).length;
    const shown = toOut(caption.to) - toOut(caption.from);
    return shown + 1e-6 >= READ_PER_WORD * words + READ_BASE;
  });
}

/**
 * The story anchors, in order: each cut, tap and success moment. The last tap (the end-card logo
 * press) is the "final" anchor, which the music's closing hit lands on.
 */
export function storyAnchors({ cues, presses }) {
  const finalPress = presses[presses.length - 1];
  const anchors = [
    ...cues.cuts.map((at, i) => ({ at, kind: 'cut', label: `cut ${i + 1}` })),
    ...presses.slice(0, -1).map((p) => ({ at: p.at, kind: 'tap', label: `tap ${p.target}` })),
    ...cues.successes.map((at, i) => ({ at, kind: 'hit', label: `success ${i + 1}` })),
    { at: finalPress.at, kind: 'final', label: `final ${finalPress.target}` },
  ];
  return anchors.sort((a, b) => a.at - b.at);
}

/**
 * Plans the output timeline. With no bpm, output time is story time. Returns the placed anchors,
 * both time maps, the output duration and the output time of the closing hit.
 */
export function planTimeline({ cues, presses, storyDuration, bpm }) {
  if (!bpm) {
    const same = (t) => t;
    return { points: [], toOut: same, toStory: same, duration: storyDuration, finalHit: presses[presses.length - 1].at, grid: null };
  }
  const grid = beatGrid(bpm);
  const points = place(storyAnchors({ cues, presses }), grid, (placed) => isReadable(cues.captions, interpolate(placed, 'story', 'out')));
  const toOut = interpolate(points, 'story', 'out');
  const toStory = interpolate(points, 'out', 'story');
  const finalHit = points[points.length - 1].out;
  const duration = Math.ceil((finalHit + MIN_TAIL) / grid.bar - 1e-9) * grid.bar;
  return { points, toOut, toStory, duration, finalHit, grid };
}
