import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildFileSet } from "../../../src/sync/fileset.ts";
import { copyFileSet, SyncChangedError } from "../../../src/sync/copy.ts";
import { FakeCommandRunner } from "../../../src/runner/fake.ts";
import { compilePattern, secretMatch, inDependencyDir } from "../../../src/sync/patterns.ts";
import { createSpawnRunner } from "../../../src/runner/spawn.ts";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function tree(t, files) {
  const root = await mkdtemp(join(tmpdir(), "gui-fileset-"));
  const servers = [];
  t.after(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    await rm(root, { recursive: true, force: true });
  });
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    if (typeof content === "string") await writeFile(full, content);
    else if (content.link) await symlink(content.link, full);
    else if (content.socket) {
      const server = createServer();
      await new Promise((r) => server.listen(full, r));
      servers.push(server);
    } else if (content.fifo) execFileSync("mkfifo", [full]);
    else if (content.mode) {
      await writeFile(full, content.text ?? "");
      await chmod(full, content.mode);
    }
  }
  return root;
}

const FIXTURE = {
  "app.py": "print('hi')\n",
  "README.md": "# demo\n",
  "run.sh": { text: "#!/bin/sh\n", mode: 0o755 },
  "services/api/main.py": "x = 1\n",
  "services/api/.env": "TOKEN=secret\n",
  "services/api/.env.local": "TOKEN=secret\n",
  "fixtures/.ssh/key": "-----BEGIN KEY-----\n",
  "fixtures/.ssh/known_hosts": "host\n",
  "fixtures/data.json": "{}\n",
  "config/secrets.yaml": "a: b\n",
  "config/app.yaml": "a: b\n",
  "certs/server.pem": "cert\n",
  "keys/id_ed25519": "key\n",
  "home/.npmrc": "//registry/:_authToken=x\n",
  ".aws/credentials": "x\n",
  "node_modules/dep/index.js": "module.exports = 1\n",
  "link-ok": { link: "app.py" },
  "sub/link-up": { link: "../README.md" },
  "link-abs-inside": { link: "__ROOT__/config/app.yaml" },
  "link-ext": { link: "/etc/hosts" },
  "link-secret": { link: "services/api/.env" },
  "link-dangling": { link: "does-not-exist" },
  "dirlink": { link: "services" },
  "agent.sock": { socket: true },
  "pipe": { fifo: true },
};

async function fixture(t) {
  const files = { ...FIXTURE };
  const root = await tree(t, Object.fromEntries(Object.entries(files).filter(([k]) => k !== "link-abs-inside")));
  await symlink(join(root, "config", "app.yaml"), join(root, "link-abs-inside"));
  return root;
}

const reasons = (set) => Object.fromEntries(set.excluded.map((e) => [e.path, e.reason]));
const synced = (set) => set.entries.map((e) => e.path);

test("walk mode: nested secrets at any depth, special files, and links are excluded per spec §4.7", async (t) => {
  const root = await fixture(t);
  const set = await buildFileSet(root, {});
  assert.equal(set.source, "walk");
  const why = reasons(set);
  assert.equal(why["services/api/.env"], "secret");
  assert.equal(why["services/api/.env.local"], "secret");
  assert.equal(why["fixtures/.ssh/key"], "secret");
  assert.equal(why["fixtures/.ssh/known_hosts"], "secret", "a secret directory excludes its whole subtree");
  assert.equal(why["config/secrets.yaml"], "secret");
  assert.equal(why["certs/server.pem"], "secret");
  assert.equal(why["keys/id_ed25519"], "secret");
  assert.equal(why["home/.npmrc"], "secret");
  assert.equal(why[".aws/credentials"], "secret");
  assert.equal(why["link-ext"], "link-outside");
  assert.equal(why["link-secret"], "link-excluded");
  assert.equal(why["link-dangling"], "link-dangling");
  assert.equal(why["agent.sock"], "special");
  assert.equal(why["pipe"], "special");
  assert.ok(!synced(set).some((p) => p.startsWith("node_modules/")), "default ignore list outside Git");
  assert.deepEqual(synced(set), ["README.md", "app.py", "config/app.yaml", "dirlink", "fixtures/data.json", "link-abs-inside", "link-ok", "run.sh", "services/api/main.py", "sub/link-up"]);
  const byPath = Object.fromEntries(set.entries.map((e) => [e.path, e]));
  assert.equal(byPath["link-ok"].linkTarget, "app.py");
  assert.equal(byPath["sub/link-up"].linkTarget, "../README.md");
  assert.equal(byPath["link-abs-inside"].linkTarget, "config/app.yaml", "absolute targets inside the root become relative");
  assert.equal(byPath["dirlink"].linkTarget, "services");
  assert.equal(set.bytes, set.entries.filter((e) => e.type === "file").reduce((n, e) => n + e.size, 0));
});

