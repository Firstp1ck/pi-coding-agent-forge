/**
 * Process identity and owner liveness (spec §7a.2). An owner is identified by
 * boot id + PID + process start time, so a reused PID or a reboot is never
 * mistaken for the original owner.
 *
 * Linux reads `/proc` (start time in clock ticks since boot, `boot_id`).
 * macOS and Windows have no `/proc` (Docker Desktop hosts, M1c): there the
 * start time is the absolute creation time in UTC seconds (`ps -o lstart`
 * under `TZ=UTC0`; PowerShell `Get-Process`), and the boot id is
 * `darwin-<kern.bootsessionuuid>` or `win32-boot-<last boot, UTC seconds>`.
 * The prefix keeps the owner labels of different operating systems apart:
 * a label written on another OS (for example a Pi in WSL next to a Windows
 * Pi on the same Docker Desktop engine) is always `unknown`, never `dead`.
 * macOS falls back to `darwin-boot-<kern.boottime seconds>` when the boot
 * session UUID is unreadable; the two macOS forms are different
 * representations of the same boot, so they never compare (`unknown`).
 * Anything that cannot be read is `unknown`, and `unknown` is never swept.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OwnerLabel, OwnerLiveness } from "../owner.ts";

/** Root of the proc filesystem; tests point it at a fake tree. */
export const DEFAULT_PROC_ROOT = "/proc";

/** Boot-id prefixes of the operating systems without `/proc`. Linux boot ids are bare UUIDs. */
export const BOOT_PREFIX = { darwin: "darwin-", win32: "win32-boot-" } as const;

/** How one platform answers the two identity questions. */
export interface ProcessProbe {
  /** `linux`, `darwin`, or `win32`: whose labels this probe can judge. */
  readonly flavor: "linux" | "darwin" | "win32";
  /** Start time of `pid`; `null` when no such process exists; `undefined` when it cannot be read. */
  startTime(pid: number): string | null | undefined;
  /** Boot identity of this machine; `undefined` when unreadable. */
  bootId(): string | undefined;
}

/** Runs a command synchronously; tests replace it. `status` is `null` when it could not run or timed out. */
export type SyncExec = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => { status: number | null; stdout: string };

const realExec: SyncExec = (file, args, options) => {
  try {
    const stdout = execFileSync(file, [...args], { env: options.env, timeout: options.timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 64 * 1024 });
    return { status: 0, stdout };
  } catch (error) {
    const e = error as { status?: number | null; stdout?: string; signal?: string; code?: string };
    if (e.code === "ENOENT" || e.signal || e.status === undefined) return { status: null, stdout: "" };
    return { status: e.status, stdout: typeof e.stdout === "string" ? e.stdout : "" };
  }
};

/**
 * Reads field 22 (`starttime`) of `<procRoot>/<pid>/stat`.
 *
 * @returns The start time as a decimal string; `null` when the PID does not
 *   exist; `undefined` when the file exists but cannot be read or parsed.
 */
export function readProcStartTime(pid: number, procRoot: string = DEFAULT_PROC_ROOT): string | null | undefined {
  let text: string;
  try {
    text = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? null : undefined;
  }
  // Field 2 (comm) is parenthesised and may contain spaces or ')', so split after the last ')'.
  const close = text.lastIndexOf(")");
  if (close === -1) return undefined;
  const rest = text.slice(close + 2).trim().split(/\s+/);
  // `rest[0]` is field 3 (state), so field 22 is rest[19].
  const value = rest[19];
  return value !== undefined && /^\d+$/.test(value) ? value : undefined;
}

