/**
 * Windows host facts shared by the Windows backends' client code: case-
 * insensitive environment lookups, absolute drive paths, the system tools
 * (always from `%SystemRoot%\System32`, never from `PATH`), and where the
 * helper lives in the installed package. Paths use `path.win32` whatever the
 * platform running this code, so unit tests can simulate a Windows host.
 */
import { join as nativeJoin } from "node:path";
import { win32 } from "node:path";
import { PACKAGE_ROOT } from "../docker/package.ts";

/** Directory of the Windows helper in the installed package. */
export const HELPER_DIR = nativeJoin(PACKAGE_ROOT, "helpers", "windows");

/** Every file the helper needs, relative to {@link HELPER_DIR} (the fixed list of `helper.ps1` plus the script and notice). */
export const HELPER_FILES = [
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
] as const;

/** Prefix the helper requires for its runtime dir (`HostConfig.RuntimePrefix`). */
export const RUNTIME_DIR_PREFIX = "pi-gui-testing-";

/**
 * Value of `name` in `env`, compared case-insensitively like Windows does
 * (`Path` and `PATH` are the same variable). An exact match wins.
 */
export function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const exact = env[name];
  if (typeof exact === "string") return exact;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === lower && typeof value === "string") return value;
  return undefined;
}

/** `true` for an absolute local drive path such as `C:\Windows` (no UNC, no device path, no relative part). */
export function isDrivePath(path: string): boolean {
  if (!/^[A-Za-z]:\\/.test(path) || /[\0\r\n"<>|?*]/.test(path.slice(2))) return false;
  return !path.split("\\").some((part) => part === "." || part === "..");
}

/** Lower-cased, normalised drive path without a trailing separator, for case-insensitive comparisons. */
export function pathKey(path: string): string {
  const normal = win32.normalize(path);
  const trimmed = normal.length > 3 && normal.endsWith("\\") ? normal.slice(0, -1) : normal;
  return trimmed.toLowerCase();
}

/** `true` when two Windows paths name the same location (case-insensitive, normalised). */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** `true` when `child` is directly inside `parent`. */
export function isDirectChild(parent: string, child: string): boolean {
  return samePath(win32.dirname(win32.normalize(child)), parent);
}

/**
 * `%SystemRoot%` from `env`, checked: an absolute drive path.
 *
 * @throws Error when it is missing or not an absolute drive path.
 */
export function systemRoot(env: Readonly<Record<string, string | undefined>>): string {
  const root = envValue(env, "SystemRoot") ?? envValue(env, "windir");
  if (!root || !isDrivePath(root)) throw new Error(`SystemRoot is ${root ? `"${root}", not an absolute drive path` : "not set"}; Windows tools cannot be located`);
  return win32.normalize(root);
}

/** `%SystemRoot%\System32\<name>`. */
export function system32Tool(env: Readonly<Record<string, string | undefined>>, name: string): string {
  return win32.join(systemRoot(env), "System32", name);
}

/** Windows PowerShell 5.1: always `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, never a `PATH` lookup (a planted `powershell.exe` must not run). */
export function powershellPath(env: Readonly<Record<string, string | undefined>>): string {
  return win32.join(systemRoot(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * `%LOCALAPPDATA%\Temp`, the only parent the helper accepts for a local runtime dir.
 *
 * @throws Error when `LOCALAPPDATA` is missing or not an absolute drive path.
 */
export function localTempRoot(env: Readonly<Record<string, string | undefined>>): string {
  const local = envValue(env, "LOCALAPPDATA");
  if (!local || !isDrivePath(local)) throw new Error(`LOCALAPPDATA is ${local ? `"${local}", not an absolute drive path` : "not set"}; the session temp dir cannot be created`);
  return win32.join(win32.normalize(local), "Temp");
}

/** PowerShell arguments that run a script file without profile, prompts, or a local execution policy in the way. */
export const POWERSHELL_FILE_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"] as const;

/** Argv that runs the helper script with Windows PowerShell 5.1 (`extra` e.g. `["-Probe", "env"]`). */
export function helperArgv(powershell: string, helperDir: string, extra: readonly string[] = []): string[] {
  return [powershell, ...POWERSHELL_FILE_ARGS, win32.join(helperDir, "helper.ps1"), ...extra];
}

/** PowerShell `-EncodedCommand` value (Base64 of UTF-16LE) for a fixed script, so no quoting reaches the command line. */
export function encodeCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Argv that runs a fixed inline script with Windows PowerShell 5.1; data goes through the environment, never the script text. */
export function inlineScriptArgv(powershell: string, script: string): string[] {
  return [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(script)];
}

/**
 * Argv that ends process `pid` only while it still has the start time
 * `start` (Unix seconds, as `owner.json` records Windows processes), so a
 * reused PID is never hit. Bounded by the caller's timeout; no tree kill: the
 * helper's kill-on-close Job Objects end its apps when it dies.
 *
 * @throws Error when `pid` or `start` is malformed (they are embedded in the script as numbers).
 */
export function stopProcessArgv(powershell: string, pid: number, start: string): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff || !/^[1-9]\d{0,14}$/.test(start)) throw new Error(`invalid process identity ${pid}:${start}`);
  const script = [
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    `if ($null -ne $p -and $null -ne $p.StartTime -and ([DateTimeOffset]$p.StartTime).ToUnixTimeSeconds() -eq ${start}) { Stop-Process -InputObject $p -Force -ErrorAction SilentlyContinue }`,
  ].join("\n");
  return inlineScriptArgv(powershell, script);
}

/** Bounded, single-line, printable copy of untrusted text (helper output, stderr) for a message. */
export function boundedText(text: unknown, max = 300): string {
  const flat = String(text ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
