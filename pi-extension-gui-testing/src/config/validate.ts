/**
 * Validation of the config files (spec §7). Wrong types are errors naming the
 * file and field; misplaced or unknown fields are dropped with a warning so a
 * stale or shared file never blocks the user.
 */
import type {
  BackendId,
  GlobalConfig,
  NetworkMode,
  PersonalConfig,
  SharedProjectConfig,
  VerifiedBackend,
  WorkspaceMode,
} from "./types.ts";
import { PERSONAL_FIELDS, SHARED_FIELDS } from "./types.ts";

/** All backend ids of the contract, implemented or not. */
export const ALL_BACKENDS: readonly BackendId[] = [
  "docker-linux",
  "local-linux",
  "remote-linux",
  "remote-linux-docker",
  "cua",
  "docker-windows",
  "local-windows",
];
export const TARGET_OSES = ["linux", "windows", "macos"] as const;

/** A config file is malformed or holds a value of the wrong type. The message names the file. */
export class ConfigError extends Error {
  readonly file: string;
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "ConfigError";
    this.file = file;
  }
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Field-level checks bound to one file, so every error names it. */
class FieldChecker {
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  fail(field: string, expected: string): never {
    throw new ConfigError(this.file, `"${field}" must be ${expected}`);
  }

  object(value: unknown, field: string): Obj {
    if (!isObject(value)) this.fail(field, "an object");
    return value;
  }

  string(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) this.fail(field, "a non-empty string");
    return value;
  }

  stringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) this.fail(field, "an array of strings");
    return [...value];
  }

  stringRecord(value: unknown, field: string): Record<string, string> {
    const obj = this.object(value, field);
    for (const [key, v] of Object.entries(obj)) if (typeof v !== "string") this.fail(`${field}.${key}`, "a string");
    return { ...(obj as Record<string, string>) };
  }

  oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
    if (typeof value !== "string" || !allowed.includes(value as T)) this.fail(field, `one of ${allowed.join(", ")}`);
    return value as T;
  }

  positiveInt(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1) this.fail(field, "a positive integer");
    return value as number;
  }

  nonNegative(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) this.fail(field, "a non-negative number");
    return value;
  }

  boolean(value: unknown, field: string): boolean {
    if (typeof value !== "boolean") this.fail(field, "true or false");
    return value;
  }
}

/** Splits the top-level fields of `raw` into allowed ones and warnings for the rest. */
function partition(raw: Obj, allowed: readonly string[], misplaced: readonly string[], file: string, misplacedHint: string, extraAllowed: readonly string[] = []) {
  const warnings: string[] = [];
  const kept: Obj = {};
  for (const [key, value] of Object.entries(raw)) {
    if (allowed.includes(key) || extraAllowed.includes(key)) kept[key] = value;
    else if (misplaced.includes(key)) warnings.push(`${file}: "${key}" ${misplacedHint}; ignored`);
    else warnings.push(`${file}: unknown field "${key}" ignored`);
  }
  return { kept, warnings };
}

export interface Validated<T> {
  config: T;
  warnings: string[];
}

/** Validates `.pi/gui.json`. Personal fields there are ignored with a warning (spec §7). */
export function validateSharedConfig(raw: unknown, file: string): Validated<SharedProjectConfig> {
  const c: FieldChecker = new FieldChecker(file);
  const { kept, warnings } = partition(c.object(raw, "(root)"), SHARED_FIELDS, PERSONAL_FIELDS, file, "is a personal setting and belongs in .pi/gui.local.json or the global config");
  const config: SharedProjectConfig = {};
  if (kept.targets !== undefined) {
    const targets: unknown = kept.targets;
    if (!Array.isArray(targets) || targets.length === 0) c.fail("targets", "a non-empty array");
    config.targets = targets.map((t: unknown, i: number) => c.oneOf(t, `targets[${i}]`, TARGET_OSES));
  }
  if (kept.setup !== undefined) config.setup = c.stringArray(kept.setup, "setup");
  if (kept.launch !== undefined) {
    const launch = c.object(kept.launch, "launch");
    config.launch = { cmd: c.string(launch.cmd, "launch.cmd") };
    if (launch.args !== undefined) config.launch.args = c.stringArray(launch.args, "launch.args");
    if (launch.env !== undefined) config.launch.env = c.stringRecord(launch.env, "launch.env");
  }
  if (kept.workspaceMode !== undefined) config.workspaceMode = c.oneOf<WorkspaceMode>(kept.workspaceMode, "workspaceMode", ["mount", "copy"]);
  if (kept.deps !== undefined) {
    const deps = c.object(kept.deps, "deps");
    config.deps = {};
    if (deps.keyFiles !== undefined) config.deps.keyFiles = c.stringArray(deps.keyFiles, "deps.keyFiles");
    if (deps.env !== undefined) config.deps.env = c.stringRecord(deps.env, "deps.env");
  }
  if (kept.sync !== undefined) {
    const sync = c.object(kept.sync, "sync");
    config.sync = {};
    if (sync.allow !== undefined) config.sync.allow = c.stringArray(sync.allow, "sync.allow");
    if (sync.deny !== undefined) config.sync.deny = c.stringArray(sync.deny, "sync.deny");
  }
  if (kept.network !== undefined) config.network = c.oneOf<NetworkMode>(kept.network, "network", ["default", "none"]);
  return { config, warnings };
}

