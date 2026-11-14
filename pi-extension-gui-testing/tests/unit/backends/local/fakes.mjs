/**
 * Test doubles for `local-linux`: a fake `/proc` (stat + environ per PID), a
 * lock dir, fake X socket and lock dirs, and a spawner whose fake helper
 * claims a display the way the host-mode helper does (lock record, X files,
 * tagged Xvfb) and removes it all when its stdin closes. Nothing here spawns
 * a process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSpawner, BOOT } from "../fakes.mjs";

export { BOOT };

/** Adds `pid` to the fake proc root with `start` and an environ built from `env`. */
export function addProc(procRoot, pid, start, env = {}) {
  mkdirSync(join(procRoot, String(pid)), { recursive: true });
  const fields = ["S", "1", ...Array.from({ length: 17 }, (_, i) => String(i)), String(start), "0", "0"];
  writeFileSync(join(procRoot, String(pid), "stat"), `${pid} (proc) ${fields.join(" ")}\n`);
  writeFileSync(join(procRoot, String(pid), "environ"), Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join(""));
}

export function removeProc(procRoot, pid) {
  rmSync(join(procRoot, String(pid)), { recursive: true, force: true });
}

/** A scratch host: proc root, tmp root, lock dir, X dirs, a project, and a fake `kill`. */
export function fakeHost(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "gui-local-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = {
    root,
    procRoot: join(root, "proc"),
    tmpRoot: join(root, "tmp"),
    x11Dir: join(root, "x11"),
    xLockDir: join(root, "xlock"),
    project: join(root, "project"),
    uid: process.getuid(),
    kills: [],
    /** PIDs that ignore SIGTERM and SIGKILL (to test leftovers). */
    unkillable: new Set(options.unkillable ?? []),
  };
  for (const dir of [host.tmpRoot, host.x11Dir, host.xLockDir, host.project]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(host.procRoot, "sys", "kernel", "random"), { recursive: true });
  writeFileSync(join(host.procRoot, "sys", "kernel", "random", "boot_id"), `${BOOT}\n`);
  host.lockDir = join(host.tmpRoot, `pi-gui-displays-${host.uid}`);
  host.kill = (pid, signal) => {
    host.kills.push([pid, signal]);
    if (!existsSync(join(host.procRoot, String(pid)))) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    if (!host.unkillable.has(pid)) removeProc(host.procRoot, pid);
  };
  return host;
}

/** Writes a lock record as the helper would; returns `{ path, record }`. */
export function writeLock(host, record) {
  mkdirSync(host.lockDir, { recursive: true, mode: 0o700 });
  const full = {
    version: 1,
    display: 90,
    helper: "4242:5000",
    bootId: BOOT,
    tag: "abcdef0123456789",
    runtimeDir: "/nonexistent/runtime",
    workspace: "/nonexistent/workspace",
    createdAt: "2026-10-24T00:00:00.000000Z",
    xvfbPid: null,
    infra: {},
    ...record,
  };
  const path = join(host.lockDir, `display-${full.display}.lock`);
  writeFileSync(path, JSON.stringify(full));
  return { path, record: full };
}

/** X socket and X lock (naming `pid`) for display `n`. */
export function writeXFiles(host, n, pid) {
  writeFileSync(join(host.x11Dir, `X${n}`), "");
  writeFileSync(join(host.xLockDir, `.X${n}-lock`), `${String(pid).padStart(10)}\n`);
}

/**
 * A spawner whose helper claims display `:display` on spawn and, on a clean
 * exit (stdin EOF after `stop`), removes its lock, X files, and Xvfb like the
 * real host-mode helper. `dirty: true` leaves everything behind (a crash).
 */
export function localSpawner(host, options = {}) {
  const display = options.display ?? 90;
  const helperPid = options.pid ?? 4242;
  const xvfbPid = helperPid + 1;
  const tag = options.tag ?? "feedfacecafebeef";
  const state = { lockPath: undefined, env: undefined, argv: undefined, cwd: undefined };
  const spawner = fakeSpawner({
    pid: helperPid,
    ...options.behaviour,
    onSpawn(child) {
      addProc(host.procRoot, helperPid, 5000);
      state.env = { ...child.env };
      state.argv = [...child.argv];
      if (options.noLock) return;
      addProc(host.procRoot, xvfbPid, 5001, { PI_GUI_TAG: tag });
      writeXFiles(host, display, xvfbPid);
      const lock = writeLock(host, {
        display,
        helper: `${helperPid}:5000`,
        tag,
        runtimeDir: options.runtimeDir ?? child.env.PI_GUI_RUNTIME_DIR,
        workspace: options.workspace ?? child.env.PI_GUI_WORKSPACE,
        xvfbPid,
        infra: { xvfb: `${xvfbPid}:5001` },
      });
      state.lockPath = lock.path;
      child.exited.then(() => {
        removeProc(host.procRoot, helperPid);
        if (options.dirty) return;
        removeProc(host.procRoot, xvfbPid);
        rmSync(join(host.x11Dir, `X${display}`), { force: true });
        rmSync(join(host.xLockDir, `.X${display}-lock`), { force: true });
        rmSync(lock.path, { force: true });
      });
      options.behaviour?.onSpawn?.(child);
    },
  });
  const wrapped = {
    children: spawner.children,
    spawn(argv, spawnOptions) {
      state.cwd = spawnOptions.cwd;
      return spawner.spawn(argv, spawnOptions);
    },
  };
  return { spawner: wrapped, state, helperPid, xvfbPid, tag, display };
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
