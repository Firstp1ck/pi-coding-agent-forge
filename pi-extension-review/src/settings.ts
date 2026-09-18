import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

export const REVIEW_SETTINGS_VERSION = 1 as const;
export const REVIEW_RUNTIME_VERSION = 1 as const;
export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
export type ReviewThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ReviewMode = "git" | "work" | "paths";

export type ReviewModelProfile = {
  provider: string;
  modelId: string;
  thinkingLevel: ReviewThinkingLevel;
};

export type ReviewSettings = {
  mode: ReviewMode;
  paths: string[];
  exclusions: string[];
  model: ReviewModelProfile | null;
  contextLines: number;
  maxTurns: number;
  timeoutMs: number;
  maxNoProgress: number;
  maxContextBytes: number;
};

export const DEFAULT_REVIEW_SETTINGS: Readonly<ReviewSettings> = Object.freeze({
  mode: "git",
  paths: Object.freeze([]) as unknown as string[],
  exclusions: Object.freeze([]) as unknown as string[],
  model: null,
  contextLines: 3,
  maxTurns: 100,
  timeoutMs: 15 * 60_000,
  maxNoProgress: 3,
  maxContextBytes: 32 * 1024,
});

export type ReviewRuntimeRecord = {
  schemaVersion: typeof REVIEW_RUNTIME_VERSION;
  reviewId: string;
  ownerSessionId: string;
  projectRoot: string;
  mode: ReviewMode;
  paths: string[];
  exclusions: string[];
  model: ReviewModelProfile;
  limits: Pick<ReviewSettings, "contextLines" | "maxTurns" | "timeoutMs" | "maxNoProgress" | "maxContextBytes">;
  taskContext: string[];
  provenanceWarnings: string[];
  baselines: Array<
    | { path: string; expected: "present"; sha256: string; byteLength: number }
    | { path: string; expected: "absent" }
  >;
  createdAt: string;
  updatedAt: string;
  status: "frozen" | "running" | "paused" | "complete" | "cancelled" | "failed";
  finalReportSubmitted: boolean;
};

export class ReviewSettingsError extends Error {}

const SETTINGS_MAX_BYTES = 64 * 1024;
const RUNTIME_MAX_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return expected.length === actual.length && expected.every((key, index) => key === actual[index]);
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > max || CONTROL.test(value)) {
    throw new ReviewSettingsError(`${label} is invalid.`);
  }
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ReviewSettingsError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function stringList(value: unknown, label: string, maximumItems: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new ReviewSettingsError(`${label} is invalid.`);
  const result = value.map((item) => boundedString(item, label, 4_096));
  if (new Set(result).size !== result.length) throw new ReviewSettingsError(`${label} contains duplicates.`);
  return result;
}

function multilineList(value: unknown, label: string, maximumItems: number, maximumItemBytes: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new ReviewSettingsError(`${label} is invalid.`);
  const result = value.map((item) => {
    if (typeof item !== "string" || !item.trim() || Buffer.byteLength(item, "utf8") > maximumItemBytes || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(item)) throw new ReviewSettingsError(`${label} is invalid.`);
    return item;
  });
  if (new Set(result).size !== result.length) throw new ReviewSettingsError(`${label} contains duplicates.`);
  return result;
}

function projectSelectionList(value: unknown): string[] {
  const result = stringList(value, "Review paths", 100);
  for (const item of result) {
    const normalized = item.replace(/\\/gu, "/");
    if ((path.isAbsolute(item) || /^[A-Za-z]:/u.test(item)) || (normalized !== "." && normalized.split("/").some((segment) => !segment || segment === "." || segment === ".."))) {
      throw new ReviewSettingsError("Review paths must be canonical project-relative paths.");
    }
  }
  return result;
}

function exclusionList(value: unknown): string[] {
  const result = stringList(value, "Review exclusions", 100);
  for (const item of result) {
    const normalized = item.replace(/\\/gu, "/");
    if (path.isAbsolute(item) || /^[A-Za-z]:/u.test(item) || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      throw new ReviewSettingsError("Review exclusions must be project-relative patterns without traversal.");
    }
  }
  return result;
}

export function validateReviewModelProfile(value: unknown): ReviewModelProfile {
  if (!plain(value) || !exactKeys(value, ["provider", "modelId", "thinkingLevel"])) {
    throw new ReviewSettingsError("Review model profile is invalid.");
  }
  const thinkingLevel = value.thinkingLevel;
  if (typeof thinkingLevel !== "string" || !THINKING_LEVELS.includes(thinkingLevel as ReviewThinkingLevel)) {
    throw new ReviewSettingsError("Review thinking level is invalid.");
  }
  return {
    provider: boundedString(value.provider, "Review provider", 160),
    modelId: boundedString(value.modelId, "Review model ID", 512),
    thinkingLevel: thinkingLevel as ReviewThinkingLevel,
  };
}

