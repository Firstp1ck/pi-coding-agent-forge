// Section cards, the two-line caption preset, focusFade and avoid regions: timing helpers and validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStoryboard, engine } from '../scripts/lib/storyboard.mjs';

const scenes = new Map([['main', { width: 1920, height: 1080 }]]);

function shot(bold, extra = {}) {
  return { caption: { bold, rest: 'does one thing.' }, duration: 5, scene: 'main', highlights: [{ from: 1, rect: [0, 0, 100, 100] }], ...extra };
}
function card(kind, extra = {}) {
  return { scene: 'main', duration: 5, section: { kind, title: 'Review a draft', ...extra } };
}
function episode(steps, overrides = {}) {
  return { version: 1, format: 'episode', framing: 'full-app', steps, ...overrides };
}
const errorsOf = (sb) => validateStoryboard(sb, { scenes }).errors;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);

test('target rectangles reject padding that cannot produce finite geometry', () => {
  for (const pad of ['8px', Infinity, NaN, {}]) {
    for (const field of ['avoid', 'spotlights']) {
      const rect = { target: '#dialog', pad };
      const sb = episode([shot('Read', { [field]: field === 'avoid' ? [rect] : [{ from: 0, rect }] }), shot('Done')]);
      assert.match(errorsOf(sb).join('\n'), /pad must be a finite number/, `${field}: ${String(pad)}`);
    }
  }
});

test('a chapter card fades in and out over the still app with the default half-second ramps', () => {
  const layers = (tl) => engine.sectionLayers({ kind: 'chapter' }, tl, 5);
  for (const [tl, cardAlpha] of [[0, 0], [0.25, 0.5], [0.5, 1], [2.5, 1], [4.75, 0.5], [5, 0]]) {
    near(layers(tl).card, cardAlpha, `card at ${tl}s`);
    assert.equal(layers(tl).black, 0, `a chapter never blacks the frame (${tl}s)`);
  }
});

test('an opening rises from black and a closing ends on a black frame', () => {
  const opening = (tl) => engine.sectionLayers({ kind: 'opening', fadeIn: 1 }, tl, 5);
  assert.deepEqual(opening(0), { card: 1, black: 1 });
  near(opening(0.5).black, 0.5, 'opening half way up');
  assert.deepEqual(opening(2), { card: 1, black: 0 });
  near(opening(4.75).card, 0.5, 'opening card hands over to the app');

  const closing = (tl) => engine.sectionLayers({ kind: 'closing', fadeOut: 1 }, tl, 6);
  near(closing(0.25).card, 0.5, 'closing card fades in');
  assert.deepEqual(closing(3), { card: 1, black: 0 });
  near(closing(5.5).black, 0.5, 'half way to black');
  assert.deepEqual(closing(6), { card: 1, black: 1 }, 'final frame is fully black');
  assert.deepEqual(engine.sectionLayers({ kind: 'closing', fadeOut: 0 }, 6, 6), { card: 1, black: 0 }, 'fadeOut 0 holds the title on the last frame');
});

test('continuous captions fade only where a section interrupts the sequence', () => {
  const sb = episode([shot('A'), card('chapter'), shot('B'), shot('C')], { captionMotion: 'continuous' });
  const tl = engine.buildTimeline(sb);
  const [, , b, c] = tl.steps;
  // B follows the section: its caption crossfades in around its start.
  near(engine.captionOpacity(b.start, b, sb), 0.5, 'B at the edit after the card');
  near(engine.captionOpacity(b.start + 0.25, b, sb), 1, 'B once the crossfade completes');
  // B to C is an ordinary edit: the plaque switches on the edit frame.
  assert.equal(engine.captionOpacity(c.start, b, sb), 0);
  assert.equal(engine.captionOpacity(c.start, c, sb), 1);
  assert.equal(engine.captionOpacity(c.end, c, sb), 1, 'the last caption holds on the final frame');
  // A runs into the section: it fades out across that edge.
  near(engine.captionOpacity(tl.steps[0].end, tl.steps[0], sb), 0.5, 'A at the card edge');
});

test('focusFade brings the caption in with the first spotlight', () => {
  const step = shot('Approve', { focusFade: 1, spotlights: [{ from: 2, rect: [0, 0, 10, 10] }, { from: 1, rect: [0, 0, 10, 10] }] });
  assert.equal(engine.focusStart(step), 1);
  assert.equal(engine.focusStart({}), 0);
  const sb = episode([card('opening'), step, shot('Next')]);
  const seg = engine.buildTimeline(sb).steps[1];
  assert.equal(engine.captionOpacity(seg.start + 0.5, seg, sb), 0, 'hidden before the spotlight starts');
  near(engine.captionOpacity(seg.start + 1.5, seg, sb), 0.5, 'half way through the shared ramp');
  assert.equal(engine.captionOpacity(seg.start + 2.5, seg, sb), 1);
});

