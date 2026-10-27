/**
 * Reading, resolving, and writing the config files (spec §7, §5.2 step 1).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic.ts";
import {
  DEFAULTS,
  PROJECT_PERSONAL_FILE,
  PROJECT_SHARED_FILE,
  globalConfigPath,
  type GlobalConfig,
  type PersonalConfig,
  type ResolvedConfig,
  type SharedProjectConfig,
} from "./types.ts";
import { ConfigError, validateGlobalConfig, validatePersonalConfig, validateSharedConfig } from "./validate.ts";

/**
 * Reads and parses a JSON file.
 *
 * @returns `undefined` when the file does not exist.
 * @throws ConfigError naming the file when it is unreadable or not valid JSON.
 */
export async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(path, `cannot read: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(path, `malformed JSON: ${(error as Error).message}`);
  }
}

/** The three config files of one project, validated. */
export interface ConfigSources {
  shared: SharedProjectConfig;
  local: PersonalConfig;
  global: GlobalConfig;
  /** Paths actually used, for messages. */
  paths: { shared: string; local: string; global: string };
  warnings: string[];
}

/** Returns an empty global config (no backend chosen, nothing verified). */
export function emptyGlobalConfig(): GlobalConfig {
  return { version: 1, verified: {} };
}

/**
 * Loads `.pi/gui.json`, `.pi/gui.local.json` (both under `projectRoot`) and the
 * global config. Missing files count as empty.
 *
 * @throws ConfigError for malformed JSON or wrong value types, naming the file.
 */
export async function loadConfigSources(projectRoot: string, globalPath: string = globalConfigPath()): Promise<ConfigSources> {
  const paths = {
    shared: join(projectRoot, PROJECT_SHARED_FILE),
    local: join(projectRoot, PROJECT_PERSONAL_FILE),
    global: globalPath,
  };
  const [sharedRaw, localRaw, globalRaw] = await Promise.all([
    readJsonFile(paths.shared),
    readJsonFile(paths.local),
    readJsonFile(paths.global),
  ]);
  const shared = sharedRaw === undefined ? { config: {}, warnings: [] } : validateSharedConfig(sharedRaw, paths.shared);
  const local = localRaw === undefined ? { config: {}, warnings: [] } : validatePersonalConfig(localRaw, paths.local);
  const global = globalRaw === undefined ? { config: emptyGlobalConfig(), warnings: [] } : validateGlobalConfig(globalRaw, paths.global);
  return {
    shared: shared.config,
    local: local.config,
    global: global.config,
    paths,
    warnings: [...shared.warnings, ...local.warnings, ...global.warnings],
  };
}

/** Values that override config files: command flags (highest) and environment-derived values (below the global config). */
export interface ResolveLayers {
  flags?: PersonalConfig;
  environment?: PersonalConfig;
}

function pick<T>(...values: (T | undefined)[]): T | undefined {
  return values.find((v) => v !== undefined);
}

/**
 * Resolves each field independently: flags → `.pi/gui.local.json` → global →
 * environment → built-in default. Shared fields come only from `.pi/gui.json`
 * plus defaults. Setup and tools use the same function (spec §5.2 step 1).
 */
export function resolveConfig(sources: ConfigSources, layers: ResolveLayers = {}): ResolvedConfig {
  const order = [layers.flags, sources.local, sources.global, layers.environment];
  const field = <T>(get: (c: PersonalConfig) => T | undefined): T | undefined => pick(...order.map((c) => (c ? get(c) : undefined)));
  const host = field((c) => c.remote?.host);
  const resolved: ResolvedConfig = {
    backend: field((c) => c.backend),
    shared: {
      ...sources.shared,
      targets: sources.shared.targets ?? [...DEFAULTS.targets],
      workspaceMode: sources.shared.workspaceMode ?? DEFAULTS.workspaceMode,
      network: sources.shared.network ?? DEFAULTS.network,
    },
    limits: {
      maxConcurrentSessions: field((c) => c.limits?.maxConcurrentSessions) ?? DEFAULTS.limits.maxConcurrentSessions,
      idleTimeoutMinutes: field((c) => c.limits?.idleTimeoutMinutes) ?? DEFAULTS.limits.idleTimeoutMinutes,
    },
    usageCheck: {
      warnSessionCostUsd: field((c) => c.usageCheck?.warnSessionCostUsd) ?? DEFAULTS.usageCheck.warnSessionCostUsd,
      warnDailyCostUsd: field((c) => c.usageCheck?.warnDailyCostUsd) ?? DEFAULTS.usageCheck.warnDailyCostUsd,
    },
    keepSandbox: field((c) => c.keepSandbox) ?? DEFAULTS.keepSandbox,
    warnings: [...sources.warnings],
  };
  if (host !== undefined) resolved.remote = { host };
  return resolved;
}

/** Convenience: {@link loadConfigSources} + {@link resolveConfig}. */
export async function loadResolvedConfig(projectRoot: string, layers: ResolveLayers = {}, globalPath?: string): Promise<ResolvedConfig> {
  return resolveConfig(await loadConfigSources(projectRoot, globalPath), layers);
}

/**
 * Read-modify-write of the global config with an atomic replace. The mutator
 * receives a validated copy (or an empty config when the file is missing).
 * Concurrent writers in different Pi processes are last-writer-wins.
 *
 * @throws ConfigError when the existing file is malformed; it is never overwritten then.
 */
export async function updateGlobalConfig(
  mutate: (config: GlobalConfig) => GlobalConfig | void,
  globalPath: string = globalConfigPath(),
): Promise<GlobalConfig> {
  const raw = await readJsonFile(globalPath);
  const current = raw === undefined ? emptyGlobalConfig() : validateGlobalConfig(raw, globalPath).config;
  const next = mutate(current) ?? current;
  await writeJsonAtomic(globalPath, next);
  return next;
}

/**
 * Read-modify-write of `.pi/gui.local.json` with an atomic replace. Only
 * personal fields survive validation, so the file never gains shared fields.
 *
 * @throws ConfigError when the existing file is malformed; it is never overwritten then.
 */
export async function updateLocalConfig(
  projectRoot: string,
  mutate: (config: PersonalConfig) => PersonalConfig | void,
): Promise<PersonalConfig> {
  const path = join(projectRoot, PROJECT_PERSONAL_FILE);
  const raw = await readJsonFile(path);
  const current = raw === undefined ? {} : validatePersonalConfig(raw, path).config;
  const next = mutate(current) ?? current;
  await writeJsonAtomic(path, next, { mode: 0o600, dirMode: 0o755 });
  return next;
}
