/**
 * The `cua` CLI adapter for Windows guests: the Windows helper's stream with
 * `-StdinEnv` (values on stdin, never in argv), Windows guest paths for
 * `cua sandbox cp`, and PowerShell guest commands through `exec -i`. No `cua`
 * process runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CuaCliApi, powershellStdinEnv } from "../../../../src/backends/cua/cli-api.ts";
import { powershellArgv, probeScript, windowsHelperArgv, windowsHelperEnv } from "../../../../src/backends/cua/windows.ts";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";
import { fakeSpawner } from "../fakes.mjs";

const BASE_ENV = { PATH: "/usr/bin", HOME: "/home/u", DISPLAY: ":0", CUA_HOME: "/home/u/.cua", AWS_SECRET_ACCESS_KEY: "aws-secret-value" };
const TOKEN = "0123456789abcdef0123456789abcdef";

function api(runner, spawner) {
  return new CuaCliApi({ runner, baseEnv: BASE_ENV, ...(spawner ? { spawner } : {}) });
}

test("the Windows helper stream appends -StdinEnv and writes the values, sorted, as the first stdin lines", async () => {
  const spawner = fakeSpawner({ noReady: true, onSpawn: (c) => (c.firstData = new Promise((resolve) => c.stdin.once("data", (d) => resolve(d.toString())))) });
  const cua = api(new FakeCommandRunner(), spawner);
  const env = { ...windowsHelperEnv("gui-1"), PI_GUI_TESTING_TOKEN: TOKEN };
  const child = cua.spawnHelper("aws:x", windowsHelperArgv("gui-1"), env, { stdinEnv: "powershell" });
  const [spawned] = spawner.children;
  assert.deepEqual(spawned.argv, [
    "cua",
    "sandbox",
    "exec",
    "-i",
    "aws:x",
    "--",
    ...windowsHelperArgv("gui-1"),
    "-StdinEnv",
    "PI_GUI_ALLOW_EXEC,PI_GUI_HELPER_MODE,PI_GUI_RUNTIME_DIR,PI_GUI_TESTING_TOKEN,PI_GUI_WORKSPACE",
  ]);
  assert.ok(!spawned.argv.some((a) => a.includes(TOKEN) || a.includes("C:\\pi-gui-testing\\gui-1\\workspace")), "no value in argv");
  assert.ok(!spawned.argv.includes("sh"), "no POSIX shell on a Windows guest");
  assert.equal(await spawned.firstData, `1\nguest\nC:\\pi-gui-testing\\gui-1\\pi-gui-testing-gui-1\n${TOKEN}\nC:\\pi-gui-testing\\gui-1\\workspace\n`);
  assert.equal(spawned.env.DISPLAY, undefined);
  assert.equal(spawned.env.AWS_SECRET_ACCESS_KEY, "aws-secret-value", "cloud credentials reach the local cua process only");
  child.kill("SIGTERM");
});

test("-StdinEnv refuses names outside the variable syntax and values with CR, LF, or NUL", () => {
  assert.throws(() => powershellStdinEnv({ "A,B": "x" }), /invalid environment variable name/);
  assert.throws(() => powershellStdinEnv({ OK: "a\r" }), /line break or NUL/);
  assert.throws(() => powershellStdinEnv({ OK: "a\nb" }), /line break or NUL/);
  assert.throws(() => powershellStdinEnv({ OK: "a\0" }), /line break or NUL/);
  assert.deepEqual(powershellStdinEnv({}), { args: [], lines: "" });
  assert.deepEqual(powershellStdinEnv({ B: "2", A: "1" }), { args: ["-StdinEnv", "A,B"], lines: "1\n2\n" });
});

test("the Linux helper stream is unchanged by the option's default", () => {
  const spawner = fakeSpawner({ noReady: true });
  const child = api(new FakeCommandRunner(), spawner).spawnHelper("aws:x", ["python3", "-I", "/tmp/h/helper"], { PI_GUI_TESTING_TOKEN: TOKEN });
  assert.deepEqual(spawner.children[0].argv.slice(0, 9), ["cua", "sandbox", "exec", "-i", "aws:x", "--", "sh", "-c", 'IFS= read -r PI_GUI_TESTING_TOKEN && export PI_GUI_TESTING_TOKEN && exec "$@"']);
  child.kill("SIGTERM");
});

test("uploads accept Windows drive paths (the CLI splits <ref>:<path> before the drive) and refuse relative ones", async () => {
  const runner = new FakeCommandRunner().on(["cua", "--json", "sandbox", "cp"], { stdout: JSON.stringify({ direction: "upload", size: 10, sha256: "ab" }) }, { prefix: true });
  const cua = api(runner);
  assert.deepEqual(await cua.upload("aws:pi-gui-testing-abcd1234-gui-1", "/tmp/s/helper.tar", "C:\\pi-gui-testing\\gui-1\\tools.tar"), { size: 10 });
  assert.deepEqual(runner.calls[0].argv, ["cua", "--json", "sandbox", "cp", "/tmp/s/helper.tar", "aws:pi-gui-testing-abcd1234-gui-1:C:\\pi-gui-testing\\gui-1\\tools.tar"]);
  await assert.rejects(cua.upload("aws:x", "/tmp/f", "tools.tar"), /must be absolute/);
  await assert.rejects(cua.upload("aws:x", "/tmp/f", "C:tools.tar"), /must be absolute/);
});

test("PowerShell guest commands go through exec -i as plain argv", async () => {
  const runner = new FakeCommandRunner().on(["cua", "sandbox", "exec"], { stdout: "build:20348\n" }, { prefix: true });
  const argv = powershellArgv(probeScript());
  const result = await api(runner).exec("aws:x", argv, { timeoutMs: 1_000 });
  assert.equal(result.stdout, "build:20348\n");
  assert.deepEqual(runner.calls[0].argv, ["cua", "sandbox", "exec", "-i", "aws:x", "--", ...argv]);
});
