import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { WorkspaceCheckpoints } from '../release/checkpoints.mjs';

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'release-checkpoints-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, 'workspace'), external = path.join(temporary, 'external');
  const directory = path.join(temporary, 'checkpoints');
  await fs.mkdir(workspace);
  return { temporary, workspace, external, directory, store: new WorkspaceCheckpoints(directory) };
}

async function put(root, relative, bytes, mode = 0o644) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, { mode });
  return file;
}

async function missing(file) {
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
}

const restored = (temporary, index) => ({ workspace: path.join(temporary, `restored-${index}`), external: path.join(temporary, `restored-external-${index}`) });

await test('checkpoints retain hook output, unpacked artifacts, sibling/external state, deletion, modes and timestamps', async t => {
  const { temporary, workspace, external, store } = await fixture(t);
  const deleted = await put(workspace, 'packages/a/removed-before-upload', 'obsolete');
  const old = await store.capture({ workspace, external });
  await fs.rm(deleted);
  const executable = await put(workspace, 'packages/a/generated/run', '#!/bin/sh\nprintf hook-output\n', 0o751);
  await fs.chmod(path.dirname(executable), 0o750);
  await fs.utimes(executable, 1_700_000_001.125, 1_700_000_002.25);
  const expected = await fs.lstat(executable);
  await put(workspace, 'packages/b/sibling-hook-output', 'sibling after prepare');
  await put(workspace, 'unpacked/package/dist/index.js', Buffer.from([0, 1, 255, 17]));
  await fs.mkdir(path.join(workspace, 'empty-hook-directory'));
  const externalFile = await put(external, '0/generated', 'external after prepack', 0o640);
  await fs.utimes(externalFile, 1_700_000_003, 1_700_000_004);
  const handle = await store.capture({ workspace, external });
  assert.deepEqual(Object.keys(handle), []);
  assert.equal(Object.isFrozen(handle), true);
  await fs.rm(workspace, { recursive: true });
  await fs.rm(external, { recursive: true });
  const destination = restored(temporary, 1);
  assert.equal(await store.restore(handle, destination), undefined);
  await missing(path.join(destination.workspace, 'packages/a/removed-before-upload'));
  assert.equal(await fs.readFile(path.join(destination.workspace, 'packages/a/generated/run'), 'utf8'), '#!/bin/sh\nprintf hook-output\n');
  assert.equal(await fs.readFile(path.join(destination.workspace, 'packages/b/sibling-hook-output'), 'utf8'), 'sibling after prepare');
  assert.deepEqual(await fs.readFile(path.join(destination.workspace, 'unpacked/package/dist/index.js')), Buffer.from([0, 1, 255, 17]));
  assert.deepEqual(await fs.readdir(path.join(destination.workspace, 'empty-hook-directory')), []);
  const actual = await fs.lstat(path.join(destination.workspace, 'packages/a/generated/run'));
  assert.equal(actual.mode & 0o7777, expected.mode & 0o7777);
  assert.equal(actual.atimeMs, expected.atimeMs);
  assert.equal(actual.mtimeMs, expected.mtimeMs);
  assert.equal((await fs.lstat(path.join(destination.workspace, 'packages/a/generated'))).mode & 0o7777, 0o750);
  assert.equal(await fs.readFile(path.join(destination.external, '0/generated'), 'utf8'), 'external after prepack');
  const externalInfo = await fs.lstat(path.join(destination.external, '0/generated'));
  assert.equal(externalInfo.mode & 0o7777, 0o640);
  assert.equal(externalInfo.mtimeMs, 1_700_000_004_000);
  const previous = restored(temporary, 0);
  await store.restore(old, previous);
  assert.equal(await fs.readFile(path.join(previous.workspace, 'packages/a/removed-before-upload'), 'utf8'), 'obsolete');
  await missing(previous.external);
  await store.restore(handle, { workspace, external });
  assert.equal(await fs.readFile(path.join(workspace, 'packages/b/sibling-hook-output'), 'utf8'), 'sibling after prepare');
});

