/**
 * e2e lifecycle (plan §8 "e2e lifecycle"): S7 crash cases (a) SIGKILL of the
 * Pi process, (b) restart sweep, (c) SIGSTOP with a shortened heartbeat; two
 * concurrent sessions; idle timeout; setup cancelled after it created
 * resources; owner-label PID reuse without a temp dir; and a real `pi` exit.
 *
 *   npm run test:e2e -- tests/e2e/lifecycle.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGuiCommands } from "../../src/commands/commands.ts";
import { createOwnerIdentity } from "../../src/cleanup/identity.ts";
import { formatOwnerLabel } from "../../src/owner.ts";
import { GuiRuntime } from "../../src/tools/runtime.ts";
import { dockerCreateArgs, writeIdentityFiles } from "../../src/backends/docker/run-args.ts";
import { ctx, docker, dockerSkipReason, e2eRuntime, FIXTURES, labelled, ownedContainers, PACKAGE_ROOT, processAlive, project, run, textOf, waitFor } from "./harness.mjs";

const skip = dockerSkipReason();
const SMOKE = { cmd: "python3", args: ["/opt/pi-gui-testing/testapps/gtk3-smoke/app.py"] };

/** Starts the Pi stand-in (fixtures/host.mjs) and resolves with its ready line. */
async function startHost(t, env, options = {}) {
  const cwd = await project(env.root, { "README.md": "x\n" });
  const child = spawn(process.execPath, ["--experimental-strip-types", join(FIXTURES, "host.mjs"), JSON.stringify({ project: cwd, tmpRoot: env.tmp, globalConfigPath: env.globalConfigPath, ...options })], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => {
    try {
      process.kill(child.pid, "SIGCONT");
      child.kill("SIGKILL");
    } catch {}
  });
  const lines = createInterface({ input: child.stdout });
  const next = () => new Promise((resolve) => lines.once("line", (line) => resolve(JSON.parse(line))));
  const ready = await next();
  assert.equal(ready.ready, true, ready.error);
  return { child, ready, next, send: (line) => child.stdin.write(`${line}\n`) };
}

test("S7 (a)+(b): SIGKILL of Pi → container and docker CLI gone within 15 s via helper EOF; restart sweep removes the temp dir; audit empty", { skip, timeout: 10 * 60_000 }, async (t) => {
  const env = await e2eRuntime(t);
  const host = await startHost(t, env);
  assert.equal(labelled(host.ready.session).length, 1);
  host.child.kill("SIGKILL");
  const gone = await waitFor(() => labelled(host.ready.session).length === 0 && !processAlive(host.ready.cliPid), 15_000);
  assert.ok(gone !== undefined, "container or docker CLI still present 15 s after SIGKILL");
  t.diagnostic(`(a) container and CLI gone ${gone} ms after SIGKILL`);
  assert.ok(existsSync(host.ready.dir), "(a) allows the client temp dir to remain until the next start");

  // (b) "Pi restarts": a fresh runtime runs the startup sweep.
  const restarted = new GuiRuntime({ tmpRoot: env.tmp, globalConfigPath: env.globalConfigPath });
  const report = await restarted.sweep(env.root);
  assert.ok(report.removedDirs.includes(host.ready.dir));
  assert.deepEqual(await restarted.auditOrphans("docker-linux", new AbortController().signal), []);
  assert.deepEqual((await readdir(env.tmp)).filter((n) => n.startsWith("pi-gui-testing-")), []);
});

test("S7 (c): SIGSTOP of Pi with a 3 s test heartbeat → helper tears down via the heartbeat path; after SIGCONT the audit is empty", { skip, timeout: 10 * 60_000 }, async (t) => {
  const env = await e2eRuntime(t);
  const host = await startHost(t, env, { heartbeatTimeoutMs: 3000 });
  process.kill(host.child.pid, "SIGSTOP");
  const gone = await waitFor(() => labelled(host.ready.session).length === 0, 30_000);
  assert.ok(gone !== undefined, "container still present 30 s into a stopped client");
  assert.ok(gone >= 2_000, `container ended after ${gone} ms, before the heartbeat timeout`);
  t.diagnostic(`(c) container gone ${gone} ms after SIGSTOP`);
  process.kill(host.child.pid, "SIGCONT");
  host.send(`stop ${host.ready.session}`);
  const stopped = await host.next();
  t.diagnostic(JSON.stringify(stopped));
  host.send("exit");
  await host.next();
  await waitFor(() => !processAlive(host.child.pid), 10_000);
  assert.equal(existsSync(host.ready.dir), false);
  assert.deepEqual(labelled(host.ready.session), []);
  assert.equal(processAlive(host.ready.cliPid), false);
});

