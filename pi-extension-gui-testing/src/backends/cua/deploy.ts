/**
 * Puts what a session needs into its sandbox (spec §4.3, §4.7): the Linux
 * helper and the smoke app (`<dir>/tools`), the helper's system packages when
 * the image lacks them, and the synced project (`<dir>/workspace`). Archives
 * are staged in the 0700 client session dir and deleted after the upload.
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
import { guestDir } from "./session.ts";

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

/** Prints `missing:<what>` for each helper requirement the guest lacks. */
export const PROBE_SCRIPT = [
  'for c in "$@"; do command -v "$c" >/dev/null 2>&1 || echo "missing:$c"; done',
  "python3 -c 'import gi; gi.require_version(\"Gtk\", \"3.0\"); from gi.repository import Gtk; import pyatspi' >/dev/null 2>&1 || echo missing:python3-gi",
].join("\n");

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
async function uploadAndExtract(api: CuaApi, ref: string, local: string, targetDir: string, signal: AbortSignal): Promise<void> {
  const remote = `${targetDir}.tar`;
  try {
    await api.upload(ref, local, remote, signal);
    await execOk(api, ref, ["tar", "-x", "--no-same-owner", "-f", remote, "-C", targetDir], `unpacking ${targetDir}`, DEPLOY_TIMEOUTS.extract, signal);
  } finally {
    await rm(local, { force: true });
    await api.exec(ref, ["rm", "-f", "--", remote], { timeoutMs: DEPLOY_TIMEOUTS.mkdir }).catch(() => undefined);
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

/** Creates the session dir and unpacks the helper tooling into `<dir>/tools`. */
export async function deployHelper(options: DeployOptions): Promise<void> {
  const { api, ref, signal } = options;
  const dir = guestDir(options.sessionId);
  options.onStatus?.("copying the helper into the sandbox");
  await execOk(api, ref, ["mkdir", "-p", "-m", "700", `${dir}/tools`, `${dir}/workspace`], "creating the session dir", DEPLOY_TIMEOUTS.mkdir, signal);
  const archive = await (options.helperArchive ?? (() => stageBuildContext(PACKAGE_ROOT)))();
  const local = join(options.sessionDir, "helper.tar");
  await writeBufferFile(local, archive);
  await uploadAndExtract(api, ref, local, `${dir}/tools`, signal);
}

/**
 * Installs the helper's packages when the image lacks them (inside the
 * sandbox only; covered by the setup acknowledgement). Returns the missing
 * items it found, `[]` when the image was complete.
 */
export async function ensureHelperPackages(options: Omit<DeployOptions, "sessionDir">): Promise<string[]> {
  const { api, ref, signal } = options;
  const out = await execOk(api, ref, ["sh", "-c", PROBE_SCRIPT, "sh", ...HELPER_COMMANDS], "checking the helper's packages", DEPLOY_TIMEOUTS.probe, signal);
  const missing = out.split("\n").filter((l) => l.startsWith("missing:")).map((l) => l.slice("missing:".length).trim().slice(0, 64));
  if (missing.length === 0) return [];
  options.onStatus?.(`installing the helper's packages in the sandbox (missing: ${missing.join(", ")})`);
  const result = await api.exec(ref, ["sh", "-c", INSTALL_SCRIPT, "sh", ...HELPER_APT_PACKAGES], { timeoutMs: DEPLOY_TIMEOUTS.install, signal });
  if (result.exitCode !== 0) {
    const why = result.exitCode === 90 ? "the sandbox user is not root and has no passwordless sudo" : result.exitCode === 91 ? "the image has no apt-get" : `exit ${result.exitCode ?? result.signal ?? "?"}`;
    throw new CuaApiError(
      "FAILED",
      `the sandbox image lacks ${missing.join(", ")} and installing them failed (${why}); use an image with the helper's packages (Debian/Ubuntu: ${HELPER_APT_PACKAGES.join(" ")})` +
        (result.stderr.trim() ? `\n${redact(result.stderr.trim().split("\n").slice(-5).join("\n"))}` : ""),
    );
  }
  return missing;
}

export interface SyncOptions extends DeployOptions {
  projectRoot: string;
  allow?: readonly string[];
  deny?: readonly string[];
  /** Local runner for `git ls-files`. */
  runner: CommandRunner;
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
  await uploadAndExtract(api, ref, local, `${guestDir(options.sessionId)}/workspace`, signal);
  return summary;
}
