import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPackageUpdates, runPackageCommand } from "../lib/package-updates.mjs";
import { validateUpdatePlanRequest } from "../lib/component-update-state.mjs";

const WEBUI = "@firstpick/pi-package-webui";
const SOURCE = `npm:${WEBUI}`;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(path.join(tmpdir(), "pi-package-updates-"));
const environment = { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
  XDG_DATA_HOME: path.join(root, "data"), npm_config_cache: path.join(root, "cache", "npm"),
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  NODE_ENV: "test", PI_OFFLINE: "1", PI_WEBUI_RPC_SUPERVISOR: "0" };

async function installed(modules) {
  const directory = path.join(modules, ...WEBUI.split("/"));
  await mkdir(directory, { recursive: true });
  // Version, settings, ownership and command capabilities are deliberately irrelevant.
  await writeFile(path.join(directory, "package.json"), "{}");
  return directory;
}

async function finished(service, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = service.getJob(id);
    if (job.phase !== "running") return job;
    await delay(10);
  }
  throw new Error(`Fixture update did not finish: ${id}`);
}

for (const requested of ["all", "webui", "pi"]) {
  assert.deepEqual(validateUpdatePlanRequest({ targets: [requested] }), { ok: true, targets: [requested] });
}
for (const invalid of [null, [], {}, { targets: [] }, { targets: ["pi", "webui"] }, { targets: ["all", "pi"] },
  { targets: ["pi", "pi"] }, { targets: ["npm"] }, { targets: [null] }, { targets: ["pi; echo bad"] },
  { targets: ["pi"], command: "npm install" }, { targets: "all" }]) {
  assert.equal(validateUpdatePlanRequest(invalid).ok, false, JSON.stringify(invalid));
}

