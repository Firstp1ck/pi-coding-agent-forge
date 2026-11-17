import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "@playwright/test";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
export const SHELL_KEY = "pi-webui-shell-preferences-v1";
export const INTERFACE_PATH = "/api/interface-preferences";

async function absent(pathname) {
  try {
    await lstat(pathname);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function writeJson(filename, value) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stopServer(child) {
  if (!child?.pid) return;
  const signalGroup = signal => {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise(resolve => child.once("exit", resolve));
  let timer;
  try {
    signalGroup("SIGTERM");
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3_000); })]);
  } finally {
    clearTimeout(timer);
    // Fake-Pi descendants may outlive the HTTP server's exit event.
    signalGroup("SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
}

/** Observe writes without changing migration, persistence or the action under test. */
async function instrumentStorage(context, unavailable) {
  await context.addInitScript(({ shellKey, unavailable }) => {
    window.rolloutStorageWrites = [];
    for (const method of ["setItem", "removeItem", "clear"]) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (...args) {
        if (this === window.localStorage) {
          window.rolloutStorageWrites.push({ method, key: args[0] ?? null, value: args[1] ?? null, stack: new Error().stack });
        }
        return original.apply(this, args);
      };
    }
    if (unavailable) {
      const original = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (this === window.localStorage && key === shellKey) throw new DOMException("Fixture storage unavailable", "SecurityError");
        return original.call(this, key);
      };
    }
  }, { shellKey: SHELL_KEY, unavailable });
}

/** Wait for the real startup migration to finish before navigation assertions. */
export async function settleStartup(page, audit) {
  await expect(page.locator("#modelSelect")).not.toBeEmpty();
  await expect.poll(() => audit.reads.length, { message: "Interface metadata request completed" }).toBeGreaterThan(0);
  await expect.poll(() => audit.pending.size === 0 && Date.now() - audit.lastActivity >= 1_000, {
    message: "Real interface migration and hydration quiesced", timeout: 10_000,
  }).toBe(true);
  expect(audit.failures, "Interface requests must not silently fail while settling").toEqual([]);
}

/** Delay only interface GETs; the bounded gate never intercepts mutations. */
export async function holdMetadata(page, transform = payload => payload) {
  let release;
  let arrived;
  const seen = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const state = { expired: false, seen, release: () => release() };
  await page.route(url => url.pathname === INTERFACE_PATH, async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch({ timeout: 8_000 });
    const payload = await response.json();
    arrived(payload);
    let timer;
    try {
      await Promise.race([gate, new Promise(resolve => {
        timer = setTimeout(() => { state.expired = true; resolve(); }, 8_000);
      })]);
      await route.fulfill({ response, json: transform(payload) });
    } finally {
      clearTimeout(timer);
    }
  });
  return state;
}

export async function shellWrites(page) {
  return page.evaluate(key => window.rolloutStorageWrites.filter(write => write.key === key || write.method === "clear"), SHELL_KEY);
}

