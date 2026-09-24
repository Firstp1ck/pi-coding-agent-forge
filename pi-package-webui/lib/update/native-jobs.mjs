import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireEffectLocks, affectedParticipants, persistSharedJob, readSharedJob, releaseEffectLocks } from "./coordination.mjs";

const sourceRunner = fileURLToPath(new URL("../../bin/pi-webui-native-update-runner.mjs", import.meta.url));
const sourceContext = fileURLToPath(new URL("../../bin/pi-webui-update-context.mjs", import.meta.url));
const sourceGuardian = fileURLToPath(new URL("../../bin/pi-webui-native-update-guardian.mjs", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function privateJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

export async function createNativeUpdatePlan({ requested, targets, refusals = [], context, active = {}, pathPi = {} }) {
  if (!(["pi", "webui"].includes(requested)) || !targets.length || targets.length > 2 || !context?.cwd || !context?.agentDir) {
    throw new TypeError("A single proven update action and immutable execution context are required.");
  }
  const transactionId = randomUUID();
  const records = [];
  for (const target of targets) {
    if (!target.eligible || !["pi", "webui:npm-global", "webui:pi-user"].includes(target.id)) {
      throw new Error("An unproven or unrelated target cannot enter an update plan.");
    }
    if ((requested === "pi") !== (target.id === "pi")) throw new Error("Combined Pi/Web UI plans are forbidden.");
    const driver = target.driver;
    if (!driver || !path.isAbsolute(driver) || !path.isAbsolute(target.command?.command)) throw new Error("Command interpreter and driver must be absolute.");
    const canonicalDriver = await realpath(driver);
    if (await realpath(target.command.command) !== await realpath(process.execPath) ||
        target.command.args[0] !== canonicalDriver) throw new Error("Node invocation must bind the confirmed command driver.");
    const expectedArgs = target.id === "pi" ? [canonicalDriver, "update"] :
      target.id === "webui:npm-global" ? [canonicalDriver, "-g", "update", "@firstpick/pi-package-webui"] :
        [canonicalDriver, "update", "--extension", target.source, "--no-approve"];
    if (JSON.stringify(target.command.args) !== JSON.stringify(expectedArgs) ||
        target.id === "webui:pi-user" && !/^npm:@firstpick\/pi-package-webui(?:@[\w.^~<>= -]+)?$/.test(target.source || "")) {
      throw new Error("Native command differs from the fixed validated update action.");
    }
    const driverDigest = hash(await readFile(canonicalDriver));
    records.push({
      id: target.id, source: target.source || "", command: target.command,
      driver: canonicalDriver, driverDigest, packageName: target.id === "pi" ? "@earendil-works/pi-coding-agent" : "@firstpick/pi-package-webui",
      beforeVersion: target.installed.version, manifestPath: path.join(target.installed.root, "package.json"),
      installedRoot: target.installed.root, effectRoot: target.effectRoot,
    });
  }
  for (const field of ["contextDigest", "settingsDigest", "npmConfigDigest", "shellDigest", "nodeDigest"]) {
    if (!/^[a-f0-9]{64}$/.test(context[field] || "")) throw new Error(`Native plan lacks a confirmed ${field}.`);
  }
  if (!path.isAbsolute(context.settingsPath) || !Array.isArray(context.npmConfigFiles) ||
      !context.npmConfigFiles.every((file) => path.isAbsolute(file))) throw new Error("Native plan lacks bound settings and npm configuration paths.");
  const unsigned = {
    schemaVersion: 2, transactionId, requested, createdAt: new Date().toISOString(),
    context: { ...context, npmPrefix: context.npmPrefix || "" },
    active, pathPi, targets: records, refusals,
    warning: "Native npm/Pi lifecycle scripts run with your existing configuration and are not sandboxed; permissions are not elevated.",
  };
  return { ...unsigned, digest: hash(JSON.stringify(unsigned)) };
}

export function affectedActivePiDependency(plan, verifiedTargets) {
  const piRoot = plan.active?.piRoot;
  if (!piRoot) return null;
  return verifiedTargets.find((target) => {
    if (target.id === "pi" || !["healthy", "unchanged"].includes(target.status)) return false;
    const relative = path.relative(target.effectRoot, piRoot);
    return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }) || null;
}

export function validateNativePlan(plan, digest) {
  if (plan?.schemaVersion !== 2 || plan.digest !== digest || hash(JSON.stringify(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "digest")))) !== digest) {
    throw new Error("Confirmed native update plan changed or is invalid.");
  }
}

