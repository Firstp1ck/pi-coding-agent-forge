import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import {
  CLASSIFICATION_VERSION,
  classificationCompatibility,
  classifyPath,
  isRelevantIgnorePath,
  normalizeReportPath,
  normalizeScopeRoots,
  pathIsInScope,
} from "./classification.mjs";
import {
  GitClient,
  computeIsolatedLineChanges,
  gitCompatibility,
  hashBytes,
  uniqueExactRenames,
} from "./git.mjs";
import {
  CommandFailure,
  DEFAULT_LIMITS,
  DeadlineExceededError,
  ScanDeadline,
  SubprocessTracker,
  createScannerTempRoot,
  sha256File,
} from "./runner.mjs";

const SNAPSHOT_STATE = new WeakMap();
const COLLECTION_STATE = new WeakMap();

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pathKey(rawPath) {
  return Buffer.from(rawPath).toString("hex");
}

function isRegularGitEntry(entry) {
  return entry.type === "blob" && entry.mode.startsWith("100");
}

function isRegularIndexEntry(entry) {
  return entry.mode.startsWith("100");
}

function isIgnoreFile(reportPath) {
  return reportPath === ".gitignore" || reportPath.endsWith("/.gitignore");
}

function increment(object, key, amount = 1) {
  object[key] = (object[key] ?? 0) + amount;
}

function createCoverage(limits) {
  return {
    status: "complete",
    complete: true,
    counts: {
      discovered: 0,
      inScope: 0,
      eligible: 0,
      captured: 0,
      exclusions: {},
      unreadable: 0,
      truncated: 0,
      invalidPaths: 0,
      omitted: 0,
    },
    reasons: [],
    diagnostics: [],
    divergenceTotal: 0,
    limits: { maxDivergenceExamples: limits.maxDivergenceExamples },
  };
}

function markIncomplete(coverage, reason, reportPath = null) {
  coverage.complete = false;
  if (coverage.status === "complete") coverage.status = "partial";
  if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason);
  if (reportPath && coverage.diagnostics.length < coverage.limits.maxDivergenceExamples) {
    coverage.diagnostics.push({ reason, path: reportPath });
  }
}

function markDivergence(coverage, reason, reportPath = null) {
  coverage.divergenceTotal += 1;
  markIncomplete(coverage, reason, reportPath);
}

function exclude(coverage, reason) {
  increment(coverage.counts.exclusions, reason);
}

function immutableCoverage(coverage) {
  return Object.freeze({
    ...coverage,
    counts: Object.freeze({
      ...coverage.counts,
      exclusions: Object.freeze({ ...coverage.counts.exclusions }),
    }),
    reasons: Object.freeze([...coverage.reasons].sort()),
    diagnostics: Object.freeze([...coverage.diagnostics]),
    limits: Object.freeze({ ...coverage.limits }),
  });
}

class RetainedSourceBudget {
  constructor(limit) {
    this.limit = limit;
    this.retained = 0;
  }

  remaining() {
    return Math.max(0, this.limit - this.retained);
  }

  reserve(size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.remaining()) return false;
    this.retained += size;
    return true;
  }

  release(size) {
    this.retained = Math.max(0, this.retained - size);
  }
}

function sameFileIdentity(left, right) {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function absoluteWorktreePath(root, reportPath) {
  const result = path.resolve(root, ...reportPath.split("/"));
  const relative = path.relative(root, result);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError("Repository-relative path escaped its root.");
  }
  return result;
}

function canonicalContains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function canonicalPathIsContained(root, filename) {
  const canonicalRoot = await fs.realpath(root);
  const canonicalFilename = await fs.realpath(filename);
  return canonicalContains(canonicalRoot, canonicalFilename);
}

async function ancestorsAreSafe(root, reportPath) {
  const canonicalRoot = await fs.realpath(root);
  let current = root;
  const segments = reportPath.split("/");
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const metadata = await fs.lstat(current);
    if (metadata.isSymbolicLink()) return false;
    const canonicalCurrent = await fs.realpath(current);
    if (canonicalCurrent !== canonicalRoot && !canonicalContains(canonicalRoot, canonicalCurrent)) return false;
  }
  return true;
}

async function readBoundedHandle(handle, expectedSize, { limit, deadline }) {
  if (expectedSize > limit) return null;
  const chunks = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expectedSize)));
  let offset = 0;
  while (offset < expectedSize) {
    deadline.assertWorkAvailable();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedSize - offset), offset);
    if (bytesRead === 0) throw new CommandFailure("file", null, "short-bounded-read");
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    offset += bytesRead;
  }
  deadline.assertWorkAvailable();
  const extra = await handle.read(buffer, 0, 1, offset);
  if (extra.bytesRead !== 0) return null;
  return Buffer.concat(chunks, expectedSize);
}