await test('symlinks relocate across roots, retain relative/absolute forms and dangling targets, and preserve outside endpoints', async t => {
  const { temporary, workspace, external, store, directory } = await fixture(t);
  await put(workspace, 'pkg/file', 'inside');
  await put(external, '0/file', 'external');
  const outside = await put(temporary, 'outside/file', 'trusted outside hook target');
  const links = [
    [workspace, 'absolute', path.join(workspace, 'pkg/file')],
    [workspace, 'relative', 'pkg/file'],
    [workspace, 'root', '.'],
    [workspace, 'cross-absolute', path.join(external, '0/file')],
    [workspace, 'cross-relative', path.relative(workspace, path.join(external, '0/file'))],
    [external, 'back', path.join(workspace, 'pkg/file')],
    [workspace, 'dangling', 'pkg/not-created'],
    [workspace, 'dangling-external', path.join(external, '0/not-created')],
    [workspace, 'outside-absolute', outside],
    [workspace, 'outside-spelling', `${temporary}/outside/./file`],
    [workspace, 'outside-relative', path.relative(workspace, outside)],
    [workspace, 'outside-dangling', path.join(temporary, 'outside/missing')],
  ];
  for (const [root, name, target] of links) await fs.symlink(target, path.join(root, name));
  const handle = await store.capture({ workspace, external });
  assert.equal((await fs.readdir(path.join(directory, 'blobs'))).length, 2, 'outside link contents are not captured');
  const destination = restored(temporary, 1);
  await store.restore(handle, destination);
  const expected = {
    absolute: path.join(destination.workspace, 'pkg/file'), relative: 'pkg/file', root: '.',
    'cross-absolute': path.join(destination.external, '0/file'),
    'cross-relative': path.relative(destination.workspace, path.join(destination.external, '0/file')),
    dangling: 'pkg/not-created', 'dangling-external': path.join(destination.external, '0/not-created'),
    'outside-absolute': outside, 'outside-relative': path.relative(destination.workspace, outside),
    'outside-spelling': `${temporary}/outside/./file`,
    'outside-dangling': path.join(temporary, 'outside/missing'),
  };
  for (const [name, target] of Object.entries(expected)) {
    assert.equal((await fs.lstat(path.join(destination.workspace, name))).isSymbolicLink(), true);
    assert.equal(await fs.readlink(path.join(destination.workspace, name)), target);
  }
  assert.equal(await fs.readlink(path.join(destination.external, 'back')), path.join(destination.workspace, 'pkg/file'));
  assert.equal(await fs.readFile(path.join(destination.workspace, 'cross-relative'), 'utf8'), 'external');
  assert.equal(await fs.readFile(path.join(destination.workspace, 'outside-relative'), 'utf8'), 'trusted outside hook target');
  await assert.rejects(fs.stat(path.join(destination.workspace, 'dangling')), { code: 'ENOENT' });
});

await test('an absent optional external tree stays absent while its dangling links relocate', async t => {
  const { temporary, workspace, external, store } = await fixture(t);
  await fs.symlink(path.join(external, 'not-created'), path.join(workspace, 'link'));
  const handle = await store.capture({ workspace, external });
  await assert.rejects(store.restore(handle, { workspace: path.join(temporary, 'missing-mapping') }), /external root mapping/);
  const destination = restored(temporary, 1);
  await store.restore(handle, destination);
  await missing(destination.external);
  assert.equal(await fs.readlink(path.join(destination.workspace, 'link')), path.join(destination.external, 'not-created'));
});

await test('content is deduplicated across paths/checkpoints and every restored file is independent', async t => {
  const { temporary, workspace, directory, store } = await fixture(t);
  await put(workspace, 'a', 'shared bytes', 0o600);
  await put(workspace, 'b', 'shared bytes', 0o755);
  const [first, second] = await Promise.all([store.capture({ workspace }), store.capture({ workspace })]);
  assert.notEqual(first, second);
  const blobs = await fs.readdir(path.join(directory, 'blobs'));
  assert.equal(blobs.length, 1);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['blobs', 'manifests']);
  assert.equal(blobs[0], createHash('sha256').update('shared bytes').digest('hex'));
  assert.equal((await fs.lstat(directory)).mode & 0o777, 0o700);
  const blob = path.join(directory, 'blobs', blobs[0]);
  assert.equal((await fs.lstat(blob)).mode & 0o777, 0o400);
  for (const name of await fs.readdir(path.join(directory, 'manifests'))) {
    assert.equal((await fs.lstat(path.join(directory, 'manifests', name))).mode & 0o777, 0o400);
  }
  const one = restored(temporary, 1), two = restored(temporary, 2);
  await store.restore(first, one);
  await store.restore(second, two);
  const files = [path.join(workspace, 'a'), path.join(one.workspace, 'a'), path.join(one.workspace, 'b'), path.join(two.workspace, 'a'), blob];
  const infos = await Promise.all(files.map(file => fs.lstat(file)));
  assert.equal(new Set(infos.map(info => `${info.dev}:${info.ino}`)).size, files.length);
  for (const info of infos) assert.equal(info.nlink, 1);
  assert.equal((await fs.lstat(path.join(one.workspace, 'b'))).mode & 0o777, 0o755);
  await fs.writeFile(path.join(one.workspace, 'a'), 'changed restore');
  for (const file of files.filter(file => file !== path.join(one.workspace, 'a'))) assert.equal(await fs.readFile(file, 'utf8'), 'shared bytes');
  await put(workspace, 'c', 'new bytes');
  await store.capture({ workspace });
  assert.equal((await fs.readdir(path.join(directory, 'blobs'))).length, 2);
});

