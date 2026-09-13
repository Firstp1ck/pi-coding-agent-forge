import { qualityGateResolutionIsCurrent } from "./quality-gate.ts";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

import { isRuntimeOwnedScopePath, nativeAuthorityReceiptHash, normalizeScopePath } from "./scope-state.ts";
import type {
  CompletionDecision,
  JsonSchemaSubset,
  OutputContractReceipt,
  OutputValidationReceipt,
  ReliabilityConfig,
  SessionBranchIdentity,
  StructuredOutputContract,
  StructuredOutputContractDefinition,
  StructuredOutputState,
  StructuredOutputValidation,
  TaskState,
} from "./types.ts";
import { nowIso, stableStringify } from "./utils.ts";

export const RELIABILITY_OUTPUT_CONTRACT_ENTRY_TYPE = "reliability-output-contract";
export const RELIABILITY_OUTPUT_VALIDATION_ENTRY_TYPE = "reliability-output-validation";
export const STRUCTURED_OUTPUT_VALIDATOR_VERSION = "structured-output-v1" as const;

const MAX_CONTRACTS = 12;
const MAX_VALIDATIONS = 12;
const MAX_JSON_SCHEMA_DEPTH = 8;
const MAX_JSON_CANDIDATE_DEPTH = 32;
const MAX_JSON_COLLECTION_ITEMS = 1_000;
const MAX_CSV_COLUMNS = 64;
const MAX_CHECKLIST_ITEMS = 64;
const MAX_REASONS = 16;
const ID_PATTERN = /^O(?:C|V)[1-9][0-9]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type OutputContractDraft = {
  path: string;
  /** Exact inspected file hash, used for the native approval receipt. */
  sha256: string;
  /** Canonical parsed-definition hash, used to detect state tampering. */
  definition_sha256: string;
  definition: StructuredOutputContractDefinition;
  bytes: number;
};

export type OutputContractBinding = {
  session: SessionBranchIdentity;
  receipt: OutputContractReceipt;
};

export type OutputValidationBinding = {
  session: SessionBranchIdentity;
  receipt: OutputValidationReceipt;
};

export type OutputValidationProposal = Omit<StructuredOutputValidation, "id" | "task_id" | "branch_id" | "validated_at" | "session_id" | "session_anchor_entry_id" | "receipt_hash">;

type CsvParseResult = { rows: string[][] } | { error: string };

