/**
 * Test doubles for `local-windows`: a simulated Windows host on any OS. An
 * in-memory file system with Windows paths (case-insensitive, junctions as
 * links), a "kernel" of processes (PID + FILETIME), Job Objects, and
 * desktops, a command runner answering `whoami`, `icacls`, the helper's
 * `-Probe` modes, and the inline PowerShell scripts, and a spawner whose fake
 * helper writes `session.json` the way the real one does. Nothing here
 * spawns a process.
 */
import { win32 } from "node:path";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";
import { INSPECT_ENV } from "../../../../src/backends/windows/inspect.ts";
import { fakeSpawner } from "../fakes.mjs";

export const SYSTEM_ROOT = "C:\\Windows";
export const LOCAL = "C:\\Users\\tester\\AppData\\Local";
export const TEMP_ROOT = `${LOCAL}\\Temp`;
export const HELPER_DIR = "C:\\pi\\node_modules\\@firstpick\\pi-extension-gui-testing\\helpers\\windows";
export const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
export const PROJECT = "C:\\Users\\tester\\src\\app";
export const SESSION_DIR = `${TEMP_ROOT}\\pi-gui-testing-AbC123`;
export const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
export const BOOT = "win32-boot-1761300000";
export const PI_PID = 900;
export const PI_START = "1761300100";
/** Start time (Unix seconds) the fake process probe reports for the helper the client spawns. */
export const HELPER_START = "1761300200";
/** The same instant as a FILETIME, as the helper records itself when it was not relaunched (same PID). */
export const HELPER_CREATED = String((BigInt(HELPER_START) + 11_644_473_600n) * 10_000_000n);
export const HELPER_FILE_LIST = [
  "helper.ps1",
  "THIRD_PARTY_NOTICES.md",
  "src\\Json.cs",
  "src\\Framing.cs",
  "src\\Dispatch.cs",
  "src\\Imaging.cs",
  "src\\Model.cs",
  "src\\Policy.cs",
  "src\\Handlers.cs",
  "src\\HelperMain.cs",
  "src\\win\\Native.cs",
  "src\\win\\WinSecurity.cs",
  "src\\win\\WinJob.cs",
  "src\\win\\WinDesktop.cs",
  "src\\win\\WinUia.cs",
  "src\\win\\WinFiles.cs",
  "src\\win\\WinPlatform.cs",
];

/** Pi's environment on the simulated host, with secrets that must never reach the helper. */
export const WIN_ENV = {
  SystemRoot: SYSTEM_ROOT,
  windir: SYSTEM_ROOT,
  SystemDrive: "C:",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
  Path: "C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\nodejs",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  TEMP: TEMP_ROOT,
  TMP: TEMP_ROOT,
  USERPROFILE: "C:\\Users\\tester",
  USERNAME: "tester",
  LOCALAPPDATA: LOCAL,
  APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
  ANTHROPIC_API_KEY: "sk-secret",
  GITHUB_TOKEN: "ghp_secret",
  PI_GUI_ALLOW_EXEC: "1",
  PI_GUI_WIN_DESKTOP: "interactive",
};

