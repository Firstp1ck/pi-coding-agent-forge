/**
 * Environment of the Windows helper when the client starts it directly
 * (`local-windows`, and its probes). Built from an allow-list of Windows
 * system variables, so API keys, tokens, and other secrets in Pi's
 * environment never reach the helper or the apps it starts (apps inherit the
 * helper's environment minus `PI_GUI_*`).
 */
import { HEARTBEAT_TIMEOUT_TEST_ENV, TOKEN_ENV } from "../../protocol.ts";
import { envValue } from "./paths.ts";

/** Helper contract variables (`helpers/windows/src/Policy.cs`, `HostConfig`). */
export const WIN_HELPER_ENV = {
  mode: "PI_GUI_HELPER_MODE",
  workspace: "PI_GUI_WORKSPACE",
  runtimeDir: "PI_GUI_RUNTIME_DIR",
  allowExec: "PI_GUI_ALLOW_EXEC",
  allowElevated: "PI_GUI_ALLOW_ELEVATED",
  desktop: "PI_GUI_WIN_DESKTOP",
  input: "PI_GUI_WIN_INPUT",
  softwareRendering: "PI_GUI_WIN_SOFTWARE_RENDERING",
  depsDir: "PI_GUI_DEPS_DIR",
  /** Session tag chosen by the client: every job and the private desktop carry it. */
  tag: "PI_GUI_WIN_TAG",
} as const;

/**
 * Variables copied from Pi's environment. PowerShell, `csc.exe` (which
 * `Add-Type` runs, and which needs `TEMP`), and ordinary apps need these; none
 * carries a credential. `LOCALAPPDATA` is also how the helper checks where the
 * runtime dir lives.
 */
export const WIN_PASSED_ENV = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "Path",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "APPDATA",
  "ProgramData",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "OS",
] as const;

/**
 * Contract variables `local-windows` never sets: no `exec` (so `setup` never
 * runs), no elevated apps, never the interactive desktop or real input, no
 * deps cache. The token is added by `HelperSession` only.
 */
export const WIN_LOCAL_FORBIDDEN_ENV = [
  TOKEN_ENV,
  WIN_HELPER_ENV.allowExec,
  WIN_HELPER_ENV.allowElevated,
  WIN_HELPER_ENV.desktop,
  WIN_HELPER_ENV.input,
  WIN_HELPER_ENV.depsDir,
] as const;

/** The allow-listed system variables of `base`, with their Windows spelling, deduplicated case-insensitively. */
export function passedWindowsEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WIN_PASSED_ENV) {
    const value = envValue(base, key);
    if (typeof value === "string" && value !== "" && !/[\0\r\n]/.test(value)) env[key] = value;
  }
  return env;
}

export interface LocalHelperEnvInput {
  /** Pi's environment; only {@link WIN_PASSED_ENV} is read. */
  base: Readonly<Record<string, string | undefined>>;
  workspace: string;
  runtimeDir: string;
  /** Session tag (16 hex), the runtime dir's own: the client recorded it in `owner.json` before the helper starts. */
  tag?: string;
  /** Test-only shortened heartbeat timeout. */
  heartbeatTimeoutMs?: number;
}

/** The complete environment of a `local` helper, without the token. */
export function localHelperEnv(input: LocalHelperEnvInput): Record<string, string> {
  const env = passedWindowsEnv(input.base);
  env[WIN_HELPER_ENV.mode] = "local";
  env[WIN_HELPER_ENV.workspace] = input.workspace;
  env[WIN_HELPER_ENV.runtimeDir] = input.runtimeDir;
  if (input.tag !== undefined) env[WIN_HELPER_ENV.tag] = input.tag;
  if (input.heartbeatTimeoutMs !== undefined) env[HEARTBEAT_TIMEOUT_TEST_ENV] = String(input.heartbeatTimeoutMs);
  return env;
}

/** Names in `env` that a `local` helper must not get (case-insensitive): forbidden contract variables, the token, or anything not allow-listed. */
export function forbiddenLocalHelperEnv(env: Readonly<Record<string, string>>): string[] {
  const allowed = new Set<string>([...WIN_PASSED_ENV, WIN_HELPER_ENV.mode, WIN_HELPER_ENV.workspace, WIN_HELPER_ENV.runtimeDir, WIN_HELPER_ENV.softwareRendering, WIN_HELPER_ENV.tag, HEARTBEAT_TIMEOUT_TEST_ENV].map((k) => k.toLowerCase()));
  const forbidden = new Set<string>(WIN_LOCAL_FORBIDDEN_ENV.map((k) => k.toLowerCase()));
  return Object.keys(env).filter((key) => forbidden.has(key.toLowerCase()) || !allowed.has(key.toLowerCase()));
}
