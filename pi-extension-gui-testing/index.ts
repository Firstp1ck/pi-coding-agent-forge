import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuiCommands } from "./src/commands/index.ts";
import { GuiRuntime, registerGuiTools } from "./src/tools/index.ts";

/**
 * Extension entry point for GUI testing (spec §8, §7a).
 *
 * Registers the `gui_*` tools and the `/gui-*` commands. Per the Pi extension
 * contract this factory starts nothing: sessions, containers, and timers are
 * created only by a tool or command. `session_start` runs the startup sweep in
 * the background; `session_shutdown` (quit, reload, session switch) stops every
 * session and cancels a running setup. A synchronous `exit` handler, installed
 * only while a session exists, removes containers Pi could not stop in time.
 *
 * @param pi Pi extension API for the current runtime.
 * @param runtime Shared state; Pi passes none. Test fixtures pass their own to observe sessions.
 */
export default function guiTesting(pi: ExtensionAPI, runtime: GuiRuntime = new GuiRuntime()): void {
  registerGuiTools(pi, runtime);
  registerGuiCommands(pi, runtime);
  pi.on("session_start", (_event, ctx) => {
    // Not awaited: the sweep must never delay Pi's startup.
    void runtime.sweep(ctx.cwd);
  });
  pi.on("session_shutdown", async () => {
    await runtime.shutdown();
  });
}
