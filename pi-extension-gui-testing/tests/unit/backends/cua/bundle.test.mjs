/**
 * The workspace archive: the §4.7 file set (secrets excluded), links kept as
 * links, long paths through pax headers, modes kept, and a fail-closed read.
 * When a `tar` is on PATH the archive is also unpacked with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TarWriter, writeWorkspaceTar } from "../../../../src/backends/cua/bundle.ts";
import { listTar } from "../../../../src/backends/docker/tar.ts";
import { buildFileSet } from "../../../../src/sync/fileset.ts";

async function tree(t) {
  const root = await mkdtemp(join(tmpdir(), "gui-cua-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const long = "d".repeat(90);
  await mkdir(join(project, long, long, long), { recursive: true });
  await writeFile(join(project, "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(project, "run.sh"), 0o755); // independent of the test's umask
  await writeFile(join(project, long, long, long, "deep.txt"), "deep\n");
  await writeFile(join(project, ".env"), "SECRET=1\n");
  await mkdir(join(project, "keys"));
  await writeFile(join(project, "keys", "id_ed25519"), "private\n");
  await symlink("run.sh", join(project, "link.sh"));
  await symlink("/etc/passwd", join(project, "outside"));
  return { root, project, long };
}

test("the workspace archive holds the synced set only, with modes, links, and pax long paths", async (t) => {
  const { root, project, long } = await tree(t);
  const set = await buildFileSet(project);
  const dest = join(root, "w.tar");
  const summary = await writeWorkspaceTar(set, dest);
  assert.equal(summary.files, 3, "run.sh, deep.txt, link.sh");
  assert.equal(summary.bytes, 18 + 5);
  assert.ok(summary.excluded >= 3, ".env, the key, and the outside link are excluded");
  assert.equal((await stat(dest)).mode & 0o777, 0o600);
  const data = await readFile(dest);
  const entries = listTar(data);
  const names = entries.map((e) => e.path);
  assert.ok(!names.some((n) => n.includes(".env") || n.includes("id_ed25519") || n === "outside"), names.join(","));
  assert.ok(names.includes("PaxHeader"), "a pax header carries the long path");
  assert.equal(entries.find((e) => e.path === "run.sh").mode, 0o755);

  const tar = spawnSync("tar", ["--version"], { encoding: "utf8" });
  if (tar.error) return t.diagnostic("no tar on PATH; unpack check skipped");
  const out = join(root, "out");
  await mkdir(out);
  const result = spawnSync("tar", ["-x", "-f", dest, "-C", out], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(out, long, long, long, "deep.txt"), "utf8"), "deep\n");
  assert.equal(await readlink(join(out, "link.sh")), "run.sh");
  assert.equal((await stat(join(out, "run.sh"))).mode & 0o100, 0o100, "still executable (the extractor's umask may narrow the rest)");
});

test("a file that shrinks while archived fails the sync", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gui-cua-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "f");
  await writeFile(source, "abc");
  const out = await open(join(root, "x.tar"), "wx");
  const input = await open(source, "r");
  try {
    await assert.rejects(new TarWriter(out).file("f", input, 10, 0o644), /shrank/);
  } finally {
    await input.close();
    await out.close();
  }
  await assert.rejects(writeWorkspaceTar({ root, source: "walk", entries: [], excluded: [], bytes: 0 }, join(root, "x.tar")), /EEXIST/, "never overwrites");
});

test("unsafe archive paths are refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gui-cua-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = await open(join(root, "x.tar"), "wx");
  try {
    const tar = new TarWriter(out);
    await assert.rejects(tar.buffer("../evil", Buffer.from("x")), /unsafe tar path/);
    await assert.rejects(tar.buffer("/abs", Buffer.from("x")), /unsafe tar path/);
  } finally {
    await out.close();
  }
});
