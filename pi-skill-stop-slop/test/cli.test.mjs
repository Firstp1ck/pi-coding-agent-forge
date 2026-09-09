import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { analyze, MAX_BYTES } from '../skills/stop-slop/scripts/analyzer.mjs';

const cli = fileURLToPath(new URL('../skills/stop-slop/scripts/slopcheck.mjs', import.meta.url));
const before = fileURLToPath(new URL('fixtures/before.md', import.meta.url));
const after = fileURLToPath(new URL('fixtures/after.md', import.meta.url));
const run = (args, input = '', options = {}) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 10000, ...options });
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stop-slop-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('CLI JSON is byte-identical across processes', () => {
  const first = run([before, '--json']);
  const second = run([before, '--json']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stderr, '');
  assert.deepEqual(JSON.parse(first.stdout), analyze(readFileSync(before, 'utf8')));
});

test('UTF-8 stdin, explicit stdin and file paths produce the same report', t => {
  const dir = temporary(t);
  const path = join(dir, 'draft with spaces.md');
  const text = '\uFEFF# Notes\r\n😀 Here’s the thing: it really works.\r\n';
  writeFileSync(path, text);
  const file = run([path, '--json']);
  assert.equal(file.status, 0, file.stderr);
  assert.equal(file.stdout, run(['-', '--json'], Buffer.from(text)).stdout);
  assert.equal(file.stdout, run(['--json'], Buffer.from(text)).stdout);
  assert.equal(JSON.parse(file.stdout).input.bytes, Buffer.byteLength(text));
});

test('baseline comparison reports category and rule deltas', () => {
  const result = run([after, '--baseline', before, '--json', '--fail-on-regression', '--max-score', '30']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.comparison.outcome, 'decreased');
  assert.equal(report.before.scores.overall, 15.77);
  assert.equal(report.after.scores.overall, 0.94);
  assert.equal(report.comparison.overallDelta, -14.83);
  assert.deepEqual(report.before.scores.categories, {
    formulaic: 23.38, rhetoric: 7.79, repetition: 5.88, adverbs: 38.96,
    punctuation: 0, rhythm: 0, passive: 35.29, vague: 16.23,
  });
  assert.equal(run([before, '--baseline', after, '--fail-on-regression']).status, 1);
  assert.equal(run([before, '--baseline', before, '--fail-on-regression']).status, 0);
  assert.equal(run(['--baseline', before, '--fail-on-regression'], '').status, 1);
});

test('score threshold handles equality, failure, and null scores', () => {
  assert.equal(run([before, '--max-score', '15.77']).status, 0);
  assert.equal(run([before, '--max-score', '15.76']).status, 1);
  assert.equal(run(['--max-score', '0'], 'Read the report.').status, 0);
  assert.equal(run(['--max-score', '100'], '').status, 1);
  assert.equal(run(['--json'], '```\nreally\n```').status, 1);
});

test('invalid arguments fail with JSON errors before consuming input', () => {
  const cases = [
    ['--format', 'html'], ['--max-score', 'NaN'], ['--max-score', 'Infinity'],
    ['--max-score', '-1'], ['--max-score', '101'], ['--max-score'],
    ['--ignore', 'SLP999'], ['--max-findings', '-1'], ['--max-findings', '1.5'],
    ['--max-findings', '10001'], ['--timeout-ms', '0'], ['--timeout-ms', '60001'],
    ['--baseline', '-'], ['--baseline'], ['--fail-on-regression'],
    ['--unknown'], ['--format', 'text', '--format', 'text'], [before, after],
  ];
  for (const args of cases) {
    const result = run([...args, '--json']);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.equal(typeof JSON.parse(result.stderr).error.message, 'string');
  }
});

test('help and rule listing work without input', () => {
  assert.equal(run(['--help']).status, 0);
  const rules = run(['--rules', '--json']);
  assert.equal(rules.status, 0, rules.stderr);
  const report = JSON.parse(rules.stdout);
  assert.equal(report.rules.length, 18);
  assert.equal(new Set(report.rules.map(rule => rule.id)).size, report.rules.length);
});

test('invalid UTF-8 and oversized input fail without partial reports', t => {
  const dir = temporary(t);
  const invalid = Buffer.from([0xc3, 0x28]);
  const path = join(dir, 'invalid.txt');
  writeFileSync(path, invalid);
  for (const result of [run([path, '--json']), run(['--json'], invalid), run(['--json'], Buffer.alloc(MAX_BYTES + 1, 65))]) {
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.ok(JSON.parse(result.stderr).error.message);
  }
  const oversized = join(dir, 'large.txt');
  writeFileSync(oversized, Buffer.alloc(MAX_BYTES + 1, 65));
  assert.equal(run([oversized]).status, 2);
});

test('missing files and directories are input errors', t => {
  const dir = temporary(t);
  assert.equal(run([join(dir, 'missing.txt')]).status, 2);
  assert.equal(run([dir]).status, 2);
  assert.equal(run([before, '--baseline', join(dir, 'missing.txt')]).status, 2);
});

test('POSIX FIFOs are rejected without waiting for a writer', { skip: process.platform === 'win32' }, t => {
  const dir = temporary(t);
  const path = join(dir, 'fifo');
  const result = spawnSync('mkfifo', [path]);
  assert.equal(result.status, 0);
  const checked = run([path], '', { timeout: 2000 });
  assert.equal(checked.status, 2, checked.stderr);
  assert.match(checked.stderr, /not a regular file/);
});

test('unfinished stdin times out and exits instead of hanging', async () => {
  const child = spawn(process.execPath, [cli, '--json', '--timeout-ms', '30'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const watchdog = setTimeout(() => child.kill(), 4000);
  try {
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    assert.equal(status, 2, stderr);
    assert.match(stderr, /timed out/);
  } finally {
    clearTimeout(watchdog);
    child.stdin.destroy();
  }
});

test('reports escape terminal controls and cannot execute draft text', t => {
  const dir = temporary(t);
  const text = "Here's the thing: $(touch owned) `touch owned` really\u001b[31m works.\u009b0m";
  const result = run(['--format', 'text'], text, { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes('\u001b'));
  assert.ok(!result.stdout.includes('\u009b'));
  assert.deepEqual(readdirSync(dir), []);
});

test('double dash supports option-like filenames and runs do not change drafts', t => {
  const dir = temporary(t);
  const filename = '-draft.md';
  const text = "Here's the thing: read the report.";
  writeFileSync(join(dir, filename), text);
  const result = run(['--json', '--', filename], '', { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dir, filename), 'utf8'), text);
  assert.deepEqual(readdirSync(dir), [filename]);
});

test('the skill runs when copied alone, outside the npm package', t => {
  const dir = temporary(t);
  const target = join(dir, 'standalone-skill');
  cpSync(new URL('../skills/stop-slop/', import.meta.url), target, { recursive: true });
  const result = spawnSync(process.execPath, [join(target, 'scripts/slopcheck.mjs'), '--json'], {
    input: "Here's the thing: read the report.", encoding: 'utf8', cwd: dir,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rules[0].count, 1);
});
