import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { uiLayoutRevision } from "../lib/ui-layout-settings.mjs";
import {
  initializeWebuiShellRollout,
  readWebuiSettings,
  updateWebuiSettings,
  validatedShellRolloutCohort,
  webuiSettingsFile,
} from "../lib/server/settings-store.mjs";

const sandbox = await mkdtemp(path.join(tmpdir(), "pi-webui-shell-rollout-"));
const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "../lib/server/settings-store.mjs")).href;
const savedEnv = { ...process.env };
const children = new Set();
let completed = 0;

async function fixture(name) {
  const home = path.join(sandbox, name);
  await mkdir(home);
  const env = {
    ...savedEnv,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
    PI_CODING_AGENT_DIR: path.join(home, "agent"),
  };
  delete env.PI_WEBUI_SETTINGS_FILE;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.PI_WEBUI_SETTINGS_FILE;
  return {
    home, env,
    root: path.join(home, ".pi/webui"),
    target: path.join(home, ".pi/webui/settings.json"),
    legacy: path.join(home, "config/pi-webui/settings.json"),
    outer: path.join(home, ".pi/.webui-shell-rollout-init.lock"),
  };
}

async function put(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, typeof value === "string" ? value : JSON.stringify(value));
}
const raw = async (filename) => JSON.parse(await readFile(filename, "utf8"));
const absent = async (filename) => assert.rejects(lstat(filename), { code: "ENOENT" });

async function waitFor(check) {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for filesystem checkpoint");
    await delay(5);
  }
}

