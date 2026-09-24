#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { lstat, readFile, rename, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { terminateProcessTree } from "../lib/process-tree.mjs";
import { acknowledgeUpdateFence, assertEffectAdmission, effectLockForRoot, readSharedJob, registerUpdateParticipant, sharedUpdateRoot, unregisterUpdateParticipant } from "../lib/update/coordination.mjs";
import {
  PI_RPC_JSONL_LINE_MAX_BYTES,
  RPC_SUPERVISOR_EVENT_RING_LIMIT,
  RPC_SUPERVISOR_EVENT_RING_MAX_BYTES,
  RPC_SUPERVISOR_PROTOCOL,
  RPC_SUPERVISOR_REQUEST_DEDUPE_LIMIT,
  RPC_SUPERVISOR_TAB_LIMIT,
  RpcSupervisorProtocolError,
  assertProtocolCompatible,
  constantTimeTokenEqual,
  deriveSupervisorRecoveryToken,
  encodeFrame,
  frameReader,
  validateClientFrame,
} from "../lib/rpc-supervisor-protocol.mjs";
import {
  appendSupervisorJournal,
  defaultAgentDir,
  ensureSupervisorRuntime,
  newSupervisorToken,
  readSupervisorState,
  removeSupervisorState,
  sanitizedSupervisorEnvironment,
  supervisorPaths,
  supervisorPidIsAlive,
  writeSupervisorState,
} from "../lib/rpc-supervisor-state.mjs";

const ATTACH_TIMEOUT_MS = 2_500;
const EMPTY_IDLE_GRACE_MS = 1_500;
const CHILD_STOP_GRACE_MS = 3_000;
const CHILD_STDIN_WRITE_TIMEOUT_MS = 2_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const READ_ONLY_RPC_COMMANDS = new Set(["get_state", "get_messages", "get_session_stats", "get_available_models", "get_commands"]);

function requestIdForErrorFrame(frame) {
  return typeof frame?.requestId === "string" && REQUEST_ID_PATTERN.test(frame.requestId) ? frame.requestId : undefined;
}

function cliOptions(argv) {
  const options = { agentDir: defaultAgentDir(), port: undefined, runtimeDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--agent-dir") options.agentDir = argv[++index];
    else if (value === "--port") options.port = Number(argv[++index]);
    else if (value === "--runtime-dir") options.runtimeDir = argv[++index];
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!options.agentDir || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("Usage: pi-webui-rpc-supervisor --agent-dir <private-agent-dir> --port <1-65535> [--runtime-dir <private-dir>]");
  }
  return options;
}

function tabSnapshot(tab) {
  return {
    id: tab.id,
    metadata: tab.metadata,
    pid: tab.child?.pid,
    startedAt: tab.startedAt,
    running: tabRunning(tab),
  };
}

function tabRunning(tab) {
  return !!tab?.child && tab.child.exitCode === null && tab.child.signalCode === null;
}

function publicError(error) {
  if (error instanceof RpcSupervisorProtocolError) return error.message;
  return String(error?.message || error || "Supervisor operation failed").replace(/(?:token|secret|password)=[^\s]+/gi, "$1=[redacted]");
}

function exitPromise(child, timeoutMs = CHILD_STOP_GRACE_MS) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

class SupervisorHost {
  constructor(paths) {
    this.paths = paths;
    this.token = newSupervisorToken();
    this.instanceId = randomUUID();
    this.epoch = randomUUID();
    this.sequence = 0n;
    this.tabs = new Map();
    this.events = [];
    this.retainedEventBytes = 0;
    this.requests = new Map();
    this.clients = new Set();
    this.controller = null;
    this.server = null;
    this.closing = false;
    this.idleTimer = null;
    this.persistQueue = Promise.resolve();
    this.updateParticipant = null;
    this.updateStateRoot = null;
  }