type ValidationResult = {
  syntaxValid: boolean;
  schemaValid: boolean;
  reasons: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedReasons(reasons: string[]): string[] {
  return [...new Set(reasons)].slice(0, MAX_REASONS);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  return value;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${field} has unsupported field '${key}'.`);
  }
}

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function semanticMode(value: unknown): "structural-only" | "human-review-required" {
  if (value === "structural-only" || value === "human-review-required") return value;
  throw new Error("semantic must be structural-only or human-review-required.");
}

function stringArray(value: unknown, field: string, maximumItems: number, maximumChars: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    throw new Error(`${field} must contain one through ${maximumItems} strings.`);
  }
  const result = value.map((item, index) => requiredString(item, `${field}[${index}]`, maximumChars));
  if (new Set(result).size !== result.length) throw new Error(`${field} must not contain duplicates.`);
  return result;
}

function scalarEnum(value: unknown, field: string): Array<string | number | boolean | null> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new Error(`${field} must contain one through 64 scalar values.`);
  const result = value.map((item, index) => {
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return item;
    throw new Error(`${field}[${index}] must be a string, finite number, boolean, or null.`);
  });
  if (new Set(result.map((item) => stableStringify(item))).size !== result.length) throw new Error(`${field} must not contain duplicates.`);
  return result;
}

function parseSchema(value: unknown, field: string, depth = 0): JsonSchemaSubset {
  if (depth > MAX_JSON_SCHEMA_DEPTH) throw new Error(`JSON schema exceeds the maximum depth of ${MAX_JSON_SCHEMA_DEPTH}.`);
  const schema = requireObject(value, field);
  const allowed = ["type", "properties", "required", "additionalProperties", "items", "enum", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"];
  assertAllowedKeys(schema, allowed, field);
  if (Object.keys(schema).length === 0) throw new Error(`${field} must declare at least one supported structural constraint.`);
  const result: JsonSchemaSubset = {};
  if (schema.type !== undefined) {
    if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(schema.type))) {
      throw new Error(`${field}.type is unsupported.`);
    }
    result.type = schema.type as JsonSchemaSubset["type"];
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new Error(`${field}.properties must be an object.`);
    const properties = Object.entries(schema.properties);
    if (properties.length > 64) throw new Error(`${field}.properties may contain at most 64 properties.`);
    result.properties = Object.fromEntries(properties.map(([name, child]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`${field}.properties has an unsupported property name.`);
      return [name, parseSchema(child, `${field}.properties.${name}`, depth + 1)];
    }));
  }
  if (schema.required !== undefined) {
    const required = stringArray(schema.required, `${field}.required`, 64, 64);
    const properties = result.properties;
    if (properties && required.some((name) => !Object.hasOwn(properties, name))) {
      throw new Error(`${field}.required must reference declared properties.`);
    }
    result.required = required;
  }
  if (schema.additionalProperties !== undefined) {
    if (typeof schema.additionalProperties !== "boolean") throw new Error(`${field}.additionalProperties must be a boolean.`);
    result.additionalProperties = schema.additionalProperties;
  }
  if (schema.items !== undefined) result.items = parseSchema(schema.items, `${field}.items`, depth + 1);
  if (schema.enum !== undefined) result.enum = scalarEnum(schema.enum, `${field}.enum`);
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (schema[key] !== undefined) result[key] = boundedInteger(schema[key], `${field}.${key}`, 0, MAX_JSON_COLLECTION_ITEMS);
  }
  for (const key of ["minimum", "maximum"] as const) {
    if (schema[key] !== undefined) {
      if (typeof schema[key] !== "number" || !Number.isFinite(schema[key])) throw new Error(`${field}.${key} must be a finite number.`);
      result[key] = schema[key];
    }
  }
  if (result.minLength !== undefined && result.maxLength !== undefined && result.minLength > result.maxLength) {
    throw new Error(`${field}.minLength cannot exceed maxLength.`);
  }
  if (result.minItems !== undefined && result.maxItems !== undefined && result.minItems > result.maxItems) {
    throw new Error(`${field}.minItems cannot exceed maxItems.`);
  }
  if (result.minimum !== undefined && result.maximum !== undefined && result.minimum > result.maximum) {
    throw new Error(`${field}.minimum cannot exceed maximum.`);
  }
  if (result.properties && result.type !== "object") throw new Error(`${field}.properties requires type object.`);
  if (result.items && result.type !== "array") throw new Error(`${field}.items requires type array.`);
  if ((result.minLength !== undefined || result.maxLength !== undefined) && result.type !== "string") throw new Error(`${field} string bounds require type string.`);
  if ((result.minItems !== undefined || result.maxItems !== undefined) && result.type !== "array") throw new Error(`${field} array bounds require type array.`);
  if ((result.minimum !== undefined || result.maximum !== undefined) && result.type !== "number" && result.type !== "integer") {
    throw new Error(`${field} numeric bounds require type number or integer.`);
  }
  return result;
}

/** Parses only the finite declarative format subset accepted for native confirmation. */
export function parseStructuredOutputContract(value: unknown): StructuredOutputContractDefinition {
  const contract = requireObject(value, "output contract");
  const format = contract.format;
  if (format === "json") {
    assertAllowedKeys(contract, ["format", "semantic", "schema"], "output contract");
    return { format, semantic: semanticMode(contract.semantic), schema: parseSchema(contract.schema, "output contract.schema") };
  }
  if (format === "csv") {
    assertAllowedKeys(contract, ["format", "semantic", "columns", "hasHeader", "minRows", "maxRows"], "output contract");
    if (typeof contract.hasHeader !== "boolean") throw new Error("output contract.hasHeader must be a boolean.");
    const minRows = boundedInteger(contract.minRows, "output contract.minRows", 0, MAX_JSON_COLLECTION_ITEMS);
    const maxRows = boundedInteger(contract.maxRows, "output contract.maxRows", minRows, MAX_JSON_COLLECTION_ITEMS);
    return { format, semantic: semanticMode(contract.semantic), columns: stringArray(contract.columns, "output contract.columns", MAX_CSV_COLUMNS, 128), hasHeader: contract.hasHeader, minRows, maxRows };
  }
  if (format === "enum") {
    assertAllowedKeys(contract, ["format", "semantic", "values"], "output contract");
    return { format, semantic: semanticMode(contract.semantic), values: stringArray(contract.values, "output contract.values", 64, 2_000) };
  }
  if (format === "bounded-string") {
    assertAllowedKeys(contract, ["format", "semantic", "minLength", "maxLength"], "output contract");
    const minLength = boundedInteger(contract.minLength, "output contract.minLength", 0, 50_000);
    const maxLength = boundedInteger(contract.maxLength, "output contract.maxLength", minLength, 50_000);
    return { format, semantic: semanticMode(contract.semantic), minLength, maxLength };
  }
  if (format === "markdown-checklist") {
    assertAllowedKeys(contract, ["format", "semantic", "items", "allowExtraItems"], "output contract");
    if (!Array.isArray(contract.items) || contract.items.length === 0 || contract.items.length > MAX_CHECKLIST_ITEMS) {
      throw new Error(`output contract.items must contain one through ${MAX_CHECKLIST_ITEMS} entries.`);
    }
    if (typeof contract.allowExtraItems !== "boolean") throw new Error("output contract.allowExtraItems must be a boolean.");
    const items = contract.items.map((item, index) => {
      const entry = requireObject(item, `output contract.items[${index}]`);
      assertAllowedKeys(entry, ["text", "checked"], `output contract.items[${index}]`);
      if (typeof entry.checked !== "boolean") throw new Error(`output contract.items[${index}].checked must be a boolean.`);
      return { text: requiredString(entry.text, `output contract.items[${index}].text`, 600), checked: entry.checked };
    });
    if (new Set(items.map((item) => item.text)).size !== items.length) throw new Error("output contract.items must not contain duplicate text.");
    return { format, semantic: semanticMode(contract.semantic), items, allowExtraItems: contract.allowExtraItems };
  }
  throw new Error("output contract.format must be json, csv, enum, bounded-string, or markdown-checklist.");
}

/** Reads a user-supplied declarative contract without giving the path execution authority. */
export function readOutputContractDraft(state: TaskState, path: string, config: ReliabilityConfig): OutputContractDraft {
  const contractPath = normalizeScopePath(state.cwd, path);
  if (isRuntimeOwnedScopePath(state.cwd, contractPath)) throw new Error("Output contracts cannot be loaded from runtime-owned task or policy paths.");
  const stat = lstatSync(contractPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > config.structuredOutput.maxSchemaChars) {
    throw new Error(`Output contract must be a real regular file no larger than ${config.structuredOutput.maxSchemaChars} bytes.`);
  }
  const bytes = readFileSync(contractPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Output contract must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const definition = parseStructuredOutputContract(parsed);
  return { path: contractPath, sha256: sha256(bytes), definition_sha256: sha256(stableStringify(definition)), definition, bytes: bytes.length };
}

export function createStructuredOutputState(): StructuredOutputState {
  return { contracts: [], validations: [], total_candidates_used: 0 };
}

function currentSessionMatchesTask(state: TaskState, session: SessionBranchIdentity): boolean {
  if (!state.task_identity.session_id) return false;
  return session.lifecycle_identity === "available"
    && session.session_id === state.task_identity.session_id
    && (!state.task_identity.session_anchor_entry_id || session.branch_entry_ids.includes(state.task_identity.session_anchor_entry_id));
}

function contractReceiptMatches(receipt: OutputContractReceipt, contract: StructuredOutputContract): boolean {
  const data = {
    task_id: receipt.task_id,
    contract_id: receipt.contract_id,
    contract_sha256: receipt.contract_sha256,
    definition_sha256: receipt.definition_sha256,
    contract_path: receipt.contract_path,
  };
  return receipt.task_id === contract.task_id
    && receipt.contract_id === contract.contract_id
    && receipt.contract_sha256 === contract.contract_sha256
    && receipt.definition_sha256 === contract.definition_sha256
    && receipt.contract_path === contract.contract_path
    && receipt.receipt_hash === nativeAuthorityReceiptHash(RELIABILITY_OUTPUT_CONTRACT_ENTRY_TYPE, data);
}

function validationResultPayload(validation: Pick<StructuredOutputValidation, "contract_id" | "contract_sha256" | "candidate_sha256" | "validator_version" | "candidate_chars" | "attempt" | "syntax_valid" | "schema_valid" | "semantic_check_state" | "semantic_checks_passed" | "human_review_required" | "decision" | "reasons">): Record<string, unknown> {
  return {
    contract_id: validation.contract_id,
    contract_sha256: validation.contract_sha256,
    candidate_sha256: validation.candidate_sha256,
    validator_version: validation.validator_version,
    candidate_chars: validation.candidate_chars,
    attempt: validation.attempt,
    syntax_valid: validation.syntax_valid,
    schema_valid: validation.schema_valid,
    semantic_check_state: validation.semantic_check_state,
    semantic_checks_passed: validation.semantic_checks_passed,
    human_review_required: validation.human_review_required,
    decision: validation.decision,
    reasons: validation.reasons,
  };
}

export function outputValidationResultHash(validation: Parameters<typeof validationResultPayload>[0]): string {
  return sha256(stableStringify(validationResultPayload(validation)));
}

function validationReceiptMatches(receipt: OutputValidationReceipt, validation: StructuredOutputValidation): boolean {
  const data = {
    task_id: receipt.task_id,
    validation_id: receipt.validation_id,
    contract_id: receipt.contract_id,
    contract_sha256: receipt.contract_sha256,
    candidate_sha256: receipt.candidate_sha256,
    result_sha256: receipt.result_sha256,
  };
  return receipt.task_id === validation.task_id
    && receipt.validation_id === validation.id
    && receipt.contract_id === validation.contract_id
    && receipt.contract_sha256 === validation.contract_sha256
    && receipt.candidate_sha256 === validation.candidate_sha256
    && receipt.result_sha256 === validation.result_sha256
    && receipt.receipt_hash === nativeAuthorityReceiptHash(RELIABILITY_OUTPUT_VALIDATION_ENTRY_TYPE, data);
}

export function outputContractIsCurrent(state: TaskState, contract: StructuredOutputContract): boolean {
  if (contract.task_id !== state.task_id || contract.branch_id !== state.task_identity.branch_id) return false;
  if (contract.definition_sha256 !== sha256(stableStringify(contract.definition))) return false;
  if (!state.task_identity.session_id) return false;
  if (!currentSessionMatchesTask(state, state.current_session) || contract.session_id !== state.current_session.session_id || !contract.session_anchor_entry_id || !contract.receipt_hash) return false;
  const receipt = state.current_session.output_contract_receipts?.find((candidate) => candidate.entry_id === contract.session_anchor_entry_id);
  return Boolean(receipt && state.current_session.branch_entry_ids.includes(receipt.entry_id) && contractReceiptMatches(receipt, contract));
}

export function outputValidationIsCurrent(state: TaskState, validation: StructuredOutputValidation): boolean {
  if (validation.task_id !== state.task_id || validation.branch_id !== state.task_identity.branch_id || validation.superseded_by_contract_id) return false;
  if (validation.result_sha256 !== outputValidationResultHash(validation)) return false;
  const contract = state.structured_output.contracts.find((candidate) => candidate.contract_id === validation.contract_id);
  if (!contract || contract.contract_sha256 !== validation.contract_sha256 || !outputContractIsCurrent(state, contract)) return false;
  if (!state.task_identity.session_id) return false;
  if (!currentSessionMatchesTask(state, state.current_session) || validation.session_id !== state.current_session.session_id || !validation.session_anchor_entry_id || !validation.receipt_hash) return false;
  const receipt = state.current_session.output_validation_receipts?.find((candidate) => candidate.entry_id === validation.session_anchor_entry_id);
  return Boolean(receipt && state.current_session.branch_entry_ids.includes(receipt.entry_id) && validationReceiptMatches(receipt, validation));
}

function requireBindingForContract(state: TaskState, binding: OutputContractBinding, contractId: string, draft: OutputContractDraft): void {
  if (!state.task_identity.session_id) {
    if (binding.receipt.entry_id || binding.session.session_id) throw new Error("Sessionless output-contract fixtures cannot attach native receipts.");
    return;
  }
  if (!currentSessionMatchesTask(state, binding.session)) throw new Error("Output contract confirmation belongs to a different Pi session or branch.");
  const receipt = binding.receipt;
  if (receipt.task_id !== state.task_id || receipt.contract_id !== contractId || receipt.contract_sha256 !== draft.sha256 || receipt.contract_path !== draft.path
    || !binding.session.branch_entry_ids.includes(receipt.entry_id)
    || !binding.session.output_contract_receipts?.some((candidate) => candidate.entry_id === receipt.entry_id && contractReceiptMatches(candidate, {
      schema_version: 1,
      contract_id: contractId,
      task_id: state.task_id,
      branch_id: state.task_identity.branch_id,
      contract_path: draft.path,
      contract_sha256: draft.sha256,
      definition_sha256: draft.definition_sha256,
      definition: draft.definition,
      created_at: "receipt-check",
      session_id: binding.session.session_id,
      session_anchor_entry_id: receipt.entry_id,
      receipt_hash: receipt.receipt_hash,
    }))) throw new Error("Output contract confirmation receipt was not persisted on the current Pi branch.");
}

/** Activates a newly user-confirmed immutable contract and supersedes prior checks for the same path. */
export function registerOutputContract(state: TaskState, draft: OutputContractDraft, binding?: OutputContractBinding): StructuredOutputContract {
  if (state.structured_output.contracts.length >= MAX_CONTRACTS) throw new Error(`A task can retain at most ${MAX_CONTRACTS} output contracts.`);
  const contractId = `OC${state.id_counters.next_output_contract}`;
  if (!binding) throw new Error("Output contracts require a current native user-confirmation receipt in an available Pi session.");
  requireBindingForContract(state, binding, contractId, draft);
  const previous = state.structured_output.contracts.filter((contract) => contract.contract_path === draft.path);
  for (const validation of state.structured_output.validations) {
    if (previous.some((contract) => contract.contract_id === validation.contract_id) && !validation.superseded_by_contract_id) {
      validation.superseded_by_contract_id = contractId;
    }
  }
  const contract: StructuredOutputContract = {
    schema_version: 1,
    contract_id: contractId,
    task_id: state.task_id,
    branch_id: state.task_identity.branch_id,
    contract_path: draft.path,
    contract_sha256: draft.sha256,
    definition_sha256: draft.definition_sha256,
    definition: draft.definition,
    created_at: nowIso(),
    session_id: binding?.session.session_id,
    session_anchor_entry_id: binding?.receipt.entry_id,
    receipt_hash: binding?.receipt.receipt_hash,
  };
  state.id_counters.next_output_contract += 1;
  state.structured_output.contracts.push(contract);
  state.structured_output.active_contract_id = contract.contract_id;
  return contract;
}

function jsonValueWithinBounds(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_CANDIDATE_DEPTH) return false;
  if (Array.isArray(value)) return value.length <= MAX_JSON_COLLECTION_ITEMS && value.every((item) => jsonValueWithinBounds(item, depth + 1));
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return entries.length <= MAX_JSON_COLLECTION_ITEMS && entries.every(([, item]) => jsonValueWithinBounds(item, depth + 1));
  }
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
}

function matchesJsonType(value: unknown, type: NonNullable<JsonSchemaSubset["type"]>): boolean {
  switch (type) {
    case "object": return isRecord(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
  }
}

function validateJsonSchema(value: unknown, schema: JsonSchemaSubset, path: string, depth = 0): string[] {
  if (depth > MAX_JSON_SCHEMA_DEPTH + MAX_JSON_CANDIDATE_DEPTH) return [`${path} exceeds the supported validation depth.`];
  const issues: string[] = [];
  if (schema.type && !matchesJsonType(value, schema.type)) issues.push(`${path} must be ${schema.type}.`);
  if (schema.enum && !schema.enum.some((candidate) => stableStringify(candidate) === stableStringify(value))) issues.push(`${path} is not an allowed enum value.`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${path} is shorter than minLength.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push(`${path} exceeds maxLength.`);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${path} is below minimum.`);
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${path} exceeds maximum.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${path} has fewer than minItems.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${path} exceeds maxItems.`);
    if (schema.items) value.forEach((item, index) => issues.push(...validateJsonSchema(item, schema.items!, `${path}[${index}]`, depth + 1)));
  }
  if (isRecord(value)) {
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) issues.push(`${path}.${required} is required.`);
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, name)) issues.push(...validateJsonSchema(value[name], child, `${path}.${name}`, depth + 1));
    }
    if (schema.additionalProperties === false) {
      const properties = schema.properties ?? {};
      for (const name of Object.keys(value)) if (!Object.hasOwn(properties, name)) issues.push(`${path}.${name} is not allowed.`);
    }
  }
  return issues.slice(0, MAX_REASONS);
}

function parseCsv(candidate: string): CsvParseResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  const pushRow = (): CsvParseResult | undefined => {
    row.push(cell);
    rows.push(row);
    if (rows.length > MAX_JSON_COLLECTION_ITEMS || row.length > MAX_CSV_COLUMNS) return { error: "CSV exceeds supported row or column bounds." };
    row = [];
    cell = "";
    afterQuote = false;
    return undefined;
  };
  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (quoted) {
      if (character === '"') {
        if (candidate[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else cell += character;
      continue;
    }
    if (afterQuote && character !== "," && character !== "\n" && character !== "\r") return { error: "CSV quoted cells may contain only a delimiter after the closing quote." };
    if (character === '"') {
      if (cell.length > 0 || afterQuote) return { error: "CSV quotes may only begin at a cell boundary." };
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
      afterQuote = false;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && candidate[index + 1] === "\n") index += 1;
      const error = pushRow();
      if (error) return error;
    } else cell += character;
  }
  if (quoted) return { error: "CSV has an unterminated quoted cell." };
  if (cell.length > 0 || row.length > 0 || afterQuote) {
    const error = pushRow();
    if (error) return error;
  }
  return { rows };
}

function validateJsonCandidate(candidate: string, definition: Extract<StructuredOutputContractDefinition, { format: "json" }>): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return { syntaxValid: false, schemaValid: false, reasons: [`JSON syntax is invalid: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!jsonValueWithinBounds(parsed)) return { syntaxValid: true, schemaValid: false, reasons: ["JSON candidate exceeds supported depth, collection, or numeric bounds."] };
  const reasons = validateJsonSchema(parsed, definition.schema, "$" as string);
  return { syntaxValid: true, schemaValid: reasons.length === 0, reasons };
}

