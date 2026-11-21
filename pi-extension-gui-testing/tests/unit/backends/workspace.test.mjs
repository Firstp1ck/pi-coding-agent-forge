import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMountableRoot, assertNoSockets, projectRootProblem, scanForSockets, WorkspaceRefusedError } from "../../../src/backends/docker/workspace.ts";

const plain = { realpath: (p) => ({ "/var/run": "/run", "/home/u/link-to-home": "/home/u" })[p] ?? p, isSocket: () => false };

test("forbidden project roots: /, home, ancestors of home or of forbidden paths, symlinks to them", () => {
  for (const root of ["/", "/home/u", "/home", "/tmp", "/run", "/run/user", "/var", "/home/u/link-to-home", "/tmp/.X11-unix/sub", "/run/user/1000"]) {
    assert.ok(projectRootProblem(root, plain, "/home/u"), root);
  }
  for (const root of ["/home/u/project", "/srv/app", "/tmp/pi-gui-probe-x", "/run/user/1000/projects/app"]) {
    assert.equal(projectRootProblem(root, plain, "/home/u"), undefined, root);
  }
  assert.throws(() => assertMountableRoot("/home/u", plain, "/home/u"), (e) => e instanceof WorkspaceRefusedError && /home directory/.test(e.message) && /workspaceMode": "copy"/.test(e.message));
});

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "gui-ws-"));
  const servers = [];
  t.after(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const socket = async (rel) => {
    await mkdir(join(root, rel, ".."), { recursive: true });
    const server = createServer();
    await new Promise((r) => server.listen(join(root, rel), r));
    servers.push(server);
  };
  return { root, socket };
}

test("the socket scan walks the whole tree, including .git, node_modules, and virtualenvs, and refuses with the paths", async (t) => {
  const { root, socket } = await workspace(t);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.py"), "");
  assert.deepEqual((await assertNoSockets(root)).sockets, []);
  await socket(".git/fsmonitor--daemon.ipc");
  await socket("node_modules/pkg/s.sock");
  await socket(".venv/run/v.sock");
  await socket("venv/x.sock");
  const scan = await scanForSockets(root);
  assert.deepEqual(scan.sockets.sort(), [".git/fsmonitor--daemon.ipc", ".venv/run/v.sock", "node_modules/pkg/s.sock", "venv/x.sock"]);
  await assert.rejects(assertNoSockets(root), (e) => e instanceof WorkspaceRefusedError && /\.git\/fsmonitor--daemon\.ipc/.test(e.message) && /copy/.test(e.message));
});

test("the socket scan fails closed on a timeout and on an unreadable directory", async (t) => {
  const { root } = await workspace(t);
  await mkdir(join(root, "a", "b"), { recursive: true });
  let clock = 0;
  await assert.rejects(scanForSockets(root, { timeoutMs: 20_000, now: () => (clock += 15_000) }), (e) => e instanceof WorkspaceRefusedError && /did not finish within 20 s/.test(e.message));
  if (process.getuid?.() !== 0) {
    await mkdir(join(root, "locked"));
    await chmod(join(root, "locked"), 0);
    try {
      await assert.rejects(scanForSockets(root), (e) => e instanceof WorkspaceRefusedError && /cannot read locked/.test(e.message) && /EACCES/.test(e.message));
    } finally {
      await chmod(join(root, "locked"), 0o700);
    }
  }
});
