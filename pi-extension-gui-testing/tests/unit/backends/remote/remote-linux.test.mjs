/**
 * `remote-linux` sessions over a loopback `ssh` (real ControlMaster
 * emulation, real remote scripts, real tar and sha256sum) with a fake helper
 * at the far end: the start sequence and what it records first, the host-mode
 * helper environment, setup through `exec`, teardown and audit, cleanup on
 * every failed start, retryable teardown, and the runtime/tools path through a
 * test registry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionError } from "../../../../src/backend.ts";
import { createSpawner } from "../../../../src/backends/docker/process.ts";
import { RemoteLinuxBackend } from "../../../../src/backends/remote-linux.ts";
import { hasRemoteHost, REMOTE_HOST_SUPPORT } from "../../../../src/backends/remote/host.ts";
import { hasDrift, hasReset, hasRunner, hasSmoke, hasSweepAvailability } from "../../../../src/backends/capabilities.ts";
import { BackendRegistry, DEFAULT_REGISTRY } from "../../../../src/backends/registry.ts";
import { GuiRuntime } from "../../../../src/tools/runtime.ts";
import { createGuiTools } from "../../../../src/tools/tools.ts";
import { decodeRemote, loopbackSsh, parseSshArgv, preambleChild } from "../../transport/ssh/fake-ssh.mjs";
import { FakeHelperChild } from "../fakes.mjs";

const OWNER = "cid0:1:2:boot0";

/** Spawner: the helper command gets a FakeHelperChild (plus a tagged local process standing in for its children); everything else runs the loopback ssh. */
function mixedSpawner(behaviour = {}) {
  const real = createSpawner();
  const helpers = [];
  return {
    helpers,
    spawn(argv, options) {
      const parsed = parseSshArgv(argv);
      const decoded = decodeRemote(parsed.command);
      if (decoded.kind === "helper" && decoded.argv.some((a) => a.endsWith("/tooling/helper"))) {
        const record = { argv: [...argv], ...parsed, decoded };
        return preambleChild(record, (a, o) => {
          const child = new FakeHelperChild(a, o, behaviour);
          // What the real helper's Xvfb/apps look like on the remote host: tagged through XDG_RUNTIME_DIR.
          const app = spawn("sleep", ["60"], { env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: `${o.env.PI_GUI_RUNTIME_DIR}/xdg` }, stdio: "ignore", detached: true });
          helpers.push({ child, record, app, appExited: new Promise((r) => app.once("exit", r)) });
          return child;
        });
      }
      return real.spawn(argv, options);
    },
  };
}

