/**
 * Runtime lifecycle fixes from the M1 post-integration review: teardown that
 * fails keeps the session (Z5), shutdown waits for starts and setup (Z7),
 * idle reaping respects in-flight calls (Z10), failed launches count (Z12),
 * export honours cancel and a deadline (Z9), config warnings reach results (Z17).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerOnPath } from "../../../src/backends/docker/cli.ts";
import { createGuiCommands } from "../../../src/commands/commands.ts";
import { DEFAULTS } from "../../../src/config/types.ts";
import { copyArtifact, exportArtifacts } from "../../../src/tools/export.ts";
import { GuiRuntime } from "../../../src/tools/runtime.ts";
import { createGuiTools } from "../../../src/tools/tools.ts";
import { fakeEnv } from "../backends/env.mjs";
import { parseRunArgv } from "../backends/fakes.mjs";

const call = (tool, params, ctx, signal) => tool.execute("call-1", params, signal, undefined, ctx);
const textOf = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const CONFIG = { shared: { targets: ["linux"], workspaceMode: "mount", network: "none" }, limits: { ...DEFAULTS.limits }, usageCheck: { ...DEFAULTS.usageCheck }, keepSandbox: false, warnings: [] };

/** A runtime whose backend is a scripted stub (no Docker, no helper). */
async function stubRuntime(t, behaviour = {}) {
  const root = await mkdtemp(join(tmpdir(), "gui-lifecycle-"));
  const tmp = join(root, "tmp");
  await mkdir(tmp);
  const sessions = [];
  const backend = {
    id: "docker-linux",
    checks: () => [],
    async startSession(options) {
      await behaviour.start?.(options);
      const s = {
        id: options.sessionId,
        backend: "docker-linux",
        arch: "x86_64",
        stops: 0,
        alive: true,
        async request() {
          return {};
        },
        async stop() {
          s.stops++;
          const leftovers = (await behaviour.stop?.(s)) ?? [];
          if (leftovers.length === 0) s.alive = false;
          return leftovers;
        },
        async auditFootprint() {
          return s.alive ? [{ kind: "container", id: `pi-gui-testing-${s.id}` }] : [];
        },
        forceRemoveArgv: () => ["true"],
      };
      sessions.push(s);
      return s;
    },
    auditOrphans: async () => [],
    sweepOrphans: async () => [],
  };
  const runtime = new GuiRuntime({ createBackend: () => backend, tmpRoot: tmp, globalConfigPath: join(root, "config.json"), dockerOnPath: async () => false, ...behaviour.runtime });
  t.after(async () => {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const open = (extra = {}) => runtime.openSession({ backend: "docker-linux", projectRoot: root, config: CONFIG, piSessionId: "pi", ...extra });
  return { root, tmp, runtime, sessions, open };
}

test("Z5: a failed teardown keeps the session, its temp dir, and the exit handler; a retry (gui_stop or /gui-cleanup) finishes it", async (t) => {
  let failures = 2;
  const env = await stubRuntime(t, { stop: () => (failures-- > 0 ? [{ kind: "container", id: "c", detail: "rm failed" }] : []) });
  const exitListeners = process.listenerCount("exit");
  const live = await env.open();
  assert.equal(process.listenerCount("exit"), exitListeners + 1);

  const first = env.runtime.closeSession(live.id);
  assert.equal(env.runtime.closeSession(live.id), first, "concurrent closes share one teardown");
  const outcome = await first;
  assert.equal(outcome.stopLeftovers.length + outcome.audit.length > 0, true);
  assert.equal(env.runtime.find(live.id).state, "failed");
  assert.ok((await stat(live.dir.path)).isDirectory(), "owner.json kept while resources may remain");
  assert.equal(process.listenerCount("exit"), exitListeners + 1, "exit handler kept");
  assert.throws(() => env.runtime.get(live.id), /cleanup did not finish; run gui_stop or \/gui-cleanup/);

  // /gui-cleanup retries this Pi's own leftover sessions.
  const messages = [];
  const commands = Object.fromEntries(createGuiCommands({ sendMessage: (m) => messages.push(m) }, env.runtime).map((c) => [c.name, c]));
  const ctx = { cwd: env.root, hasUI: true, mode: "tui", sessionManager: { getSessionId: () => "pi" }, ui: { notify() {}, setStatus() {} } };
  await commands["gui-cleanup"].handler("", ctx);
  assert.match(messages[0].content, new RegExp(`stopped sessions: ${live.id}`));
  assert.equal(env.runtime.find(live.id)?.state, "failed", "second attempt also failed");
  await commands["gui-cleanup"].handler("", ctx);
  assert.match(messages[1].content, /Footprint audit: empty/);
  assert.equal(env.runtime.find(live.id), undefined);
  await assert.rejects(stat(live.dir.path));
  assert.equal(process.listenerCount("exit"), exitListeners, "exit handler removed once nothing is left");
  assert.equal(env.sessions[0].stops, 3);
});

test("Z5: gui_stop on a session whose teardown failed retries it", async (t) => {
  const env = await fakeEnv(t);
  const tools = Object.fromEntries(createGuiTools(env.runtime).map((x) => [x.name, x]));
  const { session } = (await call(tools.gui_launch, {}, env.ctx())).details;
  // The daemon is busy: the stop's own listing and the audit after it both fail once.
  env.runner.on(/ ps -a /, { exitCode: 1, stderr: "daemon busy" }, { once: true }).on(/ ps -a /, { exitCode: 1, stderr: "daemon busy" }, { once: true });
  await assert.rejects(call(tools.gui_stop, { session }, env.ctx()), /footprint audit is not empty.*run gui_stop again or ask the user to run \/gui-cleanup/s);
  assert.equal(env.runtime.find(session).state, "failed");
  assert.match(textOf(await call(tools.gui_stop, { session }, env.ctx())), /footprint audit: empty/);
  assert.equal(env.runtime.find(session), undefined);
});

test("Z7: shutdown waits for a session start in flight and tears the late session down instead of registering it", async (t) => {
  const gate = deferred();
  const env = await stubRuntime(t, { start: () => gate.promise });
  const opening = env.open();
  const rejected = assert.rejects(opening, (e) => e.name === "AbortError" && /shutting down/.test(e.message));
  await tick();
  let done = false;
  const down = env.runtime.shutdown().then(() => (done = true));
  await tick();
  assert.equal(done, false, "shutdown waits for the start");
  await assert.rejects(env.open(), /shutting down/, "no new session while shutting down");
  gate.resolve();
  await down;
  await rejected;
  assert.equal(env.sessions[0].stops, 1, "the late session was stopped");
  assert.deepEqual(env.runtime.list(), []);
  assert.deepEqual(await readdir(env.tmp), []);
});

test("Z7: shutdown aborts and waits for a running setup; the wait is bounded", async (t) => {
  const env = await stubRuntime(t, { start: () => new Promise(() => {}), runtime: { shutdownWaitMs: 50 } });
  const controller = env.runtime.beginSetup("/gui-setup");
  let done = false;
  const down = env.runtime.shutdown().then(() => (done = true));
  await tick();
  assert.equal(controller.signal.aborted, true);
  assert.equal(done, false, "waits for the setup run to end");
  env.runtime.endSetup(controller);
  await down;

  void env.open().catch(() => {});
  await tick();
  const started = Date.now();
  await env.runtime.shutdown();
  assert.ok(Date.now() - started < 5_000, "a start that never ends does not block shutdown forever");
});

test("Z10: activity counts from admission; a session with a queued or running call is never reaped", async (t) => {
  const gate = deferred();
  const env = await fakeEnv(t, { local: { limits: { idleTimeoutMinutes: 1 } }, manualClock: true, behaviour: { handlers: { wait: () => gate.promise } } });
  const tools = Object.fromEntries(createGuiTools(env.runtime).map((x) => [x.name, x]));
  const { session } = (await call(tools.gui_launch, {}, env.ctx())).details;
  env.advance(59_000);
  const waiting = call(tools.gui_wait, { session, for: "idle", timeoutMs: 600_000 }, env.ctx());
  await tick();
  const queued = call(tools.gui_logs, { session }, env.ctx());
  env.advance(5 * 60_000);
  assert.deepEqual(await env.runtime.reapIdle(), [], "in-flight and queued calls block reaping");
  assert.equal(env.state.containers.size, 1);
  gate.resolve({ matched: true, elapsedMs: 300_000 });
  await waiting;
  await queued;
  env.advance(30_000);
  assert.deepEqual(await env.runtime.reapIdle(), [], "the end of the call is activity too");
  env.advance(31_000);
  assert.deepEqual(await env.runtime.reapIdle(), [session]);
});

test("Z12: failed launches count toward launch-storm detection, and the failed result carries the warning", async (t) => {
  const env = await fakeEnv(t, { behaviour: { handlers: { launch: () => ({ error: { code: "HANDOFF", message: "exited" } }) } } });
  const tools = Object.fromEntries(createGuiTools(env.runtime).map((x) => [x.name, x]));
  let last;
  for (let i = 0; i < 21; i++) last = await call(tools.gui_launch, {}, env.ctx()).catch((e) => e);
  assert.match(last.message, /app handed off/);
  assert.match(last.message, /usageWarning \(launch-storm\): gui_launch was called 21 times in 10 minutes/);
  assert.equal(last.usageWarning[0].signal, "launch-storm");
  assert.deepEqual(env.runtime.list(), []);
});

test("Z9: export checks the signal and its deadline before writing anything and between files", async (t) => {
  const env = await fakeEnv(t);
  const tools = Object.fromEntries(createGuiTools(env.runtime).map((x) => [x.name, x]));
  const { session } = (await call(tools.gui_launch, {}, env.ctx())).details;
  await call(tools.gui_screenshot, { session }, env.ctx());
  await call(tools.gui_screenshot, { session }, env.ctx());
  const live = env.runtime.get(session);
  const aborted = AbortSignal.abort(Object.assign(new Error("tool call cancelled"), { name: "AbortError" }));
  await assert.rejects(call(tools.gui_export, { session, dest: "out-a" }, env.ctx(), aborted), /cancelled/);
  await assert.rejects(stat(join(env.project, "out-a")), "nothing created after cancel");
  await assert.rejects(exportArtifacts(live, "out-b", env.project, { timeoutMs: 0 }), (e) => e.name === "AbortError" && /did not finish within 0 s/.test(e.message));
  await assert.rejects(stat(join(env.project, "out-b")));
  // A deadline that passes after the first file stops the export between files.
  let clock = 0;
  const now = () => clock++;
  await assert.rejects(exportArtifacts(live, "out-c", env.project, { timeoutMs: 4, now }), /1 file\(s\) were copied/);
  assert.equal((await readdir(join(env.project, "out-c"))).length, 1);
});

test("Z17: config warnings appear in gui_launch results and once in the first other tool result", async (t) => {
  const env = await fakeEnv(t, { shared: { surprise: true } });
  const tools = Object.fromEntries(createGuiTools(env.runtime).map((x) => [x.name, x]));
  const launched = await call(tools.gui_launch, {}, env.ctx());
  assert.match(textOf(launched), /config warnings:\n- .*gui\.json: unknown field "surprise" ignored/);
  assert.equal(launched.details.configWarnings.length, 1);
  const { session } = launched.details;
  const again = await call(tools.gui_launch, {}, env.ctx());
  assert.match(textOf(again), /unknown field "surprise"/, "every launch repeats them");
  const logs = await call(tools.gui_logs, { session }, env.ctx());
  assert.doesNotMatch(textOf(logs), /surprise/, "already shown in this Pi session");
});

test("Z17: a session tool shows config warnings that were not shown yet", async (t) => {
  const env = await fakeEnv(t);
  const tools = Object.fromEntries(createGuiTools(env.runtime).map((x) => [x.name, x]));
  const { session } = (await call(tools.gui_launch, {}, env.ctx())).details;
  await writeFile(join(env.project, ".pi", "gui.json"), JSON.stringify({ launch: { cmd: "python3" }, later: 1 }));
  const first = await call(tools.gui_logs, { session }, env.ctx());
  assert.match(textOf(first), /config warnings:\n- .*unknown field "later" ignored/);
  assert.doesNotMatch(textOf(await call(tools.gui_logs, { session }, env.ctx())), /later/);
});

test("Z8: dockerOnPath finds an executable docker file without running it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gui-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const withExec = join(root, "a");
  const withoutExec = join(root, "b");
  await mkdir(withExec);
  await mkdir(withoutExec);
  await mkdir(join(root, "c", "docker"), { recursive: true });
  await writeFile(join(withoutExec, "docker"), "#!/bin/sh\nexit 1\n");
  await chmod(join(withoutExec, "docker"), 0o644);
  assert.equal(await dockerOnPath(`${withoutExec}:${join(root, "c")}`), false, "not executable, or a directory");
  const marker = join(root, "ran");
  await writeFile(join(withExec, "docker"), `#!/bin/sh\ntouch '${marker}'\n`);
  await chmod(join(withExec, "docker"), 0o755);
  assert.equal(await dockerOnPath(`${withoutExec}:${withExec}`), true);
  assert.equal(await dockerOnPath(""), false);
  await assert.rejects(stat(marker), "never executed");
});

test("Q2: a failed start whose container removal fails stays tracked (owner.json, temp dir, exit cleanup) and a later /gui-cleanup removes it", async (t) => {
  let failRemove = true;
  const env = await fakeEnv(t, {
    shared: { setup: ["npm install"] },
    behaviour: {
      handlers: { exec: (params) => (params.cmd.startsWith("[") ? { exitCode: 0, elapsedMs: 1 } : { exitCode: 2, elapsedMs: 1 }) },
      // The daemon leaves an object of this session behind that the first removals cannot delete.
      onSpawn(child, state) {
        const labels = Object.fromEntries(parseRunArgv(child.argv).all("--label").map((l) => l.split(/=(.*)/s).slice(0, 2)));
        state.containers.set("pi-gui-testing-stuck", { id: "id-stuck", session: labels["pi-gui-testing.session"], owner: labels["pi-gui-testing.owner"], inspect: {} });
      },
    },
  });
  env.runner.on(/ rm -f id-stuck$/, () => (failRemove ? { exitCode: 1, stderr: "Error: removal in progress" } : (env.state.containers.delete("pi-gui-testing-stuck"), {})));
  const tools = Object.fromEntries(createGuiTools(env.runtime).map((x) => [x.name, x]));
  const exitListeners = process.listenerCount("exit");

  await assert.rejects(call(tools.gui_launch, {}, env.ctx()), /exited with 2[\s\S]*did not finish \(container[\s\S]*retried by gui_stop[\s\S]*\/gui-cleanup/);
  const [kept] = env.runtime.list();
  assert.ok(kept, "the failed start is tracked, not forgotten");
  assert.equal(kept.state, "failed");
  assert.ok((await stat(kept.dir.path)).isDirectory(), "temp dir kept");
  const owner = JSON.parse(await readFile(join(kept.dir.path, "owner.json"), "utf8"));
  assert.ok(owner.resources.some((r) => r.kind === "container"), "owner.json still lists the container");
  assert.match(kept.session.forceRemoveArgv().join(" "), /^docker --host \S+ rm -f pi-gui-testing-gui-/, "exit cleanup uses the frozen endpoint");
  assert.ok(process.listenerCount("exit") >= exitListeners, "exit handler armed");
  assert.ok(env.state.containers.has("pi-gui-testing-stuck"));

  failRemove = false;
  const messages = [];
  const commands = Object.fromEntries(createGuiCommands({ sendMessage: (m) => messages.push(m) }, env.runtime).map((c) => [c.name, c]));
  await commands["gui-cleanup"].handler("", env.ctx({ hasUI: true, mode: "tui" }));
  assert.match(messages.at(-1).content, new RegExp(`stopped sessions: ${kept.id}`));
  assert.equal(env.runtime.find(kept.id), undefined);
  assert.equal(env.state.containers.has("pi-gui-testing-stuck"), false);
  await assert.rejects(stat(kept.dir.path));
});

/**
 * Keeps the event loop alive for the rest of the test (cleared after it), so a
 * test awaiting deliberately unresolved work is never cancelled because only
 * unreferenced timers are left (node:test on Node 22 drains then).
 */
function keepAlive(t) {
  const handle = setInterval(() => {}, 60_000);
  t.after(() => clearInterval(handle));
}

/** A minimal session for exportArtifacts: a temp dir with artifacts and a scripted log flush. */
async function exportFixture(t, flush = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "gui-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "session");
  const artifactsDir = join(dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(join(artifactsDir, "screenshot-001.png"), "a");
  await writeFile(join(artifactsDir, "screenshot-002.png"), "b");
  return { root, live: { dir: { path: dir }, artifactsDir, logs: { flush } } };
}

test("Q8: cancelling or the deadline interrupts a log flush that never finishes", async (t) => {
  keepAlive(t);
  const { root, live } = await exportFixture(t, () => new Promise(() => {}));
  const controller = new AbortController();
  setTimeout(() => controller.abort(Object.assign(new Error("tool call cancelled"), { name: "AbortError" })), 20);
  const started = Date.now();
  await assert.rejects(exportArtifacts(live, "out", root, { signal: controller.signal }), /tool call cancelled/);
  assert.ok(Date.now() - started < 2_000);
  await assert.rejects(exportArtifacts(live, "out", root, { timeoutMs: 30 }), (e) => e.name === "AbortError" && /did not finish within/.test(e.message));
  await assert.rejects(stat(join(root, "out")), "nothing created");
});

test("Q8: cancelling or the deadline interrupts a slow copy; the partial file is not kept", async (t) => {
  keepAlive(t);
  const { root, live } = await exportFixture(t);
  const slowCopy = (src, dest, signal) =>
    new Promise((_, reject) => {
      void writeFile(dest, "partial");
      signal.addEventListener("abort", () => rm(dest, { force: true }).then(() => reject(signal.reason)), { once: true });
    });
  const controller = new AbortController();
  setTimeout(() => controller.abort(Object.assign(new Error("export cancelled by the user"), { name: "AbortError" })), 20);
  await assert.rejects(exportArtifacts(live, "out-a", root, { signal: controller.signal, copy: slowCopy }), /cancelled by the user/);
  assert.deepEqual(await readdir(join(root, "out-a")), []);
  await assert.rejects(exportArtifacts(live, "out-b", root, { timeoutMs: 30, copy: slowCopy }), /did not finish within 0 s; 0 file\(s\) were copied/);

  // The real copy is a stream pipeline bound to the signal; an abort mid-copy removes the partial file.
  const big = join(root, "big.bin");
  await writeFile(big, Buffer.alloc(32 * 1024 * 1024, 1));
  const abort = new AbortController();
  const copying = copyArtifact(big, join(root, "big-copy.bin"), abort.signal);
  setImmediate(() => abort.abort(Object.assign(new Error("stop"), { name: "AbortError" })));
  await assert.rejects(copying, (e) => e.name === "AbortError");
  await assert.rejects(stat(join(root, "big-copy.bin")), "partial copy removed");
  // And a normal export still copies everything.
  const done = await exportArtifacts(live, "out-c", root);
  assert.deepEqual(done.copied.sort(), ["screenshot-001.png", "screenshot-002.png"]);
});

test("Q11: a refused or failed gui_launch still carries the config warnings, without using up their one-time delivery", async (t) => {
  // Not verified: gui_launch is refused before any session starts.
  const refused = await fakeEnv(t, { shared: { surprise: true }, verified: false });
  const tools = Object.fromEntries(createGuiTools(refused.runtime).map((x) => [x.name, x]));
  await assert.rejects(call(tools.gui_launch, {}, refused.ctx()), (e) => /not set up/.test(e.message) && /config warnings:\n- .*unknown field "surprise"/.test(e.message) && e.configWarnings?.length === 1);

  // Verified, but the start fails: the warnings are on the failure, and the first other tool still gets them once.
  const env = await fakeEnv(t, { shared: { surprise: true } });
  const all = Object.fromEntries(createGuiTools(env.runtime).map((x) => [x.name, x]));
  env.runner.on(/ version --format/, { exitCode: 1, stderr: "daemon down" }, { once: true });
  await assert.rejects(call(all.gui_launch, {}, env.ctx()), /not reachable[\s\S]*config warnings:\n- .*"surprise"/);
  const { resolved } = await env.runtime.config(env.project);
  assert.equal(env.runtime.takeConfigWarnings(resolved.warnings).length, 1, "the failure did not mark them shown");
});

test("P4: a pending export keeps the process alive until its deadline settles it (no drained event loop drops the call)", async (t) => {
  // A separate process with nothing else alive: an unreferenced deadline timer would let it exit (code 13) before the export settles.
  const exportModule = fileURLToPath(new URL("../../../src/tools/export.ts", import.meta.url));
  const script = `
    import { mkdtemp, mkdir } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const { exportArtifacts } = await import(${JSON.stringify(exportModule)});
    const root = await mkdtemp(join(tmpdir(), "gui-export-ref-"));
    console.log("root:" + root);
    await mkdir(join(root, "s", "artifacts"), { recursive: true });
    const live = { dir: { path: join(root, "s") }, artifactsDir: join(root, "s", "artifacts"), logs: { flush: () => new Promise(() => {}) } };
    try {
      await exportArtifacts(live, "out", root, { timeoutMs: 100 });
      console.log("resolved");
    } catch (error) {
      console.log("settled:", error.name, error.message);
    }
  `;
  const { code, stdout } = await new Promise((resolve) =>
    execFile(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { timeout: 20_000 }, (error, stdout) =>
      resolve({ code: error ? (error.code ?? 1) : 0, stdout }),
    ),
  );
  const childRoot = /^root:(.+)$/m.exec(stdout)?.[1];
  if (childRoot) t.after(() => rm(childRoot, { recursive: true, force: true }));
  assert.equal(code, 0, `child exited with ${code}: ${stdout}`);
  assert.match(stdout, /settled: AbortError export did not finish within 0 s/);
});

test("P5: a destination that resolves into the session dir through a symlink is refused; nothing is copied there", async (t) => {
  const { root, live } = await exportFixture(t);
  await symlink(live.dir.path, join(root, "into-session"));
  await symlink(live.artifactsDir, join(root, "into-artifacts"));
  await mkdir(join(root, "outside"));
  await symlink(join(root, "into-session"), join(root, "outside", "chained"));
  for (const dest of ["into-session", "into-artifacts", "into-session/new/deeper", "outside/chained/x", "into-session/..kept", "outside/chained/..via-link"]) {
    await assert.rejects(exportArtifacts(live, dest, root), /is inside the temporary session dir \(it resolves to .*\); choose a directory outside it/, dest);
  }
  assert.deepEqual((await readdir(live.dir.path)).sort(), ["artifacts"], "nothing created in the session dir");
  assert.deepEqual((await readdir(live.artifactsDir)).sort(), ["screenshot-001.png", "screenshot-002.png"]);
  // A symlink to a directory outside the session dir is still a valid destination.
  await mkdir(join(root, "real-out"));
  await symlink(join(root, "real-out"), join(root, "link-out"));
  const done = await exportArtifacts(live, "link-out", root);
  assert.deepEqual(done.copied.sort(), ["screenshot-001.png", "screenshot-002.png"]);
  assert.deepEqual((await readdir(join(root, "real-out"))).sort(), ["screenshot-001.png", "screenshot-002.png"]);
});

test("P6: while a start is pending, the exit cleanup removes its container through the session's resolved endpoint", async (t) => {
  const contextHost = "unix:///run/user/1000/docker-ctx.sock";
  let hello;
  const helloSeen = deferred();
  const env = await fakeEnv(t, {
    docker: { contextName: "custom", contextHost },
    behaviour: {
      handlers: {
        hello: () =>
          new Promise((resolve) => {
            hello = resolve;
            helloSeen.resolve();
          }),
      },
    },
  });
  // The fake Docker answers the custom endpoint too (removal, audit).
  const escaped = contextHost.replace(/[/.]/g, "\\$&");
  env.runner.on(new RegExp(`^docker --host ${escaped} rm -f `), (argv) => (env.state.containers.delete(argv.at(-1)), {}));
  env.runner.on(new RegExp(`^docker --host ${escaped} `), { stdout: "" });
  const { resolved } = await env.runtime.config(env.project);
  const start = env.runtime.openSession({ backend: "docker-linux", projectRoot: env.project, config: resolved, piSessionId: "pi-test" }).catch((error) => error);
  await helloSeen.promise;
  const pending = env.runtime.exitCleanupCommands().filter((argv) => argv.includes("rm"));
  assert.equal(pending.length, 1, "the pending start is covered");
  assert.deepEqual(pending[0].slice(0, 5), ["docker", "--host", contextHost, "rm", "-f"]);
  assert.match(pending[0][5], /^pi-gui-testing-gui-[0-9a-f]{8}$/);
  hello({ error: { code: "INTERNAL", message: "test ends the start" } });
  assert.match((await start).message, /test ends the start/);
  assert.deepEqual(env.runtime.exitCleanupCommands(), [], "nothing left to remove once the start is gone");
});

test("P7: gui_logs never claims the temp file holds the full log once output was dropped from memory", async (t) => {
  const env = await fakeEnv(t);
  const tools = Object.fromEntries(createGuiTools(env.runtime).map((x) => [x.name, x]));
  const { session } = (await call(tools.gui_launch, {}, env.ctx())).details;
  const live = env.runtime.get(session);
  // Fill memory well past its byte budget (1 MiB) so older events are dropped.
  for (let i = 0; i < 40; i++) live.logs.add({ event: "log", stream: "stdout", source: "app", data: `${i}`.padEnd(60 * 1024, "z") });
  assert.ok(live.logs.dropped > 0);
  const text = textOf(await call(tools.gui_logs, { session, tail: 1 }, env.ctx()));
  assert.doesNotMatch(text, /full log/);
  assert.match(text, /older chunks dropped from memory; the session temp dir keeps more in app\.log, which may itself be truncated: it stops at 64 MiB and skips writes when the disk falls behind/);
});
