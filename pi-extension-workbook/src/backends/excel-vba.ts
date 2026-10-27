import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkbookError, assertNotAborted, fail } from "../errors.ts";
import { bounded, cleanupWorker, stopOwnedExcel } from "./excel-native.ts";
import { VBA_LIMITS, validateVbaOperations, type VbaOperation } from "../vba/limits.ts";
export { VBA_LIMITS, vbaCodeSha256, validateVbaOperations } from "../vba/limits.ts";

const MODULE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,30}(?![\s\S])/;

export type VbaComponentKind = "standard" | "class" | "document" | "form" | "other";
export type VbaModuleInfo = { name: string; kind: VbaComponentKind; lineCount: number; codeSha256: string; code?: string; codeTruncated?: boolean };
export type VbaProjectInfo = { protected: boolean; modules: VbaModuleInfo[] };
export type { VbaOperation } from "../vba/limits.ts";
export type VbaWorkerMeta = { excelVersion: string; excelBuild: string; automationSecurity: "ForceDisable"; sentinelExecuted: false };
export type VbaProbeResult = VbaWorkerMeta & { vbaProjectAccess: boolean; reason?: string };
export type VbaListResult = VbaWorkerMeta & { sourceSha256: string; project: VbaProjectInfo };
export type VbaEditResult = VbaWorkerMeta & {
  sourceSha256Before: string; sourceSha256After: string;
  outputPath: string; outputSha256: string;
  before: VbaProjectInfo; after: VbaProjectInfo;
  operations: Array<{ type: VbaOperation["type"]; name: string; linesBefore: number; linesAfter: number }>;
};
export type VbaListOptions = { includeCode: boolean; modules?: string[]; maxCodeChars: number };
export interface VbaBackend {
  probe(signal?: AbortSignal): Promise<VbaProbeResult>;
  list(inputPath: string, options: VbaListOptions, signal?: AbortSignal): Promise<VbaListResult>;
  edit(inputPath: string, stagedOutputPath: string, operations: VbaOperation[], signal?: AbortSignal): Promise<VbaEditResult>;
}
const HASH = /^[a-f0-9]{64}$/;
const WORKER_PATH = fileURLToPath(new URL("../../workers/excel-vba.ps1", import.meta.url));
const MAX_STDOUT_CHARS = 4 * 1024 * 1024;

function assertWindows(): void {
  if (process.platform !== "win32") fail("BACKEND_UNAVAILABLE", "VBA editing requires interactive Windows with desktop Excel.");
}

function validateProject(value: unknown): asserts value is VbaProjectInfo {
  const project = value as VbaProjectInfo | undefined;
  if (!project || typeof project.protected !== "boolean" || !Array.isArray(project.modules)) fail("VALIDATION_FAILED", "Invalid VBA project worker result.");
  const names = new Set<string>();
  for (const module of project.modules) {
    if (!module || typeof module.name !== "string" || !module.name || names.has(module.name.toLowerCase()) || !["standard", "class", "document", "form", "other"].includes(module.kind) || !Number.isSafeInteger(module.lineCount) || module.lineCount < 0 || !HASH.test(module.codeSha256) || (module.code !== undefined && typeof module.code !== "string") || (module.codeTruncated !== undefined && typeof module.codeTruncated !== "boolean")) fail("VALIDATION_FAILED", "Invalid VBA module worker result.");
    names.add(module.name.toLowerCase());
  }
}

async function sha256File(inputPath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(inputPath)).digest("hex");
}

