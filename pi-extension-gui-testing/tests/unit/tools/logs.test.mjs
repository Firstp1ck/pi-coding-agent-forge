/** Q5: the session log store is bounded in events, bytes per event, pending writes, and file size. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { ProtocolClient } from "../../../src/framing/client.ts";
import { TextTail } from "../../../src/framing/log-event.ts";
import { READY_PREFIX } from "../../../src/protocol.ts";
import { LOG_LIMITS, LogBuffer } from "../../../src/tools/logs.ts";

const ev = (data, source = "app") => ({ type: "log", stream: "stdout", source, data });

async function tempFile(t) {
  const dir = await mkdtemp(join(tmpdir(), "gui-logs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "app.log");
}

test("Q5: empty or tiny events cannot grow memory without bound (count limit and per-event overhead)", () => {
  const logs = new LogBuffer(undefined, 1024 * 1024);
  for (let i = 0; i < 200_000; i++) logs.add(ev(""));
  assert.ok(logs.tail(1_000_000).length <= LOG_LIMITS.events, "event count bounded");
  assert.ok(logs.dropped >= 200_000 - LOG_LIMITS.events);
  const small = new LogBuffer(undefined, 64 * 100, { events: 1_000_000 });
  for (let i = 0; i < 10_000; i++) small.add(ev(""));
  assert.ok(small.tail(1_000_000).length <= 100, "overhead per event counts toward the byte limit");
});

test("Q5: one huge event is cut instead of filling the buffer", () => {
  const logs = new LogBuffer();
  logs.add(ev("x".repeat(LOG_LIMITS.eventChars * 4)));
  const [line] = logs.tail(1);
  assert.ok(line.length < LOG_LIMITS.eventChars + 100);
  assert.match(line, /… \(cut\)$/);
});

test("Q5: pending writes are coalesced and bounded with a dropped marker; the file stops at its limit", async (t) => {
  const file = await tempFile(t);
  const logs = new LogBuffer(file, 1024 * 1024, { pendingChars: 2_000, fileBytes: 1_000_000 });
  for (let i = 0; i < 1_000; i++) logs.add(ev(`line ${i}\n`));
  await logs.flush();
  // P7: a burst followed by silence: flush itself writes the marker (no later event needed).
  const text = await readFile(file, "utf8");
  assert.match(text, /\[gui-testing\] dropped \d+ log event\(s\)/);
  assert.ok(text.length < 10_000, "the queue never held the whole burst");
  logs.add(ev("after the burst\n"));
  await logs.flush();
  const later = await readFile(file, "utf8");
  assert.match(later, /after the burst/);
  assert.equal(later.match(/dropped \d+ log event/g).length, 1, "one marker per run of dropped writes");

  const capped = await tempFile(t);
  const limited = new LogBuffer(capped, 1024 * 1024, { fileBytes: 4_096 });
  for (let i = 0; i < 200; i++) {
    limited.add(ev(`${"y".repeat(100)}\n`));
    await limited.flush();
  }
  assert.ok((await stat(capped)).size <= 4_096 + 8, "file size bounded");
  assert.match(await readFile(capped, "utf8"), /reached its size limit/);
  assert.equal(limited.tail(1).length, 1, "memory still has the output");
});

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc");
const MiB = 1024 * 1024;

/** Heap in use after a full collection. */
function heapAfterGc() {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

test("P1: forged log events through the real framing parser retain only known fields and bounded data", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  const before = heapAfterGc();
  // A byte budget that keeps all 64 events, so only canonicalisation bounds the memory.
  const logs = new LogBuffer(undefined, 64 * MiB);
  await (async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new ProtocolClient({ stdin, stdout, token, heartbeatIntervalMs: 0, onLog: (event) => logs.add(event) });
    stdout.write(`${READY_PREFIX} ${token}\n`);
    for (let i = 0; i < 64; i++) {
      // 1 MiB of extra property and 1 MiB of data per event, on one protocol line each.
      const forged = { event: "log", stream: "stdout", source: "app", data: `${i}`.padEnd(MiB, "d"), extra: "e".repeat(MiB), nested: { blob: "n".repeat(64 * 1024) } };
      stdout.write(`${token} ${JSON.stringify(forged)}\n`);
      await new Promise((r) => setImmediate(r));
    }
    client.close?.(new Error("done"));
    stdin.destroy();
    stdout.destroy();
  })();
  const lines = logs.tail(1_000);
  assert.equal(lines.length, 64, "every event kept");
  assert.match(lines.at(-1), /^\[app stdout\] 63d+… \(cut\)$/);
  assert.ok(lines.every((line) => line.length < LOG_LIMITS.eventChars + 100), "data cut to the per-event limit");
  const retained = heapAfterGc() - before;
  // Canonical events hold 64 × 64 KiB of text; the forged ones carried 64 × 2 MiB.
  assert.ok(retained < 24 * MiB, `retained ${(retained / MiB).toFixed(1)} MiB for 64 forged events`);
});

