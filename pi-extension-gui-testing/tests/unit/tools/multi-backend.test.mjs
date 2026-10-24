/**
 * A second, non-Docker backend registered in a test registry works through
 * the unchanged runtime, tools, and commands: setup with the smoke test,
 * doctor, launch and stop, drift, cleanup, startup sweep, and reset. The
 * docker-linux entry stays registered and must run no docker command.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiCommands } from "../../../src/commands/commands.ts";
import { BackendRegistry, DEFAULT_REGISTRY } from "../../../src/backends/registry.ts";
import { GuiRuntime } from "../../../src/tools/runtime.ts";
import { createGuiTools } from "../../../src/tools/tools.ts";
import { fakeBackendEntry } from "../backends/fake-backend.mjs";

const VERIFIED_FAKE = { verifiedAt: "2026-10-24T00:00:00.000Z", toolVersions: { "fake.version": "1", "package.version": "0.1.0" }, checksPassed: ["fake.ready"] };

async function multiEnv(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "gui-multi-"));
  const project = join(root, "project");
  const tmp = join(root, "tmp");
  const globalConfigPath = join(root, "agent", "gui", "config.json");
  await mkdir(join(project, ".pi"), { recursive: true });
  await mkdir(tmp);
  await mkdir(join(root, "agent", "gui"), { recursive: true });
  await writeFile(join(project, ".pi", "gui.json"), JSON.stringify({ launch: { cmd: "app" } }));
  await writeFile(
    globalConfigPath,
    JSON.stringify({ version: 1, backend: "local-linux", verified: options.verified === false ? {} : { "local-linux": VERIFIED_FAKE } }),
  );
  const fake = fakeBackendEntry(options.fake);
  const dockerCalls = [];
  const dockerRunner = { run: async (argv) => (dockerCalls.push(argv.join(" ")), { exitCode: 1, signal: null, stdout: "", stderr: "no docker here", timedOut: false, truncated: false, durationMs: 0 }) };
  const registry = new BackendRegistry([DEFAULT_REGISTRY.entry("docker-linux"), fake.entry]);
  const runtime = new GuiRuntime({
    registry,
    tmpRoot: tmp,
    globalConfigPath,
    docker: { runner: dockerRunner, endpointSource: {} },
    dockerOnPath: async () => false,
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const exitCode = process.exitCode;
  t.after(async () => {
    await runtime.shutdown();
    process.exitCode = exitCode;
    await rm(root, { recursive: true, force: true });
  });
  const messages = [];
  const uiCalls = [];
  const commands = Object.fromEntries(createGuiCommands({ sendMessage: (m) => messages.push(m) }, runtime).map((c) => [c.name, c]));
  const tools = Object.fromEntries(createGuiTools(runtime).map((x) => [x.name, x]));
  const ctx = (overrides = {}) => ({
    cwd: project,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "pi-multi" },
    ui: {
      notify: () => {},
      setStatus: () => {},
      select: async (...args) => (uiCalls.push(["select", ...args]), overrides.answers?.select),
      confirm: async (...args) => (uiCalls.push(["confirm", ...args]), overrides.answers?.confirm ?? false),
      input: async () => undefined,
    },
    ...overrides,
  });
  const global = async () => JSON.parse(await readFile(globalConfigPath, "utf8"));
  return { root, project, tmp, runtime, registry, fake, dockerCalls, commands, tools, ctx, messages, uiCalls, global };
}

const last = (env) => env.messages.at(-1)?.content ?? "";

test("F: the runtime offers the registry's backends; descriptions, ids, and refusals come from it", async (t) => {
  const env = await multiEnv(t);
  assert.deepEqual(env.runtime.registry.ids, ["docker-linux", "local-linux"]);
  assert.equal(env.runtime.implemented("local-linux"), true);
  assert.equal(env.runtime.implemented("cua"), false);
  assert.match(env.runtime.notAvailableMessage("cua"), /backend "cua" is not available yet; available: docker-linux, local-linux/);
  assert.deepEqual(env.commands["gui-setup"].getArgumentCompletions("lo").map((c) => [c.value, c.description]), [["local-linux", "Fake helper on the host (test backend)"]]);
  // The backend factory got the runtime context; creating it ran nothing.
  const backend = env.runtime.backend("local-linux");
  assert.equal(backend.id, "local-linux");
  assert.equal(env.fake.calls.created, 1);
  assert.equal(env.runtime.backend("local-linux"), backend, "created once per runtime");
  assert.equal(env.fake.calls.ctx.tmpRoot, env.tmp);
  assert.match(env.fake.calls.ctx.ownerLabel(), /^[^:]+:\d+:\d+:/);
  assert.equal(env.fake.calls.starts.length, 0);
  await env.commands["gui-backend"].handler("cua", env.ctx());
  assert.match(last(env), /backend "cua" is not available yet; available: docker-linux, local-linux/);
  assert.deepEqual(env.dockerCalls, []);
});

test("F: gui_launch, gui_screenshot, and gui_stop run on the non-Docker backend: owner.json, exit cleanup, workspace path, teardown, audit", async (t) => {
  const env = await multiEnv(t);
  const exitListeners = process.listenerCount("exit");
  const launched = await env.tools.gui_launch.execute("c", {}, undefined, undefined, env.ctx());
  const { session } = launched.details;
  const text = launched.content.map((c) => c.text).join("\n");
  assert.match(text, /workspace: read-only mount at \/fake\/workspace/);
  const live = env.runtime.get(session);
  assert.equal(live.backend, "local-linux");
  assert.equal(live.session.arch, "x86_64");
  const helper = env.fake.spawner.children[0];
  assert.deepEqual(Object.keys(helper.env), ["PI_GUI_TESTING_TOKEN"], "the helper gets the token through its environment only");
  assert.equal(helper.requests.find((r) => r.method === "launch").params.cwd, "/fake/workspace");
  const owner = JSON.parse(await readFile(join(live.dir.path, "owner.json"), "utf8"));
  assert.equal(owner.backend, "local-linux");
  assert.ok(owner.resources.some((r) => r.kind === "fake-process" && r.id === `${session}-helper`), "recorded before the resource exists");
  assert.equal(process.listenerCount("exit"), exitListeners + 1, "exit cleanup installed");

  const shot = await env.tools.gui_screenshot.execute("c", { session }, undefined, undefined, env.ctx());
  assert.equal(shot.details.width, 64);

  await assert.rejects(env.tools.gui_launch.execute("c", { target: "windows" }, undefined, undefined, env.ctx()), /backend "local-linux" runs Linux apps only/);

  const stopped = await env.tools.gui_stop.execute("c", { session }, undefined, undefined, env.ctx());
  assert.doesNotMatch(stopped.content.map((c) => c.text).join("\n"), /leftover/i);
  assert.equal(env.fake.calls.teardowns, 1);
  assert.ok(env.fake.calls.audits >= 1, "session footprint audited after stop");
  assert.equal(env.runtime.find(session), undefined);
  assert.deepEqual(await readdir(env.tmp), []);
  assert.equal(process.listenerCount("exit"), exitListeners);
  assert.deepEqual(env.dockerCalls, [], "docker-linux stays registered but runs nothing");
});

test("F: the drift check uses the backend's DriftCapability", async (t) => {
  const env = await multiEnv(t, { fake: { versions: { "fake.version": "2" } } });
  await assert.rejects(env.tools.gui_launch.execute("c", {}, undefined, undefined, env.ctx()), /backend "local-linux" changed since setup \(fake\.version 1 → 2\); ask the user to run \/gui-doctor local-linux/);
  assert.equal(env.fake.calls.starts.length, 0);
});

test("F: /gui-setup with the picker and /gui-doctor verify the non-Docker backend through the generic smoke test", async (t) => {
  const env = await multiEnv(t, { verified: false });
  const ctx = env.ctx({ hasUI: true, mode: "rpc", answers: { select: "local-linux — Fake helper on the host (test backend)" } });
  await env.commands["gui-setup"].handler("", ctx);
  const picker = env.uiCalls.find(([kind]) => kind === "select");
  assert.deepEqual(picker[2], [
    "docker-linux — Linux apps in a local Docker container with a virtual display (rootful Docker Engine, or Docker Desktop on macOS and Windows)",
    "local-linux — Fake helper on the host (test backend)",
  ]);
  assert.match(last(env), /GUI testing setup: local-linux — verified/);
  const helper = env.fake.spawner.children[0];
  const launch = helper.requests.find((r) => r.method === "launch");
  assert.equal(launch.params.cmd, "python3");
  assert.equal(launch.params.cwd, "/fake/workspace", "the smoke app runs in the backend's workspace");
  const record = (await env.global()).verified["local-linux"];
  assert.equal(record.toolVersions["fake.version"], "1");
  assert.equal(record.toolVersions["package.version"], "0.1.0");
  assert.equal(env.fake.calls.starts[0].config.shared.network, "none");

  await env.commands["gui-doctor"].handler("local-linux", env.ctx());
  assert.match(last(env), /GUI testing doctor: local-linux — verified[\s\S]*Footprint audit \(orphans of ended sessions\): empty/);
  assert.equal(env.fake.calls.orphanAudits, 1, "without an OrphanAuditGate the audit runs once the required checks passed");
  assert.deepEqual(await readdir(env.tmp), []);
  assert.deepEqual(env.dockerCalls, []);
});

test("F: /gui-cleanup and the startup sweep iterate the registry and honour each sweep gate", async (t) => {
  const env = await multiEnv(t);
  const { session } = (await env.tools.gui_launch.execute("c", {}, undefined, undefined, env.ctx())).details;
  await env.commands["gui-cleanup"].handler("--all", env.ctx());
  const report = last(env);
  assert.match(report, /GUI testing cleanup \(docker-linux, local-linux\)/);
  assert.match(report, new RegExp(`stopped sessions: ${session}`));
  assert.match(report, /Footprint audit: empty/);
  assert.equal(env.fake.calls.sweeps, 1);
  assert.equal(env.fake.calls.orphanAudits, 1);
  assert.deepEqual(env.fake.calls.gates, [false]);
  assert.deepEqual(env.dockerCalls, [], "the docker gate (no docker on PATH) kept docker-linux out");

  await env.runtime.sweep(env.project);
  assert.equal(env.fake.calls.sweeps, 2);
  assert.deepEqual(env.fake.calls.gates, [false, true], "the startup sweep tells the gate it runs at startup");

  const closed = await multiEnv(t, { fake: { gate: false } });
  await closed.runtime.sweep(closed.project);
  await closed.commands["gui-cleanup"].handler("local-linux", closed.ctx());
  assert.equal(closed.fake.calls.sweeps, 0, "a closed gate means no sweep");
  assert.equal(closed.fake.calls.orphanAudits, 0, "and no orphan audit");

  const throwing = await multiEnv(t, { fake: { gate: () => Promise.reject(new Error("boom")) } });
  await throwing.runtime.sweep(throwing.project);
  assert.equal(throwing.fake.calls.sweeps, 0, "a gate that throws counts as closed");

  const bare = await multiEnv(t, { fake: { capabilities: false } });
  await bare.runtime.sweep(bare.project);
  assert.equal(bare.fake.calls.sweeps, 1, "a backend without a gate is always swept");
});

test("F: /gui-reset uses the backend's ResetCapability; a backend without one gets the generic text", async (t) => {
  const env = await multiEnv(t);
  await env.commands["gui-reset"].handler("local-linux", env.ctx({ hasUI: true, mode: "tui", answers: { confirm: true } }));
  const confirm = env.uiCalls.find(([kind]) => kind === "confirm");
  assert.equal(confirm[1], "Reset local-linux?");
  assert.match(confirm[2], /removes its fake data/);
  assert.match(last(env), /GUI testing reset local-linux:\nremoved the fake data\nremoved the verified state and backend choice\nsystem packages: the fake backend installs none\nLeftovers: empty/);
  const config = await env.global();
  assert.equal(config.verified["local-linux"], undefined);
  assert.equal(config.backend, undefined);
  assert.equal(env.fake.calls.resets, 1);

  const bare = await multiEnv(t, { fake: { capabilities: false } });
  await bare.commands["gui-reset"].handler("local-linux", bare.ctx({ hasUI: true, mode: "tui", answers: { confirm: true } }));
  assert.equal(bare.uiCalls.find(([kind]) => kind === "confirm")[2], "Stops its sessions and removes its verified state and backend choice.");
  assert.match(last(bare), /GUI testing reset local-linux:\nremoved the verified state and backend choice\nLeftovers: empty/);
  assert.deepEqual([...env.dockerCalls, ...bare.dockerCalls], []);
});

test("V6: tools on a running session name and use that session's backend after the active backend changed", async (t) => {
  const local = fakeBackendEntry({ id: "local-linux" });
  const cua = fakeBackendEntry({ id: "cua" });
  const root = await mkdtemp(join(tmpdir(), "gui-multi-v6-"));
  const project = join(root, "project");
  const globalConfigPath = join(root, "config.json");
  await mkdir(join(root, "tmp"), { recursive: true });
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(project, ".pi", "gui.json"), JSON.stringify({ launch: { cmd: "app" } }));
  await writeFile(globalConfigPath, JSON.stringify({ version: 1, backend: "local-linux", verified: { "local-linux": VERIFIED_FAKE, cua: VERIFIED_FAKE } }));
  const runtime = new GuiRuntime({ registry: new BackendRegistry([local.entry, cua.entry]), globalConfigPath, tmpRoot: join(root, "tmp") });
  t.after(async () => {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const tools = Object.fromEntries(createGuiTools(runtime).map((x) => [x.name, x]));
  const ctx = { cwd: project, hasUI: false, mode: "json", sessionManager: { getSessionId: () => "pi-v6" }, ui: { notify() {}, setStatus() {} } };
  const launched = await tools.gui_launch.execute("c", {}, undefined, undefined, ctx);
  assert.equal(launched.details.backend, "local-linux");
  const session = launched.details.session;

  // The user switches the active backend; the running session still belongs to local-linux.
  await writeFile(globalConfigPath, JSON.stringify({ version: 1, backend: "cua", verified: { "local-linux": VERIFIED_FAKE, cua: VERIFIED_FAKE } }));
  const logs = await tools.gui_logs.execute("c", { session }, undefined, undefined, ctx);
  assert.equal(logs.details.backend, "local-linux");
  assert.match(logs.content[0].text, /backend: local-linux/);

  // Even with the active backend unverified, the running session is usable and named correctly.
  await writeFile(globalConfigPath, JSON.stringify({ version: 1, backend: "cua", verified: { "local-linux": VERIFIED_FAKE } }));
  const again = await tools.gui_logs.execute("c", { session }, undefined, undefined, ctx);
  assert.equal(again.details.backend, "local-linux");
  // The session's own backend losing its verified state (a failed /gui-doctor local-linux) is refused with its name; gui_stop still works.
  await writeFile(globalConfigPath, JSON.stringify({ version: 1, backend: "cua", verified: { cua: VERIFIED_FAKE } }));
  await assert.rejects(tools.gui_logs.execute("c", { session }, undefined, undefined, ctx), /backend "local-linux" is not set up/);
  const stopped = await tools.gui_stop.execute("c", { session }, undefined, undefined, ctx);
  assert.equal(stopped.details.backend, "local-linux");
  assert.equal(cua.calls.starts.length, 0, "the new active backend started nothing");

  // An unknown session with an unverified active backend keeps the spec's refusal.
  await writeFile(globalConfigPath, JSON.stringify({ version: 1, backend: "cua", verified: {} }));
  await assert.rejects(tools.gui_logs.execute("c", { session: "gui-nope" }, undefined, undefined, ctx), /backend "cua" is not set up/);
});

test("V12: the /gui-setup picker offers only the backends that run on this client's OS", async (t) => {
  const env = await multiEnv(t, { verified: false, platform: "darwin" });
  // Both before any command: each env restores the process exit code it saw.
  const none = await multiEnv(t, { verified: false, platform: "aix" });
  await env.commands["gui-setup"].handler("", env.ctx({ hasUI: true, mode: "rpc", answers: { select: undefined } }));
  const picker = env.uiCalls.find(([kind]) => kind === "select");
  assert.equal(picker[2].length, 1, `only docker-linux runs on macOS: ${picker[2]}`);
  assert.match(picker[2][0], /^docker-linux — /);
  assert.match(last(env), /GUI setup cancelled/);
  // Without a UI the hint names the same backends.
  await env.commands["gui-setup"].handler("", env.ctx());
  assert.match(last(env), /run \/gui-setup docker-linux$/);

  await none.commands["gui-setup"].handler("", none.ctx({ hasUI: true, mode: "rpc" }));
  assert.match(last(none), /no backend of this build runs on aix/);
  assert.equal(none.uiCalls.filter(([kind]) => kind === "select").length, 0);
});
