import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { removeOwnedTree, snapshot } from '../release/workspace.mjs';

await test('bounded snapshots preserve executable modes, timestamps, filtering and independent file contents', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-copy-'));
  try {
    const source = path.join(temporary, 'source'), destination = path.join(temporary, 'copy');
    await mkdir(path.join(source, 'scripts'), { recursive: true });
    await chmod(path.join(source, 'scripts'), 0o711);
    const executable = path.join(source, 'scripts/run');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o751 });
    await utimes(executable, 1_700_000_000, 1_700_000_000);
    await writeFile(path.join(source, 'excluded'), 'skip');
    await symlink('scripts/run', path.join(source, 'linked'));
    const outside = path.join(temporary, 'outside-file');
    await writeFile(outside, 'outside bytes');
    await symlink(outside, path.join(source, 'external-file'));
    await symlink('missing-target', path.join(source, 'dangling'));
    await snapshot(source, destination, { filter: file => path.basename(file) !== 'excluded', externalRoot: path.join(temporary, 'external') });
    const from = await lstat(executable), to = await lstat(path.join(destination, 'scripts/run'));
    assert.equal(to.mode & 0o777, from.mode & 0o777); assert.equal(to.mtimeMs, from.mtimeMs);
    assert.equal((await lstat(path.join(destination, 'scripts'))).mode & 0o777, 0o711);
    assert.notEqual(to.ino, from.ino); assert.equal((await lstat(path.join(destination, 'linked'))).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(destination, 'linked'), 'utf8'), '#!/bin/sh\nexit 0\n');
    await assert.rejects(lstat(path.join(destination, 'excluded')), { code: 'ENOENT' });
    await writeFile(path.join(destination, 'scripts/run'), 'changed');
    assert.equal(await readFile(executable, 'utf8'), '#!/bin/sh\nexit 0\n');
    await writeFile(path.join(destination, 'external-file'), 'isolated bytes');
    assert.equal(await readFile(outside, 'utf8'), 'outside bytes');
    assert.equal((await lstat(path.join(destination, 'dangling'))).isSymbolicLink(), true);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

await test('snapshot traversal bounds pending filesystem work and drains it before reporting failure', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-copy-failure-'));
  try {
    const source = path.join(temporary, 'source'), destination = path.join(temporary, 'copy');
    await mkdir(source);
    await Promise.all(Array.from({ length: 64 }, (_, index) => writeFile(path.join(source, String(index).padStart(3, '0')), 'bytes')));
    let active = 0, peak = 0, finished = 0;
    await assert.rejects(snapshot(source, destination, { externalRoot: path.join(temporary, 'external'), filter: async file => {
      if (file === source) return true;
      peak = Math.max(peak, ++active);
      try { await delay(5); if (path.basename(file) === '020') throw new Error('fixture copy rejected'); return true; }
      finally { active--; finished++; }
    } }), /fixture copy rejected/);
    assert.equal(active, 0); assert.ok(peak > 1 && peak <= 16);
    const count = (await readdir(destination)).length, settled = finished;
    await delay(20);
    assert.equal((await readdir(destination)).length, count); assert.equal(finished, settled);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

await test('owned cleanup handles restrictive directories without changing outside symlink targets', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-cleanup-'));
  const outside = path.join(temporary, 'outside');
  try {
    const owned = path.join(temporary, 'owned');
    await mkdir(path.join(owned, 'restricted'), { recursive: true });
    await writeFile(path.join(owned, 'restricted/file'), 'owned');
    await mkdir(outside); await writeFile(path.join(outside, 'kept'), 'outside');
    await chmod(outside, 0o555);
    await symlink(outside, path.join(owned, 'outside-link'));
    await chmod(path.join(owned, 'restricted'), 0o000);
    await removeOwnedTree(owned);
    await assert.rejects(lstat(owned), { code: 'ENOENT' });
    assert.equal((await lstat(outside)).mode & 0o777, 0o555);
    assert.equal(await readFile(path.join(outside, 'kept'), 'utf8'), 'outside');
  } finally { await chmod(outside, 0o700).catch(() => {}); await rm(temporary, { recursive: true, force: true }); }
});
