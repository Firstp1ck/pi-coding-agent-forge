#!/usr/bin/env node
// This private capsule entry outlives the original Web UI server on Windows.
// PowerShell itself cannot run -Command in a detached process group here.
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function launch() {
  const jobDir = process.env.PI_WEBUI_UPDATE_JOB;
  const shell = process.env.PI_WEBUI_UPDATE_SHELL;
  if (!jobDir || !shell || !path.isAbsolute(jobDir) || !path.isAbsolute(shell)) throw new Error("Private update guardian lacks bound paths.");
  const args = ["-NoProfile", "-NonInteractive", "-Command",
    "$env:PATHEXT = $env:PI_WEBUI_UPDATE_PATHEXT; & $env:PI_WEBUI_UPDATE_NODE $env:PI_WEBUI_UPDATE_RUNNER $env:PI_WEBUI_UPDATE_JOB; exit $LASTEXITCODE"];
  const child = spawn(shell, args, { cwd: process.env.PI_WEBUI_UPDATE_CWD, env: process.env,
    detached: false, windowsHide: true, stdio: "ignore" });
  const started = await new Promise((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
  if (!started) {
    // A pre-spawn error proves that PowerShell and all native commands never ran.
    const handle = await open(path.join(jobDir, "guardian-launch-failed.json"), "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ transactionId: path.basename(jobDir), guardianPid: process.pid, noShellStarted: true })}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    process.exitCode = 1;
    return;
  }
  const exit = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  if (exit.code !== 0 || exit.signal) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launch().catch(() => { process.exitCode = 1; });
}