function fsError(code, path) {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

/** In-memory Windows file system implementing `WinFs`. Keys are lower-cased normalised paths. */
export class FakeWinFs {
  constructor() {
    /** key → { path, type: "dir" | "file" | "link", data?, target? } */
    this.entries = new Map();
    this.nextId = 0;
    this.ops = [];
    /** Paths whose unlink/rmdir fails (EBUSY), by key. */
    this.busy = new Set();
    this.addDir("C:\\");
  }

  /** Stores an entry; a new object gets a new file id (a rename keeps it, like NTFS). */
  _set(key, entry) {
    entry.id ??= `vol1:${++this.nextId}`;
    this.entries.set(key, entry);
  }

  key(path) {
    const n = win32.normalize(path);
    return (n.length > 3 && n.endsWith("\\") ? n.slice(0, -1) : n).toLowerCase();
  }

  parentKey(path) {
    return this.key(win32.dirname(win32.normalize(path)));
  }

  addDir(path) {
    const parts = win32.normalize(path).split("\\").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? win32.join(current, part) : `${part}\\`;
      if (!this.entries.has(this.key(current))) this._set(this.key(current), { path: current, type: "dir" });
    }
    return this;
  }

  addFile(path, data = "") {
    this.addDir(win32.dirname(path));
    this._set(this.key(path), { path, type: "file", data });
    return this;
  }

  addLink(path, target) {
    this.addDir(win32.dirname(path));
    this._set(this.key(path), { path, type: "link", target });
    return this;
  }

  has(path) {
    return this.entries.has(this.key(path));
  }

  read(path) {
    return this.entries.get(this.key(path))?.data;
  }

  async lstat(path) {
    return this.entries.get(this.key(path))?.type;
  }

  async identify(path) {
    const entry = this.entries.get(this.key(path));
    return entry ? { type: entry.type, id: entry.id } : undefined;
  }

  async realpath(path) {
    // Resolve links on the way, like GetFinalPathNameByHandle.
    const parts = win32.normalize(path).split("\\").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? win32.join(current, part) : `${part}\\`;
      const entry = this.entries.get(this.key(current));
      if (!entry) throw fsError("ENOENT", path);
      if (entry.type === "link") current = entry.target;
      else current = entry.path;
    }
    return current;
  }

  async mkdir(path) {
    this.ops.push(`mkdir ${path}`);
    if (this.has(path)) throw fsError("EEXIST", path);
    if (this.entries.get(this.parentKey(path))?.type !== "dir") throw fsError("ENOENT", path);
    this._set(this.key(path), { path, type: "dir" });
  }

  async readdir(path) {
    const entry = this.entries.get(this.key(path));
    if (!entry) throw fsError("ENOENT", path);
    if (entry.type !== "dir") throw fsError("ENOTDIR", path);
    const key = this.key(path);
    return [...this.entries.values()].filter((e) => e.path !== entry.path && this.parentKey(e.path) === key).map((e) => win32.basename(e.path));
  }

  async readFile(path, maxBytes) {
    const entry = this.entries.get(this.key(path));
    if (!entry) throw fsError("ENOENT", path);
    if (entry.type !== "file") throw fsError("EISDIR", path);
    if (Buffer.byteLength(entry.data) > maxBytes) throw new Error(`${path} is larger than ${maxBytes} bytes`);
    return entry.data;
  }

  async writeNewFile(path, data) {
    this.ops.push(`write ${path}`);
    if (this.has(path)) throw fsError("EEXIST", path);
    if (this.entries.get(this.parentKey(path))?.type !== "dir") throw fsError("ENOENT", path);
    this._set(this.key(path), { path, type: "file", data });
  }

  async rename(from, to) {
    const entry = this.entries.get(this.key(from));
    if (!entry) throw fsError("ENOENT", from);
    this.entries.delete(this.key(from));
    this._set(this.key(to), { ...entry, path: to });
  }

  async unlink(path) {
    this.ops.push(`unlink ${path}`);
    const entry = this.entries.get(this.key(path));
    if (!entry) throw fsError("ENOENT", path);
    if (entry.type === "dir") throw fsError("EPERM", path);
    if (this.busy.has(this.key(path))) throw fsError("EBUSY", path);
    this.entries.delete(this.key(path));
  }

  async rmdir(path) {
    this.ops.push(`rmdir ${path}`);
    const entry = this.entries.get(this.key(path));
    if (!entry) throw fsError("ENOENT", path);
    if (entry.type !== "dir") throw fsError("ENOTDIR", path);
    const key = this.key(path);
    if ([...this.entries.values()].some((e) => e.path !== entry.path && this.parentKey(e.path) === key)) throw fsError("ENOTEMPTY", path);
    this.entries.delete(key);
  }

  /** Writes a file directly (as the helper would), creating it or replacing it. */
  put(path, data) {
    this._set(this.key(path), { path, type: "file", data });
  }

  remove(path) {
    const key = this.key(path);
    for (const k of [...this.entries.keys()]) if (k === key || k.startsWith(`${key}\\`)) this.entries.delete(k);
  }
}

