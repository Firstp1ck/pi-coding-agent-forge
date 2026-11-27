// assemble.mjs end to end: a real master from render.mjs, real ffmpeg muxing and ffprobe
// checks of the finished file. Skipped without a Chromium-family browser, ffmpeg and ffprobe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, copyFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '../scripts');
const has = (name) => spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name]).status === 0;
const browser = process.env.CHROME_PATH || ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'].find(has);
const skip = !browser || !has('ffmpeg') || !has('ffprobe') ? 'needs a Chromium-family browser, ffmpeg and ffprobe' : false;

const SCENES = `<style>.app { position: absolute; inset: 0; background: #0000ff; } .app.done { background: #ff0000; }</style>
<template id="s" data-width="400" data-height="300"><div class="app"></div></template>`;

// Four 3 s steps at 12 fps: 144 frames, chapters at 0 s (Welcome) and 6 s (Results).
const STORYBOARD = {
  version: 1, format: 'episode', title: 'Fixture tour', fps: 12, framing: 'full-app', scenes: 'scenes.html',
  steps: [
    { scene: 's', duration: 3, transition: 'cut', section: { kind: 'opening', title: 'Welcome' } },
    { scene: 's', duration: 3, transition: 'cut', caption: { bold: 'Open', rest: 'the app.', box: [1000, 900, 500] } },
    { scene: 's', duration: 3, transition: 'cut', section: { kind: 'chapter', title: 'Results' } },
    { scene: 's', duration: 3, transition: 'cut', setup: [{ type: 'class', target: '.app', add: 'done' }], caption: { bold: 'Read', rest: 'the result.', box: [1000, 900, 500] } }
  ]
};

let base;

function node(script, args) {
  return spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: 'utf8', timeout: 180_000 });
}

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
}

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_chapters', '-count_packets', file], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** A fresh directory holding the shared master, scenes, storyboard and soundtracks. */
function workspace(storyboard = STORYBOARD) {
  const dir = mkdtempSync(join(tmpdir(), 'ev-assemble-'));
  for (const f of ['master.mp4', 'scenes.html', 'long.wav', 'short.wav']) copyFileSync(join(base, f), join(dir, f));
  writeFileSync(join(dir, 'video.json'), JSON.stringify(storyboard));
  return dir;
}

const stagedLeftovers = (dir) => readdirSync(dir).filter((n) => n.includes('.assemble-'));

before(() => {
  if (skip) return;
  base = mkdtempSync(join(tmpdir(), 'ev-assemble-base-'));
  writeFileSync(join(base, 'scenes.html'), SCENES);
  writeFileSync(join(base, 'video.json'), JSON.stringify(STORYBOARD));
  const r = node('render.mjs', [join(base, 'video.json'), '--out', join(base, 'master.mp4'), '--chromium', browser]);
  assert.equal(r.status, 0, r.stderr);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=13', '-ar', '44100', join(base, 'long.wav')]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=11.5', '-ar', '44100', join(base, 'short.wav')]);
});

after(() => { if (base) rmSync(base, { recursive: true, force: true }); });