async function env(t, options = {}) {
  const root = await mkdtemp("/tmp/pgt-rl-");
  const lb = await loopbackSsh(root);
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "app.py"), "print('app')\n");
  await writeFile(join(project, ".env"), "SECRET=1\n");
  const spawner = mixedSpawner(options.behaviour);
  const backend = new RemoteLinuxBackend({ ownerLabel: () => OWNER, ssh: lb.ssh, spawner, syncMethod: "tar", readyTimeoutMs: options.readyTimeoutMs ?? 5_000, ...(options.host === null ? {} : { host: "loop" }) });
  t.after(async () => {
    for (const h of spawner.helpers) h.app.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  const base = join(lb.xdg, "pi-gui-testing");
  return { root, lb, project, backend, spawner, base };
}

async function startOptions(e, overrides = {}) {
  const sessionDir = await mkdtemp(join(e.root, "pi-gui-testing-"));
  const recorded = [];
  const exitArgvs = [];
  const statuses = [];
  const logs = [];
  const options = {
    sessionId: "gui-1234abcd",
    projectRoot: e.project,
    sessionDir,
    config: {
      shared: { targets: ["linux"], workspaceMode: "mount", network: "default", setup: ["pip install -r requirements.txt"] },
      limits: { maxConcurrentSessions: 2, idleTimeoutMinutes: 15 },
      usageCheck: { warnSessionCostUsd: 1, warnDailyCostUsd: 5 },
      keepSandbox: false,
      remote: { host: "loop" },
      warnings: [],
    },
    ownerLabel: OWNER,
    recordResource: async (kind, id) => void recorded.push([kind, id]),
    onLog: (e2) => logs.push(e2),
    onStatus: (s) => statuses.push(s),
    signal: new AbortController().signal,
    onExitCleanup: (argv) => void exitArgvs.push(argv),
    ...overrides,
  };
  return { options, sessionDir, recorded, exitArgvs, statuses, logs };
}

async function remoteDirs(e) {
  return (await readdir(e.base).catch(() => [])).filter((n) => n.startsWith("s-"));
}

test("capabilities and host handling", async (t) => {
  const e = await env(t, { host: null });
  const b = e.backend;
  assert.equal(b.id, "remote-linux");
  assert.ok(hasRemoteHost(b) && hasDrift(b) && hasReset(b) && hasRunner(b) && hasSmoke(b) && hasSweepAvailability(b));
  assert.equal(b.remoteHost, undefined);
  assert.equal(await b.sweepAvailable({ startup: false }), false, "no host, no sweep");
  const v = b.forHost("loop");
  assert.equal(b.remoteHost, undefined, "forHost never re-points the shared backend");
  assert.equal(v.remoteHost, "loop");
  assert.equal(v.id, "remote-linux");
  assert.equal(await v.sweepAvailable({ startup: true }), false, "never at Pi startup");
  assert.equal(await v.sweepAvailable({ startup: false }), true);
  assert.equal(await b.sweepAvailable({ startup: false }), false);
  assert.throws(() => b.forHost("-oProxyCommand=evil"), /starts with "-"/);
  assert.equal(v.forHost(undefined).remoteHost, undefined);
  assert.deepEqual(v.smokeApp(), { cmd: "python3", args: ["../tooling/testapps/gtk3-smoke/app.py"] });
  assert.equal(v.smokeConfig({ shared: {} }).remote.host, "loop");
  assert.equal((await v.currentVersions())["remote.host"], "loop");
  assert.equal((await b.currentVersions())["remote.host"], undefined);
  assert.deepEqual(REMOTE_HOST_SUPPORT.platforms, ["linux", "darwin"]);
});

test("a session: records first, syncs, deploys, starts the host-mode helper, runs setup, stops clean", async (t) => {
  const e = await env(t);
  const s = await startOptions(e);
  const session = await e.backend.startSession(s.options);
  const [name] = await remoteDirs(e);
  assert.match(name, /^s-gui-1234abcd-[0-9a-f]{8}$/);
  const dir = join(e.base, name);
  assert.deepEqual(s.recorded.slice(0, 2), [["ssh-master", `loop ${join(s.sessionDir, "ssh")}`], ["remote-dir", `loop:${name}`]]);
  assert.ok(s.exitArgvs.length >= 2, "exit cleanup known before the first remote resource");
  assert.equal(parseSshArgv(s.exitArgvs[0]).destination, "loop");
  await stat(join(s.sessionDir, "ssh"));

  assert.equal(session.workspacePath, join(dir, "workspace"));
  await stat(join(dir, "workspace", "app.py"));
  await assert.rejects(stat(join(dir, "workspace", ".env")), "secrets never leave the client");
  await stat(join(dir, "tooling", "helper"));
  assert.ok(session.sync.files >= 1 && session.sync.bytes > 0);
  assert.ok(s.statuses.some((x) => /^synced \d+ files to loop:/.test(x)));

  const [{ child, record }] = e.spawner.helpers;
  assert.deepEqual(record.decoded.argv, ["python3", "-I", join(dir, "tooling", "helper")]);
  assert.deepEqual(record.decoded.session, { dir, name }, "the helper runs under the remote cleanup wrapper of its session dir");
  assert.equal(record.argv.join(" ").includes(record.env.PI_GUI_TESTING_TOKEN), false);
  assert.match(record.env.PI_GUI_TESTING_TOKEN, /^[0-9a-f]{32}$/);
  assert.equal(record.env.PI_GUI_HELPER_MODE, "host");
  assert.equal(record.env.PI_GUI_WORKSPACE, join(dir, "workspace"));
  assert.equal(record.env.PI_GUI_RUNTIME_DIR, join(dir, "run"));
  assert.equal(record.env.PI_GUI_DISPLAY_LOCK_DIR, join(e.base, "displays"));
  assert.equal(record.env.PI_GUI_ALLOW_EXEC, "1");
  // Spec §4.8: setup installs below the session dir (pip --target, npm prefix), where the cache packs and fills.
  assert.equal(record.env.PI_GUI_DEPS_DIR, join(dir, "deps"));
  assert.equal(record.options.ControlPath, join(s.sessionDir, "ssh"), "the helper runs through the ControlMaster");
  const setup = child.requests.find((r) => r.method === "exec");
  assert.deepEqual([setup.params.cmd, setup.params.cwd], ["pip install -r requirements.txt", join(dir, "workspace")]);

  const launched = await session.request("launch", { cmd: "python3", args: ["app.py"], env: {}, cwd: session.workspacePath });
  assert.equal(launched.pid, 77);

  const leftovers = await session.stop();
  assert.deepEqual(leftovers, []);
  await e.spawner.helpers[0].appExited;
  assert.deepEqual(await remoteDirs(e), []);
  await assert.rejects(stat(join(s.sessionDir, "ssh")), "ControlMaster closed");
  assert.deepEqual(await session.auditFootprint(), []);
  assert.deepEqual(await session.stop(), [], "idempotent");
});

test("re-sync sends changes into the running session", async (t) => {
  const e = await env(t);
  const s = await startOptions(e);
  const session = await e.backend.startSession(s.options);
  await writeFile(join(e.project, "new.py"), "x\n");
  const report = await session.resync();
  assert.equal(report.method, "tar");
  await stat(join(session.workspacePath, "new.py"));
  assert.equal(session.sync.files, report.files);
  assert.deepEqual(await session.stop(), []);
});

test("an unreachable host fails the start with the remediation and leaves nothing", async (t) => {
  const e = await env(t);
  await writeFile(join(e.root, "unreachable"), "");
  const s = await startOptions(e);
  await assert.rejects(e.backend.startSession(s.options), (error) => error instanceof SessionError && error.code === "START_FAILED" && /Connection refused/.test(error.message) && /unreachable/.test(error.message));
  assert.deepEqual(await remoteDirs(e), []);
  assert.equal(e.spawner.helpers.length, 0);
});

test("no host configured fails before anything starts", async (t) => {
  const e = await env(t, { host: null });
  const s = await startOptions(e);
  delete s.options.config.remote;
  await assert.rejects(e.backend.startSession(s.options), /no SSH host is configured for remote-linux; run \/gui-setup remote-linux --host/);
  assert.deepEqual(s.recorded, []);
});

test("a failure after the remote dir exists (sync) removes it and closes the ControlMaster", async (t) => {
  const e = await env(t);
  const s = await startOptions(e, { projectRoot: join(e.root, "missing-project") });
  await assert.rejects(e.backend.startSession(s.options), /ENOENT|no such file/i);
  assert.deepEqual(await remoteDirs(e), []);
  await assert.rejects(stat(join(s.sessionDir, "ssh")));
});

test("a helper that never gets ready: start fails and everything is removed", async (t) => {
  const e = await env(t, { behaviour: { noReady: true }, readyTimeoutMs: 300 });
  const s = await startOptions(e);
  await assert.rejects(e.backend.startSession(s.options), (error) => error instanceof SessionError);
  assert.deepEqual(await remoteDirs(e), []);
  await e.spawner.helpers[0].appExited;
});

test("a failing setup command stops the session with SETUP_FAILED and the output tail", async (t) => {
  const e = await env(t, {
    behaviour: {
      handlers: {
        exec: (params, child) => {
          child.log("setup", "stderr", "error: no requirements.txt\n");
          return { exitCode: 3, elapsedMs: 1 };
        },
      },
    },
  });
  const s = await startOptions(e);
  await assert.rejects(e.backend.startSession(s.options), (error) => error.code === "SETUP_FAILED" && /exited with 3 on the remote host/.test(error.message) && /no requirements\.txt/.test(error.message));
  assert.deepEqual(await remoteDirs(e), []);
});

test("teardown while the host is unreachable leaves leftovers; a retry removes them", async (t) => {
  const e = await env(t);
  const s = await startOptions(e);
  const session = await e.backend.startSession(s.options);
  await writeFile(join(e.root, "unreachable"), "");
  const first = await session.stop();
  assert.ok(first.some((l) => l.kind === "remote-dir" && /removal failed/.test(l.detail)));
  assert.ok((await session.auditFootprint()).length > 0);
  assert.equal((await remoteDirs(e)).length, 1);
  await rm(join(e.root, "unreachable"));
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(await remoteDirs(e), []);
  assert.deepEqual(await session.auditFootprint(), []);
});

test("runtime and tools: gui_launch and gui_stop on remote-linux through a test registry", async (t) => {
  const e = await env(t);
  const tmp = join(e.root, "tmp");
  await mkdir(tmp);
  await mkdir(join(e.project, ".pi"));
  await writeFile(join(e.project, ".pi", "gui.json"), JSON.stringify({ launch: { cmd: "python3", args: ["app.py"] } }));
  await writeFile(join(e.project, ".pi", "gui.local.json"), JSON.stringify({ backend: "remote-linux", remote: { host: "loop" } }));
  const globalConfigPath = join(e.root, "agent", "gui", "config.json");
  await mkdir(join(e.root, "agent", "gui"), { recursive: true });
  await writeFile(globalConfigPath, JSON.stringify({ version: 1, verified: { "remote-linux": { verifiedAt: "2026-10-24T00:00:00.000Z", toolVersions: { ...(await e.backend.currentVersions()) }, checksPassed: ["ssh.auth"] } } }));
  const entry = {
    id: "remote-linux",
    description: "Linux apps on your SSH host under a private virtual display",
    hostSupport: REMOTE_HOST_SUPPORT,
    targets: ["linux"],
    create: (ctx) => new RemoteLinuxBackend({ ownerLabel: ctx.ownerLabel, ...ctx.options }),
  };
  const runtime = new GuiRuntime({
    registry: new BackendRegistry([DEFAULT_REGISTRY.entry("docker-linux"), entry]),
    tmpRoot: tmp,
    globalConfigPath,
    dockerOnPath: async () => false,
    backendOptions: { "remote-linux": { ssh: e.lb.ssh, spawner: e.spawner, syncMethod: "tar", readyTimeoutMs: 5_000 } },
  });
  t.after(() => runtime.shutdown());
  const tools = Object.fromEntries(createGuiTools(runtime).map((x) => [x.name, x]));
  const ctx = { cwd: e.project, hasUI: false, mode: "json", sessionManager: { getSessionId: () => "pi-remote" }, ui: { notify() {}, setStatus() {} } };
  const launched = await tools.gui_launch.execute("c", {}, undefined, undefined, ctx);
  const { session } = launched.details;
  const live = runtime.get(session);
  assert.equal(live.backend, "remote-linux");
  assert.match(live.session.workspacePath, /\/pi-gui-testing\/s-gui-[0-9a-f]+-[0-9a-f]+\/workspace$/);
  const helper = e.spawner.helpers.at(-1).child;
  assert.equal(helper.requests.find((r) => r.method === "launch").params.cwd, live.session.workspacePath);
  const stopped = await tools.gui_stop.execute("c", { session }, undefined, undefined, ctx);
  assert.doesNotMatch(stopped.content.map((c) => c.text).join("\n"), /leftover/i);
  assert.equal(runtime.find(session), undefined);
  assert.deepEqual(await remoteDirs(e), []);
  assert.deepEqual(await readdir(tmp), [], "client session dir removed");
});

test('V3: "network": "none" is refused before any remote resource; the smoke config uses the host network', async (t) => {
  const e = await env(t);
  const s = await startOptions(e);
  s.options.config = { ...s.options.config, shared: { ...s.options.config.shared, network: "none" } };
  await assert.rejects(e.backend.startSession(s.options), (error) => error instanceof SessionError && error.code === "UNSUPPORTED" && /remote-linux cannot block the app's network/.test(error.message));
  assert.deepEqual(s.recorded, [], "nothing recorded, so nothing was created");
  assert.deepEqual(s.exitArgvs, []);
  assert.equal(await readFile(e.lb.log, "utf8").catch(() => ""), "", "no ssh call");
  assert.deepEqual(await remoteDirs(e), []);
  assert.equal(e.spawner.helpers.length, 0);
  const smoke = e.backend.smokeConfig({ shared: { targets: ["linux"], workspaceMode: "mount", network: "none" } });
  assert.equal(smoke.shared.network, "default");
  assert.equal(smoke.remote.host, "loop");
});
