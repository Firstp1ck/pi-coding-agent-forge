import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const aliases = ['workspace', 'external'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const overlaps = (left, right) => inside(left, right) || inside(right, left);
const parts = relative => relative === '' ? [] : relative.split(path.sep);
const safeParts = value => Array.isArray(value) && value.every(part => typeof part === 'string' &&
  part !== '' && part !== '.' && part !== '..' && !part.includes('\0') && !part.includes('/') &&
  !(path.sep === '\\' && (part.includes('\\') || part.includes(':'))) && !path.isAbsolute(part));
const cancelled = signal => signal?.throwIfAborted();
const safeLinkTail = value => Array.isArray(value) && value.every(part => typeof part === 'string' && part &&
  !part.includes('\0') && !part.includes('/') && !(path.sep === '\\' && (part.includes('\\') || part.includes(':'))));

// Keep link/.. spelling until traversal enters another captured root. Resolving
// that entry is necessary when the destination roots have different names.
async function linkAnchor(file, raw, roots) {
  const base = path.isAbsolute(raw) ? path.parse(raw).root : path.dirname(file);
  const components = (path.isAbsolute(raw) ? raw.slice(base.length) : raw).split(path.sep).filter(Boolean);
  let current = base, throughLink = false;
  let retained = { anchor: base, tail: components };
  for (let index = 0; index < components.length; index++) {
    const part = components[index];
    const next = part === '.' ? current : part === '..' ? path.dirname(current) : path.join(current, part);
    let info;
    try { info = await optionalStat(next); }
    catch (error) {
      if (['EACCES', 'ENOTDIR', 'ELOOP'].includes(error.code)) return retained;
      throw error;
    }
    const rootEntry = Object.values(roots).includes(next);
    if (rootEntry) retained = { anchor: next, tail: components.slice(index + 1) };
    if (!info) return retained;
    if (info.isSymbolicLink()) {
      throughLink = true;
      try {
        current = await fs.realpath(next);
        info = await fs.stat(next);
      } catch (error) {
        if (['ENOENT', 'EACCES', 'ENOTDIR', 'ELOOP'].includes(error.code)) return retained;
        throw error;
      }
    } else {
      current = next;
      if (!throughLink) retained = { anchor: current, tail: components.slice(index + 1) };
    }
    if (!info.isDirectory() && index < components.length - 1) return retained;
  }
  return retained;
}

async function optionalStat(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Canonical parents prevent aliases through ancestor symlinks from hiding overlap.
async function rootPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new TypeError('Checkpoint roots must be nonempty paths');
  const resolved = path.resolve(value);
  if (path.dirname(resolved) === resolved) throw new Error('Checkpoint roots cannot be filesystem roots');
  return path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved));
}

async function rootsFor(value, store) {
  const roots = { workspace: await rootPath(value.workspace) };
  if (value.external != null) roots.external = await rootPath(value.external);
  if (Object.values(roots).some(root => overlaps(store, root)) ||
      (roots.external && overlaps(roots.workspace, roots.external))) throw new Error('Checkpoint roots and store must not overlap');
  return roots;
}

async function hashFile(file, signal) {
  cancelled(signal);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Checkpoint blob is not a regular file');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    for (;;) {
      cancelled(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    cancelled(signal);
    return { digest: hash.digest('hex'), size };
  } finally { await handle.close(); }
}

async function verifyBlob(file, entry, signal) {
  const actual = await hashFile(file, signal);
  if (actual.digest !== entry.digest || actual.size !== entry.size) throw new Error('Corrupt checkpoint blob');
}

