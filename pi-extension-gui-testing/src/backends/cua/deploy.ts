/**
 * Puts what a session needs into its sandbox (spec §4.3, §4.7): the Linux
 * helper and the smoke app (`<dir>/tools`), the helper's system packages when
 * the image lacks them, and the synced project (`<dir>/workspace`). The helper
 * runs in host mode as the sandbox user (`<dir>/run` runtime dir,
 * `<root>/displays` display locks, `<dir>/deps` for `setup` installs), so
 * nothing outside the session dir needs to be writable. Archives are staged
 * in the 0700 client session dir and deleted after the upload.
 *
 * Windows sandboxes (`--targets windows`) get the Windows helper's 17 files in
 * `<dir>\tools`, checked by SHA-256 after unpacking, and the project in
 * `<dir>\workspace`; see `./windows.ts` for the guest commands.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SyncSummary } from "../../backend.ts";
import type { CommandRunner } from "../../runner/types.ts";
import { buildFileSet } from "../../sync/fileset.ts";
import { stageBuildContext } from "../docker/image.ts";
import { PACKAGE_ROOT } from "../docker/package.ts";
import { CuaApiError, type CuaApi } from "./api.ts";
import { writeBufferFile, writeWorkspaceTar } from "./bundle.ts";
import { redact } from "./redact.ts";
import { GUEST_ROOT, guestDir, guestWorkspace } from "./session.ts";
import { extractScript, powershellArgv, prepareScript, probeScript, removeFileScript, verifyScript, windowsGuestPaths, windowsHelperArchive, windowsHelperFiles, WINDOWS_MIN_BUILD, type CuaTarget, type HelperFile } from "./windows.ts";

/** Commands the helper runs (`Xvfb`, `dbus-daemon`, `xdotool`, `import`, `xprop`, `xwininfo`) plus the Python modules it imports. */
export const HELPER_COMMANDS = ["Xvfb", "dbus-daemon", "xdotool", "import", "xprop", "xwininfo", "python3"] as const;

/** Debian/Ubuntu packages providing the helper's tools (a subset of the docker-linux base image). */
export const HELPER_APT_PACKAGES = [
  "xvfb",
  "xauth",
  "x11-utils",
  "xdotool",
  "imagemagick",
  "openbox",
  "dbus",
  "dbus-x11",
  "at-spi2-core",
  "python3",
  "python3-gi",
  "python3-gi-cairo",
  "python3-pyatspi",
  "gir1.2-gtk-3.0",
  "gir1.2-atspi-2.0",
  "fonts-dejavu-core",
] as const;

/** Installs `pip` for `setup` commands that use it (they install below the session's deps dir with `pip install --target`). */
export const PIP_APT_PACKAGE = "python3-pip";

/**
 * Prints `missing:<what>` for each helper requirement the guest lacks. `$1` is
 * `1` when `setup` uses pip (then `python3 -m pip` is required too), the
 * rest are commands.
 */
export const PROBE_SCRIPT = [
  "pip=$1; shift",
  'for c in "$@"; do command -v "$c" >/dev/null 2>&1 || echo "missing:$c"; done',
  "python3 -c 'import gi; gi.require_version(\"Gtk\", \"3.0\"); from gi.repository import Gtk; import pyatspi' >/dev/null 2>&1 || echo missing:python3-gi",
  '[ "$pip" != 1 ] || python3 -m pip --version >/dev/null 2>&1 || echo missing:python3-pip',
].join("\n");

