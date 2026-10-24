/**
 * `local-windows` checks (spec §5.4). PowerShell itself is observed with a
 * fixed inline script; everything else runs the helper's own `-Probe` modes,
 * so the checks exercise the code a session runs. One `-Probe env` start is
 * shared by `win.version`, `win.arch`, and `helper.av` (every start compiles
 * the helper). Nothing here installs anything: every remediation is manual.
 */
import { win32 } from "node:path";
import { commonChecks, type CommonCheckOptions } from "../../checks/common.ts";
import type { Check, CheckOutcome } from "../../checks/types.ts";
import type { HostSupport } from "../host-support.ts";
import type { CommandRunner } from "../../runner/types.ts";
import { passedWindowsEnv } from "./env.ts";
import { boundedText, HELPER_FILES, inlineScriptArgv, powershellPath, systemRoot } from "./paths.ts";
import { lastJsonObject, probeCache, reportBoolean, reportInteger, reportString, runHelperProbe, type HelperProbeName, type ProbeOutcome } from "./probe.ts";
import type { WinFs } from "./runtime-dir.ts";

export const LOCAL_WINDOWS_HOST_SUPPORT: HostSupport = {
  platforms: ["win32"],
  otherwise: "local-windows runs on Windows hosts only (Windows 10 1809 or later, or Windows 11)",
};

/** Windows 10 1809. */
export const MIN_WINDOWS_BUILD = 17763;
/** Free space `local-windows` needs in `%LOCALAPPDATA%\Temp` (screenshots, dumps, copies). */
export const LOCAL_WINDOWS_MIN_FREE_BYTES = 1024 ** 3;
export const SUPPORTED_ARCHES = ["x64", "arm64"] as const;
/** Execution policies that stop an unsigned local script even with `-ExecutionPolicy Bypass` when set by Group Policy. */
export const BLOCKING_POLICIES = ["AllSigned", "Restricted"] as const;

const REINSTALL = "pi install npm:@firstpick/pi-extension-gui-testing";

/** Fixed script: PowerShell version, edition, language mode, and the Group Policy execution policies. Runs in Constrained Language mode too. */
export const POWERSHELL_INFO_SCRIPT = [
  "$info = @{ probe = 'powershell' }",
  "$info.version = $PSVersionTable.PSVersion.ToString()",
  "$info.edition = [string]$PSVersionTable.PSEdition",
  "$info.languageMode = [string]$ExecutionContext.SessionState.LanguageMode",
  "$info.machinePolicy = [string](Get-ExecutionPolicy -Scope MachinePolicy)",
  "$info.userPolicy = [string](Get-ExecutionPolicy -Scope UserPolicy)",
  "$info | ConvertTo-Json -Compress",
].join("\n");

export interface LocalWindowsCheckOptions {
  runner: CommandRunner;
  fs: WinFs;
  /** Pi's environment (only allow-listed system variables reach PowerShell). */
  env: Readonly<Record<string, string | undefined>>;
  /** Directory holding `helper.ps1`. */
  helperDir: string;
  /** Where `disk.free` measures; default `%LOCALAPPDATA%\Temp` when known. */
  diskPath?: string;
  /** Per-probe bound. Default 55 s. */
  probeTimeoutMs?: number;
  common?: Partial<CommonCheckOptions>;
}

const ON_WINDOWS = ["host.os"];