test('a valid opening, chapter and closing episode passes', () => {
  const sb = episode([
    card('opening', { body: 'A short tour of the review queue.', credit: 'Illustrative sample', fadeIn: 1, fadeOut: 0.6, shade: 0.7 }),
    shot('First'),
    card('chapter'),
    shot('Second', { focusFade: 0.6, spotlights: [{ from: 0.4, rect: [0, 0, 100, 100] }], avoid: [[1400, 300, 400, 300], { target: '#dialog', pad: 8 }] }),
    card('closing', { fadeOut: 1.5 })
  ], { captionStyle: 'two-line' });
  assert.deepEqual(errorsOf(sb), []);
  assert.deepEqual(validateStoryboard(sb, { scenes }).warnings, []);
});

test('section shape, placement and ramps are named errors', () => {
  const sb = episode([card('chapter'), shot('First'), card('opening'), card('closing'), shot('Last')]);
  const errors = errorsOf(sb);
  assert.ok(errors.includes('step 3: an opening section must be the first step'));
  assert.ok(errors.includes('step 4: a closing section must be the last step'));

  const bad = episode([
    { scene: 'main', duration: 4, section: { kind: 'intro', title: '', body: 7, fadeIn: -1, fadeOut: 'slow', shade: 2 } },
    { scene: 'main', duration: 3, section: { kind: 'chapter', title: 'Ramps', fadeIn: 2, fadeOut: 1.5 } },
    { scene: 'main', duration: 3, section: 'Chapter two' },
    shot('Last')
  ]);
  const text = errorsOf(bad).join('\n');
  for (const defect of ['section.kind must be one of', 'section.title is required', 'section.body must be non-empty text',
    'section.fadeIn must be a nonnegative', 'section.fadeOut must be a nonnegative', 'section.shade must be a number from 0 to 1',
    'must fit inside the 3s hold', 'step 3: section must be an object']) {
    assert.ok(text.includes(defect), defect);
  }
  assert.ok(!text.includes('caption.bold is required'), 'sections need no caption');
});

test('a section card rejects caption and motion fields, and a closing cannot sit before an outro', () => {
  const step = card('chapter');
  Object.assign(step, { caption: { bold: 'Hi.' }, camera: [], spotlights: [], highlights: [], cursor: [], keys: [], actions: [], focusFade: 1, avoid: [] });
  const errors = errorsOf(episode([shot('First'), step, shot('Last')]));
  for (const field of ['caption', 'camera', 'spotlights', 'highlights', 'cursor', 'keys', 'actions', 'focusFade', 'avoid']) {
    assert.ok(errors.includes(`step 2: a section card holds the app still; remove ${field}`), field);
  }
  const withOutro = { version: 1, steps: [shot('First'), shot('Second'), card('closing')], outro: { title: ['Bye'] } };
  assert.ok(errorsOf(withOutro).some((e) => e.includes('replaces the outro')));
});

test('continuous caption continuity resets after a section but still binds ordinary edits', () => {
  const placed = (bold, box) => ({ ...shot(bold), caption: { bold, rest: 'does one thing.', box } });
  const sb = episode([placed('A', [100, 200, 700]), card('chapter'), placed('B', [900, 600, 700]), placed('C', [900, 600, 700])], { captionMotion: 'continuous' });
  assert.deepEqual(errorsOf(sb), [], 'B may start anywhere after the card');
  sb.steps[3].caption.box = [100, 200, 700];
  assert.ok(errorsOf(sb).some((e) => e.startsWith('step 4') && e.includes('previous endpoint')));
});

test('focusFade, avoid and captionStyle reject invalid values without crashing', () => {
  const sb = episode([
    shot('A', { focusFade: -0.5 }),
    shot('B', { focusFade: 2, spotlights: [{ from: 4, rect: [0, 0, 10, 10] }, null] }),
    shot('C', { avoid: [[0, 0, -5, 10], 'dialog', null, { pad: 2 }] }),
    shot('D', { avoid: { target: '#x' } })
  ], { captionStyle: 'three-line' });
  const text = errorsOf(sb).join('\n');
  for (const defect of ['captionStyle must be "two-line"', 'step 1: focusFade must be a nonnegative', 'focusFade of 2s starting at 4s runs past',
    'step 3 avoid[0]: rect width and height must be positive', 'step 3 avoid[1]: rect must be', 'step 3 avoid[2]: rect must be',
    'step 3 avoid[3]: rect must be', 'step 4 avoid must be an array']) {
    assert.ok(text.includes(defect), defect);
  }
});

test('focusFade cannot break a continuous caption mid-sequence', () => {
  const placed = (bold, extra) => ({ ...shot(bold), caption: { bold, rest: 'does one thing.', box: [100, 200, 700] }, ...extra });
  const sb = episode([placed('A', { focusFade: 0.5 }), placed('B', { focusFade: 0.5 }), card('chapter'), placed('C', { focusFade: 0.5 })], { captionMotion: 'continuous' });
  const errors = errorsOf(sb);
  assert.deepEqual(errors.filter((e) => e.includes('focusFade')), ['step 2: focusFade would hide a continuous caption mid-sequence; use it on the first step or after a section']);
});
