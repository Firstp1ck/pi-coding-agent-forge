import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { analyze, compareTexts, MAX_BYTES, RULES } from '../skills/stop-slop/scripts/analyzer.mjs';
import { maskProse } from '../skills/stop-slop/scripts/text.mjs';

const fixture = name => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const count = (report, id) => report.rules.find(rule => rule.id === id).count;
const has = (text, id) => assert.ok(count(analyze(text), id) > 0, `${id}: ${text}`);

test('every supported rule has a positive example', () => {
  const cases = {
    SLP001: "Here's the thing: the build failed.",
    SLP002: 'We should circle back next week.',
    SLP003: 'The rest of this essay explains the change.',
    SLP004: 'Let that sink in.',
    SLP010: "This isn't just a tool, but a platform.",
    SLP011: 'Not a tool. Not a platform. A library.',
    SLP012: 'Think about it.',
    SLP013: 'What makes this hard?',
    SLP014: 'Speed. Quality. Cost.',
    SLP015: 'The decision emerges after review.',
    SLP020: 'It really helps.',
    SLP021: 'The implications are significant.',
    SLP022: 'Everyone needs this.',
    SLP030: 'Save the file—then close it.',
    SLP040: 'Additionally, save it. Additionally, close it.',
    SLP041: 'The cat sleeps. The dog runs. The bird sings. The fish swims. We wait. You listen.',
    SLP050: Array(6).fill('Our team reads the report before lunch and writes clear notes.').join(' '),
    SLP060: 'The report was written by the team.',
  };
  assert.deepEqual(Object.keys(cases), RULES.map(rule => rule.id));
  for (const [id, text] of Object.entries(cases)) has(text, id);
});

test('simple concrete prose is not required to have a penalty', () => {
  const result = analyze('Mara saved the file. Read it before lunch.');
  assert.equal(result.findingsTotal, 0);
  assert.equal(result.scores.overall, 0);
});

test('same text and options produce identical JSON', () => {
  const text = fixture('before.md');
  const first = JSON.stringify(analyze(text));
  for (let i = 0; i < 10; i++) assert.equal(JSON.stringify(analyze(text)), first);
  assert.equal(JSON.stringify(analyze(text, { ignore: ['SLP030', 'SLP001', 'SLP030'] })),
    JSON.stringify(analyze(text, { ignore: ['SLP001', 'SLP030'] })));
});

test('comparison measures revisions without claiming semantic validation', () => {
  const before = fixture('before.md');
  const after = fixture('after.md');
  const result = compareTexts(before, after);
  assert.equal(result.comparison.outcome, 'decreased');
  assert.ok(result.comparison.overallDelta < 0);
  assert.ok(result.comparison.ruleCountDeltas.SLP001 < 0);
  assert.equal(result.comparison.meaningPreserved, 'not-assessed');
  assert.equal(compareTexts(after, before).comparison.outcome, 'increased');
  assert.equal(compareTexts(before, before).comparison.overallDelta, 0);
  assert.equal(compareTexts(before, '').comparison.outcome, 'not-comparable');
  assert.equal(result.before.rulesetVersion, result.after.rulesetVersion);
  assert.deepEqual(result.before.settings, result.after.settings);
});

test('Markdown masking preserves visible link labels and hides common code syntax', () => {
  const text = [
    '---', 'title: "Here\'s the thing"', '---',
    '```js', 'const x = "really — it is important to note";', '```',
    '~~~text', 'Let that sink in.', '~~~',
    '    It turns out that code is here.',
    '<!-- The implications are significant. -->',
    '`really` and `` a ` really — ``',
    '[Read the report](https://example.com/really_(deeply) "just")',
    '[ref]: https://example.com/really',
    '<img alt="really —">', 'https://example.com/really-deeply',
    '[It turns out](https://example.com)',
  ].join('\n');
  const report = analyze(text);
  assert.equal(count(report, 'SLP001'), 1);
  assert.equal(count(report, 'SLP020'), 0);
  assert.equal(count(report, 'SLP030'), 0);
  assert.equal(report.findings[0].text, 'It turns out');
  assert.equal(maskProse(text, 'markdown').length, text.length);
  assert.ok(analyze(text, { format: 'text' }).findingsTotal > report.findingsTotal);
});

