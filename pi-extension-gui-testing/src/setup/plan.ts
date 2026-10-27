/**
 * Remediation plan (spec §5.2 step 5): all fixable failures in one list, with
 * exact commands, sudo needs, download sizes, and durations, shown before a
 * single confirmation.
 */
import type { CheckResult, Remediation } from "../checks/types.ts";
import { formatGb } from "../checks/common.ts";

export interface PlanItem {
  checkId: string;
  required: boolean;
  remediation: Remediation;
  /**
   * `true` when setup may run it after confirmation or `--fix`. `false` for
   * manual items, items without a command, and sudo items when sudo needs a password.
   */
  automated: boolean;
  /** Why the item is not automated. */
  manualReason?: string;
}

export interface RemediationPlan {
  items: PlanItem[];
  downloadBytes: number;
  estimatedSeconds: number;
  needsSudo: boolean;
}

/**
 * Builds the plan from check results. Includes every result whose own outcome
 * failed and has a remediation (required failures and downgraded optional ones).
 *
 * @param passwordlessSudo Whether `sudo -n` works; when `false`, sudo items are manual.
 */
export function buildRemediationPlan(results: readonly CheckResult[], passwordlessSudo: boolean): RemediationPlan {
  const items: PlanItem[] = [];
  for (const result of results) {
    const remediation = result.remediation;
    if (!remediation || (result.status !== "fail" && result.status !== "warn")) continue;
    let manualReason: string | undefined;
    if (remediation.manual) manualReason = "needs a password or your judgement";
    else if (!remediation.command || remediation.command.length === 0) manualReason = "no command to run";
    else if (remediation.needsSudo && !passwordlessSudo) manualReason = "needs sudo with a password";
    const item: PlanItem = { checkId: result.id, required: result.required, remediation, automated: manualReason === undefined };
    if (manualReason) item.manualReason = manualReason;
    items.push(item);
  }
  return {
    items,
    downloadBytes: items.reduce((sum, i) => sum + (i.automated ? (i.remediation.downloadBytes ?? 0) : 0), 0),
    estimatedSeconds: items.reduce((sum, i) => sum + (i.automated ? (i.remediation.estimatedSeconds ?? 0) : 0), 0),
    needsSudo: items.some((i) => i.automated && i.remediation.needsSudo === true),
  };
}

/** Shell-style rendering of an argv for display only (it is never executed by a shell). */
export function formatCommand(argv: readonly string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

function formatDuration(seconds: number): string {
  return seconds >= 120 ? `~${Math.round(seconds / 60)} min` : `~${Math.round(seconds)} s`;
}

/** Describes one item in one or two lines. */
export function formatPlanItem(item: PlanItem): string {
  const r = item.remediation;
  const extras = [
    r.needsSudo ? "sudo" : undefined,
    r.downloadBytes ? `download ${formatGb(r.downloadBytes)}` : undefined,
    r.estimatedSeconds ? formatDuration(r.estimatedSeconds) : undefined,
  ].filter(Boolean);
  const head = `- ${item.checkId}: ${r.summary}${extras.length ? ` (${extras.join(", ")})` : ""}`;
  if (!r.command?.length) return head;
  return `${head}\n    $ ${formatCommand(r.command)}`;
}

/** Multi-line plan text: automated fixes first, then steps the user must do. */
export function formatPlan(plan: RemediationPlan): string {
  const automated = plan.items.filter((i) => i.automated);
  const manual = plan.items.filter((i) => !i.automated);
  const lines: string[] = [];
  if (automated.length > 0) {
    const totals = [
      plan.downloadBytes ? `download ${formatGb(plan.downloadBytes)}` : undefined,
      plan.estimatedSeconds ? formatDuration(plan.estimatedSeconds) : undefined,
      plan.needsSudo ? "uses sudo" : undefined,
    ].filter(Boolean);
    lines.push(`Fixes setup can apply${totals.length ? ` (${totals.join(", ")})` : ""}:`);
    lines.push(...automated.map(formatPlanItem));
  }
  if (manual.length > 0) {
    lines.push("Steps you need to do yourself:");
    lines.push(...manual.map((i) => `${formatPlanItem(i)}${i.manualReason ? `\n    (${i.manualReason})` : ""}`));
  }
  return lines.join("\n");
}
