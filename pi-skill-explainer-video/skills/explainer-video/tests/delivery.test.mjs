// Chapter timeline, FFmetadata, description and path-alias rules used by assemble.mjs.
// Pure Node checks plus real symlinks and hard links; no browser or ffmpeg needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, linkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveChapters, ffmetadata, description, clock, aliasErrors, deliveredTiming } from '../scripts/lib/delivery.mjs';

const step = (extra = {}) => ({ scene: 's', duration: 10, caption: { bold: 'Look.' }, ...extra });
const section = (kind, title) => ({ scene: 's', duration: 10, section: { kind, title } });

test('section steps become chapters at their start times', () => {
  const sb = { version: 1, title: 'Tour', steps: [section('opening', 'Welcome'), step(), section('chapter', 'Install'), step(), section('closing', 'Thanks')] };
  const { chapters, errors } = resolveChapters(sb, 50);
  assert.deepEqual(errors, []);
  assert.deepEqual(chapters, [
    { start: 0, end: 20, title: 'Welcome' },
    { start: 20, end: 40, title: 'Install' },
    { start: 40, end: 50, title: 'Thanks' }
  ]);
});

test('a chapter at zero is added when the first section starts later', () => {
  const sb = { version: 1, title: 'Tour', steps: [step(), section('chapter', 'Install'), step()] };
  const { chapters } = resolveChapters(sb, 30);
  assert.deepEqual(chapters.map((c) => [c.start, c.title]), [[0, 'Tour'], [10, 'Install']]);
  const untitled = resolveChapters({ version: 1, steps: [step(), step()] }, 20);
  assert.deepEqual(untitled.chapters, [{ start: 0, end: 20, title: 'Start' }]);
});

test('explicit chapters replace section chapters', () => {
  const sb = { version: 1, chapters: [{ start: 0, title: 'Intro' }, { start: 12.5, title: 'Search' }], steps: [section('opening', 'Ignored'), step()] };
  const { chapters, errors, source } = resolveChapters(sb, 20);
  assert.deepEqual(errors, []);
  assert.equal(source, 'storyboard chapters');
  assert.deepEqual(chapters, [{ start: 0, end: 12.5, title: 'Intro' }, { start: 12.5, end: 20, title: 'Search' }]);
});

test('invalid explicit chapters are rejected with the offending entry named', () => {
  const cases = [
    [[{ start: 1, title: 'Late' }], /chapters\[0\]\.start must be 0/],
    [[{ start: 0, title: 'A' }, { start: 0, title: 'B' }], /chapters\[1\]\.start \(0s\) must be later/],
    [[{ start: 0, title: 'A' }, { start: 9, title: 'B' }, { start: 5, title: 'C' }], /chapters\[2\]\.start \(5s\) must be later/],
    [[{ start: 0, title: 'A' }, { start: 20, title: 'B' }], /before the end of the video \(20s\)/],
    [[{ start: 0, title: 'A' }, { start: Infinity, title: 'B' }], /chapters\[1\]\.start must be a finite number/],
    [[{ start: 0, title: 'A' }, { start: 0.4, title: 'B' }], /same second/],
    [[{ start: 0, title: 'A\nB' }], /one line without control characters/],
    [[{ start: 0, title: ' ' }], /title must be non-empty text/],
    [[], /non-empty array/]
  ];
  for (const [chapters, pattern] of cases) {
    const result = resolveChapters({ version: 1, chapters, steps: [step(), step()] }, 20);
    assert.match(result.errors.join('\n'), pattern, JSON.stringify(chapters));
    assert.deepEqual(result.chapters, []);
  }
});

test('the delivered length is a whole number of frames', () => {
  // 3.33 s at 30 fps renders round(99.9) = 100 frames.
  assert.deepEqual(deliveredTiming({ fps: 30 }, 3.33), { fps: 30, frames: 100, duration: 100 / 30, width: 1920, height: 1080 });
});

test('chapters use one millisecond timeline for validation, metadata and description', () => {
  for (const starts of [[0, 1.9999995, 2], [0, 11.9996], [0, 5.9996, 6.0004]]) {
    const result = resolveChapters({ chapters: starts.map((start, i) => ({ start, title: `Part ${i}` })) }, 12);
    assert.ok(result.errors.length, `rounded chapters ${starts} must be rejected`);
  }
  const result = resolveChapters({ chapters: [{ start: 0, title: 'Start' }, { start: 5.9996, title: 'Next' }] }, 12);
  assert.deepEqual(result.errors, []);
  assert.equal(result.chapters[1].start, 6);
  assert.match(description({}, result.chapters), /00:06 Next/);
  assert.match(ffmetadata(result.chapters, {}), /START=6000\nEND=12000/);
});

test('FFmetadata and description share chapter times and escape reserved characters', () => {
  const chapters = [{ start: 0, end: 65.5, title: 'Set up = done; #1 \\ ok' }, { start: 65.5, end: 3725, title: 'Long run' }];
  const meta = ffmetadata(chapters, { title: 'Tour', comment: 'explainer-video:abc' });
  assert.equal(meta, [
    ';FFMETADATA1', 'title=Tour', 'comment=explainer-video:abc', '',
    '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=65500', 'title=Set up \\= done\\; \\#1 \\\\ ok', '',
    '[CHAPTER]', 'TIMEBASE=1/1000', 'START=65500', 'END=3725000', 'title=Long run', ''
  ].join('\n'));
  assert.equal(description({ title: 'Tour' }, chapters), 'Tour\n\nChapters\n00:00 Set up = done; #1 \\ ok\n01:05 Long run\n');
  assert.ok(description({ title: 'Tour', description: 'Learn to review a draft.' }, chapters).startsWith('Tour\n\nLearn to review a draft.\n\nChapters\n'));
  assert.deepEqual([clock(0), clock(59.999), clock(3600), clock(3725.9)], ['00:00', '00:59', '1:00:00', '1:02:05']);
});

test('outputs that name an input or each other through symlinks or hard links are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ev-alias-'));
  try {
    writeFileSync(join(dir, 'master.mp4'), 'x');
    symlinkSync(join(dir, 'master.mp4'), join(dir, 'link.mp4'));
    linkSync(join(dir, 'master.mp4'), join(dir, 'hard.mp4'));
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'alias'));
    const visual = { role: '--visual', path: join(dir, 'master.mp4'), output: false };
    const check = (outPath, extra = []) => aliasErrors([visual, { role: '--out', path: outPath, output: true }, ...extra]);
    assert.match(check(join(dir, 'link.mp4')).join(), /--visual .* and --out .* are the same file/);
    assert.match(check(join(dir, 'hard.mp4')).join(), /same file/);
    assert.match(check(join(dir, 'sub', '..', 'master.mp4')).join(), /same file/);
    const pair = check(join(dir, 'new.mp4'), [
      { role: 'description', path: join(dir, 'alias', 'notes.txt'), output: true },
      { role: '--sheet', path: join(dir, 'real', 'notes.txt'), output: true }
    ]);
    assert.match(pair.join(), /description .* and --sheet .* are the same file/);
    assert.deepEqual(check(join(dir, 'new.mp4')), []);
    symlinkSync(join(dir, 'future.png'), join(dir, 'preview.html'));
    assert.match(aliasErrors([
      { role: 'preview', path: join(dir, 'preview.html'), output: true },
      { role: 'sheet', path: join(dir, 'future.png'), output: true }
    ]).join(), /same file/, 'dangling output links must resolve before either file is written');
    // Two inputs may be the same file; only outputs are protected.
    assert.deepEqual(aliasErrors([visual, { role: '--audio', path: join(dir, 'link.mp4'), output: false }]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