function validateCsvCandidate(candidate: string, definition: Extract<StructuredOutputContractDefinition, { format: "csv" }>): ValidationResult {
  const parsed = parseCsv(candidate);
  if ("error" in parsed) return { syntaxValid: false, schemaValid: false, reasons: [parsed.error] };
  const rows = parsed.rows;
  const header = definition.hasHeader ? rows.shift() : undefined;
  const dataRows = rows;
  const reasons: string[] = [];
  if (definition.hasHeader && (!header || header.length !== definition.columns.length || header.some((value, index) => value !== definition.columns[index]))) {
    reasons.push("CSV header does not exactly match the declared columns.");
  }
  if (dataRows.length < definition.minRows || dataRows.length > definition.maxRows) reasons.push("CSV row count is outside the declared bounds.");
  if (dataRows.some((row) => row.length !== definition.columns.length)) reasons.push("CSV rows must contain exactly the declared column count.");
  return { syntaxValid: true, schemaValid: reasons.length === 0, reasons };
}

function validateEnumCandidate(candidate: string, definition: Extract<StructuredOutputContractDefinition, { format: "enum" }>): ValidationResult {
  const value = candidate.trim();
  return definition.values.includes(value)
    ? { syntaxValid: true, schemaValid: true, reasons: [] }
    : { syntaxValid: true, schemaValid: false, reasons: ["Candidate is not one of the declared enum values."] };
}

