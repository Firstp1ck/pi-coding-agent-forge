import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { DockerLinuxBackend } from "../../../src/backends/docker-linux.ts";
import { SessionError } from "../../../src/backend.ts";
import { WorkspaceRefusedError } from "../../../src/backends/docker/workspace.ts";
import { auditDockerOrphans, sweepDockerOrphans, listLabelledObjects } from "../../../src/backends/docker/footprint.ts";
import { addContainer, BOOT, fakeDocker, fakeProc, fakeSpawner, HOST, NO_ANSWER, parseRunArgv } from "./fakes.mjs";

function config(shared = {}) {
  return {
    shared: { targets: ["linux"], workspaceMode: "mount", network: "default", ...shared },
    limits: { maxConcurrentSessions: 2, idleTimeoutMinutes: 15 },
    usageCheck: { warnSessionCostUsd: 1, warnDailyCostUsd: 5 },
    keepSandbox: false,
    warnings: [],
  };
}

async function setup(t, { behaviour = {}, docker = {}, backendOptions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gui-session-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const sessionDir = join(root, "session");
  await mkdir(project);
  await mkdir(sessionDir, { mode: 0o700 });
  await writeFile(join(project, "app.py"), "print(1)\n");
  const { runner, state } = fakeDocker(docker);
  const spawner = fakeSpawner({
    ...behaviour,
    onSpawn(child) {
      addContainer(state, child.argv, child.env);
      const name = parseRunArgv(child.argv).one("--name");
      // --rm: the container disappears when the helper exits.
      void child.exited.then(() => state.containers.delete(name));
      behaviour.onSpawn?.(child, state);
    },
  });
  const backend = new DockerLinuxBackend({ ownerLabel: () => "c1:100:5000:boot", runner, spawner, version: "0.1.0", endpointSource: {}, uid: 4321, gid: 8765, ...backendOptions });
  const recorded = [];
  const logs = [];
  const status = [];
  const start = (shared, extra = {}) =>
    backend.startSession({
      sessionId: "gui-test0001",
      projectRoot: project,
      sessionDir,
      config: config(shared),
      ownerLabel: "c1:100:5000:boot",
      recordResource: async (kind, id) => void recorded.push({ kind, id, spawnedBefore: spawner.children.length }),
      onLog: (e) => logs.push(e),
      onStatus: (s) => status.push(s),
      signal: new AbortController().signal,
      ...extra,
    });
  return { root, project, sessionDir, runner, state, spawner, backend, recorded, logs, status, start };
}

test("mount mode: container recorded before it exists, read-only workspace, identity files, hello, requests, idempotent stop with empty audit", async (t) => {
  const s = await setup(t);
  const session = await s.start({});
  assert.deepEqual(s.recorded, [{ kind: "container", id: "pi-gui-testing-gui-test0001", spawnedBefore: 0 }]);
  const child = s.spawner.children[0];
  const p = parseRunArgv(child.argv);
  assert.deepEqual(child.argv.slice(0, 3), ["docker", "--host", HOST]);
  assert.ok(p.all("-v").includes(`${s.project}:/workspace:ro`));
  assert.match(child.env.PI_GUI_TESTING_TOKEN, /^[0-9a-f]{32}$/);
  assert.ok(!child.argv.join(" ").includes(child.env.PI_GUI_TESTING_TOKEN), "token never in argv");
  assert.equal(await readFile(join(s.sessionDir, "passwd"), "utf8"), "root:x:0:0:root:/root:/usr/sbin/nologin\napp:x:4321:8765:app:/home/app:/bin/sh\n");
  assert.equal(session.arch, "x86_64");
  assert.equal(child.requests[0].method, "hello");
  assert.equal(child.requests[0].params.packageVersion, "0.1.0");
  assert.ok(s.runner.commands().some((c) => c.endsWith("container inspect pi-gui-testing-gui-test0001")), "inspected after start");

  const snap = await session.request("snapshot", { maxNodes: 10 });
  assert.equal(snap.coverage, "full");
  const first = session.stop();
  assert.equal(session.stop(), first, "stop is idempotent");
  assert.deepEqual(await first, []);
  assert.ok(child.requests.some((r) => r.method === "stop"));
  assert.equal(child.running(), false);
  assert.deepEqual(await session.auditFootprint(), []);
  await assert.rejects(session.request("windows", {}), (e) => e instanceof SessionError && e.code === "CLOSED");
});

test("protocol errors map to SessionError codes; a dead container fails later requests with CLOSED", async (t) => {
  const s = await setup(t, {
    behaviour: {
      handlers: {
        act: () => ({ error: { code: "STALE_REF", message: "stale ref, take a new snapshot" } }),
        launch: () => ({ error: { code: "HANDOFF", message: "app exited without opening a window" } }),
      },
    },
  });
  const session = await s.start({});
  await assert.rejects(session.request("act", { ref: "s0:1", action: "click" }), (e) => e instanceof SessionError && e.code === "STALE_REF" && /stale ref/.test(e.message));
  await assert.rejects(session.request("launch", { cmd: "x", args: [], env: {}, cwd: "/workspace" }), (e) => e instanceof SessionError && e.code === "HANDOFF");
  s.spawner.children[0].exit(137);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(session.request("windows", {}), (e) => e instanceof SessionError && e.code === "CLOSED" && /container ended/.test(e.message));
  assert.deepEqual(await session.stop(), []);
});

test("A5-F1/F2: cut helper texts and errors do not keep their oversized originals alive", async (t) => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc");
  const MiB = 1024 * 1024;
  const heap = () => (gc(), gc(), process.memoryUsage().heapUsed);
  const s = await setup(t, {
    behaviour: {
      handlers: {
        act: () => ({ error: { code: "E".repeat(MiB), message: "m".repeat(4 * MiB) } }),
        windows: () => ({ windows: [{ ref: "win:0x1", title: "t".repeat(4 * MiB), bounds: { x: 0, y: 0, width: 10, height: 10 } }] }),
      },
    },
  });
  const session = await s.start({});
  const before = heap();
  const kept = [];
  for (let i = 0; i < 20; i++) {
    kept.push(await session.request("windows", {}));
    kept.push(await session.request("act", { ref: "s0:1", action: "click" }).catch((e) => e));
    await new Promise((r) => setImmediate(r));
  }
  const retained = heap() - before;
  assert.ok(kept.filter((k) => k instanceof SessionError).every((e) => e.code.length <= 64 && e.message.length <= 4_097), "errors cut");
  assert.ok(kept.filter((k) => !(k instanceof SessionError)).every((r) => r.windows[0].title.length <= 65_537), "titles cut");
  // Slices would pin 20 × (4 MiB title + 5 MiB error); owned copies keep about 20 × 70 KiB.
  assert.ok(retained < 24 * MiB, `retained ${(retained / MiB).toFixed(1)} MiB`);
  await session.stop();
});

