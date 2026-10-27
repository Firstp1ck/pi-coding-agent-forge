import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  branchResourceDirective,
  isT3ResourceProfileContext,
  readResourceDefaults,
  resolveResourceSelection,
} from "@firstpick/pi-utils/resource-management";
import { registerScopedResourceCommand } from "@firstpick/pi-utils/scoped-resource-command";
import { initializeT3ResourceProfilesCompatibility } from "./src/t3-resource-profiles-compat.ts";
import { isT3NativeTool } from "./src/t3-native-tools.ts";

const CUSTOM_TYPE = "webui-tools-config";

type ToolsState = {
  enabledTools?: string[];
};

export function toolSourceLabel(tool: ToolInfo): string {
  const source = tool.sourceInfo?.source ?? "unknown";
  if (source === "builtin") return "Pi built-in";
  if (source === "sdk") return "SDK custom tools";
  return source.replace(/^extension:/, "");
}

export function toolResourcePresentation(tool: ToolInfo) {
  return {
    name: tool.name,
    discovery: toolSourceLabel(tool),
    description: tool.description,
  };
}

function lastBranchConfig(ctx: ExtensionContext): ToolsState | undefined {
  let found: ToolsState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) found = entry.data as ToolsState;
  }
  return found;
}

export default function toolsExtension(pi: ExtensionAPI) {
  let runtimeBaseline: string[] | undefined;
  let selectedTools: Set<string> | undefined;
  let generation = 0;
  let tuiActive = false;
  let t3Active = false;
  let t3RefreshTail: Promise<void> = Promise.resolve();

  const allToolNames = () => pi.getAllTools().map((tool) => tool.name).sort();
  const runtimeTools = () => runtimeBaseline ??= [...pi.getActiveTools()];

  function enforceSelection(ctx: ExtensionContext): ((name: string) => boolean) | undefined {
    const selection = selectedTools;
    const t3 = t3Active && isT3ResourceProfileContext(ctx);
    if (!((tuiActive && ctx.mode === "tui") || t3) || !selection) return undefined;
    const allowed = (name: string) => selection.has(name) || (t3 && isT3NativeTool(name));
    const active = pi.getActiveTools();
    const filtered = active.filter(allowed);
    // Do not reactivate allowed tools that another extension intentionally holds inactive.
    if (filtered.length !== active.length) pi.setActiveTools(filtered);
    return allowed;
  }

  async function recompute(ctx: ExtensionContext, model = ctx.model): Promise<boolean> {
    if (t3Active && isT3ResourceProfileContext(ctx)) return recomputeT3(ctx, model);
    const requestedKey = model?.provider && model?.id ? `${model.provider}\0${model.id}` : "";
    const currentGeneration = ++generation;
    let defaults;
    try {
      defaults = await readResourceDefaults();
    } catch (error) {
      ctx.ui.notify(`Tool defaults could not be read: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
    const currentKey = ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}\0${ctx.model.id}` : "";
    if (currentGeneration !== generation || currentKey !== requestedKey) return false;

    const directive = branchResourceDirective(lastBranchConfig(ctx), "tools");
    const resolved = directive.pinned
      ? { names: directive.names || [], source: "session" }
      : resolveResourceSelection(defaults, "tools", model?.provider, model?.id, runtimeTools());
    // Retain unavailable selected names so late registration can still enable them.
    selectedTools = resolved.source === "runtime" ? undefined : new Set<string>(resolved.names || []);
    const available = new Set(allToolNames());
    pi.setActiveTools((resolved.names || runtimeTools()).filter((name) => available.has(name)));
    return true;
  }

  function recomputeT3(ctx: ExtensionContext, model = ctx.model): Promise<boolean> {
    // Concurrent RPC prompt preparations must each finish a fresh read,
    // rather than invalidating one another and retaining an older selection.
    const session = ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager;
    const branch = JSON.stringify(lastBranchConfig(ctx));
    const result = t3RefreshTail.then(() => {
      if (!t3Active || !isT3ResourceProfileContext(ctx)
        || session !== (ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager)
        || branch !== JSON.stringify(lastBranchConfig(ctx))) return false;
      return readT3Policy(ctx, model);
    });
    t3RefreshTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readT3Policy(ctx: ExtensionContext, model = ctx.model): Promise<boolean> {
    const currentGeneration = ++generation;
    const modelKey = JSON.stringify([model?.provider, model?.id]);
    const branchKey = JSON.stringify(lastBranchConfig(ctx));
    const session = ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager;
    const isCurrent = () => currentGeneration === generation && t3Active && isT3ResourceProfileContext(ctx)
      && session === (ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager)
      && modelKey === JSON.stringify([ctx.model?.provider, ctx.model?.id])
      && branchKey === JSON.stringify(lastBranchConfig(ctx));
    let defaults;
    try {
      defaults = await readResourceDefaults();
    } catch (error) {
      if (isCurrent()) ctx.ui.notify(`Tool defaults could not be read: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
    if (!isCurrent()) return false;
    const directive = branchResourceDirective(lastBranchConfig(ctx), "tools");
    const resolved = directive.pinned
      ? { names: directive.names || [], source: "session" }
      : resolveResourceSelection(defaults, "tools", model?.provider, model?.id);
    const next = resolved.source === "runtime" ? undefined : new Set<string>(resolved.names || []);
    const previous = selectedTools;
    selectedTools = next;
    const unchanged = previous === undefined ? next === undefined
      : next !== undefined && previous.size === next.size && [...previous].every((name) => next.has(name));
    if (unchanged) {
      enforceSelection(ctx);
    } else {
      const available = new Set(allToolNames());
      // Restoring runtime removes the policy, including restrictions on later tools.
      const active = pi.getActiveTools();
      const names = next
        ? previous
          ? [...active.filter((name) => next.has(name)), ...[...next].filter((name) => !previous.has(name))]
          : [...next]
        : [...new Set([...runtimeTools(), ...active])];
      const retainedT3Tools = active.filter(isT3NativeTool);
      pi.setActiveTools([...new Set([...names, ...retainedT3Tools])].filter((name) => available.has(name)));
    }
    return true;
  }

  registerScopedResourceCommand(pi, {
    commandName: "tools",
    resourceType: "tools",
    resourceLabel: "Tools",
    selectionKey: "enabledTools",
    customType: CUSTOM_TYPE,
    getVisibleNames: async () => allToolNames(),
    getResourcePresentation: async () => pi.getAllTools().map(toolResourcePresentation),
    getRuntimeNames: async () => runtimeTools(),
    getEnabledNames: async () => [...(selectedTools ?? pi.getActiveTools())],
    recompute,
  });

  pi.on("session_start", async (_event, ctx) => {
    generation += 1;
    tuiActive = ctx.mode === "tui";
    t3Active = isT3ResourceProfileContext(ctx);
    if (t3Active) {
      runtimeBaseline ??= [...pi.getActiveTools()];
      await recomputeT3(ctx);
      return;
    }
    if (!tuiActive) return;
    runtimeBaseline ??= [...pi.getActiveTools()];
    await recompute(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    if (t3Active && isT3ResourceProfileContext(ctx)) await recomputeT3(ctx);
    if (tuiActive && ctx.mode === "tui") await recompute(ctx);
  });
  pi.on("model_select", async (event, ctx) => {
    if (t3Active && isT3ResourceProfileContext(ctx)) await recomputeT3(ctx, event.model);
    if (tuiActive && ctx.mode === "tui") await recompute(ctx, event.model);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (t3Active && isT3ResourceProfileContext(ctx)) await recomputeT3(ctx);
    enforceSelection(ctx);
  });
  pi.on("context_with_system", (event, ctx) => {
    const isAllowed = enforceSelection(ctx);
    if (!isAllowed) return;

    // The request may already contain declarations captured before a late registration
    // or reactivation. Append a removal delta without rewriting earlier tool history.
    const excluded = new Set<string>();
    for (const message of event.messages) {
      if (message.role !== "system") continue;
      for (const tool of message.toolsRemoved ?? []) excluded.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) {
        if (!isAllowed(tool.name)) excluded.add(tool.name);
      }
    }
    if (excluded.size === 0) return;
    return {
      messages: [...event.messages, {
        role: "system" as const,
        content: "",
        toolsRemoved: [...excluded].map((name) => ({ name })),
        timestamp: Date.now(),
      }],
    };
  });
  pi.on("tool_call", (event, ctx) => {
    const isAllowed = enforceSelection(ctx);
    if (isAllowed && !isAllowed(event.toolName)) {
      return { block: true, reason: `Tool "${event.toolName}" is disabled by the effective /tools selection.` };
    }
  });
  pi.on("session_shutdown", () => {
    tuiActive = false;
    t3Active = false;
    selectedTools = undefined;
    generation += 1;
  });

  return initializeT3ResourceProfilesCompatibility(pi);
}
