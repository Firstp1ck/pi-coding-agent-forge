import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseArgs, runCli, retryTargets, loadExclusions, releaseSummary } from '../release/cli.mjs';

const capture = () => ({ text: '', write(chunk) { this.text += chunk; } });
const record = (target, status, extra = {}) => ({ target, name: `@test/${target}`, version: '1.0.1', oldVersion: '1.0.0', status, stage: 'validate', action: 'publish-update', detail: status, logPath: '/tmp/log', ...extra });
function result(root, records) {
  const counts = { total: records.length, candidates: records.length, ready: 0, published: 0, processing: 0, skipped: 0, unchanged: 0, failed: 0, blocked: 0, cancelled: 0 };
  records.forEach(record => counts[record.status]++);
  const exitCode = counts.cancelled ? 130 : counts.failed + counts.blocked ? 1 : 0;
  const report = { schemaVersion: 1, root, mode: 'plan', records, counts, exitCode, warnings: [] };
  return { records, counts, exitCode, report };
}

await test('argument contract supports all modes, preserves explicit policy, rejects ambiguous/obsolete options', () => {
  assert.equal(parseArgs(['--publish', '--targets', 'a,b']).strictAuth, true);
  assert.deepEqual(parseArgs(['--publish', '--target', 'dir,with,commas']).targets, ['dir,with,commas']);
  assert.deepEqual(parseArgs(['--publish', '--targets-json', '["dir,with,commas","other"]']).targets, ['dir,with,commas', 'other']);
  assert.deepEqual(parseArgs(['--publish', '--targets-json', '["all"]']).targets, ['all']);
  for (const invalid of ['"all"', 'null', 'true', '{}', '1', '[]']) assert.throws(() => parseArgs(['--publish', '--targets-json', invalid]), /array/);
  assert.equal(parseArgs(['--plan']).strictAuth, false);
  assert.equal(parseArgs(['--publish']).verifyTimeout, 1200);
  assert.equal(parseArgs(['--publish', '--verify-timeout', '60']).verifyTimeout, 60);
  for (const seconds of ['0', '-1', '0.5', 'no', '86401']) assert.throws(() => parseArgs(['--publish', '--verify-timeout', seconds]), /verify-timeout/);
  assert.equal(parseArgs(['--check']).strictAuth, false);
  assert.equal(parseArgs(['--plan', '--strict-auth']).strictAuth, true);
  assert.equal(parseArgs(['--publish', '--no-strict-auth']).strictAuth, false);
  const flags = parseArgs(['--publish', '--targets', 'a,b', '--concurrency', '8', '--publisher', 'bun', '--access', 'restricted', '--refresh', '--exclude', 'x', '--exclude', '@test/y']);
  assert.deepEqual(flags.targets, ['a', 'b']); assert.deepEqual(flags.exclusions, ['x', '@test/y']); assert.equal(flags.concurrency, 8);
  for (const args of [[], ['--check', '--plan'], ['--plan', '--concurrency', '0'], ['--plan', '--concurrency', '1.5'], ['--plan', '--target'], ['--plan', '--targets', 'a,,b'], ['--check', '--check-alt-client'], ['--plan', '--publisher', 'other'], ['--plan', '--access', 'other'], ['--plan', '--all', '--targets', 'a'], ['--plan', '--retry-failed', 'x', '--all'], ['--plan', '--strict-auth', '--no-strict-auth'], ['--plan', '--wat']]) assert.throws(() => parseArgs(args), args.join(' '));
});

await test('help never invokes engine or reads root config, including wrappers with no root', async () => {
  let called = false; const output = capture();
  const exit = await runCli(['--help'], { cwd: '/missing/root', output, engine: async () => { called = true; } });
  assert.equal(exit, 0); assert.equal(called, false); assert.match(output.text, /--retry-failed/);
});