test('a master, soundtrack and sections become one verified delivery with matching chapters and description', { skip }, () => {
  const dir = workspace();
  try {
    const out = join(dir, 'out', 'tour.mp4');
    const r = node('assemble.mjs', [join(dir, 'video.json'), '--visual', join(dir, 'master.mp4'), '--out', out, '--audio', join(dir, 'long.wav'),
      '--sheet', join(dir, 'out', 'sheet.png'), '--chromium', browser]);
    assert.equal(r.status, 0, r.stderr);
    const p = probe(out);
    const video = p.streams.find((s) => s.codec_type === 'video');
    const audio = p.streams.find((s) => s.codec_type === 'audio');
    assert.equal(video.codec_name, 'h264');
    assert.equal(Number(video.nb_read_packets), 144);
    assert.equal(video.avg_frame_rate, '12/1');
    assert.equal(audio.codec_name, 'aac');
    assert.ok(Math.abs(Number(audio.duration) - 12) <= 0.03, `audio trimmed to the 12 s video: ${audio.duration}`);
    assert.deepEqual(p.chapters.map((c) => [Number(c.start_time), Number(c.end_time), c.tags.title]), [[0, 6, 'Welcome'], [6, 12, 'Results']]);
    assert.equal(readFileSync(join(dir, 'out', 'tour.description.txt'), 'utf8'), 'Fixture tour\n\nChapters\n00:00 Welcome\n00:06 Results\n');
    // One row of four 480 px tiles with 34 px labels and 6 px gaps.
    const png = readFileSync(join(dir, 'out', 'sheet.png'));
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1950, 304 + 12]);
    assert.deepEqual(stagedLeftovers(join(dir, 'out')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit chapters are used and no audio stream is added without a soundtrack', { skip }, () => {
  const dir = workspace({ ...STORYBOARD, chapters: [{ start: 0, title: 'Intro' }, { start: 4.9996, title: 'Use it' }] });
  try {
    // The fingerprint covers the storyboard, so changing chapters needs a matching master.
    const out = join(dir, 'tour.mp4');
    const rendered = node('render.mjs', [join(dir, 'video.json'), '--out', join(dir, 'master.mp4'), '--chromium', browser]);
    assert.equal(rendered.status, 0, rendered.stderr);
    const r = node('assemble.mjs', [join(dir, 'video.json'), '--visual', join(dir, 'master.mp4'), '--out', out, '--description', join(dir, 'yt.txt')]);
    assert.equal(r.status, 0, r.stderr);
    const p = probe(out);
    assert.equal(p.streams.filter((s) => s.codec_type === 'audio').length, 0);
    assert.deepEqual(p.chapters.map((c) => [Number(c.start_time), c.tags.title]), [[0, 'Intro'], [5, 'Use it']]);
    assert.equal(readFileSync(join(dir, 'yt.txt'), 'utf8'), 'Fixture tour\n\nChapters\n00:00 Intro\n00:05 Use it\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('multiline video titles round-trip without injecting chapter metadata', { skip }, () => {
  const title = 'Demo\n[CHAPTER]';
  const dir = workspace({ ...STORYBOARD, title });
  try {
    const master = join(dir, 'master.mp4'), out = join(dir, 'tour.mp4');
    const rendered = node('render.mjs', [join(dir, 'video.json'), '--out', master, '--chromium', browser]);
    assert.equal(rendered.status, 0, rendered.stderr);
    const result = node('assemble.mjs', [join(dir, 'video.json'), '--visual', master, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const media = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_format', '-show_chapters', '-of', 'json', out], { encoding: 'utf8' }).stdout);
    assert.equal(media.format.tags.title, title);
    assert.match(media.format.tags.comment, /^explainer-video:/);
    assert.equal(media.chapters.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audio covering the storyboard is padded through its rounded final video frame', { skip }, () => {
  const sb = { ...STORYBOARD, steps: [STORYBOARD.steps[0], { ...STORYBOARD.steps[1], duration: 3.05 }] };
  const dir = workspace(sb);
  try {
    const master = join(dir, 'master.mp4'), out = join(dir, 'tour.mp4'), sound = join(dir, 'exact.wav');
    const rendered = node('render.mjs', [join(dir, 'video.json'), '--out', master, '--chromium', browser]);
    assert.equal(rendered.status, 0, rendered.stderr);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=6.05', sound]);
    const result = node('assemble.mjs', [join(dir, 'video.json'), '--visual', master, '--out', out, '--audio', sound]);
    assert.equal(result.status, 0, result.stderr);
    const media = probe(out), audio = media.streams.find(s => s.codec_type === 'audio');
    assert.equal(Number(media.streams.find(s => s.codec_type === 'video').nb_read_packets), 73);
    assert.ok(Math.abs(Number(audio.duration) - 73 / 12) <= 0.03, audio.duration);
    assert.ok(Math.abs(Number(audio.start_time)) < 0.001, audio.start_time);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejected inputs leave the previous delivery untouched', { skip }, () => {
  const dir = workspace();
  try {
    const out = join(dir, 'tour.mp4');
    const desc = join(dir, 'tour.description.txt');
    writeFileSync(out, 'previous delivery');
    writeFileSync(desc, 'previous description');
    const assemble = (storyboard, extra) => {
      writeFileSync(join(dir, 'video.json'), JSON.stringify(storyboard));
      return node('assemble.mjs', [join(dir, 'video.json'), '--visual', join(dir, 'master.mp4'), '--out', out, ...extra]);
    };
    symlinkSync(join(dir, 'master.mp4'), join(dir, 'alias.mp4'));
    const cases = [
      ['short soundtrack', STORYBOARD, ['--audio', join(dir, 'short.wav')], /lasts 11\.500s and ends 0\.500s before the 12\.000s video/],
      ['edited storyboard', { ...STORYBOARD, title: 'Renamed tour' }, [], /rendered from a different storyboard/],
      ['wrong length', { ...STORYBOARD, steps: [...STORYBOARD.steps, { ...STORYBOARD.steps[1] }] }, [], /has 144 frames \(12\.000s\); the storyboard needs 180/],
      ['bad chapters', { ...STORYBOARD, chapters: [{ start: 0, title: 'A' }, { start: 12, title: 'B' }] }, [], /chapters\[1\]\.start \(12s\) must be before the end/],
      ['output aliases the master', STORYBOARD, ['--description', join(dir, 'alias.mp4')], /--visual .* and description .* are the same file/]
    ];
    for (const [name, storyboard, extra, pattern] of cases) {
      const r = assemble(storyboard, extra);
      assert.equal(r.status, 1, `${name}: ${r.stderr}`);
      assert.match(r.stderr, pattern, name);
      assert.equal(readFileSync(out, 'utf8'), 'previous delivery', name);
      assert.equal(readFileSync(desc, 'utf8'), 'previous description', name);
      assert.deepEqual(stagedLeftovers(dir), [], name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a master without the render fingerprint is rejected even when its frames match', { skip }, () => {
  const dir = workspace();
  try {
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=12', '-frames:v', '144', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'other.mp4')]);
    const r = node('assemble.mjs', [join(dir, 'video.json'), '--visual', join(dir, 'other.mp4'), '--out', join(dir, 'tour.mp4')]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /has no render fingerprint/);
    assert.doesNotMatch(r.stderr, /frames/);
    assert.ok(!existsSync(join(dir, 'tour.mp4')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render keeps the previous video when encoding fails', { skip }, () => {
  // libx264 with yuv420p rejects an odd frame width after the first frame arrives.
  const dir = workspace({ ...STORYBOARD, width: 1921 });
  try {
    const out = join(dir, 'master.mp4');
    const previous = readFileSync(out);
    const r = node('render.mjs', [join(dir, 'video.json'), '--out', out, '--chromium', browser]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /ffmpeg exited/);
    assert.ok(readFileSync(out).equals(previous), 'previous master unchanged');
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.partial-')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assemble usage errors exit 2 before reading anything', () => {
  const r = node('assemble.mjs', ['video.json', '--visual', 'm.mp4', '--out', 'out.mov']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--out must end in \.mp4/);
  const help = node('assemble.mjs', ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: assemble\.mjs <storyboard\.json> --visual <master\.mp4> --out <delivery\.mp4>/);
});