test('unclosed fences exclude the remainder; shorter closing fences stay code', () => {
  assert.equal(analyze('```\nreally —').metrics.words, 0);
  const text = '````\nreally\n```\nreally\n````\nRead the file.';
  assert.equal(count(analyze(text), 'SLP020'), 0);
  assert.equal(analyze(text).metrics.words, 3);
  assert.equal(count(analyze('```\nignored\n```\nreally'), 'SLP020'), 1);
});

test('matches cannot bridge a masked inline code span', () => {
  assert.equal(count(analyze('It is `code` important to note this.'), 'SLP001'), 0);
});

test('spans are exact, with CRLF, emoji, Unicode case, and curly apostrophes', () => {
  const text = '# Notes\r\n\r\n😀 İ Here’s the thing: it really works—today.\r\n';
  const report = analyze(text);
  for (const finding of report.findings) {
    assert.equal(text.slice(finding.start.offset, finding.end.offset), finding.text);
    const prefix = text.slice(0, finding.start.offset);
    assert.equal(finding.start.line, prefix.split('\n').length);
    assert.equal(finding.start.column, prefix.length - prefix.lastIndexOf('\n'));
  }
  assert.equal(report.findings.find(f => f.ruleId === 'SLP001').text, 'Here’s the thing');
  assert.equal(report.findings.find(f => f.ruleId === 'SLP001').start.line, 3);
});

test('case folding and whitespace matching do not match substrings', () => {
  has('IT IS\tIMPORTANT TO NOTE this.', 'SLP001');
  has('It is important\r\nto note this.', 'SLP001');
  assert.equal(count(analyze('It is important\n\nto note this.'), 'SLP001'), 0);
  assert.equal(count(analyze('unpackaged landscapeish impromptu'), 'SLP002'), 0);
  assert.equal(count(analyze('reallyish justified'), 'SLP020'), 0);
});

test('adverb and passive checks remain limited, explicit heuristics', () => {
  const text = 'A friendly family sells lovely jelly. Mara saved the file. It was quickly written.';
  const report = analyze(text);
  assert.equal(report.metrics.adverbCandidates, 1);
  assert.equal(report.metrics.passiveCandidateSentences, 1);
  assert.equal(count(report, 'SLP060'), 1);
  assert.equal(report.findings.find(f => f.ruleId === 'SLP060').kind, 'heuristic');
  has('Mistakes were made.', 'SLP060');
  assert.equal(count(analyze('The team has written the report.'), 'SLP060'), 0);
});

test('contractions and sentence-pair contrasts match upstream forms', () => {
  for (const text of [
    "Not because the code failed. Because the disk filled.",
    "It’s not a preview. It’s a saved file.",
    'Not a replacement, but a backup.',
    'It stops being a note and starts being a report.',
    "It doesn't mean stop, but actually wait.",
    'This is about speed but not throughput.',
  ]) has(text, 'SLP010');
  assert.equal(count(analyze('Do not delete the file. Save the report.'), 'SLP010'), 0);
});

test('sentence counting handles soft wraps, decimals and selected abbreviations', () => {
  const text = 'Dr. Singh measured 3.5 grams. The sample\nweighs less today. Read the report.';
  assert.equal(analyze(text).metrics.sentences, 3);
  const unwrapped = analyze(text.replace('sample\nweighs', 'sample weighs'));
  assert.deepEqual(analyze(text).scores, unwrapped.scores);
  assert.equal(analyze('# Notes\n\n- Read the file\n- Save the report').metrics.sentences, 3);
});