await test('strict config validation precedes the engine and combines exact exclusions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-cli-config-'));
  try {
    for (const invalid of ['{', '[]', '{}', '{"exclusions":["*"]}', '{"exclusions":["x"],"unknown":true}', '{"exclusions":[4]}']) {
      await writeFile(path.join(root, '.release-config.json'), invalid);
      const output = capture();
      assert.equal(await runCli(['--check', '--json'], { cwd: root, output, engine: () => assert.fail('invalid config ran engine') }), 1);
      assert.ok(JSON.parse(output.text).error);
    }
    await writeFile(path.join(root, '.release-config.json'), '{"exclusions":["unfinished","@test/private"]}');
    let observed;
    const output = capture();
    assert.equal(await runCli(['--plan', '--exclude', 'unfinished', '--exclude', 'other', '--json'], { cwd: root, output, engine: async options => { observed = options; return result(root, []); } }), 0);
    assert.deepEqual(observed.exclusions, ['unfinished', '@test/private', 'other']);
    assert.equal(observed.strictAuth, false); assert.equal(observed.verifyTimeout, 1200);
    assert.deepEqual(await loadExclusions(root), ['unfinished', '@test/private']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('plain progress is bounded structured records; final outcomes emit exactly once, not transient ready', async () => {
  const output = capture(); const signals = new EventEmitter();
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-cli-output-'));
  const records = [record('a', 'published'), record('b', 'blocked'), record('bad', 'failed', { name: null, version: null }), record('c', 'cancelled'), record('d', 'unchanged')];
  try {
    const exit = await runCli(['--publish', '--plain'], { cwd: root, output, signals, engine: async options => {
      for (const status of ['running', 'ready', 'published']) options.onEvent(record('a', status));
      return result(root, records);
    } });
    assert.equal(exit, 130); assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(output.text.split('\n').filter(line => line.startsWith('RELEASE_NPM_PROGRESS ')).length, 3);
    const outcomes = output.text.split('\n').filter(line => line.startsWith('RELEASE_NPM_EVENT ')).map(line => JSON.parse(line.slice(18)));
    assert.equal(outcomes.length, records.length);
    assert.deepEqual(outcomes.map(item => item.status), ['published', 'failed', 'failed', 'failed', 'skipped']);
    assert.ok(!output.text.includes('\x1b')); assert.match(output.text, /Published\s+1/); assert.match(output.text, /Unchanged\s+1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('verified package warnings remain visible alongside successful publication counts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-cli-warning-'));
  try {
    const output = capture(), errors = capture();
    const verified = record('uploaded', 'published', { warnings: ['postpublish hook failed; see package log'] });
    const exit = await runCli(['--publish', '--plain'], { cwd: root, output, errors, engine: async () => {
      const value = result(root, [verified]); value.exitCode = value.report.exitCode = 1; return value;
    } });
    assert.equal(exit, 1);
    assert.match(output.text, /Published\s+1/);
    assert.match(errors.text, /postpublish hook failed.*log: \/tmp\/log/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('JSON alone on stdout, atomic reports, retry status filtering and root/record validation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-cli-json-'));
  try {
    const file = path.join(root, 'reports/result.json');
    const output = capture(), errors = capture();
    let calls = 0;
    const engine = async options => {
      calls++;
      options.onEvent(record('a', 'running'));
      if (calls === 2) assert.deepEqual(options.targets, ['failed', 'blocked', 'cancelled', 'processing']);
      return result(root, ['ready', 'published', 'unchanged', 'skipped', 'failed', 'blocked', 'cancelled', 'processing'].map(status => record(status, status)));
    };
    assert.equal(await runCli(['--plan', '--json', '--report', file], { cwd: root, output, errors, engine }), 130);
    assert.deepEqual(JSON.parse(output.text), JSON.parse(await readFile(file, 'utf8')));
    assert.equal(errors.text, ''); assert.deepEqual(await readdir(path.dirname(file)), ['result.json']);
    assert.equal(await runCli(['--publish', '--json', '--retry-failed', file], { cwd: root, output: capture(), engine }), 130);
    assert.equal(calls, 2);
    const invalid = path.join(root, 'invalid.json');
    for (const data of [{ schemaVersion: 2, root, records: [] }, { schemaVersion: 1, root, records: [record('../escape', 'failed')] }, { schemaVersion: 1, root, records: [record('good', 'published')] }]) {
      await writeFile(invalid, JSON.stringify(data)); await assert.rejects(retryTargets(invalid, root));
    }
    await mkdir(path.join(root, 'other'));
    await assert.rejects(retryTargets(file, path.join(root, 'other')), /root does not match/);
    const failure = capture();
    assert.equal(await runCli(['--wat', '--json'], { cwd: root, output: failure }), 1);
    assert.match(JSON.parse(failure.text).error, /Unknown option/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('cancellation forwards AbortSignal, global rejection stays JSON, report write failures remain visible', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-cli-errors-'));
  try {
    const signals = new EventEmitter(), output = capture();
    const exit = await runCli(['--publish', '--json'], { cwd: root, output, signals, engine: async options => {
      signals.emit('SIGINT'); assert.equal(options.signal.aborted, true);
      return result(root, [record('a', 'cancelled')]);
    } });
    assert.equal(exit, 130); assert.equal(JSON.parse(output.text).exitCode, 130);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    const rejection = capture();
    assert.equal(await runCli(['--check', '--json'], { cwd: root, output: rejection, engine: async () => { throw new Error('global failure'); } }), 1);
    assert.equal(JSON.parse(rejection.text).error, 'global failure');
    const errors = capture(), json = capture();
    assert.equal(await runCli(['--plan', '--json', '--report', root], { cwd: root, output: json, errors, engine: async () => result(root, []) }), 1);
    assert.match(errors.text, /Cannot save report/); assert.ok(JSON.parse(json.text).counts);
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test('final summary groups counts and pending uploads with a readable next step', () => {
  const records = [record('queued', 'processing'), ...Array.from({ length: 93 }, (_, i) => record(`unchanged-${i}`, 'unchanged')), record('excluded', 'skipped')];
  const value = result('/workspace', records); value.report.logDir = '/private/logs/run';
  const text = releaseSummary(value, 'publish');
  assert.match(text, /Packages\s+95/); assert.match(text, /Published\s+0/);
  assert.match(text, /Processing\s+1/); assert.match(text, /Unchanged\s+93/); assert.match(text, /Problems\s+1/);
  assert.match(text, /Waiting for registry \(1\)\n  @test\/queued@1.0.1\n    processing\n    Log: \/tmp\/log/);
  assert.match(text, /Next step\n  Verification did not finish/); assert.match(text, /Saved receipts prevent another upload/);
  assert.match(text, /Logs\n  \/private\/logs\/run/);
  assert.ok(!text.includes('unchanged-')); assert.ok(!text.includes('Failed        0'));
});

await test('final summary preserves failed stages and log locations, separates publications and plan readiness', () => {
  const value = result('/workspace', [record('healthy', 'published'), record('bad', 'failed', { detail: 'missing resource', stage: 'validate' }), record('waiting', 'blocked'), record('stopped', 'cancelled')]);
  const text = releaseSummary(value, 'publish');
  assert.match(text, /Problems\s+3/); assert.match(text, /Needs attention \(3\)/);
  assert.match(text, /FAILED  @test\/bad@1.0.1\n    validate: missing resource\n    Log: \/tmp\/log/);
  assert.match(text, /BLOCKED  @test\/waiting/); assert.match(text, /CANCELLED  @test\/stopped/);
  assert.match(text, /Published \(1\)\n  @test\/healthy@1.0.1/);
  const plan = releaseSummary(result('/workspace', [record('next', 'ready')]), 'plan');
  assert.match(plan, /Ready\s+1/); assert.match(plan, /Ready to publish \(1\)/); assert.ok(!plan.includes('Published'));
  assert.match(releaseSummary(result('/workspace', [record('same', 'unchanged')]), 'publish'), /Nothing new to publish/);
});

await test('verification timeout is forwarded and an unverified result returns nonzero without a success summary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-cli-verification-'));
  try {
    const output = capture();
    const exit = await runCli(['--publish', '--plain', '--verify-timeout', '90'], { cwd: root, output, engine: async options => {
      assert.equal(options.verifyTimeout, 90);
      options.onEvent(record('queued', 'running', { stage: 'verify', detail: 'Waiting for registry confirmation' }));
      const value = result(root, [record('queued', 'processing', { stage: 'verify', detail: 'Verification timed out after 90s; publication is not confirmed' })]);
      value.exitCode = value.report.exitCode = 1;
      return value;
    } });
    assert.equal(exit, 1); assert.match(output.text, /Published\s+0/); assert.match(output.text, /Problems\s+1/);
    assert.match(output.text, /publication is not confirmed/); assert.ok(!output.text.includes('Nothing new to publish'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
