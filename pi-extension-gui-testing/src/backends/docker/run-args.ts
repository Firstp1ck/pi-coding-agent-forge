/**
 * The hardened `docker run` command line of a session (spec §4.1). One
 * function builds it for real sessions and for the `isolation.inspect` probe,
 * so the probe checks exactly what sessions run.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NetworkMode } from "../../config/types.ts";
import { ELECTRON_SHM_SIZE, REQUIRED_RUN_FLAGS } from "../../hardening.ts";
import { LABEL_OWNER, LABEL_SESSION } from "../../labels.ts";
import { HEARTBEAT_TIMEOUT_TEST_ENV, TOKEN_ENV } from "../../protocol.ts";

/** Mount point of the project inside the container. */
export const WORKSPACE_PATH = "/workspace";
/** `$HOME` inside the container. */
export const CONTAINER_HOME = "/home/app";
export const PASSWD_FILE = "passwd";
export const GROUP_FILE = "group";

/** Container name of a session; known before the container exists, so `owner.json` can list it first. */
export function containerName(sessionId: string): string {
  return `pi-gui-testing-${sessionId}`;
}

/** `passwd` and `group` contents mapping the host UID/GID to a user with home {@link CONTAINER_HOME}. */
export function identityFiles(uid: number, gid: number): { passwd: string; group: string } {
  const passwd =
    uid === 0
      ? `root:x:0:0:root:${CONTAINER_HOME}:/bin/sh\n`
      : `root:x:0:0:root:/root:/usr/sbin/nologin\napp:x:${uid}:${gid}:app:${CONTAINER_HOME}:/bin/sh\n`;
  const group = gid === 0 ? "root:x:0:\n" : `root:x:0:\napp:x:${gid}:\n`;
  return { passwd, group };
}

/** Writes the identity files into the session dir (bind-mounted read-only at `/etc/passwd`, `/etc/group`). */
export async function writeIdentityFiles(sessionDir: string, uid: number, gid: number): Promise<void> {
  const files = identityFiles(uid, gid);
  await writeFile(join(sessionDir, PASSWD_FILE), files.passwd, { mode: 0o644 });
  await writeFile(join(sessionDir, GROUP_FILE), files.group, { mode: 0o644 });
}

/** Command names whose apps need a larger `/dev/shm` (mirrors the helper's Chromium detection). */
const CHROMIUM_NAMES = new Set(["electron", "chromium", "chromium-browser", "chrome", "google-chrome", "google-chrome-stable"]);

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `true` for Electron/Chromium launches, including `npx electron` and `node …/electron/cli.js`. */
export function isChromiumLike(cmd: string | undefined, args: readonly string[] = []): boolean {
  if (!cmd) return false;
  if (CHROMIUM_NAMES.has(baseName(cmd))) return true;
  if ((baseName(cmd) === "npx" || baseName(cmd) === "node") && args.length > 0) {
    return CHROMIUM_NAMES.has(baseName(args[0])) || args[0].endsWith("/electron/cli.js");
  }
  return false;
}

export interface RunArgsInput {
  sessionId: string;
  ownerLabel: string;
  image: string;
  uid: number;
  gid: number;
  /** Holds `passwd` and `group`. */
  sessionDir: string;
  /** Host directory mounted at {@link WORKSPACE_PATH}. */
  workspace: { source: string; readOnly: boolean };
  network: NetworkMode;
  /** `--shm-size` value, or undefined for Docker's default. */
  shmSize?: string;
  /** Test-only: shortened helper heartbeat timeout. */
  heartbeatTimeoutMs?: number;
}

/**
 * `docker run` arguments (after `docker --host <h>`). The framing token is
 * passed as `-e PI_GUI_TESTING_TOKEN` without a value, so it is taken from the
 * CLI's environment and never appears in `ps`.
 */
export function dockerRunArgs(input: RunArgsInput): string[] {
  const { uid, gid } = input;
  const owned = `uid=${uid},gid=${gid}`;
  const args = [
    "run",
    "-i",
    "--rm",
    "--pull",
    "never",
    "--name",
    containerName(input.sessionId),
    "--label",
    `${LABEL_SESSION}=${input.sessionId}`,
    "--label",
    `${LABEL_OWNER}=${input.ownerLabel}`,
    "--user",
    `${uid}:${gid}`,
    ...REQUIRED_RUN_FLAGS,
  ];
  if (input.network === "none") args.push("--network", "none");
  args.push(
    "--tmpfs",
    `/tmp:${owned},mode=1777`,
    "--tmpfs",
    `/scratch:${owned},mode=0700`,
    "--tmpfs",
    `${CONTAINER_HOME}:${owned},mode=0700`,
    "--tmpfs",
    `/deps:${owned},mode=0755,exec`,
    "--tmpfs",
    `/run/user/${uid}:${owned},mode=0700`,
    "-v",
    `${join(input.sessionDir, PASSWD_FILE)}:/etc/passwd:ro`,
    "-v",
    `${join(input.sessionDir, GROUP_FILE)}:/etc/group:ro`,
    "-v",
    `${input.workspace.source}:${WORKSPACE_PATH}:${input.workspace.readOnly ? "ro" : "rw"}`,
    "-e",
    `HOME=${CONTAINER_HOME}`,
    "-e",
    `XDG_RUNTIME_DIR=/run/user/${uid}`,
    "-e",
    TOKEN_ENV,
  );
  if (input.heartbeatTimeoutMs !== undefined) args.push("-e", `${HEARTBEAT_TIMEOUT_TEST_ENV}=${input.heartbeatTimeoutMs}`);
  if (input.shmSize) args.push("--shm-size", input.shmSize);
  args.push(input.image);
  return args;
}

/** The same configuration as `docker create`, for the inspect probe; the container is never started. */
export function dockerCreateArgs(input: RunArgsInput): string[] {
  const run = dockerRunArgs(input);
  return ["create", ...run.slice(1)];
}

/** `--shm-size` for a launch: {@link ELECTRON_SHM_SIZE} for Chromium/Electron, otherwise Docker's default. */
export function shmSizeFor(cmd: string | undefined, args: readonly string[] = []): string | undefined {
  return isChromiumLike(cmd, args) ? ELECTRON_SHM_SIZE : undefined;
}
