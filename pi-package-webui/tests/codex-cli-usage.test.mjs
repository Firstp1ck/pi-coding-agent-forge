import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CodexCliUsageError, projectCodexCliUsage, readCodexCliUsage, resolveCodexCliInvocation } from "../lib/codex-cli-usage.mjs";
import { terminateProcessTree } from "../lib/process-tree.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "pi-webui-codex-cli-"));
const children = [];
let serial = 0;
after(async () => {
  for (const child of children) terminateProcessTree(child, "SIGKILL");
  await rm(root, { recursive: true, force: true });
});

function run(mode, options = {}) {
  const log = path.join(root, `${++serial}.jsonl`);
  return {
    log,
    result: readCodexCliUsage({
      invocation: { command: process.execPath, args: [fixture, "app-server", "--listen", "stdio://"] },
      env: { ...process.env, FAKE_CODEX_MODE: mode, FAKE_CODEX_LOG: log },
      timeoutMs: 3_000,
      spawn: (...args) => { const child = spawn(...args); children.push(child); return child; },
      ...options,
    }),
  };
}

async function entries(log) {
  return (await readFile(log, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function assertExited(pid) {
  for (let attempt = 0; attempt < 100 && alive(pid); attempt++) await delay(20);
  assert.equal(alive(pid), false, `fixture process ${pid} should have exited`);
}

test("the usage client performs only initialization and read-only account requests", async () => {
  const { result, log } = run("success");
  const data = await result;
  assert.equal(data.planType, "plus");
  assert.equal(data.rateLimits.primary.usedPercent, 25);
  assert.equal(data.rateLimits.secondary.usedPercent, 42);
  assert.equal(data.rateLimits.credits.balance, "12.50");
  const messages = await entries(log);
  const frames = messages.filter((entry) => entry.kind === "frame");
  assert.deepEqual(frames.map((frame) => frame.method), ["initialize", "initialized", "account/read", "account/rateLimits/read"]);
  assert.deepEqual(frames[2].params, { refreshToken: false });
  assert.equal(frames[3].params, null);
  assert.doesNotMatch(JSON.stringify(data), /secret|private-account|email|profile|accessToken/);
  await assertExited(messages[0].pid);
});

test("fragmented UTF-8 JSONL and harmless notifications preserve usage data", async () => {
  const data = await run("fragmented").result;
  assert.equal(data.rateLimits.primary.usedPercent, 25);
  assert.equal(data.rateLimits.limitName, "Codex 漢字");
});

test("weekly-only and multi-bucket usage remain usable", async () => {
  const weekly = await run("weekly-only").result;
  assert.equal(weekly.rateLimits.primary, null);
  assert.equal(weekly.rateLimits.secondary.usedPercent, 42);
  const multiple = await run("multi-bucket").result;
  assert.equal(multiple.rateLimitsByLimitId.extra.primary.usedPercent, 70);
});

test("unsolicited server auth requests are rejected without providing credentials", async () => {
  const { result, log } = run("server-request");
  await result;
  const reply = (await entries(log)).find((frame) => frame.id === "server-auth-request");
  assert.equal(reply.error.code, -32601);
  assert.equal(reply.result, undefined);
  assert.equal(reply.error.data, undefined);
});

test("signed-out and API-key CLI accounts never request subscription limits", async () => {
  for (const [mode, code] of [["logged-out", "CODEX_CLI_LOGIN_REQUIRED"], ["api-key", "CODEX_CLI_AUTH_TYPE"]]) {
    const { result, log } = run(mode);
    await assert.rejects(result, (error) => error.code === code && error.statusCode === 401);
    assert.equal((await entries(log)).some((frame) => frame.method === "account/rateLimits/read"), false);
  }
});

test("upstream errors and stderr are replaced with static sanitized diagnostics", async () => {
  await assert.rejects(run("rpc-error").result, (error) => {
    assert.ok(error instanceof CodexCliUsageError);
    assert.equal(error.code, "CODEX_CLI_REQUEST");
    assert.doesNotMatch(error.message, /fixture-|Bearer|refreshToken|private/);
    return true;
  });
});

test("malformed, empty, oversized and prematurely closed peers fail safely", async () => {
  for (const [mode, code] of [["malformed", "CODEX_CLI_PROTOCOL"], ["empty", "CODEX_CLI_NO_USAGE"], ["oversized", "CODEX_CLI_OUTPUT_LIMIT"], ["stderr-flood", "CODEX_CLI_OUTPUT_LIMIT"], ["early-exit", "CODEX_CLI_EXIT"]]) {
    await assert.rejects(run(mode).result, (error) => error.code === code);
  }
});

test("a silent app server times out and is terminated", async () => {
  const start = Date.now();
  const { result, log } = run("hang", { timeoutMs: 250 });
  await assert.rejects(result, (error) => error.code === "CODEX_CLI_TIMEOUT" && error.statusCode === 504);
  assert.ok(Date.now() - start < 7_000, "timeout and cleanup must remain bounded");
  await assertExited((await entries(log))[0].pid);
});

test("successful reads also terminate stubborn processes and their descendants", async () => {
  for (const mode of ["stubborn", "tree"]) {
    const { result, log } = run(mode);
    await result;
    for (const entry of (await entries(log)).filter((entry) => entry.pid)) await assertExited(entry.pid);
  }
});

test("cancellation cleans up the child and pre-cancellation does not spawn", async () => {
  const controller = new AbortController();
  const { result, log } = run("hang", { signal: controller.signal });
  await delay(200);
  controller.abort();
  await assert.rejects(result, (error) => error.code === "CODEX_CLI_ABORTED");
  await assertExited((await entries(log))[0].pid);
  await assert.rejects(readCodexCliUsage({ signal: controller.signal, spawn: () => assert.fail("must not spawn") }), (error) => error.code === "CODEX_CLI_ABORTED");
});

test("completed reads leave no parent-exit listener behind", async () => {
  const before = process.listenerCount("exit");
  await run("success").result;
  assert.equal(process.listenerCount("exit"), before);
  await assert.rejects(run("rpc-error").result);
  assert.equal(process.listenerCount("exit"), before);
});

test("parent shutdown terminates an in-flight usage process", async () => {
  const log = path.join(root, `${++serial}.jsonl`);
  const moduleUrl = new URL("../lib/codex-cli-usage.mjs", import.meta.url).href;
  const script = `import {readCodexCliUsage} from ${JSON.stringify(moduleUrl)};
    void readCodexCliUsage({ invocation: {command: process.execPath, args: [${JSON.stringify(fixture)}]}, timeoutMs: 3000 }).catch(() => {});
    setTimeout(() => process.exit(0), 500);`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, FAKE_CODEX_MODE: "hang", FAKE_CODEX_LOG: log },
    detached: process.platform !== "win32", stdio: "ignore",
  });
  children.push(parent);
  await new Promise((resolve, reject) => { parent.once("close", resolve); parent.once("error", reject); });
  assert.equal(parent.exitCode, 0);
  const pid = (await entries(log))[0].pid;
  try { await assertExited(pid); } finally { if (alive(pid)) process.kill(pid, "SIGKILL"); }
});

