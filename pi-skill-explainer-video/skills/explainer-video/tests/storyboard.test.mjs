import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStoryboard, validateStoryboard, parseScenes, buildPage, engine } from '../scripts/lib/storyboard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const example = join(here, '../examples/pacsea/pacsea.json');

function minimal(overrides = {}) {
  const step = (bold) => ({ caption: { bold, rest: 'does one thing.' }, duration: 5, scene: 'main', highlights: [{ from: 1, rect: [0, 0, 100, 100] }] });
  return { version: 1, steps: [step('First'), step('Second'), step('Third')], outro: { title: ['Hello'] }, ...overrides };
}
const scenes = new Map([['main', { width: 1920, height: 1080 }]]);

test('the shipped Pacsea example validates without errors or warnings', () => {
  const loaded = loadStoryboard(example);
  const result = validateStoryboard(loaded.sb, { scenes: loaded.scenes, dir: loaded.dir });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.total, 39);
});

test('timeline places steps back to back and appends the outro', () => {
  const tl = engine.buildTimeline({ steps: [{ duration: 5 }, { duration: 7.5 }], outro: { duration: 3 } });
  assert.deepEqual(tl.steps.map((s) => [s.start, s.end]), [[0, 5], [5, 12.5]]);
  assert.deepEqual(tl.outro, { start: 12.5, end: 15.5 });
  assert.equal(tl.total, 15.5);
});

test('neighbouring steps crossfade: both half visible at the boundary', () => {
  const out = engine.segmentOpacity(5, 0, 5, false, true);
  const inn = engine.segmentOpacity(5, 5, 10, true, true);
  assert.equal(out, 0.5);
  assert.equal(inn, 0.5);
  assert.equal(engine.segmentOpacity(0, 0, 5, false, true), 1, 'first step starts fully visible');
});

test('camera track reaches each key at its time and eases between', () => {
  const keys = [{ at: 0, v: [0] }, { at: 2, v: [100] }, { at: 4, move: 1, v: [200] }];
  const at = (t) => engine.sampleTrack(keys, t, (k) => k.v)[0];
  assert.equal(at(0), 0);
  assert.equal(at(1), 50, 'midpoint of a symmetric ease is the midpoint value');
  assert.equal(at(2), 100);
  assert.equal(at(2.9), 100, 'a short move waits until it is due');
  assert.equal(at(4), 200);
  assert.equal(at(9), 200);
});

test('fitCamera centres the rect in the view box and caps zoom', () => {
  const view = { x: 0, y: 0, w: 1000, h: 500 };
  const cam = engine.fitCamera([100, 100, 200, 100], view, 10);
  assert.equal(cam.s, 5);
  assert.equal(200 * cam.s + cam.tx, 500, 'rect centre x maps to view centre');
  assert.equal(150 * cam.s + cam.ty, 250, 'rect centre y maps to view centre');
  assert.equal(engine.fitCamera([0, 0, 10, 10], view, 3).s, 3);
});

test('clampCamera never lets the scene edge drift past the margin', () => {
  const area = { w: 1920, h: 900, margin: 60 };
  const left = engine.clampCamera({ s: 2, tx: 400, ty: -100 }, [1920, 1080], area);
  assert.equal(left.tx, 60);
  const right = engine.clampCamera({ s: 2, tx: -5000, ty: -100 }, [1920, 1080], area);
  assert.equal(right.tx, 1920 - 3840 - 60);
  const small = engine.clampCamera({ s: 0.5, tx: 0, ty: 0 }, [1920, 1080], area);
  assert.equal(small.tx, (1920 - 960) / 2, 'a scene narrower than the frame is centred');
});

test('structural problems are errors', () => {
  const sb = minimal();
  sb.steps[0].duration = 1;
  sb.steps[1].scene = 'missing';
  sb.steps[2].highlights[0].from = 9;
  sb.steps[2].actions = [{ at: 1, type: 'wiggle', target: '#x' }];
  const { errors } = validateStoryboard(sb, { scenes });
  assert.ok(errors.some((e) => e.includes('step 1') && e.includes('duration')));
  assert.ok(errors.some((e) => e.includes('scene "missing"')));
  assert.ok(errors.some((e) => e.includes('outside the step')));
  assert.ok(errors.some((e) => e.includes('type must be one of')));
});

