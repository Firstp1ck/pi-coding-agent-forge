import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './interface-fixture.mjs';

await test('CLI report retry invokes fresh engine work for only failed targets in the matching root', async () => {
  const f = await fixture({ healthy: {}, broken: {} }, { errors: { '@test/broken': 'validate' } });
  try {
    const reportFile = path.join(f.temporary, 'reports/release.json');
    const first = f.run(['--publish', '--all', '--report', reportFile, '--json']);
    assert.equal(first.status, 1, first.stderr);
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(report.counts.published, 1); assert.equal(report.counts.failed, 1);
    const before = (await f.commands()).length;
    await writeFile(path.join(f.temporary, 'state.json'), '{}');
    const retry = f.run(['--publish', '--retry-failed', reportFile, '--json']);
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(JSON.parse(retry.stdout).records.map(item => item.target), ['broken']);
    assert.ok((await f.commands()).slice(before).some(item => item.args[0] === 'view' && item.args[1] === '@test/broken'));
    assert.equal((await f.commands()).filter(item => item.args[0] === 'publish' && !item.args.includes('--dry-run') && item.name === '@test/healthy').length, 1);
    const mismatch = f.run(['--plan', '--root', path.join(f.root, 'healthy'), '--retry-failed', reportFile, '--json']);
    assert.equal(mismatch.status, 1); assert.match(JSON.parse(mismatch.stdout).error, /root does not match/);
  } finally { await f.close(); }
});
