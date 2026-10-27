import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { resolveCommandDirectory } from "./npm-command.mjs";
import { terminateProcessTree } from "./process-tree.mjs";

export const CODEX_CLI_USAGE_TIMEOUT_MS = 15_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_BUCKETS = 16;

export class CodexCliUsageError extends Error {
  constructor(code, message, statusCode = 503) {
    super(message);
    this.name = "CodexCliUsageError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function failure(code, message, statusCode) {
  return new CodexCliUsageError(code, message, statusCode);
}

/** Resolve native executables and npm shims without a shell or command interpolation. */
export function resolveCodexCliInvocation(runtime = {}) {
  const env = runtime.env ?? process.env;
  const platform = runtime.platform ?? process.platform;
  const exists = runtime.existsSync ?? existsSync;
  const execPath = runtime.execPath ?? process.execPath;
  const api = platform === "win32" ? path.win32 : path.posix;
  const command = String(env.PI_WEBUI_CODEX_BIN || "codex").trim();
  const args = ["app-server", "--listen", "stdio://"];
  if (/\.(?:js|mjs|cjs)$/i.test(command)) return { command: execPath, args: [command, ...args] };
  if (platform !== "win32" || /\.(?:exe|com)$/i.test(command)) return { command, args };
  const directory = resolveCommandDirectory(command, { ...runtime, env, platform, existsSync: exists });
  if (directory && /^codex(?:\.(?:cmd|ps1))?$/i.test(api.basename(command))) {
    const native = api.join(directory, "codex.exe");
    if (!api.extname(command) && exists(native)) return { command: native, args };
    const script = api.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (exists(script)) return { command: execPath, args: [script, ...args] };
  }
  if (/\.(?:cmd|bat|ps1)$/i.test(command) || directory) {
    throw failure("CODEX_CLI_SHIM", "Codex CLI's Windows launcher cannot be used directly. Set PI_WEBUI_CODEX_BIN to codex.exe or the npm codex.js entry point.");
  }
  return { command, args };
}

function text(value, maximum = 80) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function windowSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) return null;
  return {
    usedPercent: value.usedPercent,
    windowDurationMins: Number.isInteger(value.windowDurationMins) && value.windowDurationMins > 0 && value.windowDurationMins <= 10_000_000 ? value.windowDurationMins : null,
    resetsAt: Number.isInteger(value.resetsAt) && value.resetsAt >= 0 && value.resetsAt <= 253402300799 ? value.resetsAt : null,
  };
}

function limitSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const credits = value.credits;
  return {
    limitId: text(value.limitId),
    limitName: text(value.limitName),
    planType: text(value.planType),
    rateLimitReachedType: text(value.rateLimitReachedType),
    primary: windowSnapshot(value.primary),
    secondary: windowSnapshot(value.secondary),
    credits: credits && typeof credits === "object" ? {
      hasCredits: typeof credits.hasCredits === "boolean" ? credits.hasCredits : undefined,
      unlimited: typeof credits.unlimited === "boolean" ? credits.unlimited : undefined,
      balance: typeof credits.balance === "string" && /^-?\d{1,32}(?:\.\d{1,16})?$/.test(credits.balance) ? credits.balance : null,
    } : null,
  };
}

/** Project only displayable quota fields. Account IDs, email and raw payloads stay private. */
export function projectCodexCliUsage(result, planType) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw failure("CODEX_CLI_PROTOCOL", "Codex CLI returned an invalid usage response.", 502);
  const rateLimits = limitSnapshot(result.rateLimits);
  const byId = result.rateLimitsByLimitId;
  const entries = byId && typeof byId === "object" && !Array.isArray(byId)
    ? Object.entries(byId).slice(0, MAX_BUCKETS).flatMap(([id, value]) => {
      const snapshot = limitSnapshot(value);
      return text(id) && snapshot ? [[id, snapshot]] : [];
    }) : [];
  if (![rateLimits, ...entries.map(([, snapshot]) => snapshot)].some((snapshot) => snapshot?.primary || snapshot?.secondary)) {
    throw failure("CODEX_CLI_NO_USAGE", "Codex CLI returned no supported subscription usage windows.", 502);
  }
  return { planType: text(planType), rateLimits, rateLimitsByLimitId: Object.fromEntries(entries) };
}

function waitForClose(closed, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    closed.then(() => { clearTimeout(timer); resolve(true); });
  });
}

