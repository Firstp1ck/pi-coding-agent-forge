import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createAppRunnerService } from "../lib/server/app-runners.mjs";

const configName = ".pi-webui-runners.json";
const errorStatus = (code) => (error) => error.statusCode === code;

async function waitFor(probe, description, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await probe();
    if (result) return result;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${description}`);
}

async function fixture(t, { available = [process.execPath], commandResult, helper } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "webui-runner-service-"));
  const tab = { id: "runner-tab", title: "Runner fixture", cwd: root, appRunner: null };
  const tabs = new Map([[tab.id, tab]]);
  const probes = [];
  const updates = [];
  const events = [];
  const deliveries = [];
  const service = createAppRunnerService({
    defaultCwd: root,
    runCommand: async (command, args, options) => {
      probes.push({ command, args, options });
      if (commandResult) return commandResult(command, args, options);
      return available.includes(command)
        ? { exitCode: 0, stdout: "fixture version", stderr: "" }
        : { exitCode: 127, stdout: "", stderr: "", error: "not available" };
    },
    resolveCwd: async (value, base) => {
      const target = path.resolve(base, value);
      assert.equal((await stat(target)).isDirectory(), true);
      return target;
    },
    normalizeSuggestionPath: (value) => String(value || "").replace(/\\/g, "/"),
    readJsonFileIfExists: async (file) => {
      try {
        return JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
    },
    makeHttpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    formatCliError: (error) => error.message || String(error),
    sanitizeError: (error) => error.message || String(error),
    displayPath: (value) => value,
    stripAnsi: stripVTControlCharacters,
    hasTab: (id) => tabs.has(id),
    broadcastTabEvent: (target, event) => updates.push({ target, event, at: Date.now() }),
    tabActivitySnapshot: (target) => ({ tab: target.id, fixture: true }),
    recordEvent: (event) => events.push(event),
    sendWebuiHelperCommand: async (target, command, payload) => {
      deliveries.push({ target, command, payload });
      return helper ? helper(target, command, payload) : { delivery: "context" };
    },
  });
  await writeFile(path.join(root, configName), JSON.stringify({ version: 2, searchPaths: [], runners: [] }));
  t.after(async () => {
    service.stopAppRunnerForTab(tab, "fixture cleanup", { force: true });
    if (tab.appRunner?.status === "running") {
      await waitFor(() => tab.appRunner.status !== "running", "fixture process cleanup");
    }
    clearTimeout(tab.appRunnerBroadcastTimer);
    clearTimeout(tab.appRunner?.stopTimer);
    await rm(root, { recursive: true, force: true });
  });
  return { root, tab, tabs, service, probes, updates, events, deliveries };
}

function pipeMode(t) {
  const previous = process.env.PI_WEBUI_APP_RUNNER_PTY;
  process.env.PI_WEBUI_APP_RUNNER_PTY = "off";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEBUI_APP_RUNNER_PTY;
    else process.env.PI_WEBUI_APP_RUNNER_PTY = previous;
  });
}

async function addNodeRunner(f, code, { id = "fixture", args = [] } = {}) {
  const file = `${id}.mjs`;
  await writeFile(path.join(f.root, file), code);
  const data = await f.service.saveCustomAppRunner(f.tab, {
    id, label: id, command: process.execPath, path: file, args,
  });
  return data.runners.find((runner) => runner.id === `custom:${id}`);
}

function output(f) {
  const run = f.service.publicAppRunnerState(f.tab.appRunner);
  return [...(run?.lines || []), run?.pendingLine || ""].join("\n");
}

test("factory exposes the fixed interface and imports without starting a server", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys(f.service).sort(), [
    "getAppRunnerData", "getCustomAppRunnerConfigData", "saveCustomAppRunner",
    "saveAppRunnerSearchPaths", "deleteCustomAppRunner", "getAppRunnerFileBrowserData",
    "startAppRunner", "sendAppRunnerInput", "transferAppRunnerContext",
    "stopAppRunnerForTab", "clearAppRunnerForTab", "publicAppRunnerState",
  ].sort());
  assert.deepEqual(f.probes, []);
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.events, []);
  assert.equal(f.service.publicAppRunnerState(null), null);
  assert.equal(f.tab.appRunner, null);
});

test("discovery preserves language candidates, manager preference, deduplication and bounded probes", async (t) => {
  const commands = ["bun", "pnpm", "npm", "yarn", "npx", "cargo", "go", "zig", "uv", "python3", "bash", "sh", "cc", "c++", "cmake", "docker", "docker-compose", "deno", "just", "make"];
  const f = await fixture(t, { available: commands });
  const files = {
    "package.json": JSON.stringify({ scripts: { dev: "vite", start: "node index.js" }, packageManager: "pnpm@10", dependencies: { vite: "*", storybook: "*", "@storybook/react": "*" } }),
    "pnpm-lock.yaml": "", "Cargo.toml": "", "main.go": "", "main.py": "",
    "build.zig": 'b.step("run", "Run");', "main.zig": "",
    "CMakeLists.txt": "add_executable(my-app main.cpp)", "compose.yaml": "services: {}",
    "dev.sh": "echo fixture", "deno.json": '{\n  "tasks": {\n    "dev": "deno run main.ts"\n  }\n}',
    "justfile": "dev:\n  echo fixture", "Makefile": "run:\n\techo fixture",
  };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(f.root, name), content);
  const data = await f.service.getAppRunnerData(f.tab);
  const ids = data.runners.map((runner) => runner.id);
  assert.equal(ids[0], "rust:cargo-run");
  for (const id of ["pkg:pnpm:dev", "pkg:npm:dev", "npx:vite", "go:.", "zig:build-run", "deno:dev", "just:dev", "make:run", "shell:bash:dev.sh"]) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.ok(ids.indexOf("pkg:pnpm:dev") < ids.indexOf("pkg:npm:dev"));
  assert.equal(data.runners.filter((runner) => runner.displayCommand === "npx --no-install storybook dev").length, 1);
  assert.deepEqual(data.runners.find((runner) => runner.id === "pkg:pnpm:dev").args, ["run", "dev"]);
  assert.ok(data.runners.every((runner) => !("priority" in runner)));
  const firstProbeCount = f.probes.filter((probe) => probe.args[0] === "--version").length;
  await f.service.getAppRunnerData(f.tab);
  assert.equal(f.probes.filter((probe) => probe.args[0] === "--version").length, firstProbeCount);
  for (const probe of f.probes) {
    assert.equal(probe.options.timeoutMs, 1_200);
    assert.equal(probe.options.maxOutputLength, 2_000);
    assert.equal(probe.options.cwd, f.root);
  }
});

test("availability accepts version stderr and isolates caches by factory", async (t) => {
  const f = await fixture(t, {
    commandResult: (command) => command === "node"
      ? { exitCode: 1, stdout: "", stderr: "node fixture version" }
      : { exitCode: 127, error: "unavailable" },
  });
  await writeFile(path.join(f.root, "main.js"), "");
  assert.ok((await f.service.getAppRunnerData(f.tab)).runners.some((runner) => runner.id === "node:main.js"));
  const g = await fixture(t, { available: [] });
  await writeFile(path.join(g.root, "main.js"), "");
  assert.deepEqual((await g.service.getAppRunnerData(g.tab)).runners, []);
  assert.ok(g.probes.some((probe) => probe.command === "node"));
});

test("v2 config writes, ancestor discovery, command arguments, deletion and file picker remain compatible", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "nested"));
  await mkdir(path.join(f.root, ".git"));
  await writeFile(path.join(f.root, "a.txt"), "text");
  await writeFile(path.join(f.root, ".hidden"), "private");
  await writeFile(path.join(f.root, "entry.mjs"), "");
  f.tab.cwd = path.join(f.root, "nested");
  const data = await f.service.saveCustomAppRunner(f.tab, {
    id: "example", label: "Example", command: `${process.execPath} --no-warnings`, path: "entry.mjs", args: ["two words", "--flag"],
  });
  const runner = data.runners.find((item) => item.id === "custom:example");
  assert.equal(runner.cwd, f.root);
  assert.deepEqual(runner.args, ["--no-warnings", "entry.mjs", "two words", "--flag"]);
  assert.match(runner.displayCommand, /"two words"/);
  const saved = JSON.parse(await readFile(path.join(f.root, configName), "utf8"));
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.searchPaths, []);
  assert.deepEqual(saved.runners[0].args, ["two words", "--flag"]);
  if (process.platform !== "win32") assert.equal((await stat(path.join(f.root, configName))).mode & 0o777, 0o600);
  const config = await f.service.getCustomAppRunnerConfigData();
  assert.equal(config.projectRoot, f.root);
  assert.equal(config.relativeConfigFile, configName);
  assert.equal(config.runners[0].available, true);
  const browser = await f.service.getAppRunnerFileBrowserData(f.tab, "");
  assert.equal(browser.parent, null);
  assert.deepEqual(browser.directories.map((item) => item.name), ["nested"]);
  assert.ok(browser.files.some((item) => item.name === ".hidden" && item.hidden));
  const nested = await f.service.getAppRunnerFileBrowserData(f.tab, "nested");
  assert.equal(nested.parent, "");
  assert.equal(nested.relativeDir, "nested");
  const deleted = await f.service.deleteCustomAppRunner(f.tab, "custom:example");
  assert.deepEqual(deleted.customRunnerConfig.runners, []);
  await assert.rejects(f.service.deleteCustomAppRunner(f.tab, "example"), errorStatus(404));
});

test("runner path validation and config limits reject invalid writes without replacing saved configuration", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "entry.mjs"), "");
  const initial = await readFile(path.join(f.root, configName), "utf8");
  const invalid = [
    { path: "../entry.mjs" }, { path: "/entry.mjs" }, { path: "C:/entry.mjs" },
    { path: "entry.mjs", command: "node\n--help" },
    { path: "entry.mjs", args: ["bad\0arg"] },
    { path: "entry.mjs", args: Array(33).fill("arg") },
    { path: "missing.mjs" },
  ];
  for (const runner of invalid) {
    await assert.rejects(f.service.saveCustomAppRunner(f.tab, { command: process.execPath, ...runner }), errorStatus(400));
    assert.equal(await readFile(path.join(f.root, configName), "utf8"), initial);
  }
  for (const paths of [[".."], [".".repeat(4)], ["/tmp"], ["a/../b"], ["bad\0path"], ["missing"], [".", "."], Array(25).fill(".")]) {
    await assert.rejects(f.service.saveAppRunnerSearchPaths(f.tab, paths), errorStatus(400));
  }
  await assert.rejects(f.service.getAppRunnerFileBrowserData(f.tab, "../"), errorStatus(400));
  await assert.rejects(f.service.getAppRunnerFileBrowserData(f.tab, "entry.mjs"), errorStatus(400));
});

test("legacy config reads and malformed collection diagnostics retain strict write refusal", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "entry.mjs"), "");
  await writeFile(path.join(f.root, configName), JSON.stringify({ version: 1, runners: [{ id: "legacy", command: process.execPath, path: "entry.mjs" }] }));
  const legacy = await f.service.getCustomAppRunnerConfigData(f.tab);
  assert.equal(legacy.version, 2);
  assert.deepEqual(legacy.searchPaths, []);
  assert.equal(legacy.runners[0].available, true);
  await f.service.saveAppRunnerSearchPaths(f.tab, ["."]);
  const migrated = JSON.parse(await readFile(path.join(f.root, configName), "utf8"));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.runners[0].id, "legacy");
  const malformed = JSON.stringify({ version: 2, runners: {}, searchPaths: {} });
  await writeFile(path.join(f.root, configName), malformed);
  const diagnosed = await f.service.getCustomAppRunnerConfigData(f.tab);
  assert.deepEqual(diagnosed.runners, []);
  assert.equal(diagnosed.diagnostics.length, 2);
  assert.ok(diagnosed.diagnostics.every((entry) => entry.severity === "error"));
  await assert.rejects(f.service.saveAppRunnerSearchPaths(f.tab, []), errorStatus(400));
  await assert.rejects(f.service.saveCustomAppRunner(f.tab, { command: process.execPath, path: "entry.mjs" }), errorStatus(400));
  assert.equal(await readFile(path.join(f.root, configName), "utf8"), malformed);
});

test("configured discovery canonicalizes paths and excludes files and directories escaping through symlinks", { skip: process.platform === "win32" ? "POSIX symlink fixture; Windows junction/permission coverage belongs to parent" : false }, async (t) => {
  const f = await fixture(t, { available: [process.execPath, "bash", "python3"] });
  const outside = await mkdtemp(path.join(tmpdir(), "webui-runner-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(f.root, "tools"));
  await writeFile(path.join(f.root, "tools", "task.py"), "print('fixture')");
  await writeFile(path.join(f.root, "tools", "dev.sh"), "echo fixture");
  await writeFile(path.join(outside, "external.py"), "print('outside')");
  await symlink(outside, path.join(f.root, "external-dir"), "dir");
  await symlink(path.join(outside, "external.py"), path.join(f.root, "tools", "external.py"));
  await symlink(path.join(f.root, "tools", "task.py"), path.join(f.root, "tools", "internal.py"));
  const data = await f.service.saveAppRunnerSearchPaths(f.tab, ["./tools/"]);
  assert.deepEqual(data.customRunnerConfig.searchPaths, ["tools"]);
  assert.ok(data.runners.some((runner) => runner.projectFile === "tools/task.py" && runner.cwd === f.root));
  assert.ok(data.runners.some((runner) => runner.projectFile === "tools/internal.py"));
  assert.ok(data.runners.some((runner) => runner.projectFile === "tools/dev.sh"));
  assert.ok(data.runners.every((runner) => runner.projectFile !== "tools/external.py"));
  await assert.rejects(f.service.saveAppRunnerSearchPaths(f.tab, ["external-dir"]), /outside the project root/);
  await assert.rejects(f.service.saveCustomAppRunner(f.tab, { command: process.execPath, path: "tools/external.py" }), /outside the project root/);
  // The runner picker retains its independent lexical browsing policy.
  const browser = await f.service.getAppRunnerFileBrowserData(f.tab, "external-dir");
  assert.ok(browser.files.some((entry) => entry.name === "external.py"));
  await writeFile(path.join(f.root, configName), JSON.stringify({ version: 2, searchPaths: ["external-dir", "tools", "tools", "missing"], runners: [] }));
  const diagnosed = await f.service.getAppRunnerData(f.tab);
  assert.ok(diagnosed.customRunnerConfig.diagnostics.some((entry) => /outside/.test(entry.message)));
  assert.ok(diagnosed.customRunnerConfig.diagnostics.some((entry) => /Duplicate/.test(entry.message)));
  assert.ok(diagnosed.customRunnerConfig.diagnostics.some((entry) => /does not exist/.test(entry.message)));
  assert.ok(diagnosed.runners.every((runner) => !runner.projectFile.startsWith("external-dir/")));
});

test("pipe process preserves partial terminal output, stdin validation, EOF, state snapshots and context delivery", async (t) => {
  pipeMode(t);
  const f = await fixture(t, { helper: async () => ({ delivery: "followUp" }) });
  const runner = await addNodeRunner(f, `
process.stdout.write('old progress\\rready');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => process.stdout.write('\\necho:' + chunk));
process.stdin.on('end', () => { process.stdout.write('\\nEOF\\n'); });
`);
  const started = await f.service.startAppRunner(f.tab, runner.id);
  assert.equal(started.activeRun.status, "running");
  assert.equal(started.activeRun.executionMode, "pipe");
  assert.equal(started.cwd, f.root);
  await waitFor(() => output(f).includes("ready"), "partial stdout");
  assert.equal(f.service.publicAppRunnerState(f.tab.appRunner).pendingLine, "ready");
  assert.ok(!output(f).includes("old progress"));
  await assert.rejects(f.service.startAppRunner(f.tab, runner.id), errorStatus(409));
  assert.equal(f.service.clearAppRunnerForTab(f.tab), false);
  assert.throws(() => f.service.sendAppRunnerInput(f.tab, "bad\0input"), errorStatus(400));
  assert.throws(() => f.service.sendAppRunnerInput(f.tab, "x".repeat(16_001)), errorStatus(413));
  assert.throws(() => f.service.sendAppRunnerInput(f.tab, "", { appendNewline: false }), errorStatus(400));
  const accepted = f.service.sendAppRunnerInput(f.tab, "hello");
  assert.equal(typeof accepted.inputBuffered, "boolean");
  await waitFor(() => output(f).includes("echo:hello"), "stdin echo");
  const context = await f.service.transferAppRunnerContext(f.tab, { lineCount: 2 });
  assert.equal(context.delivery, "followUp");
  assert.equal(context.requestedLineCount, 2);
  assert.equal(context.lineCount, 2);
  assert.equal(f.deliveries[0].target, f.tab);
  assert.equal(f.deliveries[0].command, "app-runner-context");
  assert.match(f.deliveries[0].payload.content, /Command:.*fixture.mjs/);
  assert.match(f.deliveries[0].payload.content, /echo:hello/);
  assert.ok(f.events.some((event) => event.type === "webui_app_runner_stdin" && event.chars === 5));
  const snapshot = f.service.publicAppRunnerState(f.tab.appRunner);
  snapshot.lines.push("caller mutation");
  assert.ok(!f.tab.appRunner.lines.includes("caller mutation"));
  assert.ok(!("child" in snapshot));
  const closed = f.service.sendAppRunnerInput(f.tab, "", { appendNewline: false, closeStdin: true });
  assert.equal(closed.activeRun.stdinClosed, true);
  assert.throws(() => f.service.sendAppRunnerInput(f.tab, "late"), errorStatus(409));
  await waitFor(() => f.tab.appRunner.status !== "running", "EOF process exit");
  assert.equal(f.tab.appRunner.status, "done");
  assert.equal(f.tab.appRunner.child, null);
  assert.equal(f.tab.appRunner.stdinClosed, true);
  assert.equal(f.tab.appRunner.stdinWrites, 2);
  assert.equal(f.tab.appRunnerBroadcastTimer, null);
  assert.match(output(f), /EOF/);
  assert.equal(f.events.filter((event) => event.type === "webui_app_runner_exit").length, 1);
  assert.equal(f.service.stopAppRunnerForTab(f.tab), false);
  assert.equal(f.service.clearAppRunnerForTab(f.tab), true);
  assert.equal(f.updates.at(-1).event.activeRun, null);
  await assert.rejects(f.service.transferAppRunnerContext(f.tab), errorStatus(409));
});

test("stdin accepts the 16k boundary without a newline and records real broken-pipe errors", { skip: process.platform === "win32" ? "POSIX closed-fd pipe error fixture; Windows stdin error delivery requires its own fixture" : false }, async (t) => {
  pipeMode(t);
  const f = await fixture(t);
  const runner = await addNodeRunner(f, `
