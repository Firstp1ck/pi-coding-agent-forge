import { test } from "node:test";
import assert from "node:assert/strict";
import { forbiddenLocalHelperEnv, localHelperEnv, passedWindowsEnv } from "../../../../src/backends/windows/env.ts";
import { INSPECT_ENV, INSPECT_SCRIPT, inspectWindowsObjects, validateInspectRequest } from "../../../../src/backends/windows/inspect.ts";
import { encodeCommand, envValue, HELPER_FILES, isDrivePath, isDirectChild, localTempRoot, powershellPath, samePath } from "../../../../src/backends/windows/paths.ts";
import { classifyHelperFailure, probeCache, runHelperProbe } from "../../../../src/backends/windows/probe.ts";
import { isPackageRuntimeDir, ownerRecordFrom, runtimeDirName } from "../../../../src/backends/windows/runtime-dir.ts";
import { parseSessionRecord } from "../../../../src/backends/windows/session-record.ts";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { HELPER_DIR as PKG_HELPER_DIR } from "../../../../src/backends/windows/paths.ts";
import { ownerRecord, sessionRecord, HELPER_DIR, POWERSHELL, TEMP_ROOT, WIN_ENV } from "./local-fakes.mjs";

const RUNTIME = `${TEMP_ROOT}\\pi-gui-testing-win-0123456789abcdef`;

test("Windows paths: case-insensitive variables, drive paths only, tools under SystemRoot", () => {
  assert.equal(envValue({ PATH: "a" }, "Path"), "a");
  assert.equal(envValue({ Path: "b", PATH: "c" }, "PATH"), "c", "an exact match wins");
  assert.equal(isDrivePath("C:\\Windows"), true);
  for (const bad of ["\\\\server\\share", "relative\\dir", "C:relative", "C:\\a\\..\\b", "\\\\?\\C:\\x", "C:\\a\"b"]) assert.equal(isDrivePath(bad), false, bad);
  assert.equal(powershellPath({ SYSTEMROOT: "D:\\WINNT" }), "D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.throws(() => powershellPath({ Path: "C:\\Windows\\System32" }), /SystemRoot is not set/);
  assert.equal(localTempRoot(WIN_ENV), TEMP_ROOT);
  assert.equal(samePath("C:\\Users\\X\\", "c:\\users\\x"), true);
  assert.equal(isDirectChild(TEMP_ROOT, RUNTIME.toUpperCase()), true);
  assert.equal(isDirectChild(TEMP_ROOT, `${RUNTIME}\\tmp`), false);
  assert.equal(Buffer.from(encodeCommand("Write-Output 'é'"), "base64").toString("utf16le"), "Write-Output 'é'");
});

test("the helper file list matches the files shipped in helpers/windows", () => {
  const onDisk = [
    ...readdirSync(PKG_HELPER_DIR).filter((n) => /\.(ps1|md)$/.test(n)),
    ...readdirSync(join(PKG_HELPER_DIR, "src")).filter((n) => n.endsWith(".cs")).map((n) => `src\\${n}`),
    ...readdirSync(join(PKG_HELPER_DIR, "src", "win")).filter((n) => n.endsWith(".cs")).map((n) => `src\\win\\${n}`),
  ].sort();
  assert.deepEqual([...HELPER_FILES].sort(), onDisk);
});

test("the helper environment is an allow-list: no secrets, no exec, no interactive desktop", () => {
  const env = localHelperEnv({ base: { ...WIN_ENV, path: "lower-case duplicate" }, workspace: "C:\\proj", runtimeDir: RUNTIME, heartbeatTimeoutMs: 900 });
  assert.equal(env.PI_GUI_HELPER_MODE, "local");
  assert.equal(env.PI_GUI_WORKSPACE, "C:\\proj");
  assert.equal(env.PI_GUI_RUNTIME_DIR, RUNTIME);
  assert.equal(env.PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS, "900");
  assert.equal(env.Path, WIN_ENV.Path);
  assert.equal(Object.keys(env).filter((k) => k.toLowerCase() === "path").length, 1);
  for (const key of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "PI_GUI_ALLOW_EXEC", "PI_GUI_WIN_DESKTOP"]) assert.equal(env[key], undefined, key);
  assert.deepEqual(forbiddenLocalHelperEnv(env), []);
  assert.deepEqual(forbiddenLocalHelperEnv({ ...env, pi_gui_allow_exec: "1", OPENAI_API_KEY: "x" }), ["pi_gui_allow_exec", "OPENAI_API_KEY"]);
  assert.deepEqual(passedWindowsEnv({ TEMP: "C:\\t\r\nPI_GUI_ALLOW_EXEC=1" }), {}, "values with line breaks are dropped");
});

