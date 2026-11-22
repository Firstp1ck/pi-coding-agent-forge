/** Model-facing text for tool results (spec §8). */
import { ownedSlice } from "../framing/log-event.ts";
import type { Leftover, TreeNode } from "../protocol.ts";
import type { UsageWarning } from "../usage/types.ts";

function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${ownedSlice(flat, 0, max - 1)}…` : ownedSlice(flat);
}

/** One indented line per node: `ref role "name" value=… [states] @x,y w×h`. */
export function renderTree(tree: readonly TreeNode[]): string {
  const depth = new Map<string, number>();
  const lines: string[] = [];
  for (const node of tree) {
    const d = node.parent !== undefined ? (depth.get(node.parent) ?? 0) + 1 : 0;
    depth.set(node.ref, d);
    const parts = [`${"  ".repeat(Math.min(d, 20))}${node.ref}`, node.role || "(no role)"];
    if (node.name) parts.push(JSON.stringify(clip(node.name)));
    if (node.value) parts.push(`value=${JSON.stringify(clip(node.value, 80))}`);
    const states = node.states.filter((s) => s !== "visible" && s !== "showing");
    if (states.length > 0) parts.push(`[${states.join(",")}]`);
    if (node.bounds) parts.push(`@${node.bounds.x},${node.bounds.y} ${node.bounds.width}×${node.bounds.height}`);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

export function formatLeftovers(leftovers: readonly Leftover[]): string {
  return leftovers.map((l) => `${l.kind} ${l.id}${l.detail ? ` (${l.detail})` : ""}`).join("; ");
}

/** Text appended to a result that carries usage warnings (spec §8.1): the model is told to stop and reassess. */
export function formatUsageWarnings(warnings: readonly UsageWarning[]): string {
  return warnings.map((w) => `usageWarning (${w.signal}): ${w.message}`).join("\n");
}

/** Note attached to results that mention temp paths (spec §7a.2). */
export const TEMP_NOTE = "Files under the session temp dir are deleted by gui_stop; copy them out with gui_export first if they are needed.";
