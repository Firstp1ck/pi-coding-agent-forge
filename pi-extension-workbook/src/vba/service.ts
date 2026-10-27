import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { samePath } from "@firstpick/pi-utils/paths";
import { syncDirectory, syncFile } from "@firstpick/pi-utils/filesystem";
import type { VbaBackend, VbaModuleInfo, VbaProjectInfo, VbaWorkerMeta } from "../backends/excel-vba.ts";
import { VBA_LIMITS, validateVbaOperations, vbaCodeSha256, type VbaOperation } from "./limits.ts";
import { preflightVbaPackage } from "./preflight.ts";
import type { WorkbookVbaEditRequest, WorkbookVbaReadRequest } from "../contracts.ts";
import { sha256Bytes, sha256File } from "../core/hash.ts";
import { canonicalWorkbookOutputPath, requireWorkbookFile } from "../core/paths.ts";
import type { MutationQueue } from "../core/transaction.ts";
import { assertNotAborted, fail } from "../errors.ts";
import { OoxmlPackage } from "../ooxml/package.ts";
import { validatePackage } from "../ooxml/validate.ts";
import { formatSessionEnableMessage, formatVbaApprovalMessage, type VbaPlannedOperation } from "./approval.ts";
import type { VbaSettings } from "./settings.ts";

export type VbaApprover = { hasUI: boolean; confirm(title: string, message: string): Promise<boolean> };
const nameKey = (name: string): string => name.toLowerCase();
const normalizedCode = (code: string): string => code.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
const lineCount = (code: string): number => normalizedCode(code) ? normalizedCode(code).split("\n").length : 0;
function signatureParts(pkg: OoxmlPackage): string[] {
  const parts = new Set([...pkg.archive.entries.keys()].filter((part) => /^xl\/vbaProjectSignature[^/]*\.bin$/i.test(part) || /vbaProjectSignature/i.test(pkg.contentTypeFor(part) ?? "")));
  for (const rel of pkg.relationships) if (/^vbaProjectSignature/i.test(rel.type.split("/").at(-1) ?? "") && rel.resolvedTarget) parts.add(rel.resolvedTarget);
  return [...parts].sort();
}
const relatedPart = (part: string, signatures: Set<string>): boolean => signatures.has(part) || /^(?:xl\/vbaProject\.bin|\[Content_Types\]\.xml|xl\/_rels\/(?:workbook\.xml|vbaProject\.bin)\.rels)$/i.test(part);

function formattingCode(code: string): string {
  const lines = normalizedCode(code).split("\n").map((line) => line.trim().replace(/[ \t]+/g, " ").toLowerCase());
  let start = 0; let end = lines.length;
  while (start < end && lines[start] === "") start++;
  while (end > start && lines[end - 1] === "") end--;
  if (lines[start] === "option explicit") start++;
  while (start < end && lines[start] === "") start++;
  return lines.slice(start, end).join("\n");
}

