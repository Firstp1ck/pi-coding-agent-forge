import type { ScopeExternalSideEffects, WorkflowLane } from "./types.ts";

export const MAX_SCOPE_TOOLS = 24;
export const MAX_SCOPE_PATHS = 32;
export const MAX_SCOPE_CONDITIONS = 12;
export const MAX_SCOPE_VALIDATION_COMMANDS = 12;

export type ScopeSetInput = {
  action: "set";
  lane: WorkflowLane;
  allowedTools: string[];
  allowedReadPaths?: string[];
  allowedWritePaths?: string[];
  forbiddenPaths?: string[];
  maxToolCalls: number;
  maxErrors: number;
  maxIterations: number;
  externalSideEffects: ScopeExternalSideEffects;
  validationCommands?: string[];
  stopConditions: string[];
  escalationConditions: string[];
};

export type ScopeApprovalRequestInput = {
  action: "request-approval";
  description: string;
  toolName: string;
  normalizedEffect: string;
  reversible: boolean;
};

export type ScopeCheckInput = {
  action: "check";
  candidateTool?: string;
  candidateInput?: unknown;
};

export type ReliabilityScopeInput = ScopeSetInput | ScopeApprovalRequestInput | { action: "status" } | ScopeCheckInput;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unsupported reliability_scope field '${key}'.`);
  }
}

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value.trim();
}

function toolName(value: unknown, field: string): string {
  const name = requiredString(value, field, 96);
  if (!/^[a-z][a-z0-9_-]{0,95}$/.test(name)) throw new Error(`${field} must be a supported tool identifier.`);
  return name;
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${field} must be an integer from 1 through ${maximum}.`);
  }
  return value as number;
}

function uniqueStrings(value: unknown, field: string, maximumItems: number, maximumChars: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${field} must contain at most ${maximumItems} strings.`);
  const values = value.map((item, index) => requiredString(item, `${field}[${index}]`, maximumChars));
  if (new Set(values).size !== values.length) throw new Error(`${field} must not contain duplicates.`);
  return values;
}

function parseLane(value: unknown): WorkflowLane {
  if (value === "retrieval" || value === "agentic" || value === "coding" || value === "structured-output" || value === "general") return value;
  throw new Error("lane must be retrieval, agentic, coding, structured-output, or general.");
}

function parseSideEffects(value: unknown): ScopeExternalSideEffects {
  if (value === "forbidden" || value === "approval-required" || value === "pre-approved") return value;
  throw new Error("externalSideEffects must be forbidden, approval-required, or pre-approved.");
}

/** Revalidates every model-facing scope action before it can affect task state. */
export function validateReliabilityScopeInput(input: unknown): ReliabilityScopeInput {
  if (!isRecord(input) || typeof input.action !== "string") throw new Error("reliability_scope requires an action object.");
  switch (input.action) {
    case "set": {
      assertAllowedKeys(input, [
        "action", "lane", "allowedTools", "allowedReadPaths", "allowedWritePaths", "forbiddenPaths", "maxToolCalls", "maxErrors", "maxIterations",
        "externalSideEffects", "validationCommands", "stopConditions", "escalationConditions",
      ]);
      const allowedTools = uniqueStrings(input.allowedTools, "allowedTools", MAX_SCOPE_TOOLS, 96).map((value, index) => toolName(value, `allowedTools[${index}]`));
      if (allowedTools.length === 0) throw new Error("allowedTools must contain at least one tool.");
      return {
        action: "set",
        lane: parseLane(input.lane),
        allowedTools,
        allowedReadPaths: input.allowedReadPaths === undefined ? [] : uniqueStrings(input.allowedReadPaths, "allowedReadPaths", MAX_SCOPE_PATHS, 1_024),
        allowedWritePaths: input.allowedWritePaths === undefined ? [] : uniqueStrings(input.allowedWritePaths, "allowedWritePaths", MAX_SCOPE_PATHS, 1_024),
        forbiddenPaths: input.forbiddenPaths === undefined ? [] : uniqueStrings(input.forbiddenPaths, "forbiddenPaths", MAX_SCOPE_PATHS, 1_024),
        maxToolCalls: positiveInteger(input.maxToolCalls, "maxToolCalls", 500),
        maxErrors: positiveInteger(input.maxErrors, "maxErrors", 100),
        maxIterations: positiveInteger(input.maxIterations, "maxIterations", 500),
        externalSideEffects: parseSideEffects(input.externalSideEffects),
        validationCommands: input.validationCommands === undefined ? [] : uniqueStrings(input.validationCommands, "validationCommands", MAX_SCOPE_VALIDATION_COMMANDS, 800),
        stopConditions: uniqueStrings(input.stopConditions, "stopConditions", MAX_SCOPE_CONDITIONS, 600),
        escalationConditions: uniqueStrings(input.escalationConditions, "escalationConditions", MAX_SCOPE_CONDITIONS, 600),
      };
    }
    case "request-approval":
      assertAllowedKeys(input, ["action", "description", "toolName", "normalizedEffect", "reversible"]);
      if (typeof input.reversible !== "boolean") throw new Error("reversible must be a boolean.");
      return {
        action: "request-approval",
        description: requiredString(input.description, "description", 1_000),
        toolName: toolName(input.toolName, "toolName"),
        normalizedEffect: requiredString(input.normalizedEffect, "normalizedEffect", 8_000),
        reversible: input.reversible,
      };
    case "status":
      assertAllowedKeys(input, ["action"]);
      return { action: "status" };
    case "check":
      assertAllowedKeys(input, ["action", "candidateTool", "candidateInput"]);
      return {
        action: "check",
        candidateTool: input.candidateTool === undefined ? undefined : toolName(input.candidateTool, "candidateTool"),
        candidateInput: input.candidateInput,
      };
    default:
      throw new Error(`Unsupported reliability_scope action '${input.action}'.`);
  }
}
