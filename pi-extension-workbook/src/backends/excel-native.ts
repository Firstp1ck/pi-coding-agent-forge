import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../pi-utils.ts";
import type { WorkbookOperation } from "../contracts.ts";
import { assertSafeFormula, numberToColumn } from "../ooxml/cell-ref.ts";
import { WorkbookError, assertNotAborted, fail } from "../errors.ts";

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_WORKER_PATH = path.join(EXTENSION_ROOT, "workers", "excel-native.ps1");

export type NativeWorkerAction = "probe" | "validate" | "roundtrip" | "edit" | "hang";

export type NativeWorkerControl = {
  workerPid?: number;
  excelPid?: number;
  excelStartTimeUtc?: string;
  owned?: boolean;
};

export type NativeWorkerResult = {
  ok: boolean;
  action: NativeWorkerAction;
  excelVersion?: string;
  excelBuild?: string;
  excelPid?: number;
  ownedExcelProcess?: boolean;
  automationSecurity?: string;
  enableEvents?: boolean;
  updateLinks?: number;
  calculation?: string;
  sourceHashBefore?: string;
  sourceHashAfter?: string;
  outputHash?: string;
  sentinelExecuted?: boolean;
  worksheetCount?: number;
  externalLinkCount?: number;
  connectionCount?: number;
  operations?: Array<{ type: string; sheet: string; target: string }>;
  error?: string;
};

export type NativeWorkerInvocation = {
  action: NativeWorkerAction;
  inputPath?: string;
  outputPath?: string;
  operations?: WorkbookOperation[];
  timeoutMs?: number;
  signal?: AbortSignal;
  workerPath?: string;
};

export type NativeCleanupResult = {
  workerTreeKillAttempted: boolean;
  excelKillAttempted: boolean;
  excelKilled: boolean;
  control?: NativeWorkerControl;
  warnings: string[];
};

export function bounded(value: string, max = 12_000): string {
  return value.length <= max ? value : value.slice(-max);
}

async function readControl(controlPath: string): Promise<NativeWorkerControl | undefined> {
  try {
    return JSON.parse(await fs.readFile(controlPath, "utf8")) as NativeWorkerControl;
  } catch {
    return undefined;
  }
}

export async function stopOwnedExcel(controlPath: string): Promise<{ attempted: boolean; killed: boolean; control?: NativeWorkerControl; warning?: string }> {
  const control = await readControl(controlPath);
  if (!control?.owned || !Number.isInteger(control.excelPid) || !control.excelStartTimeUtc) return { attempted: false, killed: false, control };
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=Get-Process -Id ${control.excelPid} -ErrorAction SilentlyContinue`,
    "if(-not $p){exit 0}",
    `$expected=[DateTime]::Parse('${control.excelStartTimeUtc.replace(/'/g, "''")}').ToUniversalTime()`,
    "if($p.ProcessName -ine 'EXCEL'){exit 4}",
    "if([Math]::Abs(($p.StartTime.ToUniversalTime()-$expected).TotalSeconds) -gt 1){exit 5}",
    `Stop-Process -Id ${control.excelPid} -Force -ErrorAction Stop`,
  ].join("; ");
  const result = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 10_000, maxStdoutChars: 2000, maxStderrChars: 2000 });
  return { attempted: true, killed: result.ok, control, ...(result.ok ? {} : { warning: `Owned Excel cleanup failed: ${result.stderr || result.error || result.exitCode}` }) };
}

export async function cleanupWorker(workerPid: number | undefined, controlPath: string): Promise<NativeCleanupResult> {
  const warnings: string[] = [];
  const excel = await stopOwnedExcel(controlPath);
  if (excel.warning) warnings.push(excel.warning);
  let workerTreeKillAttempted = false;
  if (workerPid && workerPid > 0) {
    workerTreeKillAttempted = true;
    const result = await runCommand("taskkill.exe", ["/PID", String(workerPid), "/T", "/F"], { timeoutMs: 10_000, maxStdoutChars: 2000, maxStderrChars: 2000 });
    if (!result.ok && !/not found|not running|no running instance/i.test(`${result.stdout}\n${result.stderr}\n${result.error ?? ""}`)) warnings.push(`Worker process-tree cleanup failed: ${result.stderr || result.error || result.exitCode}`);
  }
  return { workerTreeKillAttempted, excelKillAttempted: excel.attempted, excelKilled: excel.killed, control: excel.control, warnings };
}

