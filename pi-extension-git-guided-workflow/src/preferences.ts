import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { GuidedGitError } from "./core.ts";
import type { GenerationLanguage, ScopePolicy } from "./native-generation.ts";

export const GUIDED_GIT_PREFERENCES_VERSION = 1;
export const GUIDED_GIT_PREFERENCES_FILE = "git-guided-workflow.json";
export const GUIDED_GIT_THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
export const GUIDED_GIT_MESSAGE_VARIANTS = Object.freeze(["short", "long"] as const);
export const GUIDED_GIT_STAGING_DEFAULTS = Object.freeze(["preserve", "all"] as const);
export const GUIDED_GIT_ENTRY_STAGES = Object.freeze(["stage", "message", "commit", "push"] as const);
export const GUIDED_GIT_VERIFICATION_POLICIES = Object.freeze(["ask", "none"] as const);

export type GuidedGitThinkingLevel = (typeof GUIDED_GIT_THINKING_LEVELS)[number];
export type GuidedGitMessageVariant = (typeof GUIDED_GIT_MESSAGE_VARIANTS)[number];
export type GuidedGitStagingDefault = (typeof GUIDED_GIT_STAGING_DEFAULTS)[number];
export type GuidedGitEntryStage = (typeof GUIDED_GIT_ENTRY_STAGES)[number];
export type GuidedGitVerificationPolicy = (typeof GUIDED_GIT_VERIFICATION_POLICIES)[number];

export interface GuidedGitGenerationProfile {
  provider: string;
  modelId: string;
  thinkingLevel: GuidedGitThinkingLevel;
}

export interface GuidedGitPreferences {
  generation: {
    primary: GuidedGitGenerationProfile | null;
    fallback: GuidedGitGenerationProfile | null;
  };
  commit: {
    language: GenerationLanguage;
    scope: ScopePolicy;
    defaultVariant: GuidedGitMessageVariant;
  };
  staging: GuidedGitStagingDefault;
  defaultEntry: GuidedGitEntryStage;
  verification: GuidedGitVerificationPolicy;
}

export const DEFAULT_GUIDED_GIT_PREFERENCES: Readonly<GuidedGitPreferences> = Object.freeze({
  generation: Object.freeze({ primary: null, fallback: null }),
  commit: Object.freeze({ language: "en", scope: "auto", defaultVariant: "short" }),
  staging: "preserve",
  defaultEntry: "stage",
  verification: "ask",
});

const SETTINGS_MAX_BYTES = 16 * 1024;
const PROFILE_KEYS = Object.freeze(["modelId", "provider", "thinkingLevel"]);
const PREFERENCE_KEYS = Object.freeze(["commit", "defaultEntry", "generation", "staging", "verification"]);
const GENERATION_KEYS = Object.freeze(["fallback", "primary"]);
const COMMIT_KEYS = Object.freeze(["defaultVariant", "language", "scope"]);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GuidedGitError("INVALID_PREFERENCES", message);
  return value as Record<string, unknown>;
}

function boundedIdentity(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maxLength
    || /\x00|[\u0001-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new GuidedGitError("INVALID_PREFERENCES", `${label} is invalid`);
  }
  return value;
}

function validateProfile(value: unknown, label: string): GuidedGitGenerationProfile | null {
  if (value === null) return null;
  const profile = record(value, `${label} generation profile must be an object or null`);
  if (!exactKeys(profile, PROFILE_KEYS)) throw new GuidedGitError("INVALID_PREFERENCES", `${label} generation profile has missing or unknown fields`);
  const provider = boundedIdentity(profile.provider, `${label} provider`, 160);
  const modelId = boundedIdentity(profile.modelId, `${label} model ID`, 512);
  if (typeof profile.thinkingLevel !== "string" || !GUIDED_GIT_THINKING_LEVELS.includes(profile.thinkingLevel as GuidedGitThinkingLevel)) {
    throw new GuidedGitError("INVALID_PREFERENCES", `${label} reasoning effort is invalid`);
  }
  return { provider, modelId, thinkingLevel: profile.thinkingLevel as GuidedGitThinkingLevel };
}