export function createExcelVbaBackend(options: { workerPath?: string; timeoutMs?: number } = {}): VbaBackend {
  async function invoke<T extends VbaWorkerMeta>(action: "probe" | "list" | "edit", inputPath?: string, outputPath?: string, request?: VbaOperation[] | VbaListOptions, signal?: AbortSignal): Promise<T> {
    assertWindows();
    assertNotAborted(signal);
    const timeoutMs = options.timeoutMs ?? (action === "edit" ? 120_000 : action === "list" ? 60_000 : 30_000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) fail("INVALID_ARGUMENT", "Invalid VBA worker timeout.");
    const workerPath = options.workerPath ?? WORKER_PATH;
    if (!(await fs.stat(workerPath).catch(() => undefined))?.isFile()) fail("BACKEND_UNAVAILABLE", `VBA worker is missing: ${workerPath}`);
    const sourceSha256 = inputPath ? await sha256File(inputPath) : undefined;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbook-vba-worker-"));
    const controlPath = path.join(tempDir, "control.json");
    try {
      const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", workerPath, "-Action", action, "-ControlPath", controlPath];
      if (inputPath) args.push("-InputPath", path.resolve(inputPath), "-ExpectedSha256", sourceSha256!);
      if (outputPath) args.push("-OutputPath", path.resolve(outputPath));
      if (request) {
        const requestPath = path.join(tempDir, "request.json");
        await fs.writeFile(requestPath, JSON.stringify(request), "utf8");
        args.push(action === "edit" ? "-OperationsPath" : "-OptionsPath", requestPath);
      }
      assertNotAborted(signal);
      const payload = await new Promise<T>((resolve, reject) => {
        const child = spawn("powershell.exe", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        let stdout = "";
        let stderr = "";
        let settled = false;
        let terminating = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          callback();
        };
        const terminate = async (code: "ABORTED" | "BACKEND_UNAVAILABLE" | "LIMIT_EXCEEDED", message: string) => {
          if (terminating || settled) return;
          terminating = true;
          try {
            const cleanup = await cleanupWorker(child.pid, controlPath);
            finish(() => reject(new WorkbookError(code, message, { cleanup })));
          } catch (error) {
            child.kill();
            finish(() => reject(new WorkbookError(code, message, { cleanupError: String(error) })));
          }
        };
        const onAbort = () => { void terminate("ABORTED", "VBA worker was cancelled."); };
        const timer = setTimeout(() => { void terminate("BACKEND_UNAVAILABLE", `VBA worker timed out after ${timeoutMs} ms.`); }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        child.stdout.on("data", (chunk) => {
          if (stdout.length + String(chunk).length > MAX_STDOUT_CHARS) { void terminate("LIMIT_EXCEEDED", "VBA worker output exceeded 4 Mi characters."); return; }
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => { stderr = bounded(stderr + String(chunk)); });
        child.on("error", (error) => finish(() => reject(new WorkbookError("BACKEND_UNAVAILABLE", `Cannot start VBA worker: ${error.message}`))));
        child.on("close", (exitCode) => {
          if (terminating || settled) return;
          void (async () => {
            try {
              const cleanup = await stopOwnedExcel(controlPath);
              if (cleanup.warning) fail("BACKEND_UNAVAILABLE", cleanup.warning);
              const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
              let result: Record<string, unknown>;
              try { result = JSON.parse(line ?? ""); } catch { fail("BACKEND_UNAVAILABLE", "VBA worker returned invalid JSON.", { exitCode, stderr }); }
              if (!result || typeof result !== "object") fail("BACKEND_UNAVAILABLE", "VBA worker returned invalid JSON.");
              if (exitCode !== 0 || result.ok !== true) {
                const codes = ["BACKEND_UNAVAILABLE", "INVALID_ARGUMENT", "UNSUPPORTED_FEATURE", "LIMIT_EXCEEDED", "ABORTED", "VALIDATION_FAILED", "CONFLICT", "OUTPUT_EXISTS"] as const;
                const code = codes.find((value) => value === result.code) ?? "BACKEND_UNAVAILABLE";
                fail(code, `VBA worker failed: ${String(result.error ?? `exit ${exitCode}`)}`, { stderr });
              }
              if (result.automationSecurity !== "ForceDisable" || result.sentinelExecuted !== false || typeof result.excelVersion !== "string" || typeof result.excelBuild !== "string") fail("VALIDATION_FAILED", "VBA worker safety metadata is invalid.");
              if (!terminating) finish(() => resolve(result as T));
            } catch (error) { if (!terminating) finish(() => reject(error)); }
          })();
        });
      });
      assertNotAborted(signal);
      if (inputPath && await sha256File(inputPath) !== sourceSha256) fail("CONFLICT", "VBA worker source changed during execution.");
      if (action === "probe") {
        if (typeof (payload as unknown as VbaProbeResult).vbaProjectAccess !== "boolean") fail("VALIDATION_FAILED", "Invalid VBA probe result.");
      } else if (action === "list") {
        const listed = payload as unknown as VbaListResult;
        if (listed.sourceSha256 !== sourceSha256) fail("CONFLICT", "VBA list source hash mismatch.");
        validateProject(listed.project);
      } else {
        const edited = payload as unknown as VbaEditResult;
        if (edited.sourceSha256Before !== sourceSha256 || edited.sourceSha256After !== sourceSha256) fail("CONFLICT", "VBA edit source hash mismatch.");
        if (edited.outputPath !== path.resolve(outputPath!) || !HASH.test(edited.outputSha256) || await sha256File(outputPath!) !== edited.outputSha256 || !Array.isArray(edited.operations)) fail("VALIDATION_FAILED", "Invalid VBA output worker result.");
        validateProject(edited.before);
        validateProject(edited.after);
      }
      return payload;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return {
    probe: (signal) => invoke<VbaProbeResult>("probe", undefined, undefined, undefined, signal),
    async list(inputPath, listOptions, signal) {
      assertWindows();
      if (!listOptions || typeof listOptions.includeCode !== "boolean" || !Number.isSafeInteger(listOptions.maxCodeChars) || listOptions.maxCodeChars < 0 || listOptions.maxCodeChars > VBA_LIMITS.maxReadCodeChars || (listOptions.modules !== undefined && (!Array.isArray(listOptions.modules) || listOptions.modules.some((name) => typeof name !== "string" || !MODULE_NAME.test(name))))) fail("INVALID_ARGUMENT", "Invalid VBA list options.");
      return invoke<VbaListResult>("list", inputPath, undefined, listOptions, signal);
    },
    async edit(inputPath, stagedOutputPath, operations, signal) {
      assertWindows();
      assertNotAborted(signal);
      if (![".xlsx", ".xlsm"].includes(path.extname(inputPath).toLowerCase()) || path.extname(stagedOutputPath).toLowerCase() !== ".xlsm" || path.resolve(inputPath).toLowerCase() === path.resolve(stagedOutputPath).toLowerCase()) fail("INVALID_ARGUMENT", "VBA edits require a distinct .xlsm output and an .xlsx/.xlsm source.");
      if (await fs.lstat(stagedOutputPath).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) fail("OUTPUT_EXISTS", "VBA staged output already exists.");
      return invoke<VbaEditResult>("edit", inputPath, stagedOutputPath, validateVbaOperations(operations), signal);
    },
  };
}
