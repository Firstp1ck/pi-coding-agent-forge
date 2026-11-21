import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeDepsKey, DepsKeyError, findKeyFiles } from "../../../src/deps/key.ts";

async function project(t, files) {
  const root = await mkdtemp(join(tmpdir(), "gui-deps-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const base = (projectRoot, extra = {}) => ({
  projectRoot,
  setup: ["pip install -r requirements.txt"],
  env: {},
  backend: "docker-linux",
  base: "image 0.1.0",
  targetOs: "linux",
  arch: "x86_64",
  platform: "Linux x86_64; glibc 2.36; debian 12; python 3.11.2",
  ...extra,
});

test("default key files: lockfiles and manifests at any depth, not in dependency or VCS dirs, no symlinks", async (t) => {
  const root = await project(t, {
    "requirements.txt": "a==1\n",
    "requirements-dev.txt": "b==1\n",
    "web/package-lock.json": "{}",
    "web/node_modules/x/package-lock.json": "{}",
    ".git/yarn.lock": "",
    "crate/Cargo.lock": "",
    "README.md": "",
  });
  await symlink(join(root, "requirements.txt"), join(root, "uv.lock"));
  assert.deepEqual(await findKeyFiles(root), ["crate/Cargo.lock", "requirements-dev.txt", "requirements.txt", "web/package-lock.json"]);
});

test("the key is stable for equal inputs and changes with a lockfile, setup, env, arch, base, platform, and backend", async (t) => {
  const root = await project(t, { "requirements.txt": "a==1\n", "web/package-lock.json": '{"v":1}' });
  const first = await computeDepsKey(base(root));
  assert.match(first.key, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.files, ["requirements.txt", "web/package-lock.json"]);
  assert.equal((await computeDepsKey(base(root))).key, first.key, "same inputs, same key");
  assert.equal((await computeDepsKey(base(root, { env: { B: "2", A: "1" } }))).key, (await computeDepsKey(base(root, { env: { A: "1", B: "2" } }))).key, "env order does not matter");

  const variants = [
    base(root, { setup: ["pip install -r requirements.txt", "npm ci"] }),
    base(root, { env: { PIP_INDEX_URL: "https://example.invalid/simple" } }),
    base(root, { arch: "aarch64" }),
    base(root, { base: "image 0.2.0" }),
    base(root, { platform: "Linux x86_64; glibc 2.39; ubuntu 24.04; python 3.12.3" }),
    base(root, { backend: "remote-linux-docker" }),
  ];
  for (const variant of variants) assert.notEqual((await computeDepsKey(variant)).key, first.key, JSON.stringify(variant));

  await writeFile(join(root, "web", "package-lock.json"), '{"v":2}');
  assert.notEqual((await computeDepsKey(base(root))).key, first.key, "a changed nested lockfile changes the key");
  await writeFile(join(root, "web", "package-lock.json"), '{"v":1}');
  assert.equal((await computeDepsKey(base(root))).key, first.key, "and changing it back restores the key");
  await writeFile(join(root, "poetry.lock"), "");
  assert.notEqual((await computeDepsKey(base(root))).key, first.key, "a new lockfile changes the key");
});

test("deps.keyFiles replaces the defaults (gitignore-style patterns)", async (t) => {
  const root = await project(t, { "requirements.txt": "a\n", "deps/list.txt": "x\n", "other/list.txt": "y\n" });
  const custom = await computeDepsKey(base(root, { keyFiles: ["/deps/list.txt"] }));
  assert.deepEqual(custom.files, ["deps/list.txt"]);
  await writeFile(join(root, "requirements.txt"), "changed\n");
  assert.equal((await computeDepsKey(base(root, { keyFiles: ["/deps/list.txt"] }))).key, custom.key, "files outside deps.keyFiles do not count");
  await writeFile(join(root, "deps", "list.txt"), "changed\n");
  assert.notEqual((await computeDepsKey(base(root, { keyFiles: ["/deps/list.txt"] }))).key, custom.key);
  assert.deepEqual((await computeDepsKey(base(root, { keyFiles: ["list.txt"] }))).files, ["deps/list.txt", "other/list.txt"]);
  await assert.rejects(computeDepsKey(base(root, { keyFiles: ["!negated"] })), DepsKeyError);
});