function validateStringCandidate(candidate: string, definition: Extract<StructuredOutputContractDefinition, { format: "bounded-string" }>): ValidationResult {
  const valid = candidate.length >= definition.minLength && candidate.length <= definition.maxLength;
  return valid
    ? { syntaxValid: true, schemaValid: true, reasons: [] }
    : { syntaxValid: true, schemaValid: false, reasons: ["Candidate length is outside the declared bounds."] };
}

function validateChecklistCandidate(candidate: string, definition: Extract<StructuredOutputContractDefinition, { format: "markdown-checklist" }>): ValidationResult {
  const rows = candidate.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const items: Array<{ text: string; checked: boolean }> = [];
  for (const row of rows) {
    const match = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(row);
    if (!match) return { syntaxValid: false, schemaValid: false, reasons: ["Markdown checklist contains a non-checklist line."] };
    items.push({ checked: match[1].toLowerCase() === "x", text: match[2] });
  }
  if (items.length > MAX_CHECKLIST_ITEMS) return { syntaxValid: true, schemaValid: false, reasons: ["Markdown checklist exceeds the supported item limit."] };
  const reasons: string[] = [];
  const byText = new Map<string, Array<{ text: string; checked: boolean }>>();
  for (const item of items) byText.set(item.text, [...(byText.get(item.text) ?? []), item]);
  for (const expected of definition.items) {
    const matches = byText.get(expected.text) ?? [];
    if (matches.length === 0) reasons.push(`Checklist item '${expected.text}' is missing.`);
    else if (matches.length > 1) reasons.push(`Checklist item '${expected.text}' is duplicated.`);
    else if (matches[0].checked !== expected.checked) reasons.push(`Checklist item '${expected.text}' has the wrong status.`);
  }
  if (!definition.allowExtraItems && items.some((item) => !definition.items.some((expected) => expected.text === item.text))) {
    reasons.push("Markdown checklist contains undeclared items.");
  }
  return { syntaxValid: true, schemaValid: reasons.length === 0, reasons };
}