test("a timed-out request is cancelled and reported as TIMEOUT", async (t) => {
  const s = await setup(t, { behaviour: { handlers: { wait: () => NO_ANSWER } } });
  const session = await s.start({});
  await assert.rejects(session.request("wait", { for: "idle", timeoutMs: 10 }, { timeoutMs: 30 }), (e) => e instanceof SessionError && e.code === "TIMEOUT");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(s.spawner.children[0].requests.some((r) => r.method === "cancel"));
  await session.stop();
});

test("start fails closed: isolation violation, missing ready line, unspawnable docker; nothing stays running", async (t) => {
  let s = await setup(t, {
    behaviour: {
      onSpawn(child, state) {
        const name = parseRunArgv(child.argv).one("--name");
        state.containers.get(name).inspect.HostConfig.Privileged = true;
      },
    },
  });
  await assert.rejects(s.start({}), (e) => e instanceof SessionError && e.code === "ISOLATION" && /privileged/.test(e.message));
  assert.equal(s.spawner.children[0].running(), false);
  assert.equal(s.state.containers.size, 0);

  s = await setup(t, { behaviour: { noReady: true }, backendOptions: { readyTimeoutMs: 40 } });
  await assert.rejects(s.start({}), (e) => e instanceof SessionError && e.code === "TIMEOUT" && /ready line/.test(e.message));
  assert.equal(s.spawner.children[0].running(), false);

  s = await setup(t, { behaviour: { spawnError: true } });
  await assert.rejects(s.start({}), (e) => e instanceof SessionError && /cannot start docker|START_FAILED|CLOSED/.test(`${e.code} ${e.message}`));
});

