import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { PI_RPC_JSONL_LINE_MAX_BYTES } from "../rpc-supervisor-protocol.mjs";

export function createRpcTransportTypes({
  assertNativeRpcAdmission,
  sanitizeError,
  requestTimeoutMs,
  supervisorCommandTimeoutMaxMs,
}) {
  const stderrMirrorFailureListeners = new Set();
  const stderrMirrorErrorHandlers = new WeakSet();

  function ensureStderrMirrorErrorHandler(stream) {
    if (stderrMirrorErrorHandlers.has(stream)) return;
    stderrMirrorErrorHandlers.add(stream);
    stream.on("error", (error) => {
      // Do not log from this handler: stderr is the failing sink and recursive
      // diagnostics can otherwise terminate the process. Active writers report
      // the failure through their normal Web UI event path instead.
      for (const reportFailure of [...stderrMirrorFailureListeners]) reportFailure(error);
    });
  }

  function mirrorPiStderr(text, onFailure) {
    const stream = process.stderr;
    let reported = false;
    const reportFailure = (error) => {
      if (reported) return;
      reported = true;
      stderrMirrorFailureListeners.delete(reportFailure);
      onFailure(error);
    };

    if (!stream?.writable || stream.destroyed || stream.writableEnded) {
      reportFailure(new Error("Web UI stderr sink is not writable"));
      return;
    }

    ensureStderrMirrorErrorHandler(stream);
    stderrMirrorFailureListeners.add(reportFailure);
    try {
      stream.write(text, (error) => {
        stderrMirrorFailureListeners.delete(reportFailure);
        if (error) reportFailure(error);
      });
    } catch (error) {
      reportFailure(error);
    }
  }

  class SupervisorPiRpcProcess {
    constructor({ supervisor, tabId, displayCommand = "supervised Pi RPC", cwd, snapshot = {} }) {
      this.supervisor = supervisor;
      this.tabId = tabId;
      this.displayCommand = displayCommand;
      this.cwd = cwd;
      this.startedAt = snapshot.startedAt || new Date().toISOString();
      this.listeners = new Set();
      this.metadataUpdate = Promise.resolve();
      this.admissionTail = Promise.resolve();
      this.applySnapshot(snapshot);
    }

    applySnapshot(snapshot = {}) {
      this.startedAt = snapshot.startedAt || this.startedAt;
      this.cwd = snapshot.metadata?.cwd || this.cwd;
      const running = snapshot.running !== false;
      this.child = {
        pid: Number.isInteger(snapshot.pid) ? snapshot.pid : undefined,
        exitCode: running ? null : 1,
        signalCode: null,
        killed: !running,
      };
    }

    isRunning() {
      return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
    }

    onEvent(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit(event) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error("webui listener failed:", error);
        }
      }
    }

    receiveSupervisorEvent(event) {
      const payload = event?.payload;
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "pi_process_start") {
        this.child = { pid: payload.pid, exitCode: null, signalCode: null, killed: false };
        this.startedAt = event.at || new Date().toISOString();
      } else if (payload.type === "pi_process_exit") {
        this.child = { ...(this.child || {}), exitCode: payload.code ?? 1, signalCode: payload.signal ?? null, killed: true };
      } else if (payload.type === "pi_process_error" && !this.isRunning()) {
        this.child = { ...(this.child || {}), exitCode: 1, signalCode: null, killed: true };
      }
      this.emit({
        ...payload,
        supervisorScopeId: event.scopeId,
        supervisorEpoch: event.epoch,
        supervisorSeq: event.seq,
      });
      if (payload.type === "pi_stderr" && payload.text) {
        mirrorPiStderr(payload.text, (error) => this.emit({
          type: "pi_stderr_sink_error",
          error: `Pi RPC stderr could not be mirrored to the Web UI server log: ${sanitizeError(error)}`,
        }));
      }
    }

    // Reserve wrapper order before admission's filesystem await. Only dispatch
    // holds the barrier: an RPC response may wait on a subsequent UI write.
    dispatchInOrder(operation) {
      const dispatch = this.admissionTail.catch(() => {}).then(operation);
      this.admissionTail = dispatch.then(() => {}, () => {});
      return dispatch;
    }

    async send(command, timeoutMs = requestTimeoutMs) {
      const response = await this.dispatchInOrder(async () => {
        await assertNativeRpcAdmission(command);
        const requestId = command?.id || randomUUID();
        const boundedTimeoutMs = Math.min(Math.max(1, Number(timeoutMs) || requestTimeoutMs), supervisorCommandTimeoutMaxMs);
        return { response: this.supervisor.command(this.tabId, command, { requestId, timeoutMs: boundedTimeoutMs }) };
      });
      return response.response;
    }

    async writeRaw(command) {
      return this.dispatchInOrder(async () => {
        await assertNativeRpcAdmission(command);
        return this.supervisor.write(this.tabId, command);
      });
    }

    async replace({ child, metadata, displayCommand, restart }) {
      const snapshot = await this.dispatchInOrder(async () => {
        const request = { tabId: this.tabId, metadata, child };
        return restart ? this.supervisor.replaceTabUnderUpdate({ ...request, restart }) : this.supervisor.replaceTab(request);
      });
      if (displayCommand) this.displayCommand = displayCommand;
      this.applySnapshot(snapshot);
      return snapshot;
    }

    updateMetadata(metadata) {
      this.metadataUpdate = this.metadataUpdate.catch(() => {}).then(() => this.supervisor.updateTab(this.tabId, metadata));
      return this.metadataUpdate;
    }

    async stop() {
      return this.supervisor.closeTab(this.tabId);
    }

    dispose() {
      this.listeners.clear();
    }
  }

  class PiRpcProcess {
    constructor({ command, args, displayCommand, cwd, env = process.env }) {
      this.command = command;
      this.args = args;
      this.displayCommand = displayCommand;
      this.cwd = cwd;
      this.env = env;
      this.child = undefined;
      this.spawned = false;
      this.pending = new Map();
      this.listeners = new Set();
      this.startedAt = new Date().toISOString();
      this.stderrMirrorFailureReported = false;
    }

    reportStderrMirrorFailure(error) {
      if (this.stderrMirrorFailureReported) return;
      this.stderrMirrorFailureReported = true;
      this.emit({
        type: "pi_stderr_sink_error",
        error: `Pi RPC stderr could not be mirrored to the Web UI server log: ${sanitizeError(error)}`,
      });
    }

    start() {
      this.spawned = false;
      this.child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const startup = new Promise((resolve, reject) => {
        this.child.once("spawn", () => {
          this.spawned = true;
          this.emit({ type: "pi_process_start", pid: this.child.pid, cwd: this.cwd, command: this.displayCommand, args: this.args });
          resolve();
        });
        this.child.on("error", (error) => {
          this.spawned = false;
          const message = sanitizeError(error);
          this.emit({ type: "pi_process_error", error: message });
          this.rejectAll(new Error(message));
          reject(new Error(message));
        });
      });

      this.child.on("exit", (code, signal) => {
        this.emit({ type: "pi_process_exit", code, signal });
        this.rejectAll(new Error(`Pi RPC process exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`));
      });

      this.attachJsonlReader(this.child.stdout, (line) => this.handleStdoutLine(line));
      this.attachTextReader(this.child.stderr, (text) => {
        if (text.length > 0) {
          // Publish before attempting the optional terminal mirror so a closed
          // stderr sink cannot hide Pi diagnostics from browser clients.
          this.emit({ type: "pi_stderr", text });
          mirrorPiStderr(text, (error) => this.reportStderrMirrorFailure(error));
        }
      });

      return startup;
    }

    isRunning() {
      return this.spawned && !!this.child && this.child.exitCode === null && !this.child.killed;
    }

    onEvent(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit(event) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error("webui listener failed:", error);
        }
      }
    }

    attachJsonlReader(stream, onLine) {
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let bufferBytes = 0;
      let discardingOversizedLine = false;

      const emitOversizedLine = () => this.emit({
        type: "pi_stdout_line_too_large",
        error: `Discarded a Pi RPC JSONL line larger than ${PI_RPC_JSONL_LINE_MAX_BYTES} bytes`,
        maxBytes: PI_RPC_JSONL_LINE_MAX_BYTES,
      });
      const consume = (chunk) => {
        let input = chunk;
        while (input.length > 0) {
          if (discardingOversizedLine) {
            const newlineIndex = input.indexOf("\n");
            if (newlineIndex === -1) return;
            discardingOversizedLine = false;
            input = input.slice(newlineIndex + 1);
            continue;
          }

          const newlineIndex = input.indexOf("\n");
          const segment = newlineIndex === -1 ? input : input.slice(0, newlineIndex);
          const segmentBytes = Buffer.byteLength(segment);
          if (bufferBytes + segmentBytes > PI_RPC_JSONL_LINE_MAX_BYTES) {
            buffer = "";
            bufferBytes = 0;
            emitOversizedLine();
            if (newlineIndex === -1) {
              discardingOversizedLine = true;
              return;
            }
            input = input.slice(newlineIndex + 1);
            continue;
          }

          buffer += segment;
          bufferBytes += segmentBytes;
          if (newlineIndex === -1) return;
          let line = buffer;
          buffer = "";
          bufferBytes = 0;
          if (line.endsWith("\r")) line = line.slice(0, -1);
          onLine(line);
          input = input.slice(newlineIndex + 1);
        }
      };

      stream.on("data", (chunk) => consume(typeof chunk === "string" ? chunk : decoder.write(chunk)));
      stream.on("end", () => {
        consume(decoder.end());
        if (!discardingOversizedLine && buffer.length > 0) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      });
    }

    attachTextReader(stream, onText) {
      const decoder = new StringDecoder("utf8");
      stream.on("data", (chunk) => onText(typeof chunk === "string" ? chunk : decoder.write(chunk)));
      stream.on("end", () => {
        const tail = decoder.end();
        if (tail) onText(tail);
      });
    }

    handleStdoutLine(line) {
      if (!line.trim()) return;

      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        this.emit({ type: "pi_stdout_parse_error", line, error: sanitizeError(error) });
        return;
      }

      if (event?.type === "response" && event.id && this.pending.has(event.id)) {
        const pending = this.pending.get(event.id);
        this.pending.delete(event.id);
        clearTimeout(pending.timeout);
        pending.resolve(event);
      }

      this.emit(event);
    }

    send(command, timeoutMs = requestTimeoutMs) {
      if (!this.isRunning() || !this.child?.stdin) {
        return Promise.reject(new Error("Pi RPC process is not running"));
      }

      const id = command.id || randomUUID();
      const payload = { ...command, id };

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Timed out waiting for RPC response to ${command.type}`));
        }, timeoutMs);

        this.pending.set(id, { resolve, reject, timeout });
        this.writeRaw(payload).catch((error) => {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(error);
        });
      });
    }

    async writeRaw(command) {
      if (!this.isRunning() || !this.child?.stdin) {
        throw new Error("Pi RPC process is not running");
      }
      await assertNativeRpcAdmission(command);
      const line = `${JSON.stringify(command)}\n`;
      if (!this.child.stdin.write(line)) {
        await new Promise((resolve) => this.child.stdin.once("drain", resolve));
      }
    }

    rejectAll(error) {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(error);
        this.pending.delete(id);
      }
    }

    stop() {
      if (!this.child || this.child.exitCode !== null) return;
      this.child.kill("SIGTERM");
      setTimeout(() => {
        if (this.child && this.child.exitCode === null) this.child.kill("SIGKILL");
      }, 3000).unref();
    }
  }

  return { PiRpcProcess, SupervisorPiRpcProcess };
}
