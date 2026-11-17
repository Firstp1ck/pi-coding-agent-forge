import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test as base } from "@playwright/test";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

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

async function logEntries(file) {
  const text = await readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
}

async function stopServer(child) {
  if (!child?.pid) return;
  const signalGroup = signal => {
    try { process.kill(-child.pid, signal); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  let timer;
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise(resolve => child.once("exit", resolve));
  try {
    signalGroup("SIGTERM");
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3_000); })]);
  } finally {
    clearTimeout(timer);
    // The server may exit before its fake Pi descendants.
    signalGroup("SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
}

export const test = base.extend({
  emptyStartup: async ({ request }, use, info) => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-empty-startup-"));
    const coordinationRoot = await mkdtemp(join(tmpdir(), "pi-webui-empty-coordination-"));
    const agent = join(root, "agent");
    const ownedRoot = join(agent, "webui", "no-project");
    const startsFile = join(root, "starts.jsonl");
    const failFile = join(root, "fail-launch");
    const wrapper = join(root, "fake-wrapper.mjs");
    let child;
    let output = "";
    let spawnError;
    try {
      const env = {
        PATH: process.env.PATH, NODE_ENV: "test", HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_RUNTIME_DIR: join(root, "runtime"),
        npm_config_cache: join(root, "npm-cache"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        PI_CODING_AGENT_DIR: agent, PI_WEBUI_SETTINGS_FILE: join(root, "settings.json"),
        PI_WEBUI_WORKSPACES_FILE: join(root, "workspaces.json"), PI_WEBUI_SESSION_SUMMARY_DIR: join(root, "summaries"),
        PI_WEBUI_UPDATE_TEST_HOME: coordinationRoot, PI_WEBUI_RPC_SUPERVISOR: "0",
        FAKE_PI_SESSION_OWNERSHIP: "1", FAKE_PI_TRANSCRIPT_JSON: "[]",
      };
      for (const directory of [agent, env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.XDG_DATA_HOME, env.XDG_RUNTIME_DIR]) {
        await mkdir(directory, { recursive: true });
      }
      await writeFile(env.PI_WEBUI_SETTINGS_FILE, "{}\n");
      // Match the real no-project HTTP harness, with per-process command logs
      // so assertions can identify the actual child cwd receiving each prompt.
      await writeFile(wrapper, `import { appendFileSync, existsSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("0.0.0-test"); process.exit(0); }
process.env.FAKE_PI_LOG_FILE = ${JSON.stringify(root)} + "/commands-" + process.pid + ".jsonl";
appendFileSync(${JSON.stringify(startsFile)}, JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2), pid: process.pid, commands: process.env.FAKE_PI_LOG_FILE}) + "\\n");
if (existsSync(${JSON.stringify(failFile)})) process.exit(42);
await import(${JSON.stringify(pathToFileURL(join(packageRoot, "tests/fixtures/fake-pi.mjs")).href)});
`);
      const baseURL = `http://127.0.0.1:${await freePort()}`;
      child = spawn(process.execPath, [
        join(packageRoot, "bin/pi-webui.mjs"), "--host", "127.0.0.1", "--port", new URL(baseURL).port,
        "--pi", wrapper, "--", "--session-dir", join(root, "sessions"),
      ], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], env });
      child.on("error", error => { spawnError = error; });
      for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-32_000); });
      let ready = false;
      for (let attempt = 0; attempt < 100 && child.exitCode === null && !spawnError; attempt += 1) {
        try {
          const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) });
          if (response.ok && (await response.json()).optionalFeatures?.ready !== false) { ready = true; break; }
        } catch (error) {
          if (!["TypeError", "TimeoutError"].includes(error.name)) throw error;
        }
        await delay(100);
      }
      expect(ready, `Disposable startup: ${spawnError?.message || output}`).toBe(true);
      const api = async (pathname, data) => {
        const response = await request.fetch(`${baseURL}${pathname}`, {
          method: data === undefined ? "GET" : "POST", data, timeout: 8_000,
        });
        const payload = await response.json();
        expect(response.ok() && payload.ok !== false && payload.success !== false, `${pathname}: ${JSON.stringify(payload)}`).toBe(true);
        return payload.data;
      };
      await use({
        baseURL, api, root, ownedRoot, failFile,
        starts: () => logEntries(startsFile),
        commands: async () => (await Promise.all((await logEntries(startsFile)).map(async start =>
          (await logEntries(start.commands)).map(command => ({ ...command, cwd: start.cwd, pid: start.pid }))))).flat(),
        ownedDirectories: () => readdir(ownedRoot).catch(error => {
          if (error.code === "ENOENT") return [];
          throw error;
        }),
      });
    } finally {
      try {
        await stopServer(child);
        await info.attach("disposable server log", { body: output, contentType: "text/plain" });
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(coordinationRoot, { recursive: true, force: true });
      }
    }
  },
});
