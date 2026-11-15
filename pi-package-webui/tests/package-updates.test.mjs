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

  await progressFlow(globalOnly);
  await classificationFlow(globalOnly, dedupAgent);
  await streamedOutputFlow(processScript);
  await httpFlow();
  await httpFlow(true);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
console.log("package-updates.test.mjs passed");

async function progressFlow(globalModules) {
  const steps = [];
  const service = createPackageUpdates({ agentDir: path.join(root, "progress-agent"), env: environment,
    runCommand: (command, args, { onOutput }) => {
      if (args[0] === "root") return { exitCode: 0, stdout: globalModules };
      return new Promise((resolve) => steps.push({ command, onOutput, resolve }));
    } });
  const plan = await service.plan("all");
  assert.equal(service.getJob(plan.transactionId).progress, undefined, "abandoning a preview starts no progress or command");
  service.apply(plan.transactionId, plan.digest);
  const read = () => service.getJob(plan.transactionId);
  const initial = read().progress;
  assert.deepEqual({ ...initial, startedAt: "ISO", stepStartedAt: "ISO" }, {
    totalSteps: 2, completedSteps: 0, currentTargetId: "pi", startedAt: "ISO", stepStartedAt: "ISO", stdout: "", stderr: "",
  });
  assert.equal(new Date(initial.startedAt).toISOString(), initial.startedAt);
  assert.equal(new Date(initial.stepStartedAt).toISOString(), initial.stepStartedAt);
  steps[0].onOutput({ stdout: "x".repeat(20_000) + "\npassword=fixture-password", stderr: "token=fixture-token" });
  const live = read().progress;
  assert.equal(read().phase, "running");
  assert.ok(live.stdout.length <= 16_000 && live.stderr.length <= 16_000);
  assert.doesNotMatch(JSON.stringify(live), /fixture-password|fixture-token/);
  assert.match(live.stdout, /redacted/);
  live.stdout = "caller mutation";
  assert.notEqual(read().progress.stdout, live.stdout);
  steps[0].resolve({ exitCode: 0, stdout: "Pi command completed" });
  await delay(0);
  const next = read();
  assert.equal(steps.length, 2);
  assert.deepEqual([next.progress.completedSteps, next.progress.currentTargetId, next.progress.stdout, next.progress.stderr], [1, "webui:npm-global", "", ""]);
  assert.equal(next.progress.startedAt, initial.startedAt);
  assert.ok(next.progress.stepStartedAt >= initial.stepStartedAt);
  assert.equal(next.receipts[0].startedAt, initial.stepStartedAt);
  assert.ok(next.receipts[0].at >= next.receipts[0].startedAt);
  steps[0].onOutput({ stdout: "late output", stderr: "" });
  assert.equal(read().progress.stdout, "", "settled command callbacks cannot overwrite the next step");
  steps[1].onOutput({ stdout: "npm working\n", stderr: "" });
  assert.equal(service.getJobs().all.progress.stdout, "npm working\n");
  steps[1].resolve({ exitCode: 1, stderr: "npm failed" });
  const completed = await finished(service, plan.transactionId);
  assert.equal(completed.phase, "partial");
  assert.equal(completed.progress.completedSteps, 2, "failed steps also settle");
  assert.equal(completed.progress.currentTargetId, null);
  assert.equal(completed.progress.stderr, "npm failed");
  assert.equal(completed.receipts[1].startedAt, next.progress.stepStartedAt);
  assert.ok(completed.finishedAt >= completed.receipts[1].at);
  steps[1].onOutput({ stdout: "late terminal output", stderr: "" });
  assert.deepEqual(read(), completed);

  const throwing = createPackageUpdates({ agentDir: path.join(root, "throwing-agent"), env: environment,
    runCommand: async (_command, _args, { onOutput }) => {
      onOutput({ stdout: "last visible output", stderr: "password=fixture-password" });
      throw new Error("fixture command failed");
    } });
  const throwingPlan = await throwing.plan("pi");
  throwing.apply(throwingPlan.transactionId, throwingPlan.digest);
  const thrown = await finished(throwing, throwingPlan.transactionId);
  assert.equal(thrown.phase, "failed");
  assert.equal(thrown.progress.completedSteps, 1);
  assert.equal(thrown.progress.currentTargetId, null);
  assert.equal(thrown.progress.stdout, "last visible output");
  assert.equal(thrown.receipts[0].stdout, thrown.progress.stdout);
  assert.match(thrown.progress.stderr, /redacted/);
  assert.doesNotMatch(thrown.progress.stderr, /fixture-password/);
  assert.match(thrown.error, /fixture command failed/);
}

