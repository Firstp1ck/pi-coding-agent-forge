import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PI_RPC_JSONL_LINE_MAX_BYTES } from "../lib/rpc-supervisor-protocol.mjs";
import { createRpcTransportTypes } from "../lib/server/rpc-transports.mjs";

const moduleUrl = new URL("../lib/server/rpc-transports.mjs", import.meta.url).href;
const defaults = {
  assertNativeRpcAdmission: async () => {},
  sanitizeError: (error) => error.message || String(error),
  requestTimeoutMs: 1_000,
  supervisorCommandTimeoutMaxMs: 5_000,
};
const types = (options = {}) => createRpcTransportTypes({ ...defaults, ...options });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitFor(probe, description, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = probe();
    if (result) return result;
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${description}`);
}

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "webui-rpc-transports-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function runProbe(t, source) {
  const root = await temporaryRoot(t);
  const file = path.join(root, "probe.mjs");
  await writeFile(file, source);
  const result = spawnSync(process.execPath, [file], {
    cwd: root, env: {}, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr || `Probe ended with ${result.signal}`);
  return result.stdout;
}

const childSource = `
import { createInterface } from "node:readline";
const output = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  output({ type: "observed", command });
  if (command.type === "hold" || command.type === "raw") return;
  if (command.type === "exit") return process.exit(7);
  if (command.type === "malformed") {
    process.stdout.write("not-json\\n\\r\\n");
  }
  if (command.type === "utf8") {
    const bytes = Buffer.from(JSON.stringify({ type: "unicode", text: "🐈 café" }) + "\\r\\n");
    const split = bytes.indexOf(Buffer.from("🐈")) + 2;
    process.stdout.write(bytes.subarray(0, split));
    setImmediate(() => {
      process.stdout.write(bytes.subarray(split));
      output({ type: "response", id: command.id, success: true });
    });
    return;
  }
  output({ type: "response", id: command.id, success: true, data: command });
});
`;

async function directFixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "webui-rpc-transports-"));
  let rpc;
  let closed;
  t.after(async () => {
    try {
      if (rpc?.child?.exitCode === null && rpc.child.signalCode === null) rpc.child.kill("SIGKILL");
      if (closed) {
        await Promise.race([
          closed,
          delay(3_000, null, { ref: false }).then(() => assert.fail("Fixture child did not close")),
        ]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const file = path.join(root, "rpc-child.mjs");
  await writeFile(file, childSource);
  const { PiRpcProcess } = types(options);
  rpc = new PiRpcProcess({
    command: process.execPath, args: [file], displayCommand: "fixture RPC", cwd: root, env: {},
  });
  const events = [];
  rpc.onEvent((event) => events.push(event));
  const startup = rpc.start();
  closed = new Promise((resolve) => rpc.child.once("close", resolve));
  await startup;
  return { rpc, events, root, closed };
}

function supervisedFixture(options = {}, methods = {}) {
  const calls = [];
  const supervisor = {
    command: async (...args) => { calls.push(["command", ...args]); return { success: true }; },
    write: async (...args) => { calls.push(["write", ...args]); },
    replaceTab: async (...args) => { calls.push(["replace", ...args]); return { pid: 42 }; },
    replaceTabUnderUpdate: async (...args) => { calls.push(["replaceUpdate", ...args]); return { pid: 43 }; },
    updateTab: async (...args) => { calls.push(["update", ...args]); },
    closeTab: async (...args) => { calls.push(["close", ...args]); return "closed"; },
    ...methods,
  };
  const { SupervisorPiRpcProcess } = types(options);
  const rpc = new SupervisorPiRpcProcess({ supervisor, tabId: "tab-1", cwd: "/fixture" });
  const events = [];
  rpc.onEvent((event) => events.push(event));
  return { rpc, events, supervisor, calls };
}

test("import and factory creation have no process, timer, stderr or admission effects", { timeout: 15_000 }, async (t) => {
  const output = await runProbe(t, `
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const fail = () => { throw new Error("Unexpected effect"); };
    childProcess.spawn = fail;
    syncBuiltinESMExports();
    globalThis.setTimeout = fail;
    globalThis.setInterval = fail;
    const listeners = process.stderr.listenerCount("error");
    const { createRpcTransportTypes } = await import(${JSON.stringify(moduleUrl)});
    const pair = createRpcTransportTypes({
      assertNativeRpcAdmission: fail, sanitizeError: fail,
      requestTimeoutMs: 50, supervisorCommandTimeoutMaxMs: 100,
    });
    assert.deepEqual(Object.keys(pair).sort(), ["PiRpcProcess", "SupervisorPiRpcProcess"]);
    assert.equal(pair.PiRpcProcess, pair.PiRpcProcess);
    assert.equal(pair.SupervisorPiRpcProcess, pair.SupervisorPiRpcProcess);
    assert.equal(process.stderr.listenerCount("error"), listeners);
    const direct = new pair.PiRpcProcess({ command: "unused", args: [], cwd: "/fixture" });
    const supervised = new pair.SupervisorPiRpcProcess({ supervisor: {}, tabId: "unused" });
    assert.ok(direct instanceof pair.PiRpcProcess);
    assert.ok(supervised instanceof pair.SupervisorPiRpcProcess);
    assert.equal(direct.child, undefined);
    assert.equal(direct.isRunning(), false);
    assert.equal(process.stderr.listenerCount("error"), listeners);
    process.stdout.write("no effects");
  `);
  assert.equal(output, "no effects");
});

test("direct process preserves startup, request identity, response events and one-way raw writes", { timeout: 10_000 }, async (t) => {
  const { rpc, events, root, closed } = await directFixture(t);
  assert.equal(rpc.isRunning(), true);
  assert.deepEqual(events[0], {
    type: "pi_process_start", pid: rpc.child.pid, cwd: root,
    command: "fixture RPC", args: rpc.args,
  });
  const command = { type: "echo", id: "caller-id", data: "value" };
  const response = await rpc.send(command);
  assert.equal(response.id, command.id);
  assert.deepEqual(response.data, command);
  assert.equal(events.find((event) => event.type === "response"), response);
  assert.equal(rpc.pending.size, 0);
  const generated = await rpc.send({ type: "echo" });
  assert.match(generated.id, /^[0-9a-f-]{36}$/);

  await rpc.writeRaw({ type: "raw", id: "raw-id", value: "unanswered" });
  const raw = await waitFor(() => events.find((event) => event.command?.id === "raw-id"), "raw write");
  assert.deepEqual(raw.command, { type: "raw", id: "raw-id", value: "unanswered" });
  assert.equal(rpc.pending.size, 0);
  assert.equal(events.some((event) => event.type === "response" && event.id === "raw-id"), false);
  let unsubscribedCalls = 0;
  const unsubscribe = rpc.onEvent(() => { unsubscribedCalls += 1; });
  unsubscribe();
  rpc.stop();
  await closed;
  assert.equal(unsubscribedCalls, 0);
  assert.equal(rpc.isRunning(), false);
  assert.ok(events.some((event) => event.type === "pi_process_exit"));
  await assert.rejects(rpc.send({ type: "echo" }), /not running/);
  await assert.rejects(rpc.writeRaw({ type: "raw" }), /not running/);
});

test("direct admission completes before bytes are written and refusal cleans pending requests", { timeout: 10_000 }, async (t) => {
  const gate = deferred();
  const admitted = [];
  const { rpc, events } = await directFixture(t, {
    assertNativeRpcAdmission: async (command) => {
      admitted.push(command);
      if (command.type === "denied") throw new Error("admission fenced");
      await gate.promise;
    },
  });
  const pending = rpc.send({ type: "echo", id: "gated" });
  const raw = rpc.writeRaw({ type: "raw", id: "gated-raw" });
  assert.deepEqual(admitted.map((command) => command.id), ["gated", "gated-raw"]);
  assert.equal(rpc.pending.size, 1);
  assert.equal(events.some((event) => event.type === "observed"), false);
  gate.resolve();
  await Promise.all([pending, raw]);
  await waitFor(() => events.some((event) => event.command?.id === "gated-raw"), "admitted raw write");
  await assert.rejects(rpc.send({ type: "denied", id: "refused" }), /admission fenced/);
  await assert.rejects(rpc.writeRaw({ type: "denied", id: "refused-raw" }), /admission fenced/);
  assert.equal(rpc.pending.size, 0);
  assert.equal(events.some((event) => event.command?.type === "denied"), false);
});

test("direct timeouts, serialization errors and process exit reject and clear the pending map", { timeout: 10_000 }, async (t) => {
  const { rpc, events, closed } = await directFixture(t, { requestTimeoutMs: 40 });
  await assert.rejects(rpc.send({ type: "hold", id: "timeout" }), /Timed out waiting for RPC response to hold/);
  assert.equal(rpc.pending.size, 0);
  rpc.handleStdoutLine(JSON.stringify({ type: "response", id: "timeout", success: true }));
  assert.ok(events.some((event) => event.type === "response" && event.id === "timeout"));
  const circular = { type: "circular" };
  circular.self = circular;
  await assert.rejects(rpc.send(circular), /circular/i);
  assert.equal(rpc.pending.size, 0);
  const held = rpc.send({ type: "hold", id: "exit-pending" }, 3_000);
  const exiting = rpc.send({ type: "exit", id: "exit-trigger" }, 3_000);
  await Promise.all([
    assert.rejects(held, /Pi RPC process exited with code 7/),
    assert.rejects(exiting, /Pi RPC process exited with code 7/),
  ]);
  await closed;
  assert.equal(rpc.pending.size, 0);
  assert.equal(rpc.isRunning(), false);
});

test("direct spawn failure emits the sanitized error and never becomes running", { timeout: 5_000 }, async (t) => {
  const root = await temporaryRoot(t);
  const { PiRpcProcess } = types({ sanitizeError: (error) => `sanitized:${error.code}` });
  const rpc = new PiRpcProcess({ command: path.join(root, "missing-node"), args: [], cwd: root, env: {} });
  const events = [];
  rpc.onEvent((event) => events.push(event));
  const startup = rpc.start();
  const closed = new Promise((resolve) => rpc.child.once("close", resolve));
  await assert.rejects(startup, /sanitized:ENOENT/);
  await closed;
  assert.deepEqual(events, [{ type: "pi_process_error", error: "sanitized:ENOENT" }]);
  assert.equal(rpc.isRunning(), false);
  assert.equal(rpc.pending.size, 0);
});

test("direct child JSONL handles malformed records and UTF-8 across writes", { timeout: 10_000 }, async (t) => {
  const { rpc, events } = await directFixture(t);
  await rpc.send({ type: "malformed" });
  assert.equal(events.filter((event) => event.type === "pi_stdout_parse_error").length, 1);
  assert.equal(events.find((event) => event.type === "pi_stdout_parse_error").line, "not-json");
  await rpc.send({ type: "utf8" });
  assert.deepEqual(events.find((event) => event.type === "unicode"), { type: "unicode", text: "🐈 café" });
});

test("readers preserve split UTF-8, CRLF, unterminated records and decoder tails", () => {
  const { PiRpcProcess } = types();
  const rpc = new PiRpcProcess({ command: "unused", args: [] });
  const jsonl = new PassThrough();
  const lines = [];
  rpc.attachJsonlReader(jsonl, (line) => lines.push(line));
  const bytes = Buffer.from('  \r\n{"text":"🐈 café"}\r\nlast\r');
  for (const byte of bytes) jsonl.write(Buffer.from([byte]));
  jsonl.emit("end");
  assert.deepEqual(lines, ["  ", '{"text":"🐈 café"}', "last"]);
  const text = new PassThrough();
  const chunks = [];
  rpc.attachTextReader(text, (chunk) => chunks.push(chunk));
  for (const byte of Buffer.from("🐈 café")) text.write(Buffer.from([byte]));
  text.write(Buffer.from([0xe2]));
  text.emit("end");
  assert.equal(chunks.join(""), "🐈 café�");
});

test("JSONL bounds count UTF-8 bytes and recover once after each oversized line", () => {
  const { PiRpcProcess } = types();
  const rpc = new PiRpcProcess({ command: "unused", args: [] });
  const stream = new PassThrough();
  const events = [];
  const lines = [];
  rpc.onEvent((event) => events.push(event));
  rpc.attachJsonlReader(stream, (line) => lines.push(line));
  assert.equal(PI_RPC_JSONL_LINE_MAX_BYTES, 32 * 1024 * 1024);
  const megabyte = "a".repeat(1024 * 1024);
  for (let i = 0; i < 32; i += 1) stream.write(megabyte);
  stream.write("\n");
  assert.equal(Buffer.byteLength(lines[0]), PI_RPC_JSONL_LINE_MAX_BYTES);
  lines.length = 0;
  for (let i = 0; i < 32; i += 1) stream.write(megabyte);
  stream.write("é");
  stream.write("discarded remainder");
  assert.equal(events.length, 1);
  stream.write("\nrecovered\r\n");
  stream.write("é".repeat(PI_RPC_JSONL_LINE_MAX_BYTES / 2) + "a\nnext\n");
  assert.equal(events.length, 2);
  assert.deepEqual(lines, ["recovered", "next"]);
  for (const event of events) {
    assert.deepEqual(event, {
      type: "pi_stdout_line_too_large",
      error: `Discarded a Pi RPC JSONL line larger than ${PI_RPC_JSONL_LINE_MAX_BYTES} bytes`,
      maxBytes: PI_RPC_JSONL_LINE_MAX_BYTES,
    });
  }
  for (let i = 0; i < 32; i += 1) stream.write(megabyte);
  stream.write("a");
  stream.emit("end");
  assert.equal(events.length, 3);
  assert.deepEqual(lines, ["recovered", "next"]);
});

test("direct raw backpressure waits for drain without creating a response waiter", async () => {
  const { PiRpcProcess } = types();
  const rpc = new PiRpcProcess({ command: "unused", args: [] });
  const stdin = new PassThrough();
  const writes = [];
  stdin.write = (line) => { writes.push(line); return false; };
  rpc.spawned = true;
  rpc.child = { stdin, exitCode: null, killed: false };
  let finished = false;
  const raw = rpc.writeRaw({ type: "raw", id: "unchanged" }).then(() => { finished = true; });
  await waitFor(() => writes.length, "backpressured write");
  assert.equal(finished, false);
  assert.deepEqual(writes, ['{"type":"raw","id":"unchanged"}\n']);
  assert.equal(rpc.pending.size, 0);
  stdin.emit("drain");
  await raw;
  assert.equal(finished, true);
  assert.equal(stdin.listenerCount("drain"), 0);
});

test("supervised admission serializes dispatch but never holds a barrier for an RPC response", { timeout: 5_000 }, async () => {
  const gate = deferred();
  const response = deferred();
  const order = [];
  const { rpc, calls } = supervisedFixture({
    assertNativeRpcAdmission: async (command) => {
      order.push(`admit:${command.type}`);
      if (command.type === "prompt") await gate.promise;
    },
  }, {
    command: (tabId, command, options) => {
      calls.push(["command", tabId, command, options]);
      order.push("dispatch:prompt");
      return response.promise;
    },
    write: async (tabId, command) => {
      calls.push(["write", tabId, command]);
      order.push("dispatch:raw");
      response.resolve({ type: "response", id: "prompt-id" });
    },
  });
  const command = { type: "prompt", id: "prompt-id" };
  const pending = rpc.send(command);
  const raw = rpc.writeRaw({ type: "extension_ui_response", id: "approval-id" });
  await waitFor(() => order.length, "first admission");
  assert.deepEqual(order, ["admit:prompt"]);
  assert.deepEqual(calls, []);
  gate.resolve();
  await raw;
  assert.deepEqual(await pending, { type: "response", id: "prompt-id" });
  assert.deepEqual(order, ["admit:prompt", "dispatch:prompt", "admit:extension_ui_response", "dispatch:raw"]);
  assert.equal(calls[0][2], command);
  assert.deepEqual(calls[0][3], { requestId: "prompt-id", timeoutMs: 1_000 });
  assert.deepEqual(calls[1], ["write", "tab-1", { type: "extension_ui_response", id: "approval-id" }]);
});

test("supervised timeout bounds, generated IDs and admission or dispatch failures preserve later dispatch", { timeout: 5_000 }, async () => {
  const { rpc, calls } = supervisedFixture({
    assertNativeRpcAdmission: async (command) => {
      if (command.type === "denied") throw new Error("admission fenced");
    },
  });
  for (const [input, expected] of [[undefined, 1_000], [0, 1_000], [-5, 1], [9_000, 5_000], [Infinity, 5_000], ["12", 12], ["bad", 1_000]]) {
    await rpc.send({ type: "echo" }, input);
    const options = calls.at(-1)[3];
    assert.match(options.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(options.timeoutMs, expected);
    assert.equal(calls.at(-1)[2].id, undefined);
  }
  const count = calls.length;
  await assert.rejects(rpc.send({ type: "denied" }), /admission fenced/);
  await assert.rejects(rpc.writeRaw({ type: "denied" }), /admission fenced/);
  assert.equal(calls.length, count);
  rpc.supervisor.command = () => { throw new Error("sync dispatch failure"); };
  await assert.rejects(rpc.send({ type: "echo" }), /sync dispatch failure/);
  rpc.supervisor.command = () => Promise.reject(new Error("async response failure"));
  await assert.rejects(rpc.send({ type: "echo" }), /async response failure/);
  await rpc.writeRaw({ type: "raw" });
  assert.equal(calls.at(-1)[0], "write");
});

test("supervised snapshots, events and dispose retain wrapper ownership without stopping the host", async () => {
  const { rpc, events, calls } = supervisedFixture();
  assert.equal(rpc.isRunning(), true);
  const startedAt = rpc.startedAt;
  rpc.applySnapshot({ pid: 12, metadata: { cwd: "/next" }, running: false });
  assert.equal(rpc.startedAt, startedAt);
  assert.equal(rpc.cwd, "/next");
  assert.deepEqual(rpc.child, { pid: 12, exitCode: 1, signalCode: null, killed: true });
  rpc.receiveSupervisorEvent({ payload: { type: "pi_process_error", error: "offline" }, scopeId: "scope", epoch: "epoch", seq: "1" });
  assert.equal(rpc.isRunning(), false);
  rpc.receiveSupervisorEvent({ payload: { type: "pi_process_start", pid: 13 }, at: "fixture-time", scopeId: "scope", epoch: "epoch", seq: "2" });
  assert.equal(rpc.isRunning(), true);
  assert.equal(rpc.startedAt, "fixture-time");
  rpc.receiveSupervisorEvent({ payload: { type: "pi_process_error", error: "diagnostic" } });
  assert.equal(rpc.isRunning(), true);
  rpc.receiveSupervisorEvent({ payload: { type: "pi_process_exit", code: 0, signal: null }, scopeId: "scope", epoch: "epoch", seq: "3" });
  assert.deepEqual(rpc.child, { pid: 13, exitCode: 0, signalCode: null, killed: true });
  assert.deepEqual(events.at(-1), {
    type: "pi_process_exit", code: 0, signal: null,
    supervisorScopeId: "scope", supervisorEpoch: "epoch", supervisorSeq: "3",
  });
  const count = events.length;
  rpc.receiveSupervisorEvent({});
  rpc.receiveSupervisorEvent({ payload: "invalid" });
  assert.equal(events.length, count);
  rpc.dispose();
  assert.equal(rpc.listeners.size, 0);
  assert.deepEqual(calls, []);
  assert.equal(await rpc.stop(), "closed");
  assert.deepEqual(calls, [["close", "tab-1"]]);
});

test("supervised replacements share dispatch ordering and apply only successful snapshots", { timeout: 5_000 }, async () => {
  const gate = deferred();
  const { rpc, calls } = supervisedFixture({ assertNativeRpcAdmission: () => gate.promise });
  const raw = rpc.writeRaw({ type: "raw" });
  const request = { child: { command: "fixture" }, metadata: { cwd: "/replacement" }, displayCommand: "new command" };
  const replacing = rpc.replace(request);
  await Promise.resolve();
  assert.deepEqual(calls, []);
  gate.resolve();
  await raw;
  const snapshot = await replacing;
  assert.deepEqual(snapshot, { pid: 42 });
  assert.deepEqual(calls, [
    ["write", "tab-1", { type: "raw" }],
    ["replace", { tabId: "tab-1", child: request.child, metadata: request.metadata }],
  ]);
  assert.equal(rpc.child.pid, 42);
  assert.equal(rpc.displayCommand, "new command");
  const restart = { owner: "update-job" };
  await rpc.replace({ ...request, restart });
  assert.equal(rpc.child.pid, 43);
  assert.deepEqual(calls.at(-1), ["replaceUpdate", { tabId: "tab-1", child: request.child, metadata: request.metadata, restart }]);
  rpc.supervisor.replaceTab = async () => { throw new Error("replace failed"); };
  await assert.rejects(rpc.replace({ ...request, displayCommand: "failed" }), /replace failed/);
  assert.equal(rpc.child.pid, 43);
  assert.equal(rpc.displayCommand, "new command");
  await rpc.writeRaw({ type: "after-replace-failure" });
});

test("supervised metadata updates serialize independently and recover after rejection", { timeout: 5_000 }, async () => {
  const first = deferred();
  const { rpc, calls } = supervisedFixture({}, {
    updateTab: (tabId, metadata) => {
      calls.push(["update", tabId, metadata]);
      return metadata.revision === 1 ? first.promise : Promise.resolve(metadata);
    },
  });
  const pending = rpc.updateMetadata({ revision: 1 });
  const rejected = assert.rejects(pending, /metadata failure/);
  const next = rpc.updateMetadata({ revision: 2 });
  await waitFor(() => calls.length, "first metadata update");
  assert.equal(calls.length, 1);
  await rpc.writeRaw({ type: "raw" });
  assert.equal(calls.at(-1)[0], "write");
  first.reject(new Error("metadata failure"));
  await rejected;
  assert.deepEqual(await next, { revision: 2 });
  assert.deepEqual(calls.filter(([method]) => method === "update"), [
    ["update", "tab-1", { revision: 1 }], ["update", "tab-1", { revision: 2 }],
  ]);
});

test("stderr mirroring shares one sink handler and reports callback, throw, event and unwritable failures", { timeout: 15_000 }, async (t) => {
  await runProbe(t, `
    import assert from "node:assert/strict";
    import { EventEmitter } from "node:events";
    import { createRpcTransportTypes } from ${JSON.stringify(moduleUrl)};
    const { PiRpcProcess, SupervisorPiRpcProcess } = createRpcTransportTypes({
      assertNativeRpcAdmission: async () => {}, sanitizeError: (error) => error.message,
      requestTimeoutMs: 1000, supervisorCommandTimeoutMaxMs: 5000,
    });
    const sink = new EventEmitter();
    Object.assign(sink, { writable: true, destroyed: false, writableEnded: false });
    Object.defineProperty(process, "stderr", { configurable: true, value: sink });
    const callbacks = [];
    const order = [];
    sink.write = (text, callback) => { order.push("mirror"); callbacks.push(callback); return true; };
    const make = () => {
      const rpc = new SupervisorPiRpcProcess({ supervisor: {}, tabId: "fixture" });
      const events = [];
      rpc.onEvent((event) => { order.push(event.type); events.push(event); });
      return { rpc, events };
    };
    const a = make();
    const b = make();
    const event = { payload: { type: "pi_stderr", text: "diagnostic" } };
    a.rpc.receiveSupervisorEvent(event);
    b.rpc.receiveSupervisorEvent(event);
    assert.deepEqual(order, ["pi_stderr", "mirror", "pi_stderr", "mirror"]);
    assert.equal(sink.listenerCount("error"), 1);
    sink.emit("error", new Error("sink event failure"));
    for (const target of [a, b]) {
      assert.equal(target.events.length, 2);
      assert.equal(target.events[1].type, "pi_stderr_sink_error");
      assert.match(target.events[1].error, /sink event failure/);
    }
    for (const callback of callbacks.splice(0)) callback(new Error("duplicate callback failure"));
    assert.equal(a.events.length, 2);
    a.rpc.receiveSupervisorEvent(event);
    callbacks.shift()();
    sink.emit("error", new Error("after successful callback"));
    assert.equal(a.events.length, 3);
    sink.write = (text, callback) => callback(new Error("callback failure"));
    a.rpc.receiveSupervisorEvent(event);
    assert.match(a.events.at(-1).error, /callback failure/);
    sink.write = () => { throw new Error("thrown failure"); };
    a.rpc.receiveSupervisorEvent(event);
    assert.match(a.events.at(-1).error, /thrown failure/);
    sink.writable = false;
    a.rpc.receiveSupervisorEvent(event);
    assert.match(a.events.at(-1).error, /sink is not writable/);

    const direct = new PiRpcProcess({
      command: process.execPath,
      args: ["--input-type=module", "-e", 'process.stderr.write("fixture diagnostic");'],
      cwd: ${JSON.stringify(tmpdir())}, env: {},
    });
    const directEvents = [];
    direct.onEvent((event) => directEvents.push(event));
    const startup = direct.start();
    const closed = new Promise((resolve) => direct.child.once("close", resolve));
    await startup;
    await closed;
    const stderrIndex = directEvents.findIndex((event) => event.type === "pi_stderr");
    const failureIndex = directEvents.findIndex((event) => event.type === "pi_stderr_sink_error");
    assert.ok(stderrIndex >= 0 && failureIndex > stderrIndex);
    direct.reportStderrMirrorFailure(new Error("second failure"));
    assert.equal(directEvents.filter((event) => event.type === "pi_stderr_sink_error").length, 1);
    assert.equal(direct.pending.size, 0);
  `);
});