function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || typeof manifest.external !== 'boolean' || !manifest.roots ||
      !Array.isArray(manifest.roots.workspace) ||
      (manifest.roots.external !== null && !Array.isArray(manifest.roots.external)) ||
      (!manifest.external && manifest.roots.external !== null)) throw new Error('Invalid checkpoint manifest');
  for (const alias of aliases) {
    const entries = manifest.roots[alias];
    if (entries === null) continue;
    const seen = new Map();
    for (const entry of entries) {
      if (!entry || !safeParts(entry.path) || !['directory', 'file', 'link'].includes(entry.kind) ||
          !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777 ||
          !Number.isFinite(entry.atime) || !Number.isFinite(entry.mtime)) throw new Error('Unsafe checkpoint manifest entry');
      const key = JSON.stringify(entry.path), parent = JSON.stringify(entry.path.slice(0, -1));
      if (seen.has(key) || (entry.path.length ? seen.get(parent) !== 'directory' : seen.size !== 0 || entry.kind !== 'directory')) {
        throw new Error('Unsafe checkpoint manifest tree');
      }
      if (entry.kind === 'file' && (!/^[a-f0-9]{64}$/.test(entry.digest) || !Number.isSafeInteger(entry.size) || entry.size < 0)) {
        throw new Error('Invalid checkpoint file metadata');
      }
      if (entry.kind === 'link') {
        const link = entry.link;
        if (!link || typeof link.raw !== 'string' || !link.raw || link.raw.includes('\0') || typeof link.relative !== 'boolean' || !safeLinkTail(link.tail) || (link.root !== undefined
          ? !aliases.includes(link.root) || (link.root === 'external' && !manifest.external) || !safeParts(link.path)
          : typeof link.target !== 'string' || !path.isAbsolute(link.target) || link.target.includes('\0'))) {
          throw new Error('Unsafe checkpoint symlink metadata');
        }
      }
      seen.set(key, entry.kind);
    }
    if (seen.get('[]') !== 'directory') throw new Error('Missing checkpoint root');
  }
}

/** Private per-run checkpoints. Handles belong to this instance and never contain paths or file data. */
export class WorkspaceCheckpoints {
  #directory;
  #store;
  #handles = new WeakMap();
  #tail = Promise.resolve();

  constructor(directory) {
    if (typeof directory !== 'string' || !directory || directory.includes('\0')) throw new TypeError('Checkpoint store requires a directory');
    this.#directory = path.resolve(directory);
  }

