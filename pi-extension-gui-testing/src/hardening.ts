/**
 * Container hard rules for `docker-linux` (spec §4.1) as data. `isolation.inspect`
 * and its unit tests both consume this module, so the rule list exists once.
 */

/** Host paths a bind mount source may neither equal nor be an ancestor of (after resolving symlinks). */
export const FORBIDDEN_MOUNT_PATHS = ["/tmp/.X11-unix", "/run/user", "/run/dbus", "/var/run"] as const;

/** Any bind source whose basename matches this is forbidden, wherever it lives. */
export const FORBIDDEN_SOCKET_BASENAME = /^docker\.sock$/;

/** Project roots refused outright in `mount` mode (in addition to ancestors of {@link FORBIDDEN_MOUNT_PATHS}). */
export const REFUSED_PROJECT_ROOTS = ["/"] as const;

/** `HostConfig` modes that must not be `host`. */
export const NON_HOST_MODES = ["NetworkMode", "IpcMode", "PidMode", "UsernsMode"] as const;

/** `Config.Env` variable names that must be absent. */
export const FORBIDDEN_ENV = ["WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"] as const;

/** `Config.Env` `DISPLAY`, when present, must match this (the helper's own Xvfb). */
export const DISPLAY_PATTERN = /^:[0-9]+$/;

/** Required hardening flags, as passed to `docker run`. */
export const REQUIRED_RUN_FLAGS = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges"] as const;

/** Shared memory size for Chromium/Electron apps. */
export const ELECTRON_SHM_SIZE = "512m";

/** Bound for the mount-mode socket scan of the whole project tree. */
export const SOCKET_SCAN_TIMEOUT_MS = 20_000;

/** Identifier of one hard rule, used in check results and tests. */
export type HardRuleId =
  | "privileged"
  | "host-mode"
  | "capabilities"
  | "no-new-privileges"
  | "devices"
  | "forbidden-mount"
  | "docker-socket"
  | "forbidden-env"
  | "display";

/** One violation found by `isolation.inspect`. */
export interface HardRuleViolation {
  rule: HardRuleId;
  /** What was observed, e.g. `HostConfig.IpcMode=host` or a mount source path. */
  observed: string;
}
