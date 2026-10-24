/**
 * Process-level integration without Docker: the real spawn runner and spawner
 * drive a fake `docker` executable on PATH (fixtures/fake-docker.mjs). This
 * covers what unit fakes cannot: argv through real processes, the binary
 * build context on a real pipe, the framing token in the CLI environment,
 * and stdin-EOF teardown when the Pi process is SIGKILLed (S7 (a) analogue).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { createGuiCommands } from "../../../src/commands/commands.ts";
import { GuiRuntime } from "../../../src/tools/runtime.ts";
import { createGuiTools } from "../../../src/tools/tools.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The versions setup records against the fake docker (what currentVersions reports). */
const versions = (imageId) => ({ "package.version": "0.1.0", "pi.version": PI_VERSION, protocol: "2", "docker.cli": "29.9.1", "docker.server": "29.9.1", "image.base": "0.1.0", "image.id": imageId });

async function withFakeDocker(t) {
  const root = await mkdtemp(join(tmpdir(), "gui-fake-docker-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  const tmp = join(root, "tmp");
  await mkdir(bin);
  await mkdir(state);
  await mkdir(tmp);
  await writeFile(join(bin, "docker"), `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types --no-warnings "${join(HERE, "fixtures", "fake-docker.mjs")}" "${state}" "$@"\n`);
  await chmod(join(bin, "docker"), 0o755);
  const path = process.env.PATH;
  const dockerHost = process.env.DOCKER_HOST;
  process.env.PATH = `${bin}:${path}`;
  delete process.env.DOCKER_HOST;
  t.after(async () => {
    process.env.PATH = path;
    if (dockerHost !== undefined) process.env.DOCKER_HOST = dockerHost;
    await rm(root, { recursive: true, force: true });
  });
  const containers = async () => readdir(join(state, "containers")).catch(() => []);
  return { root, bin, state, tmp, containers, globalConfigPath: join(root, "agent", "gui", "config.json") };
}

test("real processes: /gui-setup --fix streams the build context, passes every check and the smoke test, and leaves no container", { timeout: 180_000 }, async (t) => {
  const env = await withFakeDocker(t);
  const runtime = new GuiRuntime({ tmpRoot: env.tmp, globalConfigPath: env.globalConfigPath, docker: { common: { piVersion: "1.4.0", configDir: env.root, diskPath: env.root, minFreeBytes: 1 } } });
  t.after(() => runtime.shutdown());
  const messages = [];
  const commands = Object.fromEntries(createGuiCommands({ sendMessage: (m) => messages.push(m) }, runtime).map((c) => [c.name, c]));
  const prompts = [];
  const ui = { notify() {}, setStatus() {}, select: async (...a) => (prompts.push(a), undefined), confirm: async (...a) => (prompts.push(a), false), input: async () => undefined };
  await commands["gui-setup"].handler("docker-linux --fix", { cwd: env.root, hasUI: true, mode: "tui", ui, sessionManager: { getSessionId: () => "pi" } });
  assert.deepEqual(prompts, []);
  assert.match(messages[0].content, /— verified/, messages[0].content);
  assert.match(messages[0].content, /Fixes applied:\n- image\.base: ok/);
  assert.ok(Number(await readFile(join(env.state, "build-context-bytes"), "utf8")) > 10_000, "the staged context went through stdin");
  assert.deepEqual(await env.containers(), []);
  assert.deepEqual(await readdir(env.tmp), []);
});

test("real processes: SIGKILL of the Pi process ends the session container through stdin EOF; the next start sweeps the temp dir", { timeout: 180_000 }, async (t) => {
  const env = await withFakeDocker(t);
  await mkdir(dirname(env.globalConfigPath), { recursive: true });
  await writeFile(join(env.state, "image.json"), JSON.stringify({ Id: `sha256:${"cd".repeat(32)}`, Architecture: "amd64", Config: { Labels: { "pi-gui-testing.base": "true", "pi-gui-testing.version": "0.1.0", "pi-gui-testing.protocol": "2" } } }));
  await writeFile(env.globalConfigPath, JSON.stringify({ version: 1, verified: { "docker-linux": { verifiedAt: "2026-10-24T00:00:00Z", toolVersions: versions(`sha256:${"cd".repeat(32)}`), checksPassed: [] } } }));
  const project = join(env.root, "project");
  await mkdir(project);
  const host = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(HERE, "..", "..", "e2e", "fixtures", "host.mjs"), JSON.stringify({ project, tmpRoot: env.tmp, globalConfigPath: env.globalConfigPath })], {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });
  t.after(() => host.kill("SIGKILL"));
  const ready = JSON.parse(await new Promise((resolve) => createInterface({ input: host.stdout }).once("line", resolve)));
  assert.equal(ready.ready, true, ready.error);
  assert.deepEqual(await env.containers(), [`${ready.container}.json`]);
  const saved = JSON.parse(await readFile(join(env.state, "containers", `${ready.container}.json`), "utf8"));
  assert.match(saved.env.PI_GUI_TESTING_TOKEN, /^[0-9a-f]{32}$/, "token reached the docker CLI through its environment");
  assert.ok(!saved.argv.join(" ").includes(saved.env.PI_GUI_TESTING_TOKEN), "token not in argv");

  host.kill("SIGKILL");
  const started = Date.now();
  while ((await env.containers()).length > 0 && Date.now() - started < 15_000) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(await env.containers(), [], "container gone after the Pi process died");
  let cliAlive = true;
  try {
    process.kill(ready.cliPid, 0);
  } catch {
    cliAlive = false;
  }
  assert.equal(cliAlive, false, "no orphaned docker CLI");
  assert.deepEqual(await readdir(env.tmp), [ready.dir.split("/").at(-1)], "the temp dir may remain until the next start");

  const restarted = new GuiRuntime({ tmpRoot: env.tmp, globalConfigPath: env.globalConfigPath });
  const report = await restarted.sweep(project);
  assert.deepEqual(report.removedDirs, [ready.dir]);
  assert.deepEqual(await readdir(env.tmp), []);
  assert.deepEqual(await restarted.auditOrphans("docker-linux", new AbortController().signal), []);
});