  async start() {
    await ensureSupervisorRuntime(this.paths);
    const current = await readSupervisorState(this.paths);
    if (current) {
      if (supervisorPidIsAlive(current.pid)) {
        throw Object.assign(new Error(`Refusing to replace live RPC supervisor ${current.pid}`), { code: "RPC_SUPERVISOR_LIVE_STATE" });
      }
      // A direct supervisor launch is still constrained to the same stale-state
      // rule as the client launcher. The normal replacement path also holds
      // the startup lock before reaching here.
      const removed = await removeSupervisorState(this.paths, { removeSocket: true, instanceId: current.instanceId });
      if (!removed) throw new Error("RPC supervisor state changed while removing a confirmed-dead owner");
    } else if (process.platform !== "win32") {
      // No descriptor exists to identify an incumbent. This can only clean an
      // orphaned local socket; a recorded live supervisor is never removed.
      await rm(this.paths.socketPath, { force: true }).catch(() => {});
    }
    this.server = createServer((socket) => this.accept(socket));
    this.server.on("error", (error) => {
      console.error(`RPC supervisor listener error: ${publicError(error)}`);
      this.shutdown("listener error").catch(() => process.exitCode = 1);
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server.off("listening", onListening); reject(error); };
      const onListening = () => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.paths.socketPath);
    });
    await this.persist("started");
    this.scheduleIdleExit();
  }

  persist(reason) {
    const operation = this.persistQueue.catch(() => {}).then(async () => {
      if (this.closing) return;
      const tabs = [...this.tabs.values()].map(tabSnapshot);
      await writeSupervisorState(this.paths, {
        token: this.token,
        instanceId: this.instanceId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        epoch: this.epoch,
        tabs,
      });
      await appendSupervisorJournal(this.paths, { type: "snapshot", reason, epoch: this.epoch, tabs }).catch(() => {});
    });
    this.persistQueue = operation;
    return operation;
  }

  accept(socket) {
    socket.setNoDelay(true);
    const client = { socket, attached: false, controllerId: null, attachTimer: null };
    client.attachTimer = setTimeout(() => {
      if (client.attached) return;
      this.sendError(client, undefined, Object.assign(new Error(`Timed out waiting for RPC supervisor attach after ${ATTACH_TIMEOUT_MS}ms`), { code: "RPC_SUPERVISOR_ATTACH_TIMEOUT" }));
      socket.destroy();
    }, ATTACH_TIMEOUT_MS);
    client.attachTimer.unref?.();
    this.clients.add(client);
    this.cancelIdleExit();
    const consume = frameReader(
      // Validation can fail before handleFrame has a normalized request. Echo a
      // syntactically safe raw request ID so the client rejects the matching
      // promise instead of leaving create/replace requests pending forever.
      (frame) => this.handleFrame(client, frame).catch((error) => this.sendError(client, requestIdForErrorFrame(frame), error)),
      (error) => { this.sendError(client, undefined, error); socket.destroy(); },
    );
    socket.on("data", consume);
    socket.on("error", () => {});
    socket.on("close", () => {
      if (client.attachTimer) clearTimeout(client.attachTimer);
      client.attachTimer = null;
      this.clients.delete(client);
      if (this.controller?.client === client) this.controller = null;
      this.scheduleIdleExit();
    });
  }

  send(client, frame) {
    if (!client?.socket || client.socket.destroyed) return;
    // Frames from Pi are local transport data, not persisted metadata. Never
    // strip or truncate them here; explicit frame-size validation rejects an
    // oversized record instead of silently changing it.
    try { client.socket.write(encodeFrame(frame)); } catch { client.socket.destroy(); }
  }

  sendError(client, requestId, error) {
    this.send(client, { type: "result", ...(requestId ? { requestId } : {}), ok: false, code: error?.code || "RPC_SUPERVISOR_ERROR", error: publicError(error) });
  }

  async handleFrame(client, frame) {
    const request = validateClientFrame(frame);
    if (request.type === "attach") return this.attach(client, request);
    if (!client.attached || this.controller?.client !== client || this.controller?.controllerId !== client.controllerId) {
      throw Object.assign(new Error("This RPC supervisor connection is not the active controller"), { code: "RPC_SUPERVISOR_FENCED" });
    }
    await this.operation(client, request);
  }

  attach(client, request) {
    assertProtocolCompatible(request.version);
    if (request.scopeId !== this.paths.scopeId || !constantTimeTokenEqual(request.token, this.token)) {
      throw Object.assign(new Error("RPC supervisor authentication failed"), { code: "RPC_SUPERVISOR_AUTH" });
    }
    if (this.controller && this.controller.client !== client) {
      this.send(this.controller.client, { type: "fenced", reason: "A newer server controller attached" });
      this.controller.client.attached = false;
    }
    if (client.attachTimer) clearTimeout(client.attachTimer);
    client.attachTimer = null;
    client.attached = true;
    client.controllerId = request.controllerId;
    this.controller = { client, controllerId: request.controllerId, attachedAt: Date.now() };
    const replay = this.replayFor(request.cursor);
    this.send(client, {
      type: "attached",
      version: RPC_SUPERVISOR_PROTOCOL,
      scopeId: this.paths.scopeId,
      epoch: this.epoch,
      tabs: [...this.tabs.values()].map(tabSnapshot),
      earliestSeq: this.events.length ? this.events[0].seq : this.sequence.toString(),
      latestSeq: this.sequence.toString(),
      gap: replay.gap,
      replay: replay.events,
    });
  }

  replayFor(cursor) {
    // A controller without a persisted handoff cursor cannot know which prior
    // output it observed. Replay the retained suffix and require authoritative
    // refresh whenever a live tab or retained history exists.
    if (!cursor) return { gap: this.tabs.size > 0 || this.events.length > 0, events: [...this.events] };
    if (cursor.epoch !== this.epoch) return { gap: true, events: [...this.events] };
    const sequence = BigInt(cursor.seq);
    const earliest = this.events.length ? BigInt(this.events[0].seq) : this.sequence + 1n;
    const gap = sequence + 1n < earliest;
    return { gap, events: this.events.filter((event) => BigInt(event.seq) > sequence) };
  }

  retainEvent(event) {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    // Keep a contiguous retained suffix. An oversized live event is forwarded
    // but clears prior history so cursors before it report an honest gap.
    if (bytes > RPC_SUPERVISOR_EVENT_RING_MAX_BYTES) {
      this.events = [];
      this.retainedEventBytes = 0;
      return;
    }
    this.events.push(event);
    this.retainedEventBytes += bytes;
    while (this.events.length > RPC_SUPERVISOR_EVENT_RING_LIMIT || this.retainedEventBytes > RPC_SUPERVISOR_EVENT_RING_MAX_BYTES) {
      const evicted = this.events.shift();
      this.retainedEventBytes -= Buffer.byteLength(JSON.stringify(evicted));
    }
  }

  emit(tabId, payload) {
    this.sequence += 1n;
    const event = { type: "event", epoch: this.epoch, seq: this.sequence.toString(), scopeId: this.paths.scopeId, tabId, at: new Date().toISOString(), payload };
    this.retainEvent(event);
    for (const client of this.clients) if (client.attached && this.controller?.client === client) this.send(client, event);
    return event;
  }

  pruneSettledRequests() {
    for (const [requestId, entry] of this.requests) {
      if (entry.settled) this.requests.delete(requestId);
    }
  }

  async operation(client, request) {
    const prior = this.requests.get(request.requestId);
    if (prior) {
      try { this.send(client, { type: "result", requestId: request.requestId, ok: true, data: await prior.promise }); }
      catch (error) { this.sendError(client, request.requestId, error); }
      return;
    }
    this.pruneSettledRequests();
    if (this.requests.size >= RPC_SUPERVISOR_REQUEST_DEDUPE_LIMIT) {
      this.sendError(client, request.requestId, Object.assign(new Error("RPC supervisor request dedupe capacity is occupied by unresolved work"), { code: "RPC_SUPERVISOR_DEDUPE_CAPACITY" }));
      return;
    }
    const mutating = !["ack", "prepare_handoff", "detach", "shutdown"].includes(request.type) &&
      !(request.type === "command" && READ_ONLY_RPC_COMMANDS.has(request.command?.type));
    const entry = { settled: false, promise: null, mutating };
    entry.promise = Promise.resolve().then(() => this.perform(request));
    entry.promise.then(() => { entry.settled = true; }, () => { entry.settled = true; });
    this.requests.set(request.requestId, entry);
    try { this.send(client, { type: "result", requestId: request.requestId, ok: true, data: await entry.promise }); }
    catch (error) { this.sendError(client, request.requestId, error); }
  }

  queueTabMutation(tabId, operation, updateRestart = false) {
    const tab = this.requireTab(tabId);
    const previous = tab.mutationTail || Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
      if (this.tabs.get(tabId) !== tab) throw new Error(`Managed tab is no longer available: ${tabId}`);
      if (this.updateParticipant && !updateRestart) await assertEffectAdmission(this.updateStateRoot, this.updateParticipant.canonicalRoots);
      return operation();
    });
    tab.mutationTail = result.catch(() => {});
    return result;
  }

  queueTabCommand(tabId, operation, readOnly = false) {
    const tab = this.requireTab(tabId);
    const previous = tab.mutationTail || Promise.resolve();
    let response;
    const admission = previous.catch(() => {}).then(async () => {
      if (this.tabs.get(tabId) !== tab) throw new Error(`Managed tab is no longer available: ${tabId}`);
      if (this.updateParticipant && !readOnly) await assertEffectAdmission(this.updateStateRoot, this.updateParticipant.canonicalRoots);
      // command() registers the pending response and writes to stdin
      // synchronously before returning its response promise. Release the FIFO
      // barrier at that point so extension-ui writes and later bounded probes
      // are not blocked by the full Pi response lifetime.
      response = operation();
    });
    tab.mutationTail = admission.catch(() => {});
    return admission.then(() => response);
  }

  async perform(request) {
    // Enter the tab's FIFO before any asynchronous fence check. Otherwise a
    // later replacement can overtake a write while both inspect the filesystem.
    switch (request.type) {
      case "create": return this.create(request);
      case "update": return this.queueTabMutation(request.tabId, () => this.update(request));
      case "replace": return this.queueTabMutation(request.tabId, () => this.replace(request));
      case "replace_update": return this.queueTabMutation(request.tabId, () => this.replaceUnderUpdate(request), true);
      case "close": return this.queueTabMutation(request.tabId, () => this.closeTab(request.tabId));
      // Commands take a FIFO admission position, but their full response must
      // not hold the queue: prompts can wait for extension-ui writes. Metadata
      // refreshes can also arrive continuously, so chasing a moving tail would
      // starve get_state and leave a CWD PATCH permanently in progress.
      case "command": return this.queueTabCommand(request.tabId, () => this.command(request),
        READ_ONLY_RPC_COMMANDS.has(request.command?.type));
      case "write": return this.queueTabMutation(request.tabId, () => this.write(request));
      case "ack": return { cursor: request.cursor };
      case "prepare_handoff": return { epoch: this.epoch, latestSeq: this.sequence.toString(), tabs: [...this.tabs.values()].map(tabSnapshot) };
      case "detach": return { detached: true };
      case "shutdown":
        setImmediate(() => this.shutdown("explicit shutdown"));
        return { shuttingDown: true };
      default: throw new Error(`Unsupported supervisor operation ${request.type}`);
    }
  }

  async create({ tabId, metadata, child }) {
    if (this.tabs.has(tabId)) throw new Error(`Managed tab already exists: ${tabId}`);
    if (this.tabs.size >= RPC_SUPERVISOR_TAB_LIMIT) throw new Error(`Managed tab limit is ${RPC_SUPERVISOR_TAB_LIMIT}`);
    const tab = { id: tabId, metadata, child: null, pending: new Map(), working: true, startedAt: new Date().toISOString(), mutationTail: Promise.resolve() };
    this.tabs.set(tabId, tab);
    try {
      if (this.updateParticipant) await assertEffectAdmission(this.updateStateRoot, this.updateParticipant.canonicalRoots);
      const candidate = await this.spawnChildCandidate(child);
      this.commitChild(tab, candidate);
    } catch (error) {
      this.tabs.delete(tabId);
      throw error;
    }
    await this.persist("create");
    return tabSnapshot(tab);
  }

  async update({ tabId, metadata }) {
    const tab = this.requireTab(tabId);
    tab.metadata = metadata;
    await this.persist("update");
    return tabSnapshot(tab);
  }

  async replace({ tabId, metadata, child }) {
    const tab = this.requireTab(tabId);
    await this.stopChild(tab, "replace");
    const candidate = await this.spawnChildCandidate(child);
    if (metadata !== undefined) tab.metadata = metadata;
    this.commitChild(tab, candidate);
    await this.persist("replace");
    return tabSnapshot(tab);
  }

  async replaceUnderUpdate(request) {
    if (!this.updateParticipant || !this.updateStateRoot) throw new Error("Update restart requires a registered RPC owner.");
    const { tabId, restart, metadata, child } = request;
    const tab = this.requireTab(tabId);
    if (!tabRunning(tab) || tab.working !== false || tab.pending.size > 0) throw new Error("Affected Pi tab is not verified idle.");
    const effectRoot = await realpath(restart.effectRoot);
    if (effectRoot !== restart.effectRoot || !this.updateParticipant.canonicalRoots.includes(effectRoot)) throw new Error("Unowned update effect root.");
    const lock = await effectLockForRoot(this.updateStateRoot, effectRoot);
    if (!lock || lock.token !== restart.lockToken || lock.transactionId !== restart.transactionId) throw new Error("Update fence identity changed.");
    const job = await readSharedJob(this.updateStateRoot, restart.transactionId);
    if (!job || job.phase !== "restart-authorized" || job.lock?.token !== lock.token ||
        !job.verifiedTargets?.some((item) => item.effectRoot === effectRoot && item.status === "healthy")) {
      throw new Error("No durable healthy completed update authorizes this Pi restart.");
    }
    const completed = JSON.parse(await readFile(path.join(job.jobDir, "complete.json"), "utf8"));
    if (completed.transactionId !== restart.transactionId || !completed.receipts?.some((item) =>
      (item.status === "changed" || item.status === "unchanged" && job.verifiedTargets.some((verified) =>
        verified.id === item.id && verified.piChanged === true)) && job.verifiedTargets.some((verified) =>
      verified.id === item.id && verified.effectRoot === effectRoot && verified.status === "healthy"))) {
      throw new Error("Command completion evidence does not match the authorized restart.");
    }
    const markerPath = path.join(job.jobDir, "restarts", `${restart.nonce}.json`);
    const usedPath = `${markerPath}.used`;
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    const requestDigest = createHash("sha256").update(JSON.stringify({ tabId, metadata, child })).digest("hex");
    if (marker.tabId !== tabId || marker.transactionId !== restart.transactionId || marker.lockToken !== lock.token ||
        marker.effectRoot !== effectRoot || marker.requestDigest !== requestDigest) throw new Error("Restart authorization does not bind this tab and replacement.");
    try { await lstat(usedPath); throw new Error("Restart authorization was already used."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(markerPath, usedPath);
    return this.replace(request);
  }

  async closeTab(tabId) {
    const tab = this.requireTab(tabId);
    await this.stopChild(tab, "close");
    this.tabs.delete(tabId);
    await this.persist("close");
    this.scheduleIdleExit();
    return { id: tabId, closed: true };
  }

  requireTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Managed tab not found: ${tabId}`);
    return tab;
  }

  async spawnChildCandidate(child) {
    const cwd = await realpath(child.cwd).catch(() => child.cwd);
    const env = sanitizedSupervisorEnvironment(process.env);
    if (env.PI_WEBUI_RECOVERY_URL) env.PI_WEBUI_RECOVERY_TOKEN = deriveSupervisorRecoveryToken(this.token);
    const processChild = spawn(child.command, child.args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      processChild.once("spawn", resolve);
      processChild.once("error", reject);
    });
    return { processChild, cwd, startedAt: new Date().toISOString() };
  }

  commitChild(tab, { processChild, cwd, startedAt }) {
    tab.child = processChild;
    tab.startedAt = startedAt;
    processChild.on("error", (error) => {
      if (tab.child !== processChild) return;
      this.emit(tab.id, { type: "pi_process_error", error: publicError(error) });
      this.rejectPending(tab, error);
    });
    processChild.on("exit", (code, signal) => {
      if (tab.child !== processChild) return;
      this.emit(tab.id, { type: "pi_process_exit", code, signal });
      this.rejectPending(tab, new Error(`Pi RPC process exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`));
      if (!this.closing) this.persist("child exit").catch(() => {});
    });
    // ChildProcess does not forward stdin pipe errors to its own `error`
    // event. A timed-out/backpressured one-way write followed by replacement
    // can otherwise emit an unhandled EPIPE and crash the detached supervisor.
    processChild.stdin.on("error", (error) => {
      if (tab.child !== processChild || !tabRunning(tab)) return;
      this.emit(tab.id, { type: "pi_stdin_error", error: publicError(error) });
      this.rejectPending(tab, error);
    });
    this.readJsonl(processChild.stdout, (line) => {
      if (tab.child === processChild) this.handlePiLine(tab, line);
    }, tab.id);
    this.readText(processChild.stderr, (text) => {
      if (text && tab.child === processChild) this.emit(tab.id, { type: "pi_stderr", text });
    });
    // The executable/arguments are launch details, not WebUI event data; never
    // publish them because command-line credentials must stay private.
    this.emit(tab.id, { type: "pi_process_start", pid: processChild.pid, cwd });
  }

  readJsonl(stream, onLine, tabId) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let bytes = 0;
    let discarding = false;
    const consume = (chunk) => {
      let input = typeof chunk === "string" ? chunk : decoder.write(chunk);
      while (input) {
        if (discarding) {
          const newline = input.indexOf("\n");
          if (newline < 0) return;
          input = input.slice(newline + 1); discarding = false; continue;
        }
        const newline = input.indexOf("\n");
        const piece = newline < 0 ? input : input.slice(0, newline);
        const size = Buffer.byteLength(piece);
        if (bytes + size > PI_RPC_JSONL_LINE_MAX_BYTES) {
          buffer = ""; bytes = 0;
          this.emit(tabId, { type: "pi_stdout_line_too_large", maxBytes: PI_RPC_JSONL_LINE_MAX_BYTES });
          if (newline < 0) { discarding = true; return; }
          input = input.slice(newline + 1); continue;
        }
        buffer += piece; bytes += size;
        if (newline < 0) return;
        const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
        buffer = ""; bytes = 0;
        if (line) onLine(line);
        input = input.slice(newline + 1);
      }
    };
    stream.on("data", consume);
    stream.on("end", () => { consume(decoder.end()); if (!discarding && buffer) onLine(buffer); });
  }

  readText(stream, onText) {
    const decoder = new StringDecoder("utf8");
    stream.on("data", (chunk) => onText(typeof chunk === "string" ? chunk : decoder.write(chunk)));
    stream.on("end", () => { const tail = decoder.end(); if (tail) onText(tail); });
  }

  handlePiLine(tab, line) {
    let payload;
    try { payload = JSON.parse(line); }
    catch (error) { this.emit(tab.id, { type: "pi_stdout_parse_error", line: line.slice(0, 4096), error: publicError(error) }); return; }
    if (payload?.type === "response" && typeof payload.id === "string" && tab.pending.has(payload.id)) {
      const pending = tab.pending.get(payload.id);
      tab.pending.delete(payload.id);
      clearTimeout(pending.timer);
      pending.resolve(payload);
    }
    if (payload?.type === "agent_start" || payload?.type === "compaction_start") tab.working = true;
    if (payload?.type === "agent_settled" || payload?.type === "compaction_end") tab.working = false;
    if (payload?.type === "response" && payload.command === "get_state" && payload.success !== false) {
      tab.working = payload.data?.isStreaming === true || payload.data?.isCompacting === true;
    }
    this.emit(tab.id, payload);
  }

  command({ tabId, requestId, command, timeoutMs = 60_000 }) {
    const tab = this.requireTab(tabId);
    if (!tabRunning(tab) || !tab.child?.stdin?.writable) throw new Error("Pi RPC process is not running");
    const payload = { ...command, id: requestId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        tab.pending.delete(requestId);
        reject(new Error(`Timed out waiting for RPC response to ${payload.type}`));
      }, timeoutMs);
      timer.unref?.();
      tab.pending.set(requestId, { resolve, reject, timer });
      try {
        const writable = tab.child.stdin.write(`${JSON.stringify(payload)}\n`);
        if (!writable) tab.child.stdin.once("drain", () => {});
      } catch (error) {
        clearTimeout(timer);
        tab.pending.delete(requestId);
        reject(error);
      }
    });
  }

  write({ tabId, command }) {
    const tab = this.requireTab(tabId);
    if (!tabRunning(tab) || !tab.child?.stdin?.writable) throw new Error("Pi RPC process is not running");
    // Unlike `command`, this preserves the supplied Pi RPC object exactly and
    // never waits for a Pi response. Keep FIFO ordering until Node flushes the
    // record, but bound that wait: a backpressured/unresponsive child must not
    // poison the tab mutation queue and block reload, CWD changes, or startup
    // probes for a forked tab forever.
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve({ written: true });
      };
      timer = setTimeout(() => finish(Object.assign(
        new Error(`Timed out flushing a one-way Pi RPC write after ${CHILD_STDIN_WRITE_TIMEOUT_MS}ms`),
        { code: "RPC_SUPERVISOR_CHILD_WRITE_TIMEOUT" },
      )), CHILD_STDIN_WRITE_TIMEOUT_MS);
      timer.unref?.();
      try {
        tab.child.stdin.write(`${JSON.stringify(command)}\n`, finish);
      } catch (error) {
        finish(error);
      }
    });
  }

  rejectPending(tab, error) {
    for (const [id, pending] of tab.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      tab.pending.delete(id);
    }
  }

  async stopChild(tab, reason) {
    if (!tab.child) return;
    const child = tab.child;
    this.emit(tab.id, { type: "pi_process_stopping", reason });
    terminateProcessTree(child, "SIGTERM");
    await exitPromise(child);
    if (tabRunning(tab)) {
      terminateProcessTree(child, "SIGKILL");
      await exitPromise(child, 1_000);
    }
    if (tabRunning(tab)) {
      throw Object.assign(new Error(`Pi RPC process ${child.pid || "unknown"} did not stop for ${reason}`), {
        code: "RPC_SUPERVISOR_CHILD_STOP_TIMEOUT",
      });
    }
    this.rejectPending(tab, new Error(`Pi RPC process stopped for ${reason}`));
  }

  cancelIdleExit() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  scheduleIdleExit() {
    if (this.closing || this.tabs.size || this.clients.size || this.idleTimer) return;
    this.idleTimer = setTimeout(() => this.shutdown("idle"), EMPTY_IDLE_GRACE_MS);
    this.idleTimer.unref?.();
  }

  async shutdown(reason) {
    if (this.closing) return;
    this.closing = true;
    this.cancelIdleExit();
    const stopResults = await Promise.allSettled([...this.tabs.values()].map((tab) => this.stopChild(tab, reason)));
    const stopFailures = stopResults.filter((result) => result.status === "rejected");
    if (stopFailures.length) {
      this.closing = false;
      await this.persist("shutdown blocked by live child").catch(() => {});
      console.error(`RPC supervisor shutdown blocked: ${stopFailures.map((result) => publicError(result.reason)).join("; ")}`);
      return false;
    }
    await this.persistQueue.catch(() => {});
    this.tabs.clear();
    for (const client of this.clients) client.socket.destroy();
    await new Promise((resolve) => this.server?.close(() => resolve()) || resolve());
    await removeSupervisorState(this.paths, { removeSocket: true, instanceId: this.instanceId }).catch(() => {});
    if (this.updateParticipant) await unregisterUpdateParticipant(this.updateParticipant).catch(() => {});
    process.exit(0);
  }
}

const options = cliOptions(process.argv.slice(2));
const paths = await supervisorPaths(options);
const host = new SupervisorHost(paths);
const effects = (() => {
  try { return JSON.parse(process.env.PI_WEBUI_UPDATE_EFFECT_ROOTS || "[]"); } catch { return []; }
})();
if (Array.isArray(effects) && effects.length && effects.every((root) => typeof root === "string")) {
  host.updateStateRoot = await sharedUpdateRoot();
  host.updateParticipant = await registerUpdateParticipant(host.updateStateRoot, { kind: "rpc-supervisor", roots: effects });
  setInterval(async () => {
    try {
      for (const effect of host.updateParticipant.canonicalRoots) {
        const lock = await effectLockForRoot(host.updateStateRoot, effect);
        if (!lock) continue;
        const idle = ![...host.requests.values()].some((request) => request.mutating && !request.settled) &&
          [...host.tabs.values()].every((tab) => tab.working === false && tab.pending.size === 0 && tab.child?.exitCode === null);
        await acknowledgeUpdateFence(host.updateParticipant, { token: lock.token, effects: [effect] }, idle);
      }
    } catch (error) { console.warn(`Update admission acknowledgement failed: ${publicError(error)}`); }
  }, 250).unref();
}
try { await host.start(); }
catch (error) {
  if (host.updateParticipant) await unregisterUpdateParticipant(host.updateParticipant).catch(() => {});
  throw error;
}
