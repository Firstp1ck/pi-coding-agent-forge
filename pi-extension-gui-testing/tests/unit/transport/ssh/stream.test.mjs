/**
 * The detached runner behind `ssh -f` (the ControlMaster start): its stderr
 * log is read back as a bounded tail by position, never whole, and the log
 * file is kept from growing without bound while the foreground part runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDetachedRunner, DETACHED_LOG_CAP_BYTES, DETACHED_TAIL_BYTES } from "../../../../src/transport/ssh/stream.ts";

const PATH_ENV = { PATH: "/usr/bin:/bin" };

async function logDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pgt-detached-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "ssh.log");
}

test("W10: a huge stderr returns only a bounded tail (the end of the log), and the log is removed", async (t) => {
  const logPath = await logDir(t);
  const script = "import sys; sys.stderr.write('X' * (32 * 1024 * 1024)); sys.stderr.write('\\nlast line\\n')";
  const result = await createDetachedRunner(PATH_ENV).run(["python3", "-c", script], { logPath, timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stderr.length <= DETACHED_TAIL_BYTES, `tail is ${result.stderr.length} chars`);
  assert.match(result.stderr, /X\nlast line\n$/);
  assert.equal(result.truncated, true);
  await assert.rejects(stat(logPath), "the log is removed");
});

test("W10: a foreground part that keeps writing stderr never grows the log far past the cap", async (t) => {
  const logPath = await logDir(t);
  // 48 MiB in 1 MiB writes over about 2.4 s; the runner checks the log every 200 ms.
  const script = "import sys, time\nfor i in range(48):\n    sys.stderr.write('Y' * (1024 * 1024)); sys.stderr.flush(); time.sleep(0.05)\nsys.stderr.write('\\ndone\\n')";
  let peak = 0;
  const watch = setInterval(() => {
    stat(logPath).then((s) => (peak = Math.max(peak, s.size)), () => undefined);
  }, 10);
  try {
    const result = await createDetachedRunner(PATH_ENV).run(["python3", "-c", script], { logPath, timeoutMs: 30_000 });
    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /Y\ndone\n$/, "the tail survives the cuts");
    assert.ok(result.stderr.length <= DETACHED_TAIL_BYTES);
  } finally {
    clearInterval(watch);
  }
  assert.ok(peak > 0, "the watcher saw the log");
  assert.ok(peak <= DETACHED_LOG_CAP_BYTES + 8 * 1024 * 1024, `peak log size ${peak} bytes`);
});

test("W10: small stderr is returned whole and not marked truncated", async (t) => {
  const logPath = await logDir(t);
  const result = await createDetachedRunner(PATH_ENV).run(["/bin/sh", "-c", "echo 'ünï ok' >&2; exit 3"], { logPath, timeoutMs: 10_000 });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, "ünï ok\n");
  assert.equal(result.truncated, false);
});
