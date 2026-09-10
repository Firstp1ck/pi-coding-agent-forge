import type { OperationRule } from "./approvals.ts";

export type ApprovalLifetime = "session" | "permanent";
export type BashApprovalScope = "command" | "operation" | "operation-rule";
export type BashChoice = { scope: BashApprovalScope; lifetime?: ApprovalLifetime };
export type PromptOperation = { text: string; risks: string[]; approved: boolean; rule?: OperationRule };
export const BASH_CHOICES = {
  once: "Allow once",
  commandSession: "Allow this exact command for this session",
  commandPermanent: "Always allow this exact command in this cwd",
  operationSession: "Allow listed exact operations for this session",
  operationPermanent: "Always allow listed exact operations in this cwd",
  ruleSession: "Allow listed operation types for this session",
  rulePermanent: "Always allow listed operation types in this cwd",
} as const;
const PREVIEW_MAX = 12_000;

export function buildBashPrompt(command: string, operations: PromptOperation[], fallbackReason?: string, context = "") {
  const preview = (value: string) => JSON.stringify(value.length <= PREVIEW_MAX ? value
    : `${value.slice(0, PREVIEW_MAX / 2)}\n... input truncated ...\n${value.slice(-PREVIEW_MAX / 2)}`);
  const pending = operations.filter((operation) => operation.risks.length && !operation.approved);
  const typesAvailable = !fallbackReason && pending.length > 0 && pending.every((operation) => operation.rule);
  const text = [
    "Nothing runs unless the complete invocation is approved. Block cancels it without saving new permissions.",
    fallbackReason ? `WHOLE-COMMAND APPROVAL REQUIRED: ${fallbackReason}. Operation permissions do not apply.` : "Supported literal shell commands. Existing permissions keep their original lifetime.",
    ...operations.map((operation, index) => [
      `${index + 1}. ${operation.approved ? "ALREADY APPROVED" : operation.risks.length ? "NEEDS APPROVAL" : "NO MATCHED RISK"}: ${preview(operation.text)}`,
      operation.risks.length ? `   Risks: ${operation.risks.join(", ")}` : "",
    ].filter(Boolean).join("\n")),
    context ? "RISK EXCERPTS: !!! marks a matched line; >>> pattern <<< marks matched text. Quoted arguments may have no exact text marker; operation risk labels above still apply." : "",
    context,
    "COMPLETE INVOCATION",
    preview(command),
    "Exact-command options remember the entire original input. Exact-operation options remember only the listed unapproved argument lists in this cwd, including future supported chains. They do not allow different arguments.",
    ...(typesAvailable ? [
      "OPERATION-TYPE PERMISSIONS: broader than exact operations. The following types would be remembered in this cwd:",
      ...[...new Set(pending.map((operation) => operation.rule!.description))].map((description) => `- ${description}`),
    ] : []),
    "Choose both scope and lifetime below. Remembered permissions skip future prompts and model review within their scope.",
  ].join("\n\n");
  const complete = command.length <= PREVIEW_MAX && text.length <= PREVIEW_MAX;
  const message = complete ? text : [
    "PREVIEW TRUNCATED: no remembered-permission options are available. Inspect the original tool input before allowing once.",
    text.slice(0, PREVIEW_MAX / 2),
    "... preview truncated ...",
    text.slice(-PREVIEW_MAX / 2),
  ].join("\n");
  const choices = new Map<string, BashChoice>([[BASH_CHOICES.once, { scope: "command" }]]);
  if (complete) {
    choices.set(BASH_CHOICES.commandSession, { scope: "command", lifetime: "session" });
    choices.set(BASH_CHOICES.commandPermanent, { scope: "command", lifetime: "permanent" });
    if (!fallbackReason && pending.length) {
      choices.set(BASH_CHOICES.operationSession, { scope: "operation", lifetime: "session" });
      choices.set(BASH_CHOICES.operationPermanent, { scope: "operation", lifetime: "permanent" });
      if (typesAvailable) {
        choices.set(BASH_CHOICES.ruleSession, { scope: "operation-rule", lifetime: "session" });
        choices.set(BASH_CHOICES.rulePermanent, { scope: "operation-rule", lifetime: "permanent" });
      }
    }
  }
  return { message, choices };
}