export async function capture(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

export const test = base.extend({
  rolloutState: ["fresh", { option: true }],
  rollout: async ({ browser, request, rolloutState }, use, testInfo) => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-shell-rollout-"));
    const home = join(root, "home");
    const defaultRoot = join(home, ".pi", "webui");
    const defaultSettings = join(defaultRoot, "settings.json");
    const legacySettings = join(root, "config", "pi-webui", "settings.json");
    const project = join(root, "project");
    const sessions = join(root, "sessions");
    const contexts = [];
    const audits = [];
    let settingsFile = defaultSettings;
    let child;
    let output = "";
    try {
      for (const directory of [home, project, sessions, join(home, ".pi", "agent"), join(root, "runtime")]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }
      if (rolloutState === "established") await mkdir(defaultRoot, { mode: 0o700 });
      else if (rolloutState === "legacy") await writeJson(legacySettings, { version: 8, interfacePreferences: { sidePanelWidth: 420 }, rolloutFixture: "legacy-preserved" });
      else if (rolloutState === "legacy-root") await mkdir(dirname(legacySettings), { recursive: true });
      else if (rolloutState === "xdg-state") await mkdir(join(root, "state", "pi-webui"), { recursive: true });
      else if (rolloutState === "agent-root") await mkdir(join(home, ".pi", "agent", "webui"), { recursive: true });
      else if (rolloutState === "unknown") await writeJson(defaultSettings, { version: 8, shellRollout: { version: 99, cohort: "fresh" }, rolloutFixture: "future-preserved" });
      else if (rolloutState === "custom") settingsFile = join(root, "custom", "settings.json");
      else if (rolloutState === "marked-fresh" || rolloutState === "marked-established") {
        await writeJson(defaultSettings, { version: 8, shellRollout: { version: 1, cohort: rolloutState.slice(7) }, rolloutFixture: "marker-preserved" });
      } else if (rolloutState !== "fresh") throw new Error(`Unsupported rollout fixture state: ${rolloutState}`);

      const evidence = [defaultRoot, dirname(legacySettings), join(root, "state", "pi-webui"), join(home, ".pi", "agent", "webui")];
      const absentBeforeBoot = await Promise.all(evidence.map(absent));
      if (rolloutState === "fresh") expect(absentBeforeBoot, "Fresh proof must precede all server-created settings/domain/registry state").toEqual([true, true, true, true]);
      const baseURL = `http://127.0.0.1:${await freePort()}`;
      const alternateURL = baseURL.replace("127.0.0.1", "localhost");
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith("PI_") && !key.startsWith("FAKE_PI_") && !key.startsWith("XDG_") && !key.startsWith("GIT_")
      ));
      const env = {
        ...inherited, NODE_ENV: "test", HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_RUNTIME_DIR: join(root, "runtime"),
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        PI_WEBUI_UPDATE_TEST_HOME: join(root, "update-coordination"), PI_WEBUI_RPC_SUPERVISOR: "0",
        PI_WEBUI_NPM_REGISTRY_URL: baseURL, PI_WEBUI_PI_LATEST_VERSION_URL: `${baseURL}/fixture-no-latest-version`,
        FAKE_PI_SESSION_OWNERSHIP: "1", FAKE_PI_CONTINUITY_MODE: "1",
        ...(rolloutState === "custom" ? { PI_WEBUI_SETTINGS_FILE: settingsFile } : {}),
      };
      const start = async () => {
        let spawnError;
        child = spawn(process.execPath, [
          join(packageRoot, "bin/pi-webui.mjs"), "--cwd", project,
          "--host", "127.0.0.1", "--port", new URL(baseURL).port,
          "--pi", join(packageRoot, "tests/fixtures/fake-pi.mjs"), "--", "--session-dir", sessions,
        ], { cwd: project, detached: true, stdio: ["ignore", "pipe", "pipe"], env });
        child.on("error", error => { spawnError = error; });
        for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-32_000); });
        let ready = false;
        for (let attempt = 0; attempt < 100 && child.exitCode === null && !spawnError; attempt += 1) {
          try {
            if ((await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; }
          } catch (error) {
            if (!["TypeError", "TimeoutError"].includes(error.name)) throw error;
          }
          await delay(100);
        }
        expect(ready, `Disposable rollout server startup: ${spawnError?.message || output}`).toBe(true);
      };
      await start();
      const readInterface = async () => {
        const response = await request.get(`${baseURL}${INTERFACE_PATH}`);
        expect(response.ok()).toBe(true);
        const payload = await response.json();
        expect(payload.ok).toBe(true);
        return payload.data;
      };
      const newPage = async ({ storage = {}, origin = baseURL, unavailable = false, viewport = { width: 1440, height: 900 } } = {}) => {
        const context = await browser.newContext({
          viewport, reducedMotion: "reduce", serviceWorkers: "block",
          storageState: { cookies: [], origins: [{ origin, localStorage: Object.entries(storage).map(([name, value]) => ({ name, value })) }] },
        });
        contexts.push(context);
        await instrumentStorage(context, unavailable);
        const page = await context.newPage();
        const audit = { reads: [], mutations: [], failures: [], pending: new Set(), lastActivity: Date.now() };
        const relevant = req => new URL(req.url()).pathname === INTERFACE_PATH;
        page.on("request", req => {
          if (!relevant(req)) return;
          audit.pending.add(req);
          audit.lastActivity = Date.now();
          if (!["GET", "HEAD"].includes(req.method())) audit.mutations.push({ method: req.method(), body: req.postDataJSON() });
        });
        page.on("requestfinished", req => {
          if (!relevant(req)) return;
          audit.pending.delete(req);
          audit.lastActivity = Date.now();
          if (req.method() === "GET") audit.reads.push(req.url());
        });
        page.on("requestfailed", req => {
          if (!relevant(req)) return;
          audit.pending.delete(req);
          audit.failures.push(req.failure()?.errorText);
        });
        audits.push(audit);
        return { page, context, audit, origin };
      };
      await testInfo.attach("rollout pre-boot evidence", {
        body: JSON.stringify({ rolloutState, absentBeforeBoot, defaultSettingsTarget: settingsFile === defaultSettings, agentDirectoryOverride: false }), contentType: "application/json",
      });
      await use({
        baseURL, alternateURL, newPage, readInterface,
        rawSettings: async () => JSON.parse(await readFile(settingsFile, "utf8")),
        restart: async () => { await stopServer(child); await start(); },
      });
    } finally {
      try {
        for (const context of contexts) await context.close();
      } finally {
        try {
          await stopServer(child);
          await testInfo.attach("disposable rollout server log", { body: output, contentType: "text/plain" });
          await testInfo.attach("interface request audit", {
            body: JSON.stringify(audits.map(({ reads, mutations, failures }) => ({ reads, mutations, failures })), null, 2), contentType: "application/json",
          });
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
});
