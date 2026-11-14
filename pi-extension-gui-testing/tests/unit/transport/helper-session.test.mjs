/**
 * HelperSession over a fake helper process: handshake, verification hook,
 * error mapping, queue-independent stop semantics, teardown and audit hooks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionError } from "../../../src/backend.ts";
import { startLeftovers } from "../../../src/backends/start-failure.ts";
import { diagnosticTail, HelperSession, METHOD_TIMEOUTS_MS, toSessionError } from "../../../src/transport/helper-session.ts";
import { METHOD_TIMEOUTS_MS as DOCKER_TIMEOUTS } from "../../../src/backends/docker/session.ts";
import { ProtocolClientError } from "../../../src/framing/client.ts";
import { fakeSpawner } from "../backends/fakes.mjs";

const LABELS = { launcher: "fake-launcher", target: "the fake target", inside: "inside the fake target", stillRunning: "fake launcher still running" };

function make(options = {}) {
  const spawner = fakeSpawner(options.behaviour ?? {});
  const calls = { verify: 0, teardown: 0, audit: 0, exitTimeout: 0, logs: [] };
  const hooks = {
    spawn: (env) => {
      if (options.spawnThrows) throw new Error("bad argv");
      return spawner.spawn(["fake"], { env });
    },
    teardown: async () => {
      calls.teardown++;
      return options.teardown ? options.teardown(calls.teardown) : [];
    },
    audit: async () => {
      calls.audit++;
      return options.audit ? options.audit() : [];
    },
    ...(options.verify ? { verifyAfterStart: async (signal) => (calls.verify++, options.verify(signal)) } : {}),
    onExitTimeout: async () => void calls.exitTimeout++,
  };
  const session = new HelperSession({
    id: "gui-test",
    backend: "local-linux",
    packageVersion: "0.1.0",
    workspacePath: "/w",
    onLog: (event) => calls.logs.push(event),
    readyTimeoutMs: options.readyTimeoutMs ?? 2_000,
    heartbeatIntervalMs: 0,
    exitWaitMs: options.exitWaitMs ?? 500,
    killWaitMs: 50,
    labels: LABELS,
    hooks,
  });
  return { session, spawner, calls };
}

const signal = () => new AbortController().signal;

test("HelperSession: READY, hello, verification after hello, validated requests, token only in env", async () => {
  const order = [];
  const { session, spawner, calls } = make({ verify: () => void order.push("verify") });
  await session.start(signal());
  const child = spawner.children[0];
  assert.deepEqual(Object.keys(child.env), ["PI_GUI_TESTING_TOKEN"]);
  assert.equal(child.requests[0].method, "hello");
  assert.equal(calls.verify, 1);
  assert.equal(session.arch, "x86_64");
  assert.equal(session.workspacePath, "/w");
  assert.equal(session.isOpen, true);
  assert.equal(session.helperPid, 4242);
  const launched = await session.request("launch", { cmd: "app", args: [], env: {}, cwd: "/w" });
  assert.equal(launched.pid, 77);
  assert.deepEqual(METHOD_TIMEOUTS_MS, DOCKER_TIMEOUTS, "docker re-exports the same table");
  assert.deepEqual(await session.stop(), []);
  assert.equal(calls.teardown, 1);
});

test("HelperSession: a failing verification stops the session and keeps the launcher's stderr out of ISOLATION errors", async () => {
  const { session, spawner, calls } = make({
    verify: () => {
      spawner.children[0].stderr.write("secret noise\n");
      throw new SessionError("ISOLATION", "rules broken");
    },
  });
  const error = await session.start(signal()).then(() => undefined, (e) => e);
  assert.equal(error.code, "ISOLATION");
  assert.doesNotMatch(error.message, /secret noise/);
  assert.equal(calls.teardown, 1, "stopped after the failed start");
  assert.equal(startLeftovers(error), undefined, "clean stop: nothing attached");
  await assert.rejects(session.request("ping", {}), (e) => e.code === "CLOSED");
});

test("HelperSession: other start failures carry the launcher stderr tail and labels; leftovers stay attached and retryable", async () => {
  const { session, spawner, calls } = make({
    behaviour: { handlers: { hello: (_p, child) => (child.stderr.write("why it broke\n"), { error: { code: "PROTOCOL_MISMATCH", message: "old helper" } }) } },
    teardown: (n) => (n === 1 ? [{ kind: "fake", id: "x", detail: "still there" }] : []),
  });
  const error = await session.start(signal()).then(() => undefined, (e) => e);
  assert.equal(error.code, "PROTOCOL_MISMATCH");
  assert.match(error.message, /old helper\nfake-launcher: why it broke/);
  const attached = startLeftovers(error);
  assert.equal(attached.session, session);
  assert.deepEqual(attached.leftovers, [{ kind: "fake", id: "x", detail: "still there" }]);
  assert.deepEqual(await session.stop(), [], "a retry runs the teardown again");
  assert.equal(calls.teardown, 2);
  assert.deepEqual(await session.stop(), [], "and is idempotent once clean");
  assert.equal(calls.teardown, 2);
  assert.equal(spawner.children.length, 1);
});

test("HelperSession: a launcher that cannot spawn reports the launcher label; a throwing spawn hook propagates", async () => {
  const { session } = make({ behaviour: { spawnError: true } });
  await assert.rejects(session.start(signal()), (e) => e.code === "START_FAILED" && /cannot start fake-launcher: spawn docker ENOENT/.test(e.message));
  const thrower = make({ spawnThrows: true });
  await assert.rejects(thrower.session.start(signal()), /bad argv/);
});

test("HelperSession: a helper that ends reports the target label; concurrent stops share one attempt; helper leftovers are labelled", async () => {
  const { session, spawner, calls } = make({ behaviour: { handlers: { stop: () => ({ ok: false, leftovers: [{ kind: "process", id: "9", detail: "zombie" }] }) } } });
  await session.start(signal());
  const first = session.stop();
  assert.equal(session.stop(), first);
  const leftovers = await first;
  assert.deepEqual(leftovers, [{ kind: "process", id: "9", detail: "inside the fake target: zombie" }]);
  assert.equal(calls.teardown, 1);

  const ended = make();
  await ended.session.start(signal());
  ended.spawner.children[0].exit(1);
  await assert.rejects(ended.session.request("windows", {}), (e) => e.code === "CLOSED" && /^the fake target ended \([\s\S]*\); start a new session with gui_launch$/.test(e.message));
  assert.equal(spawner.children.length, 1);
});

test("HelperSession: a launcher that ignores stdin EOF gets onExitTimeout, then SIGTERM; the audit reports it while it runs", async () => {
  const { session, spawner, calls } = make({ exitWaitMs: 50, audit: () => [{ kind: "fake", id: "res" }] });
  await session.start(signal());
  const child = spawner.children[0];
  child.stdin.removeAllListeners("finish"); // ignores EOF
  // The helper connection is gone but the launcher keeps running (a stuck CLI).
  child.stdout.end();
  await new Promise((r) => setImmediate(r));
  assert.equal(session.isOpen, false);
  assert.deepEqual(await session.auditFootprint(), [{ kind: "fake", id: "res" }, { kind: "process", id: "4242", detail: "fake launcher still running" }]);
  // The session's wait timers are unref'd (they must not keep Pi alive); keep the test's loop alive meanwhile.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await session.stop();
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(calls.exitTimeout, 1);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(session.processRunning, false);
  assert.deepEqual(await session.auditFootprint(), [{ kind: "fake", id: "res" }]);
});

test("toSessionError: helper error texts become bounded owned copies; aborts become CANCELLED", () => {
  const long = "x".repeat(10_000);
  const mapped = toSessionError(new ProtocolClientError("TIMEOUT", long), "INTERNAL");
  assert.equal(mapped.code, "TIMEOUT");
  assert.equal(mapped.message.length, 4_097);
  assert.ok(mapped.message.endsWith("…"));
  assert.equal(toSessionError(Object.assign(new Error("stop"), { name: "AbortError" }), "X").code, "CANCELLED");
  assert.equal(toSessionError(new Error("plain"), "START_FAILED").code, "START_FAILED");
  const same = new SessionError("A", "b");
  assert.equal(toSessionError(same, "X"), same);
});

test("W4: diagnosticTail quotes whole lines only: a line cut by the tail buffer or the quote bound is dropped", () => {
  assert.equal(diagnosticTail("one\ntwo\n", false), "one\ntwo");
  // The buffer dropped the start of the first line (it may hold the end of a secret).
  assert.equal(diagnosticTail("ret-tail\nsecond line\n", true), "second line");
  assert.equal(diagnosticTail("only a cut line", true), "(last output line longer than 1500 characters, omitted)");
  const long = `${"x".repeat(20)} start-of-line\nkept\n`;
  assert.equal(diagnosticTail(long, false, 10), "kept");
  assert.equal(diagnosticTail("y".repeat(50), false, 10), "(last output line longer than 10 characters, omitted)");
  assert.equal(diagnosticTail("", false), "");
});

test("W4: the sanitizeDiagnostic hook sees the launcher stderr before it is quoted in a start error", async () => {
  const seen = [];
  const spawner = fakeSpawner({ noReady: true });
  const session = new HelperSession({
    id: "gui-test",
    backend: "local-linux",
    packageVersion: "0.1.0",
    onLog() {},
    readyTimeoutMs: 100,
    heartbeatIntervalMs: 0,
    exitWaitMs: 50,
    killWaitMs: 20,
    labels: LABELS,
    hooks: {
      spawn: (env) => {
        const child = spawner.spawn(["fake"], { env });
        child.stderr.write("token=abc");
        child.stderr.write("def\n");
        return child;
      },
      teardown: async () => [],
      audit: async () => [],
      sanitizeDiagnostic: (text) => (seen.push(text), text.replace(/token=\S+/g, "token=[hidden]")),
    },
  });
  const error = await session.start(signal()).then(() => undefined, (e) => e);
  assert.ok(error);
  assert.deepEqual(seen, ["token=abcdef"], "one call with the joined, whole line");
  assert.ok(!error.message.includes("abcdef"), error.message);
  assert.match(error.message, /fake-launcher: token=\[hidden\]/);
});
