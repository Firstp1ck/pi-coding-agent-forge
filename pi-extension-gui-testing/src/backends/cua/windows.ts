/**
 * Windows guests of the `cua` backend (spec §4.3, §4.4, §4.5): the guest
 * paths of a session, the Windows helper's file set and its deployment check,
 * and every command the backend runs in a Windows sandbox.
 *
 * The Windows helper (`helpers/windows`, PowerShell 5.1 host + C# core) runs
 * in guest mode over `cua sandbox exec -i`, like the Linux helper. Its
 * environment contract values arrive as the first stdin lines (`-StdinEnv`),
 * so no value is in any argv.
 *
 * Quoting: how the `cua` CLI turns an argv into a Windows command line is not
 * part of its contract, so every command the backend sends has an argv that
 * means the same under any joining rule — fixed flags plus one
 * `-EncodedCommand` word (base64 of the UTF-16LE script, letters, digits,
 * `+`, `/`, `=` only). Inside the scripts every value is a PowerShell
 * single-quoted literal ({@link psLiteral}); nothing is ever interpolated.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TargetOs } from "../../config/types.ts";
import { createTar, type TarEntry } from "../docker/tar.ts";
import { PACKAGE_ROOT } from "../docker/package.ts";
import { HELPER_ALLOW_EXEC_ENV, HELPER_MODE_ENV, HELPER_RUNTIME_DIR_ENV, HELPER_WORKSPACE_ENV } from "../remote/linux-session.ts";

/** Target operating systems a `cua` sandbox can run in this build (macOS stays planned). */
export type CuaTarget = Extract<TargetOs, "linux" | "windows">;

/** Guest directory of every Windows session dir; removed whenever a kept Windows sandbox is reused. */
export const WINDOWS_GUEST_ROOT = "C:\\pi-gui-testing";

/**
 * Default Windows image alias, used when setup chose none (`windowsImage` in
 * `cua.json`). A cloud must list it (or the chosen image) as supported in
 * `cua cloud status` before a Windows session starts.
 */
export const DEFAULT_WINDOWS_IMAGE = "windows";

/** Oldest Windows build the helper supports (Windows 10 1809 / Server 2019). */
export const WINDOWS_MIN_BUILD = 17763;

/** Longest command line `CreateProcess` accepts (characters, with the terminating NUL). */
export const WINDOWS_COMMAND_LINE_MAX = 32_767;
/** `setup` entries become encoded Windows PowerShell commands (shared with docker-windows). */
export { CMD_LINE_MAX, windowsSetupCommand } from "../windows/setup-command.ts";

/** Paths of one Windows session in the guest. */
export interface WindowsGuestPaths {
  /** `C:\pi-gui-testing\<sessionId>`: private (protected ACL: the guest user, SYSTEM, Administrators). */
  dir: string;
  /** The deployed helper files. */
  tools: string;
  /** The synced project; launch and `setup` cwd. */
  workspace: string;
  /** The helper's runtime dir; its name must start with `pi-gui-testing-`. */
  runtime: string;
  /** `helper.ps1`. */
  helper: string;
}

export function windowsGuestPaths(sessionId: string): WindowsGuestPaths {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(sessionId)) throw new Error(`invalid session id ${JSON.stringify(sessionId)}`);
  const dir = `${WINDOWS_GUEST_ROOT}\\${sessionId}`;
  return { dir, tools: `${dir}\\tools`, workspace: `${dir}\\workspace`, runtime: `${dir}\\pi-gui-testing-${sessionId}`, helper: `${dir}\\tools\\helper.ps1` };
}

/**
 * `value` as a PowerShell single-quoted literal. Inside one, only quote
 * characters are special, and PowerShell treats the typographic single quotes
 * U+2018–U+201B like `'`: each is doubled. Control characters are refused
 * (they never belong in a path or a variable value here).
 */
export function psLiteral(value: string): string {
  if (/[\0-\x1f\x7f]/.test(value)) throw new Error(`a PowerShell literal cannot hold control characters: ${JSON.stringify(value)}`);
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q)}'`;
}

/** Base64 of the UTF-16LE script, as `powershell.exe -EncodedCommand` expects. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Windows PowerShell 5.1 without profile, prompts, or the execution policy of the guest (the helper is unsigned). */
export const POWERSHELL = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"] as const;