await test('the recorded digest describes the private copied bytes if source bytes change after copying', async t => {
  const { temporary, workspace, store } = await fixture(t);
  const source = await put(workspace, 'file', 'captured bytes');
  const copyFile = fs.copyFile;
  t.mock.method(fs, 'copyFile', async (...args) => {
    await copyFile(...args);
    if (args[0] === source) await fs.writeFile(source, 'new mutable source bytes');
  });
  const handle = await store.capture({ workspace });
  const destination = restored(temporary, 1);
  await store.restore(handle, destination);
  assert.equal(await fs.readFile(path.join(destination.workspace, 'file'), 'utf8'), 'captured bytes');
  assert.equal(await fs.readFile(source, 'utf8'), 'new mutable source bytes');
});

await test('corrupt, missing and nonregular blobs are rejected before restoration creates roots', async t => {
  for (const corruption of ['bytes', 'missing', 'symlink', 'directory']) {
    await t.test(corruption, async t => {
      const { temporary, workspace, store, directory } = await fixture(t);
      await put(workspace, 'file', 'valid');
      const handle = await store.capture({ workspace });
      const blob = path.join(directory, 'blobs', (await fs.readdir(path.join(directory, 'blobs')))[0]);
      if (corruption === 'bytes') {
        await fs.chmod(blob, 0o600);
        await fs.writeFile(blob, 'wrong');
      } else {
        await fs.rm(blob);
        if (corruption === 'symlink') await fs.symlink(path.join(workspace, 'file'), blob);
        if (corruption === 'directory') await fs.mkdir(blob);
      }
      const destination = restored(temporary, 1);
      await assert.rejects(store.restore(handle, destination));
      await missing(destination.workspace);
      await missing(destination.external);
      assert.equal(await fs.readFile(path.join(workspace, 'file'), 'utf8'), 'valid');
      if (corruption === 'bytes') {
        await assert.rejects(store.capture({ workspace }), /Corrupt checkpoint blob/);
        assert.equal((await fs.readdir(path.join(directory, 'manifests'))).length, 1);
      }
    });
  }
});

await test('manifest tampering, unsafe manifest paths, manifest symlinks and foreign handles are rejected', async t => {
  const { temporary, workspace, directory, store } = await fixture(t);
  await put(workspace, 'file', 'bytes');
  const handle = await store.capture({ workspace });
  const filename = path.join(directory, 'manifests', (await fs.readdir(path.join(directory, 'manifests')))[0]);
  const bytes = await fs.readFile(filename);
  const manifest = JSON.parse(bytes);
  manifest.roots.workspace[1].path = ['..', 'escaped'];
  await fs.chmod(filename, 0o600);
  await fs.writeFile(filename, JSON.stringify(manifest));
  const destination = restored(temporary, 1);
  await assert.rejects(store.restore(handle, destination), /Corrupt checkpoint manifest/);
  await missing(destination.workspace);
  await missing(path.join(temporary, 'escaped'));
  await fs.rm(filename);
  const outside = await put(temporary, 'outside-manifest', bytes);
  await fs.symlink(outside, filename);
  await assert.rejects(store.restore(handle, destination), /manifest file/);
  await assert.rejects(store.restore({}, destination), /Unknown checkpoint handle/);
  const other = new WorkspaceCheckpoints(path.join(temporary, 'other-store'));
  await assert.rejects(other.restore(handle, destination), /Unknown checkpoint handle/);
});