try {
  await mkdir(environment.HOME, { recursive: true });
  for (const locations of [[], ["user"], ["global"], ["user", "global"]]) {
    const fixture = path.join(root, locations.join("-") || "neither");
    const agentDir = path.join(fixture, "agent");
    const globalModules = path.join(fixture, "global", "node_modules");
    await mkdir(agentDir, { recursive: true });
    if (locations.includes("user")) await installed(path.join(agentDir, "npm", "node_modules"));
    if (locations.includes("global")) await installed(globalModules);
    for (const requested of ["all", "webui", "pi"]) {
      const calls = [];
      const service = createPackageUpdates({ agentDir, cwd: fixture, env: environment,
        runCommand: async (command, args, options) => {
          calls.push({ command, args, options });
          return { exitCode: 0, stdout: args.join(" ") === "root -g" ? `${globalModules}\n` : "done" };
        } });
      assert.deepEqual(service.getJobs(), { all: null, webui: null, pi: null });
      if (requested === "webui" && !locations.length) {
        await assert.rejects(service.plan(requested), (error) => error.statusCode === 409 && /not installed/.test(error.message));
        assert.deepEqual(calls.map(({ args }) => args), [["root", "-g"]]);
        continue;
      }
      const plan = await service.plan(requested);
      assert.equal(plan.requested, requested);
      assert.match(plan.digest, /^[a-f0-9]{64}$/);
      assert.equal(plan.context.agentDir, agentDir);
      assert.equal(plan.context.cwd, fixture);
      assert.match(plan.warning, /Restart Web UI manually/);
      assert.equal(calls.filter(({ args }) => args.includes("update")).length, 0, "previewing and abandoning a plan never runs an update");
      if (requested === "pi") assert.equal(calls.length, 0, "Pi-only needs no npm, version or capability probes");
      assert.throws(() => service.apply(plan.transactionId, "0".repeat(64)), (error) => error.statusCode === 409);
      assert.throws(() => service.apply("missing-preview", plan.digest), (error) => error.statusCode === 404);
      // Caller mutation must not replace a server-owned command or its confirmation token.
      const original = structuredClone(plan);
      plan.targets[0].command.args.push("--arbitrary");
      service.apply(original.transactionId, original.digest);
      const job = await finished(service, original.transactionId);
      const expected = requested === "pi" ? [["pi", ["update"]]] : requested === "all"
        ? [["pi", ["update", "--all"]], ...(locations.includes("global") ? [["npm", ["update", "-g", WEBUI]]] : [])]
        : [...(locations.includes("user") ? [["pi", ["update", "--extension", SOURCE]]] : []),
          ...(locations.includes("global") ? [["npm", ["update", "-g", WEBUI]]] : [])];
      assert.deepEqual(calls.filter(({ args }) => args.includes("update")).map(({ command, args }) => [command, args]), expected);
      assert.ok(calls.every(({ options }) => options.env === environment && options.cwd === fixture && options.timeoutMs > 0));
      assert.equal(job.phase, "success");
      assert.equal(job.restartRequired, true);
      assert.deepEqual(job.verifiedTargets, [], "command exit is never labeled as installed health verification");
      assert.ok(job.receipts.every((receipt) => receipt.exitCode === 0 && receipt.status === "success"));
      assert.equal(service.getJobs()[requested].transactionId, original.transactionId);
      assert.throws(() => service.apply(original.transactionId, original.digest), (error) => error.statusCode === 409, "apply never replays an already launched preview");
      job.receipts[0].stdout = "caller mutation";
      assert.equal(service.getJob(original.transactionId).receipts[0].stdout, "done");
      assert.equal(service.running, false);
    }
  }

  // npm-global can be the same physical root as Pi user storage.
  const dedupAgent = path.join(root, "dedup-agent");
  const sharedModules = path.join(dedupAgent, "npm", "node_modules");
  await installed(sharedModules);
  const globalAlias = path.join(root, "global-modules-alias");
  await symlink(sharedModules, globalAlias, "junction");
  for (const requested of ["all", "webui"]) {
    const calls = [];
    const service = createPackageUpdates({ agentDir: dedupAgent, env: environment,
      runCommand: async (command, args) => { calls.push([command, args]); return { exitCode: 0, stdout: globalAlias }; } });
    const plan = await service.plan(requested);
    assert.equal(plan.targets.length, 1);
    assert.match(plan.refusals.join(" "), /one installation/);
    if (requested === "all") assert.equal(plan.targets[0].coveredInstallations[0].installedRoot, path.join(sharedModules, ...WEBUI.split("/")));
    service.apply(plan.transactionId, plan.digest);
    await finished(service, plan.transactionId);
    assert.equal(calls.filter(([, args]) => args.includes("update")).length, 1);
  }

  const globalOnly = path.join(root, "global-only-modules");
  await installed(globalOnly);
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const orderedCalls = [];
  const serial = createPackageUpdates({ agentDir: path.join(root, "serial-agent"), env: environment,
    runCommand: async (command, args) => {
      if (args[0] === "root") return { exitCode: 0, stdout: globalOnly };
      orderedCalls.push(command);
      if (command === "pi") { await gate; return { exitCode: 4, stderr: "self update failed" }; }
      return { exitCode: 0, stdout: "global update finished" };
    } });
  const first = await serial.plan("all");
  const second = await serial.plan("pi");
  serial.apply(first.transactionId, first.digest);
  assert.equal(serial.running, true);
  assert.equal(serial.getJobs().all.phase, "running");
  assert.throws(() => serial.apply(second.transactionId, second.digest), (error) => error.statusCode === 409);
  await assert.rejects(serial.plan("webui"), (error) => error.statusCode === 409);
  assert.deepEqual(orderedCalls, ["pi"], "global Web UI waits for the Pi command to close");
  releaseFirst();
  const partial = await finished(serial, first.transactionId);
  assert.equal(partial.phase, "partial");
  assert.deepEqual(partial.receipts.map(({ exitCode }) => exitCode), [4, 0]);
  assert.deepEqual(orderedCalls, ["pi", "npm"], "a failed command has no retry or alternate command");
  assert.match(partial.error, /command exited 4/);
  serial.apply(second.transactionId, second.digest);
  const failed = await finished(serial, second.transactionId);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.restartRequired, false);
  assert.equal(serial.getJobs().all.transactionId, first.transactionId, "pi jobs preserve the all result");
  assert.equal(serial.getJobs().pi.transactionId, second.transactionId);
  const webui = await serial.plan("webui");
  serial.apply(webui.transactionId, webui.digest);
  await finished(serial, webui.transactionId);
  assert.deepEqual(Object.fromEntries(Object.entries(serial.getJobs()).map(([key, job]) => [key, job.transactionId])),
    { all: first.transactionId, webui: webui.transactionId, pi: second.transactionId }, "each mode retains its own last launched result");

  const detectionFailure = createPackageUpdates({ agentDir: dedupAgent, env: environment,
    runCommand: async () => ({ exitCode: 1, stdout: "/unusable", stderr: "no npm" }) });
  const userDespiteNpmFailure = await detectionFailure.plan("webui");
  assert.deepEqual(userDespiteNpmFailure.targets.map(({ id }) => id), ["webui:pi-user"]);
  assert.match(userDespiteNpmFailure.refusals.join(" "), /could not be detected/);
  const emptyPackage = path.join(root, "empty-package-agent");
  await mkdir(path.join(emptyPackage, "npm", "node_modules", ...WEBUI.split("/")), { recursive: true });
  const absent = createPackageUpdates({ agentDir: emptyPackage, env: environment,
    runCommand: async () => ({ exitCode: 0, stdout: path.join(root, "absent-global") }) });
  await assert.rejects(absent.plan("webui"), (error) => error.statusCode === 409);
  await assert.rejects(absent.plan("arbitrary"), (error) => error.statusCode === 400);

  // Exercise real process handling with disposable Node scripts, never package managers.
  const processScript = path.join(root, "fake-process.mjs");
  await writeFile(processScript, `console.log('x'.repeat(20000)); console.error('password=super-secret'); console.log(process.env.FIXTURE_API_TOKEN); process.exitCode = 7;`);
  const realEnv = { ...environment, FIXTURE_API_TOKEN: "fixture-private-value" };
  const output = await runPackageCommand(process.execPath, [processScript], { cwd: root, env: realEnv, timeoutMs: 2_000 });
  assert.equal(output.exitCode, 7);
  assert.ok(output.stdout.length <= 16_000 && output.stderr.length <= 16_000);
  assert.doesNotMatch(output.stdout, /fixture-private-value/);
  assert.doesNotMatch(output.stderr, /super-secret/);
  assert.match(output.stderr, /redacted/);
  const missing = await runPackageCommand(path.join(root, "missing-command"), [], { cwd: root, env: environment, timeoutMs: 2_000 });
  assert.match(missing.error, /ENOENT/);
  await writeFile(processScript, `setInterval(() => {}, 1000);`);
  const started = Date.now();
  const timedOut = await runPackageCommand(process.execPath, [processScript], { cwd: root, env: environment, timeoutMs: 100 });
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.error, /timed out/);
  assert.ok(Date.now() - started < 4_000, "timeout closes the disposable child promptly");
  if (process.platform !== "win32") {
    const marker = path.join(root, "unwanted-descendant-output");
    const descendant = path.join(root, "fake-descendant.mjs");
    await writeFile(descendant, `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'still running'), 800);`);
    await writeFile(processScript, `import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' });
setInterval(() => {}, 1000);`);
    const tree = await runPackageCommand(process.execPath, [processScript], { cwd: root, env: environment, timeoutMs: 200 });
    assert.equal(tree.timedOut, true);
    await delay(1_000);
    await assert.rejects(readFile(marker), { code: "ENOENT" }, "timeout also terminates package-command descendants");
  }
  const timeoutService = createPackageUpdates({ agentDir: dedupAgent, env: environment,
    runCommand: async () => timedOut });
  const timeoutPlan = await timeoutService.plan("pi");
  timeoutService.apply(timeoutPlan.transactionId, timeoutPlan.digest);
  const timeoutJob = await finished(timeoutService, timeoutPlan.transactionId);
  assert.equal(timeoutJob.phase, "failed");
  assert.equal(timeoutJob.receipts[0].timedOut, true);

  await httpFlow();
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
console.log("package-updates.test.mjs passed");

