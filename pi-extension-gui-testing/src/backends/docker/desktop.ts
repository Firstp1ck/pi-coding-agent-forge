/**
 * Docker Desktop hosts for `docker-linux` (M1c): macOS and Windows clients
 * whose Linux containers run in Docker Desktop's Linux VM. What differs from
 * a Linux host with Docker Engine, in one place:
 *
 * - **Endpoint**: macOS uses a `unix://` socket (`~/.docker/run/docker.sock`,
 *   context `desktop-linux`); Windows uses a local named pipe
 *   (`npipe:////./pipe/docker_engine` or `…/dockerDesktopLinuxEngine`). Only
 *   endpoints on this machine are accepted; TCP, SSH, and remote pipes fail.
 * - **Container user**: macOS runs the container as your UID/GID (Desktop's
 *   file sharing maps ownership back to you). Windows has no POSIX UID, so the
 *   container runs as {@link WINDOWS_CONTAINER_UID}:{@link WINDOWS_CONTAINER_GID}.
 * - **Paths**: bind sources are host paths in the host's form (`C:\…` on
 *   Windows). The daemon may report them in a VM form (`/run/desktop/mnt/host/c/…`,
 *   `/host_mnt/…`); {@link hostPathForms} and {@link daemonSourceToHost} map
 *   between them, so the isolation rules judge the host path.
 * - **Forbidden roots**: besides the Linux list, Docker Desktop's own state
 *   (sockets, VM data) and the Windows system directory are never mounted,
 *   and on Windows a drive root and the user profile are refused as project roots.
 * - **Workspace identity**: Desktop's file sharing does not keep the host's
 *   device and inode numbers, so the post-start check compares a fingerprint
 *   of the top-level directory listing instead (see {@link listingFingerprint}).
 */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type DockerHostFlavor = "engine" | "desktop-macos" | "desktop-windows";

/** The container user on Windows hosts (there is no POSIX UID to map). */
export const WINDOWS_CONTAINER_UID = 1000;
export const WINDOWS_CONTAINER_GID = 1000;

/** `engine` (Linux host, Docker Engine or Docker Desktop for Linux), or a Docker Desktop flavor. */
export function hostFlavor(platform: NodeJS.Platform): DockerHostFlavor {
  if (platform === "darwin") return "desktop-macos";
  if (platform === "win32") return "desktop-windows";
  return "engine";
}

/** UID/GID the container runs as. */
export function containerUser(platform: NodeJS.Platform, ids: { uid?: number; gid?: number } = {}): { uid: number; gid: number } {
  if (platform === "win32") return { uid: ids.uid ?? WINDOWS_CONTAINER_UID, gid: ids.gid ?? WINDOWS_CONTAINER_GID };
  return { uid: ids.uid ?? process.getuid?.() ?? 0, gid: ids.gid ?? process.getgid?.() ?? 0 };
}

/** A local Windows named pipe: `npipe:////./pipe/<name>` (also with backslashes). */
const LOCAL_NPIPE = /^npipe:(?:\/\/\/\/\.\/pipe\/|\\\\\\\\\.\\pipe\\)[A-Za-z0-9_.-]+$/;

/**
 * Why `host` is not a local endpoint for `platform`, or `undefined` when it is.
 * Linux and macOS: a `unix://` socket. Windows: a local named pipe.
 */
export function endpointProblem(platform: NodeJS.Platform, host: string): string | undefined {
  if (platform === "win32") {
    if (LOCAL_NPIPE.test(host)) return undefined;
    return `only a local Docker Desktop engine on a named pipe (npipe:////./pipe/docker_engine) is supported`;
  }
  if (host.startsWith("unix://") && host.length > "unix://".length) return undefined;
  return `only a local Docker daemon on a unix:// socket is supported`;
}

/** What to run when the endpoint is not local. */
export function endpointRemedy(platform: NodeJS.Platform, origin: "DOCKER_HOST" | "context"): string {
  if (origin === "DOCKER_HOST") return "Unset DOCKER_HOST";
  return platform === "darwin" || platform === "win32" ? "Run: docker context use desktop-linux" : "Run: docker context use default";
}