test("setup commands run in the session as exec with the deps env; a failure stops the session with the output tail", async (t) => {
  let s = await setup(t);
  const ok = await s.start({ setup: ["pip install -r requirements.txt"], deps: { env: { PIP_INDEX_URL: "http://mirror" } } });
  const exec = s.spawner.children[0].requests.find((r) => r.method === "exec" && r.params.cwd === "/workspace");
  assert.deepEqual(exec.params, { cmd: "pip install -r requirements.txt", cwd: "/workspace", env: { PIP_INDEX_URL: "http://mirror" }, timeoutMs: 15 * 60_000 });
  assert.ok(s.logs.some((l) => l.source === "setup" && /ran pip install/.test(l.data)));
  assert.ok(s.status.some((x) => /setup 1\/1/.test(x)));
  await ok.stop();

  s = await setup(t, { behaviour: { handlers: { exec: (params, child) => (params.cmd.startsWith("[") ? { exitCode: 0, elapsedMs: 1 } : (child.log("setup", "stderr", "EROFS: read-only file system\n"), { exitCode: 2, elapsedMs: 3 })) } } });
  await assert.rejects(s.start({ setup: ["npm install"] }), (e) => e instanceof SessionError && e.code === "SETUP_FAILED" && /exited with 2/.test(e.message) && /EROFS/.test(e.message) && /workspaceMode": "copy"/.test(e.message));
  assert.equal(s.spawner.children[0].running(), false);
});

test("mount mode refuses a workspace with a socket before any container starts", async (t) => {
  const s = await setup(t);
  const server = createServer();
  await new Promise((r) => server.listen(join(s.project, "dev.sock"), r));
  t.after(() => new Promise((r) => server.close(r)));
  await assert.rejects(s.start({}), (e) => e instanceof WorkspaceRefusedError && /dev\.sock/.test(e.message));
  assert.equal(s.spawner.children.length, 0);
  assert.deepEqual(s.recorded, []);
});

test("copy mode mounts a filtered, writable copy from the session dir and reports the sync summary", async (t) => {
  const s = await setup(t);
  await writeFile(join(s.project, ".env"), "SECRET=1\n");
  const session = await s.start({ workspaceMode: "copy" });
  const binds = parseRunArgv(s.spawner.children[0].argv).all("-v");
  assert.ok(binds.includes(`${join(s.sessionDir, "workspace")}:/workspace:rw`));
  assert.equal(await readFile(join(s.sessionDir, "workspace", "app.py"), "utf8"), "print(1)\n");
  await assert.rejects(stat(join(s.sessionDir, "workspace", ".env")));
  assert.deepEqual(session.sync, { files: 1, bytes: 9, excluded: 1 });
  await session.stop();
});

test("Electron launches get --shm-size 512m; shm: never (tests) and the heartbeat test override", async (t) => {
  let s = await setup(t);
  let session = await s.start({ launch: { cmd: "./node_modules/.bin/electron", args: [".", "--no-sandbox"] } });
  assert.equal(parseRunArgv(s.spawner.children[0].argv).one("--shm-size"), "512m");
  await session.stop();
  s = await setup(t, { backendOptions: { shm: "never", heartbeatTimeoutMs: 3000 } });
  session = await s.start({ launch: { cmd: "./node_modules/.bin/electron", args: ["."] } });
  const p = parseRunArgv(s.spawner.children[0].argv);
  assert.equal(p.one("--shm-size"), undefined);
  assert.ok(p.all("-e").includes("PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS=3000"));
  await session.stop();
});

test("stop reports leftovers the helper could not kill and removes a container that outlived the helper", async (t) => {
  const s = await setup(t, {
    behaviour: { handlers: { stop: () => ({ ok: false, leftovers: [{ kind: "process", id: "123", detail: "sleep" }] }) } },
  });
  const session = await s.start({});
  // A stray labelled object of this session (e.g. a network) is removed by the client too.
  s.state.containers.set("stray", { id: "stray-id", session: "gui-test0001", owner: "c1:100:5000:boot", inspect: {} });
  const leftovers = await session.stop();
  assert.deepEqual(leftovers, [{ kind: "process", id: "123", detail: "inside the container: sleep" }]);
  assert.ok(s.state.removed.includes("stray-id"));
});

test("orphan audit and sweep remove only objects of dead owners; unparseable owners are reported, live owners untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gui-footprint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  fakeProc(root, { 100: 5000 });
  const { runner, state } = fakeDocker();
  const add = (name, owner) => state.containers.set(name, { id: `id-${name}`, session: name, owner, inspect: {} });
  add("live", `c1:100:5000:${BOOT}`);
  add("reused-pid", `c2:100:4999:${BOOT}`);
  add("gone-pid", `c3:200:1:${BOOT}`);
  add("other-boot", "c4:100:5000:00000000-0000-0000-0000-000000000000");
  add("legacy", "w2test:100:host");
  const endpoint = { context: "default", host: HOST };
  const listed = await listLabelledObjects(runner, endpoint);
  assert.equal(listed.filter((o) => o.kind === "container").length, 5);
  const audit = await auditDockerOrphans(runner, endpoint, { procRoot: root });
  assert.deepEqual(audit.map((l) => l.id).sort(), ["gone-pid", "legacy", "other-boot", "reused-pid"]);
  assert.match(audit.find((l) => l.id === "legacy").detail, /cannot be judged/);
  const leftovers = await sweepDockerOrphans(runner, endpoint, { procRoot: root });
  assert.deepEqual(state.removed.sort(), ["id-gone-pid", "id-other-boot", "id-reused-pid"]);
  assert.deepEqual([...state.containers.keys()].sort(), ["legacy", "live"]);
  assert.deepEqual(leftovers.map((l) => l.id), ["legacy"]);
});