test("real processes: tools over the real stdio protocol, then gui_stop with an empty audit", { timeout: 180_000 }, async (t) => {
  const env = await withFakeDocker(t);
  await mkdir(dirname(env.globalConfigPath), { recursive: true });
  await writeFile(join(env.state, "image.json"), JSON.stringify({ Id: "sha256:ee", Architecture: "amd64", Config: { Labels: { "pi-gui-testing.base": "true", "pi-gui-testing.version": "0.1.0", "pi-gui-testing.protocol": "2" } } }));
  await writeFile(env.globalConfigPath, JSON.stringify({ version: 1, verified: { "docker-linux": { verifiedAt: "x", toolVersions: versions("sha256:ee"), checksPassed: [] } } }));
  const project = join(env.root, "project");
  await mkdir(project);
  const runtime = new GuiRuntime({ tmpRoot: env.tmp, globalConfigPath: env.globalConfigPath });
  t.after(() => runtime.shutdown());
  const tools = Object.fromEntries(createGuiTools(runtime).map((x) => [x.name, x]));
  const ctx = { cwd: project, hasUI: false, mode: "print", sessionManager: { getSessionId: () => "pi" }, ui: { notify() {}, setStatus() {} } };
  const { session } = (await tools.gui_launch.execute("c", { cmd: "python3", args: ["app.py"] }, undefined, undefined, ctx)).details;
  const shot = await tools.gui_screenshot.execute("c", { session }, undefined, undefined, ctx);
  assert.ok(shot.content.some((c) => c.type === "image"));
  const stop = await tools.gui_stop.execute("c", { session }, undefined, undefined, ctx);
  assert.match(stop.content[0].text, /footprint audit: empty/);
  assert.deepEqual(await env.containers(), []);
});
