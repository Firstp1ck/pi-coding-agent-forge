import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { ProtocolClient, ProtocolClientError } from "../../../src/framing/client.ts";
import { LineDecoder } from "../../../src/framing/codec.ts";
import { PROTOCOL_VERSION, READY_PREFIX } from "../../../src/protocol.ts";

const TOKEN = "fedcba9876543210fedcba9876543210";

/**
 * In-memory helper: reads requests from the client's stdin and answers through
 * `handler(request, helper)`, which may reply immediately, later, or never.
 */
function fakeHelper(handler, { ready = true, noise = true } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received = [];
  const helper = {
    stdin,
    stdout,
    received,
    write(text) {
      stdout.write(text);
    },
    reply(id, result) {
      stdout.write(`${TOKEN} ${JSON.stringify({ id, ok: true, result })}\n`);
    },
    error(id, code, message) {
      stdout.write(`${TOKEN} ${JSON.stringify({ id, ok: false, error: { code, message } })}\n`);
    },
    end() {
      stdout.end();
    },
  };
  const decoder = new LineDecoder();
  stdin.on("data", (chunk) => {
    for (const line of decoder.push(chunk)) {
      assert.ok(line.startsWith(`${TOKEN} `), `client wrote an unframed line: ${line}`);
      const request = JSON.parse(line.slice(TOKEN.length + 1));
      received.push(request);
      handler(request, helper);
    }
  });
  if (noise) stdout.write("Last login: yesterday\nmotd line\n");
  if (ready) stdout.write(`${READY_PREFIX} ${TOKEN}\n`);
  return helper;
}

const helloResult = (protocol = PROTOCOL_VERSION) => ({ protocol, helperVersion: "0.1.0", os: "linux", arch: "x86_64", capabilities: [] });

function standardHandler(request, helper) {
  if (request.method === "hello") helper.reply(request.id, helloResult());
  else if (request.method === "ping") helper.reply(request.id, { ok: true });
  else if (request.method === "cancel") helper.reply(request.id, { ok: true });
}

function makeClient(helper, options = {}) {
  return new ProtocolClient({ stdin: helper.stdin, stdout: helper.stdout, token: TOKEN, heartbeatIntervalMs: 0, ...options });
}

test("connect waits for READY through noise, performs hello, and correlates responses by id", async () => {
  const helper = fakeHelper((req, h) => {
    if (req.method === "windows") {
      // Answer out of order with noise in between.
      setTimeout(() => {
        h.write("stray app output\n");
        h.reply(req.id, { windows: [{ ref: "w1", title: "T", bounds: { x: 0, y: 0, width: 1, height: 1 } }] });
      }, 5);
    } else standardHandler(req, h);
  });
  const client = makeClient(helper);
  const hello = await client.connect("0.1.0");
  assert.equal(hello.arch, "x86_64");
  assert.deepEqual(helper.received[0], { id: 1, method: "hello", params: { protocol: PROTOCOL_VERSION, packageVersion: "0.1.0" } });
  const [w, p] = await Promise.all([client.request("windows", {}), client.request("ping", {})]);
  assert.equal(w.windows[0].ref, "w1");
  assert.deepEqual(p, { ok: true });
  assert.ok(client.diagnostics().includes("motd line"));
  assert.ok(client.diagnostics().includes("stray app output"));
  client.close();
});

test("handles a response split across chunks", async () => {
  const helper = fakeHelper((req, h) => {
    if (req.method === "hello") {
      const line = `${TOKEN} ${JSON.stringify({ id: req.id, ok: true, result: helloResult() })}\n`;
      h.write(line.slice(0, 10));
      setTimeout(() => h.write(line.slice(10, 40)), 2);
      setTimeout(() => h.write(line.slice(40)), 4);
    }
  });
  const client = makeClient(helper);
  assert.equal((await client.connect("0.1.0")).protocol, PROTOCOL_VERSION);
  client.close();
});

