import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { assessChangedCodeImports, assessCodingChanges, codingChangeIsInScope, ensureCodingReviewCriteria } from "./coding-boundary.ts";
import { computeVerification, receiptFollowsCurrentInstructions } from "./verification-state.ts";
import { isVerificationCommand } from "./verification-suggestions.ts";
import { readEvidencePack } from "./evidence-state.ts";
import { isFreshScopeRead, normalizeScopePath, scopeAuthorityIsCurrent, scopeSessionIsCurrent } from "./scope-state.ts";
import type { CompletionDecision, DependencyEvidence, DependencyEvidenceSourceKind, EvidencePack, ExecutionReceipt, TaskState } from "./types.ts";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_DEPENDENCY_RECORDS = 24;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export type DependencyEvidenceInput = {
  package: string;
  installedVersion: string;
  manifestPath: string;
  lockfilePath?: string;
  sourceKind: DependencyEvidenceSourceKind;
  sourceId: string;
  passageIds: string[];
  featureFlags?: string[];
};

function requireString(value: unknown, field: string, max = 1_024): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function requireExactVersion(value: unknown): string {
  const version = requireString(value, "installedVersion", 128);
  if (!EXACT_VERSION.test(version)) {
    throw new Error("installedVersion must be one exact installed version, not a range, tag, or workspace specifier.");
  }
  return version;
}

function packageName(value: unknown): string {
  const name = requireString(value, "package", 256);
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error("package must be a valid package name.");
  }
  return name;
}

function sourceKind(value: unknown): DependencyEvidenceSourceKind {
  if (value === "installed-source" || value === "installed-types" || value === "official-versioned-docs" || value === "official-tag") return value;
  throw new Error("sourceKind must be installed-source, installed-types, official-versioned-docs, or official-tag.");
}

function uniqueStrings(value: unknown, field: string, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new Error(`${field} must contain one through ${maxItems} strings.`);
  }
  const values = value.map((item, index) => requireString(item, `${field}[${index}]`, maxChars));
  if (new Set(values).size !== values.length) throw new Error(`${field} must not contain duplicates.`);
  return values;
}

/** Parses only the additive record-dependency fields. Source references and files are checked separately. */
export function validateDependencyEvidenceInput(value: unknown): DependencyEvidenceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record-dependency requires an action object.");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["action", "packId", "package", "installedVersion", "manifestPath", "lockfilePath", "sourceKind", "sourceId", "passageIds", "featureFlags"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unsupported record-dependency field '${key}'.`);
  const featureFlags = input.featureFlags === undefined
    ? []
    : Array.isArray(input.featureFlags) && input.featureFlags.length === 0
      ? []
      : uniqueStrings(input.featureFlags, "featureFlags", 12, 160);
  return {
    package: packageName(input.package),
    installedVersion: requireExactVersion(input.installedVersion),
    manifestPath: requireString(input.manifestPath, "manifestPath"),
    lockfilePath: input.lockfilePath === undefined ? undefined : requireString(input.lockfilePath, "lockfilePath"),
    sourceKind: sourceKind(input.sourceKind),
    sourceId: requireString(input.sourceId, "sourceId", 64),
    passageIds: uniqueStrings(input.passageIds, "passageIds", 4, 64),
    featureFlags,
  };
}

function regularWorkspaceFile(state: TaskState, path: string, field: string): string {
  const normalized = normalizeScopePath(state.cwd, path);
  const stat = lstatSync(normalized);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`${field} must be a real regular workspace file no larger than ${MAX_MANIFEST_BYTES} bytes.`);
  }
  return normalized;
}