await test('unsafe/overlapping roots and occupied destinations never overwrite existing files', async t => {
  const { temporary, workspace, directory, store } = await fixture(t);
  await put(workspace, 'file', 'protected');
  const nestedStore = new WorkspaceCheckpoints(path.join(workspace, 'checkpoint-store'));
  await assert.rejects(nestedStore.capture({ workspace }), /must not overlap/);
  await missing(path.join(workspace, 'checkpoint-store'));
  await assert.rejects(store.capture({ workspace, external: workspace }), /must not overlap/);
  await missing(directory);
  const linked = path.join(temporary, 'linked-root');
  await fs.symlink(workspace, linked);
  await assert.rejects(store.capture({ workspace: linked }), /not a symlink/);
  const handle = await store.capture({ workspace });
  await assert.rejects(store.restore(handle, { workspace }), /fresh paths/);
  await assert.rejects(store.restore(handle, { workspace: linked }), /fresh paths/);
  const occupied = await put(temporary, 'occupied/keep', 'keep');
  await assert.rejects(store.restore(handle, { workspace: path.dirname(occupied) }), /fresh paths/);
  assert.equal(await fs.readFile(occupied, 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(workspace, 'file'), 'utf8'), 'protected');
  await assert.rejects(store.restore(handle, { workspace: path.join(directory, 'nested') }), /must not overlap/);
});

await test('unsupported special entries fail without publishing a manifest or leaving active work', async t => {
  const { workspace, directory, store } = await fixture(t);
  await put(workspace, 'a-file', 'copied before special entry');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path.join(workspace, 'socket'), resolve);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await assert.rejects(store.capture({ workspace }), /Unsupported special entry/);
  assert.deepEqual(await fs.readdir(path.join(directory, 'manifests')), []);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['blobs', 'manifests']);
  const before = await fs.readdir(path.join(directory, 'blobs'));
  await nextTurn();
  assert.deepEqual(await fs.readdir(path.join(directory, 'blobs')), before);
});

await test('pre-cancelled capture is lazy and does not create the store', async t => {
  const { workspace, directory, store } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.capture({ workspace }, { signal: controller.signal }), { name: 'AbortError' });
  await missing(directory);
});

await test('capture cancellation drains the active copy and removes temporary files before rejecting', async t => {
  const { workspace, directory, store } = await fixture(t);
  for (let index = 0; index < 8; index++) await put(workspace, String(index), 'bytes');
  const controller = new AbortController(), copyFile = fs.copyFile;
  let enter, release, settled = false, active = 0, peak = 0, started = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(fs, 'copyFile', async (...args) => {
    started++;
    peak = Math.max(peak, ++active);
    try { await copyFile(...args); enter(); await blocked; }
    finally { active--; }
  });
  const capture = store.capture({ workspace }, { signal: controller.signal });
  capture.then(() => { settled = true; }, () => { settled = true; });
  await entered;
  controller.abort();
  await nextTurn();
  assert.equal(settled, false);
  release();
  await assert.rejects(capture, { name: 'AbortError' });
  assert.equal(active, 0);
  assert.equal(peak, 1);
  assert.equal(started, 1);
  assert.deepEqual(await fs.readdir(path.join(directory, 'manifests')), []);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['blobs', 'manifests']);
  await nextTurn();
  assert.equal(started, 1);
});

await test('restore cancellation drains the active copy, removes partial roots and permits a later restore', async t => {
  const { temporary, workspace, store } = await fixture(t);
  await put(workspace, 'directory/a', 'a');
  await put(workspace, 'directory/b', 'b');
  const handle = await store.capture({ workspace });
  const controller = new AbortController(), copyFile = fs.copyFile;
  let enter, release, settled = false, active = 0, copies = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(fs, 'copyFile', async (...args) => {
    active++;
    copies++;
    try { await copyFile(...args); enter(); await blocked; }
    finally { active--; }
  });
  const destination = restored(temporary, 1);
  const restoring = store.restore(handle, destination, { signal: controller.signal });
  restoring.then(() => { settled = true; }, () => { settled = true; });
  await entered;
  controller.abort();
  await nextTurn();
  assert.equal(settled, false);
  release();
  await assert.rejects(restoring, { name: 'AbortError' });
  assert.equal(active, 0);
  assert.equal(copies, 1);
  await missing(destination.workspace);
  await nextTurn();
  assert.equal(copies, 1);
  t.mock.restoreAll();
  await store.restore(handle, destination);
  assert.equal(await fs.readFile(path.join(destination.workspace, 'directory/b'), 'utf8'), 'b');
});