/** Strictly validate the complete persisted settings object; unknown fields are refused. */
export function validateGuidedGitPreferences(value: unknown): GuidedGitPreferences {
  const preferences = record(value, "Guided Git preferences must be a complete object");
  if (!exactKeys(preferences, PREFERENCE_KEYS)) throw new GuidedGitError("INVALID_PREFERENCES", "Guided Git preferences have missing or unknown fields");
  const generation = record(preferences.generation, "Generation preferences must be an object");
  const commit = record(preferences.commit, "Commit preferences must be an object");
  if (!exactKeys(generation, GENERATION_KEYS) || !exactKeys(commit, COMMIT_KEYS)) {
    throw new GuidedGitError("INVALID_PREFERENCES", "Guided Git preferences have missing or unknown nested fields");
  }
  const primary = validateProfile(generation.primary, "Primary");
  const fallback = validateProfile(generation.fallback, "Fallback");
  if (!primary && fallback) throw new GuidedGitError("INVALID_PREFERENCES", "A fallback profile requires a primary profile");
  if (primary && fallback && primary.provider === fallback.provider && primary.modelId === fallback.modelId
    && primary.thinkingLevel === fallback.thinkingLevel) {
    throw new GuidedGitError("INVALID_PREFERENCES", "The fallback profile must differ from the primary profile");
  }
  if (typeof commit.language !== "string" || !["en", "de"].includes(commit.language)
    || typeof commit.scope !== "string" || !["auto", "never", "required"].includes(commit.scope)
    || typeof commit.defaultVariant !== "string" || !GUIDED_GIT_MESSAGE_VARIANTS.includes(commit.defaultVariant as GuidedGitMessageVariant)
    || typeof preferences.staging !== "string" || !GUIDED_GIT_STAGING_DEFAULTS.includes(preferences.staging as GuidedGitStagingDefault)
    || typeof preferences.defaultEntry !== "string" || !GUIDED_GIT_ENTRY_STAGES.includes(preferences.defaultEntry as GuidedGitEntryStage)
    || typeof preferences.verification !== "string" || !GUIDED_GIT_VERIFICATION_POLICIES.includes(preferences.verification as GuidedGitVerificationPolicy)) {
    throw new GuidedGitError("INVALID_PREFERENCES", "Guided Git preferences contain an unsupported option");
  }
  return {
    generation: { primary, fallback },
    commit: {
      language: commit.language as GenerationLanguage,
      scope: commit.scope as ScopePolicy,
      defaultVariant: commit.defaultVariant as GuidedGitMessageVariant,
    },
    staging: preferences.staging as GuidedGitStagingDefault,
    defaultEntry: preferences.defaultEntry as GuidedGitEntryStage,
    verification: preferences.verification as GuidedGitVerificationPolicy,
  };
}

export interface GuidedGitPreferencesSnapshot {
  path: string;
  raw: string | null;
  preferences: GuidedGitPreferences;
  source: "defaults" | "saved";
}

export type PreferencesMutationQueue = <T>(key: string, work: () => Promise<T>) => Promise<T>;