function readJson(path: string, field: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${field} must be supported JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function selectedSource(pack: EvidencePack, sourceId: string, passageIds: string[]) {
  const source = pack.sources.find((candidate) => candidate.source_id === sourceId);
  if (!source) return undefined;
  const selected = passageIds.map((passageId) => source.passages.find((passage) => passage.passage_id === passageId));
  return selected.every((passage) => passage !== undefined) ? { source, passages: selected } : undefined;
}

function sourceContentHash(pack: EvidencePack, sourceId: string, passageIds: string[]): string | undefined {
  const selected = selectedSource(pack, sourceId, passageIds);
  if (!selected) return undefined;
  return createHash("sha256").update(JSON.stringify({
    pack_id: pack.pack_id,
    source_id: selected.source.source_id,
    source_kind: selected.source.source_kind,
    locator: selected.source.locator,
    passages: selected.passages.map((passage) => ({ id: passage!.passage_id, text: passage!.text, location: passage!.location })),
  })).digest("hex");
}

function receiptForFreshPath(state: TaskState, path: string): ExecutionReceipt | undefined {
  const fresh = state.scope_state.fresh_reads.find((item) => item.path === path && item.full_coverage === true && item.receipt_id);
  if (!fresh || !isFreshScopeRead(state, path)) return undefined;
  const receipt = state.execution_receipts.find((item) => item.id === fresh.receipt_id);
  return receipt?.operation === "read" && receipt.outcome === "success" && receipt.execution_observed && receipt.host_provenance !== "unknown" ? receipt : undefined;
}

type SourceEvidenceStatus = { hash: string; receipt_id?: string; reason?: string };

function exactOfficialLocator(value: string): string | undefined {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Binds docs/types evidence to selected pack bytes and a host observation of that exact source. */
function sourceEvidenceStatus(state: TaskState, pack: EvidencePack, input: DependencyEvidenceInput, installedRoot: string): SourceEvidenceStatus {
  const selected = selectedSource(pack, input.sourceId, input.passageIds);
  const hash = sourceContentHash(pack, input.sourceId, input.passageIds);
  if (!selected || !hash) throw new Error("record-dependency references an unregistered source or passage in the selected evidence pack.");
  const { source, passages } = selected;
  if (input.sourceKind === "installed-source" || input.sourceKind === "installed-types") {
    if (source.source_kind !== "local-file") throw new Error("Installed source/type dependency evidence requires a local-file evidence source.");
    const sourcePath = regularWorkspaceFile(state, source.locator, "dependency source locator");
    const receipt = receiptForFreshPath(state, sourcePath);
    if (!receipt) return { hash, reason: "The selected installed source/type passage lacks a current full, receipt-bound host read." };
    if (!pathWithin(installedRoot, sourcePath) || relative(installedRoot, sourcePath).split(/[\\/]/).includes("node_modules")) {
      throw new Error("Installed source/type evidence locator is outside the selected installed package.");
    }
    if (input.sourceKind === "installed-types" && !/\.(?:d\.ts|ts|tsx)$/i.test(sourcePath)) {
      throw new Error("installed-types evidence must reference a TypeScript declaration or source file.");
    }
    const bytes = readFileSync(sourcePath);
    const observed = receipt.read_targets?.find((target) => target.path === sourcePath && target.full_coverage);
    if (!observed || observed.content_bytes !== bytes.length || observed.content_sha256 !== createHash("sha256").update(bytes).digest("hex")) {
      return { hash, reason: "The selected source bytes changed since their receipt-bound read." };
    }
    if (passages.some((passage) => !bytes.includes(Buffer.from(passage!.text, "utf8")))) {
      throw new Error("Selected installed source passages do not occur in the receipt-bound source bytes.");
    }
    return { hash, receipt_id: receipt.id };
  }
  if (source.source_kind !== "official-doc" && source.source_kind !== "primary") {
    throw new Error("Official dependency documentation requires an official-doc or primary evidence source.");
  }
  const locator = exactOfficialLocator(source.locator);
  if (!locator) throw new Error("Official dependency documentation requires a canonical HTTP(S) source locator.");
  const selectedText = `${source.title}\n${locator}\n${passages.map((passage) => passage!.text).join("\n")}`;
  if (!selectedText.includes(input.installedVersion)) {
    throw new Error(`Official dependency documentation does not identify installed version ${input.installedVersion}.`);
  }
  const receipt = [...state.execution_receipts].reverse().find((candidate) => candidate.operation === "fetch_content"
    && candidate.outcome === "success"
    && candidate.execution_observed
    && candidate.host_provenance !== "unknown"
    && candidate.batch_settled
    && candidate.resource_refs.includes(locator));
  if (!receipt) return { hash, reason: "The selected official documentation lacks a receipt-bound host fetch of its exact locator." };
  return { hash, receipt_id: receipt.id };
}

function packageSpec(manifest: Record<string, unknown>, packageNameValue: string): string | undefined {
  if (manifest.name === packageNameValue && typeof manifest.version === "string") return manifest.version;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
    const entries = manifest[field];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    const value = (entries as Record<string, unknown>)[packageNameValue];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function lockVersion(lock: Record<string, unknown>, packageNameValue: string): string | undefined {
  const packagePath = `node_modules/${packageNameValue}`;
  const packages = lock.packages;
  if (packages && typeof packages === "object" && !Array.isArray(packages)) {
    const entry = (packages as Record<string, unknown>)[packagePath];
    if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).version === "string") {
      return (entry as Record<string, unknown>).version as string;
    }
  }
  const rootDependencies = lock.dependencies;
  if (rootDependencies && typeof rootDependencies === "object" && !Array.isArray(rootDependencies)) {
    const entry = (rootDependencies as Record<string, unknown>)[packageNameValue];
    if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).version === "string") {
      return (entry as Record<string, unknown>).version as string;
    }
  }
  return undefined;
}