test('one or seven steps are rejected; two is allowed with a warning', () => {
  const one = minimal();
  one.steps = one.steps.slice(0, 1);
  assert.ok(validateStoryboard(one, { scenes }).errors.some((e) => e.includes('steps')));
  const two = minimal();
  two.steps = two.steps.slice(0, 2);
  const r = validateStoryboard(two, { scenes });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('3–5 steps')));
});

test('captions get plain-language warnings, and allowTerms silences them', () => {
  const sb = minimal();
  sb.steps[0].caption = { bold: 'Sync the repo', rest: 'to simply leverage the CLI.' };
  const { warnings } = validateStoryboard(sb, { scenes });
  for (const word of ['repo', 'CLI', 'Sync']) assert.ok(warnings.some((w) => w.includes(`"${word}"`) && w.includes('jargon')), word);
  for (const word of ['simply', 'leverage']) assert.ok(warnings.some((w) => w.includes(`"${word}"`) && w.includes('filler')), word);
  sb.allowTerms = ['repo', 'CLI', 'sync'];
  const after = validateStoryboard(sb, { scenes }).warnings;
  assert.ok(!after.some((w) => w.includes('jargon')));
});

test('overlong captions error, long ones warn', () => {
  const sb = minimal();
  sb.steps[0].caption = { bold: 'Open', rest: 'the window and then look at all of the many things inside it now.' };
  assert.ok(validateStoryboard(sb, { scenes }).errors.some((e) => e.includes('words')));
  sb.steps[0].caption = { bold: 'Open', rest: 'the window and then look at the many things inside.' };
  const r = validateStoryboard(sb, { scenes });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('aim for')));
});

test('parseScenes reads template ids and sizes', () => {
  const s = parseScenes('<template id="a" data-width="800" data-height="600"></template><template id="b"></template>');
  assert.deepEqual(s.get('a'), { width: 800, height: 600 });
  assert.deepEqual(s.get('b'), { width: 1920, height: 1080 });
});

test('buildPage inlines data safely and leaves user tokens alone', () => {
  const loaded = { sb: minimal({ title: 'A </script> title' }), dir: '/tmp/x', scenesHtml: '<template id="main"><p>__DATA__</p></template>' };
  const html = buildPage(loaded, { play: false });
  assert.ok(!html.includes('A </script> title'), 'storyboard text cannot close the script tag');
  assert.ok(html.includes('<p>__DATA__</p>'), 'tokens inside scene content are not expanded');
  assert.ok(html.includes('<base href="file:///tmp/x/">'));
  assert.ok(!html.includes('ev-progress"></div>'), 'render pages have no progress bar');
  assert.ok(buildPage(loaded, { play: true }).includes('<div id="ev-progress"></div>'));
});

test('wrong shapes are named errors, not crashes', () => {
  assert.deepEqual(validateStoryboard(null).errors, ['the storyboard must be a JSON object']);
  const sb = minimal();
  sb.steps[0].camera = { at: 0 };
  sb.steps[1] = null;
  sb.outro = 'end';
  const { errors } = validateStoryboard(sb, { scenes });
  assert.ok(errors.includes('step 1 camera must be an array'));
  assert.ok(errors.includes('step 2 must be an object'));
  assert.ok(errors.includes('outro must be an object'));
});

test('length is still computed when there are errors, for render --force', () => {
  const sb = minimal();
  sb.steps[0].caption.rest = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen.';
  const r = validateStoryboard(sb, { scenes });
  assert.ok(r.errors.length > 0);
  assert.equal(r.total, 19);
});

test('template ids in single quotes or unquoted are found', () => {
  const s = parseScenes(`<template id='a' data-width='640'></template><template id=b></template>`);
  assert.equal(s.get('a').width, 640);
  assert.ok(s.has('b'));
});

test('allowTerms and image of the wrong type are named errors', () => {
  const sb = minimal({ allowTerms: 'pacsea' });
  sb.steps[0] = { ...sb.steps[0], scene: undefined, image: 5 };
  const { errors } = validateStoryboard(sb, { scenes });
  assert.ok(errors.includes('allowTerms must be an array of words'));
  assert.ok(errors.includes('step 1: image must be a file path'));
});
