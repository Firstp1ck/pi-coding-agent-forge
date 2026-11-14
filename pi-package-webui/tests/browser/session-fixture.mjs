import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "@playwright/test";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopServer(child) {
  if (!child?.pid) return;
  const signalGroup = (signal) => {
    try { process.kill(-child.pid, signal); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  let timer;
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve));
  try {
    signalGroup("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 3_000); })]);
  } finally {
    clearTimeout(timer);
    // A server exit can precede its fake-Pi descendants' shutdown.
    signalGroup("SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
}

export const test = base.extend({
  ownership: async ({ request }, use, testInfo) => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-session-ownership-"));
    let child;
    let output = "";
    let spawnError;
    try {
      const project = join(root, "project");
      const agent = join(root, "agent");
      const sessions = join(root, "sessions");
      for (const directory of [project, agent, sessions, join(root, "home")]) await mkdir(directory);
      await writeFile(join(root, "settings.json"), "{}\n");
      const sessionPath = join(sessions, "ownership-resume.jsonl");
      const timestamp = "2026-01-01T00:00:00.000Z";
      await writeFile(sessionPath, [
        { type: "session", version: 3, id: "ownership-resume", timestamp, cwd: project },
        { type: "message", id: "seed-user", parentId: null, timestamp, message: { role: "user", content: "Ownership resume target", timestamp: Date.parse(timestamp) } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

      const baseURL = `http://127.0.0.1:${await freePort()}`;
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_") && !key.startsWith("FAKE_PI_")));
      child = spawn(process.execPath, [
        join(packageRoot, "bin/pi-webui.mjs"), "--cwd", project,
        "--host", "127.0.0.1", "--port", new URL(baseURL).port,
        "--pi", join(packageRoot, "tests/fixtures/fake-pi.mjs"),
        "--", "--session-dir", sessions,
      ], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...env, NODE_ENV: "test", HOME: join(root, "home"),
          XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
          PI_CODING_AGENT_DIR: agent, PI_WEBUI_SETTINGS_FILE: join(root, "settings.json"),
          PI_WEBUI_UPDATE_TEST_HOME: join(root, "update-coordination"), PI_WEBUI_RPC_SUPERVISOR: "0",
          FAKE_PI_SESSION_OWNERSHIP: "1", FAKE_PI_CONTINUITY_MODE: "1",
        },
      });
      child.on("error", (error) => { spawnError = error; });
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-32_000); });

      let ready = false;
      for (let attempt = 0; attempt < 80 && child.exitCode === null && !spawnError; attempt += 1) {
        try {
          if ((await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; }
        } catch (error) {
          if (!["TypeError", "TimeoutError"].includes(error.name)) throw error;
        }
        await delay(100);
      }
      expect(ready, `Disposable server startup: ${spawnError?.message || output}`).toBe(true);
      const api = async (pathname, data) => {
        const response = await request.fetch(`${baseURL}${pathname}`, {
          method: data === undefined ? "GET" : "POST", data, timeout: 8_000,
        });
        const payload = await response.json();
        expect(response.ok() && payload.ok !== false && payload.success !== false, `${pathname}: ${JSON.stringify(payload)}`).toBe(true);
        return payload.data;
      };
      const initial = (await api("/api/tabs")).tabs;
      expect(initial).toHaveLength(1);
      const second = (await api("/api/tabs", {})).tab;
      expect(second.id).not.toBe(initial[0].id);
      await use({ baseURL, api, tabs: [initial[0], second], sessionPath });
    } finally {
      try {
        await stopServer(child);
        await testInfo.attach("disposable server log", { body: output, contentType: "text/plain" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
});

