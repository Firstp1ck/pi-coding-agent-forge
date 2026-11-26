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

/** RGB of the frame centre, read with ffmpeg so the test needs no PNG decoder. */
function centrePixel(png) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'crop=1:1:960:470', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 20_000 });
  assert.equal(r.status, 0, String(r.stderr));
  return [...r.stdout];
}

test('a timed action on an element nested in a set-up element takes effect', { skip }, () => {
  withFixture(storyboard(), (dir) => {
    const r = run([join(dir, 'video.json'), '--no-video', '--stills', '0.5,2', '--stills-dir', dir]);
    assert.equal(r.status, 0, r.stderr);
    const [before] = [centrePixel(join(dir, 'video-0.50s.png'))];
    const after = centrePixel(join(dir, 'video-2.00s.png'));
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
