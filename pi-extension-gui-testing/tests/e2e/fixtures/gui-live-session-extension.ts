/**
 * Pi extension for the real-Pi exit test (plan S7, review fix Z16): the
 * package's own factory with the same lifecycle handlers, plus a command
 * `/e2e-gui-launch` that starts a live session through `gui_launch` and prints
 * its container, docker CLI pid, and temp dir on stderr. Pi then exits with
 * the session still running, so its shutdown path has to clean up.
 *
 *   pi -e tests/e2e/fixtures/gui-live-session-extension.ts -p "/e2e-gui-launch"
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import guiTesting from "../../../index.ts";
import { GuiRuntime } from "../../../src/tools/runtime.ts";
import { createGuiTools } from "../../../src/tools/tools.ts";

/** Marker of the stderr line with the session facts. */
export const SESSION_MARKER = "E2E-GUI-SESSION";

export default function e2eSessionExtension(pi: ExtensionAPI): void {
  const runtime = new GuiRuntime();
  guiTesting(pi, runtime);
  const launch = createGuiTools(runtime).find((tool) => tool.name === "gui_launch")!;
  pi.registerCommand("e2e-gui-launch", {
    description: "e2e only: start a GUI session and leave it running",
    handler: async (_args, ctx) => {
      const params = { cmd: "python3", args: ["/opt/pi-gui-testing/testapps/gtk3-smoke/app.py"] };
      // Commands get a command context; gui_launch only reads what both share (cwd, UI, session id).
      const result = await launch.execute("e2e", params as never, undefined, undefined, ctx as never);
      const live = runtime.get(String(result.details.session));
      const session = live.session as typeof live.session & { containerName?: string; cliPid?: number; isOpen?: boolean };
      process.stderr.write(`${SESSION_MARKER} ${JSON.stringify({ session: live.id, container: session.containerName, cliPid: session.cliPid, dir: live.dir.path, open: session.isOpen })}\n`);
    },
  });
}
