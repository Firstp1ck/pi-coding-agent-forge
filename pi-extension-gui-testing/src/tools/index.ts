/** Model-facing tools and the runtime they share with commands (spec §8). */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGuiTools } from "./tools.ts";
import type { GuiRuntime } from "./runtime.ts";

export * from "./runtime.ts";
export * from "./tools.ts";

/** Registers the eight `gui_*` tools with Pi. */
export function registerGuiTools(pi: ExtensionAPI, runtime: GuiRuntime): void {
  for (const tool of createGuiTools(runtime)) pi.registerTool(tool);
}
