import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { takeValue, tokenizeArgs } from "../../pi-utils/src/cli.ts";

const extensionUrl = new URL("../index.ts", import.meta.url);
const source = await readFile(extensionUrl, "utf8");
// Evaluate the actual extension without loading integrations or spawning a server.
const executable = stripTypeScriptTypes(source)
  .replace(/^import\b[\s\S]*?from "[^"]+";\s*/gm, "")
  .replaceAll("import.meta.url", JSON.stringify(extensionUrl.href))
  .replace("export default function (", "function registerExtension(");
const plain = (value) => JSON.parse(JSON.stringify(value));
const launcher = fileURLToPath(new URL("../bin/pi-webui-launcher.mjs", import.meta.url));
const contextCwd = "/fixture/current-project";
const baseArgs = [launcher, "--host", "127.0.0.1", "--port", "31415"];

function harness({ env = {}, fetchJson = async () => ({ ok: false, status: 404 }) } = {}) {
  const launches = [];
  const restores = [];
  const notifications = [];
  const statuses = [];
  const commands = new Map();
  const processEnv = { PI_CODING_AGENT_DIR: "/fixture/agent", ...env };
  const api = vm.runInNewContext(`${executable}\n({ parseStartWebuiArgs, startWebui, usage, registerExtension });`, {
    path, fileURLToPath, tokenizeArgs, takeValue, setTimeout, clearTimeout,
    homedir: () => "/fixture/home",
    process: { env: processEnv, execPath: process.execPath, platform: process.platform },
    spawn(command, args, options) {
      launches.push(plain({ command, args, options }));
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.stdout.emit("data", "Pi Web UI: http://127.0.0.1:31415/\n"));
      return child;
    },
    releaseStartedChild: () => {},
    terminateFailedChild: () => assert.fail("fixture child should start successfully"),
    fetchJsonWithTimeoutBase: fetchJson,
    registerSubagentGate: () => ({ dispose() {} }),
    createRestoreFile: async (agentDir, tabs) => {
      restores.push(plain({ agentDir, tabs }));
      return { file: "/fixture/private-restore.json" };
    },
  }, { filename: "index.ts" });
  api.registerExtension({
    on() {},
    registerCommand: (name, command) => commands.set(name, command),
  });
  const ctx = {
    cwd: contextCwd,
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (name, value) => statuses.push({ name, value }),
    },
  };
  return { ...api, launches, restores, notifications, statuses, ctx, processEnv,
    run: (args) => commands.get("webui-start").handler(args, ctx) };
}

test("default parser leaves the startup project unspecified and preserves session persistence", () => {
  const h = harness();
  assert.deepEqual(plain(h.parseStartWebuiArgs("")), {
    host: "127.0.0.1", port: 31415, open: true, noSession: false, remoteAuth: false, piArgs: [],
  });
  assert.match(h.usage(), /\[--cwd PATH\]/);
  assert.match(h.usage(), /Starts empty unless tabs are restored or --cwd PATH selects a project/);
});

test("explicit cwd supports absolute, relative and quoted paths without consuming Pi arguments", () => {
  const h = harness();
  for (const [input, expected] of [
    ["--cwd /projects/app", "/projects/app"],
    ["--cwd ../other-project", "../other-project"],
    ['--cwd "./project with spaces"', "./project with spaces"],
    ["--cwd '~/project with spaces'", "~/project with spaces"],
  ]) {
    const parsed = h.parseStartWebuiArgs(`${input} -- --cwd /pi-owned --model provider/model`);
    assert.equal(parsed.cwd, expected);
    assert.deepEqual(plain(parsed.piArgs), ["--cwd", "/pi-owned", "--model", "provider/model"]);
  }
  const piOnly = h.parseStartWebuiArgs("-- --cwd /pi-owned");
  assert.equal(piOnly.cwd, undefined);
});

test("cwd requires a value and existing option validation remains effective", () => {
  const h = harness();
  for (const args of ["--cwd", "--cwd --no-open", '--cwd ""']) {
    assert.throws(() => h.parseStartWebuiArgs(args), /--cwd requires a value/);
  }
  assert.throws(() => h.parseStartWebuiArgs('--cwd "unfinished'), /Unclosed/);
  assert.throws(() => h.parseStartWebuiArgs("--unknown"), /Unknown option/);
  assert.throws(() => h.parseStartWebuiArgs("--output-mode invalid"), /normal or compact-v1/);
  assert.throws(() => h.parseStartWebuiArgs("--port 65536"), /between 1 and 65535/);
});