/** A simulated Windows host: file system with the system tools, helper files, temp root, a project, and Pi's session dir. */
export function fakeWinHost(options = {}) {
  const fs = new FakeWinFs();
  fs.addFile(POWERSHELL, "");
  for (const tool of ["whoami.exe", "icacls.exe", "taskkill.exe"]) fs.addFile(`${SYSTEM_ROOT}\\System32\\${tool}`, "");
  for (const file of options.helperFiles ?? HELPER_FILE_LIST) fs.addFile(win32.join(HELPER_DIR, file), "");
  fs.addDir(TEMP_ROOT);
  fs.addDir(PROJECT);
  fs.addFile(`${SESSION_DIR}\\owner.json`, JSON.stringify(ownerRecord()));
  const world = {
    /** "pid:FILETIME" → alive */
    processes: new Set(),
    /** pid → owner.json start time (Unix seconds), for the client's process probe */
    starts: new Map([[PI_PID, PI_START]]),
    jobs: new Set(),
    desktops: new Set(),
    /** Ids that ignore termination. */
    unkillable: new Set(),
    /** Whole inspection fails (Constrained Language, AV, …). */
    inspectFails: false,
    killed: [],
    inspections: [],
  };
  const processProbe = {
    flavor: "win32",
    startTime: (pid) => world.starts.get(pid) ?? null,
    bootId: () => BOOT,
  };
  return { fs, world, processProbe };
}

export function ownerRecord(extra = {}) {
  return { version: 1, pid: PI_PID, processStartTime: PI_START, bootId: BOOT, clientId: "c0ffee", piSessionId: "pi-1", backend: "local-windows", createdAt: "2026-10-24T00:00:00.000Z", resources: [], ...extra };
}

/** A session record as the helper writes it. */
export function sessionRecord(runtimeDir, extra = {}) {
  // The client's tag is the runtime dir's own hex digits; other dirs get a fixed one.
  const tag = extra.tag ?? /\\pi-gui-testing-win-([0-9a-f]{16})$/.exec(runtimeDir)?.[1] ?? "0123456789abcdef";
  return {
    version: 1,
    helper: { pid: 5000, created: "133000000000000000" },
    tag,
    mode: "local",
    windowStation: "WinSta0",
    desktop: `pi-gui-testing-${tag}-${"ab".repeat(16)}`,
    privateDesktop: true,
    jobs: [],
    processes: [],
    tmpDir: `${runtimeDir}\\tmp`,
    status: "running",
    updatedAt: "2026-10-24T00:00:00.000Z",
    ...extra,
  };
}

const PROBE_REPORTS = {
  env: { probe: "env", ok: true, os: "windows", arch: "x64", platform: "Windows 10.0.22631 x64; .NET Framework 4.0.30319.42000; PowerShell 5.1.22621.4391", build: 22631, elevated: false, sessionId: 1, windowStation: "WinSta0" },
  desktop: { probe: "desktop", ok: true, desktop: "pi-gui-testing-probeabcd-00" },
  job: { probe: "job", ok: true },
  nonelevated: { probe: "nonelevated", ok: true, elevated: false, detail: "the helper is not elevated, so apps inherit a non-elevated token" },
  uia: { probe: "uia", ok: true, name: "pi-gui-testing-probe" },
  foreground: { probe: "foreground", ok: true, hwnd: "win:0x1a2b", title: "Editor" },
};

export const POWERSHELL_INFO = { probe: "powershell", version: "5.1.22621.4391", edition: "Desktop", languageMode: "FullLanguage", machinePolicy: "Undefined", userPolicy: "Undefined" };

function decodeScript(argv) {
  const index = argv.indexOf("-EncodedCommand");
  return index === -1 ? "" : Buffer.from(argv[index + 1], "base64").toString("utf16le");
}