async function classificationFlow(globalModules, userAgent) {
  const self = "pi is already up to date (v9.8.7)";
  const packages = "Packages are already up to date";
  const extension = `${SOURCE} is already up to date`;
  const npm = "up to date, audited 12 packages in 428ms";
  const cases = [
    ["pi", self, "unchanged"],
    ["pi", `\u001b[32m${self}\u001b[39m\r\n`, "unchanged"],
    ["webui", extension, "unchanged"],
    ["all", `${self}\n${packages}`, "unchanged"],
    ["all", `${packages}\n${self}`, "unchanged"],
    ["all", self, "success"],
    ["all", packages, "success"],
    ["pi", "", "success"],
    ["pi", "command finished", "success"],
    ["pi", `${self}\nwarning: stale metadata`, "success"],
    ["pi", `${self}\nSkipped package updates (offline mode)`, "success"],
    ["pi", `${self}\nUpdated pi from 9.8.6 to 9.8.7`, "success"],
    ["pi", `${self}\nunrecognized output`, "success"],
    ["pi", `prefix ${self}`, "success"],
    ["pi", `${self} trailing text`, "success"],
    ["webui", "npm:@firstpick/another-package is already up to date", "success"],
    ["webui", self, "success"],
    ["pi", self, "success", { stderr: "npm warn stale metadata" }],
    ["pi", self, "failed", { exitCode: 2 }],
    ["pi", self, "failed", { timedOut: true }],
    ["pi", self, "failed", { signal: "SIGTERM" }],
    ["pi", self, "failed", { error: "command failed" }],
    ["pi", "x".repeat(17_000) + "\n" + self, "success"],
  ];
  for (const [requested, stdout, expected, overrides] of cases) {
    const service = createPackageUpdates({ agentDir: userAgent, env: environment,
      runCommand: async (_command, args) => args[0] === "root" ? { exitCode: 0, stdout: path.join(root, "not-installed") } :
        { exitCode: 0, stdout, ...overrides } });
    const plan = await service.plan(requested);
    service.apply(plan.transactionId, plan.digest);
    const job = await finished(service, plan.transactionId);
    assert.equal(job.receipts[0].status, expected, JSON.stringify([requested, stdout.slice(-200), overrides]));
    assert.equal(job.phase, expected);
    assert.equal(job.restartRequired, expected === "success");
    if (expected === "unchanged") {
      assert.match(job.message, /Already up to date/);
      assert.doesNotMatch(job.message, /restart/i);
      assert.equal(job.error, "");
    } else assert.match(job.message, /Commands completed/);
  }

  for (const [stdout, expected] of [
    [npm, "unchanged"], ["up to date in 2s", "unchanged"], ["up to date, audited 1 package in 1m", "unchanged"],
    ["\nup to date in 1.5s\n", "unchanged"], ["everything is up to date in 2s", "success"],
    ["up to date", "success"], ["up to date in someday", "success"],
    ["up to date, changed 1 package in 2s", "success"], ["up to date in 2s\nadded 1 package in 2s", "success"],
    ["removed 1 package in 2s\nup to date in 2s", "success"], ["changed 1 package in 2s\nup to date in 2s", "success"],
    ["npm warn skipped scripts\nup to date in 2s", "success"], ["up to date in 2s\nunknown output", "success"],
    [JSON.stringify({ added: 0, changed: 0 }), "success"],
  ]) {
    const service = createPackageUpdates({ agentDir: path.join(root, "npm-classification-agent"), env: environment,
      runCommand: async (_command, args) => ({ exitCode: 0, stdout: args[0] === "root" ? globalModules : stdout }) });
    const plan = await service.plan("webui");
    service.apply(plan.transactionId, plan.digest);
    const job = await finished(service, plan.transactionId);
    assert.equal(job.phase, expected, stdout);
    assert.equal(job.restartRequired, expected !== "unchanged");
  }

  // Preserve warnings observed before a command adapter's final snapshot replaces its output.
  const warned = createPackageUpdates({ agentDir: userAgent, env: environment,
    runCommand: async (_command, _args, { onOutput }) => {
      onOutput({ stdout: "warning: offline", stderr: "" });
      return { exitCode: 0, stdout: self };
    } });
  const warnedPlan = await warned.plan("pi");
  warned.apply(warnedPlan.transactionId, warnedPlan.digest);
  assert.equal((await finished(warned, warnedPlan.transactionId)).phase, "success");

  for (const piStatus of ["unchanged", "success", "failed"]) {
    for (const npmStatus of ["unchanged", "success", "failed"]) {
      const service = createPackageUpdates({ agentDir: path.join(root, "matrix-agent"), env: environment,
        runCommand: async (command, args) => {
          if (args[0] === "root") return { exitCode: 0, stdout: globalModules };
          const status = command === "pi" ? piStatus : npmStatus;
          return { exitCode: status === "failed" ? 7 : 0,
            stdout: status === "unchanged" ? command === "pi" ? `${self}\n${packages}` : npm : "command completed" };
        } });
      const plan = await service.plan("all");
      service.apply(plan.transactionId, plan.digest);
      const job = await finished(service, plan.transactionId);
      const statuses = [piStatus, npmStatus];
      const failed = statuses.filter((status) => status === "failed").length;
      const expected = failed === 2 ? "failed" : failed ? "partial" : statuses.every((status) => status === "unchanged") ? "unchanged" : "success";
      assert.deepEqual(job.receipts.map(({ status }) => status), statuses);
      assert.equal(job.phase, expected, statuses.join("/"));
      assert.equal(job.outcome, expected);
      assert.equal(job.restartRequired, statuses.includes("success"));
      assert.equal(job.progress.completedSteps, 2);
      assert.equal(job.error.split("\n").filter(Boolean).length, failed);
      if (!job.restartRequired) assert.doesNotMatch(job.message, /restart/i);
    }
  }
}

