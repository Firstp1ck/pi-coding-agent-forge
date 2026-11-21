import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './interface-fixture.mjs';

await test('CLI bundle and lifecycle preparation stays temporary in plan and publish, healthy packages survive install failure', async () => {
  const bundle = { bundledDependencies: ['@test/bundle'], dependencies: { '@test/bundle': '1.0.0' }, pi: { prompts: ['./node_modules/@test/bundle'] } };
  const f = await fixture({ healthy: bundle, hook: { scripts: { prepack: 'generate' } }, broken: bundle }, { errors: { '@test/broken': 'install' } });
  try {
    for (const mode of ['--plan', '--publish']) {
      const result = f.run([mode, '--all', '--json']);
      assert.equal(result.status, 1, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.records.map(record => record.status), mode === '--plan' ? ['failed', 'ready', 'ready'] : ['failed', 'published', 'published']);
      await assert.rejects(readFile(path.join(f.root, 'healthy/node_modules/@test/bundle/package.json')));
      await assert.rejects(readFile(path.join(f.root, 'hook/generated.txt')));
    }
    const commands = await f.commands();
    for (const item of commands.filter(item => ['install', 'publish'].includes(item.args[0]))) {
      if (item.args[0] === 'publish' && !item.args.includes('--dry-run')) {
        assert.equal(item.cwd, path.join(f.root, item.name === '@test/healthy' ? 'healthy' : 'hook'));
        assert.ok(item.args.includes('--ignore-scripts'));
        assert.ok(item.args.includes('--registry'));
        assert.ok(item.args.some(arg => arg.startsWith('--@test:registry=')));
        assert.ok(!item.args[1].startsWith(f.root), 'upload uses the isolated validated tarball');
      } else {
        assert.ok(!item.cwd.startsWith(f.root), `preparation/validation workspace must be isolated: ${item.cwd}`);
      }
    }
    const installs = commands.filter(item => item.args[0] === 'install');
    assert.equal(installs.length, 4);
    assert.ok(installs.every(item => item.args.includes('--ignore-scripts') && item.args.includes('--no-save') && item.args.includes('--package-lock=false')));
  } finally { await f.close(); }
});