let received = 0;
process.stdin.on('data', (chunk) => { received += chunk.length; process.stdout.write('received=' + received + '\\n'); });
`);
  await f.service.startAppRunner(f.tab, runner.id);
  const sent = f.service.sendAppRunnerInput(f.tab, "x".repeat(16_000), { appendNewline: false });
  assert.equal(sent.activeRun.stdinWrites, 1);
  await waitFor(() => output(f).includes("received=16000"), "16k input without newline");
  f.service.sendAppRunnerInput(f.tab, "", { appendNewline: false, closeStdin: true });
  await waitFor(() => f.tab.appRunner.status !== "running", "16k process EOF");
  const broken = await addNodeRunner(f, `
import { closeSync } from 'node:fs';
closeSync(0);
console.log('closed-reader');
setInterval(() => {}, 1000);
`, { id: "broken-pipe" });
  await f.service.startAppRunner(f.tab, broken.id);
  await waitFor(() => output(f).includes("closed-reader"), "closed child stdin");
  f.service.sendAppRunnerInput(f.tab, "pipe-error");
  await waitFor(() => f.tab.appRunner.stdinClosed && f.tab.appRunner.stdinError, "stdin write error");
  assert.equal(f.tab.appRunner.status, "running");
  assert.match(f.tab.appRunner.stdinError, /EPIPE/);
  assert.throws(() => f.service.sendAppRunnerInput(f.tab, "later"), errorStatus(409));
});

test("short output retains exactly 1000 lines while preserving the total produced count", async (t) => {
  pipeMode(t);
  const f = await fixture(t);
  const runner = await addNodeRunner(f, `
