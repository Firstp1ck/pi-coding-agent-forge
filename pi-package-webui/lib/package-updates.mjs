import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveNpmCommandInvocation, resolvePiCommandInvocation } from "./npm-command.mjs";

const WEBUI = "@firstpick/pi-package-webui";
const PI = "@earendil-works/pi-coding-agent";
const TARGETS = new Set(["all", "webui", "pi"]);
const OUTPUT_LIMIT = 16_000;
const COMMAND_TIMEOUT_MS = 10 * 60_000;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function boundedOutput(value, env) {
  let text = String(value || "").slice(-OUTPUT_LIMIT)
    .replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\b((?:_?auth[_-]?token|api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
  for (const [key, secret] of Object.entries(env)) {
    if (/(?:auth|token|password|secret|api[_-]?key)/i.test(key) && secret?.length >= 6) text = text.replaceAll(secret, "[redacted]");
  }
  return text;
}

/** Run fixed package commands without a shell; stop their process tree on timeout. */
export function runPackageCommand(command, args, { cwd, env = process.env, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const invocation = command === "npm" ? resolveNpmCommandInvocation(args, { env }) :
    resolvePiCommandInvocation(command, args, { env });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let error = "";
    let timedOut = false;
    const child = spawn(invocation.command, invocation.args, { cwd, env, shell: false,
      detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = (signal) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (failure) { if (failure.code !== "ESRCH") error = failure.message; }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => stop("SIGKILL"));
      } else stop("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = boundedOutput(stdout + chunk, env); });
    child.stderr.on("data", (chunk) => { stderr = boundedOutput(stderr + chunk, env); });
    child.once("error", (failure) => { error = failure.message; });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal: signal || null, timedOut, stdout, stderr,
        error: boundedOutput(timedOut ? `Command timed out after ${timeoutMs} ms. Inspect its output before retrying.` : error, env) });
    });
  });
}

async function installedWebui(nodeModulesRoot) {
  if (!nodeModulesRoot) return null;
  const root = path.join(nodeModulesRoot, ...WEBUI.split("/"));
  try {
    if (!(await stat(root)).isDirectory() || !(await stat(path.join(root, "package.json"))).isFile()) return null;
    return await realpath(root);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }
}

function target(id, installedRoot, command, args) {
  return { id, packageName: id === "pi" ? PI : WEBUI, beforeVersion: "",
    installedRoot, effectRoot: installedRoot, command: { command, args } };
}

