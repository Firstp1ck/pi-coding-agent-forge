#!/usr/bin/env node
// This file is copied to a private location before launch: it must never import
// files under an installation that a command can replace.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeNodeOptions, readUpdateContext } from "./pi-webui-update-context.mjs";

const OUTPUT_LIMIT = 16_000;
const confidentialValues = new Set();
function bounded(value) {
  let text = String(value || "").slice(-OUTPUT_LIMIT)
    .replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\b((?:_?auth[_-]?token|api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
  const sensitive = Object.entries(process.env).filter(([key, secret]) =>
    /(?:auth|token|password|secret|api[_-]?key)/i.test(key) && secret?.length >= 6)
    .map(([, secret]) => secret).sort((a, b) => b.length - a.length);
  for (const secret of [...new Set([...sensitive, ...confidentialValues])].sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, "[redacted]");
  }
  return text;
}
async function persist(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(data)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
async function digest(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
async function runCommand(command, args, cwd, env) {
  return new Promise((resolve) => {
    const output = { stdout: "", stderr: "" };
    let settled = false;
    let launchError = null;
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk) => { output.stdout = bounded(output.stdout + chunk); });
    child.stderr?.on("data", (chunk) => { output.stderr = bounded(output.stderr + chunk); });
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code, signal: signal || null, error: bounded(error?.message || ""), ...output });
    };
    child.once("error", (error) => { launchError = error; });
    // Never treat an error event as completion. Even failed spawns emit close;
    // a launched command's streams must finish before we write a receipt.
    child.once("close", (code, signal) => finish(code, signal, launchError));
  });
}

export async function runUpdateJob(jobDir) {
  const { targets, cwd, transactionId, contextDigest, settingsPath, settingsDigest, npmConfigFiles, npmConfigDigest,
    nodeDigest, npmDriver, npmDriverDigest } =
    JSON.parse(await readFile(path.join(jobDir, "intent.json"), "utf8"));
  const env = process.env;
  for (const filename of npmConfigFiles || []) {
    let text = "";
    try { text = await readFile(filename, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*[^=]*(?:_auth|token|password)[^=]*=\s*(.*?)\s*$/i);
      if (!match) continue;
      const value = match[1].replace(/^['"]|['"]$/g, "");
      const expanded = value.replace(/\$\{([^}]+)\}/g, (_, name) => env[name] || "");
      if (expanded.length >= 6) confidentialValues.add(expanded);
    }
  }
  assertSafeNodeOptions(env);
  if (env.BASH_ENV || env.ENV || !nodeDigest || await digest(process.execPath) !== nodeDigest) {
    throw new Error("Confirmed Node interpreter or startup configuration changed.");
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(transactionId) || !Array.isArray(targets) || targets.length < 1 || targets.length > 2 || typeof cwd !== "string") {
    throw new Error("Invalid private update intent.");
  }
  if (await stat(path.join(jobDir, "complete.json")).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) throw new Error("This update job already completed; replay is prohibited.");
  let heartbeat = Promise.resolve();
  const pulse = () => { heartbeat = heartbeat.then(() => persist(path.join(jobDir, "heartbeat.json"),
    { transactionId, pid: process.pid, at: new Date().toISOString() })); };
  pulse();
  const timer = setInterval(pulse, 1_000);
  const receipts = [];
  try {
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const receiptPath = path.join(jobDir, `${i}.receipt.json`);
    // A started command without a receipt may still be running after a crash.
    const started = await open(path.join(jobDir, `${i}.started.json`), "wx", 0o600);
    try { await started.writeFile(`${JSON.stringify({ transactionId, id: target.id, at: new Date().toISOString() })}\n`); await started.sync(); }
    finally { await started.close(); }
    let result;
    try {
      const actualContext = await readUpdateContext({ env, settingsPath, npmConfigFiles });
      if (actualContext.contextDigest !== contextDigest) throw new Error("Confirmed environment changed; no command was run.");
      if (actualContext.settingsDigest !== settingsDigest) throw new Error("Confirmed Pi settings changed; no command was run.");
      if (actualContext.npmConfigDigest !== npmConfigDigest) throw new Error("Confirmed npm routing configuration changed; no command was run.");
      if (npmDriver && (!path.isAbsolute(npmDriver) || await digest(npmDriver) !== npmDriverDigest)) {
        throw new Error("Confirmed npm driver changed; no command was run.");
      }
      if (!path.isAbsolute(target.command.command) || !Array.isArray(target.command.args) || !path.isAbsolute(target.driver) ||
          await digest(target.driver) !== target.driverDigest) {
        throw new Error("Confirmed command driver changed before launch; no command was run.");
      }
      const before = JSON.parse(await readFile(target.manifestPath, "utf8"));
      if (before.name !== target.packageName || before.version !== target.beforeVersion) {
        throw new Error("Confirmed installed package changed before launch; no command was run.");
      }
      result = await runCommand(target.command.command, target.command.args, cwd, env);
      if (result.signal || (result.exitCode === null && !result.error)) {
        result.status = "unknown";
        result.error = "Native command termination could not be proven; update exclusion remains active.";
      } else if (result.exitCode === 0 && !result.error) {
        const after = JSON.parse(await readFile(target.manifestPath, "utf8"));
        if (after.name !== target.packageName || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(after.version)) {
          result.status = "failed";
          result.error = "The installed package identity or version could not be verified.";
        } else {
          result.afterVersion = after.version;
          result.status = after.version !== before.version ? "changed" : "unchanged";
        }
      } else result.status = "failed";
    } catch (error) {
      result = { status: "failed", error: bounded(error.message) };
    }
    const receipt = { transactionId, id: target.id, at: new Date().toISOString(), ...result };
    await persist(receiptPath, receipt);
    receipts.push(receipt);
    if (receipt.status === "unknown") return receipts;
  }
  await persist(path.join(jobDir, "complete.json"), { transactionId, receipts: receipts.map(({ id, status, afterVersion }) => ({ id, status, afterVersion })) });
  return receipts;
  } finally {
    clearInterval(timer);
    await heartbeat;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runUpdateJob(process.argv[2]).catch((error) => { console.error(bounded(error.message)); process.exitCode = 1; });
}