/** A usage-only app-server connection. Never starts threads, turns, login flows or resets. */
export async function readCodexCliUsage(options = {}) {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? CODEX_CLI_USAGE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError("Codex CLI usage timeout must be between 1 and 60000ms");
  if (options.signal?.aborted) throw failure("CODEX_CLI_ABORTED", "Codex CLI usage check was cancelled.");
  const invocation = options.invocation ?? resolveCodexCliInvocation({ env });
  let child;
  try {
    child = (options.spawn ?? spawn)(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
  } catch {
    throw failure("CODEX_CLI_START", "Codex CLI could not start. Check its installation and PI_WEBUI_CODEX_BIN.");
  }
  const pending = new Map();
  let serial = 0;
  let terminalError;
  let finishClose;
  const closed = new Promise((resolve) => { finishClose = resolve; });
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const fail = (error) => {
    if (terminalError) return;
    terminalError = error;
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
  };
  const write = (frame) => {
    if (terminalError) throw terminalError;
    child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
      if (error) fail(failure("CODEX_CLI_PIPE", "Codex CLI closed its usage connection."));
    });
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    if (terminalError) { reject(terminalError); return; }
    const id = ++serial;
    pending.set(id, { resolve, reject });
    try { write({ id, method, params }); } catch (error) { pending.delete(id); reject(error); }
  });
  const receive = (line) => {
    if (!line.trim()) return;
    let frame;
    try { frame = JSON.parse(line); } catch { fail(failure("CODEX_CLI_PROTOCOL", "Codex CLI returned invalid usage protocol data.", 502)); return; }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) { fail(failure("CODEX_CLI_PROTOCOL", "Codex CLI returned invalid usage protocol data.", 502)); return; }
    if (typeof frame.method === "string") {
      // Reject unsolicited server requests rather than launching an auth flow,
      // approving work, or handing over credentials. Ignore notifications.
      if (frame.id !== undefined) {
        try { write({ id: frame.id, error: { code: -32601, message: "Usage-only client does not handle server requests." } }); } catch { /* request already failed */ }
      }
      return;
    }
    const operation = pending.get(frame.id);
    if (!operation) return;
    pending.delete(frame.id);
    if (frame.error) operation.reject(failure("CODEX_CLI_REQUEST", "Codex CLI could not read subscription usage. Check codex login status and try again.", 502));
    else if (!Object.hasOwn(frame, "result")) operation.reject(failure("CODEX_CLI_PROTOCOL", "Codex CLI returned an incomplete usage response.", 502));
    else operation.resolve(frame.result);
  };
  child.stdout.on("data", (chunk) => {
    if (terminalError) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_OUTPUT_BYTES) { fail(failure("CODEX_CLI_OUTPUT_LIMIT", "Codex CLI usage output exceeded the safe size limit.", 502)); return; }
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { fail(failure("CODEX_CLI_OUTPUT_LIMIT", "Codex CLI usage output exceeded the safe size limit.", 502)); return; }
      receive(line);
      if (terminalError) return;
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) fail(failure("CODEX_CLI_OUTPUT_LIMIT", "Codex CLI usage output exceeded the safe size limit.", 502));
  });
  child.stderr.on("data", (chunk) => {
    // Drain, but never retain or publish CLI diagnostics. They can contain secrets.
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_OUTPUT_BYTES) fail(failure("CODEX_CLI_OUTPUT_LIMIT", "Codex CLI usage diagnostics exceeded the safe size limit.", 502));
  });
  child.stdin.on("error", () => fail(failure("CODEX_CLI_PIPE", "Codex CLI closed its usage connection.")));
  child.stdout.on("error", () => fail(failure("CODEX_CLI_PIPE", "Codex CLI closed its usage connection.")));
  child.stderr.on("error", () => fail(failure("CODEX_CLI_PIPE", "Codex CLI closed its usage connection.")));
  child.on("error", (error) => fail(error?.code === "ENOENT"
    ? failure("CODEX_CLI_NOT_FOUND", "Codex CLI was not found. Install it or set PI_WEBUI_CODEX_BIN, then run codex login.")
    : failure("CODEX_CLI_START", "Codex CLI could not start. Check its installation and PI_WEBUI_CODEX_BIN.")));
  child.on("close", () => { finishClose(); fail(failure("CODEX_CLI_EXIT", "Codex CLI exited before completing the usage check.")); });
  const timer = setTimeout(() => fail(failure("CODEX_CLI_TIMEOUT", "Codex CLI subscription usage check timed out.", 504)), timeoutMs);
  const abort = () => fail(failure("CODEX_CLI_ABORTED", "Codex CLI usage check was cancelled."));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const terminate = options.terminate ?? terminateProcessTree;
  const onParentExit = () => terminate(child, "SIGKILL");
  process.once("exit", onParentExit);
  try {
    await request("initialize", { clientInfo: { name: "pi_webui_usage", title: "Pi Web UI usage", version: "1.0.0" } });
    write({ method: "initialized" });
    const account = await request("account/read", { refreshToken: false });
    if (!account?.account) throw failure("CODEX_CLI_LOGIN_REQUIRED", "Codex CLI is not logged in. Run codex login and sign in with ChatGPT.", 401);
    if (account.account.type !== "chatgpt") throw failure("CODEX_CLI_AUTH_TYPE", "Codex CLI subscription usage requires a ChatGPT login, not API-key or other provider authentication. Run codex login.", 401);
    const usage = await request("account/rateLimits/read", null);
    return projectCodexCliUsage(usage, account.account.planType);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    fail(failure("CODEX_CLI_CLOSED", "Codex CLI usage connection closed."));
    try {
      child.stdin.end();
      if (!await waitForClose(closed, 300)) {
        terminate(child, "SIGKILL");
        if (!await waitForClose(closed, 1_000)) {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
        }
      }
    } finally {
      process.removeListener("exit", onParentExit);
    }
  }
}
