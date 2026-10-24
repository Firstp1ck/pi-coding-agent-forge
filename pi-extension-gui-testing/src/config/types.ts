/**
 * Configuration contract (spec §7, §3a D3). Resolution is per field:
 * flags → `.pi/gui.local.json` → global config → environment → built-in default.
 * `.pi/gui.json` holds only {@link SHARED_FIELDS}; personal fields found there
 * are ignored with a warning.
 */
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type BackendId =
  | "docker-linux"
  | "local-linux"
  | "remote-linux"
  | "remote-linux-docker"
  | "cua"
  | "docker-windows"
  | "local-windows";

/**
 * Ids of the backends implemented in this build, in picker order. Each needs
 * an entry in `src/backends/registry.ts`; the type check fails when the two differ.
 */
export const IMPLEMENTED_BACKEND_IDS = ["docker-linux", "local-linux", "remote-linux", "remote-linux-docker", "cua", "local-windows", "docker-windows"] as const satisfies readonly BackendId[];

export type ImplementedBackendId = (typeof IMPLEMENTED_BACKEND_IDS)[number];

/** Backends implemented in the current build. Others are rejected with "not available yet". */
export const IMPLEMENTED_BACKENDS: readonly BackendId[] = IMPLEMENTED_BACKEND_IDS;

export type WorkspaceMode = "mount" | "copy";
export type NetworkMode = "default" | "none";
export type TargetOs = "linux" | "windows" | "macos";

/** `.pi/gui.json`, committed. */
export interface SharedProjectConfig {
  targets?: TargetOs[];
  /** Shell commands run inside the session (container/remote) before launch. Never on the client. */
  setup?: string[];
  launch?: { cmd: string; args?: string[]; env?: Record<string, string> };
  workspaceMode?: WorkspaceMode;
  deps?: { keyFiles?: string[]; env?: Record<string, string> };
  sync?: { allow?: string[]; deny?: string[] };
  network?: NetworkMode;
}

export const SHARED_FIELDS = ["targets", "setup", "launch", "workspaceMode", "deps", "sync", "network"] as const;

export interface Limits {
  maxConcurrentSessions?: number;
  idleTimeoutMinutes?: number;
}

export interface UsageCheckConfig {
  warnSessionCostUsd?: number;
  warnDailyCostUsd?: number;
}

/** Fields allowed in `.pi/gui.local.json` and the global config. */
/** `remote` in `.pi/gui.local.json` and the global config (remote backends, spec §4.2a). */
export interface RemoteConfig {
  /** SSH alias or `user@host` (never resolved values). */
  host?: string;
  /** `remote-linux-docker`: remove the base image from the host after every session (spec §7a.1, Q7). Default `false`. */
  purgeTooling?: boolean;
}

/** `depsCache` in `.pi/gui.local.json` and the global config: the client-side dependency cache (spec §4.8). */
export interface DepsCacheConfig {
  /** Default `true`. `false`: `setup` runs every session and nothing is stored. */
  enabled?: boolean;
  /** Size limit of the whole cache in GB (1024³ bytes), shared by all projects. Default 5; least recently used entries go first. */
  maxSizeGB?: number;
}

export interface PersonalConfig {
  backend?: BackendId;
  remote?: RemoteConfig;
  depsCache?: DepsCacheConfig;
  keepSandbox?: boolean;
  limits?: Limits;
  usageCheck?: UsageCheckConfig;
}

export const PERSONAL_FIELDS = ["backend", "remote", "depsCache", "keepSandbox", "limits", "usageCheck"] as const;

/** Verified state of one backend, persisted after a successful setup or doctor run. */
export interface VerifiedBackend {
  /** ISO 8601. */
  verifiedAt: string;
  /** e.g. `{ "docker.server": "29.9.1", "image.base": "0.1.0" }`; a change makes the backend stale. */
  toolVersions: Record<string, string>;
  checksPassed: string[];
  /** Inputs resolved at setup (never secrets). */
  inputs?: Record<string, string>;
}

/** `<agent dir>/gui/config.json`. */
export interface GlobalConfig extends PersonalConfig {
  version: 1;
  verified: Partial<Record<BackendId, VerifiedBackend>>;
}

/** Built-in defaults (spec §7, §8 Limits, §3a D5). */
export const DEFAULTS = {
  workspaceMode: "mount" as WorkspaceMode,
  network: "default" as NetworkMode,
  targets: ["linux"] as TargetOs[],
  keepSandbox: false,
  limits: { maxConcurrentSessions: 2, idleTimeoutMinutes: 15 },
  usageCheck: { warnSessionCostUsd: 1, warnDailyCostUsd: 5 },
  depsCache: { enabled: true, maxSizeGB: 5 },
} as const;

export const PROJECT_SHARED_FILE = ".pi/gui.json";
export const PROJECT_PERSONAL_FILE = ".pi/gui.local.json";

/** Absolute path of the global config; honours `PI_CODING_AGENT_DIR` through Pi's `getAgentDir()`. */
export function globalConfigPath(): string {
  return join(getAgentDir(), "gui", "config.json");
}

/** Fully resolved configuration for one command or tool call. */
export interface ResolvedConfig {
  backend?: BackendId;
  shared: Required<Pick<SharedProjectConfig, "targets" | "workspaceMode" | "network">> &
    Omit<SharedProjectConfig, "targets" | "workspaceMode" | "network">;
  limits: Required<Limits>;
  usageCheck: Required<UsageCheckConfig>;
  keepSandbox: boolean;
  remote?: RemoteConfig;
  /** Resolved `depsCache` (always set by `resolveConfig`; optional for hand-built configs, which get the defaults). */
  depsCache?: { enabled: boolean; maxBytes: number };
  /** Human-readable warnings, e.g. personal fields ignored in `.pi/gui.json`. */
  warnings: string[];
}
