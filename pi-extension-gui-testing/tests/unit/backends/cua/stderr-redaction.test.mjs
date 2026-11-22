/**
 * W4: the `cua sandbox exec -i` stream's stderr reaches the start error only
 * after redaction, also when a secret arrives split across stream chunks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { CuaCliApi } from "../../../../src/backends/cua/cli-api.ts";
import { CuaSession } from "../../../../src/backends/cua/session.ts";

const SECRET = "demo-bearer-review-secret";

/** A `cua` process that writes `chunks` to stderr, one per tick, then exits 1 before READY. */
function failingSpawner(chunks) {
  return {
    spawn() {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let alive = true;
      let finish;
      const exited = new Promise((resolve) => (finish = resolve));
      (async () => {
        for (const chunk of chunks) {
          await new Promise((r) => setTimeout(r, 2));
          stderr.write(chunk);
        }
        await new Promise((r) => setTimeout(r, 10));
        alive = false;
        finish({ code: 1, signal: null });
        stdout.end();
        stderr.end();
      })();
      return { stdin, stdout, stderr, exited, pid: 4242, running: () => alive, kill() { alive = false; finish({ code: 1, signal: null }); } };
    },
  };
}

async function startError(chunks) {
  const api = new CuaCliApi({ runner: { run() { throw new Error("should not run"); } }, spawner: failingSpawner(chunks), baseEnv: { PATH: "/usr/bin:/bin" } });
  const handle = { ref: "aws:pi-gui-testing-demo", remove: async () => [], audit: async () => [], forceRemoveArgv: () => [] };
  const session = new CuaSession({ id: "gui-demo", backend: "cua", api, handle, packageVersion: "0.2.0", sync: { files: 0, bytes: 0, excluded: 0 }, onLog() {}, readyTimeoutMs: 200, heartbeatIntervalMs: 0, exitWaitMs: 5, killWaitMs: 5 });
  return session.start(new AbortController().signal).then(() => assert.fail("start should fail"), (e) => e);
}

test("W4: streamed cua stderr is redacted before it reaches the start error", async () => {
  const error = await startError([`Authorization: Bearer ${SECRET}\n`]);
  assert.ok(!error.message.includes(SECRET), error.message);
  assert.match(error.message, /cua: Authorization: Bearer \[redacted\]/);
});

test("W4: a secret split across stderr chunks is still redacted", async () => {
  const error = await startError(["request failed\nAuthorization: Bea", "rer demo-bearer-", "review-secret\nHCLOUD_TO", "KEN=demo-hcloud-token-value\n"]);
  assert.ok(!error.message.includes("review-secret"), error.message);
  assert.ok(!error.message.includes("demo-hcloud-token-value"), error.message);
  assert.match(error.message, /request failed/);
});
