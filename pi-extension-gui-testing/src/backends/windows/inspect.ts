/**
 * Client-side inspection of a Windows helper's kernel objects: whether a
 * process with a given PID and creation time still runs, whether a named Job
 * Object or desktop still exists, and (sweep and teardown only) ending the
 * session's jobs and the processes the caller marks as its own. Node has no
 * API for jobs and desktops, so one fixed
 * PowerShell script does it through P/Invoke. The script text never changes;
 * the names and IDs travel in an environment variable as JSON, after the
 * caller validated them against the helper's formats
 * ({@link parseSessionRecord}), so nothing untrusted is ever parsed as code.
 */
import type { CommandRunner } from "../../runner/types.ts";
import { boundedText, inlineScriptArgv } from "./paths.ts";
import { lastJsonObject } from "./probe.ts";
import { jobNamePattern, MAX_RECORD_ENTRIES, privateDesktopPattern, processKey, type WinProcessId } from "./session-record.ts";

/** Environment variable carrying the JSON request to the script. */
export const INSPECT_ENV = "PI_GUI_WIN_INSPECT";

/** State of one object: `alive` (exists), `gone`, `killed` (ended by this call), or `unknown` (could not be read). */
export type ObjectState = "alive" | "gone" | "killed" | "unknown";

/** A process to inspect; `kill` (with `action: "kill"`) also ends it. Only processes the client itself started may carry it. */
export interface InspectProcess extends WinProcessId {
  kill?: boolean;
}

export interface InspectRequest {
  /**
   * `audit` reads only; `kill` terminates the named jobs that still exist
   * (their names carry the session tag) and ends the processes marked
   * `kill`. Every other process is only inspected, never ended.
   */
  action: "audit" | "kill";
  processes: readonly InspectProcess[];
  /** Session tag that every job and desktop name must carry. */
  tag: string;
  jobs: readonly string[];
  desktops: readonly string[];
}

export interface InspectResult {
  /** By `<pid>:<created>`. */
  processes: Map<string, ObjectState>;
  jobs: Map<string, ObjectState>;
  desktops: Map<string, ObjectState>;
  /** Set when the script could not run or answer; every state is then `unknown`. */
  problem?: string;
}

/**
 * The fixed script (Windows PowerShell 5.1). `OpenProcess` fails with
 * ERROR_INVALID_PARAMETER (87) for a PID that does not exist; a different
 * creation time means the PID was reused. `OpenJobObjectW` and `OpenDesktopW`
 * fail with ERROR_FILE_NOT_FOUND (2) when the object is gone. Any other error
 * is `unknown`, which callers never treat as gone.
 */
