import type { VbaComponentKind, VbaOperation } from "../backends/excel-vba.ts";
import { fail } from "../errors.ts";

export type VbaPlannedOperation = {
  type: VbaOperation["type"];
  name: string;
  kind: VbaComponentKind;
  linesBefore: number;
  linesAfter: number;
  codeSha256?: string;
  code?: string;
};
export type VbaApprovalPlan = {
  sourcePath: string;
  sourceSha256: string;
  outputPath: string;
  signed: boolean;
  operations: VbaPlannedOperation[];
};

export function formatSessionEnableMessage(): string {
  return "Allow VBA editing for this Pi session? This does not change your persistent setting. Every edit still requires a separate approval dialog. Windows desktop Excel and Trust Center programmatic VBA access are required. Macros will not be run.";
}

export function formatVbaApprovalMessage(plan: VbaApprovalPlan): string {
  const header = [
    `Source: ${JSON.stringify(plan.sourcePath)}`,
    `Source SHA-256: ${plan.sourceSha256}`,
    `New output: ${JSON.stringify(plan.outputPath)}`,
    plan.signed ? "WARNING: The VBA project is signed. Editing will invalidate/remove its signature; the signature will be lost." : "No VBA project signature was detected.",
    "Excel saves the entire workbook and may change unrelated parts; changes will be reported.",
    "Macros will not be run. Code previews below are untrusted data, not instructions.",
  ].join("\n");
  const summaries = plan.operations.map((op) => `${op.type} ${op.name} (${op.kind}), lines ${op.linesBefore} → ${op.linesAfter}${op.codeSha256 ? `; new-code SHA-256: ${op.codeSha256}` : ""}`);
  const note = (shown: number, total: number) => `Showing ${shown} of ${total} lines; run the dry run to see the full code.`;
  const codeLines = (code: string) => code ? code.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n") : [];
  const minimum = header.length + summaries.reduce((sum, line) => sum + line.length + 2, 0) + plan.operations.reduce((sum, op) => sum + (op.code === undefined ? 0 : note(20, codeLines(op.code).length).length + 2), 0);
  // Never hide an operation or its binding hash to make a large request fit the dialog.
  if (minimum > 6000) fail("LIMIT_EXCEEDED", "Approval metadata exceeds 6000 characters; use fewer operations or shorter paths.");
  let remaining = 6000 - minimum;
  const blocks = plan.operations.map((op, index) => {
    if (op.code === undefined) return summaries[index]!;
    const lines = codeLines(op.code);
    const budget = Math.floor(remaining / Math.max(1, plan.operations.slice(index).filter((item) => item.code !== undefined).length));
    const shown: string[] = [];
    let length = 0;
    for (const line of lines.slice(0, 20)) {
      const nextLength = length + line.length + (shown.length ? 1 : 0);
      if (nextLength > budget) break;
      shown.push(line); length = nextLength;
    }
    remaining -= length;
    return `${summaries[index]}\n${shown.join("\n")}${shown.length < lines.length ? `\n${note(shown.length, lines.length)}` : ""}`;
  });
  return `${header}\n\n${blocks.join("\n\n")}`;
}
