/**
 * `isolation.inspect` (spec §4.1 "Hard rules"): validates a container's
 * `docker inspect` output against the rule list in `src/hardening.ts` and
 * reports every violation, not only the first.
 */
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import {
  DISPLAY_PATTERN,
  FORBIDDEN_ENV,
  FORBIDDEN_MOUNT_PATHS,
  FORBIDDEN_SOCKET_BASENAME,
  NON_HOST_MODES,
  type HardRuleViolation,
} from "../../hardening.ts";

/** The parts of `docker container inspect` this module reads. */
export interface ContainerInspect {
  Config?: { Env?: string[] | null } | null;
  HostConfig?: {
    Privileged?: boolean;
    NetworkMode?: string;
    IpcMode?: string;
    PidMode?: string;
    UsernsMode?: string;
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    Devices?: unknown[] | null;
    DeviceRequests?: unknown[] | null;
    DeviceCgroupRules?: string[] | null;
    Binds?: string[] | null;
    Mounts?: Array<{ Type?: string; Source?: string; Target?: string }> | null;
  } | null;
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string }> | null;
}

/**
 * Stricter than "equal or ancestor" (which would still allow `/run/user/1000`
 * or `/run/containerd`): no bind source may live under the X11 socket dir
 * (Y14) or anywhere under `/run`, except private sub-directories below a
 * user's runtime dir (`/run/user/<uid>/<dir>`, e.g. a `TMPDIR` there), whose
 * sockets the socket checks catch.
 */
const FORBIDDEN_SUBTREES = ["/tmp/.X11-unix", "/run", "/var/run"];
const ALLOWED_RUNTIME_SUBDIR = /^\/(?:var\/)?run\/user\/[^/]+\/[^/]+/;

export interface PathProbe {
  /** Resolves symlinks; returns the input unchanged when the path does not exist. */
  realpath(path: string): string;
  /** `true` when the path is a Unix socket. */
  isSocket(path: string): boolean;
}

/**
 * Resolves symlinks like `realpath`, but also through links whose target does
 * not exist (yet), so a link to a missing `/tmp/.X11-unix` is still judged by
 * its target. Missing trailing components are kept as they are.
 */
export function resolveHostPath(path: string, depth = 0): string {
  try {
    return realpathSync(path);
  } catch {
    if (depth > 40) return path;
    try {
      if (lstatSync(path).isSymbolicLink()) return resolveHostPath(resolve(dirname(path), readlinkSync(path)), depth + 1);
    } catch {
      // Missing: resolve the parent and keep the name.
    }
    const parent = dirname(path);
    return parent === path ? path : join(resolveHostPath(parent, depth + 1), basename(path));
  }
}

export const hostPathProbe: PathProbe = {
  realpath: (path) => resolveHostPath(path),
  isSocket(path) {
    try {
      return statSync(path).isSocket();
    } catch {
      return false;
    }
  },
};

/** `true` when `a` equals `b` or is an ancestor of it. */
function isSameOrAncestor(a: string, b: string): boolean {
  const pa = posix.normalize(a).replace(/\/+$/, "") || "/";
  const pb = posix.normalize(b).replace(/\/+$/, "") || "/";
  if (pa === "/") return true;
  return pb === pa || pb.startsWith(`${pa}/`);
}

/** Bind sources from `HostConfig.Binds` (`src:dst[:opts]`), `HostConfig.Mounts`, and `Mounts`. */
export function bindSources(inspect: ContainerInspect): string[] {
  const sources = new Set<string>();
  for (const bind of inspect.HostConfig?.Binds ?? []) {
    const source = bind.split(":")[0];
    // Named volumes have no leading slash; they are not host paths.
    if (source.startsWith("/")) sources.add(source);
  }
  for (const mount of [...(inspect.HostConfig?.Mounts ?? []), ...(inspect.Mounts ?? [])]) {
    if (mount.Type === "bind" && mount.Source) sources.add(mount.Source);
  }
  return [...sources];
}

/**
 * Why a host path may not be bind-mounted, or `undefined` when it may. Checks
 * the path as given and after resolving symlinks, against the forbidden paths
 * as given and resolved (e.g. `/var/run` → `/run`).
 */