  // One operation and one filesystem request at a time keeps I/O bounded and
  // leaves nothing in flight when cancellation/failure reaches the caller.
  #run(operation) {
    const task = this.#tail.then(operation);
    this.#tail = task.catch(() => {});
    return task;
  }

  async #initialize() {
    if (this.#store) return;
    const directory = await rootPath(this.#directory);
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || (info.mode & 0o077) || (await fs.readdir(directory)).length) {
        throw new Error('Checkpoint store must be a new or empty private directory');
      }
    }
    await fs.mkdir(path.join(directory, 'blobs'), { mode: 0o700 });
    await fs.mkdir(path.join(directory, 'manifests'), { mode: 0o700 });
    this.#store = directory;
  }

  async #captureFile(file, info, signal) {
    const temporary = path.join(this.#store, `capture-${randomUUID()}`);
    try {
      await fs.copyFile(file, temporary, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
      cancelled(signal);
      const after = await fs.lstat(file);
      if (!after.isFile() || after.dev !== info.dev || after.ino !== info.ino) throw new Error('Checkpoint source file changed during capture');
      // Hash the private copy, never a separate read of the mutable source.
      const content = await hashFile(temporary, signal);
      const blob = path.join(this.#store, 'blobs', content.digest);
      if (await optionalStat(blob)) await verifyBlob(blob, content, signal);
      else {
        await fs.chmod(temporary, 0o400);
        await fs.rename(temporary, blob);
      }
      return content;
    } finally { await fs.rm(temporary, { force: true }); }
  }

  capture(value, { signal } = {}) {
    return this.#run(async () => {
      cancelled(signal);
      const store = await rootPath(this.#directory), roots = await rootsFor(value, store);
      const manifest = { version: 1, external: !!roots.external, roots: { workspace: [], external: null } };
      await this.#initialize();
      for (const alias of aliases) {
        const root = roots[alias];
        if (!root) continue;
        const info = await optionalStat(root);
        if (alias === 'external' && !info) continue;
        if (!info?.isDirectory()) throw new Error('Checkpoint root must be a directory, not a symlink');
        const entries = manifest.roots[alias] = [], pending = [{ file: root, relative: [], info }];
        while (pending.length) {
          cancelled(signal);
          const current = pending.pop();
          const stat = current.info ?? await fs.lstat(current.file);
          const entry = { path: current.relative, mode: stat.mode & 0o7777, atime: stat.atimeMs / 1000, mtime: stat.mtimeMs / 1000 };
          if (stat.isDirectory()) {
            entry.kind = 'directory';
            for (const name of (await fs.readdir(current.file)).sort().reverse()) {
              pending.push({ file: path.join(current.file, name), relative: [...current.relative, name] });
            }
          } else if (stat.isFile()) {
            entry.kind = 'file';
            Object.assign(entry, await this.#captureFile(current.file, stat, signal));
          } else if (stat.isSymbolicLink()) {
            entry.kind = 'link';
            const raw = await fs.readlink(current.file);
            const { anchor, tail } = await linkAnchor(current.file, raw, roots);
            const mapped = aliases.find(name => roots[name] && inside(roots[name], anchor));
            entry.link = mapped
              ? { root: mapped, path: parts(path.relative(roots[mapped], anchor)), tail, relative: !path.isAbsolute(raw) }
              : path.isAbsolute(raw) ? { target: raw, tail: [], relative: false }
                : { target: anchor, tail, relative: true };
            entry.link.raw = raw;
          } else throw new Error('Unsupported special entry in checkpoint');
          entries.push(entry);
        }
      }
      validateManifest(manifest);
      cancelled(signal);
      const bytes = JSON.stringify(manifest), filename = path.join(this.#store, 'manifests', `${randomUUID()}.json`);
      try {
        await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o400 });
        cancelled(signal);
      } catch (error) {
        await fs.rm(filename, { force: true });
        throw error;
      }
      const handle = Object.freeze({});
      this.#handles.set(handle, { filename, digest: digest(bytes), roots });
      return handle;
    });
  }

  restore(handle, value, { signal } = {}) {
    return this.#run(async () => {
      cancelled(signal);
      const checkpoint = this.#handles.get(handle);
      if (!checkpoint) throw new Error('Unknown checkpoint handle');
      const roots = await rootsFor(value, this.#store);
      const originalRoots = aliases.every(alias => roots[alias] === checkpoint.roots[alias]);
      const manifestInfo = await fs.lstat(checkpoint.filename);
      if (!manifestInfo.isFile()) throw new Error('Invalid checkpoint manifest file');
      const bytes = await fs.readFile(checkpoint.filename);
      if (digest(bytes) !== checkpoint.digest) throw new Error('Corrupt checkpoint manifest');
      const manifest = JSON.parse(bytes);
      validateManifest(manifest);
      if (manifest.external && !roots.external) throw new Error('Restore requires the external root mapping');
      for (const root of Object.values(roots)) {
        if (await optionalStat(root)) throw new Error('Restore roots must be fresh paths');
      }
      const verified = new Set();
      for (const alias of aliases) {
        for (const entry of manifest.roots[alias] ?? []) {
          cancelled(signal);
          if (entry.kind !== 'file' || verified.has(entry.digest)) continue;
          await verifyBlob(path.join(this.#store, 'blobs', entry.digest), entry, signal);
          verified.add(entry.digest);
        }
      }
      const created = [], directories = [];
      try {
        for (const alias of aliases) {
          for (const entry of manifest.roots[alias] ?? []) {
            cancelled(signal);
            const file = path.join(roots[alias], ...entry.path);
            if (entry.kind === 'directory') {
              await fs.mkdir(file, { mode: 0o700 });
              if (!entry.path.length) created.push(file);
              directories.push([file, entry]);
            } else if (entry.kind === 'file') {
              await fs.copyFile(path.join(this.#store, 'blobs', entry.digest), file, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
              await verifyBlob(file, entry, signal);
              await fs.chmod(file, entry.mode);
              await fs.utimes(file, entry.atime, entry.mtime);
            } else {
              const anchor = entry.link.root ? path.join(roots[entry.link.root], ...entry.link.path) : entry.link.target;
              const prefix = entry.link.relative ? path.relative(path.dirname(file), anchor) : anchor;
              let target = entry.link.tail.length ? `${prefix}${prefix && !prefix.endsWith(path.sep) ? path.sep : ''}${entry.link.tail.join(path.sep)}` : prefix || '.';
              if (entry.link.raw.endsWith(path.sep) && !target.endsWith(path.sep)) target += path.sep;
              if (originalRoots) target = entry.link.raw;
              await fs.symlink(target, file);
              await fs.lutimes(file, entry.atime, entry.mtime);
            }
          }
        }
        for (const [file, entry] of [...directories].reverse()) {
          cancelled(signal);
          await fs.chmod(file, entry.mode);
          await fs.utimes(file, entry.atime, entry.mtime);
        }
        cancelled(signal);
      } catch (error) {
        // Final metadata may make directories unwritable, so reopen only the
        // directories we created before removing the incomplete restore.
        for (const [file] of directories) await fs.chmod(file, 0o700);
        for (const root of created) await fs.rm(root, { recursive: true, force: true });
        throw error;
      }
    });
  }
}