test("S13: two live sessions; stopping one leaves the other usable and its own audit clean", { skip, timeout: 10 * 60_000 }, async (t) => {
  const env = await e2eRuntime(t);
  const context = ctx(await project(env.root, { "a.txt": "a\n" }));
  const a = (await run(env.tools.gui_launch, SMOKE, context)).details.session;
  const b = (await run(env.tools.gui_launch, SMOKE, context)).details.session;
  await assert.rejects(run(env.tools.gui_launch, SMOKE, context), /at most 2 GUI sessions/);
  assert.match(textOf(await run(env.tools.gui_stop, { session: a }, context)), /footprint audit: empty/);
  assert.deepEqual(labelled(a), []);
  assert.equal(labelled(b).length, 1);
  assert.match(textOf(await run(env.tools.gui_snapshot, { session: b }, context)), /coverage full/);
  await run(env.tools.gui_stop, { session: b }, context);
  assert.deepEqual(labelled(b), []);
});

test("S13: an idle session is torn down after idleTimeoutMinutes", { skip, timeout: 10 * 60_000 }, async (t) => {
  let clock = Date.now();
  const env = await e2eRuntime(t, { now: () => clock });
  const context = ctx(await project(env.root, { "a.txt": "a\n" }));
  const { session } = (await run(env.tools.gui_launch, SMOKE, context)).details;
  clock += 15 * 60_000 + 1;
  assert.deepEqual(await env.runtime.reapIdle(), [session]);
  assert.deepEqual(labelled(session), []);
  await assert.rejects(run(env.tools.gui_snapshot, { session }, context), /unknown GUI session/);
});

test("S13: /gui-cleanup cancels a setup after it created resources; no container, temp dir, or verified state remains", { skip, timeout: 20 * 60_000 }, async (t) => {
  const env = await e2eRuntime(t, { verified: false });
  const messages = [];
  const commands = Object.fromEntries(createGuiCommands({ sendMessage: (m) => messages.push(m) }, env.runtime).map((c) => [c.name, c]));
  const context = ctx(env.root, { hasUI: true, mode: "rpc" });
  // The label of this runtime's owner (a fresh identity would carry another client id and never match).
  const owner = env.runtime.ownerLabel();
  const setup = commands["gui-setup"].handler("docker-linux --fix", context);
  const created = await waitFor(() => ownedContainers(owner).length > 0, 120_000, 100);
  assert.ok(created !== undefined, "setup never created a container with this runtime's owner label");
  assert.notEqual(ownedContainers(owner).length, 0, "resources existed before the cancel");
  await commands["gui-cleanup"].handler("", context);
  await setup;
  assert.match(messages.find((m) => /GUI testing setup/.test(m.content)).content, /— cancelled/);
  assert.match(messages.find((m) => /GUI testing cleanup/.test(m.content)).content, /cancelled the running \/gui-setup/);
  assert.equal(await waitFor(() => ownedContainers(owner).length === 0, 20_000) !== undefined, true);
  assert.deepEqual((await readdir(env.tmp)).filter((n) => n.startsWith("pi-gui-testing-")), []);
  assert.equal(existsSync(env.globalConfigPath), false);
});