async function readStableFile(root, reportPath, { limits, deadline, retainedBudget = null, retain = true }) {
  deadline.assertWorkAvailable();
  const filename = absoluteWorktreePath(root, reportPath);
  let before;
  try {
    before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink()) return { status: "special" };
    if (!(await ancestorsAreSafe(root, reportPath)) || !(await canonicalPathIsContained(root, filename))) return { status: "unsafe" };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "unreadable" };
  }

  let handle;
  let reserved = false;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const descriptorBefore = await handle.stat();
    if (!sameFileIdentity(before, descriptorBefore)) return { status: "unstable" };
    if (descriptorBefore.size > limits.maxFileBytes) return { status: "truncated", size: descriptorBefore.size };
    if (retain && retainedBudget && !retainedBudget.reserve(descriptorBefore.size)) return { status: "truncated", size: descriptorBefore.size };
    reserved = retain && Boolean(retainedBudget);
    const bytes = await readBoundedHandle(handle, descriptorBefore.size, { limit: limits.maxFileBytes, deadline });
    const descriptorAfter = await handle.stat();
    const pathnameAfter = await fs.lstat(filename).catch(() => null);
    const containedAfter = await canonicalPathIsContained(root, filename).catch(() => false);
    const safeAncestorsAfter = await ancestorsAreSafe(root, reportPath).catch(() => false);
    const stable = bytes && pathnameAfter && containedAfter && safeAncestorsAfter && sameFileIdentity(descriptorBefore, descriptorAfter) && sameFileIdentity(descriptorAfter, pathnameAfter);
    if (!stable) {
      if (reserved) retainedBudget.release(descriptorBefore.size);
      return bytes ? { status: "unstable" } : { status: "truncated", size: descriptorAfter.size };
    }
    return { status: "ok", bytes, size: bytes.length, sha256: hashBytes(bytes), reserved: reserved ? bytes.length : 0 };
  } catch (error) {
    if (reserved) retainedBudget.release(before.size);
    return { status: error?.code === "ENOENT" ? "missing" : "unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readOptionalOwnedFile(filename, { limits, deadline }) {
  deadline.assertWorkAvailable();
  let handle;
  try {
    const before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > limits.maxFileBytes) return { status: "invalid" };
    handle = await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const descriptor = await handle.stat();
    if (!sameFileIdentity(before, descriptor)) return { status: "invalid" };
    const bytes = await readBoundedHandle(handle, descriptor.size, { limit: limits.maxFileBytes, deadline });
    const after = await handle.stat();
    if (!bytes || !sameFileIdentity(descriptor, after)) return { status: "invalid" };
    return { status: "ok", bytes, sha256: hashBytes(bytes) };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", bytes: Buffer.alloc(0), sha256: hashBytes(Buffer.alloc(0)) };
    return { status: "invalid" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function prepareCandidates(metadata, { scopeRoots, coverage, type = "git" }) {
  const prepared = [];
  const seen = new Set();
  for (const item of metadata) {
    coverage.counts.discovered += 1;
    const key = pathKey(item.rawPath);
    if (seen.has(key)) {
      markIncomplete(coverage, "duplicate-path-metadata");
      continue;
    }
    seen.add(key);
    const reportPath = normalizeReportPath(item.rawPath);
    if (!reportPath) {
      coverage.counts.invalidPaths += 1;
      markIncomplete(coverage, "invalid-path-encoding");
      continue;
    }
    if (type === "git" ? !isRegularGitEntry(item) : !isRegularIndexEntry(item)) {
      exclude(coverage, item.mode?.startsWith("120") ? "symlink" : item.mode?.startsWith("160") || item.type === "commit" ? "submodule" : "special-file");
      continue;
    }
    prepared.push({ ...item, key, path: reportPath });
  }
  return prepared;
}

function ignorePolicyIdentity(infoExclude, gitignoreSources) {
  return digest([infoExclude, ...gitignoreSources]
    .map((source) => ({ path: source.path, sha256: source.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path)));
}

async function prepareIgnoreWorkspace(git, workspace, { infoExclude, gitignoreSources, candidatePaths }) {
  if (gitignoreSources.length === 0 && infoExclude.bytes.length === 0) {
    return { identity: ignorePolicyIdentity(infoExclude, gitignoreSources), ignoredPaths: new Set() };
  }
  if (!workspace.initialized) {
    await fs.mkdir(workspace.root, { recursive: true, mode: 0o700 });
    await fs.mkdir(workspace.template, { recursive: true, mode: 0o700 });
    await git.run(["init", "--quiet", `--template=${workspace.template}`], { cwd: workspace.root, inRepository: false });
    workspace.initialized = true;
  }
  for (const name of await fs.readdir(workspace.root)) {
    if (name !== ".git") await fs.rm(path.join(workspace.root, name), { recursive: true, force: true });
  }
  for (const source of gitignoreSources) {
    const target = absoluteWorktreePath(workspace.root, source.path);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, source.bytes, { flag: "wx", mode: 0o600 });
  }
  const infoExcludePath = path.join(workspace.root, ".git", "info", "exclude");
  await fs.mkdir(path.dirname(infoExcludePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(infoExcludePath, infoExclude.bytes, { flag: "w", mode: 0o600 });
  const uniquePaths = [...new Set(candidatePaths)].sort((left, right) => left.localeCompare(right));
  if (uniquePaths.length === 0) return { identity: ignorePolicyIdentity(infoExclude, gitignoreSources), ignoredPaths: new Set() };
  const response = await git.run(["check-ignore", "--no-index", "-z", "--stdin"], {
    cwd: workspace.root,
    inRepository: false,
    allowedExitCodes: [0, 1],
    input: Buffer.concat(uniquePaths.map((reportPath) => Buffer.concat([Buffer.from(reportPath, "utf8"), Buffer.from([0])]))),
  });
  const ignoredPaths = new Set();
  if (response.stdout.length > 0 && response.stdout.at(-1) !== 0) throw new CommandFailure("git check-ignore", null, "malformed-ignore-output");
  let start = 0;
  for (let index = 0; index < response.stdout.length; index += 1) {
    if (response.stdout[index] !== 0) continue;
    const reportPath = normalizeReportPath(response.stdout.subarray(start, index));
    if (!reportPath || !uniquePaths.includes(reportPath)) throw new CommandFailure("git check-ignore", null, "invalid-ignore-output");
    ignoredPaths.add(reportPath);
    start = index + 1;
  }
  return { identity: ignorePolicyIdentity(infoExclude, gitignoreSources), ignoredPaths };
}

function entryFromBytes(candidate, bytes, source) {
  const classification = classifyPath(candidate.path, candidate.classificationOptions);
  return {
    key: candidate.key,
    path: candidate.path,
    mode: candidate.mode,
    category: classification.category,
    language: classification.language,
    classificationRule: classification.reason,
    byteLength: bytes.length,
    sha256: hashBytes(bytes),
    bytes,
    captureSource: source,
  };
}

function recordReadFailure(coverage, result, reportPath) {
  if (result.status === "truncated") {
    coverage.counts.truncated += 1;
    markIncomplete(coverage, "file-truncated", reportPath);
  } else if (result.status === "unreadable") {
    coverage.counts.unreadable += 1;
    markIncomplete(coverage, "file-unreadable", reportPath);
  } else if (result.status === "unstable") {
    markDivergence(coverage, "file-modified-during-read", reportPath);
  } else if (result.status === "unsafe") {
    markIncomplete(coverage, "unsafe-path", reportPath);
  } else if (result.status === "missing") {
    markDivergence(coverage, "file-missing-during-read", reportPath);
  } else {
    markIncomplete(coverage, "unsupported-file-type", reportPath);
  }
}

function snapshotFromEntries({ kind, entries, coverage, ignoreIdentity, captureIdentity }) {
  const publicFiles = [...entries.values()].map((entry) => Object.freeze({
    path: entry.path,
    mode: entry.mode,
    category: entry.category,
    language: entry.language,
    classificationRule: entry.classificationRule,
    byteLength: entry.byteLength,
    sha256: entry.sha256,
    captureSource: entry.captureSource,
  })).sort((left, right) => left.path.localeCompare(right.path));
  const snapshot = Object.freeze({
    kind,
    manifestDigest: digest(publicFiles),
    files: Object.freeze(publicFiles),
    ignoreIdentity,
    captureIdentity,
    coverage: immutableCoverage(coverage),
  });
  SNAPSHOT_STATE.set(snapshot, { entries });
  return snapshot;
}

function emptySnapshot(kind, coverage) {
  return snapshotFromEntries({ kind, entries: new Map(), coverage, ignoreIdentity: null, captureIdentity: null });
}

function entriesDigest(entries) {
  return digest([...entries.values()].map((entry) => ({ key: entry.key, path: entry.path, mode: entry.mode, sha256: entry.sha256 })).sort((left, right) => left.key.localeCompare(right.key)));
}

async function captureGitSnapshot({ git, prepared, scopeRoots, classificationOptions, limits, deadline, sourceBudget, coverage, frozenIgnorePolicy, signal = null }) {
  const { tree, candidates } = prepared;
  if (!frozenIgnorePolicy) {
    markIncomplete(coverage, "ignore-policy-unavailable");
    return { entries: new Map(), ignoreIdentity: null, treeIdentity: digest(tree.map((entry) => ({ mode: entry.mode, type: entry.type, objectId: entry.objectId, key: pathKey(entry.rawPath) }))) };
  }
  const batch = git.openBlobBatch({ signal });
  try {
    const entries = new Map();
    for (const candidate of candidates) {
      deadline.assertWorkAvailable();
      if (!pathIsInScope(candidate.path, scopeRoots)) {
        exclude(coverage, "outside-scope");
        continue;
      }
      coverage.counts.inScope += 1;
      if (frozenIgnorePolicy.ignoredPaths.has(candidate.path)) {
        exclude(coverage, "ignored");
        continue;
      }
      const classification = classifyPath(candidate.path, classificationOptions);
      if (!classification.included) {
        exclude(coverage, classification.reason);
        continue;
      }
      if (entries.size >= limits.maxFiles) {
        markIncomplete(coverage, "file-count-limit", candidate.path);
        break;
      }
      coverage.counts.eligible += 1;
      try {
        const maximum = Math.min(limits.maxFileBytes, sourceBudget.remaining());
        if (maximum <= 0) throw new CommandFailure("git cat-file", null, "retained-source-limit");
        const bytes = await batch.request(candidate.objectId, { maxBytes: maximum });
        if (!sourceBudget.reserve(bytes.length)) throw new CommandFailure("git cat-file", null, "retained-source-limit");
        if (bytes.includes(0)) {
          sourceBudget.release(bytes.length);
          exclude(coverage, "binary");
          continue;
        }
        entries.set(candidate.key, entryFromBytes(candidate, bytes, "git-blob"));
        coverage.counts.captured += 1;
      } catch (error) {
        if (!(error instanceof CommandFailure) || !["blob-exceeds-capture-limit", "retained-source-limit"].includes(error.reason)) throw error;
        coverage.counts.truncated += 1;
        markIncomplete(coverage, "file-truncated", candidate.path);
        break;
      }
    }
    return { entries, ignoreIdentity: frozenIgnorePolicy.identity, treeIdentity: digest(tree.map((entry) => ({ mode: entry.mode, type: entry.type, objectId: entry.objectId, key: pathKey(entry.rawPath) }))) };
  } finally {
    await batch.close();
  }
}

async function currentMetadata(git, scopeRoots, includeUntracked) {
  const indexEntries = await git.listIndex();
  const untrackedResult = await git.listUntracked({ scopeRoots, includeUntracked });
  const unmerged = indexEntries.filter((entry) => entry.stage !== 0);
  const skipWorktree = indexEntries.filter((entry) => entry.tag === "S");
  const tracked = indexEntries.filter((entry) => entry.stage === 0);
  const records = [...tracked];
  if (includeUntracked) {
    for (const rawPath of untrackedResult.paths) records.push({ mode: "100644", rawPath, objectId: null, stage: 0, tag: null, untracked: true });
  } else {
    // The scanner enumerated only relevant untracked .gitignore inputs. They
    // influence frozen eligibility but never become current source entries.
    for (const rawPath of untrackedResult.paths) {
      const reportPath = normalizeReportPath(rawPath);
      if (reportPath && isRelevantIgnorePath(reportPath, scopeRoots)) records.push({ mode: "100644", rawPath, objectId: null, stage: 0, tag: null, untracked: true, ignoreOnly: true });
    }
  }
  return { records, unmerged, skipWorktree, untrackedDiscovery: untrackedResult.discovery };
}

async function captureCurrentSnapshot({ root, git, scopeRoots, classificationOptions, limits, deadline, sourceBudget, coverage, infoExclude, includeUntracked, ignoreWorkspace, baseCandidates = [], retain = true }) {
  const metadata = await currentMetadata(git, scopeRoots, includeUntracked);
  if (metadata.unmerged.length > 0) {
    markIncomplete(coverage, "unmerged-index");
    return { entries: new Map(), ignoreIdentity: null, metadataIdentity: null, frozenIgnores: null, blocked: true };
  }
  if (metadata.skipWorktree.length > 0) {
    markIncomplete(coverage, "skip-worktree-unsupported");
    return { entries: new Map(), ignoreIdentity: null, metadataIdentity: null, frozenIgnores: null, blocked: true };
  }
  const candidates = prepareCandidates(metadata.records, { scopeRoots, coverage, type: "index" }).map((candidate) => ({ ...candidate, classificationOptions }));
  const ignoreSources = [];
  let transientIgnoreBytes = 0;
  for (const candidate of candidates.filter((entry) => isRelevantIgnorePath(entry.path, scopeRoots))) {
    const read = await readStableFile(root, candidate.path, { limits, deadline, retainedBudget: sourceBudget, retain });
    if (read.status !== "ok") {
      recordReadFailure(coverage, read, candidate.path);
      continue;
    }
    transientIgnoreBytes += read.bytes.length;
    if (!retain && transientIgnoreBytes > limits.maxRetainedBytes) {
      markIncomplete(coverage, "ignore-input-limit", candidate.path);
      break;
    }
    ignoreSources.push({ path: candidate.path, bytes: read.bytes, sha256: read.sha256 });
  }
  const ignores = await prepareIgnoreWorkspace(git, ignoreWorkspace, {
    infoExclude,
    gitignoreSources: ignoreSources,
    candidatePaths: [...baseCandidates, ...candidates].map((candidate) => candidate.path),
  });
  if (retain) for (const source of ignoreSources) sourceBudget.release(source.bytes.length);
  const entries = new Map();
  for (const candidate of candidates) {
    deadline.assertWorkAvailable();
    if (candidate.ignoreOnly) continue;
    if (!pathIsInScope(candidate.path, scopeRoots)) {
      exclude(coverage, "outside-scope");
      continue;
    }
    coverage.counts.inScope += 1;
    if (ignores.ignoredPaths.has(candidate.path)) {
      exclude(coverage, "ignored");
      continue;
    }
    const classification = classifyPath(candidate.path, classificationOptions);
    if (!classification.included) {
      exclude(coverage, classification.reason);
      continue;
    }
    if (entries.size >= limits.maxFiles) {
      markIncomplete(coverage, "file-count-limit", candidate.path);
      break;
    }
    coverage.counts.eligible += 1;
    const read = await readStableFile(root, candidate.path, { limits, deadline, retainedBudget: sourceBudget, retain });
    if (read.status === "missing" && !candidate.untracked) {
      // A tracked path absent from the worktree is a legitimate current-side deletion.
      continue;
    }
    if (read.status !== "ok") {
      recordReadFailure(coverage, read, candidate.path);
      continue;
    }
    if (read.bytes.includes(0)) {
      if (retain) sourceBudget.release(read.reserved);
      exclude(coverage, "binary");
      continue;
    }
    const entry = entryFromBytes(candidate, read.bytes, "worktree");
    if (!retain) delete entry.bytes;
    entries.set(candidate.key, entry);
    coverage.counts.captured += 1;
  }
  return {
    entries,
    ignoreIdentity: ignores.identity,
    metadataIdentity: digest(metadata.records.map((entry) => ({ key: pathKey(entry.rawPath), mode: entry.mode, stage: entry.stage, tag: entry.tag ?? null, untracked: Boolean(entry.untracked) })).sort((left, right) => left.key.localeCompare(right.key))),
    frozenIgnores: ignores,
    blocked: false,
    untrackedDiscovery: metadata.untrackedDiscovery,
  };
}

async function observeGitStability({ root, git, commit, scopeRoots, classificationOptions, limits, deadline, infoExcludePath, indexPath, includeUntracked, ignoreWorkspace, initial }) {
  const coverage = createCoverage(limits);
  const infoExclude = await readOptionalOwnedFile(infoExcludePath, { limits, deadline });
  if (infoExclude.status !== "ok" && infoExclude.status !== "missing") markIncomplete(coverage, "ignore-input-unavailable");
  const observedCurrent = await captureCurrentSnapshot({
    root,
    git,
    scopeRoots,
    classificationOptions,
    limits,
    deadline,
    sourceBudget: null,
    coverage,
    infoExclude: { path: "info/exclude", bytes: infoExclude.bytes ?? Buffer.alloc(0), sha256: infoExclude.sha256 ?? hashBytes(Buffer.alloc(0)) },
    includeUntracked,
    ignoreWorkspace,
    retain: false,
  });
  const observedTree = commit ? await git.listTree(commit) : null;
  const treeIdentity = observedTree ? digest(observedTree.map((entry) => ({ mode: entry.mode, type: entry.type, objectId: entry.objectId, key: pathKey(entry.rawPath) }))) : null;
  const indexHash = await sha256File(indexPath, { deadline, maxBytes: limits.maxRetainedBytes }).catch(() => null);
  const matches = initial.current.metadataIdentity === observedCurrent.metadataIdentity
    && initial.current.ignoreIdentity === observedCurrent.ignoreIdentity
    && initial.current.entriesDigest === entriesDigest(observedCurrent.entries)
    && initial.indexHash === indexHash
    && initial.before.treeIdentity === treeIdentity;
  return { matches, coverage, indexHash, observedCurrent, treeIdentity };
}

function directoryCanAffectScope(relative, scopeRoots) {
  if (!relative) return true;
  return scopeRoots.some((scope) => scope === "" || scope === relative || scope.startsWith(`${relative}/`) || relative.startsWith(`${scope}/`));
}

async function walkFilesystem(root, relative = "", output = [], { limits, coverage, deadline, scopeRoots }) {
  deadline.assertWorkAvailable();
  if (!directoryCanAffectScope(relative, scopeRoots)) return output;
  if (output.length >= limits.maxFiles) {
    coverage.counts.omitted += 1;
    markIncomplete(coverage, "file-count-limit");
    return output;
  }
  let children;
  try {
    children = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    markIncomplete(coverage, "directory-unreadable", relative || null);
    return output;
  }
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    deadline.assertWorkAvailable();
    const childRelative = relative ? `${relative}/${child.name}` : child.name;
    if (childRelative === ".git" || childRelative.startsWith(".git/")) continue;
    const filename = absoluteWorktreePath(root, childRelative);
    const safe = await canonicalPathIsContained(root, filename).catch(() => false);
    if (!safe || child.isSymbolicLink()) {
      markIncomplete(coverage, "unsafe-path", childRelative);
      exclude(coverage, "symlink");
      continue;
    }
    if (child.isDirectory()) {
      await walkFilesystem(root, childRelative, output, { limits, coverage, deadline, scopeRoots });
    } else if (child.isFile()) {
      if (output.length >= limits.maxFiles) {
        coverage.counts.omitted += 1;
        markIncomplete(coverage, "file-count-limit", childRelative);
        return output;
      }
      output.push({ mode: "100644", rawPath: Buffer.from(childRelative, "utf8"), type: "blob", objectId: null });
    } else {
      exclude(coverage, "special-file");
    }
  }
  return output;
}

async function captureFilesystemSnapshot({ root, scopeRoots, classificationOptions, limits, deadline, sourceBudget, coverage, retain = true }) {
  const raw = await walkFilesystem(root, "", [], { limits, coverage, deadline, scopeRoots });
  const candidates = prepareCandidates(raw, { scopeRoots, coverage, type: "git" }).map((candidate) => ({ ...candidate, classificationOptions }));
  const ignoreSources = [];
  let transientIgnoreBytes = 0;
  for (const candidate of candidates.filter((entry) => isIgnoreFile(entry.path))) {
    const read = await readStableFile(root, candidate.path, { limits, deadline, retainedBudget: sourceBudget, retain });
    if (read.status === "ok") {
      transientIgnoreBytes += read.bytes.length;
      if (!retain && transientIgnoreBytes > limits.maxRetainedBytes) {
        markIncomplete(coverage, "ignore-input-limit", candidate.path);
        break;
      }
      ignoreSources.push({ path: candidate.path, bytes: read.bytes, sha256: read.sha256 });
    } else recordReadFailure(coverage, read, candidate.path);
  }
  const nonGitInfoExclude = { path: "info/exclude", bytes: Buffer.alloc(0), sha256: hashBytes(Buffer.alloc(0)) };
  const ignoreIdentity = ignorePolicyIdentity(nonGitInfoExclude, ignoreSources);
  if (ignoreSources.length > 0) markIncomplete(coverage, "non-git-ignore-semantics-unavailable");
  if (retain) for (const source of ignoreSources) sourceBudget.release(source.bytes.length);
  const entries = new Map();
  for (const candidate of candidates) {
    if (!pathIsInScope(candidate.path, scopeRoots)) {
      exclude(coverage, "outside-scope");
      continue;
    }
    const classification = classifyPath(candidate.path, classificationOptions);
    if (!classification.included) {
      exclude(coverage, classification.reason);
      continue;
    }
    if (entries.size >= limits.maxFiles) {
      markIncomplete(coverage, "file-count-limit", candidate.path);
      break;
    }
    const read = await readStableFile(root, candidate.path, { limits, deadline, retainedBudget: sourceBudget, retain });
    if (read.status !== "ok") {
      recordReadFailure(coverage, read, candidate.path);
      continue;
    }
    if (read.bytes.includes(0)) {
      if (retain) sourceBudget.release(read.reserved);
      exclude(coverage, "binary");
      continue;
    }
    const entry = entryFromBytes(candidate, read.bytes, "filesystem");
    if (!retain) delete entry.bytes;
    entries.set(candidate.key, entry);
  }
  return { entries, ignoreIdentity, filesystemIdentity: entriesDigest(entries) };
}

function collectionCompatibility({ limits, scopeRoots, classificationOptions, includeUntracked, git = false, ignorePolicyIdentity = null }) {
  return {
    version: "collection-compatibility-v2",
    scopeRoots,
    includeUntracked: Boolean(includeUntracked),
    untrackedDiscovery: git ? {
      version: "scoped-untracked-discovery-v1",
      scopePathspecs: includeUntracked ? "literal-top-roots-v1" : "ignore-inputs-only-v1",
      safetyExclusions: "canonical-classification-pathspecs-v1",
      unenumeratedSafetyExcludedCount: "unknown",
      unenumeratedOutOfScopeCount: "unknown",
    } : { version: "filesystem-walk-v1" },
    pathEncoding: "strict-utf8-repository-relative-v1",
    capture: "descriptor-check-reenumerate-rehash-once-v2",
    ignores: git ? "frozen-scanner-owned-git-check-ignore-v1" : "non-git-ignore-semantics-partial-v1",
    ignorePolicyIdentity,
    classification: classificationCompatibility(classificationOptions),
    git: git ? gitCompatibility() : { version: "non-git-filesystem-v1" },
    limits: {
      deadlineMs: limits.deadlineMs,
      cleanupReserveMs: limits.cleanupReserveMs,
      maxFiles: limits.maxFiles,
      maxRetainedBytes: limits.maxRetainedBytes,
      maxFileBytes: limits.maxFileBytes,
      maxAnalyzerOutputBytes: limits.maxAnalyzerOutputBytes,
      maxStderrBytes: limits.maxStderrBytes,
      maxDivergenceExamples: limits.maxDivergenceExamples,
      analyzerConcurrency: limits.analyzerConcurrency,
      analyzerRetries: limits.analyzerRetries,
      captureRetries: limits.captureRetries,
      maxGitProcesses: limits.maxGitProcesses,
      maxSubprocesses: limits.maxSubprocesses,
      processTimeoutMs: limits.processTimeoutMs,
    },
  };
}

function aggregateCoverage(before, current, status = null) {
  const complete = before.coverage.complete && current.coverage.complete;
  return Object.freeze({
    status: status ?? (complete ? "complete" : "partial"),
    complete: complete && status !== "inconsistent",
    before: before.coverage,
    current: current.coverage,
  });
}

/** Returns only report-safe snapshot data; frozen source bytes stay in a WeakMap. */
export function snapshotReportProjection(snapshot) {
  if (!SNAPSHOT_STATE.has(snapshot)) throw new TypeError("Unknown frozen snapshot.");
  return {
    kind: snapshot.kind,
    manifestDigest: snapshot.manifestDigest,
    files: snapshot.files,
    ignoreIdentity: snapshot.ignoreIdentity,
    captureIdentity: snapshot.captureIdentity,
    coverage: snapshot.coverage,
  };
}

/** W2-only seam for frozen bytes. This is never a report projection. */
export function getFrozenEntries(snapshot) {
  const state = SNAPSHOT_STATE.get(snapshot);
  if (!state) throw new TypeError("Unknown frozen snapshot.");
  return state.entries;
}

function mergeLimits(options, budget) {
  const supplied = { ...(options.limits ?? {}), ...(budget?.limits ?? {}) };
  const limits = { ...DEFAULT_LIMITS, ...supplied };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || (key === "analyzerRetries" ? value < 0 : value <= 0)) {
      throw new TypeError(`Invalid limit: ${key}`);
    }
  }
  if (limits.cleanupReserveMs >= limits.deadlineMs) throw new TypeError("cleanupReserveMs must be smaller than deadlineMs.");
  if (limits.maxGitProcesses > limits.maxSubprocesses) throw new TypeError("maxGitProcesses cannot exceed maxSubprocesses.");
  if (limits.analyzerConcurrency !== 1 || limits.analyzerRetries !== 0 || limits.captureRetries !== 1) {
    throw new TypeError("Analyzer and capture retry limits are fixed by the scanner contract.");
  }
  return limits;
}

function buildBudget(options, budget) {
  const limits = mergeLimits(options, budget);
  return {
    limits,
    deadline: budget?.deadline ?? new ScanDeadline(limits),
    tracker: budget?.tracker ?? new SubprocessTracker(limits),
    signal: budget?.signal ?? options.signal ?? null,
  };
}

async function collectNonGit(options, execution, tempRoot) {
  const { limits, deadline } = execution;
  let finalAttempt = null;
  let consistent = false;
  let captureAttempts = 0;
  for (let attempt = 0; attempt <= limits.captureRetries; attempt += 1) {
    captureAttempts = attempt + 1;
    const coverage = createCoverage(limits);
    const retained = new RetainedSourceBudget(limits.maxRetainedBytes);
    const captured = await captureFilesystemSnapshot({
      root: path.resolve(options.cwd),
      scopeRoots: options.scopeRoots,
      classificationOptions: options.classification,
      limits,
      deadline,
      sourceBudget: retained,
      coverage,
    });
    const current = snapshotFromEntries({
      kind: "filesystem-current",
      entries: captured.entries,
      coverage,
      ignoreIdentity: captured.ignoreIdentity,
      captureIdentity: captured.filesystemIdentity,
    });
    const observedCoverage = createCoverage(limits);
    const observed = await captureFilesystemSnapshot({
      root: path.resolve(options.cwd),
      scopeRoots: options.scopeRoots,
      classificationOptions: options.classification,
      limits,
      deadline,
      sourceBudget: null,
      coverage: observedCoverage,
      retain: false,
    });
    const observedManifest = digest([...observed.entries.values()].map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      category: entry.category,
      language: entry.language,
      classificationRule: entry.classificationRule,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
      captureSource: entry.captureSource,
    })).sort((left, right) => left.path.localeCompare(right.path)));
    consistent = current.manifestDigest === observedManifest && current.ignoreIdentity === observed.ignoreIdentity;
    finalAttempt = { current, observedCoverage };
    if (consistent || attempt === limits.captureRetries || deadline.workRemainingMs() <= 0) break;
    markDivergence(coverage, "capture-reverification-mismatch");
  }
  const finalCoverage = aggregateCoverage(emptySnapshot("none", createCoverage(limits)), finalAttempt.current, consistent ? null : "inconsistent");
  const result = {
    before: null,
    current: finalAttempt.current,
    lineChanges: null,
    renameRecords: [],
    collectionCompatibility: collectionCompatibility({ limits, scopeRoots: options.scopeRoots, classificationOptions: options.classification, includeUntracked: false, git: false, ignorePolicyIdentity: finalAttempt.current.ignoreIdentity }),
    provenance: { source: "filesystem-current-only", git: null, captureAttempts, processCounts: execution.tracker.report() },
    coverage: finalCoverage,
    consistent,
    dispose: async () => fs.rm(tempRoot, { recursive: true, force: true }),
  };
  COLLECTION_STATE.set(result, { tempRoot, disposed: false, repositoryRoot: await fs.realpath(path.resolve(options.cwd)) });
  return result;
}

