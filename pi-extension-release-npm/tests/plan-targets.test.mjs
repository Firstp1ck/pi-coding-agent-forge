import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, packageRoot, repoRoot } from './interface-fixture.mjs';

await test('both real wrappers run multi-target plans and publications through the packaged engine', async () => {
  for (const wrapper of [path.join(packageRoot, 'release-workflow.sh'), path.join(repoRoot, 'dev/scripts/release-workflow.sh')]) {
    const f = await fixture({ a: {}, b: {}, excluded: {}, private: { private: true }, invalid: { invalid: true } });
    try {
      await writeFile(path.join(f.root, '.release-config.json'), JSON.stringify({ exclusions: ['excluded'] }));
      const plan = f.run(['--plan', '--targets', 'a,b,excluded,private,invalid', '--json'], { wrapper });
      assert.equal(plan.status, 1, plan.stderr);
      const report = JSON.parse(plan.stdout);
      assert.deepEqual(report.records.map(item => item.status), ['ready', 'ready', 'skipped', 'skipped', 'failed']);
      assert.equal((await f.commands()).some(item => item.args[0] === 'whoami'), false);
      const published = f.run(['--publish', '--targets', 'b,a', '--json'], { wrapper });
      assert.equal(published.status, 0, published.stderr);
      assert.equal(JSON.parse(published.stdout).counts.published, 2);
      assert.equal((await f.commands()).filter(item => item.args[0] === 'publish' && !item.args.includes('--dry-run')).length, 2);
    } finally { await f.close(); }
  }
});

await test('installed wrapper defaults to current package root; repository wrapper defaults to its own repository', async () => {
  const f = await fixture();
  try {
    const noRoot = { ...f.env }; delete noRoot.PI_NPM_PACKAGES_ROOT;
    const single = f.run(['--plan', '--json'], { cwd: path.join(f.root, 'healthy'), env: noRoot });
    assert.equal(single.status, 0, single.stderr);
    const report = JSON.parse(single.stdout);
    assert.equal(report.root, path.join(f.root, 'healthy'));
    assert.equal(report.records[0].target, '.');
    const repo = path.join(f.temporary, 'repo copy');
    await mkdir(path.join(repo, 'dev/scripts'), { recursive: true });
    await mkdir(path.join(repo, 'pi-extension-release-npm'), { recursive: true });
    await cp(path.join(packageRoot, 'release'), path.join(repo, 'pi-extension-release-npm/release'), { recursive: true });
    await cp(path.join(repoRoot, 'dev/scripts/release-workflow.sh'), path.join(repo, 'dev/scripts/release-workflow.sh'));
    await cp(path.join(f.root, 'healthy'), path.join(repo, 'healthy'), { recursive: true });
    const dev = f.run(['--plan', '--target', 'healthy', '--json'], { wrapper: path.join(repo, 'dev/scripts/release-workflow.sh'), cwd: f.temporary, env: noRoot });
    assert.equal(dev.status, 0, dev.stderr);
    assert.equal(JSON.parse(dev.stdout).root, repo);
    const override = f.run(['--plan', '--root', f.root, '--json'], { wrapper: path.join(repo, 'dev/scripts/release-workflow.sh'), env: noRoot });
    assert.equal(JSON.parse(override.stdout).root, f.root);
  } finally { await f.close(); }
});

await test('plain shell output keeps child diagnostics in retained logs', async () => {
  const f = await fixture({ healthy: {} }, { noisy: true });
  try {
    const run = f.run(['--plan', '--plain']);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!run.stdout.includes('CHILD_NOISE_MUST_STAY_IN_LOGS'));
    assert.ok(!run.stderr.includes('CHILD_NOISE_MUST_STAY_IN_LOGS'));
    const line = run.stdout.split('\n').find(line => line.startsWith('RELEASE_NPM_EVENT '));
    const record = JSON.parse(line.slice(18));
    assert.match(await readFile(record.logPath, 'utf8'), /CHILD_NOISE_MUST_STAY_IN_LOGS/);
  } finally { await f.close(); }
});