// Faults and pauses are injected at filesystem boundaries in disposable children.
// Production code has no test hooks, alternate writers or configurable lock policy.
function child(f, { fault, pause, options = {}, action = "initialize", env = f.env } = {}) {
  const source = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const root = ${JSON.stringify(f.root)};
    const target = ${JSON.stringify(f.target)};
    const fault = ${JSON.stringify(fault)};
    const pause = ${JSON.stringify(pause)};
    const original = { mkdir: fs.mkdir, rename: fs.rename, lstat: fs.lstat, readFile: fs.readFile };
    let renamed = false;
    const checkpoint = async () => {
      process.send({ checkpoint: true });
      await new Promise(resolve => process.once("message", resolve));
    };
    fs.mkdir = async (filename, options) => {
      const result = await original.mkdir(filename, options);
      if (filename === root && options?.recursive !== true) {
        if (fault === "exclusive-race") throw Object.assign(new Error("lost mkdir race"), { code: "EEXIST" });
        if (pause === "root") await checkpoint();
      }
      if (filename === target + ".lock" && pause === "settings-lock") await checkpoint();
      return result;
    };
    fs.rename = async (source, destination) => {
      if (destination === target && fault === "commit") throw Object.assign(new Error("commit denied"), { code: "EACCES" });
      const result = await original.rename(source, destination);
      if (destination === target) renamed = true;
      return result;
    };
    fs.readFile = async (filename, ...args) => {
      if (filename === target && renamed && fault === "readback") throw Object.assign(new Error("readback denied"), { code: "EACCES" });
      return original.readFile(filename, ...args);
    };
    fs.lstat = async filename => {
      if (filename === root && fault === "probe") throw Object.assign(new Error("probe denied"), { code: "EACCES" });
      return original.lstat(filename);
    };
    syncBuiltinESMExports();
    const store = await import(${JSON.stringify(moduleUrl)});
    let result;
    if (${JSON.stringify(action)} === "hold-outer") {
      await store.withWebuiSettingsLock(${JSON.stringify(f.outer.slice(0, -5))}, checkpoint);
    } else if (${JSON.stringify(action)} === "hold-settings") {
      await store.withWebuiSettingsLock(target, checkpoint);
    } else if (${JSON.stringify(action)} === "update") {
      result = await store.updateWebuiSettings(() => ({ concurrent: { retained: true } }), target);
    } else {
      result = await store.initializeWebuiShellRollout(${JSON.stringify(options)});
    }
    process.send({ result: result ?? null });
    process.disconnect();
  `;
  const processChild = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(processChild);
  let stderr = "";
  processChild.stderr.on("data", chunk => { stderr += chunk; });
  const messages = [];
  processChild.on("message", message => messages.push(message));
  const done = once(processChild, "exit").then(([code, signal]) => {
    children.delete(processChild);
    return { code, signal, stderr, messages };
  });
  const watchdog = setTimeout(() => processChild.kill("SIGKILL"), 15_000);
  done.then(() => clearTimeout(watchdog));
  return {
    process: processChild, done,
    checkpoint: () => waitFor(() => messages.some(message => message.checkpoint)),
    release: () => processChild.send("continue"),
    result: async () => {
      const outcome = await done;
      assert.equal(outcome.code, 0, outcome.stderr);
      return outcome.messages.findLast(message => Object.hasOwn(message, "result")).result;
    },
  };
}

async function check(name, run) {
  await run();
  completed += 1;
  console.log(`ok ${completed} - ${name}`);
}

try {
  await check("strict marker validation preserves extension compatibility", async () => {
    for (const value of [undefined, null, [], "fresh", {}, { version: "1", cohort: "fresh" },
      { version: 2, cohort: "fresh" }, { version: 1, cohort: "unknown" }]) {
      assert.equal(validatedShellRolloutCohort(value), null);
    }
    for (const cohort of ["fresh", "established"]) {
      assert.equal(validatedShellRolloutCohort({ version: 1, cohort, extra: true }), cohort);
    }
  });

  await check("absent default root persists private raw-only fresh marker", async () => {
    const f = await fixture("fresh");
    assert.equal(webuiSettingsFile(f.env), f.target);
    assert.deepEqual(await initializeWebuiShellRollout({ env: f.env }), { cohort: "fresh" });
    assert.deepEqual(await raw(f.target), { shellRollout: { version: 1, cohort: "fresh" } });
    assert.equal((await stat(f.root)).mode & 0o777, 0o700);
    assert.equal((await stat(f.target)).mode & 0o777, 0o600);
    const bytes = await readFile(f.target, "utf8");
    await put(f.legacy, "malformed late legacy");
    assert.deepEqual(await initializeWebuiShellRollout({ env: f.env }), { cohort: "fresh" });
    assert.equal(await readFile(f.target, "utf8"), bytes, "valid marker wins without a write");
    assert.equal((await readWebuiSettings()).version, 8);
    assert.equal((await readWebuiSettings()).uiLayout.version, 3);
    await absent(f.outer);
    assert.deepEqual(await readdir(f.root), ["settings.json"]);
  });

  await check("existing root and prior-use evidence force established", async () => {
    for (const kind of ["empty-root", "file", "directory", "dangling-link"]) {
      const f = await fixture(`evidence-${kind}`);
      const evidence = path.join(f.home, "prior-use");
      if (kind === "empty-root") await mkdir(f.root, { recursive: true });
      if (kind === "file") await put(evidence, "previous use");
      if (kind === "directory") await mkdir(evidence);
      if (kind === "dangling-link") await symlink(path.join(f.home, "missing"), evidence);
      assert.deepEqual(await initializeWebuiShellRollout({ env: f.env, additionalEvidencePaths: [evidence] }), { cohort: "established" });
    }
  });

  await check("custom target defaults resolve supplied env and never prove fresh", async () => {
    const f = await fixture("custom");
    const target = path.join(f.home, "custom/settings.json");
    const env = { ...f.env, PI_WEBUI_SETTINGS_FILE: target, XDG_CONFIG_HOME: path.join(f.home, "other-config") };
    await put(path.join(env.XDG_CONFIG_HOME, "pi-webui/settings.json"), { mustNotImport: true });
    assert.deepEqual(await initializeWebuiShellRollout({ env }), { cohort: "established" });
    assert.deepEqual(await raw(target), { shellRollout: { version: 1, cohort: "established" } });
    await absent(f.root);
    const explicit = path.join(f.home, "explicit/settings.json");
    assert.deepEqual(await initializeWebuiShellRollout({ storageFile: explicit, env: f.env }), { cohort: "established" });
    await put(explicit, { shellRollout: { version: 1, cohort: "fresh", extension: 7 } });
    assert.deepEqual(await initializeWebuiShellRollout({ storageFile: explicit, env }), { cohort: "fresh" });
    const sameDefault = await fixture("overridden-default");
    assert.deepEqual(await initializeWebuiShellRollout({ env: { ...sameDefault.env, PI_WEBUI_SETTINGS_FILE: sameDefault.target } }), { cohort: "established" });
  });

  await check("invalid, future and null own markers survive init, reads and unrelated writes", async () => {
    const f = await fixture("markers");
    for (const marker of [null, false, 0, "fresh", {}, [], { version: 2, cohort: "fresh" }, { version: 1, cohort: "bad" }]) {
      await put(f.target, { version: 8, shellRollout: marker, retained: true });
      const bytes = await readFile(f.target, "utf8");
      assert.deepEqual(await initializeWebuiShellRollout({ env: f.env }), { cohort: null });
      await readWebuiSettings();
      assert.equal(await readFile(f.target, "utf8"), bytes);
      await updateWebuiSettings(() => ({ unrelated: true }));
      assert.deepEqual((await raw(f.target)).shellRollout, marker);
    }
  });

  await check("marker-only initialization preserves raw versions, layouts and layout revisions", async () => {
    const f = await fixture("raw-layout");
    for (const version of [1, 2, 3, 99]) {
      const settings = {
        version, retained: { nested: [1, null, "keep"] },
        uiLayout: { version, sidePanel: { placement: "left", panelWidths: { left: 444, right: 555 } }, future: ["retain"] },
      };
      await put(f.target, settings);
      const before = uiLayoutRevision((await readWebuiSettings()).uiLayout);
      assert.deepEqual(await initializeWebuiShellRollout({ env: f.env }), { cohort: "established" });
      assert.deepEqual(await raw(f.target), { ...settings, shellRollout: { version: 1, cohort: "established" } });
      assert.equal(uiLayoutRevision((await readWebuiSettings()).uiLayout), before);
    }
  });

  await check("legacy migrates before marker and retains data and future layout", async () => {
    const f = await fixture("legacy");
    const legacy = { version: 99, retained: { legacy: true }, uiLayout: { version: 99, future: ["keep"] } };
    await put(f.legacy, legacy);
    const bytes = await readFile(f.legacy, "utf8");
    assert.deepEqual(await initializeWebuiShellRollout({ env: f.env }), { cohort: "established" });
    assert.deepEqual((await raw(f.target)).retained, legacy.retained);
    assert.deepEqual((await raw(f.target)).uiLayout, legacy.uiLayout);
    assert.equal((await raw(f.target)).version, 99);
    assert.equal(await readFile(f.legacy, "utf8"), bytes);
    assert.equal(Object.hasOwn(await raw(f.target), "subagentLaunchSlots"), false);
  });

  await check("malformed legacy and malformed target are not masked", async () => {
    for (const content of ["{", "[]", "null"]) {
      const f = await fixture(`malformed-${completed}-${content.length}-${content.charCodeAt(0)}`);
      await put(f.legacy, content);
      assert.deepEqual(await initializeWebuiShellRollout({ env: f.env }), { cohort: null });
      await absent(f.target);
      assert.equal(await readFile(f.legacy, "utf8"), content);
    }
    const f = await fixture("malformed-target");
    await put(f.target, "{invalid");
    await put(f.legacy, { legacy: true });
    assert.deepEqual(await initializeWebuiShellRollout({ env: f.env }), { cohort: null });
    assert.equal(await readFile(f.target, "utf8"), "{invalid");
  });

  await check("ordinary reads and undefined updates never assign a cohort", async () => {
    const f = await fixture("reads");
    await readWebuiSettings();
    await absent(f.root);
    await updateWebuiSettings(() => undefined);
    await absent(f.target);
    assert.deepEqual(await initializeWebuiShellRollout({ env: f.env }), { cohort: "established" }, "undefined update created the root, so freshness is lost");
    const migrated = await fixture("read-migration");
    await put(migrated.legacy, { retained: "legacy read" });
    assert.equal((await readWebuiSettings()).retained, "legacy read");
    assert.equal(Object.hasOwn(await raw(migrated.target), "shellRollout"), false);
  });

  await check("ambiguous paths and probe errors cannot prove freshness", async () => {
    const f = await fixture("probe-failure");
    assert.deepEqual(await child(f, { fault: "probe" }).result(), { cohort: null });
    await absent(f.root);
    for (const kind of ["file", "symlink", "dangling"]) {
      const state = await fixture(`root-${kind}`);
      await mkdir(path.dirname(state.root));
      if (kind === "file") await writeFile(state.root, "not a directory");
      else {
        const destination = path.join(state.home, "elsewhere");
        if (kind === "symlink") await mkdir(destination);
        await symlink(destination, state.root);
      }
      assert.deepEqual(await initializeWebuiShellRollout({ env: state.env }), { cohort: null });
    }
    const badEvidence = await fixture("evidence-error");
    await put(path.join(badEvidence.home, "file"), "not a directory");
    assert.deepEqual(await initializeWebuiShellRollout({ env: badEvidence.env, additionalEvidencePaths: [path.join(badEvidence.home, "file/child")] }), { cohort: null });
    await absent(badEvidence.root);
  });

  await check("exclusive mkdir EEXIST loses freshness", async () => {
    const f = await fixture("exclusive-race");
    assert.deepEqual(await child(f, { fault: "exclusive-race" }).result(), { cohort: "established" });
  });

  await check("target path types are conservative and readable valid markers still win", async () => {
    const directory = await fixture("target-directory");
    await mkdir(directory.target, { recursive: true });
    assert.deepEqual(await initializeWebuiShellRollout({ env: directory.env }), { cohort: null });
    const linked = await fixture("target-link");
    const destination = path.join(linked.home, "settings-source.json");
    await put(destination, { shellRollout: { version: 1, cohort: "fresh", extra: true } });
    await mkdir(linked.root, { recursive: true });
    await symlink(destination, linked.target);
    const bytes = await readFile(destination, "utf8");
    assert.deepEqual(await initializeWebuiShellRollout({ env: linked.env }), { cohort: "fresh" });
    assert.equal(await readFile(destination, "utf8"), bytes);
    if (process.platform === "linux") {
      const fifo = await fixture("target-fifo");
      await mkdir(fifo.root, { recursive: true });
      const made = spawnSync("mkfifo", [fifo.target], { encoding: "utf8", timeout: 2_000 });
      assert.equal(made.status, 0, made.stderr || made.error?.message);
      assert.deepEqual(await child(fifo).result(), { cohort: null });
      assert.equal((await lstat(fifo.target)).isFIFO(), true, "special target must remain untouched");
    }
  });

  await check("failed commits lose freshness; failed readback returns null", async () => {
    for (const fault of ["commit", "readback"]) {
      const f = await fixture(`failure-${fault}`);
      assert.deepEqual(await child(f, { fault }).result(), { cohort: null });
      assert.equal((await stat(f.root)).isDirectory(), true);
      assert.equal((await readdir(f.root)).some(name => name.endsWith(".tmp") || name.endsWith(".lock")), false);
      await absent(f.outer);
      // Readback failure can leave a successfully committed fresh marker.
      const expected = fault === "commit" ? "established" : "fresh";
      assert.deepEqual(await initializeWebuiShellRollout({ env: f.env }), { cohort: expected });
    }
  });

  await check("failed marker commit preserves raw settings and failed migration preserves legacy", async () => {
    const f = await fixture("existing-commit-failure");
    await put(f.target, '{ "version": 99, "uiLayout": {"version":99}, "retained":true }');
    const before = await readFile(f.target, "utf8");
    assert.deepEqual(await child(f, { fault: "commit" }).result(), { cohort: null });
    assert.equal(await readFile(f.target, "utf8"), before);
    const legacy = await fixture("migration-commit-failure");
    await put(legacy.legacy, { retained: "legacy" });
    const source = await readFile(legacy.legacy, "utf8");
    assert.deepEqual(await child(legacy, { fault: "commit" }).result(), { cohort: null });
    await absent(legacy.target);
    assert.equal(await readFile(legacy.legacy, "utf8"), source);
    assert.deepEqual(await readdir(legacy.root), []);
    await absent(legacy.outer);
    assert.deepEqual(await initializeWebuiShellRollout({ env: legacy.env }), { cohort: "established" });
    assert.equal((await raw(legacy.target)).retained, "legacy");
  });

  await check("two processes serialize absent-root initialization while first is paused", async () => {
    const f = await fixture("concurrent-starts");
    const first = child(f, { pause: "root" });
    await first.checkpoint();
    const second = child(f);
    await waitFor(async () => (await readdir(f.outer)).filter(name => name.endsWith(".json")).length === 2);
    await absent(f.target);
    first.release();
    assert.deepEqual(await first.result(), { cohort: "fresh" });
    assert.deepEqual(await second.result(), { cohort: "fresh" });
    assert.deepEqual(await raw(f.target), { shellRollout: { version: 1, cohort: "fresh" } });
    await absent(f.outer);
  });

  await check("canonical parent aliases share the same outer lock", async () => {
    const f = await fixture("alias");
    const aliasHome = `${f.home}-alias`;
    await symlink(f.home, aliasHome);
    const first = child(f, { pause: "root" });
    await first.checkpoint();
    const second = child(f, { env: { ...f.env, HOME: aliasHome } });
    await waitFor(async () => (await readdir(f.outer)).length === 2);
    first.release();
    assert.deepEqual(await first.result(), { cohort: "fresh" });
    assert.deepEqual(await second.result(), { cohort: "fresh" });
  });

  await check("concurrent ordinary update retains patch and forces established", async () => {
    const f = await fixture("concurrent-update");
    const first = child(f, { pause: "root" });
    await first.checkpoint();
    await child(f, { action: "update" }).result();
    first.release();
    assert.deepEqual(await first.result(), { cohort: "established" });
    assert.deepEqual((await raw(f.target)).concurrent, { retained: true });
    await updateWebuiSettings(() => ({ after: true }));
    assert.equal((await raw(f.target)).shellRollout.cohort, "established");
  });

  await check("raw lock recheck preserves a concurrently appeared marker or unmarked file", async () => {
    for (const marker of [undefined, null, { version: 1, cohort: "fresh", extra: true }]) {
      const f = await fixture(`raw-race-${completed}-${String(marker)}`);
      const pending = child(f, { pause: "settings-lock" });
      await pending.checkpoint();
      const settings = { retained: "winner", ...(marker === undefined ? {} : { shellRollout: marker }) };
      await put(f.target, settings);
      pending.release();
      assert.deepEqual(await pending.result(), { cohort: marker === undefined ? "established" : validatedShellRolloutCohort(marker) });
      assert.deepEqual(await raw(f.target), marker === undefined
        ? { ...settings, shellRollout: { version: 1, cohort: "established" } } : settings);
    }
  });

  await check("crash after root creation recovers dead lock and stays established", async () => {
    const f = await fixture("crash");
    const first = child(f, { pause: "root" });
    await first.checkpoint();
    first.process.kill("SIGKILL");
    assert.equal((await first.done).signal, "SIGKILL");
    await absent(f.target);
    assert.deepEqual(await child(f).result(), { cohort: "established" });
    await absent(f.outer);
    assert.deepEqual(await readdir(f.root), ["settings.json"]);
  });

  await check("late evidence loses freshness and late legacy waits for migration", async () => {
    for (const kind of ["evidence", "legacy"]) {
      const f = await fixture(`late-${kind}`);
      const evidence = path.join(f.home, "prior-use");
      const pending = child(f, { pause: "root", options: { additionalEvidencePaths: [evidence] } });
      await pending.checkpoint();
      await put(kind === "legacy" ? f.legacy : evidence, kind === "legacy" ? { imported: true } : "prior use");
      pending.release();
      assert.deepEqual(await pending.result(), { cohort: kind === "legacy" ? null : "established" });
      if (kind === "legacy") {
        await absent(f.target);
        assert.deepEqual(await initializeWebuiShellRollout({ env: f.env }), { cohort: "established" });
        assert.equal((await raw(f.target)).imported, true);
      }
    }
  });

  await check("explicit legacy path is migrated before marker persistence", async () => {
    const f = await fixture("explicit-legacy");
    const source = path.join(f.home, "selected-legacy.json");
    await put(source, { selectedSource: true });
    assert.deepEqual(await initializeWebuiShellRollout({ env: f.env, legacyFile: source }), { cohort: "established" });
    assert.equal((await raw(f.target)).selectedSource, true);
    await absent(f.legacy);
  });

  await check("live outer lock times out without creating the root", async () => {
    const f = await fixture("timeout");
    const holder = child(f, { action: "hold-outer" });
    await holder.checkpoint();
    const started = Date.now();
    assert.deepEqual(await child(f).result(), { cohort: null });
    assert.ok(Date.now() - started < 5_000, "initialization must have a bounded wait");
    await absent(f.root);
    assert.equal((await readdir(f.outer)).length, 1, "timeout cleans only its own record");
    holder.release();
    await holder.result();
    await absent(f.outer);
  });

  await check("ordinary settings lock timeout returns null and cleans outer ownership", async () => {
    const f = await fixture("settings-timeout");
    const holder = child(f, { action: "hold-settings" });
    await holder.checkpoint();
    assert.deepEqual(await child(f).result(), { cohort: null });
    await absent(f.target);
    await absent(f.outer);
    assert.equal((await readdir(`${f.target}.lock`)).length, 1);
    holder.release();
    await holder.result();
    assert.deepEqual(await initializeWebuiShellRollout({ env: f.env }), { cohort: "established" });
  });

  console.log(`server-shell-rollout.test.mjs passed (${completed} groups)`);
} finally {
  for (const processChild of children) processChild.kill("SIGKILL");
  for (const key of ["HOME", "XDG_CONFIG_HOME", "PI_WEBUI_SETTINGS_FILE"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(sandbox, { recursive: true, force: true });
}