test("sync.allow re-includes an always-excluded file; sync.deny beats sync.allow; nothing re-includes dependencies", async (t) => {
  const root = await fixture(t);
  const set = await buildFileSet(root, {
    allow: ["certs/server.pem", "fixtures/data.json", "fixtures/.ssh/known_hosts", "node_modules/**"],
    deny: ["fixtures/data.json", "*.sh", "/config/"],
  });
  const why = reasons(set);
  assert.ok(synced(set).includes("certs/server.pem"), "explicit allow");
  assert.ok(synced(set).includes("fixtures/.ssh/known_hosts"), "allow reaches into a secret dir for the listed path only");
  assert.equal(why["fixtures/.ssh/key"], "secret");
  assert.equal(why["fixtures/data.json"], "deny", "deny beats allow");
  assert.equal(why["run.sh"], "deny");
  assert.equal(why["config/app.yaml"], "deny");
  assert.equal(why["link-abs-inside"], "link-excluded", "a link to a denied file is dropped");
});

test("Git mode: tracked + untracked-not-ignored; a tracked dependency dir and a tracked secret stay excluded", { skip: hasGit ? false : "git not installed" }, async (t) => {
  const root = await tree(t, {
    "src/main.py": "1\n",
    "notes.txt": "untracked\n",
    "ignored.log": "x\n",
    ".gitignore": "*.log\n",
    "node_modules/pkg/index.js": "tracked dependency\n",
    "services/api/.env": "SECRET=1\n",
    "build/out.txt": "tracked build output\n",
  });
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q");
  git("add", "-f", "src/main.py", ".gitignore", "node_modules/pkg/index.js", "services/api/.env", "build/out.txt");
  await rm(join(root, "build", "out.txt"));
  const set = await buildFileSet(root, { runner: createSpawnRunner(), allow: ["node_modules/**"] });
  assert.equal(set.source, "git");
  assert.deepEqual(synced(set), [".gitignore", "notes.txt", "src/main.py"]);
  const why = reasons(set);
  assert.equal(why["node_modules/pkg/index.js"], "dependency");
  assert.equal(why["services/api/.env"], "secret");
  assert.equal(why["build/out.txt"], "missing", "tracked but deleted");
  assert.equal(why["ignored.log"], undefined, "ignored files are not in the file set at all");
});

test("copyFileSet reproduces the synced files and links (modes kept, special files absent) and reports counts", async (t) => {
  const root = await fixture(t);
  const set = await buildFileSet(root, {});
  const dest = join(await mkdtemp(join(tmpdir(), "gui-copy-")), "workspace");
  t.after(() => rm(dirname(dest), { recursive: true, force: true }));
  const summary = await copyFileSet(set, dest);
  assert.deepEqual(summary, { files: set.entries.length, bytes: set.bytes, excluded: set.excluded.length });
  assert.equal((await stat(dest)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(dest, "app.py"), "utf8"), "print('hi')\n");
  assert.equal((await stat(join(dest, "run.sh"))).mode & 0o777, 0o755);
  assert.equal(await readlink(join(dest, "sub/link-up")), "../README.md");
  assert.equal(await readFile(join(dest, "link-abs-inside"), "utf8"), "a: b\n", "link resolves inside the copy");
  assert.equal(await readFile(join(dest, "dirlink", "api", "main.py"), "utf8"), "x = 1\n");
  await assert.rejects(lstat(join(dest, "services/api/.env")));
  await assert.rejects(lstat(join(dest, "agent.sock")));
  await assert.rejects(lstat(join(dest, "link-ext")));
  const top = (await readdir(dest)).sort();
  assert.ok(!top.includes("node_modules") && !top.includes(".aws") && !top.includes("pipe"));
});