async function requireAbsent(outputPath: string): Promise<void> {
  try { await fs.lstat(outputPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  fail("OUTPUT_EXISTS", `VBA output must be a new file: ${outputPath}`);
}

function checkMeta(meta: VbaWorkerMeta): void {
  if (meta.automationSecurity !== "ForceDisable" || meta.sentinelExecuted !== false) fail("VALIDATION_FAILED", "VBA backend did not attest macro-disabled execution.");
}

function moduleMap(project: VbaProjectInfo): Map<string, VbaModuleInfo> {
  const result = new Map<string, VbaModuleInfo>();
  for (const module of project.modules) {
    const key = nameKey(module.name);
    if (result.has(key) || !/^[a-f0-9]{64}$/.test(module.codeSha256) || !Number.isInteger(module.lineCount) || module.lineCount < 0) fail("VALIDATION_FAILED", "VBA backend returned an invalid module inventory.");
    result.set(key, module);
  }
  return result;
}

function planOperations(operations: VbaOperation[], project: VbaProjectInfo): VbaPlannedOperation[] {
  if (project.protected) fail("UNSUPPORTED_FEATURE", "The VBA project is locked; password bypass is not supported.");
  const modules = moduleMap(project);
  return operations.map((op) => {
    const current = modules.get(nameKey(op.name));
    if (op.type === "addModule" && current) fail("INVALID_ARGUMENT", `VBA module already exists: ${op.name}`);
    if (op.type !== "addModule" && !current) fail("INVALID_ARGUMENT", `VBA module does not exist: ${op.name}`);
    const kind = op.type === "addModule" ? op.kind : current!.kind;
    if (kind !== "standard" && kind !== "class" && (op.type !== "replaceModuleCode" || kind !== "document")) fail("UNSUPPORTED_FEATURE", `${op.type} is not supported for ${kind} module ${op.name}.`);
    return { type: op.type, name: current?.name ?? op.name, kind, linesBefore: current?.lineCount ?? 0, linesAfter: op.type === "removeModule" ? 0 : lineCount(op.code), ...(op.type !== "removeModule" ? { code: op.code, codeSha256: vbaCodeSha256(op.code) } : {}) };
  });
}

function verifyBefore(expected: VbaProjectInfo, actual: VbaProjectInfo): void {
  if (actual.protected) fail("CONFLICT", "VBA project became locked after approval.");
  const before = moduleMap(expected);
  const after = moduleMap(actual);
  if (before.size !== after.size || [...before].some(([key, module]) => after.get(key)?.codeSha256 !== module.codeSha256 || after.get(key)?.kind !== module.kind || after.get(key)?.lineCount !== module.lineCount)) fail("CONFLICT", "VBA module inventory changed after approval.");
}

function verifyAfter(before: VbaProjectInfo, after: VbaProjectInfo, operations: VbaPlannedOperation[]): string[] {
  if (after.protected) fail("VALIDATION_FAILED", "Saved VBA project cannot be read back.");
  const original = moduleMap(before);
  const saved = moduleMap(after);
  const edited = new Set(operations.map((op) => nameKey(op.name)));
  const warnings: string[] = [];
  for (const op of operations) {
    const module = saved.get(nameKey(op.name));
    if (op.type === "removeModule") {
      if (module) fail("VALIDATION_FAILED", `Removed module is still present: ${op.name}`);
      continue;
    }
    if (!module || module.kind !== op.kind) fail("VALIDATION_FAILED", `Saved VBA module missing or kind changed: ${op.name}`);
    if (typeof module.code !== "string" || module.codeTruncated || vbaCodeSha256(module.code) !== module.codeSha256) fail("VALIDATION_FAILED", `Saved VBA module code is missing, truncated, or inconsistent: ${op.name}`);
    if (module.codeSha256 !== op.codeSha256) {
      if (formattingCode(module.code) !== formattingCode(op.code!)) fail("VALIDATION_FAILED", `Saved code does not match approved code: ${op.name}`);
      warnings.push(`Excel formatting-only difference in ${op.name}: approvedCodeSha256=${op.codeSha256}; storedCodeSha256=${module.codeSha256}.`);
    }
  }
  for (const [key, module] of original) {
    if (!edited.has(key) && (saved.get(key)?.codeSha256 !== module.codeSha256 || saved.get(key)?.kind !== module.kind)) fail("VALIDATION_FAILED", `Untouched module changed or disappeared: ${module.name}`);
  }
  for (const [key, module] of saved) if (!original.has(key) && !edited.has(key)) fail("VALIDATION_FAILED", `Unexpected VBA module appeared: ${module.name}`);
  return warnings;
}

export class VbaService {
  constructor(private readonly cwd: string, private readonly backend: VbaBackend, private readonly queue: MutationQueue, private readonly settings: VbaSettings) {}

  async read(request: WorkbookVbaReadRequest, signal?: AbortSignal) {
    assertNotAborted(signal);
    const sourcePath = await requireWorkbookFile(request.path, this.cwd);
    const maxCodeChars = request.maxCodeChars ?? 20000;
    if (!Number.isInteger(maxCodeChars) || maxCodeChars < 1 || maxCodeChars > VBA_LIMITS.maxReadCodeChars) fail("INVALID_ARGUMENT", `maxCodeChars must be 1–${VBA_LIMITS.maxReadCodeChars}.`);
    if (request.modules && (request.modules.length === 0 || request.modules.length > 1000 || request.modules.some((name) => !/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(name)))) fail("INVALID_ARGUMENT", "Invalid VBA module filter.");
    const sourceBytes = await fs.readFile(sourcePath);
    const sourceSha256 = sha256Bytes(sourceBytes);
    preflightVbaPackage(OoxmlPackage.fromBytes(sourceBytes));
    const result = await this.backend.list(sourcePath, { includeCode: request.includeCode ?? false, modules: request.modules ? [...request.modules] : undefined, maxCodeChars }, signal);
    assertNotAborted(signal);
    checkMeta(result);
    if (result.sourceSha256 !== sourceSha256 || await sha256File(sourcePath) !== sourceSha256) fail("CONFLICT", "Workbook changed while reading VBA modules.");
    moduleMap(result.project);
    return { ...result, sourcePath, macrosExecuted: false as const, sourceIsUntrustedData: true as const };
  }

  async edit(request: WorkbookVbaEditRequest, approver: VbaApprover, signal?: AbortSignal) {
    assertNotAborted(signal);
    const sourcePath = await requireWorkbookFile(request.path, this.cwd);
    if (!/\.(?:xlsx|xlsm)$/i.test(sourcePath)) fail("INVALID_ARGUMENT", "VBA source must be .xlsx or .xlsm.");
    const defaultPath = sourcePath.slice(0, -path.extname(sourcePath).length) + ".vba-edited.xlsm";
    const outputPath = await canonicalWorkbookOutputPath(request.outputPath ?? defaultPath, this.cwd);
    if (samePath(sourcePath, outputPath)) fail("INVALID_ARGUMENT", "VBA output must not be the source workbook.");
    if (path.extname(outputPath).toLowerCase() !== ".xlsm") fail("INVALID_ARGUMENT", "VBA output must end in .xlsm.");
    await requireAbsent(outputPath);
    const sourceSha256 = await sha256File(sourcePath);
    const dryRun = request.dryRun ?? true;
    if ((!dryRun && !request.expectedSha256) || (request.expectedSha256 && request.expectedSha256.toLowerCase() !== sourceSha256)) fail("CONFLICT", "A current expectedSha256 is required for every VBA commit.", { actualSha256: sourceSha256 });
    const operations = validateVbaOperations(request.operations).map((op) => ({ ...op }));
    const baselineBytes = await fs.readFile(sourcePath);
    if (sha256Bytes(baselineBytes) !== sourceSha256) fail("CONFLICT", "Workbook changed while preparing VBA edits.");
    const baseline = OoxmlPackage.fromBytes(baselineBytes);
    preflightVbaPackage(baseline);
    const signaturesBefore = signatureParts(baseline);
    if (signaturesBefore.length && !request.allowSignatureRemoval) fail("UNSUPPORTED_FEATURE", "Signed VBA project editing requires allowSignatureRemoval=true and a user dialog approving signature loss.");
    const listed = await this.backend.list(sourcePath, { includeCode: false, maxCodeChars: 20000 }, signal);
    assertNotAborted(signal);
    checkMeta(listed);
    if (listed.sourceSha256 !== sourceSha256) fail("CONFLICT", "Workbook changed while planning VBA edits.");
    const planned = planOperations(operations, listed.project);
    const plan = { sourcePath, sourceSha256, outputPath, signed: signaturesBefore.length > 0, operations: planned };
    const approvalPreview = formatVbaApprovalMessage(plan);
    const summary = planned.map(({ code: _code, ...op }) => op);
    if (dryRun) return { ...plan, dryRun: true as const, approvalPreview, macrosExecuted: false as const };
    if (!approver.hasUI) fail("AUTHORIZATION_REQUIRED", "VBA edits require a user approval dialog in this tool call; no dialog-capable UI is available.");
    if (!this.settings.isEnabled()) {
      const enabled = await approver.confirm("Enable VBA editing for this session?", formatSessionEnableMessage());
      assertNotAborted(signal);
      if (!enabled) fail("AUTHORIZATION_REQUIRED", "Session VBA editing permission was declined.");
      this.settings.enableSession();
    }
    const approved = await approver.confirm("Approve VBA workbook edits?", approvalPreview);
    assertNotAborted(signal);
    if (!approved) fail("AUTHORIZATION_REQUIRED", "VBA edit approval was declined.");
    const verifySource = async () => {
      if (await sha256File(sourcePath) !== sourceSha256) fail("CONFLICT", "Workbook changed after VBA edit approval.");
    };
    await verifySource();
    return this.queue(outputPath, async () => {
      assertNotAborted(signal);
      await verifySource();
      await requireAbsent(outputPath);
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbook-vba-"));
      let created = false;
      try {
        const stagedPath = path.join(tempDir, "candidate.xlsm");
        const result = await this.backend.edit(sourcePath, stagedPath, operations, signal);
        assertNotAborted(signal);
        checkMeta(result);
        await verifySource();
        if (result.sourceSha256Before !== sourceSha256 || result.sourceSha256After !== sourceSha256) fail("CONFLICT", "VBA backend source hash differs from the approved source.");
        if (!samePath(result.outputPath, stagedPath)) fail("VALIDATION_FAILED", "VBA backend returned an unexpected staged output path.");
        verifyBefore(listed.project, result.before);
        const warnings = verifyAfter(listed.project, result.after, planned);
        if (!(await fs.lstat(stagedPath)).isFile()) fail("VALIDATION_FAILED", "VBA staged output must be a regular file.");
        const bytes = await fs.readFile(stagedPath);
        const outputSha256 = sha256Bytes(bytes);
        if (outputSha256 !== result.outputSha256) fail("VALIDATION_FAILED", "VBA staged output hash differs from backend result.");
        const saved = OoxmlPackage.fromBytes(bytes);
        const validation = validatePackage(saved, stagedPath);
        if (!validation.ok) fail("VALIDATION_FAILED", `Saved VBA workbook failed package validation: ${validation.errors.join("; ")}`);
        const comparison = baseline.compareIntegrity(saved);
        const changedParts = [...new Set([...comparison.changedParts, ...comparison.addedParts, ...comparison.removedParts])].sort();
        const signaturesAfter = signatureParts(saved);
        const signatures = new Set([...signaturesBefore, ...signaturesAfter]);
        const unrelatedChangedParts = changedParts.filter((part) => !relatedPart(part, signatures));
        warnings.push(...validation.warnings, ...unrelatedChangedParts.map((part) => `Excel full save changed unrelated part: ${part}`));
        if (signaturesBefore.length) warnings.push("The original VBA signature was invalidated by editing; any signature parts remaining in the output are not verified as valid.");
        const operationSummary = summary.map((op) => {
          const after = moduleMap(result.after).get(nameKey(op.name));
          return { ...op, linesAfter: after?.lineCount ?? 0, ...(after ? { readBackCodeSha256: after.codeSha256, ...(op.codeSha256 ? { approvedCodeSha256: op.codeSha256, storedCodeSha256: after.codeSha256 } : {}) } : {}) };
        });
        assertNotAborted(signal);
        await verifySource();
        if (await canonicalWorkbookOutputPath(outputPath, this.cwd) !== outputPath) fail("CONFLICT", "Output directory changed after approval.");
        await requireAbsent(outputPath);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        assertNotAborted(signal);
        try { await fs.copyFile(stagedPath, outputPath, fs.constants.COPYFILE_EXCL); created = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("OUTPUT_EXISTS", `VBA destination appeared after approval: ${outputPath}`); throw error; }
        await syncFile(outputPath);
        await syncDirectory(path.dirname(outputPath));
        return { dryRun: false as const, sourcePath, outputPath, sourceSha256, outputSha256, macrosExecuted: false as const, approvedBy: "user-dialog" as const, operations: operationSummary, before: listed.project, after: result.after, changedParts, unrelatedChangedParts, signature: { before: signaturesBefore, after: signaturesAfter, state: signaturesAfter.length ? "present-unverified" : "absent" }, validation, warnings, excelVersion: result.excelVersion, excelBuild: result.excelBuild };
      } catch (error) {
        if (created) await fs.rm(outputPath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }
}
