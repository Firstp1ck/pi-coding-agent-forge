import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  RPC_SUPERVISOR_PROTOCOL,
  RpcSupervisorProtocolError,
  assertProtocolCompatible,
  encodeFrame,
  frameReader,
  newRequestId,
  protocolCurrent,
} from "./rpc-supervisor-protocol.mjs";
import {
  acquireStartupLock,
  defaultAgentDir,
  readSupervisorState,
  removeSupervisorState,
  sanitizedSupervisorEnvironment,
  supervisorPaths,
  supervisorPidIsAlive,
  waitForSupervisorState,
} from "./rpc-supervisor-state.mjs";

const DEFAULT_CONNECT_TIMEOUT_MS = 2_500;
const DEFAULT_ATTACH_TIMEOUT_MS = 2_500;
const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const supervisorScript = fileURLToPath(new URL("../bin/pi-webui-rpc-supervisor.mjs", import.meta.url));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function replacementConnectionError(error) {
  return error?.code === "ECONNREFUSED" || error?.code === "ENOENT";
}

function transientConnectionError(error) {
  return error?.code === "EPIPE" || error?.code === "ECONNRESET";
}

function liveStateError(state) {
  return Object.assign(new Error(`Refusing to replace RPC supervisor ${state.pid}: its recorded PID is still alive`), {
    code: "RPC_SUPERVISOR_LIVE_STATE",
  });
}

function supervisorRestartRequiredError(state, operation) {
  const version = state?.version;
  const remote = Number.isInteger(version?.major) && Number.isInteger(version?.minor) ? `${version.major}.${version.minor}` : "unknown";
  return Object.assign(new Error(`The detached RPC supervisor protocol ${remote} is older than this WebUI build and cannot ${operation}. Fully shut down Pi WebUI (not Restart), then start it again.`), {
    code: "RPC_SUPERVISOR_RESTART_REQUIRED",
  });
}