process.stdout.write(Array.from({ length: 1100 }, (_, i) => 'short-' + i).join('\\n') + '\\n', () => setTimeout(() => process.exit(0), 50));
`);
  await f.service.startAppRunner(f.tab, runner.id);
  await waitFor(() => f.tab.appRunner.status !== "running", "line-bounded output exit");
  const state = f.service.publicAppRunnerState(f.tab.appRunner);
  assert.equal(state.lines.length, 1000);
  assert.equal(state.lineCount, 1102);
  assert.equal(state.truncated, true);
  assert.equal(state.lines[0], "short-101");
  assert.match(state.lines.at(-1), /^# exit 0/);
});

test("output history obeys line and character bounds and context caps without leaking ANSI escapes", async (t) => {
  pipeMode(t);
  const f = await fixture(t);
  const runner = await addNodeRunner(f, `
const lines = Array.from({ length: 1200 }, (_, i) => 'line-' + i + '-' + 'x'.repeat(250));
process.stdout.write(lines.join('\\n') + '\\n\\x1b[31mLAST\\x1b[0m\\n', () => setTimeout(() => process.exit(0), 50));
`);
  await f.service.startAppRunner(f.tab, runner.id);
  await waitFor(() => f.tab.appRunner.status !== "running", "bounded output process exit");
  const state = f.service.publicAppRunnerState(f.tab.appRunner);
  assert.equal(state.status, "done");
  assert.equal(state.truncated, true);
  assert.ok(state.lineCount >= 1203);
  assert.ok(state.lines.length <= 1000);
  assert.ok(state.lines.reduce((sum, line) => sum + line.length + 1, 0) <= 240_000);
  assert.ok(!state.lines.includes("line-0-" + "x".repeat(250)));
  const context = await f.service.transferAppRunnerContext(f.tab, { count: 99_999 });
  assert.equal(context.requestedLineCount, 1000);
  assert.equal(context.truncated, true);
  assert.ok(!f.deliveries[0].payload.content.includes("\x1b"));
  assert.match(f.deliveries[0].payload.content, /earlier app runner output had already been truncated/);
  const last = await f.service.transferAppRunnerContext(f.tab, { lines: 0 });
  assert.equal(last.requestedLineCount, 1);
  const defaults = await f.service.transferAppRunnerContext(f.tab);
  assert.equal(defaults.requestedLineCount, 80);
});

test("stream bursts coalesce at the existing cadence and removed tabs suppress scheduled updates", async (t) => {
  pipeMode(t);
  const f = await fixture(t);
  const runner = await addNodeRunner(f, `