test("session records: the helper's own format is accepted, anything else rejected", () => {
  const good = sessionRecord(RUNTIME, { jobs: ["Local\\pi-gui-testing-0123456789abcdef-job-00000000000000aa"], processes: [{ pid: 7, created: "133000000000000001" }, { pid: 8, created: "0" }] });
  const parsed = parseSessionRecord(JSON.stringify(good), { runtimeDir: RUNTIME.toLowerCase(), mode: "local" });
  assert.ok("record" in parsed, JSON.stringify(parsed));
  assert.deepEqual(parsed.record.processes, [{ pid: 7, created: "133000000000000001" }]);
  assert.equal(parsed.record.omitted, 1, "a process without a creation time cannot be matched");
  const bad = [
    [{ version: 2 }, /unknown version/],
    [{ tag: "../../x" }, /tag/],
    [{ mode: "guest" }, /mode guest, not local/],
    [{ desktop: "Default" }, /desktop name/],
    [{ desktop: "pi-gui-testing-ffffffffffffffff-abababababababababababababababab" }, /desktop name/],
    [{ jobs: ["Global\\pi-gui-testing-0123456789abcdef-job-00000000000000aa"] }, /job that is not the session's/],
    [{ jobs: ["Local\\pi-gui-testing-0123456789abcdef-job-00000000000000aa\\..\\x"] }, /job/],
    [{ processes: [{ pid: -1, created: "1" }] }, /malformed process/],
    [{ processes: [{ pid: 7, created: "99999999999999999999" }] }, /malformed process/],
    [{ helper: { pid: 1, created: "abc" } }, /helper process/],
    [{ tmpDir: "C:\\Users\\tester\\Documents" }, /temp dir outside/],
    [{ windowStation: "Win\\Sta0" }, /window station/],
    [{ status: "zombie" }, /status/],
  ];
  for (const [patch, error] of bad) {
    const result = parseSessionRecord(JSON.stringify({ ...good, ...patch }), { runtimeDir: RUNTIME, mode: "local" });
    assert.ok("problem" in result, JSON.stringify(patch));
    assert.match(result.problem, error, JSON.stringify(patch));
  }
  assert.match(parseSessionRecord("{", { runtimeDir: RUNTIME }).problem, /not valid JSON/);
  assert.match(parseSessionRecord(" ".repeat(1024 * 1024 + 1), { runtimeDir: RUNTIME }).problem, /larger than 1 MiB/);
});

test("inspection: data goes through the environment, the script never changes, answers for unasked ids are ignored", async () => {
  const runner = new FakeCommandRunner().on((argv) => argv[0] === POWERSHELL, (argv, options) => {
    const request = JSON.parse(options.env[INSPECT_ENV]);
    assert.equal(request.action, "kill");
    return {
      exitCode: 0,
      stdout: `noise\r\n${JSON.stringify({ probe: "inspect", processes: [{ id: "7:1", state: "killed" }, { id: "666:1", state: "alive" }], jobs: [{ id: request.jobs[0], state: "bogus" }], desktops: [] })}\r\n`,
    };
  });
  const tag = "0123456789abcdef";
  const request = { action: "kill", tag, processes: [{ pid: 7, created: "1" }], jobs: [`Local\\pi-gui-testing-${tag}-job-00000000000000aa`], desktops: [`pi-gui-testing-${tag}-${"cd".repeat(16)}`] };
  const result = await inspectWindowsObjects(request, { runner, powershell: POWERSHELL, env: { SystemRoot: "C:\\Windows" } });
  assert.deepEqual([...result.processes], [["7:1", "killed"]]);
  assert.deepEqual([...result.jobs.values()], ["unknown"], "an invalid state is unknown, never gone");
  assert.deepEqual([...result.desktops.values()], ["unknown"], "an unanswered object is unknown");
  const argv = runner.calls[0].argv;
  assert.equal(argv[argv.indexOf("-EncodedCommand") + 1], encodeCommand(INSPECT_SCRIPT));
  assert.equal(argv.join(" ").includes(tag), false, "names never reach the command line");

  assert.equal(validateInspectRequest({ ...request, jobs: ["Local\\other"] }), "invalid job name");
  assert.equal(validateInspectRequest({ ...request, desktops: ["Default"] }), "invalid desktop name");
  assert.equal(validateInspectRequest({ ...request, processes: [{ pid: 7, created: "1; Stop-Computer" }] }), "invalid process id");
  const refused = await inspectWindowsObjects({ ...request, jobs: ["Local\\other"] }, { runner, powershell: POWERSHELL, env: {} });
  assert.match(refused.problem, /refused to inspect: invalid job name/);
  assert.equal(runner.calls.length, 1, "a refused request runs nothing");
});

test("probe failures are classified for the right remediation", () => {
  const base = { exitCode: 1, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1200 };
  assert.equal(classifyHelperFailure({ ...base, stderr: "pi-gui-helper: compiling the helper failed (antivirus or application control blocking csc.exe?): x" }).kind, "blocked");
  assert.equal(classifyHelperFailure({ ...base, stderr: "File C:\\x\\helper.ps1 cannot be loaded because running scripts is disabled on this system." }).kind, "execution-policy");
  assert.equal(classifyHelperFailure({ ...base, stderr: "File helper.ps1 is not digitally signed." }).kind, "execution-policy");
  assert.equal(classifyHelperFailure({ ...base, stderr: "pi-gui-helper: PowerShell runs in ConstrainedLanguage mode (an AppLocker or WDAC policy)" }).kind, "language-mode");
  assert.equal(classifyHelperFailure({ ...base, exitCode: null, signal: "SIGKILL" }).kind, "killed");
  assert.equal(classifyHelperFailure({ ...base, exitCode: null, signal: "SIGTERM", timedOut: true }).kind, "timeout");
  const plain = classifyHelperFailure({ ...base, exitCode: 2, stderr: `${"x".repeat(5000)}\u0007\n` });
  assert.equal(plain.kind, "failed");
  assert.ok(plain.problem.length < 400, "stderr is quoted bounded");
  assert.equal(/\u0007/.test(plain.problem), false);
});

test("a probe report is read from the last JSON line and must name the probe", async () => {
  const runner = new FakeCommandRunner()
    .on((argv) => argv.at(-1) === "env", { exitCode: 0, stdout: 'banner\r\n{"probe":"env","ok":true,"build":22631}\r\n' })
    .on((argv) => argv.at(-1) === "job", { exitCode: 0, stdout: '{"probe":"job","ok":true}\r\n{"probe":"env","ok":true}\r\n' });
  const options = { runner, powershell: POWERSHELL, helperDir: HELPER_DIR, env: {} };
  const env = await runHelperProbe("env", options);
  assert.equal(env.ok, true);
  assert.equal(env.report.build, 22631);
  const job = await runHelperProbe("job", options);
  assert.equal(job.ok, false);
  assert.match(job.problem, /answered for probe env, not job/);

  let runs = 0;
  const cached = probeCache(async () => ({ ok: true, report: { n: ++runs } }));
  const signal = new AbortController().signal;
  await Promise.all([cached("env", signal), cached("env", signal)]);
  await cached("env", signal);
  assert.equal(runs, 1);
});

test("runtime dir names and owner copies", () => {
  const name = runtimeDirName(Buffer.alloc(8, 0xab));
  assert.equal(name, "pi-gui-testing-win-abababababababab");
  assert.equal(isPackageRuntimeDir(TEMP_ROOT, `${TEMP_ROOT}\\${name}`), true);
  assert.equal(isPackageRuntimeDir(TEMP_ROOT, `${TEMP_ROOT}\\pi-gui-testing-AbC123`), false, "generic session dirs are not runtime dirs");
  assert.equal(isPackageRuntimeDir(TEMP_ROOT, `C:\\Elsewhere\\${name}`), false);
  assert.deepEqual(ownerRecordFrom(JSON.stringify(ownerRecord())), ownerRecord());
  assert.equal(ownerRecordFrom(JSON.stringify(ownerRecord({ pid: 0 }))), undefined);
  assert.equal(ownerRecordFrom(JSON.stringify(ownerRecord({ resources: [{ kind: 1 }] }))), undefined);
  assert.equal(ownerRecordFrom("not json"), undefined);
});
