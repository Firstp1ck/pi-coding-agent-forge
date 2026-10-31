/**
 * A complete fake environment for tools and commands: a GuiRuntime whose
 * docker-linux backend talks to the fake Docker CLI and fake helper, a temp
 * project with `.pi/gui.json`, a temp global config, and a stub Pi context.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuiRuntime } from "../../../src/tools/runtime.ts";
import { addContainer, fakeDocker, fakeSpawner, parseRunArgv } from "./fakes.mjs";

export const VERIFIED = {
  verifiedAt: "2026-10-24T00:00:00.000Z",
  toolVersions: {
    "package.version": "0.1.0",
    "pi.version": "1.4.0",
    protocol: "2",
    "docker.cli": "29.9.1",
    "docker.server": "29.9.1",
    "image.base": "0.1.0",
    "image.id": "sha256:35eede0900000000000000000000000000000000000000000000000000000000",
  },
  checksPassed: ["docker.cli"],
};

export async function fakeEnv(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "gui-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const tmp = join(root, "tmp");
  const globalConfigPath = join(root, "agent", "gui", "config.json");
  await mkdir(join(project, ".pi"), { recursive: true });
  await mkdir(tmp);
  await writeFile(join(project, "app.py"), "print(1)\n");
  await writeFile(join(project, ".pi", "gui.json"), JSON.stringify({ launch: { cmd: "python3", args: ["app.py"] }, ...options.shared }));
  if (options.local) await writeFile(join(project, ".pi", "gui.local.json"), JSON.stringify(options.local));
  if (options.verified !== false) {
    await mkdir(join(root, "agent", "gui"), { recursive: true });
    await writeFile(globalConfigPath, JSON.stringify({ version: 1, verified: { "docker-linux": options.verifiedRecord ?? VERIFIED }, ...options.global }));
  }
  const { runner, state } = fakeDocker(options.docker);
  const spawner = fakeSpawner({
    ...options.behaviour,
    onSpawn(child) {
      if (child.argv.includes("build")) {
        child.stdin.removeAllListeners("finish");
        child.stdin.on("finish", () => {
          state.imageMissing = false;
          setImmediate(() => child.exit(0));
        });
        return;
      }
      addContainer(state, child.argv, child.env);
      const name = parseRunArgv(child.argv).one("--name");
      void child.exited.then(() => state.containers.delete(name));
      options.behaviour?.onSpawn?.(child, state);
    },
  });
  let clock = options.clock ?? 1_000_000;
  const runtime = new GuiRuntime({
    docker: { runner, spawner, endpointSource: {}, version: "0.1.0", common: { configDir: root, diskPath: root, minFreeBytes: 1, piVersion: "1.4.0", platform: "linux" }, ...options.docker?.backend },
    tmpRoot: tmp,
    globalConfigPath,
    // Hermetic: the dependency cache lives in the test's temp root, never in ~/.cache.
    depsCacheRoot: join(root, "deps-cache"),
    dockerOnPath: async () => options.dockerOnPath ?? false,
    ...(options.manualClock ? { now: () => clock } : {}),
    ...options.runtime,
    // Hermetic: a real `cua` or `docker` on PATH, or a real Windows host, is never asked (the other backends' sweeps need no tools or use tmpRoot).
    backendOptions: {
      cua: { cuaOnPath: async () => false },
      "docker-windows": { dockerOnPath: async () => false },
      "local-windows": { platform: "linux" },
      ...options.runtime?.backendOptions,
    },
  });
  t.after(() => runtime.shutdown());
  const notes = [];
  const uiCalls = [];
  const ctx = (overrides = {}) => ({
    cwd: project,
    hasUI: false,
    mode: "print",
    sessionManager: { getSessionId: () => "pi-test-session" },
    ui: {
      notify: (message, type) => notes.push({ message, type }),
      setStatus: (key, text) => uiCalls.push(["setStatus", key, text]),
      select: async (...args) => (uiCalls.push(["select", ...args]), overrides.answers?.select),
      confirm: async (...args) => (uiCalls.push(["confirm", ...args]), overrides.answers?.confirm ?? false),
      input: async (...args) => (uiCalls.push(["input", ...args]), undefined),
    },
    ...overrides,
  });
  return {
    root,
    depsCacheRoot: join(root, "deps-cache"),
    project,
    tmp,
    globalConfigPath,
    runner,
    state,
    spawner,
    runtime,
    ctx,
    notes,
    uiCalls,
    advance: (ms) => (clock += ms),
  };
}
