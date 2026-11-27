// Layout checks over window.__EV.inspect(t) samples: caption overflow and frame edges,
// caption overlap with active spotlights and declared avoid regions, caption continuity at
// ordinary edits, and seek-order independence. The browser side only measures; every rule
// lives in analyzeLayout so it can be tested without a browser.
import { engine } from './storyboard.mjs';

// Pixel and opacity tolerances. inspect rounds to 0.01 px and flags frame-edge overflow
// at 0.5 px, so these stay above that rounding.
export const TOLERANCE = {
  edge: 0.5,
  overlap: 1,
  continuity: 1,
  visible: 0.02,
  settled: 0.99
};

export const LIMITS = [
  'During a crossfade only the more visible step is inspected, so the outgoing caption is not checked for its last half fade.',
  'Overlap uses the caption box and the spotlight or avoid rectangles; the checker does not find dialogs or controls on its own. Declare them as avoid regions.',
  'The seek-order check compares inspect geometry and a canonical copy of the stage DOM for every frame, and screenshots for sampled frames only. Canvas pixels (the spotlight scrim) are compared only in those screenshots.'
];

/**
 * Page-side helper, evaluated once after the player is ready. Defines
 * window.__EVCHECK.sample(times) returning [{inspect, sig}] where `sig` is a hash of the
 * inspect result plus the visible stage DOM with attributes and inline styles in sorted
 * order, so the same rendered state gives the same signature whatever order styles were set.
 * Elements with the hidden attribute, inline opacity 0, visibility hidden or display none count as hidden and
 * their subtree is skipped: the engine leaves steps that are off screen as they were.
 */
export const PAGE_HELPER = `(function () {
  function fnv(h, s) {
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }
  function walk(node, h) {
    if (node.nodeType === 3) return fnv(h, '#' + node.nodeValue);
    if (node.nodeType !== 1) return h;
    h = fnv(h, '<' + node.tagName);
    // A hidden subtree keeps whatever state its last render left; only visible state counts.
    var css = node.style;
    if (node.hidden || css.opacity === '0' || css.visibility === 'hidden' || css.display === 'none') return fnv(h, 'hidden>');
    var attrs = [];
    for (var i = 0; i < node.attributes.length; i++) {
      var a = node.attributes[i];
      if (a.name !== 'style' && !(a.name === 'class' && !a.value)) attrs.push(a.name + '=' + a.value);
    }
    attrs.sort();
    var styles = [];
    for (var j = 0; j < node.style.length; j++) {
      var p = node.style[j];
      styles.push(p + ':' + node.style.getPropertyValue(p));
    }
    styles.sort();
    h = fnv(h, attrs.join(' ') + '|' + styles.join(';'));
    if (node.tagName === 'TEMPLATE') return h;
    for (var c = node.firstChild; c; c = c.nextSibling) h = walk(c, h);
    return fnv(h, '>');
  }
  var stage = document.getElementById('ev-stage');
  window.__EVCHECK = {
    sample: function (times) {
      return times.map(function (t) {
        var r = window.__EV.inspect(t);
        var sig = walk(stage, fnv(2166136261, JSON.stringify(r)));
        return { inspect: r, sig: sig.toString(16) };
      });
    }
  };
})()`;

/** Frame times the renderer encodes: frame i is at i / fps, for i below round(total * fps). */
export function frameCount(total, fps) {
  return Math.round(total * fps);
}

/** First encoded frame whose time is at or after a boundary, using the player's exact comparison. */
export function firstFrameAt(time, fps) {
  let frame = Math.ceil(time * fps);
  if (frame / fps < time) frame++;
  if (frame > 0 && (frame - 1) / fps >= time) frame--;
  return frame;
}

