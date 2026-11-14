import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionError } from "../../../src/backend.ts";
import { resolveConfig } from "../../../src/config/load.ts";
import { runSetupWithCache } from "../../../src/deps/flow.ts";
import { DepsCache } from "../../../src/deps/store.ts";
import { createGuiTools } from "../../../src/tools/tools.ts";
import { fakeEnv } from "../backends/env.mjs";
import { depsHandlers, FakeDepsSession } from "./fake-deps.mjs";

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "gui-deps-flow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "requirements.txt"), "requests==2.32.3\n");
  return { root, project, cache: new DepsCache({ root: join(root, "cache") }) };
}

function config(shared = {}, depsCache) {
  return resolveConfig({ shared: { setup: ["pip install -r requirements.txt"], ...shared }, local: depsCache ? { depsCache } : {}, global: { version: 1, verified: {} }, paths: {}, warnings: [] });
}

async function start(env, session, options = {}) {
  let ran = 0;
  const report = await runSetupWithCache({
    session,
    cache: "cache" in options ? options.cache : env.cache,
    projectRoot: env.project,
    config: options.config ?? config(),
    backend: "docker-linux",
    base: "image 0.1.0",
    workspace: { path: "/workspace", writable: options.writable ?? false },
    runSetup: async () => {
      ran++;
      for (const cmd of (options.config ?? config()).shared.setup ?? []) await session.request("exec", { cmd, cwd: "/workspace", env: {}, timeoutMs: 1000 });
    },
    signal: options.signal ?? new AbortController().signal,
  });
  return { report, ran };
}

test("M1b exit: the second session of the same project restores the cache and skips setup", async (t) => {
  const env = await workspace(t);
  const first = new FakeDepsSession();
  const miss = await start(env, first);
  assert.equal(miss.ran, 1);
  assert.equal(miss.report.state, "miss");
  assert.equal(miss.report.stored, true);
  assert.match(miss.report.detail, /^miss: setup ran; stored \d+\.\d MB \(1 entries, 1 skipped; key [0-9a-f]{12}\)$/);
  assert.deepEqual(first.state.setupRuns, ["pip install -r requirements.txt"]);
  assert.equal(first.state.packs.size, 0, "the packed transfer is discarded after the pull");

  const second = new FakeDepsSession();
  const hit = await start(env, second);
  assert.equal(hit.ran, 0, "setup is skipped on a hit");
  assert.equal(hit.report.state, "hit");
  assert.equal(hit.report.key, miss.report.key);
  assert.match(hit.report.detail, /^hit: restored 1 entries \(.* MB\) from the cache; setup skipped \(key [0-9a-f]{12}\)$/);
  assert.deepEqual(second.state.setupRuns, []);
  assert.deepEqual([...second.state.deps.keys()], ["installed/pip_install_r_requirements_txt"], "the deps dir holds what setup installed");
  assert.ok(second.requests.every((r) => r.method !== "exec"));
});

test("M1b exit: a changed lockfile is a new key, so setup runs again", async (t) => {
  const env = await workspace(t);
  const first = await start(env, new FakeDepsSession());
  await writeFile(join(env.project, "requirements.txt"), "requests==2.32.4\n");
  const changed = await start(env, new FakeDepsSession());
  assert.equal(changed.ran, 1);
  assert.equal(changed.report.state, "miss");
  assert.notEqual(changed.report.key, first.report.key);
  assert.deepEqual(await env.cache.usage().then((u) => u.entries), 2);
});

test("a corrupted cache entry is discarded and setup reruns (then stores a good entry)", async (t) => {
  const env = await workspace(t);
  await start(env, new FakeDepsSession());
  const [project] = await readdir(env.cache.root);
  const dir = join(env.cache.root, project, "linux-x86_64");
  const archive = (await readdir(dir)).find((n) => n.endsWith(".tar.gz"));
  await writeFile(join(dir, archive), "bit rot");
  const session = new FakeDepsSession();
  const rerun = await start(env, session);
  assert.equal(rerun.ran, 1);
  assert.equal(rerun.report.state, "miss");
  assert.match(rerun.report.detail, /the cached entry was corrupt \(SHA-256 mismatch; the entry was removed\)/);
  assert.equal(session.state.unpacks, 0, "a corrupt entry is never sent");
  assert.equal(rerun.report.stored, true);
  assert.equal((await start(env, new FakeDepsSession())).report.state, "hit");
});

test("an entry the helper rejects (ARCHIVE_REJECTED) is removed and setup runs", async (t) => {
  const env = await workspace(t);
  await start(env, new FakeDepsSession());
  const rejecting = new FakeDepsSession({}, { reject: true });
  const result = await start(env, rejecting);
  assert.equal(result.ran, 1);
  assert.match(result.report.detail, /the cached entry was rejected by the helper \(dependency archive rejected: member x is a hardlink.*\) and removed/);
  assert.equal(rejecting.state.unpacks, 1);
});