function personalFields(kept: Obj, c: FieldChecker): PersonalConfig {
  const config: PersonalConfig = {};
  if (kept.backend !== undefined) config.backend = c.oneOf(kept.backend, "backend", ALL_BACKENDS);
  if (kept.remote !== undefined) {
    const remote = c.object(kept.remote, "remote");
    config.remote = {};
    if (remote.host !== undefined) config.remote.host = c.string(remote.host, "remote.host");
    if (remote.purgeTooling !== undefined) config.remote.purgeTooling = c.boolean(remote.purgeTooling, "remote.purgeTooling");
  }
  if (kept.keepSandbox !== undefined) config.keepSandbox = c.boolean(kept.keepSandbox, "keepSandbox");
  if (kept.limits !== undefined) {
    const limits = c.object(kept.limits, "limits");
    config.limits = {};
    if (limits.maxConcurrentSessions !== undefined) {
      config.limits.maxConcurrentSessions = c.positiveInt(limits.maxConcurrentSessions, "limits.maxConcurrentSessions");
    }
    if (limits.idleTimeoutMinutes !== undefined) {
      config.limits.idleTimeoutMinutes = c.positiveInt(limits.idleTimeoutMinutes, "limits.idleTimeoutMinutes");
    }
  }
  if (kept.usageCheck !== undefined) {
    const usage = c.object(kept.usageCheck, "usageCheck");
    config.usageCheck = {};
    if (usage.warnSessionCostUsd !== undefined) {
      config.usageCheck.warnSessionCostUsd = c.nonNegative(usage.warnSessionCostUsd, "usageCheck.warnSessionCostUsd");
    }
    if (usage.warnDailyCostUsd !== undefined) {
      config.usageCheck.warnDailyCostUsd = c.nonNegative(usage.warnDailyCostUsd, "usageCheck.warnDailyCostUsd");
    }
  }
  return config;
}

/** Validates `.pi/gui.local.json`. Shared fields there are ignored with a warning. */
export function validatePersonalConfig(raw: unknown, file: string): Validated<PersonalConfig> {
  const c: FieldChecker = new FieldChecker(file);
  const { kept, warnings } = partition(c.object(raw, "(root)"), PERSONAL_FIELDS, SHARED_FIELDS, file, "is a shared project setting and belongs in .pi/gui.json");
  return { config: personalFields(kept, c), warnings };
}

function validateVerified(raw: unknown, field: string, c: FieldChecker): VerifiedBackend {
  const v = c.object(raw, field);
  const record: VerifiedBackend = {
    verifiedAt: c.string(v.verifiedAt, `${field}.verifiedAt`),
    toolVersions: c.stringRecord(v.toolVersions ?? {}, `${field}.toolVersions`),
    checksPassed: c.stringArray(v.checksPassed ?? [], `${field}.checksPassed`),
  };
  if (v.inputs !== undefined) record.inputs = c.stringRecord(v.inputs, `${field}.inputs`);
  return record;
}

/** Validates the global config. A missing `verified` map is treated as empty. */
export function validateGlobalConfig(raw: unknown, file: string): Validated<GlobalConfig> {
  const c: FieldChecker = new FieldChecker(file);
  const root = c.object(raw, "(root)");
  if (root.version !== undefined && root.version !== 1) {
    throw new ConfigError(file, `unsupported config version ${JSON.stringify(root.version)}; expected 1`);
  }
  const { kept, warnings } = partition(root, PERSONAL_FIELDS, SHARED_FIELDS, file, "is a shared project setting and belongs in .pi/gui.json", ["version", "verified"]);
  const verified: GlobalConfig["verified"] = {};
  if (kept.verified !== undefined) {
    for (const [id, record] of Object.entries(c.object(kept.verified, "verified"))) {
      if (!ALL_BACKENDS.includes(id as BackendId)) {
        warnings.push(`${file}: verified state for unknown backend "${id}" ignored`);
        continue;
      }
      verified[id as BackendId] = validateVerified(record, `verified.${id}`, c);
    }
  }
  return { config: { ...personalFields(kept, c), version: 1, verified }, warnings };
}