export function validateReviewSettings(value: unknown): ReviewSettings {
  if (!plain(value) || !exactKeys(value, ["mode", "paths", "exclusions", "model", "contextLines", "maxTurns", "timeoutMs", "maxNoProgress", "maxContextBytes"])) {
    throw new ReviewSettingsError("Review settings are incomplete or contain unknown fields.");
  }
  if (value.mode !== "git" && value.mode !== "work" && value.mode !== "paths") throw new ReviewSettingsError("Review mode is invalid.");
  const paths = projectSelectionList(value.paths);
  if (value.mode === "paths" && paths.length === 0) throw new ReviewSettingsError("Paths mode needs at least one path.");
  return {
    mode: value.mode,
    paths,
    exclusions: exclusionList(value.exclusions),
    model: value.model === null ? null : validateReviewModelProfile(value.model),
    contextLines: boundedInteger(value.contextLines, "Context lines", 1, 100),
    maxTurns: boundedInteger(value.maxTurns, "Maximum turns", 1, 1_000),
    timeoutMs: boundedInteger(value.timeoutMs, "Attempt timeout", 1_000, 3_600_000),
    maxNoProgress: boundedInteger(value.maxNoProgress, "No-progress limit", 1, 20),
    maxContextBytes: boundedInteger(value.maxContextBytes, "Work context byte limit", 1_024, 256 * 1024),
  };
}

function iso(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

export function validateReviewRuntimeRecord(value: unknown): ReviewRuntimeRecord {
  const keys = ["schemaVersion", "reviewId", "ownerSessionId", "projectRoot", "mode", "paths", "exclusions", "model", "limits", "taskContext", "provenanceWarnings", "baselines", "createdAt", "updatedAt", "status", "finalReportSubmitted"];
  if (!plain(value) || !exactKeys(value, keys) || value.schemaVersion !== REVIEW_RUNTIME_VERSION) throw new ReviewSettingsError("Review runtime record is invalid.");
  if (typeof value.reviewId !== "string" || typeof value.ownerSessionId !== "string" || !SAFE_ID.test(value.reviewId) || !SAFE_ID.test(value.ownerSessionId)) throw new ReviewSettingsError("Review runtime ownership is invalid.");
  if (value.model === null) throw new ReviewSettingsError("Review runtime model is required.");
  if (typeof value.projectRoot !== "string" || !path.isAbsolute(value.projectRoot) || value.projectRoot.length > 4_096 || CONTROL.test(value.projectRoot)) throw new ReviewSettingsError("Review project root is invalid.");
  if (value.mode !== "git" && value.mode !== "work" && value.mode !== "paths") throw new ReviewSettingsError("Review runtime mode is invalid.");
  if (!plain(value.limits) || !exactKeys(value.limits, ["contextLines", "maxTurns", "timeoutMs", "maxNoProgress", "maxContextBytes"])) throw new ReviewSettingsError("Review runtime limits are invalid.");
  const settings = validateReviewSettings({ mode: value.mode, paths: value.paths, exclusions: value.exclusions, model: value.model, ...value.limits });
  const taskContext = multilineList(value.taskContext, "Task context", 200, settings.maxContextBytes);
  const provenanceWarnings = stringList(value.provenanceWarnings, "Provenance warnings", 200);
  if (!Array.isArray(value.baselines) || value.baselines.length > 500) throw new ReviewSettingsError("Review baselines are invalid.");
  const baselines: ReviewRuntimeRecord["baselines"] = value.baselines.map((item) => {
    if (!plain(item) || typeof item.path !== "string") throw new ReviewSettingsError("Review baselines are invalid.");
    projectSelectionList([item.path]);
    if (item.expected === "absent" && exactKeys(item, ["path", "expected"])) return { path: item.path, expected: "absent" as const };
    if (item.expected === "present" && exactKeys(item, ["path", "expected", "sha256", "byteLength"]) && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/u.test(item.sha256) && Number.isSafeInteger(item.byteLength) && (item.byteLength as number) >= 0) {
      return { path: item.path, expected: "present" as const, sha256: item.sha256, byteLength: item.byteLength as number };
    }
    throw new ReviewSettingsError("Review baselines are invalid.");
  });
  if (new Set(baselines.map((item) => item.path)).size !== baselines.length) throw new ReviewSettingsError("Review baselines contain duplicates.");
  if (Buffer.byteLength(JSON.stringify({ taskContext, provenanceWarnings, baselines }), "utf8") > RUNTIME_MAX_BYTES / 2) throw new ReviewSettingsError("Review runtime context is too large.");
  if (!iso(value.createdAt) || !iso(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(value.createdAt)) throw new ReviewSettingsError("Review runtime timestamps are invalid.");
  if (!["frozen", "running", "paused", "complete", "cancelled", "failed"].includes(String(value.status)) || typeof value.finalReportSubmitted !== "boolean") throw new ReviewSettingsError("Review runtime status is invalid.");
  return {
    schemaVersion: REVIEW_RUNTIME_VERSION,
    reviewId: value.reviewId, ownerSessionId: value.ownerSessionId, projectRoot: value.projectRoot,
    mode: value.mode, paths: settings.paths, exclusions: settings.exclusions, model: settings.model!,
    limits: { contextLines: settings.contextLines, maxTurns: settings.maxTurns, timeoutMs: settings.timeoutMs, maxNoProgress: settings.maxNoProgress, maxContextBytes: settings.maxContextBytes },
    taskContext, provenanceWarnings, baselines, createdAt: value.createdAt, updatedAt: value.updatedAt,
    status: value.status as ReviewRuntimeRecord["status"], finalReportSubmitted: value.finalReportSubmitted,
  };
}

async function safeDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ReviewSettingsError("Review storage directory is unsafe.");
  return await realpath(directory);
}

async function readBounded(file: string, maxBytes: number): Promise<string | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new ReviewSettingsError("Review storage file is unsafe or too large.");
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(file: string, content: string, maxBytes: number): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > maxBytes) throw new ReviewSettingsError("Review storage content is too large.");
  await safeDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temporary, file); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 5 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseEnvelope(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ReviewSettingsError(`${label} is not valid JSON.`); }
  if (!plain(value)) throw new ReviewSettingsError(`${label} is invalid.`);
  return value;
}

