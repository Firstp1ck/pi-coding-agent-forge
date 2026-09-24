import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { updateStatePaths } from "./journal.mjs";

const POINTER_SCHEMA = 1;
const RESTORE_SCHEMA = 1;
const MAX_RESTORE_TABS = 256;
const MAX_RESTORE_BYTES = 2 * 1024 * 1024;

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function managedRuntimePaths(agentDir) {
  const root = updateStatePaths(agentDir).root;
  return Object.freeze({
    root,
    runtimesDir: path.join(root, "runtimes"),
    tempDir: path.join(root, "tmp"),
    currentPointer: path.join(root, "current.json"),
    previousPointer: path.join(root, "previous.json"),
  });
}

async function privateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600).catch(() => undefined);
  try { await rename(temporary, file); } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  await chmod(file, 0o600).catch(() => undefined);
}

export async function readRuntimePointer(agentDir, name = "current") {
  if (!new Set(["current", "previous"]).has(name)) throw new TypeError("pointer name must be current or previous");
  const paths = managedRuntimePaths(agentDir);
  const file = name === "current" ? paths.currentPointer : paths.previousPointer;
  let pointer;
  try { pointer = JSON.parse(await readFile(file, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
  const runtimeRoot = typeof pointer?.runtimeRoot === "string" ? path.resolve(pointer.runtimeRoot) : "";
  const serverEntry = typeof pointer?.serverEntry === "string" ? path.resolve(pointer.serverEntry) : "";
  if (pointer?.schemaVersion !== POINTER_SCHEMA || !runtimeRoot || !serverEntry || !inside(paths.runtimesDir, runtimeRoot) || !inside(runtimeRoot, serverEntry)) return null;
  try {
    if (!(await stat(runtimeRoot)).isDirectory() || !(await stat(serverEntry)).isFile()) return null;
    const [canonicalRuntimesDir, canonicalRuntimeRoot, canonicalServerEntry] = await Promise.all([
      realpath(paths.runtimesDir),
      realpath(runtimeRoot),
      realpath(serverEntry),
    ]);
    if (!inside(canonicalRuntimesDir, canonicalRuntimeRoot) || !inside(canonicalRuntimeRoot, canonicalServerEntry)) return null;
    return Object.freeze({ ...pointer, runtimeRoot: canonicalRuntimeRoot, serverEntry: canonicalServerEntry });
  } catch { return null; }
}

export async function writeRuntimePointer(agentDir, name, pointer) {
  if (!new Set(["current", "previous"]).has(name)) throw new TypeError("pointer name must be current or previous");
  const paths = managedRuntimePaths(agentDir);
  const runtimeRoot = path.resolve(String(pointer?.runtimeRoot || ""));
  const serverEntry = path.resolve(String(pointer?.serverEntry || ""));
  if (!inside(paths.runtimesDir, runtimeRoot) || !inside(runtimeRoot, serverEntry)) throw Object.assign(new Error("Managed runtime pointer escapes the private runtime root."), { code: "UPDATE_POINTER_ESCAPE" });
  let canonicalRuntimesDir;
  let canonicalRuntimeRoot;
  let canonicalServerEntry;
  try {
    [canonicalRuntimesDir, canonicalRuntimeRoot, canonicalServerEntry] = await Promise.all([
      realpath(paths.runtimesDir),
      realpath(runtimeRoot),
      realpath(serverEntry),
    ]);
  } catch {
    throw Object.assign(new Error("Managed runtime pointer target is incomplete."), { code: "UPDATE_POINTER_INCOMPLETE" });
  }
  if (!inside(canonicalRuntimesDir, canonicalRuntimeRoot) || !inside(canonicalRuntimeRoot, canonicalServerEntry)) {
    throw Object.assign(new Error("Managed runtime pointer resolves outside the private runtime root."), { code: "UPDATE_POINTER_ESCAPE" });
  }
  const record = { schemaVersion: POINTER_SCHEMA, runtimeRoot: canonicalRuntimeRoot, serverEntry: canonicalServerEntry, version: String(pointer.version || ""), activatedAt: pointer.activatedAt || new Date().toISOString() };
  await privateJson(name === "current" ? paths.currentPointer : paths.previousPointer, record);
  return Object.freeze(record);
}

export async function switchRuntimePointer(agentDir, candidate) {
  const current = await readRuntimePointer(agentDir, "current");
  if (current) await writeRuntimePointer(agentDir, "previous", current);
  const next = await writeRuntimePointer(agentDir, "current", candidate);
  return Object.freeze({ current: next, previous: current });
}

export async function rollbackRuntimePointer(agentDir) {
  const paths = managedRuntimePaths(agentDir);
  const previous = await readRuntimePointer(agentDir, "previous");
  const current = await readRuntimePointer(agentDir, "current");
  if (!previous) {
    await rm(paths.currentPointer, { force: true });
    if (current) await writeRuntimePointer(agentDir, "previous", current);
    return Object.freeze({ current: null, previous: current, bootstrapFallback: true });
  }
  await writeRuntimePointer(agentDir, "current", previous);
  if (current) await writeRuntimePointer(agentDir, "previous", current);
  return Object.freeze({ current: previous, previous: current, bootstrapFallback: false });
}

function normalizeRestoreTab(item, seen) {
  if (!item || typeof item !== "object") return null;
  const text = (value, max) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
  const rawId = text(item.id, 128);
  const id = rawId && /^[A-Za-z0-9._:-]+$/.test(rawId) && !seen.has(rawId) ? rawId : undefined;
  if (id) seen.add(id);
  const tab = { id, title: text(item.title, 160), titleSource: text(item.titleSource, 32), cwd: text(item.cwd, 4096), sessionFile: text(item.sessionFile, 4096), conversationStarted: item.conversationStarted === true };
  if (Number.isInteger(item.index) && item.index > 0) tab.index = item.index;
  return tab;
}

export async function createRestoreFile(agentDir, tabs, { now = () => new Date() } = {}) {
  const paths = managedRuntimePaths(agentDir);
  const seen = new Set();
  const normalized = (Array.isArray(tabs) ? tabs : []).map((item) => normalizeRestoreTab(item, seen)).filter(Boolean).slice(0, MAX_RESTORE_TABS);
  const payload = { schemaVersion: RESTORE_SCHEMA, createdAt: now().toISOString(), tabs: normalized };
  const encoded = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(encoded) > MAX_RESTORE_BYTES) throw Object.assign(new Error("Restore descriptor file exceeds the private handoff limit."), { code: "RESTORE_FILE_TOO_LARGE" });
  await mkdir(paths.tempDir, { recursive: true, mode: 0o700 });
  const file = path.join(paths.tempDir, `restore-${randomUUID()}.json`);
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(encoded, "utf8"); await handle.sync(); } finally { await handle.close(); }
  return Object.freeze({ file, count: normalized.length });
}

export async function readRestoreFileOnce(file, agentDir) {
  if (!file) return [];
  const paths = managedRuntimePaths(agentDir);
  const resolved = path.resolve(file);
  if (!inside(paths.tempDir, resolved)) throw Object.assign(new Error("Restore descriptor path is outside the private temp root."), { code: "RESTORE_FILE_ESCAPE" });
  let raw;
  try {
    const info = await stat(resolved);
    if (!info.isFile() || info.size > MAX_RESTORE_BYTES) throw new Error("Restore descriptor is not a bounded file.");
    raw = await readFile(resolved, "utf8");
  } finally {
    await rm(resolved, { force: true }).catch(() => undefined);
  }
  const parsed = JSON.parse(raw);
  if (parsed?.schemaVersion !== RESTORE_SCHEMA || !Array.isArray(parsed.tabs) || parsed.tabs.length > MAX_RESTORE_TABS) throw new Error("Restore descriptor schema is invalid.");
  const seen = new Set();
  return parsed.tabs.map((item) => normalizeRestoreTab(item, seen)).filter(Boolean);
}

export async function sweepRestoreFiles(agentDir, { olderThanMs = 24 * 60 * 60_000, now = Date.now() } = {}) {
  const { tempDir } = managedRuntimePaths(agentDir);
  let entries = [];
  try { entries = await readdir(tempDir); } catch (error) { if (error?.code === "ENOENT") return 0; throw error; }
  let removed = 0;
  for (const name of entries.filter((entry) => /^restore-[a-f0-9-]+\.json$/i.test(entry))) {
    const file = path.join(tempDir, name);
    try { if (now - (await stat(file)).mtimeMs > olderThanMs) { await rm(file, { force: true }); removed += 1; } } catch {}
  }
  return removed;
}

export async function listenWithRetry(server, { port, host, attempts = 40, initialDelayMs = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError); server.once("listening", onListening); server.listen(port, host);
      });
      return attempt + 1;
    } catch (error) {
      if (error?.code !== "EADDRINUSE" || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, initialDelayMs));
    }
  }
  throw new Error("Listener retry exhausted.");
}

