import type { ShellOperation, SourceRange } from "./shell-analysis.ts";

export type CommandTrigger = { reason: string; range?: SourceRange };

/** Locate the actual matched pattern in source or a same-length masked source. */
export function patternMatchRange(text: string, pattern: RegExp): SourceRange | undefined {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  pattern.lastIndex = 0;
  return match?.[0] ? { start: match.index, end: match.index + match[0].length } : undefined;
}

/** Map a risk match in normalized argv back to the original quoted source. */
export function operationMatchRange(command: string, operation: Pick<ShellOperation, "argv"> & { argumentRanges?: SourceRange[] }, pattern: RegExp, matchingText = operation.argv.join(" ")): SourceRange | undefined {
  pattern.lastIndex = 0;
  const match = pattern.exec(matchingText);
  pattern.lastIndex = 0;
  if (!match?.[0] || !operation.argumentRanges) return undefined;
  const matchEnd = match.index + match[0].length;
  let offset = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const [index, value] of operation.argv.entries()) {
    const valueEnd = offset + value.length;
    if (valueEnd > match.index && offset < matchEnd) {
      const range = operation.argumentRanges[index];
      if (!range) return undefined;
      const raw = command.slice(range.start, range.end);
      const quoted = (raw.startsWith("'") || raw.startsWith('"')) && raw.at(-1) === raw[0] && raw.slice(1, -1) === value;
      if (!quoted && raw !== value) return undefined;
      const from = Math.max(0, match.index - offset);
      const to = Math.min(value.length, matchEnd - offset);
      start ??= range.start + from + (quoted && from > 0 ? 1 : 0);
      end = quoted && to === value.length ? range.end : range.start + (quoted ? 1 : 0) + to;
    }
    offset = valueEnd + 1;
  }
  return start === undefined || end === undefined ? undefined : { start, end };
}

function escaped(text: string): string {
  return JSON.stringify(text).slice(1, -1).replace(/[\u007f-\u009f\u2028\u2029]/gu,
    (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Render a bounded source excerpt. Markers are display-only, never command input. */
export function formatCommandTrigger(command: string, { reason, range }: CommandTrigger, highlight: (text: string) => string = (text) => text): string {
  if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end)
    || range.start < 0 || range.end < range.start || range.end > command.length) {
    return `${escaped(reason)}\nNo specific snippet identified. Approval is required for the whole command.`;
  }
  const { start, end } = range;
  const lineStart = command.slice(0, start).lastIndexOf("\n") + 1;
  const nextLine = command.indexOf("\n", end);
  const lineEnd = nextLine < 0 ? command.length : nextLine;
  const line = command.slice(0, start).split("\n").length;
  const column = [...command.slice(lineStart, start)].length + 1;
  const prefixStart = Math.max(lineStart, start - 60);
  const suffixEnd = Math.min(lineEnd, end + 60);
  const fragment = command.slice(start, end);
  const marked = !fragment ? "[missing syntax here]" : fragment.length <= 240 ? escaped(fragment)
    : `${escaped(fragment.slice(0, 120))} ... [snippet truncated] ... ${escaped(fragment.slice(-120))}`;
  const prefix = `${prefixStart > lineStart ? "... " : ""}${escaped(command.slice(prefixStart, start))}`;
  const suffix = `${escaped(command.slice(end, suffixEnd))}${suffixEnd < lineEnd ? " ..." : ""}`;
  return `${escaped(reason)}\nL${line}:C${column}  ${prefix}${highlight(`>>> ${marked} <<<`)}${suffix}`;
}
