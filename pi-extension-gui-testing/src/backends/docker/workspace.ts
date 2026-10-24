/**
 * Mount-mode workspace guards (spec §4.1 "Mount-mode privacy"). The container
 * runs as the host UID, so a Unix socket inside a read-only mount would still
 * be connectable; the whole tree is scanned and the session refused on any
 * socket, timeout, or unreadable directory (fail closed).
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { FORBIDDEN_MOUNT_PATHS, REFUSED_PROJECT_ROOTS, SOCKET_SCAN_TIMEOUT_MS } from "../../hardening.ts";
import { forbiddenBindReason, hostPathProbe, type PathProbe } from "./inspect.ts";

/** A workspace that must not be mounted; the message is user- and model-facing. */
export class WorkspaceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRefusedError";
  }
}

const COPY_HINT = 'set "workspaceMode": "copy" in .pi/gui.json to run on a filtered copy instead';

function isSameOrAncestor(a: string, b: string): boolean {
  const pa = posix.normalize(a).replace(/\/+$/, "") || "/";
  const pb = posix.normalize(b).replace(/\/+$/, "") || "/";
  return pa === "/" || pb === pa || pb.startsWith(`${pa}/`);
}

/**
 * Why `root` may not be a project root in mount mode, or `undefined`. Refused:
 * `/`, the user's home directory or an ancestor of it, an ancestor of a
 * forbidden path, and any path a bind of which breaks a hard rule.
 *
 * @param root Absolute project root (symlinks are resolved here).
 */
export function projectRootProblem(root: string, probe: PathProbe = hostPathProbe, home: string = homedir()): string | undefined {
  const real = probe.realpath(root);
  for (const form of new Set([root, real])) {
    if ((REFUSED_PROJECT_ROOTS as readonly string[]).includes(form)) return `project root ${form} is the filesystem root`;
    if (home && isSameOrAncestor(form, probe.realpath(home))) return `project root ${form} is your home directory or contains it`;
    for (const path of FORBIDDEN_MOUNT_PATHS) {
      if (isSameOrAncestor(form, path) || isSameOrAncestor(form, probe.realpath(path))) return `project root ${form} contains ${path}`;
    }
  }
  const violation = forbiddenBindReason(real, probe);
  return violation ? `project root ${real} cannot be mounted (${violation.observed})` : undefined;
}

/** @throws WorkspaceRefusedError when {@link projectRootProblem} finds a problem. */
export function assertMountableRoot(root: string, probe?: PathProbe, home?: string): void {
  const problem = projectRootProblem(root, probe, home);
  if (problem) throw new WorkspaceRefusedError(`${problem}; open Pi in the project directory itself, or ${COPY_HINT}`);
}

export interface SocketScanResult {
  /** Socket paths relative to the root. */
  sockets: string[];
  directories: number;
  entries: number;
  durationMs: number;
}

export interface SocketScanOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Stop collecting after this many sockets (the scan still fails). */
  maxReported?: number;
  now?: () => number;
}

/**
 * Walks the whole tree under `root` without following symlinks, including
 * `.git`, `node_modules`, and virtualenvs, and collects Unix sockets.
 *
 * @throws WorkspaceRefusedError on timeout or an unreadable directory.
 */
export async function scanForSockets(root: string, options: SocketScanOptions = {}): Promise<SocketScanResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? SOCKET_SCAN_TIMEOUT_MS;
  const maxReported = options.maxReported ?? 20;
  const started = now();
  const result: SocketScanResult = { sockets: [], directories: 0, entries: 0, durationMs: 0 };
  const pending = [""];
  while (pending.length > 0) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("socket scan aborted");
    if (now() - started > timeoutMs) {
      throw new WorkspaceRefusedError(
        `the workspace socket scan did not finish within ${Math.round(timeoutMs / 1000)} s (${result.entries} entries checked); ` +
          `mount mode needs a complete scan, so ${COPY_HINT}`,
      );
    }
    const rel = pending.pop()!;
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
      throw new WorkspaceRefusedError(`cannot read ${rel || "."} in the workspace (${code}); mount mode needs a complete socket scan, so ${COPY_HINT}`);
    }
    result.directories++;
    for (const entry of entries) {
      result.entries++;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSocket()) {
        if (result.sockets.length < maxReported) result.sockets.push(path);
      } else if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }
  result.durationMs = now() - started;
  return result;
}

/**
 * Runs {@link scanForSockets} and refuses the workspace when it holds a socket.
 *
 * @throws WorkspaceRefusedError listing the sockets.
 */
export async function assertNoSockets(root: string, options?: SocketScanOptions): Promise<SocketScanResult> {
  const scan = await scanForSockets(root, options);
  if (scan.sockets.length > 0) {
    throw new WorkspaceRefusedError(
      `the workspace contains Unix socket(s) the container could connect to: ${scan.sockets.join(", ")}; ` +
        `remove them, or ${COPY_HINT}`,
    );
  }
  return scan;
}