/** Create an immutable private capsule before starting a shell; no imports follow the mutable installation. */
export async function launchNativeUpdate(plan, digest, { stateRoot, env, node = process.execPath, spawnImpl = spawn,
  requiredParticipants = [] } = {}) {
  validateNativePlan(plan, digest);
  const lock = await acquireEffectLocks(stateRoot, plan.targets.map((item) => item.effectRoot), plan.transactionId);
  const jobDir = path.join(stateRoot, "jobs", plan.transactionId);
  let launched = false;
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      const participants = await affectedParticipants(stateRoot, lock);
      const requiredPresent = requiredParticipants.every(({ token, pid, kind }) => participants.some((participant) =>
        participant.kind === kind && (!token || participant.token === token) && (!pid || participant.pid === pid)));
      if (requiredPresent && participants.length && participants.every((participant) =>
        participant.ack?.lockToken === lock.token && participant.ack?.idle === true)) break;
      if (Date.now() >= deadline) throw new Error("Known owned Web UI/RPC participants did not confirm idle admission; no command was launched.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await mkdir(jobDir, { mode: 0o700 });
    const runner = path.join(jobDir, "runner.mjs");
    const copiedContext = path.join(jobDir, "pi-webui-update-context.mjs");
    await copyFile(sourceRunner, runner);
    await copyFile(sourceContext, copiedContext);
    const guardian = path.join(jobDir, "guardian.mjs");
    if (process.platform === "win32") await copyFile(sourceGuardian, guardian);
    if (hash(await readFile(runner)) !== hash(await readFile(sourceRunner)) ||
        hash(await readFile(copiedContext)) !== hash(await readFile(sourceContext)) ||
        process.platform === "win32" && hash(await readFile(guardian)) !== hash(await readFile(sourceGuardian))) {
      throw new Error("Private update capsule changed.");
    }
    if (hash(await readFile(plan.context.shell)) !== plan.context.shellDigest ||
        hash(await readFile(node)) !== plan.context.nodeDigest) throw new Error("Confirmed shell or Node interpreter changed.");
    // Credentials in npm/agent environment remain only in the detached
    // process memory; the private on-disk intent contains nonsecret bindings.
    const intent = {
      transactionId: plan.transactionId, cwd: plan.context.cwd,
      contextDigest: plan.context.contextDigest,
      settingsPath: plan.context.settingsPath,
      settingsDigest: plan.context.settingsDigest,
      npmConfigFiles: plan.context.npmConfigFiles,
      npmConfigDigest: plan.context.npmConfigDigest,
      nodeDigest: plan.context.nodeDigest,
      npmDriver: plan.context.npmDriver,
      npmDriverDigest: plan.context.npmDriverDigest,
      targets: plan.targets.map(({ id, command, driver, driverDigest, packageName, manifestPath, beforeVersion }) => ({
        id, command, driver, driverDigest, packageName, manifestPath, beforeVersion,
      })),
    };
    await privateJson(path.join(jobDir, "intent.json"), intent);
    await persistSharedJob(stateRoot, { transactionId: plan.transactionId, plan, lock, phase: "launching", jobDir,
      launchedAt: new Date().toISOString() });
    const shell = plan.context.shell;
    const shellEnv = { ...env, PI_WEBUI_UPDATE_NODE: node, PI_WEBUI_UPDATE_RUNNER: runner, PI_WEBUI_UPDATE_JOB: jobDir };
    // PowerShell normalizes PATHEXT on startup. Restore the confirmed value
    // before Node validates the frozen environment and executes a command.
    if (process.platform === "win32") {
      shellEnv.PI_WEBUI_UPDATE_PATHEXT = env.PATHEXT || env.PathExt || "";
      shellEnv.PI_WEBUI_UPDATE_SHELL = shell;
      shellEnv.PI_WEBUI_UPDATE_CWD = plan.context.cwd;
    }
    const args = process.platform === "win32"
      ? [guardian]
      : ["--noprofile", "--norc", "-c", 'exec "$PI_WEBUI_UPDATE_NODE" "$PI_WEBUI_UPDATE_RUNNER" "$PI_WEBUI_UPDATE_JOB"'];
    // A detached Node guardian owns ordinary hidden PowerShell on Windows;
    // detached PowerShell itself silently skips -Command on this host.
    const child = spawnImpl(process.platform === "win32" ? node : shell, args, { cwd: plan.context.cwd, env: shellEnv,
      detached: true, windowsHide: true, stdio: "ignore" });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    launched = true;
    child.unref();
    await persistSharedJob(stateRoot, { transactionId: plan.transactionId, plan, lock, phase: "running", jobDir,
      launcherPid: child.pid, launchedAt: new Date().toISOString() });
    return { transactionId: plan.transactionId, phase: "running", launcherPid: child.pid };
  } catch (error) {
    // A launch error before spawn proves no child was started. Any error after
    // spawn cannot release the fence: a runner may still be mutating installs.
    if (!launched) {
      await releaseEffectLocks(lock, { completionVerified: true });
      await persistSharedJob(stateRoot, { transactionId: plan.transactionId, plan, phase: "failed", outcome: "failed",
        error: "Native update shell could not be launched; no command ran." });
    }
    throw error;
  }
}

