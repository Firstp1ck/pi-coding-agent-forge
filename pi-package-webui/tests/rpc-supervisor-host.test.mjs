import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { acquireEffectLocks, persistSharedJob, releaseEffectLocks, sharedUpdateRoot } from "../lib/update/coordination.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  RPC_SUPERVISOR_CHILD_ARG_LIMIT,
  RPC_SUPERVISOR_EVENT_RING_MAX_BYTES,
  RPC_SUPERVISOR_REQUEST_DEDUPE_LIMIT,
  deriveSupervisorRecoveryToken,
} from "../lib/rpc-supervisor-protocol.mjs";
import {
  RpcSupervisorClient,
  discoverStartAttachRpcSupervisor,
} from "../lib/rpc-supervisor-client.mjs";
import {
  readSupervisorState,
  removeSupervisorState,
  supervisorPaths,
  writeSupervisorState,
} from "../lib/rpc-supervisor-state.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakePi = path.join(root, "tests", "fixtures", "fake-pi.mjs");
const work = await mkdtemp(path.join(tmpdir(), "pi-webui-rpc-supervisor-host-"));
const effectRoot = path.join(work, "effect");
await mkdir(effectRoot);
const agentDir = path.join(work, "agent");
const port = 35000 + Math.floor(Math.random() * 15000);
const logFile = path.join(work, "commands.jsonl");
const rawLogFile = path.join(work, "raw-pi.jsonl");
const rawPiScript = String.raw`
  const { appendFileSync } = require("node:fs");
  const { createInterface } = require("node:readline");
  const log = process.env.RAW_PI_LOG;
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  createInterface({ input: process.stdin }).on("line", (line) => {
    const command = JSON.parse(line);
    appendFileSync(log, line + "\n");
    if (command.type === "hold") {
      setTimeout(() => process.exit(0), 2500).unref();
      return;
    }
    if (command.type === "pause_stdin") {
      send({ type: "response", id: command.id, data: { paused: true } });
      setInterval(() => {}, 1000);
      process.stdin.pause();
      return;
    }
    if (command.type === "no_response" || command.type === "extension_ui_response") return;
    if (command.type === "flood") {
      send({ type: "response", id: command.id, data: { accepted: true } });
      for (let index = 0; index < 80; index += 1) send({ type: "large_event", index, tokens: { keep: index }, body: "r".repeat(72 * 1024) });
      return;
    }
    if (command.type === "emit_one") {
      send({ type: "response", id: command.id, data: { accepted: true } });
      send({ type: "other_tab_live_event", tokens: { keep: true } });
      return;
    }
    send({ type: "response", id: command.id, data: command });
  });
`;

let testSocketSerial = 0;

