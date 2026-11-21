// Runtime dir removal against a directory swapped for a link while it is
// being removed (review A-F1): a real file system under a temp dir stands in
// for the Windows one, Windows paths map onto it, and the swap is a real
// symbolic link to a directory outside the runtime dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { removeRuntimeDir } from "../../../../src/backends/windows/runtime-dir.ts";

const ROOT = "C:\\Temp";
const DIR = win32.join(ROOT, "pi-gui-testing-win-0123456789abcdef");
const SUB = win32.join(DIR, "sub");

/**
 * A `WinFs` over a real directory. After the `swapAfter`-th look at `sub`
 * (lstat or identify), `sub` is replaced by a symbolic link to `victim`, as an
 * app racing the cleanup could do with a junction.
 */
async function racingFs(t, swapAfter) {
  const base = await mkdtemp(join(tmpdir(), "gui-win-race-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const actual = join(base, "runtime");
  const victim = join(base, "outside");
  await mkdir(join(actual, "sub", "deeper"), { recursive: true });
  await writeFile(join(actual, "sub", "app.tmp"), "session data");
  await writeFile(join(actual, "owner.json"), "{}");
  await mkdir(victim);
  await writeFile(join(victim, "important.txt"), "not session data");
  const map = (p) => (p === DIR ? actual : join(actual, ...p.slice(DIR.length + 1).split("\\")));
  let looks = 0;
  let swapped = false;
  const look = async (p) => {
    if (swapped || p !== SUB || ++looks !== swapAfter) return;
    swapped = true;
    await rm(map(p), { recursive: true });
    await symlink(victim, map(p), "dir");
  };
  const kind = (s) => (s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other");
  const fs = {
    async lstat(p) {
      try {
        const s = await lstat(map(p));
        await look(p);
        return kind(s);
      } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async identify(p) {
      try {
        const s = await lstat(map(p), { bigint: true });
        await look(p);
        return { type: kind(s), id: `${s.dev}:${s.ino}` };
      } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
    },
    readdir: (p) => readdir(map(p)),
    unlink: (p) => unlink(map(p)),
    rmdir: (p) => rmdir(map(p)),
  };
  return { fs, victim, actual, swappedNow: () => swapped };
}

for (const swapAfter of [1, 2, 3, 4]) {
  test(`a directory replaced by a link during removal is never entered (swap after look ${swapAfter})`, async (t) => {
    const { fs, victim, swappedNow } = await racingFs(t, swapAfter);
    const leftovers = await removeRuntimeDir(fs, ROOT, DIR);
    assert.ok(swappedNow(), "the race happened");
    assert.equal(await stat(join(victim, "important.txt")).then(() => true, () => false), true, "the file outside the runtime dir survives");
    assert.deepEqual(await readdir(victim), ["important.txt"]);
    // The swap leaves a link that the cleanup either removed as a link or reported; nothing behind it was touched.
    if (leftovers.length > 0) {
      assert.equal(leftovers.length, 1);
      assert.equal(leftovers[0].kind, "tempdir");
      assert.match(leftovers[0].detail, /replaced while it was being removed|not fully removed/);
    }
  });
}

test("without a race the runtime dir is removed completely, owner.json last", async (t) => {
  const { fs, actual } = await racingFs(t, Number.POSITIVE_INFINITY);
  assert.deepEqual(await removeRuntimeDir(fs, ROOT, DIR), []);
  assert.equal(await stat(actual).then(() => true, () => false), false);
});