test('short samples and no prose cannot pretend to prove good rhythm', () => {
  const empty = analyze('```\nreally\n```');
  assert.equal(empty.scores.overall, null);
  assert.ok(empty.warnings.some(w => w.code === 'no-prose'));
  const short = analyze('The cat sleeps. The dog runs. The bird sings.');
  assert.equal(short.metrics.sentenceLength.rhythmAssessed, false);
  assert.equal(count(short, 'SLP050'), 0);
  assert.equal(count(short, 'SLP041'), 0);
  assert.ok(short.warnings.some(w => w.code === 'short-sample'));
  const rhythm = Array(6).fill('Our team reads the report before lunch and writes clear notes.').join(' ');
  assert.equal(analyze(rhythm).scores.categories.rhythm, 100);
  assert.equal(compareTexts(rhythm, 'Read the report.').comparison.rhythmAssessmentChanged, true);
});

test('ignores affect findings and scoring but preserve raw measurements', () => {
  const report = analyze('Really—really.', { ignore: ['SLP020', 'SLP030'] });
  assert.equal(report.metrics.emDashes, 1);
  assert.equal(report.metrics.adverbCandidates, 2);
  assert.equal(report.scores.categories.punctuation, null);
  assert.equal(count(report, 'SLP030'), 0);
  assert.equal(report.findingsTotal, 0);
  assert.equal(analyze('Read it.', { ignore: RULES.map(rule => rule.id) }).scores.overall, null);
  assert.throws(() => analyze('text', { ignore: ['SLP999'] }), /known rule/);
});

test('finding limits never change counts or scores', () => {
  const text = fixture('before.md');
  const full = analyze(text);
  const limited = analyze(text, { maxFindings: 1 });
  assert.deepEqual(full.scores, limited.scores);
  assert.deepEqual(full.rules, limited.rules);
  assert.equal(full.findingsTotal, limited.findingsTotal);
  assert.equal(limited.findings.length, 1);
  assert.equal(analyze(text, { maxFindings: 0 }).findings.length, 0);
  assert.ok(limited.warnings.some(w => w.code === 'findings-truncated'));
});

test('option validation and UTF-8 size bounds', () => {
  assert.throws(() => analyze(null), /string/);
  assert.throws(() => analyze('a', { format: 'html' }), /format/);
  assert.throws(() => analyze('a', { maxFindings: -1 }), /maxFindings/);
  assert.throws(() => analyze('a', { maxFindings: 0.5 }), /maxFindings/);
  assert.throws(() => analyze('a', { ignore: 'SLP001' }), /ignore/);
  assert.throws(() => analyze('a'.repeat(MAX_BYTES + 1)), /exceeds/);
  assert.throws(() => analyze('é'.repeat(MAX_BYTES / 2 + 1)), /exceeds/);
  assert.equal(analyze('a'.repeat(MAX_BYTES)).input.bytes, MAX_BYTES);
});

test('scores stay bounded and findings stay ordered on generated inputs', () => {
  let seed = 42;
  const chunks = ['Read the file.', 'Really.', "Here's the thing: save it.", 'The file was saved.', '—', '`really`', '\n\n', '🙂'];
  for (let run = 0; run < 30; run++) {
    const text = Array.from({ length: 40 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return chunks[seed % chunks.length];
    }).join(' ');
    const report = analyze(text);
    for (const score of [report.scores.overall, ...Object.values(report.scores.categories)]) {
      assert.ok(score === null || (Number.isFinite(score) && score >= 0 && score <= 100));
    }
    report.findings.forEach((finding, i) => {
      assert.equal(finding.text, text.slice(finding.start.offset, finding.end.offset));
      if (i) assert.ok(finding.start.offset >= report.findings[i - 1].start.offset);
    });
  }
});

test('upstream snapshots match pinned provenance and retain the MIT notice', () => {
  const base = new URL('../skills/stop-slop/references/upstream/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('PROVENANCE.json', base), 'utf8'));
  assert.equal(manifest.commit, '8da1f030185bdfe8471220585162991eaeb970e9');
  for (const entry of manifest.files) {
    const bytes = readFileSync(new URL(entry.bundledPath, base));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
  assert.match(readFileSync(new URL('LICENSE', base), 'utf8'), /Copyright \(c\) 2025 Hardik Pandya/);
});