function validateCandidate(candidate: string, definition: StructuredOutputContractDefinition): ValidationResult {
  switch (definition.format) {
    case "json": return validateJsonCandidate(candidate, definition);
    case "csv": return validateCsvCandidate(candidate, definition);
    case "enum": return validateEnumCandidate(candidate, definition);
    case "bounded-string": return validateStringCandidate(candidate, definition);
    case "markdown-checklist": return validateChecklistCandidate(candidate, definition);
  }
}

/** Validates one bounded candidate without storing its raw content. */
export function validateOutputCandidate(state: TaskState, contractId: string, candidate: string, config: ReliabilityConfig): OutputValidationProposal {
  if (!ID_PATTERN.test(contractId) || !contractId.startsWith("OC")) throw new Error("contractId must be an existing task-local output contract ID such as OC1.");
  if (typeof candidate !== "string" || candidate.length > config.structuredOutput.maxCandidateChars) {
    throw new Error(`candidate must be a string of at most ${config.structuredOutput.maxCandidateChars} characters.`);
  }
  const contract = state.structured_output.contracts.find((item) => item.contract_id === contractId);
  if (!contract) throw new Error(`Output contract ${contractId} does not belong to this task.`);
  if (!outputContractIsCurrent(state, contract)) throw new Error(`Output contract ${contractId} lacks current user-confirmed session provenance.`);
  if (state.structured_output.total_candidates_used >= config.structuredOutput.maxCandidatesPerTask) {
    throw new Error(`Structured-output repair budget is exhausted after ${config.structuredOutput.maxCandidatesPerTask} candidates; escalate instead of retrying.`);
  }
  const attempt = state.structured_output.total_candidates_used + 1;
  state.structured_output.total_candidates_used = attempt;
  const validation = validateCandidate(candidate, contract.definition);
  const humanReviewRequired = contract.definition.semantic === "human-review-required";
  const semanticCheckState = humanReviewRequired ? "review-required" as const : "not-required" as const;
  const semanticChecksPassed = false;
  const decision: CompletionDecision = !validation.syntaxValid || !validation.schemaValid
    ? "fail"
    : humanReviewRequired
      ? "escalate"
      : "pass";
  const reasons = validation.reasons.length
    ? validation.reasons
    : humanReviewRequired
      ? ["The user-approved contract requires human semantic review; deterministic validation is structural only."]
      : ["The candidate satisfies the user-approved structural output contract. No semantic claim was evaluated."];
  const candidateSha = sha256(candidate);
  const core = {
    contract_id: contract.contract_id,
    contract_sha256: contract.contract_sha256,
    candidate_sha256: candidateSha,
    validator_version: STRUCTURED_OUTPUT_VALIDATOR_VERSION,
    candidate_chars: candidate.length,
    attempt,
    syntax_valid: validation.syntaxValid,
    schema_valid: validation.schemaValid,
    semantic_check_state: semanticCheckState,
    semantic_checks_passed: semanticChecksPassed,
    human_review_required: humanReviewRequired,
    decision,
    reasons: boundedReasons(reasons),
  };
  return { ...core, result_sha256: outputValidationResultHash(core) };
}