await test('copy failure cleans partial restoration and leaves a reusable checkpoint', async t => {
  const { temporary, workspace, store } = await fixture(t);
  await put(workspace, 'a', 'bytes');
  const handle = await store.capture({ workspace });
  const destination = restored(temporary, 1);
  t.mock.method(fs, 'copyFile', async () => { throw new Error('fixture copy failure'); });
  await assert.rejects(store.restore(handle, destination), /fixture copy failure/);
  await missing(destination.workspace);
  t.mock.restoreAll();
  await store.restore(handle, destination);
  assert.equal(await fs.readFile(path.join(destination.workspace, 'a'), 'utf8'), 'bytes');
});

await test('relocation preserves parent traversal after a symlink for internal and cross-root targets', async t => {
  const { temporary, workspace, external, store } = await fixture(t);
  await put(workspace, 'real/deep/keep', 'deep');
  await put(workspace, 'real/result', 'correct internal result');
  await put(workspace, 'result', 'wrong lexical result');
  await put(external, 'real/deep/keep', 'external deep');
  await put(external, 'real/result', 'correct external result');
  await fs.symlink('real/deep', path.join(workspace, 'link'));
  await fs.symlink(path.join(external, 'real/deep'), path.join(workspace, 'cross-link'));
  await fs.symlink('link/../result', path.join(workspace, 'via'));
  await fs.symlink(path.join(workspace, 'cross-link') + '/../result', path.join(workspace, 'cross-via'));
  const before = await fs.readFile(path.join(workspace, 'via'), 'utf8');
  const handle = await store.capture({ workspace, external }), destination = restored(temporary, 7);
  await store.restore(handle, destination);
  assert.equal(await fs.readFile(path.join(destination.workspace, 'via'), 'utf8'), before);
  assert.equal(await fs.readlink(path.join(destination.workspace, 'via')), 'link/../result');
  assert.equal(await fs.readFile(path.join(destination.workspace, 'cross-via'), 'utf8'), 'correct external result');
});

await test('same-root restoration preserves link spelling, trailing directory checks and absent intermediate roots', async t => {
  const { temporary, workspace, external, store } = await fixture(t);
  await put(workspace, 'real/deep/keep', 'deep');
  await put(workspace, 'real/file', 'regular file');
  await put(workspace, 'file', 'must not become reachable');
  await fs.symlink('real/deep', path.join(workspace, 'link'));
  const targets = {
    trailing: 'link/../file/',
    absent: `../${path.basename(external)}/../${path.basename(workspace)}/file`,
  };
  for (const [name, target] of Object.entries(targets)) await fs.symlink(target, path.join(workspace, name));
  const check = async root => {
    await assert.rejects(fs.readFile(path.join(root, 'trailing')), { code: 'ENOTDIR' });
    await assert.rejects(fs.readFile(path.join(root, 'absent')), { code: 'ENOENT' });
  };
  await check(workspace);
  const handle = await store.capture({ workspace, external });
  await fs.rm(workspace, { recursive: true });
  await store.restore(handle, { workspace, external });
  await check(workspace);
  for (const [name, target] of Object.entries(targets)) assert.equal(await fs.readlink(path.join(workspace, name)), target);
  const destination = restored(temporary, 8);
  await store.restore(handle, destination);
  await check(destination.workspace);
});

await test('relocated links re-enter the relocated external root after traversing a symlink and parents', async t => {
  const { temporary, workspace, external, store } = await fixture(t);
  await put(workspace, 'real/deep/keep', 'deep');
  await put(external, 'file', 'external bytes');
  await fs.symlink('real/deep', path.join(workspace, 'link'));
  await fs.symlink(`link/../../../${path.basename(external)}/file`, path.join(workspace, 'via'));
  assert.equal(await fs.readFile(path.join(workspace, 'via'), 'utf8'), 'external bytes');
  const handle = await store.capture({ workspace, external });
  await fs.rm(workspace, { recursive: true });
  await fs.rm(external, { recursive: true });
  const destination = restored(temporary, 9);
  await store.restore(handle, destination);
  assert.equal(await fs.readFile(path.join(destination.workspace, 'via'), 'utf8'), 'external bytes');
});