/** Preamble of every script: stop on the first error, no progress records on stderr. */
const PREAMBLE = "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n";

/**
 * The argv that runs `script` with Windows PowerShell 5.1 in the guest.
 *
 * @throws Error when the command line would exceed what `CreateProcess` accepts.
 */
export function powershellArgv(script: string): string[] {
  const argv = [...POWERSHELL, "-EncodedCommand", encodePowerShell(PREAMBLE + script)];
  const length = argv.reduce((sum, word) => sum + word.length + 1, 0);
  if (length >= WINDOWS_COMMAND_LINE_MAX) throw new Error(`a guest PowerShell command is too long (${length} characters; Windows allows ${WINDOWS_COMMAND_LINE_MAX - 1})`);
  return argv;
}

/** The helper's argv in the guest (the contract values follow on stdin, named by `-StdinEnv`, added by the adapter). */
export function windowsHelperArgv(sessionId: string): string[] {
  return [...POWERSHELL, "-File", windowsGuestPaths(sessionId).helper];
}

/**
 * The Windows helper's contract environment (helpers/windows `src/Policy.cs`):
 * guest mode on its default private desktop, `setup` allowed (it runs through
 * `exec`), the session's workspace and runtime dir.
 */
export function windowsHelperEnv(sessionId: string): Record<string, string> {
  const paths = windowsGuestPaths(sessionId);
  return {
    [HELPER_MODE_ENV]: "guest",
    [HELPER_WORKSPACE_ENV]: paths.workspace,
    [HELPER_RUNTIME_DIR_ENV]: paths.runtime,
    [HELPER_ALLOW_EXEC_ENV]: "1",
  };
}

/**
 * Creates the session dir with a protected ACL (inheritance off; full control
 * for the guest user, SYSTEM, and Administrators only), then its `tools`,
 * `workspace`, and runtime subdirs, which inherit it. The Windows helper
 * refuses a runtime dir writable by broad groups, reached through a junction,
 * or not empty; a dir of an earlier session with the same id is removed first.
 */
export function prepareScript(sessionId: string): string {
  const p = windowsGuestPaths(sessionId);
  return [
    `$root = ${psLiteral(WINDOWS_GUEST_ROOT)}`,
    `$dir = ${psLiteral(p.dir)}`,
    "if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root | Out-Null }",
    removeTreeLines("$dir"),
    "New-Item -ItemType Directory -Path $dir | Out-Null",
    "$acl = New-Object System.Security.AccessControl.DirectorySecurity",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "foreach ($sid in @($me, (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'), (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'))) {",
    "  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))",
    "}",
    "Set-Acl -LiteralPath $dir -AclObject $acl",
    `foreach ($sub in @(${[p.tools, p.workspace, p.runtime].map(psLiteral).join(", ")})) { New-Item -ItemType Directory -Path $sub | Out-Null }`,
  ].join("\n");
}

/**
 * Lines that delete the directory tree in `variable` (if it exists) without
 * following junctions or symlinks: `rmdir /s /q` removes links as entries,
 * while `Remove-Item -Recurse` in Windows PowerShell 5.1 can descend into a
 * junction's target. The paths are below {@link WINDOWS_GUEST_ROOT} and hold
 * no space or `cmd.exe` metacharacter, so they pass as plain arguments.
 */
function removeTreeLines(variable: string): string {
  return [
    `if (Test-Path -LiteralPath ${variable}) {`,
    `  & cmd.exe /d /c rmdir /s /q ${variable}`,
    `  if (Test-Path -LiteralPath ${variable}) { [Console]::Error.WriteLine("cannot remove " + ${variable}); exit 1 }`,
    "}",
  ].join("\n");
}

/** Deletes `dir` (a path below {@link WINDOWS_GUEST_ROOT}, or the root itself) without following links; a missing dir is success. */
export function removeDirScript(dir: string): string {
  if (dir !== WINDOWS_GUEST_ROOT && !dir.startsWith(`${WINDOWS_GUEST_ROOT}\\`)) throw new Error(`refusing to remove ${dir}: not below ${WINDOWS_GUEST_ROOT}`);
  if (!/^C:\\[A-Za-z0-9\\-]+$/.test(dir) || dir.includes("\\\\")) throw new Error(`refusing to remove ${dir}: unexpected characters`);
  return [`$dir = ${psLiteral(dir)}`, removeTreeLines("$dir")].join("\n");
}

