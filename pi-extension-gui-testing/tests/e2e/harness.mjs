/**
 * Shared e2e plumbing. Every e2e test needs a reachable rootful local Docker
 * daemon; without one the tests are skipped with the reason (never failed).
 * The base image is built once from the package's Dockerfile through the same
 * staged-context path `/gui-setup --fix` uses.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerLinuxBackend } from "../../src/backends/docker-linux.ts";
import { inspectImage, baseImageProblem } from "../../src/backends/docker/image.ts";
import { GuiRuntime } from "../../src/tools/runtime.ts";
import { createGuiTools } from "../../src/tools/tools.ts";
import { createOwnerIdentity } from "../../src/cleanup/identity.ts";
import { formatOwnerLabel } from "../../src/owner.ts";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = join(HERE, "..", "..");
export const TESTAPPS = join(PACKAGE_ROOT, "testapps");
export const FIXTURES = join(HERE, "fixtures");

/** Why e2e tests cannot run here, or `undefined` when Docker is usable. */
export function dockerSkipReason() {
  const info = spawnSync("docker", ["info", "--format", "{{json .}}"], { encoding: "utf8", timeout: 20_000 });
  if (info.error?.code === "ENOENT") return "docker CLI not found; e2e tests need a local rootful Docker daemon";
  if (info.error) return `docker info failed: ${info.error.message}`;
  if (info.status !== 0) return `Docker daemon not reachable: ${(info.stderr || info.stdout).trim().split("\n")[0]}`;
  try {
    const parsed = JSON.parse(info.stdout);
    if ((parsed.SecurityOptions ?? []).some((s) => /name=rootless/.test(s))) return "rootless Docker is not supported in M1";
    if (parsed.OSType !== "linux") return `Docker OSType is ${parsed.OSType}`;
  } catch {
    return "docker info printed no JSON";
  }
  return undefined;
}

/** `true` when the host can reach the package mirrors (PySide6/Electron setup downloads). */
export function networkSkipReason() {
  if (process.env.PI_GUI_E2E_OFFLINE) return "PI_GUI_E2E_OFFLINE is set";
  return undefined;
}

export function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", timeout: options.timeoutMs ?? 60_000, ...options });
}

/**
 * Runs a read-only Docker query and returns its non-empty output lines.
 * Throws on a spawn error, a timeout, or a non-zero exit, so a failed query
 * can never pass for "nothing left".
 */
export function dockerQuery(args, options = {}) {
  const result = docker(args, options);
  if (result.error) throw new Error(`docker ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")} exited ${result.status ?? result.signal}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  return result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Ids of every object labelled with `session` (containers, volumes, networks). Throws when a query fails. */
export function labelled(session) {
  const filter = session ? `label=pi-gui-testing.session=${session}` : "label=pi-gui-testing.session";
  const out = [];
  for (const args of [["ps", "-aq"], ["volume", "ls", "-q"], ["network", "ls", "-q"]]) out.push(...dockerQuery([...args, "--filter", filter]));
  return out;
}

/** Ids of containers carrying owner label `owner`. Throws when the query fails. */
export function ownedContainers(owner) {
  return dockerQuery(["ps", "-aq", "--filter", `label=pi-gui-testing.owner=${owner}`]);
}

export async function waitFor(predicate, timeoutMs, stepMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return Date.now() - started;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return undefined;
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

let imageReady;

/** Builds the base image when it is missing or stale (minutes on the first run). */
export function ensureBaseImage(backend) {
  imageReady ??= (async () => {
    const endpoint = await backend.endpoint();
    const image = await inspectImage(backend.runner, endpoint, backend.imageTag);
    if (image && !baseImageProblem(image, backend.version)) return;
    const result = await backend.buildImage(new AbortController().signal, (line) => process.env.PI_GUI_E2E_VERBOSE && process.stderr.write(`${line}\n`));
    if (result.exitCode !== 0) throw new Error(`base image build failed:\n${result.stderr.slice(-3000)}`);
  })();
  return imageReady;
}

export function ownerLabel() {
  return formatOwnerLabel(createOwnerIdentity());
}

/**
 * A runtime on the real backend with a temp global config whose verified
 * record matches the current Docker server and image (as setup would write).
 */
export async function e2eRuntime(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "gui-e2e-"));
  await chmod(root, 0o755);
  const tmp = join(root, "tmp");
  await mkdir(tmp, { mode: 0o755 });
  const globalConfigPath = join(root, "agent", "gui", "config.json");
  const runtime = new GuiRuntime({ docker: options.backend ?? {}, tmpRoot: tmp, globalConfigPath, ...(options.now ? { now: options.now } : {}) });
  t.after(async () => {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const backend = runtime.backend("docker-linux");
  await ensureBaseImage(backend);
  if (options.verified !== false) {
    await mkdir(dirname(globalConfigPath), { recursive: true });
    const toolVersions = await backend.currentVersions();
    await writeFile(globalConfigPath, JSON.stringify({ version: 1, backend: "docker-linux", verified: { "docker-linux": { verifiedAt: new Date().toISOString(), toolVersions, checksPassed: [] } } }));
  }
  const tools = Object.fromEntries(createGuiTools(runtime).map((tool) => [tool.name, tool]));
  return { root, tmp, globalConfigPath, runtime, backend, tools };
}

/** A project dir with `.pi/gui.json`, readable by other UIDs (for the non-host-UID test). */
export async function project(root, files, gui) {
  const dir = await mkdtemp(join(root, "project-"));
  await chmod(dir, 0o755);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true, mode: 0o755 });
    await writeFile(join(dir, path), content, { mode: 0o644 });
  }
  if (gui) {
    await mkdir(join(dir, ".pi"), { recursive: true, mode: 0o755 });
    await writeFile(join(dir, ".pi", "gui.json"), JSON.stringify(gui));
  }
  return dir;
}

export function ctx(cwd, overrides = {}) {
  return {
    cwd,
    hasUI: false,
    mode: "print",
    sessionManager: { getSessionId: () => "pi-e2e" },
    ui: { notify() {}, setStatus() {}, select: async () => undefined, confirm: async () => false, input: async () => undefined },
    ...overrides,
  };
}

export const run = (tool, params, context, signal) => tool.execute("e2e", params, signal, undefined, context);
export const textOf = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** Constructs a bare backend (no runtime) for checks and negative tests. */
export function bareBackend(options = {}) {
  return new DockerLinuxBackend({ ownerLabel, ...options });
}