/** Answers an inspection request from `world`, applying kills. */
function inspect(world, payload) {
  const request = JSON.parse(payload);
  world.inspections.push(request);
  const kill = request.action === "kill";
  const answer = { probe: "inspect", processes: [], jobs: [], desktops: [] };
  // Jobs first, like the script: their processes end with them.
  for (const j of request.jobs) {
    let state = world.jobs.has(j) ? "alive" : "gone";
    if (state === "alive" && kill && !world.unkillable.has(j)) {
      world.jobs.delete(j);
      world.killed.push(j);
      // Terminating a job ends its processes.
      for (const id of world.jobMembers?.get(j) ?? []) if (!world.unkillable.has(id)) world.processes.delete(id);
      state = "killed";
    }
    answer.jobs.push({ id: j, state });
  }
  for (const p of request.processes) {
    const id = `${p.pid}:${p.created}`;
    let state = world.processes.has(id) ? "alive" : "gone";
    // Like the script: a process is ended only when the request marks it (the helper the client spawned).
    if (state === "alive" && kill && p.kill === true && !world.unkillable.has(id)) {
      world.processes.delete(id);
      world.killed.push(id);
      state = "killed";
    }
    answer.processes.push({ id, state });
  }
  // A desktop lives while a process on it runs (or a test pins it).
  const desktopAlive = (d) => world.desktops.has(d) && (world.pinnedDesktops?.has(d) || (world.desktopMembers?.get(d) ?? []).some((id) => world.processes.has(id)));
  for (const d of request.desktops) answer.desktops.push({ id: d, state: desktopAlive(d) ? "alive" : "gone" });
  return answer;
}

/**
 * The runner of the simulated host. `options.probes[name]` overrides a probe
 * report (an object), or a full run result (`{ result: {…} }`).
 */
export function fakeWinRunner(world, options = {}) {
  const runner = new FakeCommandRunner();
  runner
    .on((argv) => argv[0] === `${SYSTEM_ROOT}\\System32\\whoami.exe`, options.whoami ?? { exitCode: 0, stdout: `"desktop-1\\tester","${SID}"\r\n` })
    .on((argv) => argv[0] === `${SYSTEM_ROOT}\\System32\\icacls.exe`, options.icacls ?? { exitCode: 0, stdout: "" })
    .on((argv) => argv[0] === POWERSHELL && argv.includes("-EncodedCommand"), (argv, runOptions) => {
      if (runOptions.env?.[INSPECT_ENV] !== undefined) {
        if (world.inspectFails) return { exitCode: 1, stderr: "Add-Type : Cannot add type. Definition of new types is not supported in this language mode." };
        return { exitCode: 0, stdout: `${JSON.stringify(inspect(world, runOptions.env[INSPECT_ENV]))}\r\n` };
      }
      if (decodeScript(argv).includes("Get-ExecutionPolicy")) {
        const info = options.powershellInfo ?? POWERSHELL_INFO;
        return info.result ?? { exitCode: 0, stdout: `${JSON.stringify(info)}\r\n` };
      }
      return { exitCode: 1, stderr: "unexpected inline script" };
    })
    .on((argv) => argv[0] === POWERSHELL && argv.includes("-Probe"), (argv) => {
      const name = argv[argv.indexOf("-Probe") + 1];
      const override = typeof options.probes?.[name] === "function" ? options.probes[name]() : options.probes?.[name];
      if (override?.result) return override.result;
      const report = override ?? PROBE_REPORTS[name];
      return { exitCode: report.ok ? 0 : 1, stdout: `${JSON.stringify(report)}\r\n` };
    });
  return runner;
}

/**
 * A spawner whose helper behaves like `local` mode: on spawn it writes
 * `session.json` and `tmp\` into `PI_GUI_RUNTIME_DIR` and creates its private
 * desktop; `launch` creates a job with one process; a clean exit removes them
 * and marks the record stopped. `dirty: true` leaves everything (a crash).
 */
