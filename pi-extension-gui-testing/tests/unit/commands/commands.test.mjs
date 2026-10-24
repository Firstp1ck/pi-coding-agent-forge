import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGuiCommands } from "../../../src/commands/commands.ts";
import { createGuiTools } from "../../../src/tools/tools.ts";
import { createSpawnRunner } from "../../../src/runner/spawn.ts";
import { fakeEnv, VERIFIED } from "../backends/env.mjs";

/** Captures stderr writes and restores `process.exitCode` after the test. */
function capture(t) {
  const original = process.stderr.write;
  const exitCode = process.exitCode;
  const written = [];
  process.stderr.write = (chunk) => (written.push(String(chunk)), true);
  t.after(() => {
    process.stderr.write = original;
    process.exitCode = exitCode;
  });
  return { text: () => written.join(""), reset: () => (written.length = 0) };
}

function commands(env) {
  const messages = [];
  const pi = { sendMessage: (m) => messages.push(m) };
  const byName = Object.fromEntries(createGuiCommands(pi, env.runtime).map((c) => [c.name, c]));
  return { byName, messages };
}

const prompts = (calls) => calls.filter(([kind]) => kind === "select" || kind === "confirm" || kind === "input");

test("S15: without a UI, /gui-setup with no backend prompts nothing, reports on stderr in print mode, and sets exit code 1", async (t) => {
  const env = await fakeEnv(t, { verified: false });
  const out = capture(t);
  const { byName, messages } = commands(env);
  process.exitCode = undefined;
  await byName["gui-setup"].handler("", env.ctx());
  assert.match(out.text(), /\/gui-setup needs a backend when there is no interactive UI; run \/gui-setup docker-linux/);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(prompts(env.uiCalls), []);
  assert.deepEqual(messages, []);
});

test("S15: a needed fix without --fix in print mode fails with the missing flags and never prompts", async (t) => {
  const env = await fakeEnv(t, { verified: false, docker: { imageMissing: true } });
  const out = capture(t);
  process.exitCode = undefined;
  await commands(env).byName["gui-setup"].handler("docker-linux", env.ctx());
  assert.match(out.text(), /GUI testing setup: docker-linux — failed/);
  assert.match(out.text(), /fail +image\.base +required +pi-gui-testing-base:0\.1\.0 not found/);
  assert.match(out.text(), /Missing flags: --fix, --no-fix/);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(prompts(env.uiCalls), []);
  assert.equal(existsSync(env.globalConfigPath), false, "nothing persisted");
});

test("S1/S3 (unit): /gui-setup docker-linux --fix builds the image, re-checks, passes the smoke test, and persists with zero prompts", async (t) => {
  const env = await fakeEnv(t, { verified: false, docker: { imageMissing: true } });
  const { byName, messages } = commands(env);
  const ctx = env.ctx({ hasUI: true, mode: "tui" });
  await byName["gui-setup"].handler("docker-linux --fix", ctx);
  assert.deepEqual(prompts(env.uiCalls), [], "zero prompts");
  assert.equal(messages.length, 1, "one summary");
  const report = messages[0].content;
  assert.match(report, /GUI testing setup: docker-linux — verified/);
  assert.match(report, /Checks before fixes:[\s\S]*fail +image\.base[\s\S]*Checks after fixes:[\s\S]*pass +image\.base/);
  assert.match(report, /Fixes applied:\n- image\.base: ok/);
  assert.match(report, /Smoke test: passed — GTK 3 app launched, button found by name, click changed the label, 64×40 screenshot valid/);
  const build = env.spawner.children.find((c) => c.argv.includes("build"));
  assert.ok(build, "image built through the staged-context build");
  const config = JSON.parse(await readFile(env.globalConfigPath, "utf8"));
  assert.equal(config.backend, "docker-linux");
  assert.equal(config.verified["docker-linux"].toolVersions["docker.server"], "29.9.1");
  assert.ok(config.verified["docker-linux"].checksPassed.includes("isolation.inspect"));
  // Smoke session cleaned up: no container, no session dir, nothing in the runtime.
  assert.equal(env.state.containers.size, 0);
  assert.deepEqual(await readdir(env.tmp), []);
  assert.deepEqual(env.runtime.list(), []);
  assert.ok(env.notes.some((n) => /verified/.test(n.message)));
});