/** Installation-aware previews and in-memory jobs for one Web UI server. */
export function createPackageUpdates({ agentDir, cwd = process.cwd(), env = process.env,
  runCommand = runPackageCommand, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  if (!path.isAbsolute(agentDir || "")) throw new TypeError("An absolute Pi agent directory is required.");
  const jobs = new Map();
  const latest = { all: null, webui: null, pi: null };
  let running = false;
  const snapshot = (job) => job ? structuredClone(job) : null;

  async function plan(requested) {
    if (!TARGETS.has(requested)) throw httpError(400, "Unsupported update target.");
    if (running) throw httpError(409, "Another package update is running.");
    const targets = [];
    const refusals = [];
    let userRoot = null;
    let globalRoot = null;
    if (requested !== "pi") {
      try { userRoot = await installedWebui(path.join(agentDir, "npm", "node_modules")); }
      catch (error) { refusals.push(`Pi-managed Web UI could not be inspected: ${boundedOutput(error.message, env)}`); }
      try {
        const result = await runCommand("npm", ["root", "-g"], { cwd, env, timeoutMs: Math.min(timeoutMs, 10_000) });
        const npmRoot = String(result.stdout || "").trim();
        if (result.exitCode !== 0 || result.error || result.timedOut || !path.isAbsolute(npmRoot) || /[\r\n]/.test(npmRoot)) {
          refusals.push("The npm-global Web UI location could not be detected; no global update is planned.");
        } else globalRoot = await installedWebui(npmRoot);
      } catch (error) { refusals.push(`npm-global Web UI could not be inspected: ${boundedOutput(error.message, env)}`); }
    }
    if (requested === "pi" || requested === "all") {
      const pi = target("pi", "PATH pi", "pi", ["update", ...(requested === "all" ? ["--all"] : [])]);
      if (requested === "all" && userRoot) pi.coveredInstallations = [{ id: "webui:pi-user", installedRoot: userRoot }];
      targets.push(pi);
    }
    if (requested === "webui" && userRoot) {
      targets.push(target("webui:pi-user", userRoot, "pi", ["update", "--extension", `npm:${WEBUI}`]));
    }
    if (requested !== "pi") {
      if (!userRoot) refusals.push("Pi-managed Web UI is not installed; no targeted installation command will run for it.");
      if (globalRoot && globalRoot !== userRoot) {
        targets.push(target("webui:npm-global", globalRoot, "npm", ["update", "-g", WEBUI]));
      } else if (globalRoot) refusals.push("Pi-managed and npm-global Web UI share one installation; Pi updates it once.");
      else refusals.push("No npm-global Web UI installation was found; no global update will run.");
    }
    if (!targets.length) throw httpError(409, refusals.join(" ") || "Web UI is not installed in either package location.");
    const preview = { schemaVersion: 2, transactionId: randomUUID(), digest: randomBytes(32).toString("hex"),
      requested, createdAt: new Date().toISOString(), targets, refusals, context: { cwd, agentDir },
      warning: "Package commands use your existing configuration and may run package scripts. Restart Web UI manually after updating to load changes." };
    // Bound retained previews without evicting launched jobs or their receipts.
    const previews = [...jobs.values()].filter((job) => job.phase === "planned");
    if (previews.length >= 100) jobs.delete(previews[0].transactionId);
    jobs.set(preview.transactionId, { transactionId: preview.transactionId, plan: preview, phase: "planned",
      receipts: [], verifiedTargets: [], outcome: "", error: "" });
    return structuredClone(preview);
  }

  async function execute(job) {
    for (const item of job.plan.targets) {
      let result;
      try { result = await runCommand(item.command.command, item.command.args, { cwd, env, timeoutMs }); }
      catch (error) { result = { exitCode: null, error: error.message }; }
      const success = result.exitCode === 0 && !result.signal && !result.error && !result.timedOut;
      job.receipts.push({ id: item.id, at: new Date().toISOString(), status: success ? "success" : "failed",
        exitCode: result.exitCode ?? null, signal: result.signal || null, timedOut: Boolean(result.timedOut),
        stdout: boundedOutput(result.stdout, env), stderr: boundedOutput(result.stderr, env), error: boundedOutput(result.error, env) });
    }
    const successes = job.receipts.filter((receipt) => receipt.status === "success").length;
    job.phase = successes === job.receipts.length ? "success" : successes ? "partial" : "failed";
    job.outcome = job.phase;
    job.finishedAt = new Date().toISOString();
    job.restartRequired = successes > 0;
    job.message = "Commands finished. Restart Web UI manually to load updates. Command exit codes do not verify installed versions or health.";
    job.error = job.receipts.filter((receipt) => receipt.status !== "success")
      .map((receipt) => `${receipt.id}: ${receipt.error || `command exited ${receipt.exitCode ?? receipt.signal ?? "without a status"}`}`).join("\n");
    running = false;
  }

  function apply(transactionId, digest) {
    const job = jobs.get(transactionId);
    if (!job) throw httpError(404, "Update preview was not found in this server. Request a new preview.");
    if (job.plan.digest !== digest) throw httpError(409, "Update confirmation does not match the preview.");
    if (job.phase !== "planned") throw httpError(409, "This update has already been started.");
    if (running) throw httpError(409, "Another package update is running.");
    running = true;
    job.phase = "running";
    latest[job.plan.requested] = transactionId;
    void execute(job);
    return { transactionId, phase: "running" };
  }

  return { plan, apply, getJob: (transactionId) => snapshot(jobs.get(transactionId)),
    getJobs: () => Object.fromEntries(Object.entries(latest).map(([key, id]) => [key, snapshot(jobs.get(id))])),
    get running() { return running; } };
}
