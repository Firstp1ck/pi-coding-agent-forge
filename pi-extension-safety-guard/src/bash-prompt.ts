import type { OperationRule } from "./approvals.ts";
import type { CommandTrigger } from "./trigger.ts";
import { displayRiskLabels, escapePromptText, formatPromptCommand, mergePromptTriggers } from "./prompt-format.ts";

export type ApprovalLifetime = "session" | "permanent";
export type BashApprovalScope = "operation" | "operation-rule" | "operation-global";
export type BashChoice = { scope: "command"; lifetime?: undefined } | { scope: BashApprovalScope; lifetime: ApprovalLifetime };
export type PromptOperation = { text: string; risks: string[]; approved: boolean; rule?: OperationRule };
export const BASH_CHOICES = {
  once: "Allow once",
  operationSession: "Allow the command for the current session",
  operationPermanent: "Always allow the command in the current directory",
  operationEverywhere: "Always allow the command EVERYWHERE",
  ruleSession: "Allow operation types this session",
  rulePermanent: "Always allow operation types here",
} as const;
export const GLOBAL_OPERATION_WARNING = "WARNING: Exact pending arguments, permanently EVERYWHERE. Relative paths can target different files; executables/hooks may differ. Skips future prompts/model review.";
const SCOPE_HINTS: Record<BashApprovalScope, string> = {
  operation: "Same program and arguments, also in later supported chains. Pending operations only; existing grants unchanged.",
  "operation-rule": "Broader: eligible argument changes allowed for these operation types. Existing grants unchanged.",
  "operation-global": GLOBAL_OPERATION_WARNING,
};
const SAVED_HINT = "Same cwd; skip future prompts/model review.";

export function bashSelectionHint(choice?: BashChoice): string {
  if (!choice) return "Cancel the entire command; save nothing.";
  if (!choice.lifetime) return "Run the complete command once; save nothing.";
  if (choice.scope === "operation-global") return GLOBAL_OPERATION_WARNING;
  return `${SCOPE_HINTS[choice.scope]} ${SAVED_HINT}`;
}

export function bashSelectionSummary(choices: Map<string, BashChoice>): string {
  const scopes = [...new Set([...choices.values()].flatMap((choice) => choice.lifetime ? [choice.scope] : []))];
  const localScopes = scopes.filter((scope) => scope !== "operation-global");
  return [
    "Block/once save nothing.",
    ...(localScopes.length ? [`Cwd-scoped choices: ${SAVED_HINT}`, ...localScopes.map((scope) => SCOPE_HINTS[scope])] : []),
    ...(scopes.includes("operation-global") ? [GLOBAL_OPERATION_WARNING] : []),
  ].join("\n");
}

export type BashPromptSection = { label: string; body: string; warning?: boolean };
const PREVIEW_MAX = 12_000;