test("patterns: secret names at any depth, dependency dirs, gitignore-style allow/deny", () => {
  assert.equal(secretMatch("a/b/.env.production"), ".env*");
  assert.equal(secretMatch("x/.gnupg/pubring.kbx"), ".gnupg/");
  assert.equal(secretMatch("x/credentials.json"), "credentials*");
  assert.equal(secretMatch("docs/environment.md"), undefined);
  assert.equal(secretMatch("src/keyboard.py"), undefined);
  assert.ok(inDependencyDir("a/node_modules/b.js"));
  assert.ok(inDependencyDir("venv", true));
  assert.ok(!inDependencyDir("src/venv.py"));
  const anyDepth = compilePattern("*.log");
  assert.ok(anyDepth.test("a/b/c.log", false));
  const anchored = compilePattern("/build");
  assert.ok(anchored.test("build/x", false));
  assert.ok(!anchored.test("src/build/x", false));
  const dirOnly = compilePattern("cache/");
  assert.ok(dirOnly.test("a/cache/x", false));
  assert.ok(!dirOnly.test("a/cache", false));
  const globstar = compilePattern("docs/**/*.png");
  assert.ok(globstar.test("docs/a/b/c.png", false));
  assert.ok(globstar.test("docs/c.png", false));
  assert.throws(() => compilePattern("!keep.txt"), /negation is not supported/);
  assert.throws(() => compilePattern("  "), /empty/);
});

/** A runner whose `git ls-files` lists `paths` (NUL-separated), like Git with a stale index. */
function gitListing(paths) {
  return new FakeCommandRunner().on(/^git .* ls-files /, { stdout: paths.map((p) => `${p}\0`).join("") });
}

test("Z2: git ls-files runs with fsmonitor and hooks disabled and without optional locks", async (t) => {
  const root = await tree(t, { "a.txt": "a\n" });
  const runner = gitListing(["a.txt"]);
  await buildFileSet(root, { runner });
  const [call] = runner.calls;
  const argv = call.argv;
  assert.equal(argv[0], "git");
  const configs = argv.flatMap((a, i) => (argv[i - 1] === "-c" ? [a] : []));
  assert.ok(configs.includes("core.fsmonitor=false"), argv.join(" "));
  assert.ok(configs.includes("core.hooksPath=/dev/null"));
  assert.ok(argv.includes("--no-optional-locks"));
  assert.ok(argv.indexOf("-c") < argv.indexOf("ls-files") && argv.indexOf("-C") < argv.indexOf("ls-files"), "global options precede the subcommand");
  assert.equal(call.options.env.GIT_OPTIONAL_LOCKS, "0");
});

