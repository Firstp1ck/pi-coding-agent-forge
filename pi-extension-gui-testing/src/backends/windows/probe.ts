/**
 * Runs the Windows helper's `-Probe NAME` modes and reads their one-line JSON
 * reports. Probe output is untrusted like every helper output: only known
 * fields are read, strings are bounded copies, and a report whose `probe`
 * field names another probe is ignored. Failures without a report are
 * classified (antivirus or application control, execution policy, language
 * mode, timeout) so checks can give the right remediation.
 */
import type { CommandRunner, RunResult } from "../../runner/types.ts";
import { boundedText, helperArgv } from "./paths.ts";

export type HelperProbeName = "env" | "desktop" | "job" | "nonelevated" | "uia" | "foreground";

/** Why a probe produced no usable report. */
export type ProbeFailureKind = "blocked" | "execution-policy" | "language-mode" | "timeout" | "killed" | "not-found" | "failed";

export interface ProbeOutcome {
  /** `true` when the report says `ok: true` and the helper exited 0. */
  ok: boolean;
  /** The parsed report (untrusted; read it with {@link reportString} and friends). */
  report?: Readonly<Record<string, unknown>>;
  /** Bounded, user-facing description of a failure. */
  problem?: string;
  /** Set when there is no usable report. */
  failure?: ProbeFailureKind;
}

export interface ProbeRunOptions {
  runner: CommandRunner;
  /** Absolute `powershell.exe` ({@link powershellPath}). */
  powershell: string;
  /** Directory holding `helper.ps1`. */
  helperDir: string;
  /** The probe's complete environment (allow-listed system variables). */
  env: Record<string, string>;
  /** Working directory; default unset (the runner's). */
  cwd?: string;
  signal?: AbortSignal;
  /** Default 55 s: every start compiles the helper with `Add-Type`. */
  timeoutMs?: number;
}

const MAX_REPORT_BYTES = 64 * 1024;

/** The last line of `stdout` that parses as a JSON object, or `undefined`. */
export function lastJsonObject(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || Buffer.byteLength(trimmed) > MAX_REPORT_BYTES) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Not the report line.
    }
  }
  return undefined;
}

/** A bounded string field of an untrusted report, or `undefined`. */
export function reportString(report: Readonly<Record<string, unknown>> | undefined, key: string, max = 200): string | undefined {
  const value = report?.[key];
  return typeof value === "string" ? boundedText(value, max) : undefined;
}

/** A safe-integer field of an untrusted report, or `undefined`. */
export function reportInteger(report: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined {
  const value = report?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** A boolean field of an untrusted report, or `undefined`. */
export function reportBoolean(report: Readonly<Record<string, unknown>> | undefined, key: string): boolean | undefined {
  const value = report?.[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * What went wrong when the helper printed no report: the helper's own
 * refusals (`helper.ps1`), PowerShell's execution-policy error, a kill, or a
 * timeout. The text quotes at most one bounded stderr line.
 */
export function classifyHelperFailure(result: RunResult): { kind: ProbeFailureKind; problem: string } {
  const stderr = result.stderr;
  const lastLine = boundedText(stderr.trim().split(/\r?\n/).filter((l) => l.trim()).at(-1) ?? "", 300);
  const quote = lastLine ? `: ${lastLine}` : "";
  if (result.timedOut) return { kind: "timeout", problem: `the helper did not answer within ${Math.round(result.durationMs / 1000)} s (compiling it with Add-Type can be slow, or antivirus is scanning or holding it)` };
  if (/compiling the helper failed/i.test(stderr)) return { kind: "blocked", problem: `the helper could not be compiled; antivirus or application control may be blocking csc.exe or Add-Type${quote}` };
  if (/ConstrainedLanguage|Constrained Language|LanguageMode/i.test(stderr)) return { kind: "language-mode", problem: `PowerShell runs in Constrained Language mode (AppLocker or WDAC), which blocks the helper${quote}` };
  if (/running scripts is disabled|is not digitally signed|cannot be loaded because|execution polic/i.test(stderr)) {
    return { kind: "execution-policy", problem: `PowerShell's execution policy blocks helper.ps1 (a Group Policy AllSigned or Restricted setting overrides -ExecutionPolicy Bypass)${quote}` };
  }
  if (/missing helper source/i.test(stderr)) return { kind: "not-found", problem: `helper files are missing${quote}` };
  if (result.exitCode === null) return { kind: "killed", problem: `the helper was stopped (${result.signal ?? "killed"}) before it reported; antivirus may have ended it` };
  return { kind: "failed", problem: `the helper exited ${result.exitCode}${quote}` };
}

/** Runs `helper.ps1 -Probe <name>` and reads its report. Never throws for a helper failure; rethrows only an abort. */
export async function runHelperProbe(name: HelperProbeName, options: ProbeRunOptions): Promise<ProbeOutcome> {
  let result: RunResult;
  try {
    result = await options.runner.run(helperArgv(options.powershell, options.helperDir, ["-Probe", name]), {
      timeoutMs: options.timeoutMs ?? 55_000,
      env: options.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      maxOutputBytes: MAX_REPORT_BYTES,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || options.signal?.aborted) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, failure: "not-found", problem: code === "ENOENT" ? `${options.powershell} not found` : `cannot start ${options.powershell}: ${boundedText((error as Error).message)}` };
  }
  const report = lastJsonObject(result.stdout);
  if (!report || report.probe !== name) {
    const classified = classifyHelperFailure(result);
    return { ok: false, failure: classified.kind, problem: report ? `the helper answered for probe ${boundedText(report.probe, 40)}, not ${name}` : classified.problem };
  }
  const ok = report.ok === true && result.exitCode === 0;
  if (ok) return { ok, report };
  const error = reportString(report, "error", 300);
  return { ok: false, report, problem: error ?? `probe ${name} failed (exit ${result.exitCode ?? result.signal})` };
}

/**
 * Memoises probe runs for one check pass, so `win.version`, `win.arch`, and
 * `helper.av` share a single `-Probe env` start (each start compiles the helper).
 */
export function probeCache(run: (name: HelperProbeName, signal: AbortSignal) => Promise<ProbeOutcome>): (name: HelperProbeName, signal: AbortSignal) => Promise<ProbeOutcome> {
  const cache = new Map<HelperProbeName, Promise<ProbeOutcome>>();
  return (name, signal) => {
    let pending = cache.get(name);
    if (!pending) {
      pending = run(name, signal);
      // A cancelled or crashed run must not poison later callers.
      pending.catch(() => cache.delete(name));
      cache.set(name, pending);
    }
    return pending;
  };
}
