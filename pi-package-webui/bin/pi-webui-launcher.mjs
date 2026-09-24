#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateLegacyBootstrap } from "../lib/update/migration.mjs";

const bootstrapRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapServer = path.join(bootstrapRoot, "bin", "pi-webui.mjs");
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");

if (process.argv[2] === "agent") {
  try {
    const { runAgentCli } = await import("../lib/agent-run-adapters.mjs");
    process.exitCode = await runAgentCli(process.argv.slice(3), { agentDir });
  } catch (error) {
    console.error(`Pi Web UI agent command failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
} else {
  const selection = await migrateLegacyBootstrap(agentDir, bootstrapRoot);
  if (!selection.migrated && selection.reason !== "no-legacy-pointer") {
    console.warn(`Pi Web UI retained the previous runtime: ${selection.reason}. Inspect the installed package and pointer backups before manual migration.`);
  }
  const serverEntry = selection.serverEntry || bootstrapServer;
  const child = spawn(process.execPath, [serverEntry, ...process.argv.slice(2)], {
    cwd: process.cwd(), env: process.env, stdio: "inherit", windowsHide: true,
  });
  child.once("error", (error) => { console.error(`Pi Web UI launcher failed: ${error.message || error}`); process.exitCode = 1; });
  child.once("exit", (code, signal) => {
    if (signal) {
      try { process.kill(process.pid, signal); } catch { process.exitCode = 1; }
    } else process.exitCode = code ?? 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { try { child.kill(signal); } catch {} });
}
