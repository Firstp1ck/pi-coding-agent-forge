// Browser checks of window.__EV.inspect(t) and the layout it reports. Runs the real player
// page in headless Chromium through --dump-dom, so no CDP client is needed. Skipped without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPage } from '../scripts/lib/storyboard.mjs';

const has = (name) => spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name]).status === 0;
const browser = process.env.CHROME_PATH || ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'].find(has);
const skip = browser ? false : 'needs a Chromium-family browser';

// 400x300 scenes fill the 1920x1080 frame at scale 3.6 between x=240 and x=1680.
const SCENES = `<style>
.app { position: absolute; inset: 0; background: #0000ff; }
#dialog { position: absolute; left: 200px; top: 100px; width: 100px; height: 50px; background: #fff; }
</style>
<template id="s" data-width="400" data-height="300"><div class="app"><div id="dialog"></div><div id="label">idle</div></div></template>`;

/**
 * Load a storyboard in headless Chromium, wait for the player, run `probe` (a function
 * source taking the page's __EV and returning JSON-safe data) and return its result.
 */
function runInPage(sb, probe, scenesHtml = SCENES) {
  const dir = mkdtempSync(join(tmpdir(), 'ev-inspect-'));
  try {
    let html = buildPage({ sb, dir, scenesHtml });
    const runner = `<script>window.__EV.ready().then(function () { return (${probe})(window.__EV); })
      .then(function (r) { return JSON.stringify(r); }, function (e) { return JSON.stringify({ error: String(e && e.message || e) }); })
      .then(function (s) { var p = document.createElement('pre'); p.id = 'ev-out'; p.textContent = s; document.body.appendChild(p); });</script>`;
    html = html.replace('</body>', `${runner}</body>`);
    const page = join(dir, 'page.html');
    writeFileSync(page, html);
    const r = spawnSync(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(dir, 'profile')}`, '--window-size=1920,1080', '--virtual-time-budget=10000',
      '--dump-dom', pathToFileURL(page).href], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `browser failed: ${r.stderr}`);
    const match = /<pre id="ev-out">([\s\S]*?)<\/pre>/.exec(r.stdout);
    assert.ok(match, 'probe produced no output');
    const decoded = match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const result = JSON.parse(decoded);
    assert.ok(!result || !result.error, result && result.error);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const shot = (bold, rest, extra = {}) => ({ scene: 's', duration: 4, caption: { bold, rest }, ...extra });

test('inspect reports section, caption, spotlight and avoid geometry in output pixels', { skip }, () => {
  const sb = { version: 1, format: 'episode', framing: 'full-app', steps: [
    { scene: 's', duration: 4, section: { kind: 'opening', title: 'Review a draft', body: 'Illustrative sample.' } },
    shot('Open', 'the dialog.', {
      transition: 'cut',
      spotlights: [{ from: 0, rect: { target: '#dialog', pad: 0 } }],
      avoid: [{ target: '#dialog', pad: 10 }, [0, 0, 100, 50]],
      caption: { bold: 'Open', rest: 'the dialog.', box: [300, 800, 600] }
    })
  ] };
  const [atStart, onCard, onShot] = runInPage(sb, 'function (ev) { return [ev.inspect(0), ev.inspect(2), ev.inspect(6)]; }');
  assert.equal(atStart.section.kind, 'opening');
  assert.equal(atStart.section.black, 1, 'the opening starts on black');
  assert.equal(onCard.section.black, 0);
  assert.equal(onCard.section.opacity, 1);
  assert.equal(onCard.section.textOverflow, false);
  assert.equal(onCard.caption, null);
  assert.deepEqual(onCard.spotlights, []);
  const [x, y, w, h] = onCard.section.rect;
  assert.ok(Math.abs(x + w / 2 - 960) < 1 && Math.abs(y + h / 2 - 540) < 1, `title block centred: ${onCard.section.rect}`);

  assert.equal(onShot.time, 6);
  assert.equal(onShot.step, 1);
  assert.equal(onShot.section, null);
  // #dialog at scene (200,100) 100x50 maps to 240 + 200 * 3.6 = 960, 100 * 3.6 = 360.
  assert.deepEqual(onShot.spotlights, [{ rect: [960, 360, 360, 180], opacity: 1 }]);
  assert.deepEqual(onShot.avoid, [[924, 324, 432, 252], [240, 0, 360, 180]]);
  assert.equal(onShot.caption.opacity, 1);
  assert.equal(onShot.caption.textOverflow, false);
  assert.deepEqual(onShot.caption.rect.slice(0, 3), [300, 800, 600]);
});

test('inspect is independent of seek order', { skip }, () => {
  const sb = { version: 1, steps: [
    shot('First', 'shot here.', { actions: [{ at: 1, type: 'type', target: '#label', text: 'typed' }], spotlights: [{ from: 1, rect: [10, 10, 50, 50] }] }),
    shot('Second', 'shot here.', { focusFade: 1, spotlights: [{ from: 0.5, rect: [20, 20, 50, 50] }] }),
    shot('Third', 'shot here.')
  ], outro: { title: ['Done'] } };
  const result = runInPage(sb, `function (ev) {
    var times = [0.3, 2.2, 4, 5.1, 9.9, 13];
    var forward = times.map(ev.inspect);
    var backward = times.slice().reverse().map(ev.inspect).reverse();
    var jumpy = times.map(function (t) { ev.inspect(15); ev.inspect(0); return ev.inspect(t); });
    return { forward: forward, backward: backward, jumpy: jumpy };
  }`);
  assert.deepEqual(result.backward, result.forward);
  assert.deepEqual(result.jumpy, result.forward);
  const focus = result.forward[3];
  assert.equal(focus.step, 1);
  assert.ok(focus.caption.opacity > 0 && focus.caption.opacity < 1, 'caption mid-entrance at 5.1s');
  assert.equal(focus.spotlights[0].opacity, focus.caption.opacity, 'spotlight and caption share one ramp');
});

test('target-based zoom cameras measure the same geometry after arbitrary seeks', { skip }, () => {
  const sb = { version: 1, steps: [
    shot('Inspect', 'the dialog.', {
      camera: [{ at: 0, rect: { target: '#dialog', pad: 17 } }, { at: 4, rect: [0, 0, 400, 300] }],
      spotlights: [{ from: 0, rect: { target: '#dialog', pad: 3 } }]
    }), shot('Read', 'the result.')
  ] };
  const result = runInPage(sb, `function (ev) {
    var times = [0.567, 1.233, 2.967, 3.9];
    var forward = times.map(ev.inspect);
    var jumpy = times.map(function (t) { ev.seek(7.9); ev.seek(0.01); return ev.inspect(t); });
    return { forward: forward, jumpy: jumpy };
  }`);
  assert.deepEqual(result.jumpy, result.forward);
});

test('two-line captions keep the badge and both baselines fixed across wording and a chapter', { skip }, () => {
  const sb = { version: 1, format: 'episode', captionStyle: 'two-line', steps: [
    shot('Open', 'the queue.'),
    shot('Choose the highlighted draft', 'Compare its summary against the original request.'),
    { scene: 's', duration: 4, section: { kind: 'chapter', title: 'Approve' } },
    shot('Approve', 'when it reads well.'),
    shot('Check', 'the status column one more time before you send the reviewed draft back to its author, then confirm that every reviewer comment has been answered and that the summary still matches the request.')
  ], outro: { title: ['Done'] } };
  const result = runInPage(sb, `function (ev) {
    return [2, 6, 14, 18].map(function (t) {
      var report = ev.inspect(t);
      var cap = document.querySelector('#ev-caption .ev-cap:last-child');
      var boxes = Array.prototype.flatMap.call(cap.querySelectorAll('.ev-bold, .ev-rest'), function (span) {
        var lines = document.createRange();
        lines.selectNodeContents(span);
        return Array.from(lines.getClientRects());
      });
      var tops = boxes.map(function (r) { return Math.round(r.bottom); })
        .filter(function (v, i, a) { return a.indexOf(v) === i; });
      return { report: report, badge: cap.querySelector('.ev-num').getBoundingClientRect().top, text: cap.querySelector('.ev-text').getBoundingClientRect().left, lines: tops };
    });
  }`);
  const [oneLine, twoLines, afterChapter, tooLong] = result;
  assert.equal(oneLine.lines.length, 2, 'action and instruction each have their own line');
  assert.equal(twoLines.lines.length, 2);
  assert.equal(twoLines.lines[0], oneLine.lines[0], 'first baseline holds when a second line appears');
  assert.equal(afterChapter.lines[0], oneLine.lines[0], 'first baseline holds across the chapter');
  for (const r of [twoLines, afterChapter]) {
    assert.equal(r.badge, oneLine.badge, 'badge holds');
    assert.equal(r.text, oneLine.text, 'text column holds');
    assert.deepEqual(r.report.caption.rect, oneLine.report.caption.rect, 'caption block holds');
    assert.equal(r.report.caption.textOverflow, false);
  }
  assert.ok(tooLong.lines.length > 2);
  assert.equal(tooLong.report.caption.textOverflow, true, 'a third line is reported as overflow');
});

test('a section pauses inputs and hides ordinary overlays, while default captions keep their markup', { skip }, () => {
  const sb = { version: 1, format: 'episode', steps: [
    shot('Type', 'a name.', { keys: [{ at: 3.6, label: 'Enter', dur: 2 }], cursor: [{ at: 0, x: 10, y: 10 }],
      highlights: [{ from: 0, rect: [0, 0, 50, 50] }] }),
    { scene: 's', duration: 4, setup: [{ type: 'text', target: '#label', text: 'paused' }], section: { kind: 'chapter', title: 'Next part', credit: 'Illustrative' } },
    shot('Read', 'the result.')
  ], outro: { title: ['Done'] } };
  const result = runInPage(sb, `function (ev) {
    ev.seek(2.5);
    var defaultMarkup = document.querySelector('#ev-caption .ev-cap').innerHTML;
    ev.inspect(4.5);
    var earlyKeys = document.querySelectorAll('#ev-keys .ev-key').length;
    var report = ev.inspect(6);
    var visible = function (sel) { return Array.prototype.filter.call(document.querySelectorAll(sel), function (el) { return Number(el.style.opacity) > 0; }).length; };
    var host = document.querySelectorAll('.ev-step')[1];
    return { report: report, earlyKeys: earlyKeys, defaultMarkup: defaultMarkup, captions: document.querySelectorAll('#ev-caption .ev-cap').length,
      keys: document.querySelectorAll('#ev-keys .ev-key').length, cursors: visible('.ev-cursor'), rings: visible('.ev-ring'),
      label: host.querySelector('#label').textContent, drift: host.querySelector('.ev-scene').style.transform };
  }`);
  assert.equal(result.defaultMarkup, '<span class="ev-num">1</span><span class="ev-bold">Type</span> <span class="ev-rest">a name.</span>');
  assert.equal(result.report.section.kind, 'chapter');
  assert.equal(result.report.section.opacity, 1);
  assert.equal(result.captions, 0);
  assert.equal(result.keys, 0);
  assert.equal(result.earlyKeys, 0, 'the preceding key badge ends when the section takes over');
  assert.equal(result.cursors, 0);
  assert.equal(result.rings, 0);
  assert.equal(result.label, 'paused', 'setup still applies under the card');
  // The 300px-tall scene fits the 820px view box at 820 / 300; a drift push would scale past it.
  assert.match(result.drift, /scale\(2\.73333\)/, 'no drift push on a held card');
});

test('hard section cuts remove instructional captions on the exact incoming frame', { skip }, () => {
  const sb = { version: 1, format: 'episode', captionMotion: 'continuous', steps: [
    shot('Read', 'the queue.', { transition: 'cut', caption: { bold: 'Read', rest: 'the queue.', box: [300, 800, 600] } }),
    { scene: 's', duration: 4, transition: 'cut', section: { kind: 'chapter', title: 'Next' } },
    shot('Check', 'the result.', { transition: 'cut', caption: { bold: 'Check', rest: 'the result.', box: [300, 800, 600] } }),
    { scene: 's', duration: 4, transition: 'cut', section: { kind: 'closing', title: 'Done' } }
  ] };
  const results = runInPage(sb, `function (ev) {
    return [3.99, 4, 4.04, 4.08, 11.99, 12, 12.04].map(function (t) {
      ev.seek(t); return document.querySelectorAll('#ev-caption .ev-cap').length;
    });
  }`);
  assert.deepEqual(results, [1, 0, 0, 0, 1, 0, 0]);
});

test('two-line captions reserve their badge column for 9, 10, 100 and hidden numbers', { skip }, () => {
  const sb = { version: 1, captionStyle: 'two-line', steps: [9, 10, 100, ''].map((number) =>
    shot('Read', 'the queue.', { transition: 'cut', caption: { number, bold: 'Read', rest: 'the queue.', box: [1120, 800, 700] } })) };
  const positions = runInPage(sb, `function (ev) {
    return [2, 6, 10, 14].map(function (t) {
      ev.seek(t);
      var badge = document.querySelector('#ev-caption .ev-num');
      var range = document.createRange(); range.selectNodeContents(badge);
      var digits = range.getBoundingClientRect(), box = badge.getBoundingClientRect();
      return { textLeft: document.querySelector('#ev-caption .ev-text').getBoundingClientRect().left,
        fits: !badge.textContent || (digits.top >= box.top && digits.bottom <= box.bottom && digits.left >= box.left && digits.right <= box.right) };
    });
  }`);
  assert.deepEqual(positions.map(p => p.textLeft), Array(4).fill(positions[0].textLeft));
  assert.ok(positions.every(p => p.fits), 'badge digits stay inside the badge');
});

test('the Stockroom opening click lands inside the named item row', { skip }, () => {
  const folder = new URL('../examples/stockroom/', import.meta.url);
  const sb = JSON.parse(readFileSync(new URL('storyboard.json', folder), 'utf8'));
  const scenes = readFileSync(new URL('scenes.html', folder), 'utf8');
  const result = runInPage(sb, `function (ev) {
    ev.seek(22);
    var row = document.querySelectorAll('.ev-step')[3].querySelector('#sample-row').getBoundingClientRect();
    var cursor = document.querySelectorAll('.ev-cursor')[3].getBoundingClientRect();
    return { row: [row.left, row.top, row.right, row.bottom], point: [cursor.left + 4, cursor.top + 3] };
  }`, scenes);
  const [left, top, right, bottom] = result.row;
  assert.ok(result.point[0] > left && result.point[0] < right && result.point[1] > top && result.point[1] < bottom,
    `click ${result.point} must be inside item row ${result.row}`);
});
