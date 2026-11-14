/**
 * SshTransport with a scripted ssh: argv of every call (BatchMode, host-key
 * strictness, connect timeout, no forwarding, ControlMaster modes), the
 * remote runner contract (exit 255 is a result), the helper spawn (token on
 * stdin, never in argv), and the ControlMaster lifecycle (open, check, close
 * once, fall back to direct connections, short socket dir removal).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseSshOptions, controlLocation, controlOptions, MAX_CONTROL_PATH_BYTES, usableControlPath } from "../../../../src/transport/ssh/options.ts";
import { classifySshFailure, SshError, sshRemediation } from "../../../../src/transport/ssh/errors.ts";
import { SshTransport, oneShotTransport } from "../../../../src/transport/ssh/transport.ts";
import { FakeSsh, parseSshArgv } from "./fake-ssh.mjs";
import { FakeHelperChild } from "../../backends/fakes.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

function transport(fake, extra = {}) {
  return new SshTransport({ destination: "raspi5", runner: fake.runner, spawner: fake.spawner, detached: fake.detached, ...extra });
}

test("base options: never prompt, strict host keys, no forwarding, bounded connect", () => {
  const options = baseSshOptions(7).join(" ");
  for (const expected of ["BatchMode=yes", "StrictHostKeyChecking=yes", "UpdateHostKeys=no", "ConnectTimeout=7", "ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes", "PermitLocalCommand=no", "RequestTTY=no", "ServerAliveInterval=15"]) {
    assert.ok(options.includes(expected), expected);
  }
  assert.ok(baseSshOptions(0).includes("ConnectTimeout=1"));
  assert.deepEqual(controlOptions({ kind: "none" }), ["-o", "ControlMaster=no", "-o", "ControlPath=none"]);
  assert.deepEqual(controlOptions({ kind: "client", path: "/tmp/a%b" }), ["-o", "ControlMaster=no", "-o", "ControlPath=/tmp/a%%b"]);
  assert.ok(controlOptions({ kind: "master", path: "/tmp/s" }).includes("ControlPersist=60"));
});

test("controlLocation: socket in the session dir, or a short dir when the path is too long", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pgt-ctl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await controlLocation(join(root, "s")), { path: join(root, "s", "ssh") });
  const long = join(root, "x".repeat(MAX_CONTROL_PATH_BYTES));
  const short = await controlLocation(long, root);
  assert.ok(short.shortDir?.startsWith(join(root, "pgt-ssh-")));
  assert.equal(short.path, join(short.shortDir, "s"));
  assert.equal(((await stat(short.shortDir)).mode & 0o777).toString(8), "700");
  assert.equal(usableControlPath("/tmp/with space/s"), false);
  assert.equal(usableControlPath("/tmp/ok/s"), true);
});

test("runner.run: one ssh call with the base options, -T, --, the destination, and the quoted command", async () => {
  const fake = new FakeSsh();
  fake.remote.on(["uname", "-sm"], { stdout: "Linux aarch64\n" });
  const t = transport(fake);
  const result = await t.runner.run(["uname", "-sm"], { timeoutMs: 6_000, input: "in" });
  assert.equal(result.stdout, "Linux aarch64\n");
  const call = fake.calls.at(-1);
  assert.equal(call.argv[0], "ssh");
  assert.equal(call.options.BatchMode, "yes");
  assert.equal(call.options.StrictHostKeyChecking, "yes");
  assert.equal(call.options.ConnectTimeout, "3", "connect timeout is bounded by the call's timeout");
  assert.equal(call.options.ControlPath, "none", "no ControlMaster without a control location");
  assert.ok(call.flags.includes("-T"));
  assert.equal(call.destination, "raspi5");
  assert.equal(call.input, "in");
  assert.deepEqual(call.decoded.argv, ["uname", "-sm"]);
  const dashes = call.argv.indexOf("--");
  assert.equal(call.argv[dashes + 1], "raspi5");
  assert.equal(call.argv.length, dashes + 3, "the remote command is one argv element");
});

test("runner.run: a connection failure is a result with exit 255, not a rejection", async () => {
  const fake = new FakeSsh({ unreachable: [["raspi5", "ssh: connect to host raspi5 port 22: Connection refused"]] });
  const result = await transport(fake).runner.run(["true"], { timeoutMs: 5_000 });
  assert.equal(result.exitCode, 255);
  assert.equal(classifySshFailure(result.stderr), "unreachable");
});

test("runner.run passes cwd and env to the remote side only", async () => {
  const fake = new FakeSsh();
  fake.remote.on(["make"], (argv, opts) => ({ stdout: `${opts.cwd}|${opts.env.FOO}` }));
  const result = await transport(fake).runner.run(["make"], { timeoutMs: 5_000, cwd: "/srv/w", env: { FOO: "bar baz" } });
  assert.equal(result.stdout, "/srv/w|bar baz");
});

test("spawnHelper: token and env on stdin, never in argv; helper sees them", async () => {
  const fake = new FakeSsh({ helper: (argv, opts) => new FakeHelperChild(argv, opts) });
  const t = transport(fake);
  const child = t.spawnHelper(["python3", "-I", "/r/tooling/helper"], { PI_GUI_TESTING_TOKEN: TOKEN, PI_GUI_HELPER_MODE: "host" });
  const ready = await new Promise((resolve) => child.stdout.on("data", (c) => c.toString().includes("READY") && resolve(c.toString())));
  assert.match(ready, new RegExp(`PI-GUI-TESTING-READY ${TOKEN}`));
  const spawn = fake.spawns.at(-1);
  assert.equal(spawn.argv.join(" ").includes(TOKEN), false, "token not in the local argv");
  assert.equal(spawn.decoded.script.includes(TOKEN), false, "token not in the remote command");
  assert.deepEqual(spawn.decoded.keys, ["PI_GUI_HELPER_MODE", "PI_GUI_TESTING_TOKEN"]);
  assert.deepEqual(spawn.env, { PI_GUI_HELPER_MODE: "host", PI_GUI_TESTING_TOKEN: TOKEN });
  assert.deepEqual(spawn.localEnv, {}, "nothing extra in the local ssh environment");
  child.stdin.end();
  await child.exited;
  assert.throws(() => t.spawnHelper(["x"], { A: "bad\nvalue" }), /newline/);
});

test("ControlMaster: open, client calls through the socket, check, close once, then direct", async (t) => {
  const fake = new FakeSsh();
  const dir = await mkdtemp(join(tmpdir(), "pgt-ctl-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tr = transport(fake, { control: { path: join(dir, "ssh") } });
  await tr.open();
  const master = fake.calls.find((c) => c.master);
  assert.equal(master.options.ControlMaster, "yes");
  assert.equal(master.options.ControlPersist, "60");
  assert.ok(master.flags.includes("-N") && master.flags.includes("-f"));
  assert.equal(await tr.masterRunning(), true);
  await tr.runner.run(["true"], { timeoutMs: 5_000 });
  const client = fake.calls.at(-1);
  assert.equal(client.options.ControlMaster, "no");
  assert.equal(client.options.ControlPath, join(dir, "ssh"));
  await Promise.all([tr.close(), tr.close()]);
  assert.equal(fake.calls.filter((c) => c.op === "exit").length, 1, "ssh -O exit runs once");
  assert.equal(await tr.masterRunning(), false);
  await tr.runner.run(["true"], { timeoutMs: 5_000 });
  assert.equal(fake.calls.at(-1).options.ControlPath, "none", "after close, calls connect directly");
  await assert.rejects(tr.open(), /closed/);
});

test("ControlMaster: a failed open is an SshError with its class and remediation", async () => {
  const fake = new FakeSsh({ masterFailure: "tester@raspi5: Permission denied (publickey)." });
  const tr = transport(fake, { control: { path: "/tmp/pgt-none/ssh" } });
  await assert.rejects(tr.open(), (error) => error instanceof SshError && error.failure === "auth" && /Permission denied/.test(error.message));
  assert.match(sshRemediation("auth", "raspi5"), /ssh-copy-id raspi5/);
  assert.match(sshRemediation("hostkey-unknown", "raspi5"), /ssh raspi5/);
});

test("close retries when ssh -O exit failed and the master still answers", async () => {
  const fake = new FakeSsh();
  const tr = transport(fake, { control: { path: "/tmp/pgt-retry/ssh" } });
  await tr.open();
  const exits = [];
  const original = fake.runner.run;
  let refuse = true;
  fake.runner.run = async (argv, opts) => {
    if (argv.includes("-O") && argv.includes("exit")) {
      exits.push(argv);
      if (refuse) return { exitCode: 255, signal: null, stdout: "", stderr: "mux_client_request_session: read from master failed", timedOut: false, truncated: false, durationMs: 1 };
    }
    return original(argv, opts);
  };
  await tr.close();
  assert.equal(await tr.masterRunning(), true);
  assert.equal(tr.multiplexed, false, "no call uses the socket after the first close()");
  refuse = false;
  await tr.close();
  assert.equal(exits.length, 2);
  assert.equal(await tr.masterRunning(), false);
});

test("close removes a short control dir", async () => {
  const fake = new FakeSsh();
  const dir = await mkdtemp(join(tmpdir(), "pgt-ssh-"));
  const tr = transport(fake, { control: { path: join(dir, "s"), shortDir: dir } });
  await tr.open();
  await tr.close();
  await assert.rejects(stat(dir));
});

test("exitArgv and rshCommand carry the session options", () => {
  const fake = new FakeSsh();
  const tr = transport(fake, { control: { path: "/tmp/pgt-x/ssh" } });
  const exit = parseSshArgv(tr.exitArgv("rm -rf x"));
  assert.equal(exit.options.ConnectTimeout, "3");
  assert.equal(exit.options.ControlPath, "/tmp/pgt-x/ssh");
  assert.equal(exit.destination, "raspi5");
  assert.equal(exit.command, "rm -rf x");
  const rsh = tr.rshCommand();
  assert.ok(rsh.startsWith("ssh "));
  assert.ok(rsh.includes("-o BatchMode=yes") && rsh.includes("-o ControlPath=/tmp/pgt-x/ssh"));
  assert.equal(rsh.includes("--"), false, "rsync appends the host itself");
  assert.equal(oneShotTransport("h").multiplexed, false);
});

test("classifySshFailure", () => {
  assert.equal(classifySshFailure("Host key verification failed."), "hostkey-unknown");
  assert.equal(classifySshFailure("No ED25519 host key is known for raspi5 and you have requested strict checking."), "hostkey-unknown");
  assert.equal(classifySshFailure("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@"), "hostkey-changed");
  assert.equal(classifySshFailure("pi@raspi5: Permission denied (publickey,password)."), "auth");
  assert.equal(classifySshFailure("ssh: Could not resolve hostname nope: Name or service not known"), "resolve");
  assert.equal(classifySshFailure("ssh: connect to host 10.0.0.9 port 22: Connection timed out"), "unreachable");
  assert.equal(classifySshFailure("weird"), "other");
});