async function httpFlow() {
  const fixture = path.join(root, "http");
  const agentDir = path.join(fixture, "agent");
  const prefix = path.join(fixture, "prefix");
  const modules = path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules");
  const piRoot = path.join(modules, "@earendil-works", "pi-coding-agent");
  const bin = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const cli = path.join(piRoot, "dist", "cli.js");
  const npmCli = path.join(fixture, "fake-npm.mjs");
  const log = path.join(fixture, "commands.jsonl");
  await mkdir(path.dirname(cli), { recursive: true });
  await mkdir(bin, { recursive: true });
  await installed(modules);
  await installed(path.join(agentDir, "npm", "node_modules"));
  await writeFile(path.join(piRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.8.7", bin: { pi: "dist/cli.js" } }));
  await writeFile(cli, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('9.8.7'); process.exit(0); }
if (args[0] === 'update') { appendFileSync(${JSON.stringify(log)}, JSON.stringify(['pi', args]) + '\\n'); await new Promise(r => setTimeout(r, 250)); process.exit(0); }
await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, "tests", "fixtures", "fake-pi.mjs")).href)});
` , { mode: 0o755 });
  if (process.platform === "win32") await writeFile(path.join(bin, "pi.cmd"), `@echo off\r\nnode "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*\r\n`);
  else await symlink(cli, path.join(bin, "pi"));
  await writeFile(npmCli, `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.join(' ') === 'root -g') { console.log(${JSON.stringify(modules)}); process.exit(0); }
appendFileSync(${JSON.stringify(log)}, JSON.stringify(['npm', args]) + '\\n'); process.exitCode = 5;
`);
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(packageRoot, "bin", "pi-webui.mjs"), "--cwd", fixture,
    "--host", "127.0.0.1", "--port", String(port), "--pi", cli], {
    env: { ...environment, PATH: `${bin}${path.delimiter}${environment.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir,
      PI_WEBUI_SETTINGS_FILE: path.join(fixture, "settings.json"), PI_WEBUI_NPM_BIN: npmCli,
      PI_WEBUI_UPDATE_TEST_HOME: fixture, PI_WEBUI_SESSION_SUMMARY_DIR: path.join(fixture, "summary") }, stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  child.stdout.on("data", (chunk) => { serverOutput += chunk; });
  child.stderr.on("data", (chunk) => { serverOutput += chunk; });
  const api = async (route, body) => {
    const response = await fetch(base + route, { ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000) });
    return { status: response.status, body: await response.json() };
  };
  try {
    let bootIdentity;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(serverOutput);
      try {
        const health = await api("/api/health");
        if (health.status === 200) { bootIdentity = health.body.bootIdentity; break; }
      } catch {}
      await delay(100);
    }
    assert.ok(bootIdentity, serverOutput);
    const initial = await api("/api/update-status");
    assert.deepEqual(initial.body.data.nativeJobs, { all: null, webui: null, pi: null });
    assert.equal(initial.body.data.canRunUpdate, true);
    assert.equal((await api("/api/update/plan", { targets: ["pi", "webui"] })).status, 400);
    assert.equal((await api("/api/update/plan", { targets: ["all"], command: "arbitrary" })).status, 400);
    const result = await api("/api/update/plan", { targets: ["all"] });
    assert.equal(result.status, 201, JSON.stringify(result) + serverOutput);
    const plan = result.body.data.plan;
    assert.deepEqual(plan.targets.map(({ id }) => id), ["pi", "webui:npm-global"]);
    await assert.rejects(readFile(log), { code: "ENOENT" }, "opening a preview makes no package changes");
    assert.equal((await api("/api/update/apply", { transactionId: plan.transactionId, planDigest: "0".repeat(64) })).status, 409);
    const apply = await api("/api/update/apply", { transactionId: plan.transactionId, planDigest: plan.digest });
    assert.equal(apply.status, 202, JSON.stringify(apply));
    assert.equal(apply.body.data.transactionId, plan.transactionId);
    assert.equal((await api("/api/update-status")).body.data.canRunUpdate, false);
    let completed;
    for (let attempt = 0; attempt < 100; attempt++) {
      completed = (await api(`/api/update/transactions/${plan.transactionId}`)).body.data;
      if (completed.phase !== "running") break;
      await delay(20);
    }
    assert.equal(completed.phase, "partial", JSON.stringify(completed));
    assert.deepEqual(completed.receipts.map(({ exitCode }) => exitCode), [0, 5]);
    assert.deepEqual(completed.verifiedTargets, []);
    assert.equal(completed.restartRequired, true);
    assert.match(completed.message, /Restart Web UI manually/);
    assert.equal((await api("/api/health")).body.bootIdentity, bootIdentity, "successful commands never restart the server");
    const status = (await api("/api/update-status")).body.data;
    assert.equal(status.nativeJobs.all.transactionId, plan.transactionId);
    assert.equal(status.nativeJobs.all.phase, "partial");
    assert.equal(status.nativeJobs.pi, null);
    assert.equal(status.nativeJobs.webui, null);
    assert.equal(status.canRunUpdate, true);
    assert.equal(status.restartRequired, true);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").map(JSON.parse), [
      ["pi", ["update", "--all"]], ["npm", ["update", "-g", WEBUI]],
    ]);
    assert.equal((await api("/api/update/apply", { transactionId: plan.transactionId, planDigest: plan.digest })).status, 409);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(6_000)]);
      if (child.exitCode === null) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve)); }
    }
  }
}