export function buildBashPrompt(command: string, operations: PromptOperation[], fallbackReason?: string, context = "", triggers: CommandTrigger[] = []) {
  const preview = (value: string) => value.length <= PREVIEW_MAX ? value
    : `${value.slice(0, PREVIEW_MAX / 2)}\n... input truncated ...\n${value.slice(-PREVIEW_MAX / 2)}`;
  const pending = operations.filter((operation) => operation.risks.length && !operation.approved);
  const typesAvailable = !fallbackReason && pending.length > 0 && pending.every((operation) => operation.rule);
  const shownTriggers = mergePromptTriggers(command, triggers);
  const hasHighlights = shownTriggers.some((trigger) => trigger.range);
  const showOperations = !fallbackReason && operations.length > 1;
  const risks = displayRiskLabels(pending.flatMap((operation) => operation.risks));
  let sections: BashPromptSection[] = [
    { label: "Command", body: preview(formatPromptCommand(command, shownTriggers)) },
    ...(showOperations ? [{ label: "Operations", body: operations.map((operation, index) => [
      `${index + 1}. ${operation.approved ? "ALREADY APPROVED" : operation.risks.length ? "NEEDS APPROVAL" : "NO MATCHED RISK"}: ${preview(JSON.stringify(operation.text))}`,
      operation.risks.length ? `   Risks: ${displayRiskLabels(operation.risks).join(", ")}` : "",
    ].filter(Boolean).join("\n")).join("\n") }] : risks.length ? [{ label: "Risk", warning: true, body: risks.map(escapePromptText).join("\n") }] : []),
    ...(fallbackReason ? [{
      label: "Whole-command approval required", warning: true, body: escapePromptText(fallbackReason),
    }] : []),
    ...(context && (!hasHighlights || command.length > PREVIEW_MAX) ? [{ label: "Risk excerpts", body: context }] : []),
    ...(typesAvailable ? [{
      label: "Broader operation types", warning: true,
      body: ["Only in this working directory:", ...[...new Set(pending.map((operation) => operation.rule!.description))].map((description) => `- ${description}`)].join("\n"),
    }] : []),
  ];
  const text = sections.map(({ label, body }) => `${label}\n${body}`).join("\n\n");
  const complete = command.length <= PREVIEW_MAX && text.length <= PREVIEW_MAX;
  if (!complete) sections = [
    { label: "Preview truncated", warning: true, body: "Only Block or Allow once. Inspect the original tool input before allowing." },
    { label: "Partial preview", body: `${text.slice(0, PREVIEW_MAX / 2)}\n... preview truncated ...\n${text.slice(-PREVIEW_MAX / 2)}` },
  ];
  const message = sections.map(({ label, body }) => `${label}\n${body}`).join("\n\n");
  const choices = new Map<string, BashChoice>([[BASH_CHOICES.once, { scope: "command" }]]);
  if (complete && !fallbackReason && pending.length) {
    choices.set(BASH_CHOICES.operationSession, { scope: "operation", lifetime: "session" });
    choices.set(BASH_CHOICES.operationPermanent, { scope: "operation", lifetime: "permanent" });
    choices.set(BASH_CHOICES.operationEverywhere, { scope: "operation-global", lifetime: "permanent" });
    if (typesAvailable) {
      choices.set(BASH_CHOICES.ruleSession, { scope: "operation-rule", lifetime: "session" });
      choices.set(BASH_CHOICES.rulePermanent, { scope: "operation-rule", lifetime: "permanent" });
    }
  }
  return { message, sections, choices, command, triggers: shownTriggers };
}

export type BashPrompt = ReturnType<typeof buildBashPrompt>;

export function formatBashPrompt(prompt: BashPrompt, theme: {
  fg: (color: "accent" | "warning" | "success" | "muted" | "text", text: string) => string;
  bold: (text: string) => string;
}): string {
  return prompt.sections.map(({ label, body, warning }) => {
    const heading = theme.fg(warning ? "warning" : "accent", theme.bold(label));
    if (label === "Command") {
      const highlighted = formatPromptCommand(prompt.command, prompt.triggers,
        (text) => theme.fg("warning", theme.bold(text)));
      return `${heading}\n${theme.fg("text", highlighted)}`;
    }
    const lines = body.split("\n").map((line) => {
      const status = /^(\d+\. )(NEEDS APPROVAL|ALREADY APPROVED|NO MATCHED RISK)(.*)$/.exec(line);
      if (status) {
        const tone = status[2] === "NEEDS APPROVAL" ? "warning" : status[2] === "ALREADY APPROVED" ? "success" : "muted";
        return theme.fg("muted", status[1]) + theme.fg(tone, theme.bold(status[2])) + theme.fg("text", status[3]);
      }
      return theme.fg(warning || /^\s*Risks:|^!!!/.test(line) ? "warning" : "text", line);
    });
    return `${heading}\n${lines.join("\n")}`;
  }).join("\n\n");
}
