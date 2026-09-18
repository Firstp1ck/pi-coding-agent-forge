import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject } from "../src/store.ts";
import { SKILLS } from "../src/workflow.ts";

const cli = process.argv[2];
if (!cli) throw new Error("Usage: node --experimental-strip-types tests/pi-smoke.mjs <path-to-installed-pi-cli.js>");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), "pi-writer-live-"));
const cwd = join(temp, "workspace"), config = join(temp, "agent");
await mkdir(cwd); await mkdir(config);
await writeFile(join(config, "settings.json"), JSON.stringify({ packages: [root], enableSkillCommands: true, enableInstallTelemetry: false }));
await createProject(cwd, { title: "Smoke Book", format: "light-novel" });
const env = { PI_CODING_AGENT_DIR: config, PI_CODING_AGENT_SESSION_DIR: join(temp, "sessions"), PI_OFFLINE: "1", PI_TELEMETRY: "0", HOME: temp, USERPROFILE: temp };
for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LANG"]) {
  if (process.env[key]) env[key] = process.env[key];
}
const child = spawn(process.execPath, [resolve(cli), "--mode", "rpc", "--no-session", "--no-context-files", "--approve"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
const notifications = [], events = [];
let serial = 0, buffer = "", stderr = "";
const exited = new Promise((resolveExit) => {
  child.once("exit", resolveExit);
  child.once("error", resolveExit);
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16000); });
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, end).replace(/\r$/, "");
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    events.push(event.type);
    if (event.type === "extension_ui_request") {
      if (event.method === "notify") notifications.push(event.message);
      else if (["select", "input", "confirm", "editor"].includes(event.method)) {
        child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true }) + "\n");
      }
    }
    if (event.type === "response" && pending.has(event.id)) {
      const item = pending.get(event.id); pending.delete(event.id); clearTimeout(item.timer); item.resolve(event);
    }
  }
});
function failPending(error) {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
  pending.clear();
}
child.once("error", failPending);
child.once("exit", (code) => failPending(new Error(`Pi exited with ${code}: ${stderr}`)));
function send(type, payload = {}) {
  return new Promise((resolveResponse, reject) => {
    const id = `writer-smoke-${++serial}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Pi smoke timed out for ${type}: ${stderr}`));
    }, 30000);
    pending.set(id, { resolve: resolveResponse, reject, timer });
    child.stdin.write(JSON.stringify({ id, type, ...payload }) + "\n");
  });
}
try {
  const response = await send("get_commands");
  assert.equal(response.success, true);
  const names = response.data.commands.map((command) => command.name);
  assert.ok(names.includes("writer"));
  for (const name of SKILLS) assert.ok(names.includes(`skill:${name}`), name);
  for (const message of ["/writer help", "/writer list", "/writer open smoke-book", "/writer status", "/writer"]) {
    assert.equal((await send("prompt", { message })).success, true, message);
  }
  assert.ok(notifications.some((message) => message.includes("Writer workflows")));
  assert.ok(notifications.some((message) => message.includes("Selected Smoke Book")));
  assert.ok(notifications.some((message) => message.includes("No manuscript has been drafted")));
  assert.ok(!notifications.some((message) => message.includes("Trust this workspace")));
  assert.equal((await send("new_session")).success, true);
  assert.equal((await send("prompt", { message: "/writer status" })).success, true);
  assert.ok(!events.includes("agent_start"), "Read-only commands must not start a model call");
  assert.ok(!events.includes("extension_error"));
  console.log(`Pi RPC smoke passed: /writer and ${SKILLS.length} skills discovered; help/list/open/status, menu cancellation, and session restart verified without a model call.`);
} finally {
  failPending(new Error("Smoke test finished"));
  child.kill();
  const forceStop = setTimeout(() => child.kill("SIGKILL"), 2000);
  try { await exited; } finally { clearTimeout(forceStop); }
  await rm(temp, { recursive: true, force: true });
}