test("setup that changed the writable workspace is not stored; an unchanged one is", async (t) => {
  const env = await workspace(t);
  const changed = await start(env, new FakeDepsSession({}, { workspaceChanged: true }), { writable: true });
  assert.equal(changed.report.stored, false);
  assert.match(changed.report.detail, /not stored: setup changed the workspace, and only the deps dir is cached/);
  assert.deepEqual(await env.cache.usage(), { entries: 0, bytes: 0 });
  const session = new FakeDepsSession();
  const clean = await start(env, session, { writable: true });
  assert.equal(clean.report.stored, true);
  const execs = session.requests.filter((r) => r.method === "exec").map((r) => r.params.cmd);
  assert.match(execs[0], /^: > "\$\{TMPDIR:-\/tmp\}"\/\.pi-gui-setup-marker-[0-9a-f]{12} && sleep 1$/, "the marker comes before setup");
  assert.equal(execs[1], "pip install -r requirements.txt");
  assert.match(execs[2], /find '\/workspace' -xdev -cnewer "\$m" -print -quit/);
});

test("no setup, cache off, or a helper without a deps dir: setup behaves as before", async (t) => {
  const env = await workspace(t);
  const none = await start(env, new FakeDepsSession(), { config: config({ setup: [] }) });
  assert.equal(none.report, undefined);
  const off = await start(env, new FakeDepsSession(), { cache: undefined, config: config({}, { enabled: false }) });
  assert.equal(off.ran, 1);
  assert.deepEqual(off.report, { state: "off", detail: "off (depsCache.enabled is false); setup ran" });
  const noDeps = await start(env, new FakeDepsSession({}, { capabilities: ["exec"] }));
  assert.equal(noDeps.ran, 1);
  assert.equal(noDeps.report.state, "off");
});

test("a pack over the limit or a failed pull is reported, never fatal; a dead session is", async (t) => {
  const env = await workspace(t);
  const large = await start(env, new FakeDepsSession({}, { packTooLarge: true }));
  assert.equal(large.ran, 1);
  assert.match(large.report.detail, /not stored: larger than the cache limit \(5120\.0 MB\)/);
  const failing = new FakeDepsSession({}, { failOn: { depsRead: new SessionError("TIMEOUT", "depsRead timed out after 60000 ms") } });
  const pulled = await start(env, failing);
  assert.match(pulled.report.detail, /not stored: depsRead timed out/);
  assert.deepEqual(await env.cache.usage(), { entries: 0, bytes: 0 });
  const [project] = await readdir(env.cache.root);
  assert.deepEqual(await readdir(join(env.cache.root, project, "linux-x86_64")), [], "no temp file or lock is left behind");
  const dead = new FakeDepsSession({}, { failOn: { depsPack: new SessionError("CLOSED", "the session container ended") } });
  await assert.rejects(start(env, dead), (e) => e.code === "CLOSED");
});

test("gui_launch through docker-linux: miss then hit, reported in the result; setup skipped on the second session", async (t) => {
  const deps = {};
  const handlers = depsHandlers(deps);
  const env = await fakeEnv(t, {
    shared: { setup: ["pip install -r requirements.txt"] },
    behaviour: {
      handlers: {
        ...handlers,
        hello: (params) => ({ protocol: params.protocol, helperVersion: "0.1.0", os: "linux", arch: "x86_64", capabilities: ["launch", "exec", "deps"], platform: "Linux x86_64; glibc 2.36; debian 12; python 3.11.2" }),
      },
    },
  });
  await writeFile(join(env.project, "requirements.txt"), "requests\n");
  const tools = Object.fromEntries(createGuiTools(env.runtime).map((tool) => [tool.name, tool]));
  const call = (tool, params) => tool.execute("call", params, undefined, undefined, env.ctx());
  const text = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

  const first = await call(tools.gui_launch, {});
  assert.match(text(first), /dependency cache: miss: setup ran; stored .* MB/);
  assert.equal(first.details.depsCache.state, "miss");
  assert.deepEqual(deps.setupRuns, ["pip install -r requirements.txt"]);
  await call(tools.gui_stop, { session: first.details.session });

  deps.deps = new Map(); // a fresh container: empty /deps
  const second = await call(tools.gui_launch, {});
  assert.match(text(second), /dependency cache: hit: restored 1 entries .* setup skipped/);
  assert.equal(second.details.depsCache.state, "hit");
  assert.deepEqual(deps.setupRuns, ["pip install -r requirements.txt"], "setup did not run again");
  const child = env.spawner.children.at(-1);
  assert.ok(child.requests.some((r) => r.method === "depsUnpack"));
  assert.ok(!child.requests.some((r) => r.method === "exec" && r.params.cmd.startsWith("pip")));
  assert.equal((await readdir(env.depsCacheRoot)).length, 1, "the cache lives in the runtime's cache root");
  await call(tools.gui_stop, { session: second.details.session });
});
