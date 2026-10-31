import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createGuiTools } from "../../../src/tools/tools.ts";
import { BackendRegistry, DEFAULT_REGISTRY } from "../../../src/backends/registry.ts";
import { fakeEnv, VERIFIED } from "../backends/env.mjs";

function tools(runtime) {
  return Object.fromEntries(createGuiTools(runtime).map((tool) => [tool.name, tool]));
}

const call = (tool, params, ctx, signal) => tool.execute("call-1", params, signal, undefined, ctx);
const textOf = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

const NOT_SET_UP = 'backend "docker-linux" is not set up; ask the user to run /gui-setup docker-linux';

test("S9: every tool refuses with the spec's text when docker-linux is not verified, and starts nothing", async (t) => {
  const env = await fakeEnv(t, { verified: false });
  const all = tools(env.runtime);
  assert.deepEqual(Object.keys(all), ["gui_launch", "gui_wait", "gui_snapshot", "gui_screenshot", "gui_act", "gui_logs", "gui_stop", "gui_export"]);
  const params = {
    gui_launch: {},
    gui_wait: { session: "gui-x", for: "idle" },
    gui_snapshot: { session: "gui-x" },
    gui_screenshot: { session: "gui-x" },
    gui_act: { session: "gui-x", action: "click", ref: "s1:1" },
    gui_logs: { session: "gui-x" },
    gui_stop: { session: "gui-x" },
    gui_export: { session: "gui-x", dest: "out" },
  };
  for (const [name, tool] of Object.entries(all)) {
    await assert.rejects(call(tool, params[name], env.ctx()), (e) => e.message === NOT_SET_UP, name);
    assert.equal(tool.executionMode, "sequential");
  }
  assert.equal(env.spawner.children.length, 0);
  assert.deepEqual(env.runner.calls, [], "refusal happens before any Docker call");
});

test("a backend that this build lacks is refused as not available, never replaced by another (R6)", async (t) => {
  // Every known id is registered in this build, so a registry without docker-windows stands in for an older build.
  const registry = new BackendRegistry(DEFAULT_REGISTRY.entries().filter((e) => e.id !== "docker-windows"));
  const env = await fakeEnv(t, { local: { backend: "docker-windows" }, runtime: { registry } });
  await assert.rejects(call(tools(env.runtime).gui_launch, {}, env.ctx()), /backend "docker-windows" is not available yet; available: docker-linux, local-linux, remote-linux, remote-linux-docker, cua, local-windows/);
  // A registered backend that is not verified is refused too; docker-linux (verified) is never used instead.
  const local = await fakeEnv(t, { local: { backend: "local-linux" } });
  await assert.rejects(call(tools(local.runtime).gui_launch, {}, local.ctx()), /backend "local-linux" is not set up; ask the user to run \/gui-setup local-linux/);
  assert.deepEqual(local.runner.calls, []);
});