const identityOf = async (path) => {
  const info = await stat(path, { bigint: true });
  return `${info.dev} ${info.ino}`;
};

test("Z4: mount mode mounts the resolved path and checks /workspace's device/inode in the container before setup or the app", async (t) => {
  const s = await setup(t);
  const viaLink = join(s.root, "project-link");
  await symlink(s.project, viaLink);
  const session = await s.start({ setup: ["make deps"] }, { projectRoot: viaLink });
  const child = s.spawner.children[0];
  const real = await realpath(s.project);
  assert.ok(parseRunArgv(child.argv).all("-v").includes(`${real}:/workspace:ro`), "Docker gets the resolved path, never the link");
  const execs = child.requests.filter((r) => r.method === "exec");
  assert.equal(execs.length, 2);
  assert.equal(execs[0].params.cwd, "/");
  assert.equal(execs[0].params.cmd, `[ "$(stat -c '%d %i' /workspace)" = '${await identityOf(real)}' ]`);
  assert.equal(execs[1].params.cmd, "make deps", "setup runs only after the identity check");
  await session.stop();
});

test("Z4: a /workspace with another device/inode stops the session and fails closed before setup runs", async (t) => {
  const s = await setup(t, { behaviour: { handlers: { exec: (params) => ({ exitCode: params.cmd.startsWith("[") ? 1 : 0, elapsedMs: 1 }) } } });
  await assert.rejects(s.start({ setup: ["make deps"] }), (e) => e instanceof SessionError && e.code === "ISOLATION" && /not the one that was checked/.test(e.message));
  const child = s.spawner.children[0];
  assert.equal(child.running(), false, "session stopped");
  assert.deepEqual(child.requests.filter((r) => r.method === "exec").map((r) => r.params.cwd), ["/"], "no setup command ran");
  assert.equal(s.state.containers.size, 0);
});

test("Z4: the running-container inspect refuses a /workspace bound from anything but the checked path", async (t) => {
  const s = await setup(t, {
    behaviour: {
      onSpawn(child, state) {
        const container = [...state.containers.values()].at(-1);
        container.inspect.Mounts = container.inspect.Mounts.map((m) => (m.Destination === "/workspace" ? { ...m, Source: "/home/someone" } : m));
      },
    },
  });
  await assert.rejects(s.start({}), (e) => e instanceof SessionError && e.code === "ISOLATION" && /workspace: \/workspace is bound from \/home\/someone/.test(e.message));
  assert.equal(s.spawner.children[0].running(), false);
});

test("Z4: copy mode verifies the copy's identity the same way", async (t) => {
  const s = await setup(t);
  const session = await s.start({ workspaceMode: "copy" });
  const copy = join(await realpath(s.sessionDir), "workspace");
  const [check] = s.spawner.children[0].requests.filter((r) => r.method === "exec");
  assert.match(check.params.cmd, new RegExp(`= '${await identityOf(copy)}' \\]$`));
  await session.stop();
});