export async function probeCandidateRuntime(serverEntry, { expectedVersion, expectedPiVersion, timeoutMs = 20_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(process.execPath, [serverEntry, "--candidate-probe"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PI_WEBUI_CANDIDATE_PROBE: "1" } });
    let stdout = "", stderr = "", settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(Object.freeze(result)); };
    child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk).slice(-16_000); });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16_000); });
    child.once("error", (error) => finish({ ok: false, error: String(error.message || error), stdout, stderr }));
    child.once("close", (code) => {
      let data = null;
      try { data = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); } catch {}
      const ok = code === 0
        && data?.ok === true
        && (!expectedVersion || data.version === expectedVersion)
        && (!expectedPiVersion || data.piVersion === expectedPiVersion);
      finish({ ok, code, data, stdout, stderr, error: ok ? "" : "Candidate probe did not verify the expected Web UI runtime." });
    });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish({ ok: false, timedOut: true, stdout, stderr, error: "Candidate probe timed out." }); }, timeoutMs);
    timer.unref?.();
  });
}

async function freeLoopbackPort() {
  const socket = createNetServer();
  await new Promise((resolve, reject) => socket.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

/** Exercise real candidate startup and restoration in an isolated disposable agent directory. */
export async function probeStartupRestore(serverEntry, { expectedVersion, spawnImpl = spawn, timeoutMs = 20_000, piCommand = "" } = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), "pi-webui-startup-probe-"));
  const agentDir = path.join(temp, "agent");
  const restore = await createRestoreFile(agentDir, [{ id: "probe-tab", title: "Temporary startup probe", cwd: temp }]);
  const port = await freeLoopbackPort();
  // Every verification probe needs its own coordination domain: an active
  // update deliberately fences the real installation until this check passes.
  const env = { ...process.env, PI_WEBUI_UPDATE_TEST_HOME: temp,
    PI_CODING_AGENT_DIR: agentDir, PI_WEBUI_RESTORE_FILE: restore.file,
    PI_WEBUI_STARTUP_PROBE: "1", PI_WEBUI_RPC_SUPERVISOR: "0", PI_WEBUI_NPM_BIN: path.join(temp, "absent-npm"),
    PI_WEBUI_SETTINGS_FILE: path.join(temp, "webui-settings.json") };
  const child = spawnImpl(process.execPath, [serverEntry, "--host", "127.0.0.1", "--port", String(port), "--cwd", temp, "--no-session", ...(piCommand ? ["--pi", piCommand] : [])],
    { cwd: temp, env, windowsHide: true, stdio: "ignore" });
  let exited = false;
  child.once("error", () => { exited = true; });
  child.once("exit", () => { exited = true; });
  const deadline = Date.now() + timeoutMs;
  let result = { ok: false, error: "Candidate did not complete isolated startup and restored-tab health check." };
  try {
    while (Date.now() < deadline && !exited) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/update/startup-probe`, { signal: AbortSignal.timeout(600) });
        const body = await response.json();
        if (response.ok && body?.ok === true && body.data?.schemaVersion === 1 && body.data?.packageName === "@firstpick/pi-package-webui" &&
            body.data?.version === expectedVersion && body.data?.restoredTabCount === 1 &&
            body.data?.restoredProbeTabHealthy === true && body.data?.runningTabCount >= 1) {
          result = { ok: true, version: body.data.version, bootIdentity: body.data.bootIdentity };
          break;
        }
      } catch { /* Wait only for this disposable local candidate. */ }
      await delay(150);
    }
  } finally {
    if (!exited) child.kill("SIGTERM");
    const closed = exited || await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      delay(5_000, false),
    ]);
    if (closed) await rm(temp, { recursive: true, force: true });
    else result = { ok: false, error: "Candidate probe did not stop; temporary session artifacts were retained for safe recovery." };
  }
  return Object.freeze(result);
}

export const UPDATE_RESTORE_LIMIT = MAX_RESTORE_TABS;
