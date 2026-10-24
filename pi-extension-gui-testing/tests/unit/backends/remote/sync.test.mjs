/**
 * Remote workspace sync (spec §4.2a, §4.7): the streaming tar writer read
 * back by the system `tar`, the §4.7 file set sent over a loopback `ssh`
 * (secrets, dependency dirs, and outside links never leave; modes, unicode,
 * long names, inside links survive), incremental re-sync deletions limited to
 * the workspace, the rsync argv, method choice, and the helper deploy with
 * hash verification.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFileSet } from "../../../../src/sync/fileset.ts";
import { tarBuffer, tarStream } from "../../../../src/sync/transport/tar-stream.ts";
import { parseRsyncBytesSent, rsyncArgv, rsyncCanReach, WorkspaceSync } from "../../../../src/sync/transport/workspace-sync.ts";
import { SshTransport } from "../../../../src/transport/ssh/transport.ts";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";
import { createRemoteSessionDir, remoteSessionName } from "../../../../src/backends/remote/session-dir.ts";
import { deployFiles, deployHelper, parseSha256sum, toolingEntries } from "../../../../src/backends/remote/deploy.ts";
import { FakeSsh, loopbackSsh, parseSshArgv } from "../../transport/ssh/fake-ssh.mjs";

const LONG = `${"deep/".repeat(25)}file-with-a-long-name.txt`;

async function sandbox(t) {
  const root = await mkdtemp("/tmp/pgt-sync-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const lb = await loopbackSsh(root);
  const transport = new SshTransport({ destination: "loop", ssh: lb.ssh });
  const project = join(root, "project");
  await mkdir(project);
  const files = {
    "app.py": "print('hi')\n",
    "run.sh": "#!/bin/sh\necho run\n",
    "ünïcødé ✓.txt": "unicode\n",
    [LONG]: "long\n",
    ".env": "SECRET=1\n",
    "config/.env.local": "SECRET=2\n",
    "keys/id_rsa": "PRIVATE\n",
    "node_modules/pkg/index.js": "module.exports = 1\n",
    "src/lib.py": "x = 1\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(project, path, ".."), { recursive: true });
    await writeFile(join(project, path), content);
  }
  await chmod(join(project, "run.sh"), 0o755);
  await symlink("src/lib.py", join(project, "lib-link.py"));
  await symlink("/etc/passwd", join(project, "outside-link"));
  const remote = await createRemoteSessionDir(transport.runner, { name: remoteSessionName("gui-sync"), ownerLabel: "c:1:2:b", sessionId: "gui-sync", backend: "remote-linux" });
  return { root, lb, transport, project, remote, staging: join(root, "client-session", "sync") };
}

test("tarStream: PAX names, unicode, symlinks, modes, and dirs round-trip through the system tar", async (t) => {
  const dir = await mkdtemp("/tmp/pgt-tar-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = await tarBuffer([
    { path: "d", type: "dir", mode: 0o755 },
    { path: "d/x.sh", type: "file", mode: 0o755, data: Buffer.from("#!/bin/sh\n") },
    { path: LONG, type: "file", mode: 0o644, data: Buffer.from("long") },
    { path: "ünï ✓", type: "file", mode: 0o600, data: Buffer.alloc(1500, 65) },
    { path: "link", type: "symlink", mode: 0o777, linkTarget: `${"t/".repeat(60)}target` },
  ]);
  assert.equal(archive.length % 512, 0);
  const out = spawnSync("tar", ["-x", "-f", "-", "-C", dir], { input: archive });
  assert.equal(out.status, 0, String(out.stderr));
  assert.equal(await readFile(join(dir, LONG), "utf8"), "long");
  assert.equal((await readFile(join(dir, "ünï ✓"))).length, 1500);
  assert.equal(((await stat(join(dir, "d/x.sh"))).mode & 0o111) !== 0, true);
  assert.equal(await readlink(join(dir, "link")), `${"t/".repeat(60)}target`);
  await assert.rejects(tarBuffer([{ path: "../evil", type: "file", mode: 0o644, data: Buffer.alloc(0) }]), /unsafe archive path/);
  await assert.rejects(tarBuffer([{ path: "/abs", type: "file", mode: 0o644, data: Buffer.alloc(0) }]), /unsafe archive path/);
  const short = tarStream([{ path: "f", type: "file", mode: 0o644, size: 10, open: async () => [Buffer.from("abc")] }]);
  await assert.rejects(async () => { for await (const _ of short); }, /shrank/);
});

test("tar sync over ssh: the §4.7 file set arrives intact; secrets, deps, and outside links stay home", async (t) => {
  const s = await sandbox(t);
  const set = await buildFileSet(s.project);
  const sync = new WorkspaceSync({ transport: s.transport, stagingRoot: s.staging, remoteDir: s.remote.workspace, method: "tar" });
  const report = await sync.sync(set);
  assert.equal(report.method, "tar");
  assert.equal(report.files, set.entries.length);
  assert.ok(report.bytes > report.setBytes, "bytes sent = archive size");
  assert.equal(report.excluded, set.excluded.length);
  const ws = s.remote.workspace;
  assert.equal(await readFile(join(ws, "app.py"), "utf8"), "print('hi')\n");
  assert.equal(await readFile(join(ws, "ünïcødé ✓.txt"), "utf8"), "unicode\n");
  assert.equal(await readFile(join(ws, LONG), "utf8"), "long\n");
  assert.equal(((await stat(join(ws, "run.sh"))).mode & 0o111) !== 0, true, "executable bit kept");
  assert.equal(await readlink(join(ws, "lib-link.py")), "src/lib.py");
  for (const gone of [".env", "config/.env.local", "keys/id_rsa", "node_modules", "outside-link"]) await assert.rejects(lstat(join(ws, gone)), undefined, gone);
  await assert.rejects(stat(join(s.staging, "stage-1")), "staging is removed after the transfer");
});

test("re-sync removes files that left the set (only inside the workspace) and updates changed ones", async (t) => {
  const s = await sandbox(t);
  const sync = new WorkspaceSync({ transport: s.transport, stagingRoot: s.staging, remoteDir: s.remote.workspace, method: "tar" });
  await sync.sync(await buildFileSet(s.project));
  const outsideVictim = join(s.remote.dir, "tooling", "app.py");
  await writeFile(outsideVictim, "keep me");
  await unlink(join(s.project, "app.py"));
  await writeFile(join(s.project, "src/lib.py"), "x = 2\n");
  await unlink(join(s.project, "lib-link.py"));
  await writeFile(join(s.project, "lib-link.py"), "now a file\n");
  const report = await sync.sync(await buildFileSet(s.project));
  assert.equal(report.deleted, 2, "app.py and the link that became a file");
  await assert.rejects(lstat(join(s.remote.workspace, "app.py")));
  assert.equal(await readFile(join(s.remote.workspace, "src/lib.py"), "utf8"), "x = 2\n");
  assert.equal(await readFile(join(s.remote.workspace, "lib-link.py"), "utf8"), "now a file\n");
  assert.equal(await readFile(outsideVictim, "utf8"), "keep me");
});

test("rsync: --files-from with exactly the staged entries, -e with the session ssh options, no --delete", async (t) => {
  const s = await sandbox(t);
  const local = new FakeCommandRunner();
  let seen;
  local.on((argv) => argv[0] === "rsync", async (argv) => {
    const list = argv.find((a) => a.startsWith("--files-from=")).slice("--files-from=".length);
    seen = { argv, list: (await readFile(list, "utf8")).split("\0").filter(Boolean), stage: argv.at(-2) };
    seen.staged = await readFile(join(seen.stage, "app.py"), "utf8");
    return { stdout: "Number of files: 9\nTotal bytes sent: 1,234\nTotal bytes received: 56\n" };
  });
  const transport = new SshTransport({ destination: "loop", ssh: s.lb.ssh, control: { path: join(s.root, "ctl") } });
  const sync = new WorkspaceSync({ transport, stagingRoot: s.staging, remoteDir: s.remote.workspace, localRunner: local, method: "rsync" });
  const set = await buildFileSet(s.project);
  const report = await sync.sync(set);
  assert.equal(report.method, "rsync");
  assert.equal(report.bytes, 1234);
  assert.deepEqual(seen.list, set.entries.map((e) => e.path));
  assert.equal(seen.staged, "print('hi')\n", "rsync reads the checked staging copy, not the project");
  const argv = seen.argv;
  assert.ok(argv.includes("--from0") && argv.includes("--links") && argv.includes("--checksum") && argv.includes("--safe-links"));
  assert.equal(argv.some((a) => a.startsWith("--delete")), false);
  const rsh = argv[argv.indexOf("-e") + 1];
  const parsed = parseSshArgv(rsh.split(" "));
  assert.equal(parsed.options.BatchMode, "yes");
  assert.equal(parsed.options.ControlPath, join(s.root, "ctl"));
  assert.equal(argv.at(-1), `loop:${s.remote.workspace}/`);
  assert.equal(argv[argv.length - 3], "--");
});

test("auto method: tar when rsync is missing on either end or the destination is an ssh:// URI", async (t) => {
  const s = await sandbox(t);
  const noRsync = new FakeCommandRunner();
  const sync = new WorkspaceSync({ transport: s.transport, stagingRoot: s.staging, remoteDir: s.remote.workspace, localRunner: noRsync });
  await sync.sync(await buildFileSet(s.project));
  assert.equal(sync.method, "tar");
  assert.equal(rsyncCanReach("raspi5"), true);
  assert.equal(rsyncCanReach("pi@raspi5"), true);
  assert.equal(rsyncCanReach("ssh://pi@raspi5:2222"), false);
  assert.equal(parseRsyncBytesSent("Total bytes sent: 98,765"), 98765);
  assert.equal(parseRsyncBytesSent("nothing"), undefined);
  assert.throws(() => new WorkspaceSync({ transport: s.transport, stagingRoot: s.staging, remoteDir: "relative" }), /unsafe remote path/);
  assert.deepEqual(rsyncArgv({ listFile: "/l", stage: "/s", rsh: "ssh", destination: "h", remoteDir: "/r" }).slice(-3), ["--", "/s/", "h:/r/"]);
});

test("deployHelper copies the helper and smoke app into tooling/ and verifies every hash", async (t) => {
  const s = await sandbox(t);
  const result = await deployHelper(s.transport, s.remote.tooling);
  assert.ok(result.files > 5);
  const helper = await stat(join(s.remote.tooling, "helper"));
  assert.equal((helper.mode & 0o777).toString(8), "700", "umask 077 on the remote side");
  await stat(join(s.remote.tooling, "pi_gui_helper", "main.py"));
  await stat(join(s.remote.tooling, "testapps", "gtk3-smoke", "app.py"));
  const entries = await toolingEntries();
  assert.equal(entries.some((e) => e.path.includes("__pycache__") || e.path.endsWith(".pyc")), false);
});

test("deploy refuses files whose remote hash differs", async () => {
  const fake = new FakeSsh();
  fake.remote.on((argv) => argv[0] === "sha256sum", () => ({ stdout: `${"0".repeat(64)}  a.txt\n` }));
  const transport = new SshTransport({ destination: "h", runner: fake.runner, spawner: fake.spawner });
  await assert.rejects(deployFiles(transport, "/r/s-x/tooling", [{ path: "a.txt", type: "file", mode: 0o644, data: Buffer.from("a") }]), /differ from the package \(a\.txt\)/);
  assert.equal(parseSha256sum(`${"a".repeat(64)}  ./x\n${"b".repeat(64)} *y\n`).get("x"), "a".repeat(64));
});