export function forbiddenBindReason(source: string, probe: PathProbe = hostPathProbe): HardRuleViolation | undefined {
  const forms = [...new Set([source, probe.realpath(source)])];
  for (const form of forms) {
    if (FORBIDDEN_SOCKET_BASENAME.test(basename(form))) return { rule: "docker-socket", observed: `bind source ${source}` };
  }
  const forbidden = [...new Set(FORBIDDEN_MOUNT_PATHS.flatMap((p) => [p, probe.realpath(p)]))];
  for (const form of forms) {
    for (const path of forbidden) {
      if (isSameOrAncestor(form, path)) return { rule: "forbidden-mount", observed: `bind source ${source} contains ${path}` };
    }
    for (const subtree of FORBIDDEN_SUBTREES) {
      if (isSameOrAncestor(subtree, form) && !ALLOWED_RUNTIME_SUBDIR.test(posix.normalize(form))) {
        return { rule: "forbidden-mount", observed: `bind source ${source} is under ${subtree}` };
      }
    }
  }
  if (forms.some((form) => probe.isSocket(form))) return { rule: "forbidden-mount", observed: `bind source ${source} is a Unix socket` };
  return undefined;
}

function hasNoNewPrivileges(securityOpt: readonly string[]): boolean {
  return securityOpt.some((opt) => /^no-new-privileges(?:[:=]true)?$/.test(opt));
}

/** Every hard-rule violation of `inspect`; empty when the container is compliant. */
export function hardRuleViolations(inspect: ContainerInspect, probe: PathProbe = hostPathProbe): HardRuleViolation[] {
  const violations: HardRuleViolation[] = [];
  const host = inspect.HostConfig ?? {};
  if (host.Privileged !== false) violations.push({ rule: "privileged", observed: `HostConfig.Privileged=${String(host.Privileged)}` });
  for (const mode of NON_HOST_MODES) {
    const value = host[mode];
    if (value === "host") violations.push({ rule: "host-mode", observed: `HostConfig.${mode}=host` });
  }
  const capAdd = host.CapAdd ?? [];
  if (capAdd.length > 0) violations.push({ rule: "capabilities", observed: `HostConfig.CapAdd=${capAdd.join(",")}` });
  const capDrop = (host.CapDrop ?? []).map((c) => c.toUpperCase());
  if (!capDrop.includes("ALL")) violations.push({ rule: "capabilities", observed: `HostConfig.CapDrop=${capDrop.join(",") || "(empty)"}` });
  if (!hasNoNewPrivileges(host.SecurityOpt ?? [])) {
    violations.push({ rule: "no-new-privileges", observed: `HostConfig.SecurityOpt=${(host.SecurityOpt ?? []).join(",") || "(empty)"}` });
  }
  const devices = [
    ...(host.Devices ?? []).map(() => "Devices"),
    ...(host.DeviceRequests ?? []).map(() => "DeviceRequests"),
    ...(host.DeviceCgroupRules ?? []).map(() => "DeviceCgroupRules"),
  ];
  if (devices.length > 0) violations.push({ rule: "devices", observed: `HostConfig has ${devices.length} device entr${devices.length === 1 ? "y" : "ies"} (${[...new Set(devices)].join(", ")})` });
  for (const source of bindSources(inspect)) {
    const violation = forbiddenBindReason(source, probe);
    if (violation) violations.push(violation);
  }
  for (const entry of inspect.Config?.Env ?? []) {
    const eq = entry.indexOf("=");
    const name = eq === -1 ? entry : entry.slice(0, eq);
    const value = eq === -1 ? "" : entry.slice(eq + 1);
    if ((FORBIDDEN_ENV as readonly string[]).includes(name)) violations.push({ rule: "forbidden-env", observed: `Config.Env has ${name}` });
    if (name === "DISPLAY" && !DISPLAY_PATTERN.test(value)) violations.push({ rule: "display", observed: `Config.Env DISPLAY=${value}` });
  }
  return violations;
}

/**
 * Why the container's `/workspace` is not exactly a bind of `expected` (the
 * resolved directory that was checked), or `undefined` when it is. Docker
 * must report one mount at the workspace path, a bind, with that source.
 */
export function workspaceMountProblem(inspect: ContainerInspect, expected: string, destination = "/workspace"): string | undefined {
  const mounts = (inspect.Mounts ?? []).filter((m) => m.Destination === destination);
  if (mounts.length !== 1) return `${mounts.length} mounts at ${destination}, expected 1`;
  const [mount] = mounts;
  if (mount.Type !== "bind") return `${destination} is a ${mount.Type ?? "unknown"} mount, expected a bind`;
  if (mount.Source !== expected) return `${destination} is bound from ${mount.Source ?? "(unknown)"}, expected ${expected}`;
  for (const bind of inspect.HostConfig?.Binds ?? []) {
    const [source, target] = bind.split(":");
    if (target === destination && source !== expected) return `HostConfig.Binds binds ${source} at ${destination}, expected ${expected}`;
  }
  return undefined;
}

/** One-line summary of violations for check results and errors. */
export function formatViolations(violations: readonly HardRuleViolation[]): string {
  return violations.map((v) => `${v.rule}: ${v.observed}`).join("; ");
}