export function createReviewSettingsStore(agentDir: string) {
  const root = path.resolve(agentDir, "review");
  const settingsPath = path.join(root, "settings.json");
  return {
    root,
    settingsPath,
    async load(): Promise<{ raw: string | undefined; settings: ReviewSettings }> {
      const raw = await readBounded(settingsPath, SETTINGS_MAX_BYTES);
      if (raw === undefined) return { raw, settings: validateReviewSettings(DEFAULT_REVIEW_SETTINGS) };
      const envelope = parseEnvelope(raw, "Review settings file");
      if (!exactKeys(envelope, ["version", "settings"]) || envelope.version !== REVIEW_SETTINGS_VERSION) throw new ReviewSettingsError("Review settings version is unsupported.");
      return { raw, settings: validateReviewSettings(envelope.settings) };
    },
    async save(expectedRaw: string | undefined, settings: ReviewSettings): Promise<void> {
      const validated = validateReviewSettings(settings);
      if (await readBounded(settingsPath, SETTINGS_MAX_BYTES) !== expectedRaw) throw new ReviewSettingsError("Review settings changed while setup was open. Reopen setup.");
      await atomicWrite(settingsPath, `${JSON.stringify({ version: REVIEW_SETTINGS_VERSION, settings: validated }, null, 2)}\n`, SETTINGS_MAX_BYTES);
    },
  };
}

export function createReviewRuntimeStore(agentDir: string) {
  const root = path.resolve(agentDir, "review");
  const runs = path.join(root, "runs");
  const pointers = path.join(root, "current");
  const pointerKey = (owner: string, projectRoot: string) => `${createHash("sha256").update(`${owner}\0${path.resolve(projectRoot)}`).digest("hex")}.json`;
  return {
    root,
    stateRoot: path.join(root, "state"),
    async write(record: ReviewRuntimeRecord): Promise<void> {
      const validated = validateReviewRuntimeRecord(record);
      await atomicWrite(path.join(runs, `${validated.reviewId}.json`), `${JSON.stringify(validated)}\n`, RUNTIME_MAX_BYTES);
      await atomicWrite(path.join(pointers, pointerKey(validated.ownerSessionId, validated.projectRoot)), `${JSON.stringify({ reviewId: validated.reviewId })}\n`, 1_024);
    },
    async read(reviewId: string): Promise<ReviewRuntimeRecord | undefined> {
      if (typeof reviewId !== "string" || !SAFE_ID.test(reviewId)) throw new ReviewSettingsError("Review ID is invalid.");
      const raw = await readBounded(path.join(runs, `${reviewId}.json`), RUNTIME_MAX_BYTES);
      if (raw === undefined) return undefined;
      const record = validateReviewRuntimeRecord(parseEnvelope(raw, "Review runtime record"));
      if (record.reviewId !== reviewId) throw new ReviewSettingsError("Review runtime filename and embedded ID do not match.");
      return record;
    },
    async current(owner: string, projectRoot: string): Promise<ReviewRuntimeRecord | undefined> {
      if (!SAFE_ID.test(owner)) throw new ReviewSettingsError("Session ID is invalid.");
      const raw = await readBounded(path.join(pointers, pointerKey(owner, projectRoot)), 1_024);
      if (raw === undefined) return undefined;
      const value = parseEnvelope(raw, "Review pointer");
      if (!exactKeys(value, ["reviewId"]) || typeof value.reviewId !== "string") throw new ReviewSettingsError("Review pointer is invalid.");
      return await this.read(value.reviewId);
    },
  };
}

/** Match a canonical project-relative path against a bounded user exclusion. */
export function matchesReviewExclusion(relativePath: string, patterns: readonly string[]): string | undefined {
  const normalized = relativePath.replace(/\\/gu, "/");
  for (const pattern of patterns) {
    const escaped = pattern.replace(/\\/gu, "/").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*");
    if (new RegExp(`^${escaped}(?:/.*)?$`, "u").test(normalized)) return `User exclusion: ${pattern}`;
  }
  return undefined;
}
