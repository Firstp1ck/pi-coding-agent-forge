/**
 * Commands for the Windows guest's OpenSSH server. Windows sshd hands the
 * command line to its default shell, `cmd.exe /c`, which has no quoting rule
 * that survives arbitrary text. So every command is either:
 *
 * - a Windows PowerShell 5.1 script passed as `-EncodedCommand` (Base64 of
 *   UTF-16LE: only `A-Z a-z 0-9 + / =`, which `cmd.exe` never interprets),
 *   with values embedded as single-quoted PowerShell literals; or
 * - a fixed program with arguments from {@link SAFE_CMD_ARG} only (no space,
 *   quote, `%`, `^`, `&`, `|`, `<`, `>`, `(`, `)`, or `!`).
 *
 * Nothing user-controlled reaches `cmd.exe` unencoded.
 */

/** `cmd.exe` stops reading a command line here (8 191 characters); stay well below. */
export const MAX_COMMAND_LINE = 8_000;

/** Arguments `cmd.exe` passes through unchanged. */
export const SAFE_CMD_ARG = /^[A-Za-z0-9_.,:\\/=+-]+$/;

/** Absolute guest paths this package creates or uses. */
export const SAFE_GUEST_PATH = /^[A-Za-z]:\\(?:[A-Za-z0-9_.-]+\\)*[A-Za-z0-9_.-]*$/;

/**
 * Checks a guest path made of safe characters (no `..` segment, no trailing separator).
 *
 * @throws Error naming the path otherwise.
 */
export function assertGuestPath(path: string): string {
  if (!SAFE_GUEST_PATH.test(path) || path.split("\\").includes("..") || path.endsWith("\\")) throw new Error(`unsafe guest path ${JSON.stringify(path)}`);
  return path;
}

/**
 * A PowerShell single-quoted literal: `'` doubled (PowerShell also treats the
 * typographic quotes U+2018–U+201B as quotes, so they are doubled as well).
 *
 * @throws Error for a NUL character.
 */
export function psQuote(value: string): string {
  if (value.includes("\0")) throw new Error("a PowerShell argument contains a NUL character");
  return `'${value.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}

/** Fixed start of every script: stop on errors, no progress records (they reach stderr as CLIXML). */
const PRELUDE = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }\n";

/** `-EncodedCommand` value of `script` (with the prelude). */
export function encodeScript(script: string): string {
  return Buffer.from(PRELUDE + script, "utf16le").toString("base64");
}

/** Decodes an `-EncodedCommand` value (tests and diagnostics). */
export function decodeScript(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf16le");
}

/** Windows PowerShell 5.1 options of every call: no logo, no profile, never prompts. */
export const POWERSHELL = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"] as const;

/** Argv that runs `script` in Windows PowerShell 5.1. */
export function powershellArgv(script: string): string[] {
  return [...POWERSHELL, "-EncodedCommand", encodeScript(script)];
}

/**
 * Joins an argv into one `cmd.exe` command line.
 *
 * @throws Error for an argument outside {@link SAFE_CMD_ARG} or a line longer than {@link MAX_COMMAND_LINE}.
 */
export function cmdLine(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error("empty argv");
  for (const arg of argv) if (!SAFE_CMD_ARG.test(arg)) throw new Error(`guest command argument ${JSON.stringify(arg.slice(0, 80))} contains characters cmd.exe would interpret`);
  const line = argv.join(" ");
  if (line.length > MAX_COMMAND_LINE) throw new Error(`guest command line is ${line.length} characters (limit ${MAX_COMMAND_LINE})`);
  return line;
}

/** The guest command line that runs `script`. */
export function scriptCommand(script: string): string {
  return cmdLine(powershellArgv(script));
}

/** Script fragment that writes `expression` as one compressed JSON line. */
export function jsonOut(expression: string): string {
  return `ConvertTo-Json -Compress -Depth 6 -InputObject (${expression})`;
}

/** Last JSON line of a script's stdout. */
export function parseJsonOutput<T>(stdout: string): T {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") || l.startsWith("["))
    .at(-1);
  if (!line) throw new Error(`the guest printed no JSON${stdout.trim() ? `: ${stdout.trim().slice(-200)}` : ""}`);
  return JSON.parse(line) as T;
}