/** All `local-windows` checks: the common ones, then PowerShell, the helper files, and the helper probes. */
export function localWindowsChecks(options: LocalWindowsCheckOptions): Check[] {
  const { runner, env } = options;
  const probeEnv = passedWindowsEnv(env);
  const powershell = (): string => powershellPath(env);
  const cwd = (): string => win32.join(systemRoot(env), "System32");
  const probeTimeout = options.probeTimeoutMs ?? 55_000;

  const probe = probeCache((name: HelperProbeName, signal: AbortSignal) =>
    runHelperProbe(name, { runner, powershell: powershell(), helperDir: options.helperDir, env: probeEnv, cwd: cwd(), signal, timeoutMs: probeTimeout }),
  );

  let infoRun: Promise<Record<string, unknown> | string> | undefined;
  /** Memoised PowerShell info report, or a problem text. */
  const powershellInfo = (signal: AbortSignal): Promise<Record<string, unknown> | string> => {
    infoRun ??= (async () => {
      const path = powershell();
      const type = await options.fs.lstat(path);
      if (type !== "file") return `${path} not found (Windows PowerShell 5.1 is part of Windows; the package never uses a powershell.exe found on PATH)`;
      try {
        const result = await runner.run(inlineScriptArgv(path, POWERSHELL_INFO_SCRIPT), { timeoutMs: 30_000, env: probeEnv, cwd: cwd(), signal });
        const report = lastJsonObject(result.stdout);
        if (result.exitCode !== 0 || report?.probe !== "powershell") return `${path} failed (exit ${result.exitCode ?? result.signal}${result.stderr.trim() ? `: ${boundedText(result.stderr.trim().split(/\r?\n/).at(-1))}` : ""})`;
        return report;
      } catch (error) {
        if (signal.aborted) throw error;
        return `cannot run ${path}: ${boundedText((error as Error).message)}`;
      }
    })();
    infoRun.catch(() => (infoRun = undefined));
    return infoRun;
  };

  const probeCheck = (name: HelperProbeName, describePass: (outcome: ProbeOutcome) => string): Check["run"] =>
    async (ctx) => {
      const outcome = await probe(name, ctx.signal);
      return outcome.ok ? { status: "pass", observed: describePass(outcome) } : { status: "fail", observed: outcome.problem ?? `probe ${name} failed` };
    };

  let diskPath = options.diskPath;
  if (!diskPath) {
    const local = passedWindowsEnv(env).LOCALAPPDATA;
    if (local) diskPath = win32.join(local, "Temp");
  }
  const common = commonChecks("local-windows", {
    minFreeBytes: LOCAL_WINDOWS_MIN_FREE_BYTES,
    ...(diskPath ? { diskPath } : {}),
    hostSupport: LOCAL_WINDOWS_HOST_SUPPORT,
    ...options.common,
  });

  const powershellCheck: Check = {
    id: "win.powershell",
    description: "Windows PowerShell 5.1 in full language mode (runs the helper)",
    kind: "observe",
    required: true,
    dependsOn: ON_WINDOWS,
    timeoutMs: 35_000,
    remediation: {
      summary: "Use a Windows installation with Windows PowerShell 5.1 (%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe). Constrained Language mode comes from an AppLocker or WDAC policy; ask your administrator to allow full language mode for your user",
      manual: true,
    },
    async run(ctx): Promise<CheckOutcome> {
      const info = await powershellInfo(ctx.signal);
      if (typeof info === "string") return { status: "fail", observed: info };
      const version = reportString(info, "version", 40) ?? "?";
      const edition = reportString(info, "edition", 20) ?? "?";
      const mode = reportString(info, "languageMode", 40) ?? "?";
      const observed = `PowerShell ${version} (${edition}), ${mode}`;
      if (!/^5\.1\./.test(version) || edition !== "Desktop") return { status: "fail", observed: `${observed}; Windows PowerShell 5.1 (Desktop edition) is required` };
      if (mode !== "FullLanguage") return { status: "fail", observed: `${observed}; Add-Type is blocked outside FullLanguage mode` };
      return { status: "pass", observed: `${observed} at ${powershell()}`, facts: { "powershell.version": version } };
    },
  };

  const policyCheck: Check = {
    id: "win.execution-policy",
    description: "no Group Policy execution policy blocks the unsigned helper script",
    kind: "observe",
    required: true,
    dependsOn: ["win.powershell"],
    timeoutMs: 35_000,
    remediation: {
      summary: "A Group Policy sets PowerShell's execution policy to AllSigned or Restricted, which -ExecutionPolicy Bypass cannot override. Ask your administrator to allow local scripts (RemoteSigned or less) for your user",
      manual: true,
    },
    async run(ctx): Promise<CheckOutcome> {
      const info = await powershellInfo(ctx.signal);
      if (typeof info === "string") return { status: "fail", observed: info };
      const machine = reportString(info, "machinePolicy", 30) ?? "?";
      const user = reportString(info, "userPolicy", 30) ?? "?";
      const observed = `MachinePolicy ${machine}, UserPolicy ${user}`;
      const blocking = [machine, user].filter((p) => (BLOCKING_POLICIES as readonly string[]).includes(p));
      if (blocking.length > 0) return { status: "fail", observed: `${observed}; ${blocking[0]} blocks helper.ps1` };
      return { status: "pass", observed: `${observed}; the helper starts with -ExecutionPolicy Bypass` };
    },
  };

  const presentCheck: Check = {
    id: "helper.present",
    description: "Windows helper files present (helper.ps1 and its C# sources)",
    kind: "observe",
    required: true,
    dependsOn: ON_WINDOWS,
    remediation: { summary: `Reinstall the package (${REINSTALL})`, command: ["pi", "install", "npm:@firstpick/pi-extension-gui-testing"], manual: true },
    async run(): Promise<CheckOutcome> {
      const missing: string[] = [];
      for (const file of HELPER_FILES) {
        const type = await options.fs.lstat(win32.join(options.helperDir, file)).catch(() => undefined);
        if (type !== "file") missing.push(file);
      }
      if (missing.length > 0) return { status: "fail", observed: `missing in ${options.helperDir}: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}` };
      return { status: "pass", observed: `${HELPER_FILES.length} files in ${options.helperDir} (unsigned PowerShell script compiled with Add-Type at start)` };
    },
  };

  const helperReady = ["win.execution-policy", "helper.present"];

  const versionCheck: Check = {
    id: "win.version",
    description: "Windows 10 1809 (build 17763) or later, or Windows 11",
    kind: "observe",
    required: true,
    dependsOn: helperReady,
    timeoutMs: 60_000,
    remediation: { summary: "Update Windows to Windows 10 1809 or later, or Windows 11", manual: true },
    async run(ctx): Promise<CheckOutcome> {
      const outcome = await probe("env", ctx.signal);
      if (!outcome.ok) return { status: "fail", observed: outcome.problem ?? "probe env failed" };
      const build = reportInteger(outcome.report, "build");
      const platform = reportString(outcome.report, "platform", 200);
      const elevated = reportBoolean(outcome.report, "elevated");
      if (build === undefined || build <= 0) return { status: "fail", observed: `the helper could not read the Windows build${platform ? ` (${platform})` : ""}` };
      const detail = `build ${build}${platform ? ` (${platform})` : ""}${elevated ? "; Pi runs elevated, apps will run with the Explorer token" : ""}`;
      if (build < MIN_WINDOWS_BUILD) return { status: "fail", observed: `${detail}; build ${MIN_WINDOWS_BUILD} or later is required` };
      return { status: "pass", observed: detail, facts: { "windows.build": String(build) } };
    },
  };

  const archCheck: Check = {
    id: "win.arch",
    description: "x64 or arm64",
    kind: "observe",
    required: true,
    dependsOn: helperReady,
    timeoutMs: 60_000,
    async run(ctx): Promise<CheckOutcome> {
      const outcome = await probe("env", ctx.signal);
      if (!outcome.ok) return { status: "fail", observed: outcome.problem ?? "probe env failed" };
      const arch = reportString(outcome.report, "arch", 20) ?? "unknown";
      if (!(SUPPORTED_ARCHES as readonly string[]).includes(arch)) return { status: "fail", observed: `${arch}; x64 or arm64 is required` };
      return { status: "pass", observed: arch, facts: { "windows.arch": arch } };
    },
  };

  const desktopCheck: Check = {
    id: "helper.desktop",
    description: "the helper can create and destroy a private desktop",
    kind: "probe",
    required: true,
    dependsOn: ["win.version"],
    timeoutMs: 60_000,
    run: probeCheck("desktop", () => "a private desktop was created and destroyed"),
  };

  const jobCheck: Check = {
    id: "helper.job",
    description: "a process in a kill-on-close Job Object dies when the job handle closes",
    kind: "probe",
    required: true,
    dependsOn: ["win.version"],
    timeoutMs: 60_000,
    run: probeCheck("job", () => "the test process ended when its job closed"),
  };

  const nonElevatedCheck: Check = {
    id: "helper.nonelevated",
    description: "apps can run non-elevated (Explorer token when Pi is elevated)",
    kind: "probe",
    required: true,
    dependsOn: ["win.version"],
    timeoutMs: 60_000,
    remediation: { summary: "Run Pi from a normal, non-elevated session of your own user with Explorer running (UAC on); the package never asks for elevation", manual: true },
    run: probeCheck("nonelevated", (o) => reportString(o.report, "detail", 200) ?? "a non-elevated token is available"),
  };

  const uiaCheck: Check = {
    id: "helper.uia",
    description: "UI Automation reads a window on a private desktop",
    kind: "probe",
    required: true,
    dependsOn: ["helper.desktop"],
    timeoutMs: 60_000,
    run: probeCheck("uia", () => "UI Automation read the probe window's name on a private desktop"),
  };

  const avCheck: Check = {
    id: "helper.av",
    description: "the helper is not blocked or quarantined by antivirus",
    kind: "observe",
    required: false,
    dependsOn: helperReady,
    timeoutMs: 60_000,
    degrades: "sessions may fail to start or be ended by antivirus",
    remediation: {
      summary: `Allow the helper in your antivirus or endpoint protection: it runs ${win32.join(options.helperDir, "helper.ps1")} with Windows PowerShell, compiles C# with Add-Type (csc.exe in %TEMP%), and uses hidden desktops and Job Objects. Ask your administrator if a policy blocks it`,
      manual: true,
    },
    async run(ctx): Promise<CheckOutcome> {
      const outcome = await probe("env", ctx.signal);
      if (outcome.ok) return { status: "pass", observed: "the helper compiled and ran without being blocked" };
      if (outcome.failure === "blocked" || outcome.failure === "killed" || outcome.failure === "timeout") return { status: "fail", observed: outcome.problem ?? "the helper was blocked" };
      return { status: "fail", observed: `not checked: the helper did not start (${outcome.problem ?? "unknown reason"})` };
    },
  };

  return [...common, powershellCheck, policyCheck, presentCheck, versionCheck, archCheck, desktopCheck, jobCheck, nonElevatedCheck, uiaCheck, avCheck];
}