type Semver = { major: number; minor: number; patch: number; prerelease?: string };

function parseVersion(value: string): Semver | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] } : undefined;
}

function atLeast(version: Semver, floor: Semver): boolean {
  return version.major > floor.major || version.major === floor.major && (version.minor > floor.minor || version.minor === floor.minor && version.patch >= floor.patch);
}

/** Conservative semver subset: prerelease ranges are unsupported unless exact; 0.x caret upper bounds are narrower. */
export function projectRangeAllows(range: string, version: string): boolean | undefined {
  if (range === version) return true;
  const parsed = parseVersion(version);
  if (!parsed || parsed.prerelease) return undefined;
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (caret) {
    const floor = { major: Number(caret[1]), minor: Number(caret[2]), patch: Number(caret[3]) };
    if (!atLeast(parsed, floor)) return false;
    if (floor.major > 0) return parsed.major === floor.major;
    if (floor.minor > 0) return parsed.major === 0 && parsed.minor === floor.minor;
    return parsed.major === 0 && parsed.minor === 0 && parsed.patch === floor.patch;
  }
  const tilde = /^~(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (tilde) {
    const floor = { major: Number(tilde[1]), minor: Number(tilde[2]), patch: Number(tilde[3]) };
    return atLeast(parsed, floor) && parsed.major === floor.major && parsed.minor === floor.minor;
  }
  return undefined;
}

function evidenceStatus(
  state: TaskState,
  pack: EvidencePack,
  input: DependencyEvidenceInput,
  manifestPath: string,
  lockfilePath: string | undefined,
): Pick<DependencyEvidence, "status" | "reasons" | "manifest_receipt_id" | "lockfile_receipt_id" | "source_content_sha256" | "source_receipt_id"> {
  // Only a direct, non-symlink node_modules installation is supported. A
  // fixture manifest or nested copy is not the dependency resolved from cwd.
  let installedManifestPath: string;
  try {
    installedManifestPath = regularWorkspaceFile(state, resolve(state.cwd, "node_modules", input.package, "package.json"), "installed package manifest");
  } catch {
    return { status: "unknown", reasons: ["The installed package layout is unavailable or unsupported; a real workspace node_modules package is required."] };
  }
  if (manifestPath !== installedManifestPath) {
    return { status: "unknown", reasons: ["manifestPath is not the actual installed package manifest resolved from the workspace."] };
  }
  const source = sourceEvidenceStatus(state, pack, input, dirname(installedManifestPath));
  const manifestReceipt = receiptForFreshPath(state, manifestPath);
  const lockReceipt = lockfilePath ? receiptForFreshPath(state, lockfilePath) : undefined;
  const reasons: string[] = [];
  if (!manifestReceipt) reasons.push("The installed manifest lacks a current full, receipt-bound host read.");
  if (lockfilePath && !lockReceipt) reasons.push("The lockfile lacks a current full, receipt-bound host read. Use a bounded host parser or omit the optional lockfile.");
  if (source.reason) reasons.push(source.reason);
  if (reasons.length) return { status: "unknown", reasons, manifest_receipt_id: manifestReceipt?.id, lockfile_receipt_id: lockReceipt?.id, source_content_sha256: source.hash, source_receipt_id: source.receipt_id };

  const installedManifest = readJson(manifestPath, "manifestPath");
  if (installedManifest.name !== input.package || installedManifest.version !== input.installedVersion) {
    throw new Error(`manifestPath identifies ${String(installedManifest.name)}@${String(installedManifest.version)}, not installed ${input.package}@${input.installedVersion}.`);
  }
  if (lockfilePath) {
    const resolvedVersion = lockVersion(readJson(lockfilePath, "lockfilePath"), input.package);
    if (!resolvedVersion) throw new Error(`lockfilePath has no supported resolved entry for ${input.package}.`);
    if (resolvedVersion !== input.installedVersion) {
      throw new Error(`Installed manifest is ${input.package}@${input.installedVersion} but lockfile resolves ${resolvedVersion}.`);
    }
  }
  const projectManifestPath = resolve(state.cwd, "package.json");
  if (projectManifestPath !== manifestPath) {
    const projectReceipt = receiptForFreshPath(state, projectManifestPath);
    if (!projectReceipt) return { status: "unknown", reasons: ["The project manifest lacks a current full, receipt-bound host read."], manifest_receipt_id: manifestReceipt?.id, lockfile_receipt_id: lockReceipt?.id, source_content_sha256: source.hash, source_receipt_id: source.receipt_id };
    const projectSpec = packageSpec(readJson(projectManifestPath, "project package.json"), input.package);
    if (!projectSpec) return { status: "unknown", reasons: [`Project manifest has no declared dependency entry for ${input.package}.`], manifest_receipt_id: manifestReceipt?.id, lockfile_receipt_id: lockReceipt?.id, source_content_sha256: source.hash, source_receipt_id: source.receipt_id };
    const compatible = projectRangeAllows(projectSpec, input.installedVersion);
    if (compatible !== true) return { status: "unknown", reasons: [compatible === false ? `Project range ${projectSpec} does not allow ${input.installedVersion}.` : `Project range ${projectSpec} is unsupported for deterministic compatibility checking.`], manifest_receipt_id: manifestReceipt?.id, lockfile_receipt_id: lockReceipt?.id, source_content_sha256: source.hash, source_receipt_id: source.receipt_id };
  }
  return { status: "verified", reasons: [], manifest_receipt_id: manifestReceipt?.id, lockfile_receipt_id: lockReceipt?.id, source_content_sha256: source.hash, source_receipt_id: source.receipt_id };
}

/** Builds an immutable dependency association after source references and current host reads are checked. */
export function createDependencyEvidence(
  state: TaskState,
  pack: EvidencePack,
  input: DependencyEvidenceInput,
  recordedAt: string,
): DependencyEvidence {
  if (!selectedSource(pack, input.sourceId, input.passageIds)) {
    throw new Error("record-dependency references an unregistered source or passage in the selected evidence pack.");
  }
  const manifestPath = regularWorkspaceFile(state, input.manifestPath, "manifestPath");
  const lockfilePath = input.lockfilePath ? regularWorkspaceFile(state, input.lockfilePath, "lockfilePath") : undefined;
  const status = evidenceStatus(state, pack, input, manifestPath, lockfilePath);
  return {
    pack_id: pack.pack_id,
    package_name: input.package,
    installed_version: input.installedVersion,
    manifest_path: manifestPath,
    lockfile_path: lockfilePath,
    source_kind: input.sourceKind,
    source_id: input.sourceId,
    passage_ids: input.passageIds,
    feature_flags: input.featureFlags ?? [],
    ...status,
    recorded_at: recordedAt,
  };
}

/** Ensures a dependency record still points to the actual content observed by its receipts. */
export function reassessDependencyEvidence(state: TaskState, evidence: DependencyEvidence): DependencyEvidence {
  const input: DependencyEvidenceInput = {
    package: evidence.package_name,
    installedVersion: evidence.installed_version,
    manifestPath: evidence.manifest_path,
    lockfilePath: evidence.lockfile_path,
    sourceKind: evidence.source_kind,
    sourceId: evidence.source_id,
    passageIds: evidence.passage_ids,
    featureFlags: evidence.feature_flags,
  };
  try {
    const pack = readEvidencePack(state, evidence.pack_id);
    const currentSourceHash = sourceContentHash(pack, evidence.source_id, evidence.passage_ids);
    if (!currentSourceHash || currentSourceHash !== evidence.source_content_sha256) {
      return { ...evidence, status: "unknown", reasons: ["The selected source/passages no longer match this dependency record's hash-bound evidence association."], manifest_receipt_id: undefined, lockfile_receipt_id: undefined, source_receipt_id: undefined };
    }
    const manifestPath = regularWorkspaceFile(state, input.manifestPath, "manifestPath");
    const lockfilePath = input.lockfilePath ? regularWorkspaceFile(state, input.lockfilePath, "lockfilePath") : undefined;
    const status = evidenceStatus(state, pack, input, manifestPath, lockfilePath);
    if (status.source_receipt_id !== evidence.source_receipt_id) {
      return { ...evidence, ...status, status: "unknown", reasons: ["The selected source is no longer backed by its original attributable host receipt."], source_receipt_id: undefined };
    }
    return { ...evidence, ...status };
  } catch (error) {
    return { ...evidence, status: "unknown", reasons: [error instanceof Error ? error.message : String(error)], manifest_receipt_id: undefined, lockfile_receipt_id: undefined, source_receipt_id: undefined };
  }
}

export function replaceDependencyEvidence(state: TaskState, evidence: DependencyEvidence): void {
  const index = state.dependency_evidence.findIndex((item) => item.pack_id === evidence.pack_id && item.package_name === evidence.package_name);
  if (index >= 0) state.dependency_evidence[index] = evidence;
  else state.dependency_evidence.push(evidence);
  if (state.dependency_evidence.length > MAX_DEPENDENCY_RECORDS) {
    throw new Error(`A task can retain at most ${MAX_DEPENDENCY_RECORDS} dependency evidence records.`);
  }
}

function pathWithin(boundary: string, candidate: string): boolean {
  return candidate === boundary || candidate.startsWith(`${boundary}/`) || candidate.startsWith(`${boundary}\\`);
}

/** Coding checks share criterion freshness with final completion; scope commands are obligations, not permissions. */
export function codingValidationCriteria(state: TaskState): string[] {
  return [...new Set(state.trusted_check_mappings.filter((mapping) => mapping.operation === "bash"
    && (!mapping.command || isVerificationCommand(mapping.command)
      || state.scope_state.active_scope?.validation_commands.includes(mapping.command)))
    .map((mapping) => mapping.criterion_id))];
}

function codingValidationReasons(state: TaskState): string[] {
  const commands = state.scope_state.active_scope?.validation_commands ?? [];
  const criterionIds = codingValidationCriteria(state);
  const verification = computeVerification(state).filter((item) => criterionIds.includes(item.criterion_id!));
  const reasons: string[] = [];
  if (!commands.length || !criterionIds.length) reasons.push("Coding validation requires approved validation commands and trusted mapped runtime checks; omitted commands or manual-only attestation cannot certify the current diff.");
  for (const item of verification) {
    if (item.status !== "passed" || item.source !== "runtime") reasons.push(`Coding validation ${item.criterion_id} requires current successful runtime evidence (${item.status}).`);
  }
  for (const command of commands) {
    const mappings = state.trusted_check_mappings.filter((mapping) => mapping.operation === "bash" && (!mapping.command || mapping.command === command));
    const receipt = [...state.execution_receipts].reverse().find((item) => item.operation === "bash" && item.command === command);
    const validationStatus = receipt?.validation_status ?? state.criterion_results.find((result) => result.provenance === "runtime" && result.fresh
      && result.checked_workspace_revision === state.workspace_revision.digest && result.receipt_ids.includes(receipt?.id ?? ""))?.status;
    const session = state.current_session;
    const currentSession = receipt && session.lifecycle_identity !== "unavailable" && (state.task_identity.session_id
      ? session.session_id === state.task_identity.session_id && receipt.session_id === session.session_id
        && typeof receipt.result_is_error === "boolean" && Boolean(receipt.session_anchor_entry_id)
        && session.branch_entry_ids.includes(receipt.session_anchor_entry_id!)
        && (!state.task_identity.session_anchor_entry_id || session.branch_entry_ids.includes(state.task_identity.session_anchor_entry_id))
      : receipt.session_id === undefined);
    if (!mappings.length || !receipt || validationStatus !== "passed" || !currentSession || !receiptFollowsCurrentInstructions(state, receipt)
      || receipt.task_id !== state.task_id || receipt.branch_id !== state.task_identity.branch_id
      || receipt.outcome !== "success" || receipt.exit_code !== 0 || !receipt.execution_observed || receipt.host_provenance !== "pi-builtin-bash"
      || !receipt.batch_settled || receipt.workspace_revision_before !== state.workspace_revision.digest || receipt.workspace_revision_after !== state.workspace_revision.digest
      || !mappings.every((mapping) => receipt.criterion_ids.includes(mapping.criterion_id))) {
      reasons.push(`Coding validation command ${JSON.stringify(command)} lacks a current successful native mapped receipt for this diff.`);
    }
  }
  return reasons;
}

/** Coding completion uses host baseline/current inventories; omitted model metadata never creates an exemption. */
export function evaluateCodingCompletionRequirement(state: TaskState): {
  decision: CompletionDecision;
  reasons: string[];
  evidence_refs: string[];
} | undefined {
  const scope = state.scope_state.active_scope;
  const codingRelevant = state.lane === "coding" || scope?.lane === "coding" || state.modified_files.length > 0 || state.dependency_evidence.length > 0;
  if (!codingRelevant) return undefined;
  const reasons: string[] = codingValidationReasons(state);
  const refs = state.dependency_evidence.map((item) => `${item.pack_id}:${item.package_name}`);
  if (!scope || scope.lane !== "coding") {
    reasons.push("Coding completion requires an active coding scope; absence is not a local-only exemption.");
  } else {
    if (!scopeSessionIsCurrent(state, scope) || !scopeAuthorityIsCurrent(state, scope)) reasons.push("The active coding scope lacks current native task/branch authority.");
    if (state.coding_boundary.status !== "captured") reasons.push(state.coding_boundary.reason ?? "Coding baseline is missing; require explicit user-reviewed recovery.");
    if (!state.coding_boundary.scope_id) reasons.push("Coding baseline is not bound to an approved coding scope.");
  }
  const changes = assessCodingChanges(state);
  if (!changes.complete) reasons.push(...changes.reasons);
  else {
    for (const change of changes.changes) if (!codingChangeIsInScope(state, change)) reasons.push(`Actual changed path ${change.path} is outside the active coding write scope.`);
    const imports = assessChangedCodeImports(state, changes.changes);
    ensureCodingReviewCriteria(state, changes, imports.local_only_paths.length > 0);
    for (const packageNameValue of imports.packages) {
      const evidence = state.dependency_evidence.find((item) => item.package_name === packageNameValue);
      if (!evidence) {
        reasons.push(`Changed code imports external package ${packageNameValue} without required verified dependency evidence.`);
        continue;
      }
      const current = reassessDependencyEvidence(state, evidence);
      if (current.status !== "verified") reasons.push(`Dependency ${packageNameValue}@${evidence.installed_version} remains unverified: ${current.reasons.join(" ")}`);
    }
    const verification = computeVerification(state);
    for (const review of state.coding_boundary.review_dispositions ?? []) {
      if (review.diff_hash !== changes.diff_hash) continue;
      const result = verification.find((item) => item.criterion_id === review.criterion_id);
      if (review.status !== "attested" || result?.status !== "passed" || result.source !== "user") {
        reasons.push(`Host ${review.kind} review requires current native user verification for the exact current diff.`);
      }
    }
  }
  for (const evidence of state.dependency_evidence) {
    const current = reassessDependencyEvidence(state, evidence);
    if (current.status !== "verified") reasons.push(`Dependency ${evidence.package_name}@${evidence.installed_version} remains unverified: ${current.reasons.join(" ")}`);
  }
  if (state.recovery.episodes.some((episode) => episode.attempts >= 3)) reasons.push("A coding repair episode exceeded the two-attempt limit.");
  return reasons.length
    ? { decision: "escalate", reasons: [...new Set(reasons)].slice(0, 24), evidence_refs: refs }
    : { decision: "pass", reasons: ["Actual task diff, active coding scope, dependency evidence, and exact-diff reviews remain current."], evidence_refs: refs };
}

export function dependencyEvidenceFingerprint(evidence: DependencyEvidence): string {
  return createHash("sha256").update(JSON.stringify({
    pack: evidence.pack_id,
    package: evidence.package_name,
    version: evidence.installed_version,
    manifest: evidence.manifest_path,
    lockfile: evidence.lockfile_path,
    source: evidence.source_id,
    passages: evidence.passage_ids,
    source_content_sha256: evidence.source_content_sha256,
    source_receipt_id: evidence.source_receipt_id,
  })).digest("hex");
}

export function isDependencyPathInWorkspace(state: TaskState, value: string): boolean {
  try {
    return normalizeScopePath(state.cwd, value) === resolve(state.cwd, value);
  } catch {
    return false;
  }
}