function openSocket(socketPath, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to RPC supervisor after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

export class RpcSupervisorClient {
  constructor({ socket, state, controllerId = randomUUID(), cursor, paths, attachTimeoutMs = DEFAULT_ATTACH_TIMEOUT_MS }) {
    this.socket = socket;
    this.state = state;
    this.paths = paths;
    this.controllerId = controllerId;
    this.cursor = cursor;
    this.attachTimeoutMs = attachTimeoutMs;
    this.connected = true;
    this.attached = false;
    this.pending = new Map();
    this.events = new Set();
    this.startupEvents = [];
    this.startupBuffering = true;
    this.snapshot = null;
    this.attachTimer = null;
    this.attachDeferred = deferred();
    this.attachDeferred.promise.catch(() => {});
    this.#listen();
  }

  #listen() {
    const consume = frameReader((frame) => this.#receive(frame), (error) => this.#fail(error));
    this.socket.on("data", consume);
    this.socket.on("error", (error) => this.#fail(error));
    this.socket.on("close", () => this.#fail(new Error("RPC supervisor connection closed")));
  }

  #dispatchEvent(frame) {
    for (const listener of this.events) {
      try { listener(frame); } catch { /* listeners are server-owned */ }
    }
  }

  #receive(frame) {
    if (frame.type === "attached") {
      try { assertProtocolCompatible(frame.version); } catch (error) { this.#fail(error); return; }
      if (this.attachTimer) clearTimeout(this.attachTimer);
      this.attachTimer = null;
      this.attached = true;
      this.snapshot = frame;
      this.attachDeferred.resolve(frame);
      return;
    }
    if (frame.type === "result" && typeof frame.requestId === "string") {
      const pending = this.pending.get(frame.requestId);
      if (!pending) return;
      this.pending.delete(frame.requestId);
      if (frame.ok === false) pending.reject(Object.assign(new Error(frame.error || "Supervisor operation failed"), { code: frame.code }));
      else pending.resolve(frame.data);
      return;
    }
    // Authentication, version, and other attach failures are intentionally
    // untagged because no requestId exists before attachment completes.
    if (!this.attached && frame.type === "result" && frame.ok === false) {
      this.#fail(Object.assign(new Error(frame.error || "RPC supervisor attach failed"), { code: frame.code || "RPC_SUPERVISOR_ATTACH" }));
      return;
    }
    if (frame.type === "event") {
      this.cursor = { epoch: frame.epoch, seq: frame.seq };
      if (this.startupBuffering) this.startupEvents.push(frame);
      else this.#dispatchEvent(frame);
      return;
    }
    if (frame.type === "fenced") this.#fail(Object.assign(new Error("RPC supervisor controller was fenced by a newer server"), { code: "RPC_SUPERVISOR_FENCED" }));
  }

  #fail(error) {
    if (!this.connected) return;
    this.connected = false;
    this.attached = false;
    if (this.attachTimer) clearTimeout(this.attachTimer);
    this.attachTimer = null;
    this.attachDeferred.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.socket.destroyed) this.socket.destroy();
  }

  #write(frame) {
    if (!this.connected || this.socket.destroyed) throw new Error("RPC supervisor is not connected");
    this.socket.write(encodeFrame(frame));
  }

  async attach() {
    if (!this.attachTimer) {
      this.attachTimer = setTimeout(() => {
        this.#fail(Object.assign(new Error(`Timed out attaching to RPC supervisor after ${this.attachTimeoutMs}ms`), { code: "RPC_SUPERVISOR_ATTACH_TIMEOUT" }));
      }, this.attachTimeoutMs);
      this.attachTimer.unref?.();
    }
    try {
      this.#write({
        type: "attach",
        version: RPC_SUPERVISOR_PROTOCOL,
        scopeId: this.state.scopeId,
        token: this.state.token,
        controllerId: this.controllerId,
        ...(this.cursor ? { cursor: this.cursor } : {}),
      });
    } catch (error) {
      this.#fail(error);
    }
    return this.attachDeferred.promise;
  }

  onEvent(listener) {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  /**
   * Deliver live events received after `attached` only after the caller has
   * hydrated snapshot/replay state. This preserves ordering without dropping
   * events for tabs whose listener did not exist during attachment.
   */
  drainStartupEvents() {
    const events = this.startupEvents;
    this.startupEvents = [];
    this.startupBuffering = false;
    for (const event of events) this.#dispatchEvent(event);
    return events;
  }

  isConnected() { return this.connected && this.attached; }
  isCurrentVersion() { return protocolCurrent(this.state.version); }

  request(type, payload = {}, { requestId = newRequestId() } = {}) {
    if (!this.attached) return Promise.reject(new Error("RPC supervisor client is not attached"));
    if (this.pending.has(requestId)) return this.pending.get(requestId).promise;
    const result = deferred();
    this.pending.set(requestId, result);
    try {
      this.#write({ type, requestId, ...payload });
    } catch (error) {
      this.pending.delete(requestId);
      result.reject(error);
    }
    return result.promise;
  }

  createTab({ tabId, metadata, child }, options) {
    if (!this.isCurrentVersion()) return Promise.reject(supervisorRestartRequiredError(this.state, "create a Pi tab"));
    return this.request("create", { tabId, metadata, child }, options);
  }
  updateTab(tabId, metadata, options) { return this.request("update", { tabId, metadata }, options); }
  replaceTab({ tabId, metadata, child }, options) {
    if (!this.isCurrentVersion()) return Promise.reject(supervisorRestartRequiredError(this.state, "replace a Pi tab"));
    return this.request("replace", { tabId, metadata, child }, options);
  }
  replaceTabUnderUpdate({ tabId, metadata, child, restart }, options) {
    if (!this.isCurrentVersion()) return Promise.reject(supervisorRestartRequiredError(this.state, "restart a Pi tab after an update"));
    return this.request("replace_update", { tabId, metadata, child, restart }, options);
  }
  closeTab(tabId, options) { return this.request("close", { tabId }, options); }
  command(tabId, command, { requestId = newRequestId(), timeoutMs } = {}) {
    return this.request("command", { tabId, command, ...(timeoutMs ? { timeoutMs } : {}) }, { requestId });
  }
  // Resolves when the supervisor has written the raw object to Pi stdin; it
  // deliberately never waits for a Pi response frame.
  write(tabId, command, { requestId = newRequestId() } = {}) {
    return this.request("write", { tabId, command }, { requestId });
  }
  ack(cursor = this.cursor, options) { return this.request("ack", { cursor }, options); }
  prepareHandoff(options) { return this.request("prepare_handoff", {}, options); }
  detach(options) { return this.request("detach", {}, options); }
  shutdown(options) { return this.request("shutdown", {}, options); }

  close() {
    if (!this.connected) return;
    this.socket.end();
    this.socket.destroy();
    this.#fail(new Error("RPC supervisor client closed"));
  }
}