function testSocketPath(label) {
  testSocketSerial += 1;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-webui-rpc-host-${process.pid}-${testSocketSerial}-${label}`
    : path.join(work, `${label}.sock`);
}

async function listen(server, socketPath) {
  const connections = new Set();
  server.__testConnections = connections;
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server) {
  for (const socket of server.__testConnections || []) socket.destroy();
  await new Promise((resolve) => server.close(() => resolve()));
}

async function rawLines() {
  const text = await readFile(rawLogFile, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`${label} did not happen within ${timeoutMs}ms`);
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

let client;
let replacement;
let replayClient;
try {
  client = await discoverStartAttachRpcSupervisor({
    agentDir,
    port,
    environment: {
      ...process.env,
      FAKE_PI_LOG_FILE: logFile,
      RAW_PI_LOG: rawLogFile,
      NODE_ENV: "test",
      PI_WEBUI_UPDATE_TEST_HOME: work,
      PI_WEBUI_UPDATE_EFFECT_ROOTS: JSON.stringify([effectRoot]),
      PI_WEBUI_RECOVERY_URL: `http://127.0.0.1:${port}/api/recovery/plan`,
      PI_WEBUI_RECOVERY_TOKEN: "server-ephemeral-recovery-token",
    },
    startupTimeoutMs: 10_000,
  });
  const created = await client.createTab({
    tabId: "tab-1",
    metadata: { title: "One", index: 0, cwd: work, sessionFile: path.join(work, "one.jsonl"), apiToken: "never-persist" },
    child: { command: process.execPath, args: [fakePi], cwd: work },
  });
  assert.equal(created.id, "tab-1");
  assert.ok(created.pid > 0);
  await client.createTab({
    tabId: "raw-tab",
    metadata: { title: "Raw", index: 1, cwd: work, sessionFile: path.join(work, "raw.jsonl") },
    child: { command: process.execPath, args: ["-e", rawPiScript], cwd: work },
  });
  await assert.rejects(
    Promise.race([
      client.createTab({
        tabId: "invalid-arg-tab",
        metadata: { title: "Invalid", index: 2, cwd: work },
        child: { command: process.execPath, args: Array.from({ length: RPC_SUPERVISOR_CHILD_ARG_LIMIT + 1 }, () => "x"), cwd: work },
      }),
      delay(1_000).then(() => { throw new Error("validation failure was not correlated to the create request"); }),
    ]),
    /at most 1024 entries/,
    "invalid create frames must reject their matching client request instead of hanging",
  );

  const response = await Promise.all([
    client.command("tab-1", { type: "prompt", message: "dedupe me" }, { requestId: "prompt-once" }),
    client.command("tab-1", { type: "prompt", message: "dedupe me" }, { requestId: "prompt-once" }),
  ]);
  assert.equal(response[0].data.output, "fake prompt accepted");
  assert.deepEqual(response[0], response[1]);
  await delay(60);
  const logged = (await readFile(logFile, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(logged.filter((entry) => entry.direction === "command" && entry.message === "dedupe me").length, 1, "duplicate request IDs must not write to Pi twice");
  const startupState = await readSupervisorState(await supervisorPaths({ agentDir, port }));
  const expectedRecoveryDigest = createHash("sha256").update(deriveSupervisorRecoveryToken(startupState.token)).digest("hex");
  const startupEntry = logged.find((entry) => entry.direction === "startup" && entry.cwd === work);
  assert.equal(startupEntry?.recoveryTokenDigest, expectedRecoveryDigest, "managed Pi children must receive the stable derived recovery credential");
  assert.notEqual(
    startupEntry?.recoveryTokenDigest,
    createHash("sha256").update("server-ephemeral-recovery-token").digest("hex"),
    "managed Pi children must not retain the server process's restart-scoped credential",
  );

  const rawCommand = {
    type: "raw_round_trip",
    message: "x".repeat(64 * 1024 + 1),
    tokens: { input: 123, output: 456 },
    entries: Array.from({ length: 257 }, (_, index) => ({ index, token: `token-${index}` })),
  };
  const rawResponse = await client.command("raw-tab", rawCommand, { requestId: "raw-round-trip" });
  assert.equal(rawResponse.data.message.length, rawCommand.message.length, "live Pi responses must preserve long strings");
  assert.equal(rawResponse.data.entries.length, 257, "live Pi responses must preserve arrays beyond metadata limits");
  assert.deepEqual(rawResponse.data.tokens, rawCommand.tokens, "live Pi responses must preserve token-named fields");

  const rawWrite = { type: "extension_ui_response", id: "ui-no-response", tokens: { private: "keep" }, entries: Array.from({ length: 257 }, (_, index) => index) };
  await Promise.race([
    client.write("raw-tab", rawWrite, { requestId: "raw-write-once" }),
    delay(1_000).then(() => { throw new Error("raw write waited for a Pi response"); }),
  ]);
  const written = await waitFor("raw write log", async () => (await rawLines()).find((line) => line.type === "extension_ui_response"));
  assert.deepEqual(written, rawWrite, "fire-and-forget writes must reach Pi unchanged and without an injected request ID");

  const pendingCommand = client.command("raw-tab", { type: "no_response" }, { requestId: "pending-before-ui-write", timeoutMs: 700 });
  await waitFor("pending command admission", async () => (await rawLines()).some((line) => line.type === "no_response"));
  const queuedProbe = await Promise.race([
    client.command("raw-tab", { type: "queued_behind_pending_response" }, { requestId: "queued-behind-pending-response", timeoutMs: 500 }),
    delay(300).then(() => { throw new Error("a pending Pi response held the supervisor admission queue"); }),
  ]);
  assert.equal(queuedProbe.data.type, "queued_behind_pending_response", "later commands should be admitted without waiting for an earlier Pi response");
  await Promise.race([
    client.write("raw-tab", { type: "extension_ui_response", id: "ui-behind-pending-command" }, { requestId: "ui-behind-pending-command" }),
    delay(300).then(() => { throw new Error("extension UI response deadlocked behind a pending Pi command"); }),
  ]);
  await waitFor("extension UI response behind pending command", async () => (await rawLines()).some((line) => line.id === "ui-behind-pending-command"));
  await assert.rejects(pendingCommand, /Timed out waiting for RPC response/, "the deliberately unanswered command should retain its own response timeout");

  const metadataUpdates = [];
  let metadataSerial = 0;
  const metadataFlood = setInterval(() => {
    metadataSerial += 1;
    metadataUpdates.push(client.updateTab("raw-tab", {
      title: `Raw ${metadataSerial}`,
      index: 1,
      cwd: work,
      sessionFile: path.join(work, "raw.jsonl"),
    }));
  }, 1);
  try {
    await delay(40);
    const starvationProbe = await Promise.race([
      client.command("raw-tab", { type: "metadata_starvation_probe" }, { requestId: "metadata-starvation-probe" }),
      delay(3_000).then(() => { throw new Error("RPC command starved behind continuous metadata updates"); }),
    ]);
    assert.equal(starvationProbe.data.type, "metadata_starvation_probe", "commands should take a FIFO admission position instead of chasing a continuously moving metadata tail");
  } finally {
    clearInterval(metadataFlood);
    const updateResults = await Promise.allSettled(metadataUpdates);
    assert.ok(updateResults.length > 0 && updateResults.every((result) => result.status === "fulfilled"), "metadata flood must consist of successful updates");
  }

  const replacementCwd = path.join(work, "replacement-cwd");
  await mkdir(replacementCwd);
  const originalRawPid = client.snapshot.tabs.find((tab) => tab.id === "raw-tab")?.pid;
  const paused = await client.command("raw-tab", { type: "pause_stdin" }, { requestId: "pause-stdin-before-replace" });
  assert.equal(paused.data.paused, true);
  const blockedWriteResult = client.write("raw-tab", {
    type: "extension_ui_response",
    id: "backpressured-before-replace",
    body: "x".repeat(2 * 1024 * 1024),
  }, { requestId: "backpressured-before-replace" }).then(
    () => ({ status: "fulfilled" }),
    (error) => ({ status: "rejected", error }),
  );
  const replacedRawTab = await Promise.race([
    client.replaceTab({
      tabId: "raw-tab",
      metadata: { title: "Raw", index: 1, cwd: replacementCwd, sessionFile: path.join(work, "raw.jsonl") },
      child: { command: process.execPath, args: ["-e", rawPiScript], cwd: replacementCwd },
    }),
    delay(5_000).then(() => { throw new Error("replacement remained blocked behind a backpressured one-way write"); }),
  ]);
  const blockedWrite = await blockedWriteResult;
  assert.equal(blockedWrite.status, "rejected", "a backpressured one-way write must fail within a bounded interval");
  assert.match(blockedWrite.error?.message || "", /Timed out flushing a one-way Pi RPC write/, "the bounded write failure should explain the queue blockage");
  assert.equal(replacedRawTab.metadata.cwd, replacementCwd, "successful replacement should publish the child cwd atomically");
  assert.notEqual(replacedRawTab.pid, originalRawPid, "successful replacement should expose the replacement child PID");
  const replacedRawResponse = await client.command("raw-tab", { type: "replacement_probe" }, { requestId: "replacement-probe" });
  assert.equal(replacedRawResponse.data.type, "replacement_probe", "replacement child should accept RPC commands after replace resolves");

  const concurrentCwdA = path.join(work, "concurrent-cwd-a");
  const concurrentCwdB = path.join(work, "concurrent-cwd-b");
  await Promise.all([mkdir(concurrentCwdA), mkdir(concurrentCwdB)]);
  const [concurrentA, concurrentB] = await Promise.all([
    client.replaceTab({
      tabId: "raw-tab",
      metadata: { title: "Raw A", index: 1, cwd: concurrentCwdA, sessionFile: path.join(work, "raw.jsonl") },
      child: { command: process.execPath, args: ["-e", rawPiScript], cwd: concurrentCwdA },
    }),
    client.replaceTab({
      tabId: "raw-tab",
      metadata: { title: "Raw B", index: 1, cwd: concurrentCwdB, sessionFile: path.join(work, "raw.jsonl") },
      child: { command: process.execPath, args: ["-e", rawPiScript], cwd: concurrentCwdB },
    }),
  ]);
  assert.equal(concurrentA.metadata.cwd, concurrentCwdA, "first queued replacement should resolve with its own committed cwd");
  assert.equal(concurrentB.metadata.cwd, concurrentCwdB, "second queued replacement should resolve with its own committed cwd");
  assert.notEqual(concurrentA.pid, concurrentB.pid, "serialized replacements should use distinct child processes");
  await waitFor("superseded replacement child exit", () => !pidIsAlive(concurrentA.pid));
  const concurrentProbe = await client.command("raw-tab", { type: "concurrent_replacement_probe" }, { requestId: "concurrent-replacement-probe" });
  assert.equal(concurrentProbe.data.type, "concurrent_replacement_probe", "commands arriving after queued replacements should reach the final child");

  const deliveredStartupEvents = [];
  const unsubscribe = client.onEvent((event) => deliveredStartupEvents.push(event));
  await client.command("raw-tab", { type: "emit_one" }, { requestId: "startup-buffer-event" });
  await delay(50);
  assert.equal(deliveredStartupEvents.length, 0, "events arriving during startup must wait for explicit hydration drain");
  const drainedStartupEvents = client.drainStartupEvents();
  assert.ok(drainedStartupEvents.some((event) => event.payload?.type === "other_tab_live_event"), "startup drain must retain other-tab live events");
  assert.deepEqual(deliveredStartupEvents.map((event) => event.seq), drainedStartupEvents.map((event) => event.seq), "startup drain must deliver buffered events in order");
  unsubscribe();

  const paths = await supervisorPaths({ agentDir, port });
  const state = await readSupervisorState(paths);
  assert.equal(state.tabs.length, 2);
  assert.equal(state.tabs.find((tab) => tab.id === "tab-1").metadata.apiToken, undefined, "private metadata fields must not reach the state snapshot");

  await client.command("tab-1", { type: "get_state" }, { requestId: "update-idle-state" });
  const updateRoot = await sharedUpdateRoot({ home: work });
  const updateLock = await acquireEffectLocks(updateRoot, [effectRoot], "verified-job");
  const originalChild = { command: process.execPath, args: [fakePi], cwd: work };
  const updatedMetadata = { title: "One", index: 0, cwd: work, sessionFile: path.join(work, "one.jsonl") };
  const restart = { transactionId: "verified-job", lockToken: updateLock.token, effectRoot, nonce: "once-only" };
  await assert.rejects(client.command("tab-1", { type: "prompt", message: "must not race" }), /fenced/i);
  await assert.rejects(client.replaceTabUnderUpdate({ tabId: "tab-1", metadata: updatedMetadata, child: originalChild, restart }), /durable healthy/i);
  const updateJobDir = path.join(updateRoot, "jobs", restart.transactionId);
  await mkdir(path.join(updateJobDir, "restarts"), { recursive: true });
  await writeFile(path.join(updateJobDir, "complete.json"), JSON.stringify({ transactionId: restart.transactionId, receipts: [{ id: "pi", status: "changed" }] }));
  await persistSharedJob(updateRoot, { transactionId: restart.transactionId, phase: "restart-authorized", lock: updateLock,
    jobDir: updateJobDir, verifiedTargets: [{ id: "pi", effectRoot, status: "healthy" }] });
  const requestDigest = createHash("sha256").update(JSON.stringify({ tabId: "tab-1", metadata: updatedMetadata, child: originalChild })).digest("hex");
  await writeFile(path.join(updateJobDir, "restarts", `${restart.nonce}.json`), JSON.stringify({ tabId: "tab-1", transactionId: restart.transactionId,
    lockToken: updateLock.token, effectRoot, requestDigest }));
  const restarted = await client.replaceTabUnderUpdate({ tabId: "tab-1", metadata: updatedMetadata, child: originalChild, restart }, { requestId: "one-restart" });
  const deduped = await client.replaceTabUnderUpdate({ tabId: "tab-1", metadata: updatedMetadata, child: originalChild, restart }, { requestId: "one-restart" });
  assert.equal(deduped.pid, restarted.pid, "deduplicated transport request must not launch another child");
  await assert.rejects(client.replaceTabUnderUpdate({ tabId: "tab-1", metadata: updatedMetadata, child: originalChild, restart }, { requestId: "replayed-restart" }), /ENOENT|already used/i);
  await writeFile(path.join(updateJobDir, "restarts", "wrong-tab.json"), JSON.stringify({ tabId: "raw-tab", transactionId: restart.transactionId,
    lockToken: updateLock.token, effectRoot, requestDigest }));
  await assert.rejects(client.replaceTabUnderUpdate({ tabId: "tab-1", metadata: updatedMetadata, child: originalChild, restart: { ...restart, nonce: "wrong-tab" } }), /authorization/i);
  await releaseEffectLocks(updateLock, { completionVerified: true });
  const dependencyLock = await acquireEffectLocks(updateRoot, [effectRoot], "webui-dependency-job");
  const dependencyJobDir = path.join(updateRoot, "jobs", dependencyLock.transactionId);
  await mkdir(path.join(dependencyJobDir, "restarts"), { recursive: true });
  await writeFile(path.join(dependencyJobDir, "complete.json"), JSON.stringify({ transactionId: dependencyLock.transactionId,
    receipts: [{ id: "webui:npm-global", status: "unchanged" }] }));
  await persistSharedJob(updateRoot, { transactionId: dependencyLock.transactionId, phase: "restart-authorized", lock: dependencyLock,
    jobDir: dependencyJobDir, verifiedTargets: [{ id: "webui:npm-global", effectRoot, status: "healthy", piChanged: true }] });
  const dependencyRestart = { transactionId: dependencyLock.transactionId, lockToken: dependencyLock.token,
    effectRoot, nonce: "webui-dependency-pi-reload" };
  await writeFile(path.join(dependencyJobDir, "restarts", `${dependencyRestart.nonce}.json`), JSON.stringify({ tabId: "tab-1",
    transactionId: dependencyRestart.transactionId, lockToken: dependencyRestart.lockToken, effectRoot,
    requestDigest: createHash("sha256").update(JSON.stringify({ tabId: "tab-1", metadata: updatedMetadata, child: originalChild })).digest("hex") }));
  const dependencyReload = await client.replaceTabUnderUpdate({ tabId: "tab-1", metadata: updatedMetadata, child: originalChild,
    restart: dependencyRestart });
  assert.notEqual(dependencyReload.pid, restarted.pid, "verified bundled Pi dependency changes must reload owned tabs despite unchanged WebUI version");
  await releaseEffectLocks(dependencyLock, { completionVerified: true });

  const failedReplacementCwd = path.join(work, "failed-replacement-cwd");
  await mkdir(failedReplacementCwd);
  await assert.rejects(
    client.replaceTab({
      tabId: "tab-1",
      metadata: { title: "One", index: 0, cwd: failedReplacementCwd, sessionFile: path.join(work, "one.jsonl") },
      child: { command: path.join(work, "missing-pi-executable"), args: [], cwd: failedReplacementCwd },
    }),
    /ENOENT|spawn/i,
    "replace should reject when the replacement child cannot spawn",
  );
  await delay(50);
  const stateAfterFailedReplacement = await readSupervisorState(paths);
  assert.equal(stateAfterFailedReplacement.tabs.find((tab) => tab.id === "tab-1").metadata.cwd, work, "failed replacement must not persist the requested cwd");

  replacement = await discoverStartAttachRpcSupervisor({ agentDir, port, controllerId: "replacement-controller", startupTimeoutMs: 5_000 });
  await assert.rejects(client.command("tab-1", { type: "get_state" }), /fenced|closed|not attached/i, "newer attachment must fence prior controller writes");
  assert.equal(replacement.snapshot.tabs.find((tab) => tab.id === "tab-1").id, "tab-1");
  assert.equal(replacement.snapshot.gap, true, "a cursor-less attach with managed history must truthfully report a gap");
  assert.ok(replacement.snapshot.replay.length > 0, "a cursor-less attach must replay retained history");

  await replacement.command("raw-tab", { type: "flood" }, { requestId: "flood-replay-ring" });
  await delay(500);
  replayClient = await discoverStartAttachRpcSupervisor({
    agentDir,
    port,
    controllerId: "replay-controller",
    cursor: { epoch: state.epoch, seq: "0" },
    startupTimeoutMs: 5_000,
  });
  assert.equal(replayClient.snapshot.gap, true, "evicted byte-bounded replay history must report a gap");
  assert.ok(replayClient.snapshot.replay.length > 0, "byte-bounded replay must still attach with a retained suffix");
  const replayBytes = Buffer.byteLength(JSON.stringify(replayClient.snapshot.replay));
  assert.ok(replayBytes <= RPC_SUPERVISOR_EVENT_RING_MAX_BYTES + 1024, "replay payload must remain well below the transport frame limit");
  const replaySequences = replayClient.snapshot.replay.map((event) => BigInt(event.seq));
  assert.deepEqual(replaySequences, [...replaySequences].sort((left, right) => left < right ? -1 : left > right ? 1 : 0), "replay events must be sequence ordered");

  const pending = Array.from({ length: RPC_SUPERVISOR_REQUEST_DEDUPE_LIMIT }, (_, index) => (
    replayClient.command("raw-tab", { type: "hold" }, { requestId: `hold-${index}`, timeoutMs: 86_400_000 }).catch(() => {})
  ));
  await Promise.race([
    assert.rejects(
      replayClient.command("raw-tab", { type: "hold" }, { requestId: "hold-over-capacity", timeoutMs: 86_400_000 }),
      (error) => error?.code === "RPC_SUPERVISOR_DEDUPE_CAPACITY",
      "unresolved dedupe entries must never be evicted to admit new work",
    ),
    delay(5_000).then(() => { throw new Error("dedupe capacity response timed out"); }),
  ]);
  await Promise.all(pending);
  await replayClient.closeTab("raw-tab");

  await replayClient.closeTab("tab-1");
  await replayClient.shutdown();
  await delay(200);
  assert.equal(await readSupervisorState(paths), null, "a matching supervisor shutdown must remove private state");

  // A host that loses its state race must leave the new incarnation untouched.
  const safeAgentDir = path.join(work, "instance-safe-agent");
  const safePort = port + 1;
  const safePaths = await supervisorPaths({ agentDir: safeAgentDir, port: safePort });
  const safeClient = await discoverStartAttachRpcSupervisor({ agentDir: safeAgentDir, port: safePort, startupTimeoutMs: 10_000 });
  await writeSupervisorState(safePaths, { token: "replacement-token", instanceId: "replacement-instance", pid: process.pid, tabs: [] });
  await safeClient.shutdown();
  await delay(150);
  assert.equal((await readSupervisorState(safePaths)).instanceId, "replacement-instance", "old supervisor shutdown must not remove newer state");
  safeClient.close();
  await removeSupervisorState(safePaths, { removeSocket: true, instanceId: "replacement-instance" });

  // A stale socket path cannot authorize replacement while the recorded PID is alive.
  const liveAgentDir = path.join(work, "live-state-agent");
  const livePort = port + 2;
  const livePaths = await supervisorPaths({ agentDir: liveAgentDir, port: livePort });
  await writeSupervisorState(livePaths, { token: "live-token", instanceId: "live-instance", pid: process.pid, tabs: [] });
  await assert.rejects(
    discoverStartAttachRpcSupervisor({ agentDir: liveAgentDir, port: livePort, startupTimeoutMs: 300 }),
    (error) => error?.code === "RPC_SUPERVISOR_LIVE_STATE",
    "startup must refuse a live recorded supervisor instead of replacing it after a connection failure",
  );
  assert.equal((await readSupervisorState(livePaths)).instanceId, "live-instance");
  await removeSupervisorState(livePaths, { removeSocket: true, instanceId: "live-instance" });

  // A live state plus a reset pipe is ambiguous and must fail closed rather
  // than launching a duplicate detached owner.
  const resetAgentDir = path.join(work, "reset-state-agent");
  const resetPort = port + 3;
  const resetPaths = await supervisorPaths({ agentDir: resetAgentDir, port: resetPort });
  await writeSupervisorState(resetPaths, { token: "reset-token", instanceId: "reset-instance", pid: process.pid, tabs: [] });
  const resetServer = createServer((socket) => socket.destroy());
  await listen(resetServer, resetPaths.socketPath);
  await assert.rejects(
    discoverStartAttachRpcSupervisor({ agentDir: resetAgentDir, port: resetPort, startupTimeoutMs: 300 }),
    /closed|reset|pipe/i,
    "a transient reset must not trigger stale-state replacement",
  );
  assert.equal((await readSupervisorState(resetPaths)).instanceId, "reset-instance");
  await closeServer(resetServer);
  await removeSupervisorState(resetPaths, { removeSocket: true, instanceId: "reset-instance" });

  // Untagged pre-attach errors and silent peers must fail a client deterministically.
  const attachErrorPath = testSocketPath("attach-error");
  const attachErrorServer = createServer((socket) => socket.once("data", () => socket.write(`${JSON.stringify({ type: "result", ok: false, code: "RPC_SUPERVISOR_AUTH", error: "denied" })}\n`)));
  await listen(attachErrorServer, attachErrorPath);
  const attachErrorClient = new RpcSupervisorClient({
    socket: createConnection(attachErrorPath),
    state: { scopeId: "a".repeat(64), token: "token" },
    attachTimeoutMs: 500,
  });
  await assert.rejects(attachErrorClient.attach(), (error) => error?.code === "RPC_SUPERVISOR_AUTH");
  attachErrorClient.close();
  await delay(20);
  await closeServer(attachErrorServer);

  const attachTimeoutPath = testSocketPath("attach-timeout");
  const attachTimeoutServer = createServer(() => {});
  await listen(attachTimeoutServer, attachTimeoutPath);
  const attachTimeoutClient = new RpcSupervisorClient({
    socket: createConnection(attachTimeoutPath),
    state: { scopeId: "b".repeat(64), token: "token" },
    attachTimeoutMs: 30,
  });
  await assert.rejects(attachTimeoutClient.attach(), (error) => error?.code === "RPC_SUPERVISOR_ATTACH_TIMEOUT");
  attachTimeoutClient.close();
  await delay(20);
  await closeServer(attachTimeoutServer);
  console.log("rpc-supervisor-host.test.mjs passed");
} catch (error) {
  console.error("RPC supervisor fixture failed before shutdown:", error);
  throw error;
} finally {
  // A failed assertion must not strand the detached fixture owner and mask the
  // original failure with Windows EBUSY during temporary-directory removal.
  for (const owner of [replayClient, replacement, client]) {
    if (!owner?.isConnected()) continue;
    try { await owner.shutdown(); break; } catch { /* Another controller may own this fixture. */ }
  }
  replayClient?.close();
  replacement?.close();
  client?.close();
  for (let attempt = 0; attempt < 25; attempt++) {
    try { await rm(work, { recursive: true, force: true }); break; }
    catch (error) {
      if (error.code !== "EBUSY" || attempt === 24) throw error;
      await delay(200);
    }
  }
}