test("launch → snapshot → act by ref → screenshot (image block) → logs → export → stop with an empty audit", async (t) => {
  const env = await fakeEnv(t);
  const all = tools(env.runtime);
  const launched = await call(all.gui_launch, {}, env.ctx());
  const session = launched.details.session;
  assert.match(session, /^gui-[0-9a-f]{8}$/);
  assert.match(textOf(launched), /started; app pid 77 \(python3 app\.py\)/);
  assert.match(textOf(launched), /read-only mount at \/workspace/);
  assert.match(textOf(launched), /win:0x1 "Pi GUI smoke"/);
  assert.match(textOf(launched), /backend: docker-linux/);
  assert.equal(launched.details.backend, "docker-linux");
  assert.equal(launched.details.arch, "x86_64");
  const child = env.spawner.children[0];
  assert.deepEqual(child.requests.find((r) => r.method === "launch").params, { cmd: "python3", args: ["app.py"], env: {}, cwd: "/workspace" });

  const snap = await call(all.gui_snapshot, { session, maxNodes: 2 }, env.ctx());
  assert.match(textOf(snap), /coverage full, 2 of 3 nodes/);
  assert.match(textOf(snap), /s1:1 label "Waiting"/);
  assert.ok((await stat(snap.details.path)).isFile());
  assert.equal(JSON.parse(await readFile(snap.details.path, "utf8")).length, 3, "the full tree is saved");

  const acted = await call(all.gui_act, { session, action: "click", ref: "s1:2" }, env.ctx());
  assert.match(textOf(acted), /click on s1:2: ok/);

  const shot = await call(all.gui_screenshot, { session }, env.ctx());
  const image = shot.content.find((c) => c.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.ok(Buffer.from(image.data, "base64").subarray(1, 4).toString() === "PNG");
  assert.match(textOf(shot), /temporary/);
  assert.ok((await stat(shot.details.path)).isFile());

  child.log("app", "stderr", "Gtk-WARNING: hello\n");
  await new Promise((r) => setImmediate(r));
  const logs = await call(all.gui_logs, { session, tail: 5 }, env.ctx());
  assert.match(textOf(logs), /\[app stderr\] Gtk-WARNING: hello/);

  const exported = await call(all.gui_export, { session, dest: "artifacts-out" }, env.ctx());
  const names = await readdir(join(env.project, "artifacts-out"));
  assert.ok(names.some((n) => n.startsWith("screenshot-")) && names.some((n) => n.startsWith("snapshot-")) && names.includes("app.log"), names.join());
  assert.match(textOf(exported), /exported \d+ file\(s\)/);
  const again = await call(all.gui_export, { session, dest: "artifacts-out" }, env.ctx());
  assert.match(textOf(again), /skipped \(already present\)/);
  await assert.rejects(call(all.gui_export, { session, dest: env.runtime.get(session).artifactsDir }, env.ctx()), /inside the temporary session dir/);

  const sessionDir = env.runtime.get(session).dir.path;
  const stopped = await call(all.gui_stop, { session }, env.ctx());
  assert.match(textOf(stopped), /footprint audit: empty; temporary files deleted/);
  await assert.rejects(stat(sessionDir));
  assert.equal(env.state.containers.size, 0);
  await assert.rejects(call(all.gui_snapshot, { session }, env.ctx()), /unknown GUI session/);
});

test("coordinates are in the pixels of the latest screenshot image and are scaled to the capture; stale captures are refused", async (t) => {
  const env = await fakeEnv(t);
  const all = tools(env.runtime);
  const { session } = (await call(all.gui_launch, {}, env.ctx())).details;
  await assert.rejects(call(all.gui_act, { session, action: "click", x: 1, y: 1 }, env.ctx()), /take a gui_screenshot first/);
  await assert.rejects(call(all.gui_act, { session, action: "click", ref: "s1:1", x: 1, y: 1 }, env.ctx()), /either ref, or x and y/);
  const shot = await call(all.gui_screenshot, { session, maxEdge: 32 }, env.ctx());
  assert.equal(shot.details.scale, 0.5);
  assert.equal(shot.details.width, 32);
  await call(all.gui_act, { session, action: "double_click", x: 10, y: 7 }, env.ctx());
  const act = env.spawner.children[0].requests.filter((r) => r.method === "act").at(-1);
  assert.deepEqual(act.params, { action: "double_click", captureId: shot.details.captureId, x: 20, y: 14 });
  await assert.rejects(call(all.gui_act, { session, action: "click", x: 1, y: 1, captureId: "c0" }, env.ctx()), /capture c0 is stale/);
  const typed = await call(all.gui_act, { session, action: "type", ref: "s1:2", text: "hello", screenshot: true }, env.ctx());
  assert.ok(typed.content.some((c) => c.type === "image"), "auto-screenshot");
  assert.deepEqual(env.spawner.children[0].requests.filter((r) => r.method === "act").at(-1).params, { action: "type", text: "hello", ref: "s1:2" });
});

test("S8: a loop warning is attached to the result and notified, and the call still succeeds", async (t) => {
  const env = await fakeEnv(t);
  const all = tools(env.runtime);
  const ctx = env.ctx({ hasUI: true, mode: "tui" });
  const { session } = (await call(all.gui_launch, {}, ctx)).details;
  let last;
  for (let i = 0; i < 6; i++) last = await call(all.gui_act, { session, action: "click", ref: "s1:2" }, ctx);
  assert.match(textOf(last), /click on s1:2: ok/);
  assert.match(textOf(last), /usageWarning \(repeated-action\): The same action on the same target ran 6 times/);
  assert.equal(last.details.usageWarning[0].signal, "repeated-action");
  assert.ok(env.notes.some((n) => n.type === "warning" && /ran 6 times/.test(n.message)));
  assert.equal(env.spawner.children[0].requests.filter((r) => r.method === "act").length, 6, "never blocked");
});

test("S13: maxConcurrentSessions is enforced; stopping one of two sessions leaves the other usable", async (t) => {
  const env = await fakeEnv(t, { local: { limits: { maxConcurrentSessions: 2 } } });
  const all = tools(env.runtime);
  const a = (await call(all.gui_launch, {}, env.ctx())).details.session;
  const b = (await call(all.gui_launch, {}, env.ctx())).details.session;
  await assert.rejects(call(all.gui_launch, {}, env.ctx()), /at most 2 GUI sessions can run at once.*Active: gui-/);
  assert.equal(env.spawner.children.length, 2, "the refused launch started nothing");
  await call(all.gui_stop, { session: a }, env.ctx());
  const snap = await call(all.gui_snapshot, { session: b }, env.ctx());
  assert.match(textOf(snap), /coverage full/);
  assert.equal(env.state.containers.size, 1);
  const c = (await call(all.gui_launch, {}, env.ctx())).details.session;
  assert.notEqual(c, a);
});

test("S13: idle sessions are torn down after idleTimeoutMinutes; activity resets the timer", async (t) => {
  const env = await fakeEnv(t, { local: { limits: { idleTimeoutMinutes: 1 } }, manualClock: true });
  const all = tools(env.runtime);
  const ui = env.ctx({ hasUI: true, mode: "tui" });
  const { session } = (await call(all.gui_launch, {}, ui)).details;
  env.advance(50_000);
  await call(all.gui_wait, { session, for: "idle" }, ui);
  env.advance(30_000);
  assert.deepEqual(await env.runtime.reapIdle(), [], "activity 30 s ago");
  env.advance(31_000);
  assert.deepEqual(await env.runtime.reapIdle(), [session]);
  assert.ok(env.notes.some((n) => /was idle too long and was stopped/.test(n.message)));
  assert.equal(env.state.containers.size, 0);
});

test("S13: version drift makes the backend stale and points the user to /gui-doctor", async (t) => {
  const env = await fakeEnv(t, { verifiedRecord: { ...VERIFIED, toolVersions: { ...VERIFIED.toolVersions, "image.id": "sha256:old" } } });
  await assert.rejects(call(tools(env.runtime).gui_launch, {}, env.ctx()), /backend "docker-linux" changed since setup \(image\.id sha256:old → sha256:35eede09.*\); ask the user to run \/gui-doctor docker-linux/);
  assert.equal(env.spawner.children.length, 0);
});

test("a hand-off at launch fails with the spec wording and stops the session", async (t) => {
  const env = await fakeEnv(t, { behaviour: { handlers: { launch: () => ({ error: { code: "HANDOFF", message: "app exited without opening a window" } }) } } });
  await assert.rejects(call(tools(env.runtime).gui_launch, {}, env.ctx()), /app handed off to another instance.*the session was stopped/s);
  assert.deepEqual(env.runtime.list(), []);
  assert.equal(env.state.containers.size, 0);
  assert.deepEqual(await readdir(env.tmp), []);
});

test("gui_launch: explicit cmd/args/env override .pi/gui.json; non-linux targets are refused", async (t) => {
  const env = await fakeEnv(t, { shared: { launch: { cmd: "python3", args: ["app.py"], env: { A: "1" } } } });
  const all = tools(env.runtime);
  await call(all.gui_launch, { cmd: "./node_modules/.bin/electron", args: ["."], env: { B: "2" } }, env.ctx());
  const child = env.spawner.children[0];
  assert.deepEqual(child.requests.find((r) => r.method === "launch").params, { cmd: "./node_modules/.bin/electron", args: ["."], env: { A: "1", B: "2" }, cwd: "/workspace" });
  assert.ok(child.argv.includes("--shm-size"));
  await assert.rejects(call(all.gui_launch, { target: "windows" }, env.ctx()), /runs Linux apps only/);
});

test("session_shutdown path: runtime.shutdown stops every session and removes temp dirs (idempotent)", async (t) => {
  const env = await fakeEnv(t);
  const all = tools(env.runtime);
  await call(all.gui_launch, {}, env.ctx());
  await call(all.gui_launch, {}, env.ctx());
  await env.runtime.shutdown();
  await env.runtime.shutdown();
  assert.equal(env.state.containers.size, 0);
  assert.deepEqual(await readdir(env.tmp), []);
});

test("gui_stop still stops a live session after its backend became unverified (e.g. a failed /gui-doctor)", async (t) => {
  const env = await fakeEnv(t);
  const all = tools(env.runtime);
  const { session } = (await call(all.gui_launch, {}, env.ctx())).details;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(env.globalConfigPath, JSON.stringify({ version: 1, verified: {} }));
  await assert.rejects(call(all.gui_snapshot, { session }, env.ctx()), (e) => e.message === NOT_SET_UP);
  assert.match(textOf(await call(all.gui_stop, { session }, env.ctx())), /footprint audit: empty/);
  assert.equal(env.state.containers.size, 0);
});

test("Z1: helper-supplied ids never reach host paths; forged dumps and screenshots are refused", async (t) => {
  const { gzipSync } = await import("node:zlib");
  let dump = gzipSync(JSON.stringify([{ ref: "x", role: "r", name: "n", states: [] }])).toString("base64");
  const env = await fakeEnv(t, {
    behaviour: {
      handlers: {
        snapshot: () => ({ snapshotId: "../../../../tmp/pwned", coverage: "full", tree: [{ ref: "s1:0", role: "frame", name: "w", states: [] }], truncated: true }),
        snapshotFull: () => ({ tree_gz_base64: dump }),
      },
    },
  });
  const all = tools(env.runtime);
  const { session } = (await call(all.gui_launch, {}, env.ctx())).details;
  const live = env.runtime.get(session);
  const snap = await call(all.gui_snapshot, { session }, env.ctx());
  assert.equal(snap.details.path, join(live.artifactsDir, "snapshot-001.json"), "client-generated name inside the artifact dir");
  const snapshots = async () => (await readdir(live.artifactsDir)).filter((n) => n.startsWith("snapshot")).sort();
  assert.deepEqual(await snapshots(), ["snapshot-001.json"]);

  dump = gzipSync(JSON.stringify({ not: "a list" })).toString("base64");
  await assert.rejects(call(all.gui_snapshot, { session }, env.ctx()), /BAD_RESPONSE: .*tree is not an array/);
  dump = Buffer.from("not gzip").toString("base64");
  await assert.rejects(call(all.gui_snapshot, { session }, env.ctx()), /BAD_RESPONSE: .*does not unpack/);
  assert.deepEqual(await snapshots(), ["snapshot-001.json"], "nothing written for refused results");
});

test("Z1: an artifact name already present (e.g. a planted symlink) is never written through", async (t) => {
  const { symlink } = await import("node:fs/promises");
  const env = await fakeEnv(t);
  const all = tools(env.runtime);
  const { session } = (await call(all.gui_launch, {}, env.ctx())).details;
  const live = env.runtime.get(session);
  const victim = join(env.root, "victim.txt");
  await symlink(victim, join(live.artifactsDir, "screenshot-001.png"));
  await assert.rejects(call(all.gui_screenshot, { session }, env.ctx()), /EEXIST/);
  await assert.rejects(stat(victim), "the link target was not created");
});

test("Z11: drift in any recorded version (package, Pi, protocol, Docker CLI/server, image) blocks new launches; running sessions continue", async (t) => {
  const drifts = {
    "package.version": "0.0.9",
    "pi.version": "1.3.9",
    protocol: "0",
    "docker.cli": "28.0.0",
    "docker.server": "28.0.0",
    "image.base": "0.0.9",
  };
  for (const [key, recorded] of Object.entries(drifts)) {
    const env = await fakeEnv(t, { verifiedRecord: { ...VERIFIED, toolVersions: { ...VERIFIED.toolVersions, [key]: recorded } } });
    await assert.rejects(
      call(tools(env.runtime).gui_launch, {}, env.ctx()),
      (e) => e.message.includes(`changed since setup (${key} ${recorded} → `) && /ask the user to run \/gui-doctor docker-linux/.test(e.message),
      key,
    );
    assert.equal(env.spawner.children.length, 0, key);
  }

  const env = await fakeEnv(t);
  const all = tools(env.runtime);
  const { session } = (await call(all.gui_launch, {}, env.ctx())).details;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(env.globalConfigPath, JSON.stringify({ version: 1, verified: { "docker-linux": { ...VERIFIED, toolVersions: { ...VERIFIED.toolVersions, "docker.server": "28.0.0" } } } }));
  await assert.rejects(call(all.gui_launch, {}, env.ctx()), /changed since setup/);
  assert.match(textOf(await call(all.gui_snapshot, { session }, env.ctx())), /coverage full/, "the running session keeps working");
});

test("Z11: the versions setup records match what the launch-time drift check observes", async (t) => {
  const env = await fakeEnv(t, { verified: false });
  const { createGuiCommands } = await import("../../../src/commands/commands.ts");
  const commands = Object.fromEntries(createGuiCommands({ sendMessage() {} }, env.runtime).map((c) => [c.name, c]));
  await commands["gui-setup"].handler("docker-linux", env.ctx({ hasUI: true, mode: "tui" }));
  const recorded = JSON.parse(await readFile(env.globalConfigPath, "utf8")).verified["docker-linux"].toolVersions;
  const current = await env.runtime.backend("docker-linux").currentVersions();
  for (const [key, value] of Object.entries(current)) assert.equal(recorded[key], value, key);
  assert.match(textOf(await call(tools(env.runtime).gui_launch, {}, env.ctx())), /started/);
});