function requireBindingForValidation(state: TaskState, proposal: OutputValidationProposal, validationId: string, binding: OutputValidationBinding): void {
  if (!state.task_identity.session_id) {
    if (binding.receipt.entry_id || binding.session.session_id) throw new Error("Sessionless output-validation fixtures cannot attach native receipts.");
    return;
  }
  if (!currentSessionMatchesTask(state, binding.session)) throw new Error("Output validation belongs to a different Pi session or branch.");
  const receipt = binding.receipt;
  if (receipt.task_id !== state.task_id || receipt.validation_id !== validationId || receipt.contract_id !== proposal.contract_id
    || receipt.contract_sha256 !== proposal.contract_sha256 || receipt.candidate_sha256 !== proposal.candidate_sha256 || receipt.result_sha256 !== proposal.result_sha256
    || !binding.session.branch_entry_ids.includes(receipt.entry_id)) throw new Error("Output validation receipt does not match the current candidate result.");
  const validation: StructuredOutputValidation = {
    ...proposal,
    id: validationId,
    task_id: state.task_id,
    branch_id: state.task_identity.branch_id,
    validated_at: "receipt-check",
    session_id: binding.session.session_id,
    session_anchor_entry_id: receipt.entry_id,
    receipt_hash: receipt.receipt_hash,
  };
  if (!binding.session.output_validation_receipts?.some((candidate) => candidate.entry_id === receipt.entry_id && validationReceiptMatches(candidate, validation))) {
    throw new Error("Output validation receipt was not persisted on the current Pi branch.");
  }
}

