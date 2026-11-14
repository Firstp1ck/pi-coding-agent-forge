/**
 * Stand-in for a Pi process in the crash tests (plan S7): loads the same
 * runtime and tools the extension registers, starts one session with
 * gui_launch, prints one JSON line, then follows stdin commands
 * (`stop`, `exit`). The tests SIGKILL / SIGSTOP this process.
 *
 * Usage: node --experimental-strip-types host.mjs '<json options>'
 *   options: { project, tmpRoot, globalConfigPath, heartbeatTimeoutMs? }
 */
import { createInterface } from "node:readline";
import { GuiRuntime } from "../../../src/tools/runtime.ts";
import { createGuiTools } from "../../../src/tools/tools.ts";

const options = JSON.parse(process.argv[2]);
const runtime = new GuiRuntime({
  tmpRoot: options.tmpRoot,
  globalConfigPath: options.globalConfigPath,
  docker: options.heartbeatTimeoutMs ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs } : {},
});
const tools = Object.fromEntries(createGuiTools(runtime).map((t) => [t.name, t]));
const ctx = { cwd: options.project, hasUI: false, mode: "print", sessionManager: { getSessionId: () => "pi-e2e-host" }, ui: { notify() {}, setStatus() {} } };
const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

try {
  const launched = await tools.gui_launch.execute("host", { cmd: "python3", args: ["/opt/pi-gui-testing/testapps/gtk3-smoke/app.py"] }, undefined, undefined, ctx);
  const live = runtime.get(launched.details.session);
  say({ ready: true, session: live.id, container: live.session.containerName, dir: live.dir.path, cliPid: live.session.cliPid, pid: process.pid });
} catch (error) {
  say({ ready: false, error: error.message });
  process.exit(1);
}

for await (const line of createInterface({ input: process.stdin })) {
  const [command, arg] = line.trim().split(/\s+/);
  try {
    if (command === "stop") {
      const result = await tools.gui_stop.execute("host", { session: arg }, undefined, undefined, ctx);
      say({ stopped: true, text: result.content[0].text });
    } else if (command === "snapshot") {
      const result = await tools.gui_snapshot.execute("host", { session: arg }, undefined, undefined, ctx);
      say({ snapshot: true, text: result.content[0].text });
    } else if (command === "exit") {
      await runtime.shutdown();
      say({ exited: true });
      process.exit(0);
    }
  } catch (error) {
    say({ error: error.message });
  }
}
