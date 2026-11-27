// render.mjs --check-layout and --sheet-mode through the real renderer in headless Chromium,
// plus the layout rules on hand-made inspect samples. Browser cases skip without Chromium/ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeLayout } from '../scripts/lib/layout.mjs';

const render = join(dirname(fileURLToPath(import.meta.url)), '../scripts/render.mjs');
const has = (name) => spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name]).status === 0;
const browser = process.env.CHROME_PATH || ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'].find(has);
const skip = !browser || !has('ffmpeg') ? 'needs a Chromium-family browser and ffmpeg' : false;

// A 400x300 scene fills the 1920x1080 frame at scale 3.6 between x=240 and x=1680.
const SCENES = `<style>.app { position: absolute; inset: 0; background: #0000ff; }</style>
<template id="s" data-width="400" data-height="300"><div class="app"></div></template>`;

const shot = (caption, extra = {}) => ({ scene: 's', duration: 3, transition: 'cut', caption, ...extra });

function withFixture(sb, fn, scenes = SCENES) {
  const dir = mkdtempSync(join(tmpdir(), 'ev-layout-'));
  try {
    writeFileSync(join(dir, 'scenes.html'), scenes);
    writeFileSync(join(dir, 'video.json'), JSON.stringify({ version: 1, fps: 12, framing: 'full-app', scenes: 'scenes.html', ...sb }));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir, args) {
  return spawnSync(process.execPath, [render, join(dir, 'video.json'), ...args, '--chromium', browser], { encoding: 'utf8', timeout: 120_000 });
}

/** Width and height from a PNG header, so the test needs no image decoder. */
function pngSize(file) {
  const buf = readFileSync(file);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const sample = (step, caption, spotlights = [], avoid = []) => ({ step, opacity: 1, section: null, caption, spotlights, avoid });

test('overlap findings are grouped into timestamped runs and ignore invisible regions', () => {
  const sb = { steps: [{ duration: 1, caption: { bold: 'A' } }] };
  const cap = { rect: [100, 100, 200, 50], textOverflow: false, opacity: 1 };
  const samples = Array.from({ length: 10 }, (_, k) => sample(0, cap,
    k >= 3 && k <= 5 ? [{ rect: [250, 120, 100, 100], opacity: 1 }] : [{ rect: [250, 120, 100, 100], opacity: 0 }],
    k === 8 ? [[0, 0, 150, 150]] : []));
  const { failures } = analyzeLayout(sb, samples, { fps: 10, width: 1920, height: 1080 });
  assert.deepEqual(failures.map((f) => [f.kind, f.firstFrame, f.frames, f.from, f.to]), [
    ['caption-covers-spotlight', 3, 3, 0.3, 0.5],
    ['caption-covers-avoid', 8, 1, 0.8, 0.8]
  ]);
  assert.match(failures[0].message, /^from 0\.300s to 0\.500s \(frames 3–5\): step 1: caption covers spotlights\[0\]/);
  // A one-pixel touch is within the rounding tolerance.
  const touching = analyzeLayout(sb, [sample(0, cap, [], [[299, 149, 50, 50]])], { fps: 10, width: 1920, height: 1080 });
  assert.deepEqual(touching.failures, []);
});

test('a clean storyboard passes the layout check without rendering video', { skip }, () => {
  const sb = { steps: [
    shot({ bold: 'Open', rest: 'the app.', box: [1000, 900, 500] }, { spotlights: [{ from: 0, rect: [0, 0, 50, 50] }], avoid: [[0, 200, 50, 50]] }),
    shot({ bold: 'Done.', box: [1000, 900, 500] })
  ] };
  withFixture(sb, (dir) => {
    const report = join(dir, 'report.json');
    const r = run(dir, ['--no-video', '--check-layout', '--report', report]);
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(json.ok, true);
    assert.equal(json.frames, 72);
    assert.deepEqual(json.failures, []);
    assert.ok(!existsSync(join(dir, 'video.mp4')), 'no video with --no-video');
  });
});

test('the zoomed Pacsea example has stable pixels after forward and shuffled seeks', { skip }, () => {
  const example = join(dirname(render), '../examples/pacsea/pacsea.json');
  const result = spawnSync(process.execPath, [render, example, '--no-video', '--check-layout', '--chromium', browser],
    { encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /compared 15 screenshots/);
});

test('fractional shot durations use the same encoded cut frame as the player', { skip }, () => {
  withFixture({ fps: 30, captionMotion: 'continuous', steps: Array.from({ length: 4 }, () =>
    shot({ bold: 'Read', rest: 'the result.', box: [1000, 800, 700] }, { duration: 3.2 })) }, (dir) => {
    const result = run(dir, ['--no-video', '--check-layout']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /3 edit\(s\) checked/);
  });
});

test('render outputs cannot overwrite their storyboard or scene sources', () => {
  withFixture({ steps: [shot({ bold: 'Read.' }), shot({ bold: 'Done.' })] }, (dir) => {
    for (const args of [['--no-video', '--check-layout', '--report', join(dir, 'video.json')], ['--preview', join(dir, 'scenes.html')]]) {
      const before = readFileSync(join(dir, 'video.json'), 'utf8');
      const scenes = readFileSync(join(dir, 'scenes.html'), 'utf8');
      const result = run(dir, args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /same file/);
      assert.equal(readFileSync(join(dir, 'video.json'), 'utf8'), before);
      assert.equal(readFileSync(join(dir, 'scenes.html'), 'utf8'), scenes);
    }
  });
});

test('dangling output symlinks are rejected before a preview or report is written', () => {
  withFixture({ steps: [shot({ bold: 'Read.' }), shot({ bold: 'Done.' })] }, (dir) => {
    const report = join(dir, 'report.json'), preview = join(dir, 'preview.html');
    symlinkSync(report, preview);
    const result = run(dir, ['--no-video', '--preview', preview, '--check-layout', '--report', report]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /same file/);
    assert.ok(!existsSync(report), 'neither output is written');
  });
});

test('invalid target padding cannot silently disable a declared caption exclusion', () => {
  withFixture({ steps: [
    shot({ bold: 'Read.', box: [1000, 800, 500] }, { avoid: [{ target: '.app', pad: '8px' }] }),
    shot({ bold: 'Done.', box: [1000, 800, 500] })
  ] }, (dir) => {
    const result = run(dir, ['--no-video', '--check-layout']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /avoid\[0\]: pad must be a finite number/);
  });
});

test('a caption over a spotlight, over an avoid region and past its two lines fails with timestamps', { skip }, () => {
  const sb = { captionStyle: 'two-line', steps: [
    // Scene [0,0,100,100] is output [240,0,360,360]; the placed caption starts inside it.
    shot({ bold: 'Open', rest: 'the menu.', box: [300, 100, 400] }, { spotlights: [{ from: 1, rect: [0, 0, 100, 100] }] }),
    // Scene [300,200,50,50] is output [1320,720,180,180].
    shot({ bold: 'Check', rest: 'the dialog.', box: [1200, 700, 400] }, { avoid: [[300, 200, 50, 50]] }),
    shot({ bold: 'Read', rest: 'x'.repeat(400) })
  ] };
  withFixture(sb, (dir) => {
    const report = join(dir, 'report.json');
    const r = run(dir, ['--check-layout', '--report', report, '--out', join(dir, 'video.mp4')]);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(!existsSync(join(dir, 'video.mp4')), 'a failed check writes no video');
    const json = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(json.ok, false);
    const kinds = json.failures.map((f) => [f.kind, f.step, f.firstFrame, f.frames]);
    // Spotlight active from 1 s (frame 12) to the cut at 3 s (frame 35); avoid all of step 2; overflow all of step 3.
    assert.deepEqual(kinds, [
      ['caption-covers-spotlight', 1, 12, 24],
      ['caption-covers-avoid', 2, 36, 36],
      ['caption-overflow', 3, 72, 36]
    ]);
    assert.match(r.stderr, /layout: from 1\.000s to 2\.917s \(frames 12–35\): step 1: caption covers spotlights\[0\]/);
    assert.match(r.stderr, /layout check failed: 3 problem\(s\) in 108 frames/);
  });
});

test('a continuous caption that jumps at a cut is reported at the edit', { skip }, () => {
  const sb = { captionMotion: 'continuous', steps: [
    shot({ bold: 'One.', box: [300, 800, 400] }),
    shot({ bold: 'Two.', box: [900, 800, 400] })
  ] };
  withFixture(sb, (dir) => {
    const report = join(dir, 'report.json');
    // Validation already rejects this jump; --force lets the rendered check confirm it independently.
    const r = run(dir, ['--no-video', '--force', '--check-layout', '--report', report]);
    assert.equal(r.status, 1, r.stderr);
    const json = JSON.parse(readFileSync(report, 'utf8'));
    assert.deepEqual(json.continuity.map((c) => [c.edit, c.time, c.rule, c.ok]), [[2, 3, 'continuous', false]]);
    const jump = json.failures.find((f) => f.kind === 'caption-jump');
    assert.match(jump.message, /edit into step 2 \(3\.000s, frames 35–36\): caption box moves from 300, 800/);
  });
});

test('rendering that depends on earlier seeks fails the seek-order check', { skip }, () => {
  // The scenes file wraps the player's seek so every call leaves a mark on the stage.
  const leaky = `${SCENES}<script>
    Object.defineProperty(window, 'ExplainerVideo', { configurable: true, get: function () { return this._ev; }, set: function (api) {
      var seek = api.Player.prototype.seek, calls = 0;
      api.Player.prototype.seek = function (t) { var r = seek.call(this, t); this.doc.getElementById('ev-stage').dataset.calls = String(++calls % 7); return r; };
      this._ev = api;
    } });
  </script>`;
  withFixture({ steps: [shot({ bold: 'One.', box: [300, 800, 400] }), shot({ bold: 'Two.', box: [300, 800, 400] })] }, (dir) => {
    const report = join(dir, 'report.json');
    const r = run(dir, ['--no-video', '--check-layout', '--report', report]);
    assert.equal(r.status, 1, r.stderr);
    const json = JSON.parse(readFileSync(report, 'utf8'));
    assert.ok(json.failures.length > 0 && json.failures.every((f) => f.kind === 'seek-order'), JSON.stringify(json.failures.slice(0, 3)));
    assert.match(r.stderr, /rendered state differs when frames are seeked in reverse order/);
  }, leaky);
});

test('shot sheets show every step and continue on a second page; overview keeps its 4x3 grid', { skip }, () => {
  const steps = Array.from({ length: 33 }, (_, i) => ({ scene: 's', duration: 3, transition: 'cut', caption: { bold: `Step ${i + 1}.` } }));
  withFixture({ format: 'episode', steps }, (dir) => {
    const sheet = join(dir, 'shots.png');
    const r = run(dir, ['--no-video', '--sheet', sheet, '--sheet-mode', 'shots']);
    assert.equal(r.status, 0, r.stderr);
    // 4 columns of 480 px tiles; each row is a 270 px frame plus a 34 px label, with 6 px gaps.
    assert.deepEqual(pngSize(sheet), [1950, 8 * 304 + 9 * 6]);
    assert.deepEqual(pngSize(join(dir, 'shots-p2.png')), [1950, 304 + 2 * 6]);
    assert.match(r.stderr, /33 shots, page 2 of 2/);
    const overview = join(dir, 'overview.png');
    const o = run(dir, ['--no-video', '--sheet', overview]);
    assert.equal(o.status, 0, o.stderr);
    // ffmpeg's tile filter puts 6 px padding between tiles only.
    assert.deepEqual(pngSize(overview), [4 * 480 + 3 * 6, 3 * 270 + 2 * 6]);
  });
});

test('layout and sheet options are validated before anything renders', () => {
  const r = spawnSync(process.execPath, [render, 'missing.json', '--report', 'r.json'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--report needs --check-layout/);
  const m = spawnSync(process.execPath, [render, 'missing.json', '--sheet', 's.png', '--sheet-mode', 'grid'], { encoding: 'utf8' });
  assert.equal(m.status, 2);
  assert.match(m.stderr, /--sheet-mode must be overview or shots/);
});