test("/gui-setup --project writes the backend choice to .pi/gui.local.json", async (t) => {
  const env = await fakeEnv(t, { verified: false });
  await commands(env).byName["gui-setup"].handler("docker-linux --project", env.ctx({ hasUI: true, mode: "tui" }));
  assert.equal(JSON.parse(await readFile(join(env.project, ".pi", "gui.local.json"), "utf8")).backend, "docker-linux");
  assert.equal(JSON.parse(await readFile(env.globalConfigPath, "utf8")).backend, undefined);
});

test("JSON mode reports as a custom message, never on stderr; failure sets the exit code", async (t) => {
  const env = await fakeEnv(t, { verified: false, docker: { info: { exitCode: 1, stderr: "Cannot connect to the Docker daemon" } } });
  const out = capture(t);
  const { byName, messages } = commands(env);
  process.exitCode = undefined;
  await byName["gui-doctor"].handler("docker-linux", env.ctx({ mode: "json" }));
  assert.equal(out.text(), "");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].customType, "gui-testing");
  assert.equal(messages[0].display, true);
  assert.match(messages[0].content, /GUI testing doctor: docker-linux — failed[\s\S]*fail +docker\.daemon/);
  assert.equal(process.exitCode, 1);
  assert.equal(existsSync(env.globalConfigPath), false, "doctor never creates config files");
});

test("/gui-doctor on a healthy host refreshes the verified state and includes the orphan audit", async (t) => {
  const env = await fakeEnv(t);
  const out = capture(t);
  process.exitCode = undefined;
  await commands(env).byName["gui-doctor"].handler("", env.ctx());
  assert.match(out.text(), /GUI testing doctor: docker-linux — verified/);
  assert.match(out.text(), /Footprint audit \(orphans of ended sessions\): empty/);
  assert.equal(process.exitCode, undefined);
  assert.notEqual(JSON.parse(await readFile(env.globalConfigPath, "utf8")).verified["docker-linux"].verifiedAt, VERIFIED.verifiedAt);
});

