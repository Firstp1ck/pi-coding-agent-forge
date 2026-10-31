/**
 * The `cua` CLI adapter on a scripted runner: argv shapes, exit-code classes,
 * JSON validation and bounds, redaction, environment pass-through, and the
 * helper stream. Nothing is spawned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CuaApiError } from "../../../../src/backends/cua/api.ts";
import { cuaEnv, CuaCliApi, envPreamble, nonSecretEnvWords } from "../../../../src/backends/cua/cli-api.ts";
import { redact } from "../../../../src/backends/cua/redact.ts";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";
import { fakeSpawner } from "../fakes.mjs";

const BASE_ENV = { PATH: "/usr/bin", HOME: "/home/u", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", CUA_HOME: "/home/u/.cua", CUA_DAEMON_TOKEN: "s3cr3t-daemon-token", AWS_PROFILE: "dev", AWS_SECRET_ACCESS_KEY: "aws-secret-value" };

function api(runner, spawner) {
  return new CuaCliApi({ runner, baseEnv: BASE_ENV, ...(spawner ? { spawner } : {}) });
}

const SANDBOX = { id: "s1", name: "pi-gui-testing-abcd1234-gui-1", status: "ready", state: "running", location: "aws", kind: "container", expires_at: "2026-10-24T12:00:00Z", image: "linux", provider_details: {} };

test("calls use argv only, --json, and a bounded environment without desktop variables", async () => {
  const runner = new FakeCommandRunner()
    .on(["cua", "--json", "sandbox", "create"], { stdout: JSON.stringify(SANDBOX) }, { prefix: true })
    .on(["cua", "--json", "sandbox", "rm"], { stdout: JSON.stringify({ deleted: "aws:x", missing: false }) }, { prefix: true });
  const cua = api(runner);
  const info = await cua.createSandbox({ name: "pi-gui-testing-abcd1234-gui-1", location: "aws", image: "linux" });
  assert.deepEqual(info, { name: "pi-gui-testing-abcd1234-gui-1", location: "aws", status: "ready", expiresAt: "2026-10-24T12:00:00Z", image: "linux" });
  assert.deepEqual(runner.calls[0].argv, ["cua", "--json", "sandbox", "create", "linux", "--on", "aws", "--name", "pi-gui-testing-abcd1234-gui-1"]);
  const env = runner.calls[0].options.env;
  assert.equal(env.CUA_HOME, "/home/u/.cua");
  assert.equal(env.AWS_PROFILE, "dev");
  assert.equal(env.CUA_NO_BROWSER, "1");
  assert.equal(env.DISPLAY, undefined);
  assert.equal(env.WAYLAND_DISPLAY, undefined);
  assert.ok(runner.calls[0].options.timeoutMs >= 10 * 60_000, "create waits for readiness");
  assert.deepEqual(await cua.deleteSandbox("aws:x"), { missing: false });
  assert.deepEqual(runner.calls[1].argv, ["cua", "--json", "sandbox", "rm", "aws:x", "--force"]);
});

test("exit codes map to error classes; not found is undefined or missing", async () => {
  const runner = new FakeCommandRunner()
    .on(["cua", "--json", "sandbox", "info"], { exitCode: 3, stderr: "Error: sandbox not found" }, { prefix: true })
    .on(["cua", "--json", "sandbox", "rm"], { exitCode: 3, stderr: "Error: not found" }, { prefix: true })
    .on(["cua", "--json", "sandbox", "ls", "--no-size"], { exitCode: 6, stderr: "Error: unauthenticated" })
    .on(["cua", "--json", "cloud", "status"], { exitCode: 5, stderr: "relay unreachable" });
  const cua = api(runner);
  assert.equal(await cua.getSandbox("aws:gone"), undefined);
  assert.deepEqual(await cua.deleteSandbox("aws:gone"), { missing: true });
  await assert.rejects(cua.listSandboxes(), (e) => e instanceof CuaApiError && e.code === "AUTH");
  await assert.rejects(cua.cloudStatus(), (e) => e.code === "TRANSPORT");
});

test("a missing CLI, a timeout, and an abort are classified", async () => {
  const missing = new FakeCommandRunner().on(() => true, Object.assign(new Error("spawn cua ENOENT"), { code: "ENOENT" }));
  await assert.rejects(api(missing).version(), (e) => e.code === "NO_CLI" && /install it/.test(e.message));
  const slow = new FakeCommandRunner().on(() => true, { timedOut: true, exitCode: null });
  await assert.rejects(api(slow).whoami(), (e) => e.code === "TIMEOUT");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api(new FakeCommandRunner().on(() => true, {})).getSandbox("aws:x", controller.signal), (e) => e.code === "CANCELLED");
});

test("JSON is validated and bounded", async () => {
  const cases = [
    [{ stdout: "not json" }, /not JSON/],
    [{ stdout: JSON.stringify([{ ...SANDBOX, name: "../etc" }]) }, /unexpected characters/],
    [{ stdout: JSON.stringify([{ ...SANDBOX, name: 42 }]) }, /name is not a string/],
    [{ stdout: JSON.stringify([{ ...SANDBOX, image: "x".repeat(10_000) }]) }, /longer than/],
    [{ stdout: JSON.stringify({ not: "an array" }) }, /not an array/],
    [{ stdout: "[]", truncated: true }, /size limit/],
  ];
  for (const [response, pattern] of cases) {
    const runner = new FakeCommandRunner().on(() => true, response);
    await assert.rejects(api(runner).listSandboxes(), (e) => e.code === "BAD_RESPONSE" && pattern.test(e.message), String(pattern));
  }
  const many = new FakeCommandRunner().on(() => true, { stdout: JSON.stringify(Array.from({ length: 2_001 }, () => SANDBOX)) });
  await assert.rejects(api(many).listSandboxes(), /more than 2000/);
  const renamed = new FakeCommandRunner().on(() => true, { stdout: JSON.stringify({ ...SANDBOX, name: "other" }) });
  await assert.rejects(api(renamed).createSandbox({ name: "pi-gui-testing-abcd1234-gui-1", location: "aws", image: "linux" }), /not "pi-gui-testing/);
});

test("cloud status, cloud test, auth status, and whoami parse the CLI 0.7 shapes", async () => {
  const runner = new FakeCommandRunner()
    .on(["cua", "--json", "cloud", "status"], {
      stdout: JSON.stringify({
        default_on: "aws",
        providers: [{ name: "aws", title: "AWS", tier: "ga", connected: true, default: true, credentials: { found: true, source: "profile" }, region: "us-west-2", ttl_hours: 8, kinds: [{ image: "linux", kind: "container", supported: true, reason: null, machine_type: "t3.medium", usd_per_hour: 0.0416 }] }],
        resources: [],
      }),
    })
    .on(["cua", "--json", "cloud", "test", "aws"], { exitCode: 1, stdout: JSON.stringify({ provider: "aws", ok: false, account: "123", checks: [{ name: "quota", ok: false, detail: "vCPU limit 0; token=abcdef123456" }] }) })
    .on(["cua", "--json", "auth", "status"], { exitCode: 1, stdout: JSON.stringify({ logged_in: false, expires_at: null }) })
    .on(["cua", "--json", "auth", "whoami"], { stdout: JSON.stringify({ authenticated: true, user: "ada", email: "ada@example.com", plan: "free" }) })
    .on(["cua", "--version"], { stdout: "cua 0.7.0\n" });
  const cua = api(runner);
  const [aws] = await cua.cloudStatus();
  assert.deepEqual(aws, { name: "aws", connected: true, isDefault: true, credentialsFound: true, region: "us-west-2", ttlHours: 8, kinds: [{ image: "linux", kind: "container", supported: true, machineType: "t3.medium", usdPerHour: 0.0416 }] });
  const test = await cua.cloudTest("aws");
  assert.equal(test.ok, false);
  assert.equal(test.checks[0].detail, "vCPU limit 0; token=[redacted]");
  assert.deepEqual(await cua.signedIn(), { signedIn: false, detail: "not signed in" });
  assert.deepEqual(await cua.whoami(), { account: "ada (free)" });
  assert.equal(await cua.version(), "0.7.0");
});

test("errors quote CLI output only after redaction", async () => {
  const runner = new FakeCommandRunner().on(() => true, { exitCode: 1, stderr: "request failed: authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl\nCUA_ENV_TOKEN=abc123def456 x" });
  await assert.rejects(api(runner).deleteSandbox("aws:x"), (e) => {
    assert.ok(!e.message.includes("eyJ"), e.message);
    assert.ok(!e.message.includes("abc123def456"), e.message);
    assert.match(e.message, /\[redacted\]/);
    return true;
  });
});

test("exec runs argv through `exec -i` and upload addresses the ref", async () => {
  const runner = new FakeCommandRunner()
    .on(["cua", "sandbox", "exec"], { exitCode: 2, stdout: "out", stderr: "password=hunter22 failed" }, { prefix: true })
    .on(["cua", "--json", "sandbox", "cp"], { stdout: JSON.stringify({ direction: "upload", size: 42, sha256: "x", src: "/a", dst: "b" }) }, { prefix: true });
  const cua = api(runner);
  const result = await cua.exec("aws:x", ["tar", "-x", "-f", "/tmp/a b.tar"], { timeoutMs: 1000, cwd: "/tmp" });
  assert.deepEqual(runner.calls[0].argv, ["cua", "sandbox", "exec", "-i", "--cwd", "/tmp", "aws:x", "--", "tar", "-x", "-f", "/tmp/a b.tar"]);
  assert.equal(result.exitCode, 2, "the command's own status is a result, not an error");
  assert.equal(result.stderr, "password=[redacted] failed");
  assert.deepEqual(await cua.upload("aws:x", "/local/w.tar", "/tmp/w.tar"), { size: 42 });
  assert.deepEqual(runner.calls[1].argv, ["cua", "--json", "sandbox", "cp", "/local/w.tar", "aws:x:/tmp/w.tar"]);
  await assert.rejects(cua.upload("aws:x", "/local/w.tar", "relative"), /absolute/);
});

test("the helper stream passes env values on stdin, never in argv", async () => {
  const spawner = fakeSpawner({ noReady: true, onSpawn: (c) => (c.firstData = new Promise((resolve) => c.stdin.once("data", (d) => resolve(d.toString())))) });
  const cua = api(new FakeCommandRunner(), spawner);
  const child = cua.spawnHelper("aws:x", ["python3", "-I", "/tmp/h/helper"], { PI_GUI_TESTING_TOKEN: "0123456789abcdef0123456789abcdef" });
  const [spawned] = spawner.children;
  assert.deepEqual(spawned.argv.slice(0, 7), ["cua", "sandbox", "exec", "-i", "aws:x", "--", "sh"]);
  assert.ok(!spawned.argv.some((a) => a.includes("0123456789abcdef")), "token not in argv");
  assert.deepEqual(spawned.argv.slice(-3), ["python3", "-I", "/tmp/h/helper"]);
  assert.equal(spawned.argv[8], 'IFS= read -r PI_GUI_TESTING_TOKEN && export PI_GUI_TESTING_TOKEN && exec "$@"');
  assert.equal(spawned.env.DISPLAY, undefined);
  assert.equal(spawned.env.PATH, "/usr/bin");
  assert.equal(await spawned.firstData, "0123456789abcdef0123456789abcdef\n");
  child.kill("SIGTERM");
  assert.throws(() => envPreamble({ "BAD;NAME": "x" }), /invalid environment variable name/);
  assert.throws(() => envPreamble({ OK: "a\nb" }), /line break/);
});

test("the exit-handler argv carries no secret", () => {
  const argv = api(new FakeCommandRunner()).forceDeleteArgv("aws:x");
  assert.deepEqual(argv.slice(-5), ["cua", "sandbox", "rm", "aws:x", "--force"]);
  assert.ok(argv.includes("CUA_HOME=/home/u/.cua"));
  assert.ok(argv.includes("AWS_PROFILE=dev"));
  assert.ok(!argv.some((a) => a.includes("s3cr3t") || a.includes("aws-secret-value")), argv.join(" "));
  assert.ok(nonSecretEnvWords({ CUA_DAEMON_TOKEN: "x", HCLOUD_TOKEN: "y" }).every((w) => !w.includes("TOKEN")));
  assert.equal(cuaEnv({ DISPLAY: ":0" }).DISPLAY, undefined);
});

test("W5: the exit-handler argv carries only allowlisted settings: no API keys, no proxy credentials", () => {
  const words = nonSecretEnvWords({
    PATH: "/usr/bin",
    CUA_HOME: "/home/u/.cua",
    CUA_API_KEY: "demo-key",
    CUA_ANYTHING_NEW: "demo-new",
    GOOGLE_API_KEY: "demo-google-key",
    GOOGLE_CLOUD_PROJECT: "proj-1",
    HTTPS_PROXY: "http://name:demo-password@proxy.invalid",
    HTTP_PROXY: "http://proxy.invalid:3128",
    https_proxy: "http://name@proxy.invalid",
    HCLOUD_TOKEN: "demo-token",
    AWS_PROFILE: "dev",
    AWS_ACCESS_KEY_ID: "AKIADEMO",
    AWS_REGION: "eu-west-1",
  });
  assert.deepEqual(words, [
    "AWS_PROFILE=dev",
    "AWS_REGION=eu-west-1",
    "CUA_HOME=/home/u/.cua",
    "CUA_KEYCHAIN_NONINTERACTIVE=1",
    "CUA_NO_BROWSER=1",
    "GOOGLE_CLOUD_PROJECT=proj-1",
    "HTTP_PROXY=http://proxy.invalid:3128",
  ]);
  for (const secret of ["demo-key", "demo-new", "demo-google-key", "demo-password", "demo-token", "AKIADEMO", "name@"]) {
    assert.ok(!words.some((w) => w.includes(secret)), `${secret} in ${words.join(" ")}`);
  }
  const argv = new CuaCliApi({ runner: new FakeCommandRunner(), baseEnv: { PATH: "/usr/bin", CUA_API_KEY: "demo-key", HTTPS_PROXY: "http://a:b@p.invalid" } }).forceDeleteArgv("aws:x");
  assert.deepEqual(argv, ["env", "CUA_KEYCHAIN_NONINTERACTIVE=1", "CUA_NO_BROWSER=1", "cua", "sandbox", "rm", "aws:x", "--force"]);
});

test("redact removes credential shapes and keeps paths readable", () => {
  assert.equal(redact('{"token": "abcdef", "name": "ok"}'), '{"token": "[redacted]", "name": "ok"}');
  assert.equal(redact("Authorization: Bearer abc.def"), "Authorization: Bearer [redacted]");
  assert.equal(redact("x-cua-env-authorization: abc"), "x-cua-env-authorization: [redacted]");
  assert.equal(redact("https://user:pw@example.com/x?token=abc&y=1"), "https://[redacted]@example.com/x?token=[redacted]", "over-redacting the rest of a query is fine");
  assert.equal(redact("HCLOUD_TOKEN=abcdef ok"), "HCLOUD_TOKEN=[redacted] ok");
  assert.equal(redact("/tmp/pi-gui-testing/gui-00000001/workspace/some/long/path/file.py"), "/tmp/pi-gui-testing/gui-00000001/workspace/some/long/path/file.py");
  assert.equal(redact(`key ${"a1".repeat(30)}`), "key [redacted]");
  assert.equal(redact("value mysecretvalue here", ["mysecretvalue"]), "value [redacted] here");
  assert.ok(redact("x".repeat(10_000) + " ").length <= 2_001);
});
