import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../../../src/config/validate.ts";
import {
  loadConfigSources,
  loadResolvedConfig,
  resolveConfig,
  updateGlobalConfig,
  updateLocalConfig,
} from "../../../src/config/load.ts";
import { writeJsonAtomic } from "../../../src/config/atomic.ts";
import {
  markUnverified,
  markVerified,
  notAvailableMessage,
  notSetUpMessage,
  staleVersions,
  verificationState,
} from "../../../src/config/verified.ts";

async function project(files = {}) {
  const root = await mkdtemp(join(tmpdir(), "gui-cfg-test-"));
  await mkdir(join(root, ".pi"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

test("defaults apply when no file exists", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cfg = await loadResolvedConfig(root, {}, join(root, "global.json"));
  assert.equal(cfg.backend, undefined);
  assert.deepEqual(cfg.shared.targets, ["linux"]);
  assert.equal(cfg.shared.workspaceMode, "mount");
  assert.equal(cfg.shared.network, "default");
  assert.deepEqual(cfg.limits, { maxConcurrentSessions: 2, idleTimeoutMinutes: 15 });
  assert.deepEqual(cfg.usageCheck, { warnSessionCostUsd: 1, warnDailyCostUsd: 5 });
  assert.equal(cfg.keepSandbox, false);
  assert.deepEqual(cfg.warnings, []);
});

test("each field resolves independently: flags → local → global → environment → default", async (t) => {
  const root = await project({
    ".pi/gui.local.json": { limits: { idleTimeoutMinutes: 30 }, remote: { host: "local-host" } },
    "global.json": { version: 1, verified: {}, backend: "docker-linux", limits: { maxConcurrentSessions: 4, idleTimeoutMinutes: 5 }, keepSandbox: true },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = await loadConfigSources(root, join(root, "global.json"));
  const env = { usageCheck: { warnDailyCostUsd: 9 }, backend: "cua", remote: { host: "env-host" } };

  const plain = resolveConfig(sources, { environment: env });
  assert.equal(plain.backend, "docker-linux", "global beats environment");
  assert.equal(plain.limits.idleTimeoutMinutes, 30, "local beats global");
  assert.equal(plain.limits.maxConcurrentSessions, 4, "global fills a field local lacks");
  assert.equal(plain.usageCheck.warnDailyCostUsd, 9, "environment beats default");
  assert.equal(plain.usageCheck.warnSessionCostUsd, 1, "default");
  assert.equal(plain.keepSandbox, true);
  assert.deepEqual(plain.remote, { host: "local-host" });

  const flagged = resolveConfig(sources, { flags: { backend: "local-linux", remote: { host: "flag-host" } }, environment: env });
  assert.equal(flagged.backend, "local-linux");
  assert.deepEqual(flagged.remote, { host: "flag-host" });
});

test("shared fields come only from .pi/gui.json; personal fields there are ignored with a warning", async (t) => {
  const root = await project({
    ".pi/gui.json": {
      targets: ["linux", "windows"],
      setup: ["pip install -r requirements.txt"],
      launch: { cmd: "python", args: ["app.py"] },
      workspaceMode: "copy",
      network: "none",
      backend: "cua",
      limits: { maxConcurrentSessions: 9 },
      bogus: 1,
    },
    ".pi/gui.local.json": { backend: "docker-linux", setup: ["rm -rf /"] },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const cfg = await loadResolvedConfig(root, {}, join(root, "missing-global.json"));
  assert.equal(cfg.backend, "docker-linux");
  assert.equal(cfg.limits.maxConcurrentSessions, 2);
  assert.deepEqual(cfg.shared.setup, ["pip install -r requirements.txt"]);
  assert.deepEqual(cfg.shared.targets, ["linux", "windows"]);
  assert.equal(cfg.shared.workspaceMode, "copy");
  assert.equal(cfg.shared.network, "none");
  assert.deepEqual(cfg.shared.launch, { cmd: "python", args: ["app.py"] });
  const text = cfg.warnings.join("\n");
  assert.match(text, /gui\.json: "backend" is a personal setting/);
  assert.match(text, /gui\.json: "limits" is a personal setting/);
  assert.match(text, /gui\.json: unknown field "bogus"/);
  assert.match(text, /gui\.local\.json: "setup" is a shared project setting/);
});

test("malformed JSON and wrong types raise ConfigError naming the file and field", async (t) => {
  const root = await project({ ".pi/gui.json": "{ not json" });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(loadConfigSources(root, join(root, "g.json")), (e) => e instanceof ConfigError && e.file.endsWith(".pi/gui.json") && /malformed JSON/.test(e.message));

  await writeFile(join(root, ".pi/gui.json"), JSON.stringify({ workspaceMode: "bind" }));
  await assert.rejects(loadConfigSources(root, join(root, "g.json")), /gui\.json: "workspaceMode" must be one of mount, copy/);

  await writeFile(join(root, ".pi/gui.json"), "{}");
  await writeFile(join(root, ".pi/gui.local.json"), JSON.stringify({ limits: { maxConcurrentSessions: 0 } }));
  await assert.rejects(loadConfigSources(root, join(root, "g.json")), /gui\.local\.json: "limits\.maxConcurrentSessions" must be a positive integer/);

  await writeFile(join(root, ".pi/gui.local.json"), "{}");
  await writeFile(join(root, "g.json"), JSON.stringify({ version: 2, verified: {} }));
  await assert.rejects(loadConfigSources(root, join(root, "g.json")), /g\.json: unsupported config version 2/);

  await writeFile(join(root, "g.json"), JSON.stringify({ version: 1, verified: { "docker-linux": { verifiedAt: 5 } } }));
  await assert.rejects(loadConfigSources(root, join(root, "g.json")), /verified\.docker-linux\.verifiedAt/);
});

test("writeJsonAtomic creates parents, writes mode 0600, and leaves no temp files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gui-atomic-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "a", "b", "config.json");
  await writeJsonAtomic(path, { x: 1 });
  await writeJsonAtomic(path, { x: 2 });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { x: 2 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(root, "a", "b")), ["config.json"]);
});

test("updateGlobalConfig and updateLocalConfig read-modify-write atomically and refuse to overwrite a malformed file", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const globalPath = join(root, "agent", "gui", "config.json");
  await updateGlobalConfig((c) => {
    c.backend = "docker-linux";
  }, globalPath);
  const written = JSON.parse(await readFile(globalPath, "utf8"));
  assert.deepEqual(written, { version: 1, verified: {}, backend: "docker-linux" });

  await updateLocalConfig(root, (c) => ({ ...c, backend: "docker-linux" }));
  assert.deepEqual(JSON.parse(await readFile(join(root, ".pi/gui.local.json"), "utf8")), { backend: "docker-linux" });

  await writeFile(globalPath, "{ broken");
  await assert.rejects(updateGlobalConfig(() => {}, globalPath), ConfigError);
  assert.equal(await readFile(globalPath, "utf8"), "{ broken");
});

test("verified state: mark, read, stale on tool-version change, unverify", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const globalPath = join(root, "config.json");
  const record = { verifiedAt: "2026-10-24T00:00:00.000Z", toolVersions: { "docker.server": "29.9.1", "image.base": "0.1.0" }, checksPassed: ["pi.version"] };
  await markVerified("docker-linux", record, globalPath);
  let { global } = await loadConfigSources(root, globalPath);
  assert.deepEqual(global.verified["docker-linux"], record);

  assert.equal(verificationState(global, "docker-linux").state, "verified");
  assert.equal(verificationState(global, "docker-linux", { "docker.server": "29.9.1" }).state, "verified");
  const stale = verificationState(global, "docker-linux", { "docker.server": "30.0.1" });
  assert.equal(stale.state, "stale");
  assert.match(stale.message, /docker\.server 29\.9\.1 → 30\.0\.1.*\/gui-doctor docker-linux/);
  assert.deepEqual(staleVersions(record, { "new.tool": "1" }), [{ key: "new.tool", recorded: undefined, current: "1" }]);

  const missing = verificationState(global, "local-linux");
  assert.equal(missing.state, "unverified");
  assert.equal(missing.message, notSetUpMessage("local-linux"));
  assert.equal(notSetUpMessage("docker-linux"), 'backend "docker-linux" is not set up; ask the user to run /gui-setup docker-linux');
  assert.match(notAvailableMessage("cua"), /not available yet; available: docker-linux/);

  await markUnverified("docker-linux", globalPath);
  ({ global } = await loadConfigSources(root, globalPath));
  assert.equal(global.verified["docker-linux"], undefined);
});

test("I: remote.purgeTooling is validated and resolved per field (local over global)", async () => {
  const { validatePersonalConfig } = await import("../../../src/config/validate.ts");
  const { resolveConfig } = await import("../../../src/config/load.ts");
  assert.deepEqual(validatePersonalConfig({ remote: { host: "raspi5", purgeTooling: true } }, "x.json").config.remote, { host: "raspi5", purgeTooling: true });
  assert.throws(() => validatePersonalConfig({ remote: { purgeTooling: "yes" } }, "x.json"), /remote\.purgeTooling/);
  const sources = { shared: {}, local: { remote: { host: "lab" } }, global: { version: 1, verified: {}, remote: { host: "g", purgeTooling: true } }, warnings: [] };
  assert.deepEqual(resolveConfig(sources).remote, { host: "lab", purgeTooling: true });
  assert.equal(resolveConfig({ ...sources, global: { version: 1, verified: {} }, local: {} }).remote, undefined);
});

test("M1b: depsCache.enabled and depsCache.maxSizeGB are validated and resolved per field with defaults", async () => {
  const { validatePersonalConfig } = await import("../../../src/config/validate.ts");
  assert.deepEqual(validatePersonalConfig({ depsCache: { enabled: false, maxSizeGB: 0.5 } }, "x.json").config.depsCache, { enabled: false, maxSizeGB: 0.5 });
  assert.throws(() => validatePersonalConfig({ depsCache: { enabled: "no" } }, "x.json"), /depsCache\.enabled/);
  assert.throws(() => validatePersonalConfig({ depsCache: { maxSizeGB: 0 } }, "x.json"), /depsCache\.maxSizeGB/);
  assert.throws(() => validatePersonalConfig({ depsCache: { maxSizeGB: "5" } }, "x.json"), /depsCache\.maxSizeGB/);
  const empty = { shared: {}, local: {}, global: { version: 1, verified: {} }, warnings: [] };
  assert.deepEqual(resolveConfig(empty).depsCache, { enabled: true, maxBytes: 5 * 1024 ** 3 });
  const layered = { shared: {}, local: { depsCache: { maxSizeGB: 2 } }, global: { version: 1, verified: {}, depsCache: { enabled: false, maxSizeGB: 9 } }, warnings: [] };
  assert.deepEqual(resolveConfig(layered).depsCache, { enabled: false, maxBytes: 2 * 1024 ** 3 });
  const shared = await import("../../../src/config/validate.ts").then((m) => m.validateSharedConfig({ depsCache: { enabled: false } }, ".pi/gui.json"));
  assert.match(shared.warnings[0], /"depsCache" is a personal setting/);
});
