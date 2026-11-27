// End-to-end checks through the real renderer. Skipped when no browser or ffmpeg is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const render = join(dirname(fileURLToPath(import.meta.url)), '../scripts/render.mjs');
const has = (name) => spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name]).status === 0;
const browser = process.env.CHROME_PATH || ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'].find(has);
const skip = !browser || !has('ffmpeg') ? 'needs a Chromium-family browser and ffmpeg' : false;

const SCENES = `<style>
.box { position: absolute; inset: 0; background: #0000ff; }
.box.on { background: #ff0000; }
</style>
<template id="s" data-width="400" data-height="300"><div id="parent" class="wrap"><div id="child" class="box"></div></div></template>`;

function storyboard(actionsTarget = '#child') {
  const step = {
    caption: { bold: 'Look', rest: 'at the box.' },
    duration: 3,
    scene: 's',
    // A class action on the parent must not disconnect the child the timed action targets.
    setup: [{ type: 'class', target: '#parent', add: 'ready' }],
    actions: [{ at: 1, type: 'class', target: actionsTarget, add: 'on' }]
  };
  return { version: 1, fps: 30, scenes: 'scenes.html', steps: [step, { ...step }] };
}

function withFixture(sb, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ev-test-'));
  try {
    writeFileSync(join(dir, 'scenes.html'), SCENES);
    writeFileSync(join(dir, 'video.json'), JSON.stringify(sb));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(args) {
  return spawnSync(process.execPath, [render, ...args, '--chromium', browser], { encoding: 'utf8', timeout: 60_000 });
}

/** RGB at an output coordinate, read with ffmpeg so the test needs no PNG decoder. */
function samplePixel(png, x = 960, y = 470) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 20_000 });
  assert.equal(r.status, 0, String(r.stderr));
  return [...r.stdout];
}

test('a timed action on an element nested in a set-up element takes effect', { skip }, () => {
  withFixture(storyboard(), (dir) => {
    const r = run([join(dir, 'video.json'), '--no-video', '--stills', '0.5,2', '--stills-dir', dir]);
    assert.equal(r.status, 0, r.stderr);
    const [before] = [samplePixel(join(dir, 'video-0.50s.png'))];
    const after = samplePixel(join(dir, 'video-2.00s.png'));
    assert.ok(before[2] > 200 && before[0] < 60, `blue before the action, got ${before}`);
    assert.ok(after[0] > 200 && after[2] < 60, `red after the action, got ${after}`);
  });
});

test('a selector that matches nothing is reported by name', { skip }, () => {
  withFixture(storyboard('#nope'), (dir) => {
    const r = run([join(dir, 'video.json'), '--no-video', '--stills', '1', '--stills-dir', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /selector "#nope" matches nothing/);
  });
});

test('a missing browser fails cleanly and leaves no temp directory', { skip }, () => {
  withFixture(storyboard(), (dir) => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('explainer-video-')).length;
    const r = spawnSync(process.execPath, [render, join(dir, 'video.json'), '--no-video', '--stills', '1', '--stills-dir', dir, '--chromium', join(dir, 'no-such-browser')], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot start browser/);
    assert.doesNotMatch(r.stderr, /at .*render\.mjs/, 'no stack trace');
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('explainer-video-')).length;
    assert.equal(after, before);
  });
});

test('a cut switches between fully opaque scenes at the edit frame', { skip }, () => {
  const sb = storyboard();
  sb.steps[1].transition = 'cut';
  withFixture(sb, (dir) => {
    const result = run([join(dir, 'video.json'), '--no-video', '--stills', '2.99,3', '--stills-dir', dir]);
    assert.equal(result.status, 0, result.stderr);
    const before = samplePixel(join(dir, 'video-2.99s.png'));
    const after = samplePixel(join(dir, 'video-3.00s.png'));
    assert.ok(before[0] > 240 && before[2] < 10, `outgoing red frame: ${before}`);
    assert.ok(after[2] > 240 && after[0] < 10, `incoming blue frame: ${after}`);
  });
});

test('full-app fits all edges, preserves overlapping spotlights and places the caption over the dimmed UI', { skip }, () => {
  const sb = storyboard();
  sb.framing = 'full-app';
  const step = sb.steps[0];
  step.caption.box = [700, 700, 400];
  step.camera = [{ at: 0, rect: [50, 50, 40, 40] }];
  step.spotlights = [
    { from: 0, to: 2, rect: [0, 0, 60, 80] },
    { from: 0, to: 2, rect: [30, 0, 60, 80] }
  ];
  withFixture(sb, (dir) => {
    const result = run([join(dir, 'video.json'), '--no-video', '--stills', '0.5', '--stills-dir', dir]);
    assert.equal(result.status, 0, result.stderr);
    const png = join(dir, 'video-0.50s.png');
    // A 4:3 fixture fits this 16:9 frame between x=240 and x=1680.
    for (const [x, y] of [[241, 2], [370, 30], [535, 30]]) {
      assert.ok(samplePixel(png, x, y)[2] > 245, `unshaded blue at ${x},${y}`);
    }
    const dim = samplePixel(png, 1678, 1078)[2];
    assert.ok(dim > 90 && dim < 125, `dimmed bottom-right corner: ${dim}`);
    assert.ok(samplePixel(png, 730, 708)[2] < dim - 20, 'caption backing at the requested location');
  });
});