/** Deterministic permutation of 0..n-1 (a fixed-seed LCG Fisher-Yates), for the jumpy seek pass. */
export function shuffledOrder(n, seed = 0x2545f491) {
  const order = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  for (let i = n - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

const outside = (r, w, h) => r[0] < -TOLERANCE.edge || r[1] < -TOLERANCE.edge || r[0] + r[2] > w + TOLERANCE.edge || r[1] + r[3] > h + TOLERANCE.edge;

/** Intersection [x, y, w, h] of two rects, or null when they share less than the overlap tolerance. */
export function intersection(a, b) {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - x;
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - y;
  return w > TOLERANCE.overlap && h > TOLERANCE.overlap ? [x, y, w, h].map((v) => Math.round(v * 100) / 100) : null;
}

const fmt = (t) => `${t.toFixed(3)}s`;

/**
 * Per-frame findings for one inspect sample. Steps in findings are 1-based, like validation messages.
 * @returns {{kind: string, step: number, region?: number, rect?: number[], other?: number[]}[]}
 */
function frameFindings(r, width, height) {
  const found = [];
  if (r.section) {
    if (r.section.textOverflow && r.section.opacity > TOLERANCE.visible) {
      found.push({ kind: 'section-out-of-frame', step: r.section.step + 1, rect: r.section.rect });
    }
    return found;
  }
  const c = r.caption;
  if (!c || c.opacity <= TOLERANCE.visible) return found;
  const step = r.step + 1;
  if (outside(c.rect, width, height)) found.push({ kind: 'caption-out-of-frame', step, rect: c.rect });
  else if (c.textOverflow) found.push({ kind: 'caption-overflow', step, rect: c.rect });
  r.spotlights.forEach((s, j) => {
    if (s.opacity <= TOLERANCE.visible) return;
    const hit = intersection(c.rect, s.rect);
    if (hit) found.push({ kind: 'caption-covers-spotlight', step, region: j, rect: c.rect, other: s.rect, overlap: hit });
  });
  r.avoid.forEach((a, j) => {
    const hit = intersection(c.rect, a);
    if (hit) found.push({ kind: 'caption-covers-avoid', step, region: j, rect: c.rect, other: a, overlap: hit });
  });
  return found;
}

const DESCRIBE = {
  'section-out-of-frame': (f) => `step ${f.step}: section title crosses the frame edge at ${f.rect.join(', ')}`,
  'caption-out-of-frame': (f) => `step ${f.step}: caption crosses the frame edge at ${f.rect.join(', ')}`,
  'caption-overflow': (f) => `step ${f.step}: caption text does not fit its box`,
  'caption-covers-spotlight': (f) => `step ${f.step}: caption covers spotlights[${f.region}] (overlap ${f.overlap.join(', ')})`,
  'caption-covers-avoid': (f) => `step ${f.step}: caption covers avoid[${f.region}] (overlap ${f.overlap.join(', ')})`,
  'seek-order': (f) => `rendered state differs when frames are seeked in ${f.pass} order`
};

/** Merge per-frame findings into runs of consecutive frames with the same kind, step and region. */
function groupRuns(perFrame, fps) {
  const runs = [];
  const open = new Map();
  perFrame.forEach((findings, frame) => {
    const seen = new Set();
    for (const f of findings) {
      const key = `${f.kind}|${f.step}|${f.region ?? ''}`;
      seen.add(key);
      const run = open.get(key);
      if (run && run.lastFrame === frame - 1) {
        run.lastFrame = frame;
      } else {
        const fresh = { ...f, firstFrame: frame, lastFrame: frame };
        open.set(key, fresh);
        runs.push(fresh);
      }
    }
  });
  return runs.map((run) => {
    const from = run.firstFrame / fps;
    const to = run.lastFrame / fps;
    const frames = run.lastFrame - run.firstFrame + 1;
    const { firstFrame, lastFrame, ...rest } = run;
    const span = frames === 1 ? `at ${fmt(from)} (frame ${firstFrame})` : `from ${fmt(from)} to ${fmt(to)} (frames ${firstFrame}–${lastFrame})`;
    return { ...rest, from, to, firstFrame, frames, message: `${span}: ${DESCRIBE[run.kind](run)}` };
  });
}

/** Nearest sample from `start` moving by `dir` whose caption belongs to `step`, within the step's frames. */
function captionNear(samples, start, dir, step, lo, hi) {
  for (let k = start; k >= lo && k <= hi; k += dir) {
    const r = samples[k];
    if (r.step === step && r.caption) return { frame: k, caption: r.caption };
  }
  return null;
}

/**
 * Caption continuity at ordinary edits (two non-section steps in a row).
 * Continuous captions must be fully visible on both frames of the edit and keep their left,
 * top and width. The two-line preset without a placed box must keep its whole box, so the
 * badge and both baselines stay put. Other caption styles have no continuity rule.
 */
function continuityChecks(sb, timeline, samples, fps) {
  const results = [];
  const failures = [];
  const continuous = sb.captionMotion === 'continuous';
  const twoLine = sb.captionStyle === 'two-line';
  for (let i = 0; i + 1 < sb.steps.length; i++) {
    const a = sb.steps[i];
    const b = sb.steps[i + 1];
    if (a.section || b.section) continue;
    const placed = a.caption?.box || b.caption?.box;
    const rule = continuous ? 'continuous' : twoLine && !placed ? 'two-line' : null;
    if (!rule) continue;
    const edit = timeline.steps[i + 1].start;
    const after = firstFrameAt(edit, fps);
    const before = after - 1;
    if (before < 0 || after >= samples.length) continue;
    const entry = { edit: i + 2, time: edit, rule, beforeFrame: before, afterFrame: after, ok: true };
    let problem = null;
    let left;
    let right;
    if (rule === 'continuous') {
      left = samples[before].step === i ? samples[before].caption : null;
      right = samples[after].step === i + 1 ? samples[after].caption : null;
      if (!left || !right || left.opacity < TOLERANCE.settled || right.opacity < TOLERANCE.settled) {
        problem = 'continuous caption is not fully visible on both sides of the edit';
      }
    } else {
      const lo = firstFrameAt(timeline.steps[i].start, fps);
      const hi = Math.min(samples.length - 1, firstFrameAt(timeline.steps[i + 1].end, fps) - 1);
      left = captionNear(samples, before, -1, i, lo, after)?.caption;
      right = captionNear(samples, after, 1, i + 1, before, hi)?.caption;
      if (!left || !right) continue;
    }
    if (!problem) {
      const keys = rule === 'continuous' ? [0, 1, 2] : [0, 1, 2, 3];
      const moved = keys.filter((k) => Math.abs(left.rect[k] - right.rect[k]) > TOLERANCE.continuity);
      if (moved.length) {
        problem = `caption box moves from ${left.rect.join(', ')} to ${right.rect.join(', ')}`;
      }
    }
    if (problem) {
      entry.ok = false;
      failures.push({
        kind: 'caption-jump', step: i + 2, from: before / fps, to: after / fps, firstFrame: before, frames: 2,
        rect: left?.rect, other: right?.rect,
        message: `at the edit into step ${i + 2} (${fmt(edit)}, frames ${before}–${after}): ${problem}`
      });
    }
    results.push(entry);
  }
  return { results, failures };
}

/**
 * Run every geometry rule over forward-order samples.
 * @param {object} sb storyboard
 * @param {object[]} samples inspect results for frames 0..n-1, in frame order
 * @param {{fps: number, width: number, height: number}} frame
 * @returns {{failures: object[], continuity: object[]}}
 */
export function analyzeLayout(sb, samples, { fps, width, height }) {
  const timeline = engine.buildTimeline(sb);
  const perFrame = samples.map((r) => frameFindings(r, width, height));
  const continuity = continuityChecks(sb, timeline, samples, fps);
  const failures = [...groupRuns(perFrame, fps), ...continuity.failures].sort((x, y) => x.from - y.from || x.kind.localeCompare(y.kind));
  return { failures, continuity: continuity.results };
}

/**
 * Compare signatures from two seek orders, frame by frame.
 * @param {string[]} reference signatures in frame order from the forward pass
 * @param {string[]} other signatures in frame order from another pass
 * @param {string} pass name of the other pass, used in messages
 */
export function seekOrderFailures(reference, other, pass, fps) {
  const perFrame = reference.map((sig, k) => (sig === other[k] ? [] : [{ kind: 'seek-order', step: null, pass }]));
  return groupRuns(perFrame, fps);
}

// Frames per Runtime.evaluate call. Each inspect forces one layout; 120 keeps a call far
// below the 30 s DevTools reply bound even for heavy scenes.
const BATCH = 120;

/**
 * Inspect frames in the given order inside the page. Needs PAGE_HELPER evaluated first.
 * @param {object} session browser session with a ready player page
 * @param {number[]} order frame indices, sampled in exactly this order
 * @param {(done: number) => void} [onBatch] progress callback
 * @returns {Promise<{inspect: object, sig: string}[]>} results aligned with `order`
 */
export async function sampleFrames(session, order, fps, onBatch) {
  const out = new Array(order.length);
  for (let i = 0; i < order.length; i += BATCH) {
    const times = order.slice(i, i + BATCH).map((k) => k / fps);
    const results = await session.evaluate(`window.__EVCHECK.sample(${JSON.stringify(times)})`);
    results.forEach((r, j) => { out[i + j] = r; });
    onBatch?.(Math.min(i + BATCH, order.length));
  }
  return out;
}