async function safeDirectory(directory: string, create: boolean): Promise<boolean> {
  try {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GuidedGitError("UNSAFE_PREFERENCES_PATH", "The Pi agent directory must be a real directory");
    if (await realpath(directory) !== path.resolve(directory)) throw new GuidedGitError("UNSAFE_PREFERENCES_PATH", "The Pi agent directory must not traverse symbolic links");
    return true;
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readBoundedProfile(file: string): Promise<string | null> {
  if (!await safeDirectory(path.dirname(file), false)) return null;
  let handle;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new GuidedGitError("UNSAFE_PREFERENCES_PATH", "Guided Git preferences must be a regular non-symlink file");
    if (stat.size > SETTINGS_MAX_BYTES) throw new GuidedGitError("PREFERENCES_TOO_LARGE", `Guided Git preferences exceed ${SETTINGS_MAX_BYTES} bytes`);
    handle = await open(file, "r");
    const bytes = Buffer.alloc(SETTINGS_MAX_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > SETTINGS_MAX_BYTES) throw new GuidedGitError("PREFERENCES_TOO_LARGE", `Guided Git preferences exceed ${SETTINGS_MAX_BYTES} bytes`);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)); }
    catch { throw new GuidedGitError("INVALID_PREFERENCES", "Guided Git preferences are not valid UTF-8"); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseSavedPreferences(raw: string): GuidedGitPreferences {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new GuidedGitError("INVALID_PREFERENCES", "Guided Git preferences contain invalid JSON; repair or remove the file before continuing"); }
  const envelope = record(value, "Guided Git preferences file must contain an object");
  if (!exactKeys(envelope, ["preferences", "version"]) || envelope.version !== GUIDED_GIT_PREFERENCES_VERSION) {
    throw new GuidedGitError("INVALID_PREFERENCES", `Unsupported Guided Git preferences format; expected version ${GUIDED_GIT_PREFERENCES_VERSION}`);
  }
  return validateGuidedGitPreferences(envelope.preferences);
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try { handle = await open(directory, "r"); await handle.sync(); }
  catch { /* Directory fsync is unavailable on some supported filesystems. */ }
  finally { await handle?.close().catch(() => {}); }
}

/** Create the extension-owned global preference store rooted at Pi's agent directory. */
export function createGuidedGitPreferencesStore(
  agentDir: string,
  mutate: PreferencesMutationQueue = async (_key, work) => await work(),
) {
  const file = path.join(path.resolve(agentDir), GUIDED_GIT_PREFERENCES_FILE);
  const load = async (): Promise<GuidedGitPreferencesSnapshot> => {
    const raw = await readBoundedProfile(file);
    return {
      path: file,
      raw,
      preferences: raw === null ? validateGuidedGitPreferences(DEFAULT_GUIDED_GIT_PREFERENCES) : parseSavedPreferences(raw),
      source: raw === null ? "defaults" : "saved",
    };
  };
  return {
    path: file,
    load,
    async save(snapshot: GuidedGitPreferencesSnapshot, preferences: GuidedGitPreferences, signal?: AbortSignal): Promise<GuidedGitPreferencesSnapshot> {
      if (snapshot.path !== file) throw new GuidedGitError("PREFERENCES_CHANGED", "The preferences snapshot belongs to another settings file");
      const validated = validateGuidedGitPreferences(preferences);
      return await mutate(file, async () => {
        if (signal?.aborted) throw new GuidedGitError("PREFERENCES_SAVE_CANCELLED", "Saving Guided Git preferences was cancelled");
        if (await readBoundedProfile(file) !== snapshot.raw) throw new GuidedGitError("PREFERENCES_CHANGED", "Guided Git preferences changed while setup was open; reopen setup instead of overwriting them");
        await safeDirectory(path.dirname(file), true);
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
        let handle;
        try {
          handle = await open(temporary, "wx", 0o600);
          await handle.writeFile(`${JSON.stringify({ version: GUIDED_GIT_PREFERENCES_VERSION, preferences: validated }, null, 2)}\n`, "utf8");
          await handle.sync();
          await handle.close();
          handle = undefined;
          if (signal?.aborted) throw new GuidedGitError("PREFERENCES_SAVE_CANCELLED", "Saving Guided Git preferences was cancelled");
          const current = await readBoundedProfile(file);
          if (current !== snapshot.raw) throw new GuidedGitError("PREFERENCES_CHANGED", "Guided Git preferences changed before save; reopen setup instead of overwriting them");
          await rename(temporary, file);
          await syncDirectoryBestEffort(path.dirname(file));
        } finally {
          await handle?.close().catch(() => {});
          await rm(temporary, { force: true }).catch(() => {});
        }
        return await load();
      });
    },
  };
}

/** Return only reasoning levels supported by the selected Pi model. */
export function supportedGuidedGitThinkingLevels(model: { reasoning?: boolean; thinkingLevelMap?: Partial<Record<GuidedGitThinkingLevel, string | null>> }): GuidedGitThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return GUIDED_GIT_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return typeof mapped === "string";
    return true;
  });
}