function readProcBootId(procRoot: string): string | undefined {
  try {
    const value = readFileSync(join(procRoot, "sys", "kernel", "random", "boot_id"), "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The `/proc` probe (Linux, and any test that points `procRoot` at a fake tree). */
export function linuxProbe(procRoot: string = DEFAULT_PROC_ROOT): ProcessProbe {
  return { flavor: "linux", startTime: (pid) => readProcStartTime(pid, procRoot), bootId: () => readProcBootId(procRoot) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `ps -o lstart=` output under `LC_ALL=C TZ=UTC0` (`Sat Oct 24 10:00:00 2026`) → UTC seconds, or `undefined`. */
export function parsePsLstart(text: string): string | undefined {
  const match = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text);
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1]);
  if (month === -1) return undefined;
  const seconds = Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1000;
  return Number.isSafeInteger(seconds) && seconds > 0 ? String(seconds) : undefined;
}

/** macOS: `ps` and `sysctl` with a fixed environment (UTC, C locale), so every Pi process reads the same value. */
export function darwinProbe(exec: SyncExec = realExec): ProcessProbe {
  const env = { PATH: "/bin:/usr/bin:/usr/sbin:/sbin", LC_ALL: "C", TZ: "UTC0" };
  let boot: string | undefined;
  return {
    flavor: "darwin",
    startTime(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      const result = exec("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env, timeoutMs: 5_000 });
      if (result.status === null) return undefined;
      const text = result.stdout.trim();
      // ps exits 1 and prints nothing for a PID that does not exist.
      if (result.status !== 0) return text === "" && result.status === 1 ? null : undefined;
      return text === "" ? null : parsePsLstart(text);
    },
    bootId() {
      if (boot) return boot;
      const uuid = exec("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { env, timeoutMs: 5_000 });
      const value = uuid.status === 0 ? uuid.stdout.trim() : "";
      if (/^[0-9A-Fa-f-]{16,64}$/.test(value)) return (boot = `${BOOT_PREFIX.darwin}${value.toLowerCase()}`);
      const time = exec("/usr/sbin/sysctl", ["-n", "kern.boottime"], { env, timeoutMs: 5_000 });
      const sec = time.status === 0 ? /sec\s*=\s*(\d+)/.exec(time.stdout)?.[1] : undefined;
      return sec ? (boot = `${BOOT_PREFIX.darwin}boot-${sec}`) : undefined;
    },
  };
}

function powershell(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  return root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell.exe";
}

/** Windows: PowerShell `Get-Process` and the CIM last boot time, in UTC seconds. */
export function win32Probe(exec: SyncExec = realExec, env: NodeJS.ProcessEnv = process.env): ProcessProbe {
  const run = (script: string) =>
    exec(powershell(env), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      env: { SystemRoot: env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", PATH: env.PATH ?? env.Path ?? "" },
      timeoutMs: 15_000,
    });
  let boot: string | undefined;
  return {
    flavor: "win32",
    startTime(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      const result = run(
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'none' } elseif ($null -eq $p.StartTime) { 'unknown' } else { ([DateTimeOffset]$p.StartTime).ToUnixTimeSeconds() }`,
      );
      if (result.status !== 0) return undefined;
      const text = result.stdout.trim();
      if (text === "none") return null;
      return /^\d+$/.test(text) && text !== "0" ? text : undefined;
    },
    bootId() {
      if (boot) return boot;
      const result = run("([DateTimeOffset](Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime).ToUnixTimeSeconds()");
      const text = result.status === 0 ? result.stdout.trim() : "";
      return /^\d+$/.test(text) ? (boot = `${BOOT_PREFIX.win32}${text}`) : undefined;
    },
  };
}

const defaultProbes = new Map<string, ProcessProbe>();

/**
 * The probe for this host: `/proc` on Linux (and whenever `procRoot` is not
 * the default, which only tests do), `ps` on macOS, PowerShell on Windows.
 * Other platforms get a probe that knows nothing (every owner is `unknown`).
 */
export function defaultProbe(procRoot: string = DEFAULT_PROC_ROOT, platform: NodeJS.Platform = process.platform): ProcessProbe {
  if (platform === "linux" || procRoot !== DEFAULT_PROC_ROOT) return linuxProbe(procRoot);
  let probe = defaultProbes.get(platform);
  if (!probe) {
    probe =
      platform === "darwin"
        ? darwinProbe()
        : platform === "win32"
          ? win32Probe()
          : { flavor: "linux", startTime: () => undefined, bootId: () => undefined };
    defaultProbes.set(platform, probe);
  }
  return probe;
}

/**
 * Start time of `pid` as recorded in owner labels and `owner.json`.
 *
 * @returns A decimal string; `null` when the PID does not exist; `undefined` when unreadable.
 */
export function readProcessStartTime(pid: number, procRoot: string = DEFAULT_PROC_ROOT, probe: ProcessProbe = defaultProbe(procRoot)): string | null | undefined {
  return probe.startTime(pid);
}

/** Boot identity of this machine (`/proc/sys/kernel/random/boot_id` on Linux); `undefined` when unreadable. */
export function readBootId(procRoot: string = DEFAULT_PROC_ROOT, probe: ProcessProbe = defaultProbe(procRoot)): string | undefined {
  return probe.bootId();
}

/** Returns a new random client id (one per extension instance). */
export function createClientId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Identity of this extension instance. Create it once per instance and reuse
 * it, so `clientId` stays stable for the instance's lifetime.
 *
 * @throws Error when this process's start time or the boot id cannot be read.
 */
export function createOwnerIdentity(procRoot: string = DEFAULT_PROC_ROOT, pid: number = process.pid, probe: ProcessProbe = defaultProbe(procRoot)): OwnerLabel {
  const processStartTime = probe.startTime(pid);
  const bootId = probe.bootId();
  if (!processStartTime || !bootId) {
    const where = probe.flavor === "linux" ? procRoot : probe.flavor === "darwin" ? "ps and sysctl" : "PowerShell";
    throw new Error(`cannot read process identity from ${where} (start time ${processStartTime}, boot id ${bootId})`);
  }
  return { clientId: createClientId(), pid, processStartTime, bootId };
}

/**
 * Representation of a boot id: its OS plus, on macOS, which form it is
 * (`darwin-<uuid>` or the `darwin-boot-<seconds>` fallback). Only boot ids of
 * the same representation compare; any other pair is incomparable.
 */
export function bootKind(bootId: string): string {
  if (bootId.startsWith(`${BOOT_PREFIX.darwin}boot-`)) return "darwin-boottime";
  return bootFlavor(bootId);
}

/** Which operating system wrote a boot id. */
export function bootFlavor(bootId: string): ProcessProbe["flavor"] {
  if (bootId.startsWith(BOOT_PREFIX.darwin)) return "darwin";
  if (bootId.startsWith(BOOT_PREFIX.win32)) return "win32";
  return "linux";
}

/**
 * Decides whether an owner is still running.
 *
 * - `dead`: same OS, and the boot id differs, the PID is gone, or the PID now has a different start time.
 * - `alive`: same boot, same PID, same start time.
 * - `unknown`: anything could not be read, the owner was written by another OS, or its boot id uses
 *   another representation than this machine's (macOS UUID vs boot-time fallback); such owners are never swept.
 */
export function ownerLiveness(
  owner: Pick<OwnerLabel, "pid" | "processStartTime" | "bootId">,
  procRoot: string = DEFAULT_PROC_ROOT,
  probe: ProcessProbe = defaultProbe(procRoot),
): OwnerLiveness {
  const bootId = probe.bootId();
  if (!bootId) return "unknown";
  if (bootFlavor(owner.bootId) !== probe.flavor || bootFlavor(bootId) !== probe.flavor) return "unknown";
  // A different representation of a boot id says nothing about whether it is the same boot.
  if (bootKind(owner.bootId) !== bootKind(bootId)) return "unknown";
  if (bootId !== owner.bootId) return "dead";
  const startTime = probe.startTime(owner.pid);
  if (startTime === null) return "dead";
  if (startTime === undefined) return "unknown";
  return startTime === owner.processStartTime ? "alive" : "dead";
}