test("Z2: a repository-configured core.fsmonitor never runs during enumeration", { skip: hasGit ? false : "git not installed" }, async (t) => {
  const root = await tree(t, { "a.txt": "a\n" });
  const marker = join(root, "..", `fsmonitor-ran-${process.pid}-${Date.now()}`);
  t.after(() => rm(marker, { force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q");
  git("add", "a.txt");
  await writeFile(join(root, "hook.sh"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git("config", "core.fsmonitor", join(root, "hook.sh"));
  const set = await buildFileSet(root, { runner: createSpawnRunner() });
  assert.equal(set.source, "git");
  await assert.rejects(stat(marker), "the fsmonitor hook must not run");
});

test("Z3: a tracked path below a directory replaced by a symlink (outside, or to an excluded secret dir) is excluded, never read", async (t) => {
  const outside = await tree(t, { "app.txt": "OUTSIDE\n" });
  const root = await tree(t, { "ok.txt": "ok\n", ".ssh/notes.txt": "secret dir\n" });
  await symlink(outside, join(root, "cfg"));
  await symlink(".ssh", join(root, "cfg2"));
  const set = await buildFileSet(root, { runner: gitListing(["ok.txt", "cfg/app.txt", "cfg2/notes.txt", "../escape.txt", "a//b"]) });
  assert.deepEqual(synced(set), ["ok.txt"]);
  const why = reasons(set);
  assert.equal(why["cfg/app.txt"], "link-ancestor");
  assert.equal(why["cfg2/notes.txt"], "link-ancestor");
  assert.equal(why["../escape.txt"], "invalid");
  assert.equal(why["a//b"], "invalid");
  const dest = join(await mkdtemp(join(tmpdir(), "gui-copy-")), "workspace");
  t.after(() => rm(dirname(dest), { recursive: true, force: true }));
  await copyFileSet(set, dest);
  assert.deepEqual(await readdir(dest), ["ok.txt"]);
});

test("Z3: the copy re-checks each file: a parent swapped for a symlink, a file swapped for a symlink or another file all fail closed", async (t) => {
  const outside = await tree(t, { "app.txt": "OUTSIDE\n" });
  const cases = {
    "parent became a symlink": async (root) => {
      await rm(join(root, "cfg"), { recursive: true });
      await symlink(outside, join(root, "cfg"));
    },
    "file became a symlink": async (root) => {
      await rm(join(root, "cfg", "app.txt"));
      await symlink(join(outside, "app.txt"), join(root, "cfg", "app.txt"));
    },
    "file replaced": async (root) => {
      await rm(join(root, "cfg", "app.txt"));
      // File timestamps advance in coarse kernel ticks (a few ms): a replacement that reuses the inode within the
      // same tick is indistinguishable by dev:ino:birthtime (a documented residual), so wait past one tick.
      await new Promise((r) => setTimeout(r, 30));
      await writeFile(join(root, "cfg", "keep.txt"), "occupy the old inode\n");
      await writeFile(join(root, "cfg", "app.txt"), "NEW\n");
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const root = await tree(t, { "cfg/app.txt": "inside\n" });
    const set = await buildFileSet(root, {});
    assert.deepEqual(synced(set), ["cfg/app.txt"], name);
    await mutate(root);
    const dest = join(await mkdtemp(join(tmpdir(), "gui-copy-")), "workspace");
    t.after(() => rm(dirname(dest), { recursive: true, force: true }));
    await assert.rejects(copyFileSet(set, dest), (e) => e instanceof SyncChangedError && /cfg\/app\.txt changed/.test(e.message), name);
    await assert.rejects(readFile(join(dest, "cfg", "app.txt")), name);
  }
});

test("Z6: a directory link survives only when its target directory has synced files", async (t) => {
  const root = await tree(t, {
    "code/main.py": "x\n",
    "only-env/.env": "S=1\n",
    "code-link": { link: "code" },
    "env-link": { link: "only-env" },
    "empty-link": { link: "empty" },
  });
  await mkdir(join(root, "empty"));
  const set = await buildFileSet(root, {});
  assert.deepEqual(synced(set), ["code-link", "code/main.py"]);
  const why = reasons(set);
  assert.equal(why["env-link"], "link-excluded");
  assert.equal(why["empty-link"], "link-excluded");
});

test("Z3 (inode reuse): the file identity includes the birth time, so a replacement that reuses the inode number is refused; an in-place edit is not a replacement", async (t) => {
  const { fileIdentity } = await import("../../../src/sync/fileset.ts");
  assert.notEqual(fileIdentity({ dev: 1n, ino: 2n, birthtimeNs: 3n }), fileIdentity({ dev: 1n, ino: 2n, birthtimeNs: 4n }), "same dev and inode, another file");
  const root = await tree(t, { "cfg/app.txt": "inside\n" });
  const set = await buildFileSet(root, {});
  const entry = set.entries.find((e) => e.path === "cfg/app.txt");
  const info = await lstat(join(root, "cfg", "app.txt"), { bigint: true });
  assert.equal(entry.identity, `${info.dev}:${info.ino}:${info.birthtimeNs}`);
  await writeFile(join(root, "cfg", "app.txt"), "edited in place\n");
  const dest = join(await mkdtemp(join(tmpdir(), "gui-copy-")), "workspace");
  t.after(() => rm(dirname(dest), { recursive: true, force: true }));
  await copyFileSet(set, dest);
  assert.equal(await readFile(join(dest, "cfg", "app.txt"), "utf8"), "edited in place\n");
});