process.stdout.write('ready\\n');
process.stdin.once('data', () => {
  for (let i = 0; i < 40; i++) process.stdout.write('burst-' + i + '\\n');
});
setInterval(() => {}, 1000);
`);
  await f.service.startAppRunner(f.tab, runner.id);
  await waitFor(() => output(f).includes("ready"), "burst fixture readiness");
  await waitFor(() => f.tab.appRunnerBroadcastTimer === null, "initial output broadcast");
  const before = f.updates.length;
  const sentAt = Date.now();
  f.service.sendAppRunnerInput(f.tab, "go");
  await waitFor(() => output(f).includes("burst-39"), "burst output");
  await waitFor(() => f.updates.length > before, "coalesced broadcast");
  assert.equal(f.updates.length, before + 1);
  assert.ok(f.updates.at(-1).at - sentAt >= 100);
  assert.equal(f.updates.at(-1).event.type, "webui_app_runner_update");
  assert.deepEqual(f.updates.at(-1).event.tabActivity, { tab: f.tab.id, fixture: true });
  f.tabs.delete(f.tab.id);
  const retiredCount = f.updates.length;
  f.service.sendAppRunnerInput(f.tab, "retired");
  await waitFor(() => f.tab.appRunnerBroadcastTimer === null, "retired tab timer cleanup");
  assert.equal(f.updates.length, retiredCount);
});

test("spawn errors and nonzero process exits settle once and preserve the public failure contract", async (t) => {
  pipeMode(t);
  const f = await fixture(t, { available: [process.execPath, "missing-webui-fixture-command"] });
  await writeFile(path.join(f.root, "entry.mjs"), "");
  const data = await f.service.saveCustomAppRunner(f.tab, { id: "missing", command: "missing-webui-fixture-command", path: "entry.mjs" });
  await f.service.startAppRunner(f.tab, data.runners.find((runner) => runner.custom).id);
  await waitFor(() => f.tab.appRunner.status !== "running", "spawn error settlement");
  assert.equal(f.tab.appRunner.status, "error");
  assert.match(output(f), /ENOENT/);
  assert.equal(f.tab.appRunner.child, null);
  assert.equal(f.events.filter((event) => event.type === "webui_app_runner_exit").length, 1);
  const runner = await addNodeRunner(f, "process.stderr.write('failed fixture\\n'); process.exitCode = 7;", { id: "nonzero" });
  await f.service.startAppRunner(f.tab, runner.id);
  await waitFor(() => f.tab.appRunner.status !== "running", "nonzero exit");
  assert.equal(f.tab.appRunner.status, "failed");
  assert.equal(f.tab.appRunner.exitCode, 7);
  assert.match(output(f), /failed fixture/);
  assert.match(output(f), /exit 7/);
  await assert.rejects(f.service.startAppRunner(f.tab, "unknown"), errorStatus(400));
});

test("context errors propagate without recording success or changing runner state", async (t) => {
  const f = await fixture(t, { helper: async () => { throw new Error("helper unavailable"); } });
  f.tab.appRunner = { id: "record", status: "done", lines: ["\x1b[31m\x1b[0m"], displayCommand: "fixture", cwd: f.root };
  await assert.rejects(f.service.transferAppRunnerContext(f.tab), errorStatus(400));
  f.tab.appRunner.lines = ["captured text"];
  await assert.rejects(f.service.transferAppRunnerContext(f.tab), /helper unavailable/);
  assert.equal(f.events.length, 0);
  assert.equal(f.tab.appRunner.status, "done");
});

test("graceful stop signals the complete POSIX process group and cleans tab-owned timers", { skip: process.platform === "win32" ? "POSIX signal group contract; Windows process-tree/ConPTY coverage belongs to parent" : false }, async (t) => {
  pipeMode(t);
  const f = await fixture(t);
  await writeFile(path.join(f.root, "descendant.mjs"), `
