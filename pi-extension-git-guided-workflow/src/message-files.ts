import path from "node:path";
import { COMMIT_MESSAGE_MAX_BYTES, GuidedGitError, type StatusSummary } from "./core.ts";
import { readSafeOptionalRepositoryFile, validateCommitArtifacts } from "./native-generation.ts";

export const COMMIT_MESSAGE_FILE_PATHS = Object.freeze({
  short: "dev/COMMIT/staged-commit-short.txt",
  long: "dev/COMMIT/staged-commit-long.txt",
} as const);
export const DEFAULT_COMMIT_SUBJECT_MAX_CHARACTERS = 72;

export interface CommitMessageFileCandidate {
  variant: "short" | "long";
  relativePath: string;
  absolutePath: string;
  message: string;
  sha256: string;
  byteLength: number;
  freshness: "unverified";
}

export interface CommitMessageFilePreview {
  short: CommitMessageFileCandidate;
  long: CommitMessageFileCandidate;
}

function removeArtifactTerminator(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/** Read the paired generated commit artifacts for explicit preview or reuse. */
export async function readCommitMessageFilePreview(root: string): Promise<CommitMessageFilePreview | null> {
  const [shortFile, longFile] = await Promise.all([
    readSafeOptionalRepositoryFile(root, COMMIT_MESSAGE_FILE_PATHS.short, COMMIT_MESSAGE_MAX_BYTES),
    readSafeOptionalRepositoryFile(root, COMMIT_MESSAGE_FILE_PATHS.long, COMMIT_MESSAGE_MAX_BYTES),
  ]);
  if (!shortFile && !longFile) return null;
  if (!shortFile || !longFile) {
    throw new GuidedGitError("INCOMPLETE_COMMIT_ARTIFACTS", "Generated commit artifacts must both be present before either can be reused");
  }
  const short = removeArtifactTerminator(shortFile.text);
  const long = removeArtifactTerminator(longFile.text);
  const validated = validateCommitArtifacts(short, long, "auto");
  return {
    short: {
      variant: "short",
      relativePath: COMMIT_MESSAGE_FILE_PATHS.short,
      absolutePath: path.join(path.resolve(root), ...COMMIT_MESSAGE_FILE_PATHS.short.split("/")),
      message: validated.short,
      sha256: shortFile.sha256,
      byteLength: shortFile.byteLength,
      freshness: "unverified",
    },
    long: {
      variant: "long",
      relativePath: COMMIT_MESSAGE_FILE_PATHS.long,
      absolutePath: path.join(path.resolve(root), ...COMMIT_MESSAGE_FILE_PATHS.long.split("/")),
      message: validated.long,
      sha256: longFile.sha256,
      byteLength: longFile.byteLength,
      freshness: "unverified",
    },
  };
}

export interface SingleFileCommitDefault {
  operation: "created" | "updated" | "deleted";
  path: string;
  message: string;
}

function safeStatusPath(bytes: Buffer): string {
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new GuidedGitError("UNSAFE_DEFAULT_MESSAGE_PATH", "The staged path is not valid UTF-8; write the commit message manually"); }
  if (!value || path.isAbsolute(value) || value.startsWith("-")
    || value.split(/[\\/]/u).some((segment) => segment === "" || segment === "." || segment === "..")
    || /\x00|[\u0001-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new GuidedGitError("UNSAFE_DEFAULT_MESSAGE_PATH", "The staged path is unsafe to place in an automatic commit message; write the message manually");
  }
  return value;
}

/** Derive a conservative exact-path subject only for one clean staged add, modify, or delete. */
export function deriveSingleFileCommitDefault(status: StatusSummary): SingleFileCommitDefault | null {
  if (status.staged !== 1 || status.unstaged !== 0 || status.untracked !== 0 || status.conflicted !== 0 || status.entries.length !== 1) return null;
  const entry = status.entries[0]!;
  if (!entry.staged || entry.unstaged || entry.untracked || entry.conflicted || entry.originalPath
    || !["A", "M", "D"].includes(entry.index) || entry.worktree !== " ") return null;
  const operation = ({ A: "created", M: "updated", D: "deleted" } as const)[entry.index as "A" | "M" | "D"];
  const filePath = safeStatusPath(entry.path);
  const message = `${operation} ${filePath}`;
  if ([...message].length > DEFAULT_COMMIT_SUBJECT_MAX_CHARACTERS || Buffer.byteLength(message, "utf8") > COMMIT_MESSAGE_MAX_BYTES) {
    throw new GuidedGitError("DEFAULT_MESSAGE_PATH_TOO_LONG", `The exact staged path does not fit the ${DEFAULT_COMMIT_SUBJECT_MAX_CHARACTERS}-character automatic subject limit; write the message manually`);
  }
  return { operation, path: filePath, message };
}