test("missing executables and synchronous spawn errors do not leak raw details", async () => {
  await assert.rejects(readCodexCliUsage({ invocation: { command: path.join(root, "missing-codex"), args: [] } }), (error) => error.code === "CODEX_CLI_NOT_FOUND");
  await assert.rejects(readCodexCliUsage({ spawn: () => { throw new Error("fixture-secret"); }, invocation: { command: "codex", args: [] } }), (error) => error.code === "CODEX_CLI_START" && !error.message.includes("fixture-secret"));
});

test("quota projection allowlists fields, caps buckets and rejects malformed windows", () => {
  const window = { usedPercent: 0, windowDurationMins: 300, resetsAt: 2000000000, token: "fixture-secret" };
  const byId = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`bucket-${index}`, { primary: window }]));
  const projected = projectCodexCliUsage({ rateLimits: { primary: window, credits: { balance: { token: "fixture-secret" } } }, rateLimitsByLimitId: byId, accountId: "private" }, "plus");
  assert.equal(Object.keys(projected.rateLimitsByLimitId).length, 16);
  assert.equal(projected.rateLimits.primary.usedPercent, 0);
  assert.equal(projected.rateLimits.credits.balance, null);
  assert.doesNotMatch(JSON.stringify(projected), /fixture-secret|private|token/);
  for (const value of [null, [], { rateLimits: { primary: { usedPercent: "25" } } }, { rateLimits: { primary: { usedPercent: -1 } } }]) {
    assert.throws(() => projectCodexCliUsage(value), CodexCliUsageError);
  }
});

test("command resolution supports native binaries, scripts and Windows npm shims without a shell", () => {
  assert.deepEqual(resolveCodexCliInvocation({ platform: "linux", env: {} }), { command: "codex", args: ["app-server", "--listen", "stdio://"] });
  assert.deepEqual(resolveCodexCliInvocation({ platform: "win32", env: { PI_WEBUI_CODEX_BIN: "C:\\Codex Tools\\codex.exe" } }), { command: "C:\\Codex Tools\\codex.exe", args: ["app-server", "--listen", "stdio://"] });
  const script = "C:\\Node Tools\\node_modules\\@openai\\codex\\bin\\codex.js";
  const exists = new Set(["C:\\Node Tools\\codex.cmd", script].map((value) => value.toLowerCase()));
  const invocation = resolveCodexCliInvocation({ platform: "win32", execPath: "C:\\Node Tools\\node.exe", env: { PATH: "C:\\Node Tools", PATHEXT: ".EXE;.CMD" }, existsSync: (value) => exists.has(value.toLowerCase()) });
  assert.equal(invocation.command, "C:\\Node Tools\\node.exe");
  assert.deepEqual(invocation.args, [script, "app-server", "--listen", "stdio://"]);
  assert.throws(() => resolveCodexCliInvocation({ platform: "win32", env: { PI_WEBUI_CODEX_BIN: "C:\\unknown\\custom.cmd" }, existsSync: () => false }), (error) => error.code === "CODEX_CLI_SHIM");
  assert.equal(resolveCodexCliInvocation({ platform: "linux", env: { PI_WEBUI_CODEX_BIN: "codex;echo hacked" } }).command, "codex;echo hacked");
});