export function winSpawner(host, options = {}) {
  const { fs, world } = host;
  const helperPid = options.pid ?? 4242;
  // Like the real helper: the client's PI_GUI_WIN_TAG when it sends one (local-windows always does).
  const state = { env: undefined, argv: undefined, cwd: undefined, record: undefined, runtimeDir: undefined, tag: options.tag ?? "0123456789abcdef" };
  world.jobMembers ??= new Map();
  world.desktopMembers ??= new Map();
  const writeRecord = () => fs.put(`${state.runtimeDir}\\session.json`, JSON.stringify(state.record));
  const spawner = fakeSpawner({
    pid: helperPid,
    handlers: {
      hello: (params) => ({ protocol: params.protocol, helperVersion: "0.2.0", os: "windows", arch: "x64", platform: "Windows 10.0.22631 x64", capabilities: options.capabilities ?? ["launch", "wait", "snapshot", "snapshotFull", "screenshot", "act", "windows", "a11y-uia", "desktop-private"] }),
      launch: () => {
        const job = `Local\\pi-gui-testing-${state.tag}-job-${String(state.record.jobs.length).padStart(16, "0")}`;
        const proc = { pid: 7000 + state.record.processes.length, created: "133000000000001000" };
        world.jobs.add(job);
        world.processes.add(`${proc.pid}:${proc.created}`);
        world.jobMembers.set(job, [`${proc.pid}:${proc.created}`]);
        world.desktopMembers.get(state.record.desktop)?.push(`${proc.pid}:${proc.created}`);
        state.record.jobs.push(job);
        state.record.processes.push(proc);
        writeRecord();
        return { pid: proc.pid, windows: [{ ref: "win:0x10", title: "Pi GUI smoke", bounds: { x: 0, y: 0, width: 320, height: 160 } }] };
      },
      ...options.handlers,
    },
    onSpawn(child) {
      state.env = { ...child.env };
      state.argv = [...child.argv];
      state.runtimeDir = child.env.PI_GUI_RUNTIME_DIR;
      if (!options.tag && child.env.PI_GUI_WIN_TAG) state.tag = child.env.PI_GUI_WIN_TAG;
      world.starts.set(helperPid, HELPER_START);
      // Default: not relaunched, so the record's helper is the spawned process itself. `innerPid` models
      // the elevated relaunch, whose non-elevated copy is another process (in the outer one's kill-on-close job).
      const helper = { pid: options.innerPid ?? helperPid, created: options.innerCreated ?? (options.innerPid ? "133000000000000000" : HELPER_CREATED) };
      world.processes.add(`${helper.pid}:${helper.created}`);
      state.record = sessionRecord(state.runtimeDir, { tag: state.tag, helper, ...options.record });
      world.desktops.add(state.record.desktop);
      world.desktopMembers.set(state.record.desktop, [`${helper.pid}:${helper.created}`]);
      if (!options.noRecord) {
        fs.addDir(`${state.runtimeDir}\\tmp`);
        writeRecord();
      }
      options.onSpawn?.(child, state);
      child.exited.then(() => {
        world.starts.delete(helperPid);
        if (options.dirty) return;
        world.processes.delete(`${helper.pid}:${helper.created}`);
        for (const job of state.record.jobs) {
          world.jobs.delete(job);
          for (const id of world.jobMembers.get(job) ?? []) if (!world.unkillable.has(id)) world.processes.delete(id);
        }
        world.desktops.delete(state.record.desktop);
        fs.remove(`${state.runtimeDir}\\tmp`);
        state.record.status = "stopped";
        state.record.leftovers = [];
        if (fs.has(state.runtimeDir)) writeRecord();
      });
    },
  });
  const wrapped = {
    children: spawner.children,
    spawn(argv, spawnOptions) {
      state.cwd = spawnOptions.cwd;
      return spawner.spawn(argv, spawnOptions);
    },
  };
  return {
    spawner: wrapped,
    state,
    helperPid,
    get tag() {
      return state.tag;
    },
  };
}