import { writeFileSync } from 'node:fs';
process.on('SIGINT', () => { writeFileSync('descendant-stopped', 'SIGINT'); process.exit(0); });
process.stdout.write('descendant-ready\\n');
setInterval(() => {}, 1000);
`);
  const runner = await addNodeRunner(f, `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['descendant.mjs'], { stdio: ['ignore', 'inherit', 'inherit'] });
process.on('SIGINT', () => {});
child.on('exit', () => process.exit(0));
setInterval(() => {}, 1000);
`);
  await f.service.startAppRunner(f.tab, runner.id);
  await waitFor(() => output(f).includes("descendant-ready"), "descendant signal handler");
  assert.equal(f.service.stopAppRunnerForTab(f.tab, "test stop"), true);
  assert.equal(f.service.publicAppRunnerState(f.tab.appRunner).stopping, true);
  await waitFor(() => f.tab.appRunner.status !== "running", "process group stop");
  assert.equal(await readFile(path.join(f.root, "descendant-stopped"), "utf8"), "SIGINT");
  assert.match(output(f), /test stop; sending Ctrl\+C/);
  assert.equal(f.tab.appRunner.stopping, false);
  assert.equal(f.tab.appRunner.stdinClosed, true);
  assert.equal(f.tab.appRunnerBroadcastTimer, null);
  assert.equal(f.tab.appRunner.settled, true);
});

test("unresponsive POSIX runners are force-stopped after the 2.5 second grace period", { skip: process.platform === "win32" ? "Windows pipe stop immediately terminates the process tree" : false }, async (t) => {
  pipeMode(t);
  const f = await fixture(t);
  const runner = await addNodeRunner(f, "process.on('SIGINT', () => {}); console.log('ready'); setInterval(() => {}, 1000);");
  await f.service.startAppRunner(f.tab, runner.id);
  await waitFor(() => output(f).includes("ready"), "signal-resistant runner");
  const stoppedAt = Date.now();
  f.service.stopAppRunnerForTab(f.tab);
  await waitFor(() => f.tab.appRunner.status !== "running", "stop grace escalation");
  assert.ok(Date.now() - stoppedAt >= 2_400);
  assert.equal(f.tab.appRunner.signal, "SIGKILL");
  assert.match(output(f), /forcing process-tree termination/);
  assert.equal(f.tab.appRunner.child, null);
});

const scriptProbe = process.platform === "win32" ? null : spawnSync("script", ["--version"], { encoding: "utf8", timeout: 1_200 });
const scriptAvailable = scriptProbe && !scriptProbe.error && /util-linux/i.test(`${scriptProbe.stdout}\n${scriptProbe.stderr}`);

test("util-linux script PTY preserves interactive input and Ctrl+C stop", { skip: scriptAvailable ? false : "util-linux script PTY unavailable on this platform" }, async (t) => {
  const previous = process.env.PI_WEBUI_APP_RUNNER_PTY;
  delete process.env.PI_WEBUI_APP_RUNNER_PTY;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEBUI_APP_RUNNER_PTY;
    else process.env.PI_WEBUI_APP_RUNNER_PTY = previous;
  });
  const f = await fixture(t, {
    commandResult: (command) => command === "script"
      ? { exitCode: scriptProbe.status, stdout: scriptProbe.stdout, stderr: scriptProbe.stderr }
      : command === process.execPath ? { exitCode: 0, stdout: "fixture version" } : { exitCode: 127, error: "unavailable" },
  });
  const runner = await addNodeRunner(f, `
process.stdout.write('tty=' + Boolean(process.stdin.isTTY) + '\\n');
process.stdin.on('data', (chunk) => process.stdout.write('pty-input:' + chunk));
setInterval(() => {}, 1000);
`);
  await f.service.startAppRunner(f.tab, runner.id);
  assert.equal(f.tab.appRunner.executionMode, "pty");
  await waitFor(() => output(f).includes("tty=true"), "PTY initialization");
  f.service.sendAppRunnerInput(f.tab, "interactive");
  await waitFor(() => output(f).includes("pty-input:interactive"), "PTY stdin");
  f.service.stopAppRunnerForTab(f.tab);
  await waitFor(() => f.tab.appRunner.status !== "running", "PTY Ctrl+C stop");
  assert.equal(f.tab.appRunner.stdinClosed, true);
  assert.equal(f.tab.appRunner.child, null);
  assert.equal(f.probes.filter((probe) => probe.command === "script").length, 1);
});