function normalizeNativeOperations(operations: WorkbookOperation[]): WorkbookOperation[] {
  const supported = new Set(["setValue", "setFormula", "clear", "setStyle", "setRowHeight", "setColumnWidth", "merge", "unmerge"]);
  return operations.map((operation) => {
    if (!supported.has(operation.type)) fail("UNSUPPORTED_FEATURE", `Native feasibility worker does not implement ${operation.type}.`);
    if (operation.type === "setFormula") return { ...operation, formula: assertSafeFormula(operation.formula) };
    if (operation.type === "setColumnWidth") {
      return {
        ...operation,
        startColumn: typeof operation.startColumn === "number" ? numberToColumn(operation.startColumn) : operation.startColumn,
        ...(operation.endColumn === undefined ? {} : { endColumn: typeof operation.endColumn === "number" ? numberToColumn(operation.endColumn) : operation.endColumn }),
      };
    }
    return operation;
  });
}

export async function runNativeExcelWorker(invocation: NativeWorkerInvocation): Promise<NativeWorkerResult & { cleanup?: NativeCleanupResult }> {
  if (process.platform !== "win32") fail("BACKEND_UNAVAILABLE", "Native Excel worker requires interactive Windows.");
  assertNotAborted(invocation.signal);
  const workerPath = invocation.workerPath ?? DEFAULT_WORKER_PATH;
  try {
    if (!(await fs.stat(workerPath)).isFile()) fail("BACKEND_UNAVAILABLE", `Native Excel worker is missing: ${workerPath}`);
  } catch (error) {
    if (error instanceof WorkbookError) throw error;
    fail("BACKEND_UNAVAILABLE", `Native Excel worker is missing: ${workerPath}`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbook-native-worker-"));
  const controlPath = path.join(tempDir, "control.json");
  let operationsPath: string | undefined;
  if (invocation.operations) {
    operationsPath = path.join(tempDir, "operations.json");
    await fs.writeFile(operationsPath, `${JSON.stringify(normalizeNativeOperations(invocation.operations), null, 2)}\n`, "utf8");
  }
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", workerPath, "-Action", invocation.action, "-ControlPath", controlPath];
  if (invocation.inputPath) args.push("-InputPath", path.resolve(invocation.inputPath));
  if (invocation.outputPath) args.push("-OutputPath", path.resolve(invocation.outputPath));
  if (operationsPath) args.push("-OperationsPath", operationsPath);

  let cleanup: NativeCleanupResult | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let terminating = false;
      const timeoutMs = invocation.timeoutMs ?? 60_000;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        invocation.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const terminate = async (reason: "abort" | "timeout") => {
        if (terminating || settled) return;
        terminating = true;
        cleanup = await cleanupWorker(child.pid, controlPath);
        finish(() => reject(new WorkbookError(reason === "abort" ? "ABORTED" : "BACKEND_UNAVAILABLE", reason === "abort" ? "Native Excel worker was cancelled." : `Native Excel worker timed out after ${timeoutMs} ms.`, { cleanup })));
      };
      const onAbort = () => { void terminate("abort"); };
      invocation.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => { void terminate("timeout"); }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout = bounded(stdout + String(chunk)); });
      child.stderr.on("data", (chunk) => { stderr = bounded(stderr + String(chunk)); });
      child.on("error", (error) => finish(() => reject(new WorkbookError("BACKEND_UNAVAILABLE", `Cannot start native Excel worker: ${error.message}`))));
      child.on("close", (code) => {
        if (terminating || settled) return;
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
        let payload: NativeWorkerResult | undefined;
        try { if (line) payload = JSON.parse(line) as NativeWorkerResult; } catch { /* handled below */ }
        if (!payload) {
          finish(() => reject(new WorkbookError("BACKEND_UNAVAILABLE", "Native Excel worker returned invalid JSON.", { exitCode: code, stdout: bounded(stdout), stderr: bounded(stderr) })));
          return;
        }
        if (code !== 0 || !payload.ok) {
          finish(() => reject(new WorkbookError("BACKEND_UNAVAILABLE", `Native Excel worker failed: ${payload.error ?? `exit ${code}`}`, { result: payload, stderr: bounded(stderr) })));
          return;
        }
        finish(() => resolve(payload));
      });
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class NativeExcelCandidate {
  async probe(signal?: AbortSignal): Promise<NativeWorkerResult> {
    return runNativeExcelWorker({ action: "probe", signal, timeoutMs: 30_000 });
  }

  async validate(inputPath: string, signal?: AbortSignal): Promise<NativeWorkerResult> {
    return runNativeExcelWorker({ action: "validate", inputPath, signal, timeoutMs: 60_000 });
  }

  async roundTrip(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<NativeWorkerResult> {
    return runNativeExcelWorker({ action: "roundtrip", inputPath, outputPath, signal, timeoutMs: 90_000 });
  }

  async edit(inputPath: string, outputPath: string, operations: WorkbookOperation[], signal?: AbortSignal): Promise<NativeWorkerResult> {
    return runNativeExcelWorker({ action: "edit", inputPath, outputPath, operations, signal, timeoutMs: 90_000 });
  }

  async exerciseTimeout(timeoutMs = 3_000): Promise<never> {
    return runNativeExcelWorker({ action: "hang", timeoutMs }) as Promise<never>;
  }
}
