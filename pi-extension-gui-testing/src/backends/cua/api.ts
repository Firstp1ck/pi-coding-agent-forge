/**
 * The one seam between the `cua` backend and Cua (spec §4.3). Everything the
 * backend needs from Cua goes through {@link CuaApi}; the production adapter
 * drives the `cua` CLI (`./cli-api.ts`) and tests use a fake. Swapping Cua's
 * surface again changes only the adapter.
 *
 * Cua Cloud (`api.cua.ai/v1/vms`, `CUA_API_KEY`) ended on 18 October 2026.
 * Sandboxes now run in the user's own cloud account (`--on aws|gcp|hetzner|modal`),
 * created and deleted by the `cua` CLI, which holds the user's cua.ai sign-in
 * and cloud credentials. This package never sees either.
 *
 * Everything an adapter returns comes from another program and the network:
 * adapters validate shapes and bound sizes before returning, and every error
 * message is redacted (`./redact.ts`).
 */
import type { RunResult } from "../../runner/types.ts";
import type { HelperProcess } from "../../transport/process.ts";

/** Clouds the backend creates sandboxes in. `local` and `direct:` are not cloud sandboxes and are refused. */
export const CLOUD_LOCATIONS = ["aws", "gcp", "hetzner", "modal"] as const;
export type CloudLocation = (typeof CLOUD_LOCATIONS)[number];

export function isCloudLocation(value: unknown): value is CloudLocation {
  return typeof value === "string" && (CLOUD_LOCATIONS as readonly string[]).includes(value);
}

/** One sandbox as Cua reports it (portable fields only). */
export interface SandboxInfo {
  /** Sandbox name, e.g. `pi-gui-testing-gui-1a2b3c4d`. */
  name: string;
  /** Where it runs (`aws`, `gcp`, …). */
  location: string;
  /** Portable status: `provisioning`, `starting`, `ready`, `stopped`, `expired`, or another word. */
  status: string;
  /** RFC 3339 expiry when the cloud's TTL applies. */
  expiresAt?: string;
  image?: string;
}

/** What a connected cloud can run, at what hourly price. */
export interface CloudKind {
  image: string;
  kind: string;
  supported: boolean;
  reason?: string;
  machineType?: string;
  usdPerHour?: number;
}

/** One cloud in `cua cloud status`. */
export interface CloudProvider {
  name: string;
  connected: boolean;
  /** The cloud `cua cloud connect --default` chose. */
  isDefault: boolean;
  credentialsFound: boolean;
  region?: string;
  /** Hours each sandbox lives before it deletes itself; 0 = never. */
  ttlHours?: number;
  kinds: CloudKind[];
}

/** Result of a read-only cloud check (`cua cloud test`, which creates nothing). */
export interface CloudTest {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface CreateSandboxSpec {
  name: string;
  location: CloudLocation;
  /** Image alias (`linux`) or registry reference. */
  image: string;
}

export interface SpawnHelperOptions {
  /**
   * How `env` reaches the guest process: `posix` (default) wraps `argv` in a
   * `sh` preamble that reads the values from the first stdin lines;
   * `powershell` appends `-StdinEnv NAME,…` to `argv` (the Windows helper
   * reads the values itself, in that order, from the first stdin lines).
   */
  stdinEnv?: "posix" | "powershell";
}

export interface ExecOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Guest working directory. */
  cwd?: string;
}

/** Failure classes the backend reacts to. Messages are redacted and bounded. */
export type CuaErrorCode =
  /** The `cua` executable is missing. */
  | "NO_CLI"
  /** Sandbox or cloud not found. */
  | "NOT_FOUND"
  /** Not signed in, or the cloud refused the credentials. */
  | "AUTH"
  /** Not supported or not configured (e.g. no cloud connected). */
  | "UNSUPPORTED"
  /** Network, relay, or cua-spacesd unreachable. */
  | "TRANSPORT"
  | "TIMEOUT"
  | "CANCELLED"
  /** Output that does not have the documented shape. */
  | "BAD_RESPONSE"
  | "FAILED";

export class CuaApiError extends Error {
  readonly code: CuaErrorCode;
  constructor(code: CuaErrorCode, message: string) {
    super(message);
    this.name = "CuaApiError";
    this.code = code;
  }
}

export interface CuaApi {
  /** `cua` CLI version; throws `NO_CLI` when it is missing. */
  version(signal?: AbortSignal): Promise<string>;
  /** Whether a cua.ai session is stored. No network. */
  signedIn(signal?: AbortSignal): Promise<{ signedIn: boolean; detail: string }>;
  /** Read-only authenticated call; resolves the account name. */
  whoami(signal?: AbortSignal): Promise<{ account: string }>;
  /** Read-only: the clouds, their connection, TTL, and hourly prices. */
  cloudStatus(signal?: AbortSignal): Promise<CloudProvider[]>;
  /** Read-only: credentials, permissions (dry run), quota, region. Creates nothing. */
  cloudTest(location: CloudLocation, signal?: AbortSignal): Promise<CloudTest>;
  /** Creates a sandbox and waits until it is ready. Billing starts here. */
  createSandbox(spec: CreateSandboxSpec, signal?: AbortSignal): Promise<SandboxInfo>;
  /** One sandbox, or `undefined` when it does not exist. */
  getSandbox(ref: string, signal?: AbortSignal): Promise<SandboxInfo | undefined>;
  /** Every sandbox this machine's `cua` knows, of every location. */
  listSandboxes(signal?: AbortSignal): Promise<SandboxInfo[]>;
  /** Deletes a sandbox; a sandbox that is already gone resolves `{ missing: true }`. */
  deleteSandbox(ref: string, signal?: AbortSignal): Promise<{ missing: boolean }>;
  /** Runs `argv` (no shell) in the sandbox. Resolves for every exit status. */
  exec(ref: string, argv: readonly string[], options: ExecOptions): Promise<RunResult>;
  /** Uploads one local file to `guestPath`. */
  upload(ref: string, localPath: string, guestPath: string, signal?: AbortSignal): Promise<{ size: number }>;
  /**
   * Starts `argv` in the sandbox with a live stdio stream (the helper
   * channel). `env` reaches the guest process only, never any argv: through a
   * POSIX `sh` preamble (Linux guests, the default) or the Windows helper's
   * `-StdinEnv` option, appended to `argv` (Windows guests).
   */
  spawnHelper(ref: string, argv: readonly string[], env: Readonly<Record<string, string>>, options?: SpawnHelperOptions): HelperProcess;
  /** Argv that deletes the sandbox synchronously, for the process `exit` handler (no shell, no secret). */
  forceDeleteArgv(ref: string): string[];
}

/** `<location>:<name>`, the ref every `cua sb` command accepts. */
export function sandboxRef(location: string, name: string): string {
  return `${location}:${name}`;
}
