import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';

/** Remove only owned scratch entries; retry restrictive directory modes without following links. */
export async function removeOwnedTree(root) {
  try { await rm(root, { recursive: true, force: true }); return; }
  catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }
  async function reopen(directory) {
    let info;
    try { info = await lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!info.isDirectory()) return;
    await chmod(directory, info.mode | 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await reopen(path.join(directory, entry.name));
    }
  }
  await reopen(root);
  await rm(root, { recursive: true, force: true });
}

async function optionalRead(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// A copied linked-worktree .git file would still direct hooks into live Git
// metadata. Materialize its common repository and private index/HEAD instead.
export async function isolateGit(source, destination, filter) {
  const sourceGit = path.join(source, '.git');
  let info;
  try { info = await lstat(sourceGit); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const destinationGit = path.join(destination, '.git');
  if (info.isFile()) {
    const match = /^gitdir:\s*(.+)\s*$/.exec(await readFile(sourceGit, 'utf8'));
    if (!match) throw new Error('Cannot isolate unrecognized Git metadata pointer');
    const privateGit = path.resolve(source, match[1].trim());
    const commonPointer = await optionalRead(path.join(privateGit, 'commondir'));
    const commonGit = commonPointer ? path.resolve(privateGit, commonPointer.trim()) : privateGit;
    await rm(destinationGit, { recursive: true, force: true });
    await cp(commonGit, destinationGit, {
      recursive: true, dereference: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE,
      filter: file => filter(file) && file !== path.join(commonGit, 'worktrees'),
    });
    if (commonGit !== privateGit) {
      for (const file of ['HEAD', 'index', 'config.worktree']) {
        if (await optionalRead(path.join(privateGit, file)) !== null) await cp(path.join(privateGit, file), path.join(destinationGit, file), { mode: constants.COPYFILE_FICLONE });
      }
    }
    for (const file of ['gitdir', 'commondir']) await rm(path.join(destinationGit, file), { force: true });
  }
  for (const filename of ['config', 'config.worktree']) {
    const config = await optionalRead(path.join(destinationGit, filename));
    if (config === null) continue;
    await writeFile(path.join(destinationGit, filename), `${config}\n[core]\n\tbare = false\n\tworktree = ${JSON.stringify(destination)}\n`);
  }
}

const contains = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

async function copyEntries(source, destination, filter) {
  const queue = [[source, destination]], active = new Set(), links = [], directories = [];
  let next = 0;
  async function copy(original, copied) {
    if (!await filter(original, copied)) return;
    const info = await lstat(original);
    if (info.isDirectory()) {
      await mkdir(copied, { recursive: true });
      directories.push([copied, info.mode]);
      for (const entry of await readdir(original)) queue.push([path.join(original, entry), path.join(copied, entry)]);
    } else if (info.isFile()) {
      if (original === source) await mkdir(path.dirname(copied), { recursive: true });
      await copyFile(original, copied, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
      await chmod(copied, info.mode);
      await utimes(copied, info.atime, info.mtime);
    } else {
      await cp(original, copied, { verbatimSymlinks: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE });
      if (info.isSymbolicLink()) links.push([original, copied]);
    }
  }
  try {
    while (next < queue.length || active.size) {
      while (next < queue.length && active.size < 16) {
        const entry = queue[next]; queue[next++] = undefined;
        const task = copy(...entry).finally(() => active.delete(task));
        active.add(task);
      }
      if (active.size) await Promise.race(active);
    }
  } catch (error) {
    // Cleanup must not race with copies that were already in flight.
    await Promise.allSettled(active);
    throw error;
  }
  return { links, directories };
}

// Keep symlinks as symlinks so npm's packlist sees the original file types.
// External targets live in a separate temporary snapshot, away from package files.
export async function snapshot(source, destination, { filter, externalRoot }, mappings = new Map()) {
  mappings.set(source, destination);
  const { links, directories } = await copyEntries(source, destination, filter);
  for (const [original, copied] of links) {
    const target = path.resolve(path.dirname(original), await readlink(copied));
    const mapping = [...mappings].find(([root]) => contains(root, target));
    let replacement;
    if (mapping) replacement = path.join(mapping[1], path.relative(mapping[0], target));
    else {
      await mkdir(externalRoot, { recursive: true });
      replacement = path.join(externalRoot, String(mappings.size));
      let canonical;
      try { canonical = await realpath(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (canonical) {
        const known = [...mappings].find(([root]) => contains(root, canonical));
        if (known) replacement = path.join(known[1], path.relative(known[0], canonical));
        else await snapshot(canonical, replacement, { filter, externalRoot }, mappings);
      }
    }
    await rm(copied);
    await symlink(replacement, copied, process.platform === 'win32' ? 'junction' : undefined);
  }
  for (const [directory, mode] of directories.reverse()) await chmod(directory, mode);
}
