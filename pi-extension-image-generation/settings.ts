import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { MutationQueue } from "./workflow.ts";

export interface ImageSettings {
  authentication: "environment" | "environment-or-pi";
  defaultModel: string | null;
  selectionBehavior: "ask" | "default";
  aspectRatio: string | null;
  resolution: string | null;
  outputDirectory: string;
  preview: "inline" | "paths";
}

export const DEFAULT_SETTINGS: Readonly<ImageSettings> = Object.freeze({
  authentication: "environment", defaultModel: null, selectionBehavior: "ask",
  aspectRatio: null, resolution: null, outputDirectory: "generated-images", preview: "inline",
});
export type SettingsScope = "global" | "project";
export interface SettingsSnapshot {
  settings: ImageSettings;
  source: "built-in defaults" | SettingsScope;
  globalPath: string;
  projectPath: string;
  globalRaw: string | null;
  projectRaw: string | null;
  globalSettings: ImageSettings;
  projectSettings: ImageSettings;
}
const MAX_SETTINGS_BYTES = 16 * 1024;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;

export function validateSettings(value: unknown): ImageSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Image settings must be a complete settings profile.");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_SETTINGS);
  if (Object.keys(row).length !== keys.length || Object.keys(row).some((key) => !keys.includes(key))) {
    throw new Error("Image settings contain missing or unknown fields. Never store API keys in image settings.");
  }
  if (typeof row.authentication !== "string" || !["environment", "environment-or-pi"].includes(row.authentication)
    || typeof row.selectionBehavior !== "string" || !["ask", "default"].includes(row.selectionBehavior)
    || typeof row.preview !== "string" || !["inline", "paths"].includes(row.preview)) {
    throw new Error("Image settings contain an invalid preference.");
  }
  if (row.defaultModel !== null && (typeof row.defaultModel !== "string" || !MODEL_ID.test(row.defaultModel))) throw new Error("Invalid default image model.");
  for (const key of ["aspectRatio", "resolution"]) {
    if (row[key] !== null && (typeof row[key] !== "string" || !/^[a-zA-Z0-9:.-]{1,32}$/.test(row[key] as string))) throw new Error(`Invalid ${key} setting.`);
  }
  if (!row.defaultModel && (row.selectionBehavior === "default" || row.aspectRatio !== null || row.resolution !== null)) {
    throw new Error("Choose a default model before setting automatic selection, ratio, or resolution.");
  }
  if (typeof row.outputDirectory !== "string" || !row.outputDirectory.trim() || row.outputDirectory !== row.outputDirectory.trim()
    || row.outputDirectory.length > 1024 || /^[~]/.test(row.outputDirectory)
    || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(row.outputDirectory)) {
    throw new Error("Output directory must be a plain relative or absolute path, up to 1,024 characters. Expand ~ yourself.");
  }
  return { ...row } as unknown as ImageSettings;
}

function parseProfile(raw: string | null): ImageSettings | null {
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Image settings contain invalid JSON. Repair the file before generating images."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid image settings file.");
  const row = parsed as Record<string, unknown>;
  if (row.version !== 1 || !Object.hasOwn(row, "settings") || Object.keys(row).some((key) => !["version", "settings"].includes(key))) {
    throw new Error("Unsupported image settings format. Expected version 1 and settings only.");
  }
  return row.settings === null ? null : validateSettings(row.settings);
}

async function readProfile(path: string): Promise<string | null> {
  try {
    const parent = await lstat(dirname(path));
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("Image settings directory must be a real directory, not a symbolic link.");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Image settings must be a regular file, not a symbolic link.");
    const handle = await open(path, "r");
    try {
      const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        const result = await handle.read(bytes, count, bytes.length - count, null);
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      if (count > MAX_SETTINGS_BYTES) throw new Error("Image settings exceed the 16 KiB limit.");
      return bytes.subarray(0, count).toString("utf8");
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function createSettingsStore(agentDir: string, configDirName: string, mutate: MutationQueue) {
  const globalPath = join(agentDir, "image-generation.json");
  return {
    async load(cwd: string, trusted: boolean): Promise<SettingsSnapshot> {
      const projectPath = resolve(cwd, configDirName, "image-generation.json");
      const globalRaw = await readProfile(globalPath);
      const projectRaw = trusted ? await readProfile(projectPath) : null;
      const global = parseProfile(globalRaw);
      const project = parseProfile(projectRaw);
      return {
        settings: { ...(project ?? global ?? DEFAULT_SETTINGS) },
        source: project ? "project" : global ? "global" : "built-in defaults",
        globalPath, projectPath, globalRaw, projectRaw,
        globalSettings: { ...(global ?? DEFAULT_SETTINGS) },
        projectSettings: { ...(project ?? global ?? DEFAULT_SETTINGS) },
      };
    },
    async save(snapshot: SettingsSnapshot, scope: SettingsScope, settings: ImageSettings | null, trusted: boolean, signal: AbortSignal): Promise<void> {
      if (scope === "project" && !trusted) throw new Error("Trust this project before saving project image settings.");
      const validated = settings === null ? null : validateSettings(settings);
      const path = scope === "global" ? snapshot.globalPath : snapshot.projectPath;
      const expected = scope === "global" ? snapshot.globalRaw : snapshot.projectRaw;
      await mutate(path, async () => {
        signal.throwIfAborted();
        if (await readProfile(path) !== expected) throw new Error("Image settings changed while setup was open. Reopen setup instead of overwriting them.");
        await mkdir(dirname(path), { recursive: true });
        if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error("Image settings directory cannot be a symbolic link.");
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify({ version: 1, settings: validated }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
          signal.throwIfAborted();
          await rename(temporary, path);
        } finally { await rm(temporary, { force: true }).catch(() => {}); }
      });
    },
  };
}