test("Z5: a failed stop is not cached; the next stop retries and succeeds", async (t) => {
  let failRemove = true;
  const s = await setup(t, { behaviour: { handlers: { stop: () => ({ ok: true, leftovers: [] }) } } });
  const session = await s.start({});
  // The container outlives the helper (e.g. the daemon was busy) and the first rm fails.
  s.state.containers.set("pi-gui-testing-gui-test0001-stuck", { id: "id-stuck", session: "gui-test0001", owner: "c1:100:5000:boot", inspect: {} });
  s.runner.on(/ rm -f id-stuck$/, () => (failRemove ? { exitCode: 1, stderr: "Error: removal in progress" } : (s.state.containers.delete("pi-gui-testing-gui-test0001-stuck"), {})));
  const first = await session.stop();
  assert.equal(first.length, 1, JSON.stringify(first));
  await assert.rejects(session.request("windows", {}), (e) => e.code === "CLOSED", "no requests after the first stop");
  failRemove = false;
  assert.deepEqual(await session.stop(), [], "retried");
  assert.deepEqual(await session.auditFootprint(), []);
  const calls = s.runner.commands().filter((c) => c.endsWith("rm -f id-stuck")).length;
  assert.deepEqual(await session.stop(), []);
  assert.equal(s.runner.commands().filter((c) => c.endsWith("rm -f id-stuck")).length, calls, "a clean stop is final");
});

test("Z1: helper results are validated per method before use", async (t) => {
  const s = await setup(t, {
    behaviour: {
      handlers: {
        snapshot: () => ({ snapshotId: "../../etc/x", coverage: "full", tree: "not-an-array", truncated: false }),
        screenshot: () => ({ captureId: "c1", target: "screen", origin: { x: 0, y: 0 }, width: 10, height: 10, scale: 1, png_base64: "bm90IGEgcG5n", sha256: "x" }),
        windows: () => ({ windows: [{ ref: "win:0x1", title: 7, bounds: { x: 0, y: 0, width: 1, height: 1 } }] }),
        wait: () => ({ matched: "yes", elapsedMs: 1 }),
      },
    },
  });
  const session = await s.start({});
  await assert.rejects(session.request("snapshot", { maxNodes: 5 }), (e) => e.code === "BAD_RESPONSE" && /tree is not an array/.test(e.message));
  await assert.rejects(session.request("screenshot", {}), (e) => e.code === "BAD_RESPONSE" && /not a PNG/.test(e.message));
  await assert.rejects(session.request("windows", {}), (e) => e.code === "BAD_RESPONSE" && /windows\[0\]\.title is not a string/.test(e.message));
  await assert.rejects(session.request("wait", { for: "idle", timeoutMs: 1 }), (e) => e.code === "BAD_RESPONSE" && /matched is not a boolean/.test(e.message));
  await session.stop();
});

test("Q4: accessibility bounds use AT-SPI's range and invalid ones are dropped per node; window geometry uses X11's range", async (t) => {
  const node = (i, extra) => ({ ref: `s1:${i}`, role: "push button", name: `b${i}`, states: ["showing"], ...extra });
  const s = await setup(t, {
    behaviour: {
      handlers: {
        snapshot: () => ({
          snapshotId: "s1",
          coverage: "full",
          truncated: false,
          tree: [
            node(0, { bounds: { x: 40_000, y: -50_000, width: 70_000, height: 10 } }), // off screen: valid
            node(1, { bounds: { x: 1.5, y: 0, width: 1, height: 1 } }), // dropped
            node(2, { bounds: { x: 2 ** 40, y: 0, width: 1, height: 1 } }), // dropped
            node(3, { bounds: "nope" }), // dropped
            node(4, { name: "n".repeat(70_000) }), // cut, not refused
          ],
        }),
        windows: () => ({ windows: [{ ref: "win:0x1", title: "t".repeat(70_000), bounds: { x: -32_000, y: 0, width: 40_000, height: 60_000 } }] }),
      },
    },
  });
  const session = await s.start({});
  const snap = await session.request("snapshot", { maxNodes: 10 });
  assert.deepEqual(snap.tree[0].bounds, { x: 40_000, y: -50_000, width: 70_000, height: 10 });
  assert.deepEqual([1, 2, 3].map((i) => snap.tree[i].bounds), [undefined, undefined, undefined]);
  assert.ok(snap.tree[4].name.length <= 64 * 1024 + 1);
  const { windows } = await session.request("windows", {});
  assert.deepEqual(windows[0].bounds, { x: -32_000, y: 0, width: 40_000, height: 60_000 });
  assert.ok(windows[0].title.endsWith("…"));
  await session.stop();
});

test("Q4: window geometry outside X11's range or fractional is still refused", async (t) => {
  const s = await setup(t, { behaviour: { handlers: { windows: () => ({ windows: [{ ref: "win:0x1", title: "t", bounds: { x: 0.5, y: 0, width: 1, height: 1 } }] }) } } });
  const session = await s.start({});
  await assert.rejects(session.request("windows", {}), (e) => e.code === "BAD_RESPONSE" && /windows\[0\]\.bounds\.x is not an integer/.test(e.message));
  await session.stop();
});