test("A4-F1: huge non-protocol stdout lines leave only bounded, owned diagnostics", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  const before = heapAfterGc();
  let client;
  await (async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    client = new ProtocolClient({ stdin, stdout, token, heartbeatIntervalMs: 0 });
    stdout.write(`${READY_PREFIX} ${token}\n`);
    for (let i = 0; i < 50; i++) {
      // 4 MiB lines without the token prefix are diagnostics; the client keeps 500 characters of each.
      stdout.write(`${i}:`.padEnd(4 * MiB, "x") + "\n");
      await new Promise((r) => setImmediate(r));
    }
  })();
  const kept = client.diagnostics();
  assert.equal(kept.length, 50);
  assert.ok(kept.every((line) => line.length <= 501), "each line cut to 500 characters");
  const retained = heapAfterGc() - before;
  // Slices of the decoded lines would pin 50 × 4 MiB.
  assert.ok(retained < 16 * MiB, `retained ${(retained / MiB).toFixed(1)} MiB for 50 diagnostic lines`);
  client.close?.(new Error("done"));
});

test("P1: LogBuffer keeps no reference to a forged event's extra properties", async () => {
  const logs = new LogBuffer(undefined, 64 * MiB);
  let extra = { payload: "x".repeat(MiB) };
  const ref = new WeakRef(extra);
  logs.add({ event: "log", stream: "stderr", source: "setup", data: "hello\n", extra, toString: () => "forged" });
  extra = undefined;
  // WeakRef targets stay alive until the current job ends.
  await new Promise((r) => setImmediate(r));
  gc();
  assert.ok(ref.deref() === undefined, "the extra property is not retained");
  assert.deepEqual(logs.tail(5), ["[setup stderr] hello"]);
  // Bogus stream/source values are normalised instead of being stored as given.
  logs.add({ event: "log", stream: "\u001b[31m", source: { evil: true }, data: "x" });
  assert.equal(logs.tail(1)[0], "[app stdout] x");
});

test("P1: the setup output tail is bounded in characters and owns its text", () => {
  const tail = new TextTail(4096);
  for (let i = 0; i < 1_000; i++) tail.push(`${i}:`.padEnd(64 * 1024, "s"));
  assert.equal(tail.text.length, 4096);
  assert.ok(tail.text.startsWith("s") && !tail.text.includes(":"), "only the newest characters");
  tail.push("last line\n");
  assert.ok(tail.text.endsWith("last line\n"));
  assert.equal(tail.text.length, 4096);
});

test("app.log is created once and written through its handle: planted links and later swaps never redirect it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gui-logs-link-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const kind of ["symlink", "hardlink"]) {
    const victim = join(dir, `${kind}-outside.txt`);
    await writeFile(victim, "OUTSIDE");
    const file = join(dir, `${kind}-app.log`);
    if (kind === "symlink") await symlink(victim, file);
    else await link(victim, file);
    const logs = new LogBuffer(file);
    logs.add({ event: "log", stream: "stdout", source: "app", data: "PLANTED-LINK-APPEND\n" });
    await logs.flush();
    assert.equal(await readFile(victim, "utf8"), "OUTSIDE", `${kind}: the outside file is untouched`);
    assert.deepEqual(logs.tail(1), ["[app stdout] PLANTED-LINK-APPEND"], "the output stays in memory");
    await logs.close();
  }
  // A swap after the file exists: writes keep going to the file that was created.
  const file = join(dir, "app.log");
  const logs = new LogBuffer(file);
  logs.add({ event: "log", stream: "stdout", source: "app", data: "first\n" });
  await logs.flush();
  await rename(file, join(dir, "moved.log"));
  const victim = join(dir, "victim.txt");
  await writeFile(victim, "OUTSIDE");
  await symlink(victim, file);
  logs.add({ event: "log", stream: "stdout", source: "app", data: "second\n" });
  await logs.close();
  assert.equal(await readFile(victim, "utf8"), "OUTSIDE");
  assert.match(await readFile(join(dir, "moved.log"), "utf8"), /first[\s\S]*second/);
  logs.add({ event: "log", stream: "stdout", source: "app", data: "after close\n" });
  await logs.flush();
  assert.doesNotMatch(await readFile(join(dir, "moved.log"), "utf8"), /after close/, "nothing is written after close()");
});
