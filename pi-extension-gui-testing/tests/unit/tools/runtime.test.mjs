import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import guiTesting from "../../../index.ts";
import { createGuiTools } from "../../../src/tools/tools.ts";
import { fakeEnv } from "../backends/env.mjs";

test("the extension factory registers 8 tools, 7 commands, and 2 lifecycle handlers, and starts nothing", () => {
  const registered = { tools: [], commands: [], events: [] };
  const exitListeners = process.listenerCount("exit");
  const handles = process.getActiveResourcesInfo().length;
  guiTesting({
    registerTool: (tool) => registered.tools.push(tool.name),
    registerCommand: (name) => registered.commands.push(name),
    on: (event) => registered.events.push(event),
    sendMessage: () => assert.fail("no message from the factory"),
  });
  assert.deepEqual(registered.tools, ["gui_launch", "gui_wait", "gui_snapshot", "gui_screenshot", "gui_act", "gui_logs", "gui_stop", "gui_export"]);
  assert.deepEqual(registered.commands, ["gui-setup", "gui-doctor", "gui-backend", "gui-usage", "gui-cleanup", "gui-reset", "gui-export"]);
  assert.deepEqual(registered.events, ["session_start", "session_shutdown"]);
  assert.equal(process.listenerCount("exit"), exitListeners, "no exit handler until a session exists");
  assert.equal(process.getActiveResourcesInfo().length, handles, "no timers, sockets, or processes");
});

test("the exit handler exists only while a session runs, and knows how to force-remove its container", async (t) => {
  const env = await fakeEnv(t);
  const tools = Object.fromEntries(createGuiTools(env.runtime).map((x) => [x.name, x]));
  const before = process.listenerCount("exit");
  const { session } = (await tools.gui_launch.execute("c", {}, undefined, undefined, env.ctx())).details;
  assert.equal(process.listenerCount("exit"), before + 1);
  const live = env.runtime.get(session);
  assert.deepEqual(live.session.forceRemoveArgv(), ["docker", "--host", "unix:///var/run/docker.sock", "rm", "-f", `pi-gui-testing-${session}`]);
  await tools.gui_stop.execute("c", { session }, undefined, undefined, env.ctx());
  assert.equal(process.listenerCount("exit"), before);
});

test("Z8: startup sweep removes a dead owner's temp dir; the Docker sweep runs whenever docker is on PATH, verified or not, and never otherwise", async (t) => {
  const bootId = (await import("node:fs")).readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  // Same boot, PID 1 with an impossible start time → the owner is gone.
  const deadOwner = `x:1:999999999999:${bootId}`;

  const noDocker = await fakeEnv(t, { dockerOnPath: false });
  const dead = join(noDocker.tmp, "pi-gui-testing-dead01");
  await mkdir(dead);
  await writeFile(join(dead, "owner.json"), JSON.stringify({ version: 1, pid: 1, processStartTime: "999999999999", bootId, clientId: "x", piSessionId: "", backend: "docker-linux", createdAt: "2026-10-24T00:00:00Z", resources: [{ kind: "container", id: "pi-gui-testing-dead01" }] }));
  const malformed = join(noDocker.tmp, "pi-gui-testing-bad001");
  await mkdir(malformed);
  const report = await noDocker.runtime.sweep(noDocker.project);
  assert.deepEqual(report.removedDirs, [dead]);
  assert.equal(report.unknown.length, 1, "a dir without owner.json is reported, never removed");
  assert.deepEqual((await readdir(noDocker.tmp)).sort(), ["pi-gui-testing-bad001"]);
  assert.ok(!noDocker.runner.commands().some((c) => c.startsWith("docker")), "no docker command on a host without a docker executable, even though docker-linux is verified");

  // Not verified (e.g. after /gui-reset or a failed doctor), but docker is on PATH: orphans are still swept.
  const unverified = await fakeEnv(t, { verified: false, dockerOnPath: true });
  unverified.state.containers.set("pi-gui-testing-dead02", { id: "id-dead02", session: "dead02", owner: deadOwner, inspect: {} });
  await unverified.runtime.sweep(unverified.project);
  assert.deepEqual(unverified.state.removed, ["id-dead02"], "labelled container of a dead owner removed without a verified record or temp dir");

  // A daemon error is reported in the sweep, never thrown at startup.
  const broken = await fakeEnv(t, { dockerOnPath: true, docker: { contextHost: "tcp://remote:2375" } });
  const brokenReport = await broken.runtime.sweep(broken.project);
  assert.ok(brokenReport.leftovers.some((l) => l.kind === "sweeper"), JSON.stringify(brokenReport));
});