test("requests run sequentially; ping and cancel bypass the queue", async () => {
  let launchId;
  const helper = fakeHelper((req, h) => {
    if (req.method === "launch") launchId = req.id; // answered later
    else if (req.method === "wait") h.reply(req.id, { matched: true, elapsedMs: 1 });
    else standardHandler(req, h);
  });
  const client = makeClient(helper);
  await client.connect("0.1.0");
  const launch = client.request("launch", { cmd: "app", args: [], env: {}, cwd: "/w" });
  const wait = client.request("wait", { for: "idle", timeoutMs: 10 });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(helper.received.map((r) => r.method), ["hello", "launch"], "wait must queue behind launch");
  assert.deepEqual(await client.request("ping", {}), { ok: true }, "ping bypasses the queue");
  assert.deepEqual(helper.received.map((r) => r.method), ["hello", "launch", "ping"]);
  helper.reply(launchId, { pid: 7, windows: [] });
  assert.equal((await launch).pid, 7);
  assert.equal((await wait).matched, true);
  assert.deepEqual(helper.received.map((r) => r.method), ["hello", "launch", "ping", "wait"]);
  client.close();
});

test("timeout rejects with TIMEOUT, sends cancel, and the queue resumes after the CANCELLED answer", async () => {
  const helper = fakeHelper((req, h) => {
    if (req.method === "cancel") {
      h.reply(req.id, { ok: true });
      h.error(req.params.targetId, "CANCELLED", "cancelled");
    } else if (req.method === "windows") h.reply(req.id, { windows: [] });
    else if (req.method !== "launch") standardHandler(req, h);
  });
  const client = makeClient(helper);
  await client.connect("0.1.0");
  const launch = client.request("launch", { cmd: "app", args: [], env: {}, cwd: "/w" }, { timeoutMs: 20 });
  const next = client.request("windows", {});
  await assert.rejects(launch, (e) => e instanceof ProtocolClientError && e.code === "TIMEOUT");
  assert.deepEqual(await next, { windows: [] });
  const cancel = helper.received.find((r) => r.method === "cancel");
  assert.equal(cancel.params.targetId, helper.received.find((r) => r.method === "launch").id);
  client.close();
});

test("abort signal rejects with CANCELLED; a queued request aborted before sending is never written", async () => {
  const helper = fakeHelper((req, h) => {
    if (req.method === "cancel") {
      h.reply(req.id, { ok: true });
      h.error(req.params.targetId, "CANCELLED", "cancelled");
    } else if (req.method !== "launch") standardHandler(req, h);
  });
  const client = makeClient(helper);
  await client.connect("0.1.0");
  const running = new AbortController();
  const queued = new AbortController();
  const launch = client.request("launch", { cmd: "app", args: [], env: {}, cwd: "/w" }, { signal: running.signal });
  const snap = client.request("snapshot", { maxNodes: 10 }, { signal: queued.signal });
  queued.abort();
  await assert.rejects(snap, (e) => e.code === "CANCELLED");
  running.abort();
  await assert.rejects(launch, (e) => e.code === "CANCELLED");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!helper.received.some((r) => r.method === "snapshot"));
  assert.ok(helper.received.some((r) => r.method === "cancel"));
  await assert.rejects(client.request("ping", {}, { signal: AbortSignal.abort() }), (e) => e.code === "CANCELLED");
  client.close();
});

test("helper error responses reject with the helper's code", async () => {
  const helper = fakeHelper((req, h) => {
    if (req.method === "act") h.error(req.id, "STALE_REF", "stale ref, take a new snapshot");
    else standardHandler(req, h);
  });
  const client = makeClient(helper);
  await client.connect("0.1.0");
  await assert.rejects(client.request("act", { ref: "s1:1", action: "click" }), (e) => e.code === "STALE_REF" && /stale ref/.test(e.message));
  client.close();
});

test("stream end fails every pending request with CLOSED and includes recent diagnostics", async () => {
  const helper = fakeHelper((req, h) => {
    if (req.method === "launch") {
      h.write("Traceback: boom\n");
      setTimeout(() => h.end(), 5);
    } else standardHandler(req, h);
  });
  let closedWith;
  const client = makeClient(helper, { onClose: (e) => (closedWith = e) });
  await client.connect("0.1.0");
  const launch = client.request("launch", { cmd: "app", args: [], env: {}, cwd: "/w" });
  const queued = client.request("windows", {});
  await assert.rejects(launch, (e) => e.code === "CLOSED" && /Traceback: boom/.test(e.message));
  await assert.rejects(queued, (e) => e.code === "CLOSED");
  assert.equal(client.isOpen, false);
  assert.equal(closedWith.code, "CLOSED");
  await assert.rejects(client.request("ping", {}), (e) => e.code === "CLOSED");
});