test('the visible caption moves along its authored path and clears its old position', { skip }, () => {
  const sb = storyboard();
  sb.framing = 'full-app';
  const step = sb.steps[0];
  step.actions = [];
  step.caption.box = [400, 600, 270];
  step.caption.track = [{ at: 2, x: 1100, y: 600, move: 1 }];
  withFixture(sb, (dir) => {
    const result = run([join(dir, 'video.json'), '--no-video', '--stills', '0.5,1.5,2.5', '--stills-dir', dir]);
    assert.equal(result.status, 0, result.stderr);
    for (const [time, left] of [['0.50', 400], ['1.50', 750], ['2.50', 1100]]) {
      const png = join(dir, `video-${time}s.png`);
      assert.ok(samplePixel(png, left + 25, 605)[2] < 120, `caption at ${left}, time ${time}`);
      if (left !== 400) assert.ok(samplePixel(png, 425, 605)[2] > 240, 'previous position cleared');
    }
  });
});

test('active controls have a bright outline and the caption stays visible across an edit', { skip }, () => {
  const sb = storyboard();
  sb.framing = 'full-app';
  sb.captionMotion = 'continuous';
  sb.spotlightOutline = true;
  const [first, second] = sb.steps;
  for (const step of sb.steps) {
    step.actions = [];
    step.spotlights = [{ from: 0, rect: [45, 80, 55, 40] }];
  }
  first.caption = { bold: 'Select', rest: 'the result.', box: [400, 600, 300], track: [{ at: 2.5, x: 850, y: 600, move: 2 }] };
  second.caption = { bold: 'Read', rest: 'the result.', box: [850, 600, 300] };
  withFixture(sb, (dir) => {
    const result = run([join(dir, 'video.json'), '--no-video', '--stills', '1.5,2.99,3.01', '--stills-dir', dir]);
    assert.equal(result.status, 0, result.stderr);
    const midpoint = join(dir, 'video-1.50s.png');
    const [r, g, b] = samplePixel(midpoint, 602, 350);
    assert.ok(r > 95 && r < 140 && g > 200 && b > 235, `expected cyan outline, got ${[r, g, b]}`);
    assert.ok(samplePixel(midpoint, 650, 605)[2] < 95, 'caption visible halfway through its glide');
    for (const time of ['2.99', '3.01']) {
      assert.ok(samplePixel(join(dir, `video-${time}s.png`), 875, 605)[2] < 95, 'caption backing stays in place at the boundary');
    }
  });
});

test('the rendered fast-slow caption covers most of its distance by mid-flight', { skip }, () => {
  const sb = storyboard();
  sb.framing = 'full-app';
  sb.captionMotion = 'continuous';
  sb.captionEase = 'fast-slow';
  const [first, second] = sb.steps;
  for (const step of sb.steps) step.actions = [];
  first.caption = { bold: 'Select', box: [400, 600, 200], track: [{ at: 2, x: 1100, y: 600, move: 1 }] };
  second.caption = { bold: 'Read', box: [1100, 600, 200] };
  withFixture(sb, (dir) => {
    const result = run([join(dir, 'video.json'), '--no-video', '--stills', '1.5', '--stills-dir', dir]);
    assert.equal(result.status, 0, result.stderr);
    const frame = join(dir, 'video-1.50s.png');
    assert.ok(samplePixel(frame, 775, 605)[2] > 240, 'caption cleared the balanced midpoint');
    assert.ok(samplePixel(frame, 985, 605)[2] < 120, 'caption reached the far half');
  });
});

test('sections start and end on black and shade the app only while their card shows', { skip }, () => {
  const sb = storyboard();
  sb.framing = 'full-app';
  sb.format = 'episode';
  const card = (kind) => ({ scene: 's', duration: 3, transition: 'cut', section: { kind, title: `${kind} title` } });
  sb.steps = [card('opening'), { ...sb.steps[0], transition: 'cut' }, card('chapter'), card('closing')];
  withFixture(sb, (dir) => {
    const result = run([join(dir, 'video.json'), '--no-video', '--stills', '0,1.5,4.5,7.5,12', '--stills-dir', dir]);
    assert.equal(result.status, 0, result.stderr);
    const at = (time, x, y) => samplePixel(join(dir, `video-${time}s.png`), x, y);
    for (const [x, y] of [[300, 100], [960, 540], [1600, 1000]]) {
      assert.deepEqual(at('0.00', x, y), [0, 0, 0], `opening frame is black at ${x},${y}`);
      assert.deepEqual(at('12.00', x, y), [0, 0, 0], `closing frame is black at ${x},${y}`);
    }
    // The default 0.62 shade leaves 38% of the blue app showing.
    for (const time of ['1.50', '7.50']) {
      const [r, g, b] = at(time, 300, 100);
      assert.ok(r < 10 && g < 10 && b > 85 && b < 110, `shaded app at ${time}s: ${[r, g, b]}`);
    }
    const plain = at('4.50', 300, 100);
    assert.ok(plain[0] > 240 && plain[2] < 15, `an ordinary shot is unshaded: ${plain}`);
  });
});
