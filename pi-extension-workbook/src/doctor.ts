import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineCapabilities } from "./contracts.ts";
import { probeAllBackends } from "./backends/probes.ts";
import { isVbaEditingEnabled } from "./vba/settings.ts";

export type WorkbookDoctorReport = {
  ok: boolean;
  runtime: { node: string; nodeSupported: boolean; platform: string; architecture: string; interactiveWindows: boolean };
  dependencies: Array<{ name: string; installed: boolean }>;
  runtimeFiles: Array<{ path: string; present: boolean }>;
  temporaryDirectory: { path: string; writable: boolean; error?: string };
  tiers: Array<{ tier: string; status: "enabled" | "disabled" | "deferred"; formats: string[]; summary: string }>;
  backends: EngineCapabilities[];
};

export async function workbookDoctorReport(ooxml: EngineCapabilities, vbaEnabled = isVbaEditingEnabled()): Promise<WorkbookDoctorReport> {
  const require = createRequire(import.meta.url);
  const dependencies = ["@firstpick/pi-utils", "@xmldom/xmldom", "fflate"].map((name) => {
    try { require.resolve(name); return { name, installed: true }; }
    catch { return { name, installed: false }; }
  });
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const runtimeFiles = await Promise.all(["index.ts", "skills/workbook-editor/SKILL.md", "workers/excel-native.ps1", "workers/excel-vba.ps1", "docs/CAPABILITY-MATRIX.md", "docs/MIGRATION.md"].map(async (relative) => ({ path: relative, present: await fs.stat(path.join(packageRoot, relative)).then((stat) => stat.isFile(), () => false) })));
  const tempPath = os.tmpdir();
  let temporaryDirectory: WorkbookDoctorReport["temporaryDirectory"];
  const probePath = path.join(tempPath, `.pi-workbook-doctor-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(probePath, "probe", { mode: 0o600, flag: "wx" });
    await fs.rm(probePath, { force: true });
    temporaryDirectory = { path: tempPath, writable: true };
  } catch (error) {
    temporaryDirectory = { path: tempPath, writable: false, error: error instanceof Error ? error.message : String(error) };
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const backends = await probeAllBackends(ooxml);
  const report: WorkbookDoctorReport = {
    ok: nodeMajor >= 24 && dependencies.every((dependency) => dependency.installed) && runtimeFiles.every((file) => file.present) && temporaryDirectory.writable && ooxml.edit,
    runtime: { node: process.versions.node, nodeSupported: nodeMajor >= 24, platform: process.platform, architecture: process.arch, interactiveWindows: process.platform === "win32" && Boolean(process.env.USERPROFILE) },
    dependencies,
    runtimeFiles,
    temporaryDirectory,
    tiers: [
      { tier: "Tier 1 — bounded OOXML", status: "enabled", formats: ["xlsx", "xlsm"], summary: "Cross-platform semantic inspection, deterministic previews, and declared surgical edits. Part-adding operations require mutable content types and therefore fail closed for protected XLSM packages." },
      { tier: "Tier 2 — interactive native Excel", status: "disabled", formats: ["xlsx", "xlsm"], summary: "Safety harness exists, but native no-op fidelity failed and public mutation is disabled." },
      { tier: "Tier 2b — VBA module editing (Windows Excel)", status: process.platform === "win32" && vbaEnabled ? "enabled" : "disabled", formats: ["xlsx", "xlsm"], summary: `Platform: ${process.platform}; PI_WORKBOOK_VBA_EDITING/session permission: ${vbaEnabled ? "enabled" : "disabled"}. Requires Windows desktop Excel and File > Options > Trust Center > Trust Center Settings > Macro Settings > Trust access to the VBA project object model. Every commit requires a user dialog; macros never run. Excel behavior is unverified on a real Windows host.` },
      { tier: "Tier 3 — licensed cross-platform high fidelity", status: "deferred", formats: ["xlsx", "xlsm"], summary: "Aspose.Cells licensing and Java/native deployment were intentionally not provisioned." },
    ],
    backends,
  };
  return report;
}

export function formatDoctorReport(report: WorkbookDoctorReport): string {
  const lines = [
    `workbook-doctor: ${report.ok ? "PASS" : "FAIL"}`,
    `Node ${report.runtime.node} (${report.runtime.nodeSupported ? "supported" : "requires >=24"}); ${report.runtime.platform}/${report.runtime.architecture}`,
    `Temporary directory: ${report.temporaryDirectory.writable ? "writable" : "unwritable"} — ${report.temporaryDirectory.path}`,
    `Dependencies: ${report.dependencies.map((item) => `${item.name}=${item.installed ? "ok" : "missing"}`).join(", ")}`,
    `Runtime files: ${report.runtimeFiles.map((item) => `${item.path}=${item.present ? "ok" : "missing"}`).join(", ")}`,
    "Capability tiers:",
    ...report.tiers.map((tier) => `  ${tier.tier}: ${tier.status}; ${tier.summary}`),
    "Backends:",
    ...report.backends.flatMap((backend) => [`  ${backend.engine}: ${backend.available ? "detected" : "unavailable"}; mutation=${backend.edit ? "enabled" : "disabled"}`, ...backend.constraints.map((constraint) => `    ${constraint}`)]),
  ];
  if (report.temporaryDirectory.error) lines.push(`Temporary-directory error: ${report.temporaryDirectory.error}`);
  return lines.join("\n");
}
