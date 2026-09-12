import type { CommandTrigger } from "./trigger.ts";

/** Combine synonymous display labels without changing the underlying risk rules. */
export function displayRiskLabels(labels: readonly string[]): string[] {
  const unique = [...new Set(labels)];
  const combinedRm = unique.includes("recursive force rm") || unique.includes("force rm") && unique.includes("recursive rm");
  return [...new Set(unique.map((label) => combinedRm && ["force rm", "recursive rm", "recursive force rm"].includes(label)
    ? "recursive force rm" : label))];
}

/** Merge overlapping display spans only. Separate occurrences remain separate. */
export function mergePromptTriggers(command: string, triggers: readonly CommandTrigger[]): CommandTrigger[] {
  const located: { start: number; end: number; reasons: string[] }[] = [];
  const unlocated: string[] = [];
  for (const { reason, range } of triggers) {
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end)
      || range.start < 0 || range.end <= range.start || range.end > command.length) {
      unlocated.push(reason);
      continue;
    }
    let { start, end } = range;
    // Boundary whitespace belongs to the regex match, not to the risky token.
    while (start < end && /\s/.test(command[start])) start++;
    while (end > start && /\s/.test(command[end - 1])) end--;
    if (start === end) { unlocated.push(reason); continue; }
    located.push({ start, end, reasons: [reason] });
  }
  located.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: typeof located = [];
  for (const span of located) {
    const previous = merged.at(-1);
    if (previous && span.start < previous.end) {
      previous.end = Math.max(previous.end, span.end);
      previous.reasons.push(...span.reasons);
    } else merged.push({ ...span, reasons: [...span.reasons] });
  }
  return [
    ...merged.map(({ start, end, reasons }) => ({ range: { start, end }, reason: displayRiskLabels(reasons).join("; ") })),
    ...displayRiskLabels(unlocated).map((reason) => ({ reason })),
  ];
}

export function escapePromptText(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Render complete source once, highlighting only validated source ranges. */
export function formatPromptCommand(command: string, triggers: readonly CommandTrigger[], highlight: (text: string) => string = (text) => text): string {
  let cursor = 0;
  const parts: string[] = [];
  for (const { range } of mergePromptTriggers(command, triggers)) {
    if (!range) continue;
    parts.push(escapePromptText(command.slice(cursor, range.start)));
    parts.push(highlight(`>>> ${escapePromptText(command.slice(range.start, range.end))} <<<`));
    cursor = range.end;
  }
  parts.push(escapePromptText(command.slice(cursor)));
  const lines = parts.join("").split("\n");
  return lines.map((line, index) => lines.length > 1 ? `${index + 1} | ${line}` : line).join("\n");
}