export async function connectRpcSupervisor({ agentDir = defaultAgentDir(), port, controllerId, cursor, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, runtimeDir } = {}) {
  const paths = await supervisorPaths({ agentDir, port, runtimeDir });
  const state = await readSupervisorState(paths);
  if (!state) return null;
  assertProtocolCompatible(state.version);
  const socket = await openSocket(state.socketPath, connectTimeoutMs);
  const client = new RpcSupervisorClient({ socket, state, controllerId, cursor, paths });
  await client.attach();
  return client;
}

async function startSupervisor({ agentDir, port, runtimeDir, startupTimeoutMs, environment, script }) {
  const paths = await supervisorPaths({ agentDir, port, runtimeDir });
  const release = await acquireStartupLock(paths);
  if (!release) return false;
  try {
    // A reset or a stale pathname is not proof that its recorded owner died.
    // Under the exclusive lock, replace only a descriptor whose PID is known
    // dead; a live owner must be repaired rather than split into two hosts.
    const already = await readSupervisorState(paths);
    if (already) {
      if (supervisorPidIsAlive(already.pid)) throw liveStateError(already);
      const removed = await removeSupervisorState(paths, { removeSocket: true, instanceId: already.instanceId });
      if (!removed) throw new Error("RPC supervisor state changed while replacing a confirmed-dead owner");
    }
    const child = spawn(process.execPath, [script || supervisorScript, "--agent-dir", agentDir, "--port", String(port), ...(runtimeDir ? ["--runtime-dir", runtimeDir] : [])], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: sanitizedSupervisorEnvironment(environment || process.env),
    });
    child.unref();
    const state = await waitForSupervisorState(paths, { timeoutMs: startupTimeoutMs });
    if (!state) throw new Error(`RPC supervisor did not publish state within ${startupTimeoutMs}ms`);
    assertProtocolCompatible(state.version);
    return true;
  } finally {
    await release();
  }
}

/** Discover, attach, or atomically launch a detached owner for one agent-dir/port scope. */
export async function discoverStartAttachRpcSupervisor(options = {}) {
  const settings = {
    agentDir: options.agentDir || defaultAgentDir(),
    port: Number(options.port),
    runtimeDir: options.runtimeDir,
    controllerId: options.controllerId || randomUUID(),
    cursor: options.cursor,
    connectTimeoutMs: options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS,
    startupTimeoutMs: options.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS,
  };
  try {
    const existing = await connectRpcSupervisor(settings);
    if (existing) return existing;
  } catch (error) {
    // A live pipe reset is ambiguous. Starting another detached owner could
    // duplicate a command or strand the original Pi child, so fail closed.
    if (transientConnectionError(error) || !replacementConnectionError(error)) throw error;
  }
  await startSupervisor({ ...settings, environment: options.environment, script: options.supervisorScript });
  const deadline = Date.now() + settings.startupTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const client = await connectRpcSupervisor(settings);
      if (client) return client;
    } catch (error) {
      lastError = error;
      if (transientConnectionError(error) || !replacementConnectionError(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error("RPC supervisor state was not available after startup");
}