test("hello with a different protocol version fails closed with PROTOCOL_MISMATCH", async () => {
  const helper = fakeHelper((req, h) => {
    if (req.method === "hello") h.reply(req.id, helloResult(PROTOCOL_VERSION + 1));
  });
  const client = makeClient(helper);
  await assert.rejects(client.connect("0.1.0"), (e) => e.code === "PROTOCOL_MISMATCH");
  assert.equal(client.isOpen, false);
  assert.equal(helper.stdin.writableEnded, true, "stdin is ended so the helper tears down");
});

test("a PROTOCOL_MISMATCH error from the helper also fails closed", async () => {
  const helper = fakeHelper((req, h) => {
    if (req.method === "hello") h.error(req.id, "PROTOCOL_MISMATCH", "helper speaks 2");
  });
  const client = makeClient(helper);
  await assert.rejects(client.connect("0.1.0"), (e) => e.code === "PROTOCOL_MISMATCH");
  assert.equal(client.isOpen, false);
});

test("missing ready line times out with the captured output", async () => {
  const helper = fakeHelper(() => {}, { ready: false });
  helper.write("python3: not found\n");
  const client = makeClient(helper, { readyTimeoutMs: 30 });
  await assert.rejects(client.connect("0.1.0"), (e) => e.code === "TIMEOUT" && /ready line/.test(e.message) && /python3: not found/.test(e.message));
  assert.equal(client.isOpen, false);
});

test("bad JSON or an oversize protocol line closes the client with PROTOCOL_ERROR", async () => {
  const helper = fakeHelper((req, h) => {
    if (req.method === "windows") h.write(`${TOKEN} {broken\n`);
    else standardHandler(req, h);
  });
  const client = makeClient(helper);
  await client.connect("0.1.0");
  await assert.rejects(client.request("windows", {}), (e) => e.code === "PROTOCOL_ERROR");
  assert.equal(client.isOpen, false);

  const big = fakeHelper((req, h) => {
    if (req.method === "screenshot") h.write(`${TOKEN} ${"x".repeat(400)}\n`);
    else standardHandler(req, h);
  });
  const small = makeClient(big, { maxLineBytes: 200 });
  await small.connect("0.1.0");
  await assert.rejects(small.request("screenshot", {}), (e) => e.code === "PROTOCOL_ERROR" && /exceeds 200 bytes/.test(e.message));
});

test("log events are dispatched to onLog", async () => {
  const logs = [];
  const helper = fakeHelper((req, h) => {
    if (req.method === "exec") {
      h.write(`${TOKEN} ${JSON.stringify({ event: "log", stream: "stdout", source: "setup", data: "Collecting x" })}\n`);
      h.reply(req.id, { exitCode: 0, elapsedMs: 3 });
    } else standardHandler(req, h);
  });
  const client = makeClient(helper, { onLog: (e) => logs.push(e) });
  await client.connect("0.1.0");
  assert.equal((await client.request("exec", { cmd: "pip install x", cwd: "/workspace", env: {}, timeoutMs: 1000 })).exitCode, 0);
  assert.deepEqual(logs, [{ event: "log", stream: "stdout", source: "setup", data: "Collecting x" }]);
  client.close();
});

test("heartbeat pings while open and stops after close", async () => {
  const helper = fakeHelper(standardHandler);
  const client = makeClient(helper, { heartbeatIntervalMs: 10 });
  await client.connect("0.1.0");
  // Wait for the pings instead of counting them in a fixed window (a 45 ms window flaked under load).
  const pingCount = () => helper.received.filter((r) => r.method === "ping").length;
  const deadline = Date.now() + 2_000;
  while (pingCount() < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  const pings = pingCount();
  assert.ok(pings >= 2, `expected at least 2 pings within 2 s, got ${pings}`);
  client.close();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(helper.received.filter((r) => r.method === "ping").length, pings);
});

test("protocol messages before READY are a framing violation", async () => {
  const helper = fakeHelper(() => {}, { ready: false });
  const client = makeClient(helper, { readyTimeoutMs: 1000 });
  const connecting = client.connect("0.1.0");
  helper.write(`${TOKEN} {"id":1,"ok":true,"result":{}}\n`);
  await assert.rejects(connecting, (e) => e.code === "PROTOCOL_ERROR");
});