test("owner-label PID reuse without a temp dir: the sweep removes a dead owner's container and keeps a live owner's", { skip, timeout: 10 * 60_000 }, async (t) => {
  const env = await e2eRuntime(t);
  const identity = createOwnerIdentity();
  const dir = await mkdtemp(join(tmpdir(), "gui-e2e-reuse-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeIdentityFiles(dir, process.getuid(), process.getgid());
  await mkdir(join(dir, "workspace"));
  const create = (session, ownerLabel) => {
    const args = dockerCreateArgs({ sessionId: session, ownerLabel, image: env.backend.imageTag, uid: process.getuid(), gid: process.getgid(), sessionDir: dir, workspace: { source: join(dir, "workspace"), readOnly: true }, network: "none" });
    const result = docker(args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  // Same PID and boot as this live process, but another start time: a reused PID.
  const reused = create(`e2e-reuse-${process.pid}`, `${identity.clientId}x:${identity.pid}:${Number(identity.processStartTime) + 1}:${identity.bootId}`);
  const live = create(`e2e-live-${process.pid}`, formatOwnerLabel(identity));
  t.after(() => docker(["rm", "-f", reused, live]));
  const report = await env.runtime.sweepNow(["docker-linux"], new AbortController().signal);
  assert.deepEqual(report.leftovers, []);
  assert.deepEqual(labelled(`e2e-reuse-${process.pid}`), []);
  assert.equal(labelled(`e2e-live-${process.pid}`).length, 1, "a live owner's container is never swept");
});

/** Why the real-Pi tests cannot run here, or `undefined`. */
function piSkipReason() {
  if (skip) return skip;
  const version = spawnSync("pi", ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) return "pi not on PATH";
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(`${version.stdout} ${version.stderr}`);
  if (!found) return `cannot read the Pi version from: ${version.stdout.trim()}`;
  const [major, minor] = [Number(found[1]), Number(found[2])];
  if (major < 1 || (major === 1 && minor < 4)) return `Pi ${found[0]} is older than 1.4.0`;
  return undefined;
}
const piSkip = piSkipReason();

function runPi(args, options) {
  return spawnSync("pi", args, { encoding: "utf8", input: "", timeout: 15 * 60_000, ...options });
}

test("S7/S15: a real `pi -p /gui-doctor` run exits, reports on stderr, and leaves nothing labelled", { skip: piSkip, timeout: 20 * 60_000 }, async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "gui-e2e-agent-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const before = labelled();
  const result = runPi(["-e", join(PACKAGE_ROOT, "index.ts"), "-p", "/gui-doctor docker-linux"], { cwd: PACKAGE_ROOT, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
  t.diagnostic(result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /GUI testing doctor: docker-linux — (verified|failed)/);
  assert.equal(result.status, /— verified/.test(result.stderr) ? 0 : 1);
  assert.deepEqual(labelled().filter((id) => !before.includes(id)), []);
});

test("S7 (real Pi): Pi exits with a live session; its container, docker CLI, and temp dir are gone afterwards", { skip: piSkip, timeout: 30 * 60_000 }, async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "gui-e2e-agent-"));
  const work = await mkdtemp(join(tmpdir(), "gui-e2e-pi-"));
  t.after(async () => {
    await rm(agentDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });
  const cwd = await project(work, { "README.md": "x\n" });
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  // Prerequisite: doctor verifies docker-linux in this agent dir (as setup would); otherwise skip with its reason.
  const doctor = runPi(["-e", join(PACKAGE_ROOT, "index.ts"), "-p", "/gui-doctor docker-linux"], { cwd, env });
  if (!/— verified/.test(doctor.stderr)) {
    const reason = doctor.stderr.split("\n").find((l) => /^GUI testing doctor|smoke test failed|required checks/.test(l)) ?? doctor.stderr.trim().split("\n").at(-1);
    t.skip(`/gui-doctor did not verify docker-linux on this host: ${reason}`);
    return;
  }
  const result = runPi(["-e", join(FIXTURES, "gui-live-session-extension.ts"), "-p", "/e2e-gui-launch"], { cwd, env });
  t.diagnostic(result.stderr);
  const line = /E2E-GUI-SESSION (\{.*\})/.exec(result.stderr);
  assert.ok(line, `the fixture did not start a session:\n${result.stderr}`);
  const info = JSON.parse(line[1]);
  assert.equal(info.open, true, "the session was live when Pi began to exit");
  assert.ok(info.cliPid > 0 && info.container && info.dir);
  // Pi has exited (spawnSync returned): its shutdown (or the exit handler) must have removed everything.
  const gone = await waitFor(() => labelled(info.session).length === 0 && !processAlive(info.cliPid) && !existsSync(info.dir), 20_000);
  assert.ok(gone !== undefined, `left behind: container ${JSON.stringify(labelled(info.session))}, CLI alive ${processAlive(info.cliPid)}, temp dir ${existsSync(info.dir)}`);
  t.diagnostic(`cleanup finished ${gone} ms after Pi exited`);
});