async function streamedOutputFlow(script) {
  const snapshots = [];
  let releaseObserved;
  const observed = new Promise((resolve) => { releaseObserved = resolve; });
  await writeFile(script, `process.stdout.write('working\\n');
process.stdout.write('password=split-');
setTimeout(() => { process.stdout.write('credential\\n'); process.stderr.write('https://user:private@example.test\\n'); }, 50);
setTimeout(() => { process.stdout.write(process.env.FIXTURE_API_TOKEN.slice(0, 8)); }, 100);
setTimeout(() => { process.stdout.write(process.env.FIXTURE_API_TOKEN.slice(8) + '\\n'); }, 150);
setTimeout(() => { process.stdout.write('final without newline'); }, 400);`);
  let settled = false;
  const command = runPackageCommand(process.execPath, [script], {
    cwd: root, env: { ...environment, FIXTURE_API_TOKEN: "fixture-private-value" }, timeoutMs: 2_000,
    onOutput: (snapshot) => { snapshots.push(snapshot); if (snapshot.stdout.includes("working")) releaseObserved(); },
  }).then((result) => { settled = true; return result; });
  await Promise.race([observed, delay(1_500).then(() => { throw new Error("No live command snapshot"); })]);
  assert.equal(settled, false, "output is available before the child exits");
  const result = await command;
  assert.equal(result.exitCode, 0);
  assert.deepEqual(snapshots.at(-1), { stdout: result.stdout, stderr: result.stderr });
  assert.match(result.stdout, /final without newline$/);
  assert.match(result.stdout, /password=\[redacted\]/);
  assert.match(result.stderr, /https:\/\/\[redacted\]@example.test/);
  for (const snapshot of snapshots) {
    assert.ok(snapshot.stdout.length <= 16_000 && snapshot.stderr.length <= 16_000);
    assert.doesNotMatch(JSON.stringify(snapshot), /split-|credential|fixture-|private-value|user:private/);
  }

  await writeFile(script, `process.stdout.write('token=' + 'z'.repeat(17_000));
setTimeout(() => { console.log('z'.repeat(5_000)); console.log('up to date in 2s'); }, 50);`);
  const boundedSnapshots = [];
  const bounded = await runPackageCommand(process.execPath, [script], { cwd: root, env: environment, timeoutMs: 2_000,
    onOutput: (snapshot) => boundedSnapshots.push(snapshot) });
  assert.ok(bounded.stdout.length <= 16_000);
  assert.match(bounded.stdout, /output truncated/);
  assert.match(bounded.stdout, /up to date in 2s/);
  for (const snapshot of boundedSnapshots) {
    assert.ok(snapshot.stdout.length <= 16_000);
    assert.doesNotMatch(snapshot.stdout, /z{6}/);
  }

  await writeFile(script, `process.stdout.write('\\u001b[');
setTimeout(() => { process.stdout.write('32mworking\\u001b[39m\\n'); process.stdout.write(Buffer.from([0xe2])); }, 50);
setTimeout(() => { process.stdout.write(Buffer.from([0x82, 0xac, 0x0a])); }, 100);
setTimeout(() => { for (let i = 0; i < 2000; i++) console.log('bounded output ' + i); }, 150);`);
  const unicodeSnapshots = [];
  const unicode = await runPackageCommand(process.execPath, [script], { cwd: root, env: environment, timeoutMs: 2_000,
    onOutput: (snapshot) => unicodeSnapshots.push(snapshot) });
  assert.ok(unicodeSnapshots.some(({ stdout }) => stdout.includes("working\n€\n")));
  assert.match(unicode.stdout, /output truncated/);
  assert.match(unicode.stdout, /bounded output 1999/);
  for (const snapshot of unicodeSnapshots) {
    assert.ok(snapshot.stdout.length <= 16_000);
    assert.doesNotMatch(snapshot.stdout, /\u001b|\ufffd/);
  }

  await writeFile(script, `console.log('before timeout'); setInterval(() => {}, 1000);`);
  const timeoutSnapshots = [];
  const timeout = await runPackageCommand(process.execPath, [script], { cwd: root, env: environment, timeoutMs: 200,
    onOutput: (snapshot) => timeoutSnapshots.push(snapshot) });
  assert.equal(timeout.timedOut, true);
  assert.match(timeout.stdout, /before timeout/);
  const count = timeoutSnapshots.length;
  await delay(50);
  assert.equal(timeoutSnapshots.length, count);
  assert.deepEqual(timeoutSnapshots.at(-1), { stdout: timeout.stdout, stderr: timeout.stderr });
  if (process.platform !== "win32") {
    await writeFile(script, `console.log('before cancellation'); process.kill(process.pid, 'SIGTERM');`);
    const cancelled = await runPackageCommand(process.execPath, [script], { cwd: root, env: environment, timeoutMs: 2_000,
      onOutput: () => { throw new Error("observer failure"); } });
    assert.equal(cancelled.signal, "SIGTERM");
    assert.equal(cancelled.exitCode, null);
    assert.equal(cancelled.timedOut, false);
    assert.match(cancelled.stdout, /before cancellation/);
  }
}

