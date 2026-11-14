import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test as base } from "@playwright/test";

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const artifactRoot = join(packageRoot, "test-results/overhaul-baseline");
export const sourceBaseline = "06351edae0d87829dfa8c747d31a061825568b0e";
export const seedBaseline = "cff3432ee63131ebb6150a906d9c06594ca2c401";
export const fixedPrompt = "Baseline draft: inspect the changed README and preserve session isolation.";
export const streamPrompt = "voice test slow";
export const streamFinal = "This is a long streaming answer that keeps going.";
const runFile = promisify(execFile);

export const fixtureContract = {
  sessions: 3,
  project: "isolated Git repository, one modified README and 120 fixed text files",
  transcript: "existing fake Pi: fake prompt / fake answer / fake follow-up; identical in each session",
  companions: "none installed; fake Pi advertises its existing commands and voice/continuity event scripts",
  streaming: { prompt: streamPrompt, finalText: streamFinal, chunks: 5, spacingMs: 500 },
  blocked: { prompt: "fixture mobile blocker", title: "Fixture blocker", id: "fixture_blocker_12345678" },
  browser: { locale: "en-US", timezone: "UTC", reducedMotion: "reduce", serviceWorkers: "block", colorScheme: "dark" },
};

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function api(request, baseURL, pathname, data, method = data === undefined ? "GET" : "POST") {
  const response = await request.fetch(`${baseURL}${pathname}`, { method, data, timeout: 10_000 });
  const payload = await response.json();
  assert.ok(response.ok() && payload.ok !== false, `${method} ${pathname}: ${JSON.stringify(payload)}`);
  return payload.data;
}

async function stopProcessGroup(child) {
  const send = (signal) => {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
  send("SIGTERM");
  let timer;
  try {
    await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 3000); })]);
  } finally {
    clearTimeout(timer);
    // The server may exit before its fake Pi descendants finish shutting down.
    send("SIGKILL");
  }
}

export async function startFixture(request) {
  const root = await mkdtemp(join(tmpdir(), "pi-overhaul-baseline-"));
  let child;
  try {
    const project = join(root, "project");
    const agent = join(root, "agent");
    await mkdir(project);
    await mkdir(join(agent, "themes"), { recursive: true });
    await mkdir(join(root, "home"));
    await writeFile(join(root, "settings.json"), "{}\n");
    await writeFile(join(project, "README.md"), "# Baseline project\n\nFixed project context.\n");
    await writeFile(join(project, "baseline-runner.mjs"), 'console.log("BASELINE RUNNER OUTPUT");\n');
    for (let index = 0; index < 120; index += 1) {
      await writeFile(join(project, `context-${String(index).padStart(3, "0")}.txt`), `Fixed context ${index}\n`);
    }
    const gitEnv = { ...process.env, HOME: join(root, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (...args) => runFile("git", args, { cwd: project, env: gitEnv, timeout: 10_000 });
    await git("init", "-b", "baseline");
    await git("add", ".");
    await git("-c", "user.name=Baseline", "-c", "user.email=baseline@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Baseline fixture");
    await writeFile(join(project, "README.md"), "# Baseline project\n\nFixed project context with a changed line.\n");
    const theme = JSON.parse(await readFile(join(packageRoot, "../pi-package-themes-bundle/themes/catppuccin-mocha.json"), "utf8"));
    theme.name = "overhaul-custom";
    theme.colors.accent = "#f5c2e7";
    await writeFile(join(agent, "themes/overhaul-custom.json"), JSON.stringify(theme));
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${port}`;
    let output = "";
    child = spawn(process.execPath, [join(packageRoot, "bin/pi-webui.mjs"), "--cwd", project, "--host", "127.0.0.1", "--port", String(port), "--pi", join(packageRoot, "tests/fixtures/fake-pi.mjs")], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        PI_CODING_AGENT_DIR: agent,
        PI_WEBUI_SETTINGS_FILE: join(root, "settings.json"),
        PI_WEBUI_UPDATE_TEST_HOME: join(root, "update-coordination"),
        PI_WEBUI_RPC_SUPERVISOR: "0",
        FAKE_PI_CONTINUITY_MODE: "1",
        FAKE_PI_VOICE_SCRIPTS: "1",
        FAKE_PI_LOG_FILE: join(root, "fake-pi.jsonl"),
      },
    });
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-32_000); });
    child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-32_000); });
    let ready = false;
    for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt += 1) {
      try {
        if ((await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; }
      } catch (error) {
        if (!['TypeError', 'TimeoutError'].includes(error.name)) throw error;
      }
      await delay(100);
    }
    assert.ok(ready, `Isolated server did not start:\n${output}`);
    let tabs = (await api(request, baseURL, "/api/tabs")).tabs;
    for (let attempt = 0; tabs.length < 3 && attempt < 3; attempt += 1) {
      await api(request, baseURL, "/api/tabs", {});
      tabs = (await api(request, baseURL, "/api/tabs")).tabs;
    }
    assert.equal(tabs.length, 3);
    const [first] = tabs;
    await api(request, baseURL, "/api/app-runner-config", { tab: first.id, runner: { label: "Baseline runner", command: process.execPath, path: "baseline-runner.mjs" } });
    return { root, project, baseURL, tabs, child, output: () => output };
  } catch (error) {
    if (child) await stopProcessGroup(child);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export const test = base.extend({
  fixture: async ({ request }, use) => {
    const fixture = await startFixture(request);
    try { await use(fixture); } finally {
      await stopFixture(fixture);
    }
  },
});

export async function stopFixture(fixture) {
  await stopProcessGroup(fixture.child);
  await rm(fixture.root, { recursive: true, force: true });
}

export async function openFixture(page, fixture, query = "") {
  const params = new URLSearchParams(process.env.PI_OVERHAUL_QUERY || "");
  for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
  params.set("tab", fixture.tabs[0].id);
  await page.goto(`${fixture.baseURL}/?${params}`);
  await expect(page.locator("#promptInput")).toBeVisible();
  await expect(page.locator("#chat")).toContainText("fake answer");
  await page.evaluate(() => document.fonts.ready);
}

export async function promptFixture(page, fixture, message, index) {
  return api(page.request, fixture.baseURL, `/api/prompt?tab=${encodeURIComponent(fixture.tabs[0].id)}`, { message, requestId: `overhaul-${index}` });
}

export async function waitIdle(page, fixture) {
  await expect.poll(async () => (await api(page.request, fixture.baseURL, `/api/state?tab=${encodeURIComponent(fixture.tabs[0].id)}`)).isStreaming).toBe(false);
  await expect(page.locator("#chat .message.assistant.streaming")).toHaveCount(0);
}