async function claimState(file) {
  let claim;
  try { claim = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { return error?.code === "ENOENT" ? "absent" : "unknown"; }
  if (!Number.isInteger(claim.pid) || !Number.isFinite(Date.parse(claim.startedAt)) ||
      Date.now() - Date.parse(claim.startedAt) > 60_000) return "unknown";
  try { process.kill(claim.pid, 0); return "running"; }
  catch (error) { return error.code === "ESRCH" ? "unknown" : "running"; }
}

export async function inspectNativeJob(stateRoot, transactionId) {
  const job = await readSharedJob(stateRoot, transactionId);
  if (!job) return null;
  if (!job.jobDir) return { ...job, receipts: [] };
  let complete = null;
  try { complete = JSON.parse(await readFile(path.join(job.jobDir, "complete.json"), "utf8")); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const receipts = [];
  for (let index = 0; index < job.plan.targets.length; index++) {
    try { receipts.push(JSON.parse(await readFile(path.join(job.jobDir, `${index}.receipt.json`), "utf8"))); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const completeProven = complete?.transactionId === transactionId && Array.isArray(complete.receipts) &&
    complete.receipts.length === job.plan.targets.length && receipts.length === job.plan.targets.length &&
    receipts.every((receipt, index) => receipt.transactionId === transactionId &&
      receipt.id === complete.receipts[index].id && receipt.status === complete.receipts[index].status &&
      receipt.afterVersion === complete.receipts[index].afterVersion);
  let heartbeatAt = 0;
  try { heartbeatAt = Date.parse(JSON.parse(await readFile(path.join(job.jobDir, "heartbeat.json"), "utf8")).at) || 0; }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const evidenceAt = heartbeatAt || Date.parse(job.launchedAt || "") || 0;
  const missingRunnerEvidence = !complete && ["running", "launching"].includes(job.phase) && Date.now() - evidenceAt > 10_000;
  const terminal = ["restart-authorized", "restart-pending", "success", "partial", "failed", "unchanged", "unknown"].includes(job.phase);
  let guardianFailure = null;
  try { guardianFailure = JSON.parse(await readFile(path.join(job.jobDir, "guardian-launch-failed.json"), "utf8")); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const noShellStarted = guardianFailure?.transactionId === transactionId && guardianFailure.noShellStarted === true &&
    guardianFailure.guardianPid === job.launcherPid && !complete && receipts.length === 0;
  const finalizer = await claimState(path.join(job.jobDir, "finalize.claim"));
  const restart = job.phase === "restart-authorized" ? await claimState(path.join(job.jobDir, "restart-action.claim")) : "absent";
  return { ...job, phase: restart !== "absent" ? restart === "running" ? "restart-in-progress" : "unknown" :
    terminal ? job.phase : noShellStarted ? "launch-failed" : finalizer !== "absent" ? finalizer === "running" ? "finalizing" : "unknown" :
      complete ? completeProven ? "command-complete" : "unknown" :
    receipts.some((item) => item.status === "unknown") || missingRunnerEvidence ? "unknown" : job.phase,
    receipts: receipts.map(({ id, status, exitCode, signal, afterVersion, stdout, stderr, error }) =>
      ({ id, status, exitCode, signal, afterVersion, stdout, stderr, error })) };
}
