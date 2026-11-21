/**
 * Cache key of the dependency cache (spec §4.8): SHA-256 over the contents of
 * the project's key files (lockfiles and manifests), the `setup` commands,
 * `deps.env`, the backend, the base (image or helper version), the target OS
 * and architecture, and the helper's platform fingerprint. Any change to one
 * of them is a new key, so a changed lockfile never reuses old dependencies.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { compilePattern, DEFAULT_IGNORED_DIRS, type PathPattern } from "../sync/patterns.ts";

/** Default key files: lockfiles and manifests, matched by name at any depth. */
export const DEFAULT_KEY_FILES = [
  "requirements*.txt",
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
] as const;

/** Bounds of the key-file search, so a huge tree cannot stall a session start. */
export const KEY_FILE_LIMITS = {
  /** Directory depth below the project root. */
  depth: 8,
  /** Directory entries looked at. */
  entries: 100_000,
  /** Key files hashed. */
  files: 256,
  /** Bytes of one key file. */
  fileBytes: 64 * 1024 * 1024,
} as const;

/** Version of the key layout; bumping it invalidates every cache entry. */
const KEY_FORMAT = 1;

export interface DepsKeyInputs {
  projectRoot: string;
  /** `deps.keyFiles` from `.pi/gui.json` (gitignore-style patterns), or the defaults. */
  keyFiles?: readonly string[];
  setup: readonly string[];
  env: Readonly<Record<string, string>>;
  backend: string;
  /** What the installed dependencies were built against, e.g. `image 0.1.0`. */
  base: string;
  targetOs: string;
  arch: string;
  /** `hello.platform`, when the helper reports one. */
  platform?: string;
}

export interface DepsKey {
  /** 64 lowercase hex characters. */
  key: string;
  /** Root-relative key files that went into the key, sorted. */
  files: string[];
}

/** A key that cannot be computed (unreadable key file, bound exceeded); the cache is skipped for this start. */
export class DepsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepsKeyError";
  }
}

const IGNORED = new Set<string>(DEFAULT_IGNORED_DIRS);

/**
 * Root-relative paths (with `/`) of the regular files matching `patterns`,
 * sorted. Skips the default ignored directories (`.git`, `node_modules`,
 * virtualenvs, build output) and never follows symlinks.
 *
 * @throws DepsKeyError when a bound is exceeded or a directory is unreadable.
 */
export async function findKeyFiles(projectRoot: string, patterns: readonly string[] = DEFAULT_KEY_FILES): Promise<string[]> {
  let compiled: PathPattern[];
  try {
    compiled = patterns.map((p) => compilePattern(p));
  } catch (error) {
    throw new DepsKeyError(`deps.keyFiles: ${(error as Error).message}`);
  }
  const found: string[] = [];
  let entries = 0;
  const pending: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
  while (pending.length > 0) {
    const { rel, depth } = pending.pop()!;
    let list;
    try {
      list = await readdir(rel ? join(projectRoot, rel) : projectRoot, { withFileTypes: true });
    } catch (error) {
      throw new DepsKeyError(`cannot read ${rel || "the project root"} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
    }
    for (const entry of list) {
      if (++entries > KEY_FILE_LIMITS.entries) throw new DepsKeyError(`more than ${KEY_FILE_LIMITS.entries} entries while looking for key files; set deps.keyFiles in .pi/gui.json`);
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name) && depth + 1 < KEY_FILE_LIMITS.depth) pending.push({ rel: path, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (compiled.some((p) => p.test(path, false))) {
        found.push(path);
        if (found.length > KEY_FILE_LIMITS.files) throw new DepsKeyError(`more than ${KEY_FILE_LIMITS.files} key files; narrow deps.keyFiles in .pi/gui.json`);
      }
    }
  }
  return found.sort();
}

/** SHA-256 hex of one key file, refusing symlinks and files over the bound. */
async function hashFile(projectRoot: string, rel: string): Promise<string> {
  const path = join(projectRoot, rel);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    throw new DepsKeyError(`cannot read key file ${rel} (${error.code ?? error.message})`);
  });
  if (!info.isFile()) throw new DepsKeyError(`key file ${rel} is not a regular file`);
  if (info.size > KEY_FILE_LIMITS.fileBytes) throw new DepsKeyError(`key file ${rel} is larger than ${KEY_FILE_LIMITS.fileBytes} bytes`);
  const hash = createHash("sha256");
  let read = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
      read += (chunk as Buffer).length;
      if (read > KEY_FILE_LIMITS.fileBytes) throw new DepsKeyError(`key file ${rel} grew past ${KEY_FILE_LIMITS.fileBytes} bytes`);
      hash.update(chunk as Buffer);
    }
  } catch (error) {
    if (error instanceof DepsKeyError) throw error;
    throw new DepsKeyError(`cannot read key file ${rel} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
  }
  return hash.digest("hex");
}

/**
 * Computes the cache key. The JSON document hashed is canonical (fixed field
 * order, sorted files and env), so equal inputs always give equal keys.
 *
 * @throws DepsKeyError when a key file cannot be read or a bound is exceeded.
 */
export async function computeDepsKey(inputs: DepsKeyInputs): Promise<DepsKey> {
  const files = await findKeyFiles(inputs.projectRoot, inputs.keyFiles && inputs.keyFiles.length > 0 ? inputs.keyFiles : DEFAULT_KEY_FILES);
  const hashed: Array<[string, string]> = [];
  for (const file of files) hashed.push([file, await hashFile(inputs.projectRoot, file)]);
  const document = JSON.stringify({
    format: KEY_FORMAT,
    backend: inputs.backend,
    base: inputs.base,
    targetOs: inputs.targetOs,
    arch: inputs.arch,
    platform: inputs.platform ?? "",
    keyFiles: inputs.keyFiles && inputs.keyFiles.length > 0 ? [...inputs.keyFiles] : "default",
    setup: [...inputs.setup],
    env: Object.entries(inputs.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    files: hashed,
  });
  return { key: createHash("sha256").update(document).digest("hex"), files };
}