/** Persists metadata and hashes only after the native validator receipt is observable. */
export function recordOutputValidation(state: TaskState, proposal: OutputValidationProposal, binding?: OutputValidationBinding): StructuredOutputValidation {
  if (state.structured_output.validations.length >= MAX_VALIDATIONS) throw new Error(`A task can retain at most ${MAX_VALIDATIONS} structured-output validation results.`);
  if (!Number.isSafeInteger(proposal.attempt) || proposal.attempt < 1 || proposal.attempt > state.structured_output.total_candidates_used) {
    throw new Error("Structured-output validation must correspond to an already counted candidate attempt.");
  }
  if (state.structured_output.validations.some((item) => item.candidate_sha256 === proposal.candidate_sha256 && item.contract_id === proposal.contract_id)) {
    throw new Error("The same candidate hash cannot be recorded twice for one output contract.");
  }
  const validationId = `OV${state.id_counters.next_output_validation}`;
  if (!binding) throw new Error("Output validation requires a current native runtime receipt in an available Pi session.");
  requireBindingForValidation(state, proposal, validationId, binding);
  const validation: StructuredOutputValidation = {
    ...proposal,
    id: validationId,
    task_id: state.task_id,
    branch_id: state.task_identity.branch_id,
    validated_at: nowIso(),
    session_id: binding?.session.session_id,
    session_anchor_entry_id: binding?.receipt.entry_id,
    receipt_hash: binding?.receipt.receipt_hash,
  };
  state.id_counters.next_output_validation += 1;
  state.structured_output.validations.push(validation);
  return validation;
}

/** Records only the final response hash; raw assistant text stays in the host session, not task state. */
export function bindFinalOutputCandidate(state: TaskState, finalOutput: string): void {
  const active = activeOutputContract(state);
  if (!active || typeof finalOutput !== "string") return;
  state.structured_output.final_candidate_contract_id = active.contract_id;
  state.structured_output.final_candidate_sha256 = sha256(finalOutput);
}