test("default launch omits cwd and no-session flags while retaining spawn cwd and inherited environment", async () => {
  const h = harness({ env: {
    PI_WEBUI_OUTPUT_MODE: "compact-v1", PI_WEBUI_REMOTE_AUTH: "1", PI_WEBUI_RPC_SUPERVISOR: "0",
    PI_WEBUI_RESTORE_FILE: "/fixture/inherited-restore.json", FIXTURE_SETTING: "retained",
  } });
  assert.equal(await h.startWebui(h.parseStartWebuiArgs(""), h.ctx), "http://127.0.0.1:31415/");
  assert.deepEqual(h.launches, [{
    command: process.execPath,
    args: baseArgs,
    options: { cwd: contextCwd, env: h.processEnv, detached: true,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  }]);
  assert.deepEqual(h.restores, []);
});

test("named options and explicit project forward before the untouched Pi argument tail", async () => {
  const h = harness();
  const options = h.parseStartWebuiArgs('32100 --port 32101 --host ::1 --cwd "../selected project" --no-open --no-session --remote-auth --output-mode compact-v1 --name "Review project" -- --model provider/model --thinking high');
  assert.equal(options.open, false);
  await h.startWebui(options, h.ctx);
  assert.deepEqual(h.launches[0].args, [
    launcher, "--host", "::1", "--port", "32101", "--cwd", "../selected project",
    "--no-session", "--remote-auth", "--output-mode", "compact-v1", "--name", "Review project",
    "--", "--model", "provider/model", "--thinking", "high",
  ]);
  assert.equal(h.launches[0].options.cwd, contextCwd);
  assert.equal(h.parseStartWebuiArgs("--remote-auth --no-remote-auth").remoteAuth, false);
  assert.equal(h.parseStartWebuiArgs("--output-mode normal").outputMode, "normal");
});

test("restore descriptors use a private file with or without an explicit project", async () => {
  const tabs = [{ id: "tab-7", index: 7, title: "Existing", cwd: "/fixture/restored-project",
    sessionFile: "/fixture/session.jsonl", conversationStarted: true }];
  for (const args of ["", "--cwd /fixture/selected-project"]) {
    const h = harness({ env: { PI_WEBUI_RESTORE_FILE: "/fixture/stale-restore.json" } });
    await h.startWebui(h.parseStartWebuiArgs(args), h.ctx, tabs);
    assert.deepEqual(h.restores, [{ agentDir: "/fixture/agent", tabs }]);
    assert.deepEqual(h.launches[0].args, [...baseArgs, ...(args ? ["--cwd", "/fixture/selected-project"] : [])]);
    assert.equal(h.launches[0].options.env.PI_WEBUI_RESTORE_FILE, "/fixture/private-restore.json");
    assert.equal(h.processEnv.PI_WEBUI_RESTORE_FILE, "/fixture/stale-restore.json");
  }
});

test("registered command starts empty when no server exists and reports parser failures without launch", async () => {
  const h = harness();
  await h.run("--no-open");
  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.launches[0].args, baseArgs);
  assert.match(h.notifications[0].message, /Pi Web UI started/);
  assert.equal(h.notifications[0].level, "info");
  await h.run("--cwd --no-open");
  assert.equal(h.launches.length, 1);
  assert.match(h.notifications.at(-1).message, /--cwd requires a value[\s\S]*Usage:.*--cwd PATH/);
  assert.equal(h.notifications.at(-1).level, "error");
});

test("existing server restart retains open tabs, strips sessions only on request, and keeps empty servers empty", async () => {
  for (const scenario of [
    { args: "--no-open", tabs: [{ id: "open-1", cwd: "/fixture/project", sessionFile: "/fixture/session.jsonl" }] },
    { args: "--no-open --no-session --cwd ./selected", tabs: [{ id: "open-1", cwd: "/fixture/project", sessionFile: "/fixture/session.jsonl" }] },
    { args: "--no-open", tabs: [] },
  ]) {
    let online = true;
    const requests = [];
    const h = harness({ fetchJson: async (url, init) => {
      const endpoint = new URL(url).pathname;
      requests.push([endpoint, init.method || "GET"]);
      if (endpoint === "/api/health") return { ok: online, status: online ? 200 : 404,
        body: { ok: online, webuiVersion: "fixture", tabs: scenario.tabs } };
      if (endpoint === "/api/webui-status") return { ok: true, status: 200,
        body: { ok: true, data: { tabs: scenario.tabs, restorableTabs: [{ id: "closed-1" }] } } };
      assert.equal(endpoint, "/api/shutdown");
      online = false;
      return { ok: true, status: 200, body: { ok: true } };
    } });
    await h.run(scenario.args);
    assert.deepEqual(requests, [["/api/health", "GET"], ["/api/webui-status", "GET"],
      ["/api/shutdown", "POST"], ["/api/health", "GET"]]);
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0].options.cwd, contextCwd);
    if (scenario.tabs.length) {
      const restored = h.restores[0].tabs;
      assert.equal(restored.length, 1);
      assert.equal(restored[0].id, "open-1");
      assert.equal(restored[0].cwd, "/fixture/project");
      assert.equal(restored[0].sessionFile, scenario.args.includes("--no-session") ? undefined : "/fixture/session.jsonl");
      assert.equal(h.launches[0].options.env.PI_WEBUI_RESTORE_FILE, "/fixture/private-restore.json");
      assert.match(h.notifications[0].message, /Pi Web UI restarted[\s\S]*Restored 1 Web UI tab/);
    } else {
      assert.deepEqual(h.restores, []);
      assert.deepEqual(h.launches[0].args, baseArgs);
      assert.equal(h.launches[0].options.env.PI_WEBUI_RESTORE_FILE, undefined);
    }
    assert.equal(h.notifications[0].level, "info");
  }
});
