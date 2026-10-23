import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpawnRunner, minimalEnv } from "../../../src/runner/spawn.ts";
import { FakeCommandRunner } from "../../../src/runner/fake.ts";

const node = process.execPath;
const runner = createSpawnRunner({ killGraceMs: 300 });

test("captures stdout, stderr, exit code; passes input and env; resolves for non-zero exits", async () => {
  const ok = await runner.run(
    [node, "-e", "process.stdin.pipe(process.stdout); process.stderr.write(process.env.EXTRA)"],
    { timeoutMs: 5000, input: "hello", env: { EXTRA: "from-env" } },
  );
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout, "hello");
  assert.equal(ok.stderr, "from-env");
  assert.equal(ok.timedOut, false);
  assert.equal(ok.truncated, false);

  const fail = await runner.run([node, "-e", "process.exit(3)"], { timeoutMs: 5000 });
  assert.equal(fail.exitCode, 3);
});

test("does not pass DISPLAY, WAYLAND_DISPLAY, or DBUS_SESSION_BUS_ADDRESS to children", async () => {
  const base = { PATH: process.env.PATH, DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x", DOCKER_HOST: "unix:///d" };
  assert.deepEqual(Object.keys(minimalEnv(base)).sort(), ["DOCKER_HOST", "PATH"]);
  const isolated = createSpawnRunner({ baseEnv: base });
  const r = await isolated.run([node, "-e", "console.log(JSON.stringify([process.env.DISPLAY, process.env.WAYLAND_DISPLAY, process.env.DBUS_SESSION_BUS_ADDRESS, process.env.DOCKER_HOST]))"], { timeoutMs: 5000 });
  assert.deepEqual(JSON.parse(r.stdout), [null, null, null, "unix:///d"]);
});

test("timeout kills the process and reports timedOut with exitCode null", async () => {
  const started = Date.now();
  const r = await runner.run([node, "-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 100 });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.ok(Date.now() - started < 3000);
});

test("timeout escalates to SIGKILL for a child that ignores SIGTERM, and kills its process group", async () => {
  const script = `
    process.on("SIGTERM", () => {});
    require("child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: "inherit" });
    setInterval(() => {}, 1000);
  `;
  const started = Date.now();
  const r = await runner.run([node, "-e", script], { timeoutMs: 150 });
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, "SIGKILL");
  assert.ok(Date.now() - started < 3000, "bounded by timeout + grace");
});

test("abort signal stops a running command; an already-aborted signal rejects before spawn", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const r = await runner.run([node, "-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 10000, signal: controller.signal });
  assert.equal(r.timedOut, false);
  assert.ok(r.signal === "SIGTERM" || r.signal === "SIGKILL");
  await assert.rejects(runner.run([node, "-e", ""], { timeoutMs: 1000, signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("output beyond maxOutputBytes is dropped and flagged", async () => {
  const r = await runner.run([node, "-e", "process.stdout.write('x'.repeat(10000))"], { timeoutMs: 5000, maxOutputBytes: 100 });
  assert.equal(r.stdout.length, 100);
  assert.equal(r.truncated, true);
});

test("rejects only when the executable cannot be spawned", async () => {
  await assert.rejects(runner.run(["/nonexistent/definitely-not-here"], { timeoutMs: 1000 }), { code: "ENOENT" });
});

test("argv is never interpreted by a shell", async () => {
  const r = await runner.run([node, "-e", "console.log(process.argv[1])", "$(echo injected); ls"], { timeoutMs: 5000 });
  assert.equal(r.stdout.trim(), "$(echo injected); ls");
});

test("FakeCommandRunner matches exact, prefix, regex, and function rules; later rules win; records calls", async () => {
  const fake = new FakeCommandRunner()
    .on(["docker", "version"], { stdout: "29.9.1" })
    .on(["docker", "info"], { stdout: "{}" }, { prefix: true })
    .on(/^sudo -n/, { exitCode: 1 })
    .on((argv) => argv[0] === "id", (argv) => ({ stdout: `uid for ${argv[1]}` }));
  assert.equal((await fake.run(["docker", "version"], { timeoutMs: 1 })).stdout, "29.9.1");
  assert.equal((await fake.run(["docker", "info", "--format", "x"], { timeoutMs: 1 })).stdout, "{}");
  assert.equal((await fake.run(["sudo", "-n", "true"], { timeoutMs: 1 })).exitCode, 1);
  assert.equal((await fake.run(["id", "me"], { timeoutMs: 1 })).stdout, "uid for me");
  fake.on(["docker", "version"], { stdout: "30.0.0" });
  assert.equal((await fake.run(["docker", "version"], { timeoutMs: 1 })).stdout, "30.0.0");
  await assert.rejects(fake.run(["docker", "version", "--x"], { timeoutMs: 1 }), /no rule for: docker version --x/);
  assert.equal(fake.calls.length, 6);
  assert.deepEqual(fake.commands()[0], "docker version");
});

test("FakeCommandRunner supports errors, once rules, and simulated delays with timeout and abort", async () => {
  const fake = new FakeCommandRunner()
    .on(["docker"], Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }), { prefix: true })
    .on(["docker", "ps"], { stdout: "first" }, { once: true })
    .on(["slow"], { stdout: "late" }, { delayMs: 200 });
  assert.equal((await fake.run(["docker", "ps"], { timeoutMs: 1 })).stdout, "first");
  await assert.rejects(fake.run(["docker", "ps"], { timeoutMs: 1 }), { code: "ENOENT" });
  assert.equal((await fake.run(["slow"], { timeoutMs: 20 })).timedOut, true);
  const c = new AbortController();
  setTimeout(() => c.abort(), 10);
  const aborted = await fake.run(["slow"], { timeoutMs: 1000, signal: c.signal });
  assert.equal(aborted.timedOut, false);
  assert.equal(aborted.exitCode, null);
  assert.equal((await fake.run(["slow"], { timeoutMs: 1000 })).stdout, "late");
});