test("S13: /gui-cleanup cancels a running setup after it created resources; nothing is left and nothing is saved", async (t) => {
  let release;
  const env = await fakeEnv(t, {
    verified: false,
    behaviour: { handlers: { launch: () => new Promise((resolve) => (release = resolve)) } },
  });
  capture(t);
  const { byName, messages } = commands(env);
  const ctx = env.ctx({ hasUI: true, mode: "rpc" });
  const setup = byName["gui-setup"].handler("docker-linux --fix", ctx);
  // Wait until the smoke-test container exists (resources were created).
  for (let i = 0; i < 200 && env.state.containers.size === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(env.state.containers.size, 1);
  await byName["gui-cleanup"].handler("", ctx);
  release?.({ pid: 1, windows: [] });
  await setup;
  const setupReport = messages.find((m) => /GUI testing setup/.test(m.content));
  assert.match(setupReport.content, /— cancelled[\s\S]*setup cancelled: cancelled by \/gui-cleanup; nothing was saved/);
  const cleanupReport = messages.find((m) => /GUI testing cleanup/.test(m.content));
  assert.match(cleanupReport.content, /cancelled the running \/gui-setup/);
  assert.equal(env.state.containers.size, 0);
  assert.deepEqual(await readdir(env.tmp), []);
  assert.equal(existsSync(env.globalConfigPath), false);
});

test("a second setup while one runs is refused with a pointer to /gui-cleanup", async (t) => {
  const env = await fakeEnv(t, { verified: false });
  const controller = env.runtime.beginSetup("/gui-setup");
  const out = capture(t);
  try {
    await commands(env).byName["gui-setup"].handler("docker-linux", env.ctx());
  } finally {
    // Ended before the env's shutdown, which would otherwise wait its full bound for this run.
    env.runtime.endSetup(controller);
  }
  assert.match(out.text(), /\/gui-setup is already running; wait for it or cancel it with \/gui-cleanup/);
});

test("/gui-reset never prompts without a UI; with a UI it asks once and removes images, verified state, and the backend choice", async (t) => {
  const env = await fakeEnv(t, { global: { backend: "docker-linux" } });
  const out = capture(t);
  const { byName, messages } = commands(env);
  process.exitCode = undefined;
  await byName["gui-reset"].handler("docker-linux", env.ctx());
  assert.match(out.text(), /needs your confirmation in an interactive Pi session/);
  assert.equal(process.exitCode, 1);
  assert.ok(JSON.parse(await readFile(env.globalConfigPath, "utf8")).verified["docker-linux"]);

  env.runner.on(/image ls -q --no-trunc --filter label=pi-gui-testing\.base/, { stdout: "sha256:aaa\nsha256:aaa\n" });
  env.runner.on(/image rm -f sha256:aaa/, {});
  await byName["gui-reset"].handler("docker-linux", env.ctx({ hasUI: true, mode: "tui", answers: { confirm: true } }));
  assert.equal(prompts(env.uiCalls).length, 1);
  assert.match(messages.at(-1).content, /removed 1 base image\(s\)[\s\S]*Leftovers: empty/);
  const config = JSON.parse(await readFile(env.globalConfigPath, "utf8"));
  assert.equal(config.verified["docker-linux"], undefined);
  assert.equal(config.backend, undefined);
});

test("/gui-backend requires a verified backend; /gui-usage and /gui-export report per mode", async (t) => {
  const env = await fakeEnv(t);
  const out = capture(t);
  const { byName } = commands(env);
  await byName["gui-backend"].handler("docker-linux", env.ctx());
  assert.match(out.text(), /GUI testing backend is now docker-linux \(global config\)/);
  assert.equal(JSON.parse(await readFile(env.globalConfigPath, "utf8")).backend, "docker-linux");
  await byName["gui-backend"].handler("cua", env.ctx());
  assert.match(out.text(), /backend "cua" is not verified; run \/gui-setup cua first/);
  await byName["gui-backend"].handler("docker-windows", env.ctx());
  assert.match(out.text(), /backend "docker-windows" is not available yet/);
  await byName["gui-backend"].handler("--bogus", env.ctx());
  assert.match(out.text(), /\/gui-backend: unknown flag --bogus; valid flags: --project/);

  const tools = Object.fromEntries(createGuiTools(env.runtime).map((x) => [x.name, x]));
  const { session } = (await tools.gui_launch.execute("c", {}, undefined, undefined, env.ctx())).details;
  await tools.gui_screenshot.execute("c", { session }, undefined, undefined, env.ctx());
  out.reset();
  await byName["gui-usage"].handler("", env.ctx());
  assert.match(out.text(), new RegExp(`${session} \\(docker-linux, running, [\\d.]+ min\\): gui_launch 1, gui_screenshot 1; actions 0, screenshots 1`));
  await byName["gui-export"].handler(`${session} exported`, env.ctx());
  assert.match(out.text(), /exported \d+ file\(s\) from gui-/);
  assert.ok((await readdir(join(env.project, "exported"))).some((n) => n.endsWith(".png")));
  await byName["gui-export"].handler("gui-nope exported", env.ctx());
  assert.match(out.text(), /unknown GUI session "gui-nope"/);
});

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** fakeEnv whose project is a real Git repo; `git` calls go to the real binary through the fake runner. */
async function gitEnv(t) {
  const env = await fakeEnv(t, { verified: false });
  execFileSync("git", ["-C", env.project, "init", "-q"], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const real = createSpawnRunner();
  env.runner.on(/^git /, (argv, options) => real.run(argv, { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }));
  return env;
}
const gitignore = (env) => readFile(join(env.project, ".gitignore"), "utf8").catch(() => undefined);

test("Z13: /gui-setup --project without a UI or --fix warns that .pi/gui.local.json is not ignored and leaves .gitignore alone", { skip: hasGit ? false : "git not installed" }, async (t) => {
  const env = await gitEnv(t);
  const out = capture(t);
  await commands(env).byName["gui-setup"].handler("docker-linux --project", env.ctx());
  assert.match(out.text(), /— verified/);
  assert.match(out.text(), /warning: \.pi\/gui\.local\.json holds personal settings but Git does not ignore it; add it to \.gitignore.*--fix/);
  assert.equal(await gitignore(env), undefined);
  assert.deepEqual(prompts(env.uiCalls), []);
  const gitCalls = env.runner.calls.filter((c) => c.argv[0] === "git");
  assert.ok(gitCalls.length >= 2 && gitCalls.every((c) => c.argv.includes("core.fsmonitor=false")), "git runs with fsmonitor disabled");
});

test("Z13: --fix adds .pi/gui.local.json to .gitignore without asking; an existing rule means no offer at all", { skip: hasGit ? false : "git not installed" }, async (t) => {
  const env = await gitEnv(t);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(env.project, ".gitignore"), "node_modules/");
  const ctx = env.ctx({ hasUI: true, mode: "tui" });
  const { byName, messages } = commands(env);
  await byName["gui-setup"].handler("docker-linux --project --fix", ctx);
  assert.match(messages[0].content, /added \.pi\/gui\.local\.json to \.gitignore/);
  assert.equal(await gitignore(env), "node_modules/\n.pi/gui.local.json\n");
  assert.deepEqual(prompts(env.uiCalls), []);
  await byName["gui-setup"].handler("docker-linux --project", ctx);
  assert.doesNotMatch(messages[1].content, /gitignore/);
  assert.deepEqual(prompts(env.uiCalls), []);
});

test("Z13: with a UI, /gui-setup --project asks once; yes adds the line, no leaves a warning", { skip: hasGit ? false : "git not installed" }, async (t) => {
  for (const answer of [true, false]) {
    const env = await gitEnv(t);
    const { byName, messages } = commands(env);
    await byName["gui-setup"].handler("docker-linux --project", env.ctx({ hasUI: true, mode: "tui", answers: { confirm: answer } }));
    const asked = prompts(env.uiCalls);
    assert.equal(asked.length, 1, `asked once (answer ${answer})`);
    assert.match(asked[0][1], /Keep \.pi\/gui\.local\.json out of Git\?/);
    if (answer) {
      assert.equal(await gitignore(env), ".pi/gui.local.json\n");
      assert.match(messages[0].content, /added \.pi\/gui\.local\.json to \.gitignore/);
    } else {
      assert.equal(await gitignore(env), undefined);
      assert.match(messages[0].content, /warning: \.pi\/gui\.local\.json holds personal settings/);
    }
  }
});

test("Z17: config warnings appear in command reports in every mode", async (t) => {
  const env = await fakeEnv(t, { shared: { surprise: true } });
  const out = capture(t);
  const { byName, messages } = commands(env);
  await byName["gui-usage"].handler("", env.ctx());
  assert.match(out.text(), /Config warnings:\n- .*gui\.json: unknown field "surprise" ignored/);
  await byName["gui-doctor"].handler("", env.ctx({ mode: "json" }));
  assert.match(messages.at(-1).content, /Config warnings:\n- .*unknown field "surprise"/);
  await byName["gui-cleanup"].handler("", env.ctx({ hasUI: true, mode: "tui" }));
  assert.match(messages.at(-1).content, /Config warnings:/);
});

test("Z8: /gui-cleanup sweeps Docker orphans when docker is on PATH even if the backend is not verified, and never without it", async (t) => {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const env = await fakeEnv(t, { verified: false, dockerOnPath: true });
  env.state.containers.set("pi-gui-testing-dead03", { id: "id-dead03", session: "dead03", owner: `x:1:999999999999:${bootId}`, inspect: {} });
  capture(t);
  await commands(env).byName["gui-cleanup"].handler("", env.ctx());
  assert.deepEqual(env.state.removed, ["id-dead03"]);

  const none = await fakeEnv(t, { dockerOnPath: false });
  await commands(none).byName["gui-cleanup"].handler("", none.ctx());
  assert.ok(!none.runner.commands().some((c) => c.startsWith("docker")), "no docker command without a docker executable");
});

/** A UI whose dialogs stay open until the test answers them; records each call and its options. */
function delayedUi() {
  const calls = [];
  const pending = [];
  const open = (kind) => (...args) =>
    new Promise((resolve) => {
      calls.push([kind, ...args]);
      pending.push(resolve);
    });
  const ui = { notify() {}, setStatus() {}, select: open("select"), confirm: open("confirm"), input: open("input") };
  const opened = async () => {
    for (let i = 0; i < 400 && pending.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(pending.length > 0, "a dialog opened");
  };
  return { ui, calls, opened, answer: (value) => pending.shift()(value) };
}

test("Q6: the backend picker runs inside the tracked setup; a late answer after shutdown starts nothing and saves nothing", async (t) => {
  const env = await fakeEnv(t, { verified: false, runtime: { shutdownWaitMs: 50 } });
  capture(t);
  const { byName, messages } = commands(env);
  const dialogs = delayedUi();
  const setup = byName["gui-setup"].handler("", env.ctx({ hasUI: true, mode: "tui", ui: dialogs.ui }));
  await dialogs.opened();
  assert.ok(dialogs.calls[0][3]?.signal instanceof AbortSignal, "the picker is bound to the setup's signal");
  assert.throws(() => env.runtime.beginSetup("/gui-doctor"), /\/gui-setup is already running/, "registered before the dialog");
  await env.runtime.shutdown();
  assert.equal(dialogs.calls[0][3].signal.aborted, true);
  dialogs.answer(dialogs.calls[0][2][0]); // the user picks docker-linux after Pi shut down
  await setup;
  assert.match(messages.at(-1).content, /GUI setup cancelled.*nothing was changed/);
  assert.equal(env.spawner.children.length, 0, "no smoke-test container");
  assert.equal(existsSync(env.globalConfigPath), false, "nothing persisted");
});

test("Q6: /gui-cleanup cancels a setup whose backend picker is still open", async (t) => {
  const env = await fakeEnv(t, { verified: false });
  capture(t);
  const { byName, messages } = commands(env);
  const dialogs = delayedUi();
  const ctx = env.ctx({ hasUI: true, mode: "tui", ui: dialogs.ui });
  const setup = byName["gui-setup"].handler("", ctx);
  await dialogs.opened();
  await byName["gui-cleanup"].handler("", env.ctx({ hasUI: true, mode: "tui" }));
  assert.match(messages.at(-1).content, /cancelled the running \/gui-setup/);
  dialogs.answer(dialogs.calls[0][2][0]);
  await setup;
  assert.match(messages.at(-1).content, /GUI setup cancelled.*cancelled by \/gui-cleanup.*nothing was changed/);
  assert.equal(env.spawner.children.length, 0);
  assert.equal(existsSync(env.globalConfigPath), false);
});

test("Q7: --no-fix is report-only for .gitignore, with or without a UI", { skip: hasGit ? false : "git not installed" }, async (t) => {
  for (const hasUI of [false, true]) {
    const env = await gitEnv(t);
    const out = capture(t);
    const { byName, messages } = commands(env);
    await byName["gui-setup"].handler("docker-linux --project --no-fix", env.ctx(hasUI ? { hasUI: true, mode: "tui", answers: { confirm: true } } : {}));
    const report = hasUI ? messages[0].content : out.text();
    assert.match(report, /— verified/);
    assert.match(report, /Git does not ignore it.*--no-fix: \.gitignore was not changed/);
    assert.equal(await gitignore(env), undefined, `no write (hasUI ${hasUI})`);
    assert.deepEqual(prompts(env.uiCalls), [], `no prompt (hasUI ${hasUI})`);
  }
});

test("Q7: the .gitignore confirm uses the setup dialog adapter; a cancel while it is open writes nothing", { skip: hasGit ? false : "git not installed" }, async (t) => {
  const env = await gitEnv(t);
  capture(t);
  const { byName, messages } = commands(env);
  const dialogs = delayedUi();
  const setup = byName["gui-setup"].handler("docker-linux --project", env.ctx({ hasUI: true, mode: "tui", ui: dialogs.ui }));
  await dialogs.opened();
  assert.equal(dialogs.calls[0][0], "confirm");
  assert.match(dialogs.calls[0][1], /Keep \.pi\/gui\.local\.json out of Git\?/);
  assert.ok(dialogs.calls[0][3]?.signal instanceof AbortSignal, "bound to the setup's signal");
  env.runtime.cancelSetup("cancelled by /gui-cleanup");
  assert.equal(dialogs.calls[0][3].signal.aborted, true);
  dialogs.answer(true); // a late "yes"
  await setup;
  assert.match(messages[0].content, /cancelled: \.gitignore was not changed/);
  assert.equal(await gitignore(env), undefined);
});

test("Q3: --fix never writes through a .gitignore symlink (or into a special file); the report warns instead", { skip: hasGit ? false : "git not installed" }, async (t) => {
  const { mkdtemp, rm, symlink, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const outside = await mkdtemp(join(tmpdir(), "gui-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const target = join(outside, "victim");
  await writeFile(target, "keep\n");
  const cases = [
    ["symlink to an outside file", (p) => symlink(target, p)],
    ["dangling symlink", (p) => symlink(join(outside, "missing"), p)],
    ["directory", (p) => mkdir(p)],
  ];
  for (const [name, make] of cases) {
    const env = await gitEnv(t);
    await make(join(env.project, ".gitignore"));
    const out = capture(t);
    await commands(env).byName["gui-setup"].handler("docker-linux --project --fix", env.ctx());
    assert.match(out.text(), /warning: did not add \.pi\/gui\.local\.json to \.gitignore: .*(symbolic link|not a regular file)/, name);
    assert.equal(readFileSync(target, "utf8"), "keep\n", `${name}: the outside file is untouched`);
    assert.equal(existsSync(join(outside, "missing")), false, `${name}: nothing created through a dangling link`);
  }
});

test("Q3: addLocalConfigToGitignore appends through one no-follow descriptor and creates the file when missing", async (t) => {
  const { mkdtemp, rm, writeFile, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { addLocalConfigToGitignore, GitignoreRefusedError } = await import("../../../src/commands/gitignore.ts");
  const root = await mkdtemp(join(tmpdir(), "gui-ignore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await addLocalConfigToGitignore(root);
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), ".pi/gui.local.json\n");
  await writeFile(join(root, ".gitignore"), "dist");
  await addLocalConfigToGitignore(root);
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "dist\n.pi/gui.local.json\n");
  const other = join(root, "other");
  await writeFile(other, "x");
  await rm(join(root, ".gitignore"));
  await symlink(other, join(root, ".gitignore"));
  await assert.rejects(addLocalConfigToGitignore(root), GitignoreRefusedError);
  assert.equal(readFileSync(other, "utf8"), "x");
  // A FIFO neither blocks the command nor receives the line.
  await rm(join(root, ".gitignore"));
  try {
    execFileSync("mkfifo", [join(root, ".gitignore")]);
  } catch {
    return;
  }
  await assert.rejects(addLocalConfigToGitignore(root), (e) => e instanceof GitignoreRefusedError && /not a regular file/.test(e.message));
});

/** Holds the runtime's first config read until `release()`; later reads go straight through. */
function delayFirstConfigRead(runtime) {
  const original = runtime.config.bind(runtime);
  let release;
  const gate = new Promise((r) => (release = r));
  let entered;
  const reading = new Promise((r) => (entered = r));
  let first = true;
  runtime.config = async (root) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return original(root);
  };
  return { reading, release: () => release() };
}

test("P2: a command whose entry config read outlives a shutdown starts no setup, no session, and writes no config", async (t) => {
  // /gui-doctor: verified host; before the fix the late continuation re-ran every check and the smoke test and re-saved.
  const doctorEnv = await fakeEnv(t, { runtime: { shutdownWaitMs: 50 } });
  const out = capture(t);
  const delayed = delayFirstConfigRead(doctorEnv.runtime);
  process.exitCode = undefined;
  const doctor = commands(doctorEnv).byName["gui-doctor"].handler("docker-linux", doctorEnv.ctx());
  await delayed.reading;
  await doctorEnv.runtime.shutdown();
  delayed.release();
  await doctor;
  assert.match(out.text(), /\/gui-doctor: Pi is shutting down \(or restarted this extension\); run the command again/);
  assert.equal(doctorEnv.spawner.children.length, 0, "no smoke-test container");
  assert.equal(doctorEnv.runner.commands().filter((c) => c.startsWith("docker")).length, 0, "no check ran");
  assert.equal(JSON.parse(await readFile(doctorEnv.globalConfigPath, "utf8")).verified["docker-linux"].verifiedAt, VERIFIED.verifiedAt, "verified state untouched");
  // A command that starts after the shutdown belongs to the new generation and runs.
  doctorEnv.runtime.endSetup(doctorEnv.runtime.beginSetup("/gui-doctor", doctorEnv.runtime.signal));

  // /gui-setup --fix: nothing verified before; nothing may be saved after.
  const setupEnv = await fakeEnv(t, { verified: false, runtime: { shutdownWaitMs: 50 } });
  const setupDelay = delayFirstConfigRead(setupEnv.runtime);
  const setup = commands(setupEnv).byName["gui-setup"].handler("docker-linux --fix", setupEnv.ctx());
  await setupDelay.reading;
  await setupEnv.runtime.shutdown();
  setupDelay.release();
  await setup;
  assert.equal(setupEnv.spawner.children.length, 0);
  assert.equal(existsSync(setupEnv.globalConfigPath), false, "nothing persisted");

  // /gui-backend --project writes config: refused as well.
  const backendEnv = await fakeEnv(t, { runtime: { shutdownWaitMs: 50 } });
  const backendDelay = delayFirstConfigRead(backendEnv.runtime);
  const backend = commands(backendEnv).byName["gui-backend"].handler("docker-linux --project", backendEnv.ctx());
  await backendDelay.reading;
  await backendEnv.runtime.shutdown();
  backendDelay.release();
  await backend;
  assert.equal(existsSync(join(backendEnv.project, ".pi", "gui.local.json")), false, "no local config written");
});

test("P2: gui_launch whose verification read outlives a shutdown starts no session", async (t) => {
  const env = await fakeEnv(t, { runtime: { shutdownWaitMs: 50 } });
  const tools = Object.fromEntries(createGuiTools(env.runtime).map((x) => [x.name, x]));
  const delayed = delayFirstConfigRead(env.runtime);
  const launch = tools.gui_launch.execute("c", {}, undefined, undefined, env.ctx());
  await delayed.reading;
  await env.runtime.shutdown();
  delayed.release();
  await assert.rejects(launch, /Pi is shutting down; no new GUI session starts/);
  assert.equal(env.spawner.children.length, 0);
  assert.deepEqual(env.runtime.list(), []);
  assert.deepEqual(await readdir(env.tmp), []);
});

test("P3: /gui-cleanup stops live sessions and sweeps even when .pi/gui.json is malformed; the config error is a warning", async (t) => {
  const env = await fakeEnv(t);
  const tools = Object.fromEntries(createGuiTools(env.runtime).map((x) => [x.name, x]));
  const { byName, messages } = commands(env);
  const ctx = env.ctx({ hasUI: true, mode: "tui" });
  for (const args of ["--all", "docker-linux", ""]) {
    const { session } = (await tools.gui_launch.execute("c", {}, undefined, undefined, env.ctx())).details;
    assert.equal(env.state.containers.size, 1, `a live session before /gui-cleanup ${args}`);
    await writeFile(join(env.project, ".pi", "gui.json"), "{ not json");
    await byName["gui-cleanup"].handler(args, ctx);
    const report = messages.at(-1).content;
    // A broken config, or --all, cleans every backend; an explicit backend only that one.
    assert.match(report, args === "docker-linux" ? /GUI testing cleanup \(docker-linux\)/ : /GUI testing cleanup \(docker-linux, local-linux, remote-linux, remote-linux-docker, cua\)/, `/gui-cleanup ${args}`);
    assert.match(report, new RegExp(`stopped sessions: ${session}`));
    assert.match(report, /warning: could not read the GUI testing config \(.*gui\.json.*malformed JSON/);
    assert.match(report, /Footprint audit: empty/);
    assert.equal(env.state.containers.size, 0, "container removed");
    assert.deepEqual(env.runtime.list(), []);
    assert.deepEqual(await readdir(env.tmp), []);
    await writeFile(join(env.project, ".pi", "gui.json"), JSON.stringify({ launch: { cmd: "python3", args: ["app.py"] } }));
  }
  assert.match(messages.at(-1).content, /so every backend is cleaned/, "the default falls back to every implemented backend");
});
