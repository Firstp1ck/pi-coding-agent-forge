import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isReviewId, isReviewState, type ReviewState } from "./core.ts";

export const DEFAULT_STORAGE_LIMITS = {
  maxStateBytes: 32 * 1024 * 1024,
  maxArtifactBytes: 16 * 1024 * 1024,
} as const;

export type StorageLimits = {
  maxStateBytes?: number;
  maxArtifactBytes?: number;
};

type ResolvedStorageLimits = {
  maxStateBytes: number;
  maxArtifactBytes: number;
};
export type ReviewArtifactName = "report.json" | "report.md";

export class ReviewStorageError extends Error {}

export type ReviewStorage = {
  readonly rootDir: string;
  reviewDirectory(reviewId: string): Promise<string>;
  writeState(state: ReviewState): Promise<string>;
  readState(reviewId: string): Promise<ReviewState | undefined>;
  writeArtifact(reviewId: string, name: ReviewArtifactName, content: string): Promise<string>;
  readArtifact(reviewId: string, name: ReviewArtifactName): Promise<string | undefined>;
};

let temporarySequence = 0;

function resolvedLimits(input: StorageLimits = {}): ResolvedStorageLimits {
  const output = { ...DEFAULT_STORAGE_LIMITS, ...input };
  for (const [name, value] of Object.entries(output)) {
    if (!Number.isInteger(value) || value <= 0) throw new ReviewStorageError(`${name} must be a positive integer.`);
  }
  return output;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function ensurePrivateDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ReviewStorageError(`Storage directory is unsafe: ${directory}`);
  return await realpath(directory);
}

async function atomicWrite(destination: string, content: string, limit: number): Promise<void> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > limit) throw new ReviewStorageError(`Refusing to persist ${bytes} bytes above the ${limit}-byte storage limit.`);
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${++temporarySequence}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Windows readers can briefly deny replacement of an otherwise valid file.
    // Retry only sharing/access errors; never remove the old state to force it.
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temporary, destination); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readRegularFile(file: string, limit: number): Promise<string | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new ReviewStorageError(`Storage file is unsafe: ${file}`);
  if (info.size > limit) throw new ReviewStorageError(`Storage file exceeds the ${limit}-byte limit.`);
  return await readFile(file, "utf8");
}

function reviewSegment(reviewId: string): string {
  if (!isReviewId(reviewId)) throw new ReviewStorageError("Review ID has unsafe path characters.");
  return reviewId;
}

function artifactName(name: ReviewArtifactName): ReviewArtifactName {
  if (name !== "report.json" && name !== "report.md") throw new ReviewStorageError("Unsupported review artifact name.");
  return name;
}

/**
 * Versioned review state lives outside the reviewed project. Each state write
 * is a private atomic replacement; malformed or future state is rejected.
 */
export function createReviewStorage(input: { rootDir: string; limits?: StorageLimits }): ReviewStorage {
  if (typeof input.rootDir !== "string" || !input.rootDir) throw new ReviewStorageError("A storage root is required.");
  const rootDir = path.resolve(input.rootDir);
  const limits = resolvedLimits(input.limits);

  const reviewDirectory = async (reviewId: string): Promise<string> => {
    const root = await ensurePrivateDirectory(rootDir);
    const reviews = path.join(root, "reviews");
    if (!isInside(root, reviews)) throw new ReviewStorageError("Review directory escapes storage root.");
    await ensurePrivateDirectory(reviews);
    const destination = path.join(reviews, reviewSegment(reviewId));
    if (!isInside(reviews, destination)) throw new ReviewStorageError("Review path escapes storage root.");
    await ensurePrivateDirectory(destination);
    const resolvedReviews = await realpath(reviews);
    const resolvedDestination = await realpath(destination);
    if (!isInside(resolvedReviews, resolvedDestination) || resolvedDestination === resolvedReviews) {
      throw new ReviewStorageError("Review path escapes storage root through a symlink.");
    }
    return resolvedDestination;
  };

  return {
    rootDir,
    reviewDirectory,
    async writeState(state) {
      if (!isReviewState(state)) throw new ReviewStorageError("Refusing to persist invalid review state.");
      const directory = await reviewDirectory(state.reviewId);
      const destination = path.join(directory, "state.json");
      if (!isInside(directory, destination)) throw new ReviewStorageError("State path escapes review directory.");
      const content = `${JSON.stringify(state)}\n`;
      await atomicWrite(destination, content, limits.maxStateBytes);
      return destination;
    },
    async readState(reviewId) {
      const directory = await reviewDirectory(reviewId);
      const raw = await readRegularFile(path.join(directory, "state.json"), limits.maxStateBytes);
      if (raw === undefined) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ReviewStorageError("Persisted review state is not valid JSON.");
      }
      if (!isReviewState(parsed) || parsed.reviewId !== reviewId) {
        throw new ReviewStorageError("Persisted review state is malformed, inconsistent, or from an unsupported version.");
      }
      return parsed;
    },
    async writeArtifact(reviewId, name, content) {
      if (typeof content !== "string") throw new ReviewStorageError("Review artifact must be text.");
      const directory = await reviewDirectory(reviewId);
      const destination = path.join(directory, artifactName(name));
      if (!isInside(directory, destination)) throw new ReviewStorageError("Artifact path escapes review directory.");
      await atomicWrite(destination, content, limits.maxArtifactBytes);
      return destination;
    },
    async readArtifact(reviewId, name) {
      const directory = await reviewDirectory(reviewId);
      return await readRegularFile(path.join(directory, artifactName(name)), limits.maxArtifactBytes);
    },
  };
}