function semanticReviewIsResolved(state: TaskState, validation: StructuredOutputValidation): boolean {
  const latest = [...state.quality_gate.resolutions].reverse().find((resolution) => resolution.target_kind === "semantic-review"
    && resolution.target_id === validation.id
    && resolution.contract_id === validation.contract_id
    && resolution.candidate_sha256 === validation.candidate_sha256);
  return Boolean(latest && latest.decision === "approved" && qualityGateResolutionIsCurrent(state, latest));
}

export function activeOutputContract(state: TaskState): StructuredOutputContract | undefined {
  return state.structured_output.active_contract_id
    ? state.structured_output.contracts.find((contract) => contract.contract_id === state.structured_output.active_contract_id)
    : undefined;
}

export function evaluateStructuredOutputCompletionRequirement(state: TaskState, requireFinalOutput = true): { decision: CompletionDecision; reasons: string[]; evidence_refs: string[] } | undefined {
  const active = activeOutputContract(state);
  if (state.lane !== "structured-output" && !active && state.structured_output.validations.length === 0) return undefined;
  if (!active) return { decision: "fail", reasons: ["Structured-output work has no active user-confirmed output contract."], evidence_refs: [] };
  if (!outputContractIsCurrent(state, active)) {
    return { decision: "escalate", reasons: [`Output contract ${active.contract_id} is not bound to the current Pi session branch.`], evidence_refs: [active.contract_id] };
  }
  const latest = [...state.structured_output.validations].reverse().find((validation) => validation.contract_id === active.contract_id && !validation.superseded_by_contract_id);
  if (!latest) return { decision: "fail", reasons: [`Output contract ${active.contract_id} has no validated candidate.`], evidence_refs: [active.contract_id] };
  if (!outputValidationIsCurrent(state, latest)) {
    return { decision: "escalate", reasons: [`Output validation ${latest.id} lacks current contract/session provenance.`], evidence_refs: [active.contract_id, latest.id] };
  }
  if (!latest.syntax_valid || !latest.schema_valid) {
    return { decision: "fail", reasons: latest.reasons, evidence_refs: [active.contract_id, latest.id] };
  }
  if (latest.human_review_required && !semanticReviewIsResolved(state, latest)) {
    return { decision: "escalate", reasons: latest.reasons, evidence_refs: [active.contract_id, latest.id] };
  }
  if (requireFinalOutput && (state.structured_output.final_candidate_contract_id !== active.contract_id || state.structured_output.final_candidate_sha256 !== latest.candidate_sha256)) {
    return { decision: "escalate", reasons: [`Final assistant output does not exactly match validated candidate ${latest.id}.`], evidence_refs: [active.contract_id, latest.id] };
  }
  return {
    decision: "pass",
    reasons: [`Output contract ${active.contract_id} passed deterministic syntax and structural validation. No factual, extraction, or behavioral requirement was promoted by this result.`],
    evidence_refs: [active.contract_id, latest.id],
  };
}

export function formatStructuredOutputStatus(state: TaskState, maxCandidates = 3): string {
  const active = activeOutputContract(state);
  if (!active) return "Structured output: no active user-confirmed contract.";
  const latest = [...state.structured_output.validations].reverse().find((item) => item.contract_id === active.contract_id && !item.superseded_by_contract_id);
  return [
    `Structured output contract ${active.contract_id}: ${active.definition.format}, ${active.definition.semantic}, hash ${active.contract_sha256.slice(0, 12)}.`,
    `Candidates: ${state.structured_output.total_candidates_used}/${maxCandidates} task-wide; latest ${latest ? `${latest.id} ${latest.decision} (syntax=${latest.syntax_valid}, schema=${latest.schema_valid}, semantic=${latest.semantic_check_state}, human-review=${latest.human_review_required})` : "none"}.`,
  ].join("\n");
}

export function outputContractReceiptData(state: TaskState, contractId: string, draft: OutputContractDraft): Record<string, string> {
  return {
    task_id: state.task_id,
    contract_id: contractId,
    contract_sha256: draft.sha256,
    definition_sha256: draft.definition_sha256,
    contract_path: draft.path,
  };
}

export function outputValidationReceiptData(state: TaskState, validationId: string, proposal: OutputValidationProposal): Record<string, string> {
  return {
    task_id: state.task_id,
    validation_id: validationId,
    contract_id: proposal.contract_id,
    contract_sha256: proposal.contract_sha256,
    candidate_sha256: proposal.candidate_sha256,
    result_sha256: proposal.result_sha256,
  };
}

export function outputReceiptHash(customType: string, data: Record<string, string>): string {
  return nativeAuthorityReceiptHash(customType, data);
}

export function isStructuredOutputId(value: unknown, prefix: "OC" | "OV"): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}[1-9][0-9]*$`).test(value);
}

export function isStructuredOutputHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}