/**
 * Collects Git comparison inputs (or a current-only filesystem snapshot) without
 * exposing a reviewed-worktree path or source bytes in report-ready values.
 */
export async function collectGitInputs(options = {}, budget = {}) {
  const normalizedOptions = {
    cwd: path.resolve(options.cwd ?? process.cwd()),
    base: options.base ?? null,
    includeUntracked: Boolean(options.includeUntracked),
    scopeRoots: normalizeScopeRoots(options.scopeRoots),
    classification: { overrides: options.classification?.overrides ?? [] },
    gitExecutable: options.gitExecutable,
    signal: options.signal ?? null,
    limits: options.limits ?? {},
  };
  const execution = buildBudget(normalizedOptions, budget);
  const tempRoot = await createScannerTempRoot();
  const emptyConfigPath = path.join(tempRoot, "empty-git-config");
  await fs.writeFile(emptyConfigPath, "", { flag: "wx", mode: 0o600 });

  let git;
  let repository;
  try {
    git = await GitClient.create({
      cwd: normalizedOptions.cwd,
      checkoutRoot: normalizedOptions.cwd,
      gitExecutable: normalizedOptions.gitExecutable,
      emptyConfigPath,
      deadline: execution.deadline,
      tracker: execution.tracker,
      limits: execution.limits,
      signal: execution.signal,
    });
    repository = await git.tryRepositoryInfo(normalizedOptions.base);
  } catch (error) {
    if (normalizedOptions.base) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      throw error;
    }
    return collectNonGit(normalizedOptions, execution, tempRoot);
  }
  if (!repository) {
    if (normalizedOptions.base) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      throw new CommandFailure("git", null, "repository-unavailable");
    }
    return collectNonGit(normalizedOptions, execution, tempRoot);
  }

  try {
    await git.setRepositoryRoot(repository.root);
    const version = await git.getVersion();
    const baseCommit = repository.baseCommit;
    const ignoreWorkspace = {
      root: path.join(tempRoot, "frozen-ignore-workspace"),
      template: path.join(tempRoot, "empty-git-template"),
      initialized: false,
    };
    let finalAttempt = null;
    let inconsistent = false;
    let captureAttempts = 0;
    for (let attempt = 0; attempt <= execution.limits.captureRetries; attempt += 1) {
      captureAttempts = attempt + 1;
      const beforeCoverage = createCoverage(execution.limits);
      const currentCoverage = createCoverage(execution.limits);
      const retained = new RetainedSourceBudget(execution.limits.maxRetainedBytes);
      const indexHash = await sha256File(repository.indexPath, { deadline: execution.deadline, maxBytes: execution.limits.maxRetainedBytes }).catch(() => null);
      if (!indexHash) markIncomplete(currentCoverage, "index-unavailable");
      const infoExcludeRead = await readOptionalOwnedFile(repository.infoExcludePath, { limits: execution.limits, deadline: execution.deadline });
      if (infoExcludeRead.status !== "ok" && infoExcludeRead.status !== "missing") markIncomplete(currentCoverage, "ignore-input-unavailable");
      const infoExclude = { path: "info/exclude", bytes: infoExcludeRead.bytes ?? Buffer.alloc(0), sha256: infoExcludeRead.sha256 ?? hashBytes(Buffer.alloc(0)) };
      const beforePrepared = baseCommit
        ? (() => {
          const treePromise = git.listTree(baseCommit);
          return treePromise.then((tree) => ({
            tree,
            candidates: prepareCandidates(tree, { scopeRoots: normalizedOptions.scopeRoots, coverage: beforeCoverage, type: "git" }).map((candidate) => ({ ...candidate, classificationOptions: normalizedOptions.classification })),
          }));
        })()
        : null;
      const preparedBase = beforePrepared ? await beforePrepared : null;
      const currentCaptured = await captureCurrentSnapshot({
        root: repository.root,
        git,
        scopeRoots: normalizedOptions.scopeRoots,
        classificationOptions: normalizedOptions.classification,
        limits: execution.limits,
        deadline: execution.deadline,
        sourceBudget: retained,
        coverage: currentCoverage,
        infoExclude,
        includeUntracked: normalizedOptions.includeUntracked,
        ignoreWorkspace,
        baseCandidates: preparedBase?.candidates ?? [],
      });
      const beforeCaptured = preparedBase
        ? await captureGitSnapshot({
          git,
          prepared: preparedBase,
          scopeRoots: normalizedOptions.scopeRoots,
          classificationOptions: normalizedOptions.classification,
          limits: execution.limits,
          deadline: execution.deadline,
          sourceBudget: retained,
          coverage: beforeCoverage,
          frozenIgnorePolicy: currentCaptured.frozenIgnores,
          signal: execution.signal,
        })
        : { entries: new Map(), ignoreIdentity: null, treeIdentity: null };
      const initial = {
        before: beforeCaptured,
        current: { ...currentCaptured, entriesDigest: entriesDigest(currentCaptured.entries) },
        indexHash,
      };
      const stability = await observeGitStability({
        root: repository.root,
        git,
        commit: baseCommit,
        scopeRoots: normalizedOptions.scopeRoots,
        classificationOptions: normalizedOptions.classification,
        limits: execution.limits,
        deadline: execution.deadline,
        infoExcludePath: repository.infoExcludePath,
        indexPath: repository.indexPath,
        includeUntracked: normalizedOptions.includeUntracked,
        ignoreWorkspace,
        initial,
      });
      finalAttempt = { beforeCoverage, currentCoverage, beforeCaptured, currentCaptured, initial, stability, retained };
      if (stability.matches) break;
      markDivergence(currentCoverage, "capture-reverification-mismatch");
      if (attempt === execution.limits.captureRetries || execution.deadline.workRemainingMs() <= 0) {
        inconsistent = true;
        break;
      }
    }
    const before = baseCommit
      ? snapshotFromEntries({
        kind: "git-base",
        entries: finalAttempt.beforeCaptured.entries,
        coverage: finalAttempt.beforeCoverage,
        ignoreIdentity: finalAttempt.beforeCaptured.ignoreIdentity,
        captureIdentity: finalAttempt.beforeCaptured.treeIdentity,
      })
      : null;
    const current = snapshotFromEntries({
      kind: "git-current",
      entries: finalAttempt.currentCaptured.entries,
      coverage: finalAttempt.currentCoverage,
      ignoreIdentity: finalAttempt.currentCaptured.ignoreIdentity,
      captureIdentity: finalAttempt.initial.current.entriesDigest,
    });
    const renameRecords = before && !inconsistent ? uniqueExactRenames(getFrozenEntries(before), getFrozenEntries(current)) : [];
    const lineChanges = before && !inconsistent && !finalAttempt.currentCaptured.blocked
      ? await computeIsolatedLineChanges({
        git,
        beforeEntries: getFrozenEntries(before),
        currentEntries: getFrozenEntries(current),
        renameRecords,
        tempRoot,
      })
      : null;
    const coverage = before
      ? aggregateCoverage(before, current, inconsistent ? "inconsistent" : null)
      : Object.freeze({ status: inconsistent ? "inconsistent" : current.coverage.status, complete: current.coverage.complete && !inconsistent, before: null, current: current.coverage });
    const result = {
      before,
      current,
      lineChanges,
      renameRecords: Object.freeze(renameRecords.map(({ beforeKey, currentKey, ...record }) => Object.freeze(record))),
      collectionCompatibility: collectionCompatibility({
        limits: execution.limits,
        scopeRoots: normalizedOptions.scopeRoots,
        classificationOptions: normalizedOptions.classification,
        includeUntracked: normalizedOptions.includeUntracked,
        git: true,
        ignorePolicyIdentity: current.ignoreIdentity,
      }),
      provenance: Object.freeze({
        source: "git",
        gitVersion: version,
        baselineCommit: baseCommit,
        gitPolicy: gitCompatibility(),
        captureAttempts,
        untrackedDiscovery: finalAttempt.currentCaptured.untrackedDiscovery ?? null,
        processCounts: execution.tracker.report(),
      }),
      coverage,
      dispose: async () => fs.rm(tempRoot, { recursive: true, force: true }),
    };
    COLLECTION_STATE.set(result, { tempRoot, disposed: false, repositoryRoot: await fs.realpath(repository.root) });
    return result;
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Internal execution-only root accessor. It never appears in report projections. */
export function getCollectionRootForOutput(collection) {
  const state = COLLECTION_STATE.get(collection);
  if (!state?.repositoryRoot) throw new TypeError("Unknown collection result.");
  return state.repositoryRoot;
}

/**
 * Copies selected retained buffers to scanner-owned safe names for an analyzer.
 * Returned absolute paths are private execution inputs and must never be saved.
 */
export async function materializeAnalyzerWorkspace(snapshot, selection = null, budget = {}) {
  const state = SNAPSHOT_STATE.get(snapshot);
  if (!state) throw new TypeError("Unknown frozen snapshot.");
  const deadline = budget.deadline ?? new ScanDeadline(budget.limits ?? {});
  const selectedEntries = selection === null
    ? [...state.entries.values()]
    : [...selection].map((item) => typeof item === "string"
      ? [...state.entries.values()].find((entry) => entry.path === item)
      : item).filter(Boolean);
  if (selectedEntries.some((entry) => !state.entries.get(entry.key) || !Buffer.isBuffer(entry.bytes))) {
    throw new TypeError("Analyzer selection must contain entries from this retained snapshot.");
  }
  const root = await createScannerTempRoot("pi-code-quality-analyzer-");
  const files = [];
  try {
    for (const [index, entry] of selectedEntries.sort((left, right) => left.path.localeCompare(right.path)).entries()) {
      deadline.assertWorkAvailable();
      const extension = path.posix.extname(entry.path).replace(/[^.a-zA-Z0-9]/gu, "");
      const filename = `input-${String(index + 1).padStart(5, "0")}${extension}`;
      const filePath = path.join(root, filename);
      await fs.writeFile(filePath, entry.bytes, { flag: "wx", mode: 0o600 });
      files.push(Object.freeze({ filePath, id: filename, entry }));
    }
    let disposed = false;
    return Object.freeze({
      root,
      files: Object.freeze(files),
      verify: async () => {
        if (disposed) return Object.freeze({ valid: false, modified: files.length });
        let modified = 0;
        for (const file of files) {
          const currentHash = await sha256File(file.filePath, { deadline, maxBytes: file.entry.byteLength }).catch(() => null);
          if (currentHash !== file.entry.sha256) modified += 1;
        }
        return Object.freeze({ valid: modified === 0, modified });
      },
      dispose: async () => {
        if (!disposed) {
          disposed = true;
          await fs.rm(root, { recursive: true, force: true });
        }
      },
    });
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

export { CLASSIFICATION_VERSION };
