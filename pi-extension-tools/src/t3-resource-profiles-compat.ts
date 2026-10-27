import { parseArgs } from "@earendil-works/pi-coding-agent";
import type { Args, ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readResourceDefaults, branchResourceDirective, resolveResourceSelection, isT3ResourceProfileContext } from "@firstpick/pi-utils/resource-management";
import { isT3NativeTool } from "./t3-native-tools.ts";

const PROFILE_ENV = "T3_PI_RESOURCE_PROFILES";
const BRIDGE_FILENAME = "pi-t3-mcp-extension.ts";
const RUNTIME_MODES = new Set(["approval-required", "auto-accept-edits", "auto", "full-access"]);

type LaunchArgs = Pick<Args, "mode" | "extensions" | "noSession" | "noExtensions" | "noTools">;

function isT3ChatLaunch(args: LaunchArgs, env: NodeJS.ProcessEnv): boolean {
  if (args.mode !== "rpc") return false;
  if (args.noSession || args.noExtensions || args.noTools) return false;
  if (!env.T3_MCP_URL || !env.T3_MCP_BEARER_TOKEN || !RUNTIME_MODES.has(env.T3_PI_RUNTIME_MODE ?? "")) return false;
  return (args.extensions ?? []).some((extension) =>
    extension.replaceAll("\\", "/").split("/").at(-1) === BRIDGE_FILENAME,
  );
}

/** Identify legacy T3 chat launches without giving inherited ownership to children. */
export function isLegacyT3ResourceLaunch(args: LaunchArgs, env: NodeJS.ProcessEnv): boolean {
  return env[PROFILE_ENV] === undefined && isT3ChatLaunch(args, env);
}

type Selection = ReadonlySet<string> | null;

function selectedEntries<T extends { name: string }>(entries: readonly T[], selection: Selection): readonly T[] {
  return selection === null ? entries : entries.filter((entry) => selection.has(entry.name) || isT3NativeTool(entry.name));
}

/** Apply the Pi selection to discovery catalogs without hiding T3's native tools. */
export function scopeDiscoveryTool<TParams extends ToolDefinition["parameters"], TDetails, TState>(
  definition: ToolDefinition<TParams, TDetails, TState>,
  currentSelection: () => Selection,
  refreshSelection: (ctx: ExtensionContext) => Promise<Selection>,
): ToolDefinition<TParams, TDetails, TState> {
  return {
    ...definition,
    prepareLoadout: definition.prepareLoadout && ((loadout) => {
      const selection = currentSelection();
      return definition.prepareLoadout!({
        ...loadout,
        declared: selectedEntries(loadout.declared, selection),
        callable: selectedEntries(loadout.callable, selection),
        registered: selectedEntries(loadout.registered, selection),
      });
    }),
    async execute(id, params, signal, onUpdate, ctx) {
      const selection = await refreshSelection(ctx);
      // Pi defines executeTool and its guarded getters as non-enumerable.
      // Copy descriptors so catalog scoping does not drop or freeze them.
      const scopedContext: ExtensionToolContext = selection === null ? ctx : Object.defineProperties(
        Object.create(Object.getPrototypeOf(ctx)),
        {
          ...Object.getOwnPropertyDescriptors(ctx),
          tools: { get: () => selectedEntries(ctx.tools, selection) },
        },
      );
      return definition.execute(id, params, signal, onUpdate, scopedContext);
    },
  };
}

export function initializeT3ResourceProfilesCompatibility(
  pi: ExtensionAPI,
  args: LaunchArgs = parseArgs(process.argv.slice(2)),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> | undefined {
  const ownedMarker = `t3-v1:${process.pid}`;
  if (env[PROFILE_ENV] !== undefined && env[PROFILE_ENV] !== ownedMarker) return;
  if (!isT3ChatLaunch(args, env)) return;
  return installDiscoveryCompatibility(pi, env, ownedMarker);
}

async function installDiscoveryCompatibility(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv,
  ownedMarker: string,
): Promise<void> {
  const { createCodemodeExtension, createToolSearchExtension } = await import("@earendil-works/pi-coding-agent");

  // Bind before session_start, retaining ownership when Pi reloads this runtime.
  // Raw requests and markers inherited from another process are never rebound.
  env[PROFILE_ENV] = ownedMarker;
  let selection: Selection = new Set();
  let hasSelection = false;

  async function refreshSelection(ctx: ExtensionContext): Promise<Selection> {
    if (!isT3ResourceProfileContext(ctx, env)) return selection = null;
    try {
      const defaults = await readResourceDefaults();
      let branchConfig: unknown;
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === "webui-tools-config") branchConfig = entry.data;
      }
      const directive = branchResourceDirective(branchConfig, "tools");
      const resolved = directive.pinned
        ? { names: directive.names }
        : resolveResourceSelection(defaults, "tools", ctx.model?.provider, ctx.model?.id);
      selection = resolved.names === null ? null : new Set<string>(resolved.names ?? []);
      hasSelection = true;
      return selection;
    } catch (error) {
      if (!hasSelection) throw error;
      return selection;
    }
  }

  pi.on("session_start", (_event, ctx) => refreshSelection(ctx).then(() => undefined));
  pi.on("before_agent_start", (_event, ctx) => refreshSelection(ctx).then(() => undefined));
  pi.on("session_shutdown", () => { selection = new Set(); hasSelection = false; });

  // Deferred tools remain callable when merely deactivated. Scope the native
  // discovery implementations as well, so their catalogs cannot reveal excluded Pi tools.
  const scopedAPI: ExtensionAPI = {
    ...pi,
    getAllTools: () => [...selectedEntries(pi.getAllTools(), selection)],
    registerTool: (definition) => pi.registerTool(scopeDiscoveryTool(definition, () => selection, refreshSelection)),
  };
  createCodemodeExtension()(scopedAPI);
  createToolSearchExtension()(scopedAPI);
}