export const INSPECT_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$req = $env:PI_GUI_WIN_INSPECT | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PiGuiInspect {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenJobObjectW(int access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr h, uint code);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenDesktopW(string name, int flags, bool inherit, int access);
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr h);
  public static string Process(int pid, long created, bool kill, uint settleMs) {
    IntPtr h = OpenProcess(0x1000 | 0x100000 | (kill ? 0x1 : 0), false, pid);
    if (h == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? "gone" : "unknown";
    try {
      long c, x, k, u;
      if (!GetProcessTimes(h, out c, out x, out k, out u)) return "unknown";
      if (c != created) return "gone";
      if (WaitForSingleObject(h, kill ? 0 : settleMs) != 0x102) return "gone";
      if (!kill) return "alive";
      if (!TerminateProcess(h, 1)) return "alive";
      return WaitForSingleObject(h, 5000) == 0 ? "killed" : "alive";
    } finally { CloseHandle(h); }
  }
  public static string Job(string name, bool kill) {
    IntPtr h = OpenJobObjectW(kill ? 0x8 : 0x4, false, name);
    if (h == IntPtr.Zero) return Marshal.GetLastWin32Error() == 2 ? "gone" : "unknown";
    try {
      if (!kill) return "alive";
      return TerminateJobObject(h, 1) ? "killed" : "alive";
    } finally { CloseHandle(h); }
  }
  public static string Desktop(string name) {
    IntPtr h = OpenDesktopW(name, 0, false, 0x1);
    if (h == IntPtr.Zero) return Marshal.GetLastWin32Error() == 2 ? "gone" : "unknown";
    CloseDesktop(h);
    return "alive";
  }
}
'@
$kill = $req.action -eq 'kill'
$out = @{ processes = @(); jobs = @(); desktops = @() }
# Jobs first: their processes end with them, so the process states below show what survived.
foreach ($j in @($req.jobs)) { $out.jobs += @{ id = [string]$j; state = [PiGuiInspect]::Job([string]$j, $kill) } }
# After terminating jobs, give their processes up to 2 s to exit before calling them alive.
$settle = if ($kill) { [uint32]2000 } else { [uint32]0 }
foreach ($p in @($req.processes)) { $out.processes += @{ id = "$($p.pid):$($p.created)"; state = [PiGuiInspect]::Process([int]$p.pid, [long]::Parse([string]$p.created), ($kill -and $p.kill -eq $true), $settle) } }
foreach ($d in @($req.desktops)) {
  $s = [PiGuiInspect]::Desktop([string]$d)
  # After ending processes, Windows destroys the desktop once its last user is gone: give it a moment.
  for ($n = 0; $kill -and $s -eq 'alive' -and $n -lt 20; $n++) { Start-Sleep -Milliseconds 100; $s = [PiGuiInspect]::Desktop([string]$d) }
  $out.desktops += @{ id = [string]$d; state = $s }
}
$out['probe'] = 'inspect'
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Compress -Depth 4))
`;

/** Rejects anything the helper could not have produced, so the script only ever sees the session's own names. */
export function validateInspectRequest(request: InspectRequest): string | undefined {
  if (!/^[0-9a-f]{16}$/.test(request.tag)) return "invalid session tag";
  if (request.processes.length > MAX_RECORD_ENTRIES + 1 || request.jobs.length > MAX_RECORD_ENTRIES || request.desktops.length > 1) return "too many objects";
  for (const p of request.processes) {
    if (!Number.isSafeInteger(p.pid) || p.pid <= 0 || p.pid > 0x7fffffff || !/^[1-9]\d{0,17}$/.test(p.created)) return "invalid process id";
    if (p.kill !== undefined && typeof p.kill !== "boolean") return "invalid kill flag";
  }
  const job = jobNamePattern(request.tag);
  for (const j of request.jobs) if (!job.test(j)) return "invalid job name";
  const desktop = privateDesktopPattern(request.tag);
  for (const d of request.desktops) if (!desktop.test(d)) return "invalid desktop name";
  return undefined;
}

function allUnknown(request: InspectRequest, problem: string): InspectResult {
  return {
    processes: new Map(request.processes.map((p) => [processKey(p), "unknown" as const])),
    jobs: new Map(request.jobs.map((j) => [j, "unknown" as const])),
    desktops: new Map(request.desktops.map((d) => [d, "unknown" as const])),
    problem,
  };
}

const STATES = new Set<ObjectState>(["alive", "gone", "killed", "unknown"]);

function readStates(raw: unknown, wanted: readonly string[]): Map<string, ObjectState> {
  const states = new Map<string, ObjectState>(wanted.map((id) => [id, "unknown"]));
  if (!Array.isArray(raw)) return states;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, state } = entry as Record<string, unknown>;
    // Only answers for what was asked count; anything else in the output is ignored.
    if (typeof id === "string" && states.has(id) && typeof state === "string" && STATES.has(state as ObjectState)) states.set(id, state as ObjectState);
  }
  return states;
}

export interface InspectRunOptions {
  runner: CommandRunner;
  powershell: string;
  /** Allow-listed system variables for PowerShell (`SystemRoot`, `TEMP`, …). */
  env: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Inspects (or, with `action: "kill"`, ends) the given objects. Never throws for a script failure: states become `unknown`. */
export async function inspectWindowsObjects(request: InspectRequest, options: InspectRunOptions): Promise<InspectResult> {
  const invalid = validateInspectRequest(request);
  if (invalid) return allUnknown(request, `refused to inspect: ${invalid}`);
  if (request.processes.length + request.jobs.length + request.desktops.length === 0) return { processes: new Map(), jobs: new Map(), desktops: new Map() };
  const processes = request.processes.map((p) => ({ pid: p.pid, created: p.created, ...(request.action === "kill" && p.kill === true ? { kill: true } : {}) }));
  const payload = JSON.stringify({ action: request.action, processes, jobs: request.jobs, desktops: request.desktops });
  let result;
  try {
    result = await options.runner.run(inlineScriptArgv(options.powershell, INSPECT_SCRIPT), {
      timeoutMs: options.timeoutMs ?? 60_000,
      env: { ...options.env, [INSPECT_ENV]: payload },
      ...(options.signal ? { signal: options.signal } : {}),
      maxOutputBytes: 256 * 1024,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || options.signal?.aborted) throw error;
    return allUnknown(request, `cannot start ${options.powershell}: ${boundedText((error as Error).message)}`);
  }
  const report = lastJsonObject(result.stdout);
  if (result.exitCode !== 0 || !report || report.probe !== "inspect") {
    const why = result.timedOut ? "timed out" : `exit ${result.exitCode ?? result.signal}${result.stderr.trim() ? `: ${boundedText(result.stderr.trim().split(/\r?\n/).at(-1))}` : ""}`;
    return allUnknown(request, `the inspection script failed (${why})`);
  }
  return {
    processes: readStates(report.processes, request.processes.map(processKey)),
    jobs: readStates(report.jobs, request.jobs),
    desktops: readStates(report.desktops, request.desktops),
  };
}
