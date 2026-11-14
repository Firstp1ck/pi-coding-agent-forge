/**
 * Report rendering and delivery per Pi mode (spec §5.2 "Modes", plan §12
 * Wave 0 evidence). Print mode reroutes extension stdout to stderr and JSON mode
 * reserves stdout for JSONL, so the report never goes to stdout directly.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CheckResult } from "../checks/types.ts";
import { formatPlan } from "./plan.ts";
import type { SetupReport } from "./flow.ts";

/** `customType` of every report message this package sends. */
export const REPORT_CUSTOM_TYPE = "gui-testing";

const OBSERVED_MAX = 120;

function oneLine(text: string, max = OBSERVED_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Plain-text table of check results: status, id, required/optional, observed value. */
export function renderCheckTable(results: readonly CheckResult[]): string {
  if (results.length === 0) return "(no checks ran)";
  const rows = results.map((r) => [r.status, r.id, r.required ? "required" : "optional", oneLine(r.observed)]);
  const header = ["STATUS", "CHECK", "", "OBSERVED"];
  const widths = [0, 1, 2].map((col) => Math.max(header[col].length, ...rows.map((row) => row[col].length)));
  const format = (row: string[]) => row.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell)).join("  ").trimEnd();
  return [format(header), ...rows.map(format)].join("\n");
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** One-line outcome, used for notifications. */
export function summarizeReport(report: SetupReport): string {
  const label = report.kind === "setup" ? "GUI setup" : "GUI doctor";
  return `${label} ${report.backend}: ${report.status} — ${report.message}`;
}

/** Full plain-text report: header, check table, applied fixes, remaining plan items, smoke test, warnings, summary. */
export function renderReport(report: SetupReport): string {
  const sections: string[] = [`${report.kind === "setup" ? "GUI testing setup" : "GUI testing doctor"}: ${report.backend} — ${report.status}`];
  if (report.initialResults) sections.push(`Checks before fixes:\n${renderCheckTable(report.initialResults)}`);
  sections.push(`${report.initialResults ? "Checks after fixes" : "Checks"}:\n${renderCheckTable(report.results)}`);
  if (report.applied.length > 0) {
    sections.push(`Fixes applied:\n${report.applied.map((a) => `- ${a.checkId}: ${a.ok ? "ok" : "failed"} (${oneLine(a.observed)})`).join("\n")}`);
  }
  // Every plan item not applied yet stays visible with its guidance, also after some fixes ran.
  const appliedIds = new Set(report.applied.map((a) => a.checkId));
  const remaining = report.plan?.items.filter((item) => !appliedIds.has(item.checkId)) ?? [];
  if (report.plan && remaining.length > 0) {
    const label =
      report.kind === "doctor" ? "Suggested fixes (doctor never applies them; run /gui-setup)" : report.applied.length > 0 ? "Remaining steps" : "Remediation plan";
    const automated = remaining.filter((i) => i.automated);
    sections.push(
      `${label}:\n${formatPlan({
        items: remaining,
        downloadBytes: automated.reduce((sum, i) => sum + (i.remediation.downloadBytes ?? 0), 0),
        estimatedSeconds: automated.reduce((sum, i) => sum + (i.remediation.estimatedSeconds ?? 0), 0),
        needsSudo: automated.some((i) => i.remediation.needsSudo === true),
      })}`,
    );
  }
  if (report.missingFlags?.length) sections.push(`Missing flags: ${report.missingFlags.join(", ")}`);
  if (report.smoke) sections.push(`Smoke test: ${report.smoke.ok ? "passed" : "failed"} — ${oneLine(report.smoke.observed, 300)}`);
  if (report.degraded.length > 0) sections.push(`Degraded capabilities:\n${report.degraded.map((d) => `- ${d}`).join("\n")}`);
  sections.push(`${report.message} (${seconds(report.durationMs)})`);
  return sections.join("\n\n");
}

/** A rendered report: full text plus a one-line summary for notifications. */
export interface RenderedReport {
  text: string;
  summary?: string;
}

/**
 * Delivers a report the way the current mode allows:
 *
 * - `print`: writes the text to stderr (Pi reroutes extension stdout there anyway).
 * - `json`: sends a displayed custom message; never plain text on stdout.
 * - `tui` / `rpc`: sends a displayed custom message and a one-line notification.
 *
 * When `failed` and there is no UI (print/json), sets `process.exitCode = 1`,
 * because Pi does not turn command failures into an exit code. With a UI the
 * exit code is left alone so a later successful retry in the same session does
 * not end Pi with status 1.
 */
export function emitReport(
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: Pick<ExtensionContext, "mode" | "hasUI" | "ui">,
  report: string | RenderedReport,
  failed: boolean,
): void {
  const { text, summary } = typeof report === "string" ? { text: report, summary: undefined } : report;
  if (ctx.mode === "print") {
    process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  } else {
    pi.sendMessage({ customType: REPORT_CUSTOM_TYPE, content: text, display: true });
    if (ctx.hasUI && ctx.mode !== "json") ctx.ui.notify(summary ?? oneLine(text), failed ? "error" : "info");
  }
  if (failed && !ctx.hasUI) process.exitCode = 1;
}

/** Renders and emits a setup or doctor report; failed unless verified. */
export function emitSetupReport(
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: Pick<ExtensionContext, "mode" | "hasUI" | "ui">,
  report: SetupReport,
): void {
  emitReport(pi, ctx, { text: renderReport(report), summary: summarizeReport(report) }, report.status !== "verified");
}