async function httpFlow(unchanged = false) {
  const fixture = path.join(root, unchanged ? "http-unchanged" : "http");
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
if (args[0] === 'update') { appendFileSync(${JSON.stringify(log)}, JSON.stringify(['pi', args]) + '\\n'); console.log(${JSON.stringify(unchanged ? "pi is already up to date (v9.8.7)\nPackages are already up to date" : "updating pi\npassword=fixture-password")}); await new Promise(r => setTimeout(r, 500)); process.exit(0); }
await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, "tests", "fixtures", "fake-pi.mjs")).href)});
` , { mode: 0o755 });
  if (process.platform === "win32") await writeFile(path.join(bin, "pi.cmd"), `@echo off\r\nnode "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*\r\n`);
  else await symlink(cli, path.join(bin, "pi"));
  await writeFile(npmCli, `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.join(' ') === 'root -g') { console.log(${JSON.stringify(modules)}); process.exit(0); }
appendFileSync(${JSON.stringify(log)}, JSON.stringify(['npm', args]) + '\\n'); console.log(${JSON.stringify(unchanged ? "up to date in 2s" : "npm command failed")}); process.exitCode = ${unchanged ? 0 : 5};
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
    let live;
    for (let attempt = 0; attempt < 50; attempt++) {
      live = (await api(`/api/update/transactions/${plan.transactionId}`)).body.data;
      if (live.progress.stdout) break;
      await delay(10);
    }
    assert.equal(live.phase, "running", JSON.stringify(live));
    assert.deepEqual([live.progress.totalSteps, live.progress.completedSteps, live.progress.currentTargetId], [2, 0, "pi"]);
    assert.ok(live.progress.stdout);
    assert.doesNotMatch(live.progress.stdout, /fixture-password/);
    assert.equal((await api("/api/update-status")).body.data.nativeJobs.all.progress.stdout, live.progress.stdout);
    let completed;
    for (let attempt = 0; attempt < 100; attempt++) {
      completed = (await api(`/api/update/transactions/${plan.transactionId}`)).body.data;
      if (completed.phase !== "running") break;
      await delay(20);
    }
    assert.equal(completed.phase, unchanged ? "unchanged" : "partial", JSON.stringify(completed));
    assert.deepEqual(completed.receipts.map(({ exitCode }) => exitCode), [0, unchanged ? 0 : 5]);
    assert.deepEqual(completed.verifiedTargets, []);
    assert.equal(completed.restartRequired, !unchanged);
    assert.match(completed.message, unchanged ? /Already up to date/ : /Restart Web UI manually/);
    assert.equal(completed.progress.completedSteps, 2);
    assert.equal(completed.progress.currentTargetId, null);
    assert.equal((await api("/api/health")).body.bootIdentity, bootIdentity, "successful commands never restart the server");
    const status = (await api("/api/update-status")).body.data;
    assert.equal(status.nativeJobs.all.transactionId, plan.transactionId);
    assert.equal(status.nativeJobs.all.phase, unchanged ? "unchanged" : "partial");
    assert.equal(status.nativeJobs.pi, null);
    assert.equal(status.nativeJobs.webui, null);
    assert.equal(status.canRunUpdate, true);
    assert.equal(status.restartRequired, !unchanged);
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