/** Whether a `setup` command calls pip (`pip`, `pip3`, `python3 -m pip`). */
export function setupUsesPip(commands: readonly string[]): boolean {
  return commands.some((cmd) => /(^|[\s;&|(])(pip3?|python3?(\.\d+)? -m pip)(\s|$)/.test(cmd));
}

/** Installs `$@` with apt as root or through passwordless sudo; exits 90 without either, 91 without apt. */
export const INSTALL_SCRIPT = [
  'if [ "$(id -u)" = 0 ]; then S=""; elif sudo -n true 2>/dev/null; then S="sudo -n"; else echo "needs root or passwordless sudo in the sandbox" >&2; exit 90; fi',
  'command -v apt-get >/dev/null 2>&1 || { echo "the sandbox image has no apt-get" >&2; exit 91; }',
  "export DEBIAN_FRONTEND=noninteractive",
  '$S apt-get update -q && $S apt-get install -y -q --no-install-recommends "$@"',
].join("\n");

export const DEPLOY_TIMEOUTS = { mkdir: 60_000, extract: 5 * 60_000, probe: 60_000, install: 15 * 60_000 } as const;

async function execOk(api: CuaApi, ref: string, argv: readonly string[], what: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const result = await api.exec(ref, argv, { timeoutMs, signal });
  if (result.exitCode !== 0) throw new CuaApiError("FAILED", `${what} failed in the sandbox (exit ${result.exitCode ?? result.signal ?? "?"})${result.stderr.trim() ? `: ${redact(result.stderr.trim())}` : ""}`);
  return result.stdout;
}

/** Uploads a staged local archive and unpacks it into `targetDir`; removes both copies of the archive. */
async function uploadAndExtract(api: CuaApi, ref: string, local: string, targetDir: string, signal: AbortSignal, target: CuaTarget = "linux"): Promise<void> {
  const remote = `${targetDir}.tar`;
  const windows = target === "windows";
  try {
    await api.upload(ref, local, remote, signal);
    const extract = windows ? powershellArgv(extractScript(remote, targetDir)) : ["tar", "-x", "--no-same-owner", "-f", remote, "-C", targetDir];
    await execOk(api, ref, extract, `unpacking ${targetDir}`, DEPLOY_TIMEOUTS.extract, signal);
  } finally {
    await rm(local, { force: true });
    await api.exec(ref, windows ? powershellArgv(removeFileScript(remote)) : ["rm", "-f", "--", remote], { timeoutMs: DEPLOY_TIMEOUTS.mkdir }).catch(() => undefined);
  }
}

export interface DeployOptions {
  api: CuaApi;
  ref: string;
  sessionId: string;
  /** Client session dir (0700) for staging archives. */
  sessionDir: string;
  signal: AbortSignal;
  onStatus?(text: string): void;
  /** Helper tooling archive; default: the docker-linux build context (helper, `pi_gui_helper`, smoke app). */
  helperArchive?: () => Promise<Buffer>;
}

/**
 * Creates the session dir (0700, with `tools/`, `workspace/`, `run/`) and the
 * shared display lock dir, and unpacks the helper tooling into `<dir>/tools`.
 */
export async function deployHelper(options: DeployOptions): Promise<void> {
  const { api, ref, signal } = options;
  const dir = guestDir(options.sessionId);
  options.onStatus?.("copying the helper into the sandbox");
  await execOk(api, ref, ["mkdir", "-p", "-m", "700", `${GUEST_ROOT}/displays`, dir, `${dir}/tools`, `${dir}/workspace`, `${dir}/run`], "creating the session dir", DEPLOY_TIMEOUTS.mkdir, signal);
  const archive = await (options.helperArchive ?? (() => stageBuildContext(PACKAGE_ROOT)))();
  const local = join(options.sessionDir, "helper.tar");
  await writeBufferFile(local, archive);
  await uploadAndExtract(api, ref, local, `${dir}/tools`, signal);
}

/**
 * Installs the helper's packages (and pip, when `setup` uses it) when the
 * image lacks them (inside the sandbox only; covered by the setup
 * acknowledgement). Returns the missing items it found, `[]` when the image
 * was complete.
 */
export async function ensureHelperPackages(options: Omit<DeployOptions, "sessionDir"> & { pip?: boolean }): Promise<string[]> {
  const { api, ref, signal } = options;
  const out = await execOk(api, ref, ["sh", "-c", PROBE_SCRIPT, "sh", options.pip ? "1" : "0", ...HELPER_COMMANDS], "checking the helper's packages", DEPLOY_TIMEOUTS.probe, signal);
  const missing = out.split("\n").filter((l) => l.startsWith("missing:")).map((l) => l.slice("missing:".length).trim().slice(0, 64));
  if (missing.length === 0) return [];
  options.onStatus?.(`installing the helper's packages in the sandbox (missing: ${missing.join(", ")})`);
  const packages = options.pip ? [...HELPER_APT_PACKAGES, PIP_APT_PACKAGE] : [...HELPER_APT_PACKAGES];
  const result = await api.exec(ref, ["sh", "-c", INSTALL_SCRIPT, "sh", ...packages], { timeoutMs: DEPLOY_TIMEOUTS.install, signal });
  if (result.exitCode !== 0) {
    const why = result.exitCode === 90 ? "the sandbox user is not root and has no passwordless sudo" : result.exitCode === 91 ? "the image has no apt-get" : `exit ${result.exitCode ?? result.signal ?? "?"}`;
    throw new CuaApiError(
      "FAILED",
      `the sandbox image lacks ${missing.join(", ")} and installing them failed (${why}); use an image with the helper's packages (Debian/Ubuntu: ${packages.join(" ")})` +
        (result.stderr.trim() ? `\n${redact(result.stderr.trim().split("\n").slice(-5).join("\n"))}` : ""),
    );
  }
  return missing;
}

export interface WindowsDeployOptions extends Omit<DeployOptions, "helperArchive"> {
  /** The helper's files; default: every file under `helpers/windows`. */
  helperFiles?: () => Promise<HelperFile[]>;
}

/**
 * Windows guests: creates the private session dir (with `tools`, `workspace`,
 * and the runtime dir) and checks what the helper needs from the guest:
 * Windows PowerShell 5.1, build {@link WINDOWS_MIN_BUILD} or newer, and
 * `tar.exe`. Nothing is installed in a Windows sandbox; a missing requirement
 * fails the start with what to change.
 */
export async function prepareWindowsGuest(options: Omit<DeployOptions, "sessionDir" | "helperArchive">): Promise<void> {
  const { api, ref, signal } = options;
  options.onStatus?.("preparing the Windows sandbox");
  await execOk(api, ref, powershellArgv(prepareScript(options.sessionId)), "creating the session dir", DEPLOY_TIMEOUTS.mkdir, signal);
  const out = await execOk(api, ref, powershellArgv(probeScript()), "checking the Windows sandbox", DEPLOY_TIMEOUTS.probe, signal);
  const lines = out.split(/\r?\n/);
  const missing = lines.filter((l) => l.startsWith("missing:")).map((l) => l.slice("missing:".length).trim().slice(0, 64));
  if (missing.length === 0) return;
  const build = lines.find((l) => l.startsWith("build:"))?.slice("build:".length).trim().slice(0, 16);
  const why: Record<string, string> = {
    powershell: "Windows PowerShell 5.1 (powershell.exe)",
    "windows-build": `Windows 10 1809 / Server 2019 (build ${WINDOWS_MIN_BUILD}) or newer${build ? `, found build ${build}` : ""}`,
    tar: "the system tar.exe (Windows 10 1803 and newer)",
  };
  throw new CuaApiError("FAILED", `the Windows sandbox image lacks ${missing.map((m) => why[m] ?? m).join(", ")}; choose another Windows image at /gui-setup cua`);
}

/**
 * Uploads the Windows helper's files into `<dir>\tools` and checks each one
 * against its SHA-256 in the guest. A mismatch (a truncated upload, an
 * extraction that changed bytes, a file the guest's security software
 * removed) fails the start.
 */
export async function deployWindowsHelper(options: WindowsDeployOptions): Promise<void> {
  const { api, ref, signal } = options;
  const paths = windowsGuestPaths(options.sessionId);
  options.onStatus?.("copying the Windows helper into the sandbox");
  const files = await (options.helperFiles ?? (() => windowsHelperFiles()))();
  const local = join(options.sessionDir, "helper.tar");
  await writeBufferFile(local, windowsHelperArchive(files));
  await uploadAndExtract(api, ref, local, paths.tools, signal, "windows");
  const result = await api.exec(ref, powershellArgv(verifyScript(paths.tools, files)), { timeoutMs: DEPLOY_TIMEOUTS.probe, signal });
  if (result.exitCode !== 0) {
    const bad = result.stdout.split(/\r?\n/).filter((l) => l.startsWith("bad:")).map((l) => l.slice("bad:".length).trim().slice(0, 128));
    throw new CuaApiError(
      "FAILED",
      bad.length > 0
        ? `the Windows helper in the sandbox does not match this package (missing or changed: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ", …" : ""})`
        : `checking the Windows helper in the sandbox failed (exit ${result.exitCode ?? result.signal ?? "?"})${result.stderr.trim() ? `: ${redact(result.stderr.trim())}` : ""}`,
    );
  }
}

export interface SyncOptions extends DeployOptions {
  projectRoot: string;
  allow?: readonly string[];
  deny?: readonly string[];
  /** Local runner for `git ls-files`. */
  runner: CommandRunner;
  /** Guest OS; default `linux`. */
  target?: CuaTarget;
}

/** Uploads the §4.7 file set into `<dir>/workspace`; returns files, bytes, and the excluded count. */
export async function syncWorkspace(options: SyncOptions): Promise<SyncSummary> {
  const { api, ref, signal } = options;
  options.onStatus?.("uploading the workspace (sync rules apply; secrets are never uploaded)");
  const set = await buildFileSet(options.projectRoot, { allow: options.allow, deny: options.deny, runner: options.runner, signal });
  const local = join(options.sessionDir, "workspace.tar");
  let summary: SyncSummary;
  try {
    summary = await writeWorkspaceTar(set, local, signal);
  } catch (error) {
    await rm(local, { force: true });
    throw error;
  }
  const target = options.target ?? "linux";
  await uploadAndExtract(api, ref, local, guestWorkspace(target, options.sessionId), signal, target);
  return summary;
}
