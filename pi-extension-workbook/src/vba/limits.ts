import { createHash } from "node:crypto";
import { fail } from "../errors.ts";

export type VbaOperation =
  | { type: "addModule"; name: string; kind: "standard" | "class"; code: string }
  | { type: "replaceModuleCode"; name: string; code: string }
  | { type: "removeModule"; name: string };
export const VBA_LIMITS: { maxOperations: 50; maxModuleCodeBytes: 262144; maxReadCodeChars: 200000 } = {
  maxOperations: 50, maxModuleCodeBytes: 262144, maxReadCodeChars: 200000,
};

const MODULE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,30}(?![\s\S])/;

export function vbaCodeSha256(code: string): string {
  return createHash("sha256").update(code.replace(/\r\n?/g, "\n").replace(/\n+$/, ""), "utf8").digest("hex");
}

export function validateVbaOperations(operations: unknown[]): VbaOperation[] {
  if (!Array.isArray(operations) || operations.length === 0) fail("INVALID_ARGUMENT", "At least one VBA operation is required.");
  if (operations.length > VBA_LIMITS.maxOperations) fail("LIMIT_EXCEEDED", "At most 50 VBA operations are allowed.");
  const names = new Set<string>();
  return Array.from(operations, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_ARGUMENT", "VBA operations must be objects.");
    const op = value as Record<string, unknown>;
    if (typeof op.type !== "string" || !["addModule", "replaceModuleCode", "removeModule"].includes(op.type)) fail("UNSUPPORTED_FEATURE", "Unsupported VBA operation type.");
    if (typeof op.name !== "string" || !MODULE_NAME.test(op.name)) fail("INVALID_ARGUMENT", "VBA module names must match ^[A-Za-z][A-Za-z0-9_]{0,30}$.");
    const nameKey = op.name.toLowerCase();
    if (names.has(nameKey)) fail("INVALID_ARGUMENT", `Duplicate VBA target: ${op.name}`);
    names.add(nameKey);
    const keys = op.type === "addModule" ? ["type", "name", "kind", "code"] : op.type === "replaceModuleCode" ? ["type", "name", "code"] : ["type", "name"];
    if (Object.keys(op).some((key) => !keys.includes(key))) fail("INVALID_ARGUMENT", "Unexpected VBA operation property.");
    if (op.type === "addModule" && op.kind !== "standard" && op.kind !== "class") fail("UNSUPPORTED_FEATURE", "Only standard and class modules can be added.");
    if (op.type !== "removeModule") {
      if (typeof op.code !== "string") fail("INVALID_ARGUMENT", "VBA code must be a string.");
      if (Buffer.byteLength(op.code, "utf8") > VBA_LIMITS.maxModuleCodeBytes) fail("LIMIT_EXCEEDED", "VBA code exceeds 256 KiB per module.");
      if (/[^\x20-\x7e\t\r\n]/.test(op.code)) fail("INVALID_ARGUMENT", "VBA code must contain only printable ASCII, tabs, and newlines.");
      if (/^[\t ]*Attribute[\t ]+VB_/im.test(op.code.replace(/\r\n?/g, "\n"))) fail("UNSUPPORTED_FEATURE", "Attribute VB_ lines cannot be supplied to CodeModule.");
    }
    if (op.type === "addModule") return { type: "addModule", name: op.name, kind: op.kind as "standard" | "class", code: op.code as string };
    if (op.type === "replaceModuleCode") return { type: "replaceModuleCode", name: op.name, code: op.code as string };
    return { type: "removeModule", name: op.name };
  });
}