/** Path module of a platform's host paths. */
function pathsOf(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** Windows paths compare case-insensitively; POSIX paths exactly. */
function key(platform: NodeJS.Platform, path: string): string {
  const p = pathsOf(platform);
  const normal = p.normalize(path).replace(/[\\/]+$/, "") || p.sep;
  // Keep the root of a drive (`C:\`).
  const fixed = platform === "win32" && /^[A-Za-z]:$/.test(normal) ? `${normal}\\` : normal;
  return platform === "win32" ? fixed.toLowerCase() : fixed;
}

/** `true` when `a` equals `b` or is an ancestor of it, in `platform`'s path semantics. */
export function isSameOrAncestorOn(platform: NodeJS.Platform, a: string, b: string): boolean {
  const ka = key(platform, a);
  const kb = key(platform, b);
  const sep = pathsOf(platform).sep;
  if (kb === ka) return true;
  const prefix = ka.endsWith(sep) ? ka : `${ka}${sep}`;
  return kb.startsWith(prefix);
}

/**
 * Every form the daemon may report for host path `path` (for comparing a
 * container's mount source with the directory that was checked).
 */
export function hostPathForms(platform: NodeJS.Platform, path: string): string[] {
  if (platform === "win32") {
    const native = win32.normalize(path);
    const drive = /^([A-Za-z]):[\\/](.*)$/.exec(native);
    if (!drive) return [...new Set([path, native])];
    const letter = drive[1].toLowerCase();
    const rest = drive[2].replace(/\\/g, "/");
    return [
      native,
      `${drive[1].toUpperCase()}:\\${drive[2]}`,
      `${letter}:\\${drive[2]}`,
      `${drive[1]}:/${rest}`,
      `/${letter}/${rest}`,
      `//${letter}/${rest}`,
      `/run/desktop/mnt/host/${letter}/${rest}`,
      `/host_mnt/${letter}/${rest}`,
    ];
  }
  if (platform === "darwin") {
    const forms = new Set([path, `/host_mnt${path}`]);
    // /var, /tmp, and /etc are symlinks into /private on macOS.
    if (path.startsWith("/private/")) forms.add(path.slice("/private".length));
    else if (/^\/(?:var|tmp|etc)(?:\/|$)/.test(path)) forms.add(`/private${path}`);
    for (const form of [...forms]) forms.add(`/host_mnt${form}`);
    return [...forms];
  }
  return [path];
}

/** `true` when the daemon-reported `source` names host path `expected`. */
export function sameHostPath(platform: NodeJS.Platform, source: string, expected: string): boolean {
  if (platform === "win32") return hostPathForms(platform, expected).some((f) => f.toLowerCase() === source.toLowerCase());
  return hostPathForms(platform, expected).includes(source);
}

/**
 * Maps a daemon-reported bind source in Docker Desktop's VM form back to the
 * host path it shares, so the hard rules judge the real host path. Other
 * sources (VM-internal paths such as `/var/run/docker.sock`) stay as they are.
 */
export function daemonSourceToHost(platform: NodeJS.Platform, source: string): string {
  if (platform === "win32") {
    const vm = /^(?:\/run\/desktop\/mnt\/host|\/host_mnt)\/([A-Za-z])(?:\/(.*))?$/.exec(source);
    if (vm) return `${vm[1].toUpperCase()}:\\${(vm[2] ?? "").replace(/\//g, "\\")}`;
    const slashed = /^([A-Za-z]):\/(.*)$/.exec(source);
    if (slashed) return `${slashed[1].toUpperCase()}:\\${slashed[2].replace(/\//g, "\\")}`;
    return source;
  }
  if (platform === "darwin" && source.startsWith("/host_mnt/")) return source.slice("/host_mnt".length);
  return source;
}

/** `true` for a host path in Windows form (`C:\…`, `C:/…`, or a UNC path). */
export function isWindowsHostPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

export interface DesktopEnv {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Host paths a Docker Desktop bind source may neither equal nor contain, in
 * addition to the Linux list: Docker Desktop's sockets and VM data, the
 * Docker CLI's config (it holds the socket and credentials), and on Windows
 * the system directory.
 */
export function desktopForbiddenPaths(platform: NodeJS.Platform, options: DesktopEnv = {}): string[] {
  const env = options.env ?? process.env;
  if (platform === "darwin") {
    const home = options.home ?? homedir();
    return [
      posix.join(home, ".docker"),
      posix.join(home, "Library", "Containers", "com.docker.docker"),
      posix.join(home, "Library", "Group Containers", "group.com.docker"),
      "/private/var/run",
      "/var/run",
    ];
  }
  if (platform === "win32") {
    const profile = env.USERPROFILE ?? options.home ?? homedir();
    const local = env.LOCALAPPDATA ?? win32.join(profile, "AppData", "Local");
    const roaming = env.APPDATA ?? win32.join(profile, "AppData", "Roaming");
    const programData = env.ProgramData ?? env.PROGRAMDATA ?? "C:\\ProgramData";
    const system = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    return [
      win32.join(profile, ".docker"),
      win32.join(local, "Docker"),
      win32.join(roaming, "Docker"),
      win32.join(roaming, "Docker Desktop"),
      win32.join(programData, "Docker"),
      win32.join(programData, "DockerDesktop"),
      system,
    ];
  }
  return [];
}

/**
 * Why `root` (resolved) may not be a Desktop project root in mount mode, or
 * `undefined`: a drive root or UNC share root on Windows, the user's home
 * (profile) or an ancestor of it, or an ancestor of a Desktop forbidden path.
 */
export function desktopRootProblem(platform: NodeJS.Platform, root: string, options: DesktopEnv = {}): string | undefined {
  if (platform !== "darwin" && platform !== "win32") return undefined;
  if (platform === "win32") {
    if (!isWindowsHostPath(root)) return `project root ${root} is not a Windows path`;
    if (/^[A-Za-z]:[\\/]*$/.test(root)) return `project root ${root} is a drive root`;
    if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(root)) return `project root ${root} is a network share root`;
    const profile = options.env?.USERPROFILE ?? process.env.USERPROFILE ?? options.home ?? homedir();
    if (profile && isSameOrAncestorOn(platform, root, profile)) return `project root ${root} is your user profile or contains it`;
  }
  for (const path of desktopForbiddenPaths(platform, options)) {
    if (isSameOrAncestorOn(platform, root, path)) return `project root ${root} contains ${path}`;
    if (isSameOrAncestorOn(platform, path, root)) return `project root ${root} is inside ${path}`;
  }
  return undefined;
}

/** Why a host bind source is forbidden on a Desktop host, or `undefined`. */
export function desktopBindProblem(platform: NodeJS.Platform, source: string, options: DesktopEnv = {}): string | undefined {
  const host = daemonSourceToHost(platform, source);
  for (const path of desktopForbiddenPaths(platform, options)) {
    if (isSameOrAncestorOn(platform, host, path) || isSameOrAncestorOn(platform, path, host)) return `bind source ${source} touches ${path}`;
  }
  return undefined;
}

/**
 * Fingerprint of a directory's top-level entry names: SHA-256 of the names
 * sorted bytewise, each followed by a newline. It equals the container-side
 * `LC_ALL=C ls -A1 /workspace | sha256sum` of the same directory.
 */
export async function listingFingerprint(dir: string): Promise<string> {
  const names = (await readdir(dir)).map((n) => Buffer.from(n, "utf8")).sort(Buffer.compare);
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** Shell test, run by the helper, that succeeds only when `/workspace` lists exactly the names behind `fingerprint`. */
export function listingIdentityCommand(fingerprint: string): string {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error(`invalid listing fingerprint ${JSON.stringify(fingerprint)}`);
  return `[ "$(LC_ALL=C ls -A1 /workspace | sha256sum)" = '${fingerprint}  -' ]`;
}