/**
 * Prints `missing:<what>` for each guest requirement of the helper that is
 * absent: Windows PowerShell 5.1 (`powershell`), Windows build
 * {@link WINDOWS_MIN_BUILD} or newer (`windows-build`), and the bundled
 * `tar.exe` (`tar`, Windows 10 1803 and newer) that unpacks the uploads. Then
 * `build:<n>` for the message.
 */
export function probeScript(): string {
  return [
    "if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -eq 'Core') { 'missing:powershell' }",
    "$build = [int](Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').CurrentBuildNumber",
    `if ($build -lt ${WINDOWS_MIN_BUILD}) { 'missing:windows-build' }`,
    "if (-not (Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\\tar.exe'))) { 'missing:tar' }",
    "'build:' + $build",
  ].join("\n");
}

/** Unpacks the uploaded `archive` into `dir` with the system's `tar.exe` (bsdtar); exits with its status. */
export function extractScript(archive: string, dir: string): string {
  return [
    `$archive = ${psLiteral(archive)}`,
    `$dir = ${psLiteral(dir)}`,
    "& (Join-Path $env:SystemRoot 'System32\\tar.exe') -x -f $archive -C $dir",
    "exit $LASTEXITCODE",
  ].join("\n");
}

/** Deletes one file; a missing file is success. */
export function removeFileScript(path: string): string {
  return `Remove-Item -LiteralPath ${psLiteral(path)} -Force -ErrorAction SilentlyContinue`;
}

/** One file of the Windows helper with its SHA-256. */
export interface HelperFile {
  /** Relative path with `/` separators, e.g. `src/win/Native.cs`. */
  path: string;
  data: Buffer;
  sha256: string;
}

/** Every file under `helpers/windows` (the 17 files `helper.ps1` and its C# sources need), in path order. */
export async function windowsHelperFiles(packageRoot: string = PACKAGE_ROOT): Promise<HelperFile[]> {
  const base = join(packageRoot, "helpers", "windows");
  const files: HelperFile[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(base, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const data = await readFile(join(base, path));
        files.push({ path, data, sha256: createHash("sha256").update(data).digest("hex") });
      } else throw new Error(`helpers/windows/${path} is not a regular file`);
    }
  };
  await walk("");
  if (!files.some((f) => f.path === "helper.ps1")) throw new Error(`the Windows helper is missing from ${base}`);
  return files;
}

/** The helper files as a tar archive (directories first, so bsdtar creates them). */
export function windowsHelperArchive(files: readonly HelperFile[]): Buffer {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const entries: TarEntry[] = [...[...dirs].sort().map((path) => ({ path, type: "dir" as const, mode: 0o755 })), ...files.map((f) => ({ path: f.path, type: "file" as const, mode: 0o644, data: f.data }))];
  return createTar(entries);
}

/**
 * Checks every deployed helper file against its SHA-256 (`Get-FileHash`):
 * prints `bad:<path>` for each missing or different file and exits 1 when
 * any is; prints `ok:<count>` otherwise.
 */
export function verifyScript(toolsDir: string, files: readonly HelperFile[]): string {
  const table = files.map((f) => `  ${psLiteral(f.path.replace(/\//g, "\\"))} = ${psLiteral(f.sha256.toUpperCase())}`).join("\n");
  return [
    `$tools = ${psLiteral(toolsDir)}`,
    "$expected = [ordered]@{",
    table,
    "}",
    "$bad = 0",
    "foreach ($rel in $expected.Keys) {",
    "  $path = Join-Path $tools $rel",
    "  $hash = if (Test-Path -LiteralPath $path -PathType Leaf) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash } else { '' }",
    "  if ($hash -ne $expected[$rel]) { 'bad:' + $rel; $bad++ }",
    "}",
    "if ($bad) { exit 1 }",
    "'ok:' + $expected.Count",
  ].join("\n");
}
