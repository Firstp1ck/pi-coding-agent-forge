/**
 * `setup` commands in a Windows guest (`docker-windows`, `cua` with a Windows
 * target). The Windows helper's `exec` runs `cmd.exe /d /s /c "<cmd>"`; the
 * documented semantics of a `setup` entry on Windows are a Windows PowerShell
 * 5.1 script, so each entry is wrapped into one encoded PowerShell command
 * line before it reaches `exec`.
 */
import { encodeCommand } from "./paths.ts";

/** Longest command line `cmd.exe` accepts; the helper runs `setup` commands through `cmd.exe /d /s /c`. */
export const CMD_LINE_MAX = 8_191;

/** Windows PowerShell 5.1 in the guest, without profile, prompts, or the guest's execution policy. */
const GUEST_POWERSHELL = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"] as const;

/**
 * A `setup` command for the Windows helper's `exec`: the command runs as a
 * Windows PowerShell 5.1 script in the workspace. A failing cmdlet stops it
 * (exit 1, its error on stderr); a failing native command does not
 * (PowerShell 5.1 has no switch for that), and the script exits with the
 * last native command's exit code. Chain native commands with
 * `if ($LASTEXITCODE) { exit $LASTEXITCODE }` to stop early. Encoded, so no
 * `cmd.exe` metacharacter of the command reaches `cmd.exe`.
 *
 * @throws Error when the encoded command exceeds `cmd.exe`'s line limit.
 */
export function windowsSetupCommand(cmd: string): string {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$global:LASTEXITCODE = 0",
    "try {",
    cmd,
    "} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }",
    "if ($global:LASTEXITCODE) { exit $global:LASTEXITCODE }",
    "exit 0",
  ].join("\n");
  const line = [...GUEST_POWERSHELL, "-EncodedCommand", encodeCommand(script)].join(" ");
  // `cmd.exe /d /s /c "` + line + `"` must fit cmd.exe's limit.
  if (line.length + 16 > CMD_LINE_MAX) throw new Error(`the setup command is too long for a Windows guest (${cmd.length} characters; about ${Math.floor((CMD_LINE_MAX - 200) / 2.7)} fit)`);
  return line;
}
