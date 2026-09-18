import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SessionWriteProvenance = {
  path: string;
  toolName: "write" | "edit";
  toolCallId: string;
  source: "active-branch" | "live-event";
};

export type SessionWorkSnapshot = {
  paths: string[];
  provenance: SessionWriteProvenance[];
  taskContext: string[];
  warnings: string[];
};

type PendingCall = { toolName: string; input: Record<string, unknown>; branchEntryId?: string | null };

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => plain(part) && part.type === "text" && typeof part.text === "string").map((part) => String(part.text)).join("\n");
}

function safeRelativePath(cwd: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.includes("\0")) return undefined;
  const absolute = path.resolve(cwd, value.replace(/^@/u, ""));
  const relative = path.relative(path.resolve(cwd), absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  const canonical = relative.split(path.sep).join("/");
  return canonical.split("/").every((part) => part && part !== "." && part !== "..") ? canonical : undefined;
}

function collectBranchCalls(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): { provenance: SessionWriteProvenance[]; warnings: string[] } {
  const pending = new Map<string, PendingCall>();
  const provenance: SessionWriteProvenance[] = [];
  const warnings = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
    if (message.role === "bashExecution") {
      warnings.add("A user shell command occurred in this session. Its file changes cannot be attributed exactly.");
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!plain(part) || part.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string" || !plain(part.arguments)) continue;
        pending.set(part.id, { toolName: part.name, input: part.arguments });
        if (!["read", "grep", "find", "ls", "write", "edit"].includes(part.name)) warnings.add(`Tool ${part.name} may have changed files, but exact attribution is unavailable.`);
      }
      continue;
    }
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const call = pending.get(message.toolCallId);
    if (!call || message.isError) continue;
    if (call.toolName === "write" || call.toolName === "edit") {
      const relative = safeRelativePath(ctx.cwd, call.input.path);
      if (relative) provenance.push({ path: relative, toolName: call.toolName, toolCallId: message.toolCallId, source: "active-branch" });
      else warnings.add(`${call.toolName} completed with a path that cannot be attributed inside the current project.`);
    }
  }
  return { provenance, warnings: [...warnings] };
}

function collectTaskContext(ctx: Pick<ExtensionContext, "sessionManager">, maxBytes: number): string[] {
  const candidates: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message") {
      const message = entry.message as { role?: string; content?: unknown };
      if (message.role === "user") {
        const text = textContent(message.content).trim();
        if (text) candidates.push(text);
      }
    } else if (entry.type === "compaction" && entry.summary.trim()) {
      candidates.push(`Session summary: ${entry.summary.trim()}`);
    } else if (entry.type === "branch_summary" && entry.summary.trim()) {
      candidates.push(`Branch summary: ${entry.summary.trim()}`);
    }
  }
  const selected: string[] = [];
  let bytes = 2;
  for (const candidate of candidates.reverse()) {
    const bounded = candidate.slice(0, 16_000);
    const added = Buffer.byteLength(JSON.stringify(bounded), "utf8") + 1;
    if (bytes + added > maxBytes) continue;
    selected.unshift(bounded);
    bytes += added;
  }
  return selected;
}

/** Track finalized live tool results without treating shell or custom tools as exact file provenance. */
export function createSessionWorkTracker() {
  const pending = new Map<string, PendingCall>();
  const provenance = new Map<string, SessionWriteProvenance & { branchEntryId?: string | null }>();
  const warnings = new Map<string, { text: string; branchEntryId?: string | null }>();
  const warn = (text: string, branchEntryId?: string | null) => warnings.set(`${branchEntryId ?? "current"}\0${text}`, { text, branchEntryId });
  return {
    observeToolCall(event: { toolCallId: string; toolName: string; input: Record<string, unknown> }, branchEntryId?: string | null): void {
      pending.set(event.toolCallId, { toolName: event.toolName, input: { ...event.input }, branchEntryId });
      if (!["read", "grep", "find", "ls", "write", "edit"].includes(event.toolName)) warn(`Tool ${event.toolName} may have changed files, but exact attribution is unavailable.`, branchEntryId);
    },
    observeToolResult(event: { toolCallId: string; toolName: string; isError: boolean }, cwd: string): void {
      const call = pending.get(event.toolCallId);
      pending.delete(event.toolCallId);
      if (!call || event.isError || (call.toolName !== "write" && call.toolName !== "edit")) return;
      const relative = safeRelativePath(cwd, call.input.path);
      if (!relative) {
        warn(`${call.toolName} completed with a path that cannot be attributed inside the current project.`, call.branchEntryId);
        return;
      }
      provenance.set(`${event.toolCallId}\0${relative}`, { path: relative, toolName: call.toolName, toolCallId: event.toolCallId, source: "live-event", branchEntryId: call.branchEntryId });
    },
    observeUserShell(branchEntryId?: string | null): void {
      warn("A user shell command occurred in this session. Its file changes cannot be attributed exactly.", branchEntryId);
    },
    snapshot(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, maxContextBytes: number): SessionWorkSnapshot {
      const branch = collectBranchCalls(ctx);
      const branchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
      const onBranch = (branchEntryId: string | null | undefined) => branchEntryId === undefined || branchEntryId === null || branchIds.has(branchEntryId);
      const merged = new Map<string, SessionWriteProvenance>();
      for (const item of branch.provenance) merged.set(`${item.toolCallId}\0${item.path}`, item);
      for (const { branchEntryId: _branchEntryId, ...item } of provenance.values()) {
        if (onBranch(_branchEntryId)) merged.set(`${item.toolCallId}\0${item.path}`, item);
      }
      const items = [...merged.values()].sort((left, right) => left.path.localeCompare(right.path) || left.toolCallId.localeCompare(right.toolCallId));
      const liveWarnings = [...warnings.values()].filter((item) => onBranch(item.branchEntryId)).map((item) => item.text);
      return {
        paths: [...new Set(items.map((item) => item.path))],
        provenance: items,
        taskContext: collectTaskContext(ctx, maxContextBytes),
        warnings: [...new Set([...branch.warnings, ...liveWarnings])].sort(),
      };
    },
    clear(): void {
      pending.clear();
      provenance.clear();
      warnings.clear();
    },
  };
}
