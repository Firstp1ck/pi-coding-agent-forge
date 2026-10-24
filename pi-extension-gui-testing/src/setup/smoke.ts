/**
 * Smoke test (spec §5.5) for `docker-linux`: start a session on an empty
 * workspace, launch the bundled GTK 3 app, find its button by name, click it,
 * see the label change, take a valid non-uniform screenshot, stop, and require
 * an empty footprint audit. Isolation is guaranteed by construction and by
 * `isolation.inspect`, which ran before.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendId, ResolvedConfig } from "../config/types.ts";
import { DEFAULTS } from "../config/types.ts";
import { PROTOCOL_VERSION, type TreeNode } from "../protocol.ts";
import { decodePng, isUniform } from "../tools/png.ts";
import type { GuiRuntime, LiveSession } from "../tools/runtime.ts";
import type { SmokeOutcome } from "./flow.ts";

/** The GTK 3 smoke app baked into the base image (spec §4.1). */
export const SMOKE_APP = { cmd: "python3", args: ["/opt/pi-gui-testing/testapps/gtk3-smoke/app.py"] } as const;
export const SMOKE_WINDOW_TITLE = "Pi GUI smoke";
export const SMOKE_BUTTON = "Press me";
export const SMOKE_LABEL_AFTER = "Pressed";

/** Config of the smoke session: no setup, no network, an empty read-only workspace. */
export function smokeConfig(): ResolvedConfig {
  return {
    shared: { targets: ["linux"], workspaceMode: "mount", network: "none", launch: { cmd: SMOKE_APP.cmd, args: [...SMOKE_APP.args] } },
    limits: { ...DEFAULTS.limits },
    usageCheck: { ...DEFAULTS.usageCheck },
    keepSandbox: false,
    warnings: [],
  };
}

export interface SmokeOptions {
  runtime: GuiRuntime;
  backend: BackendId;
  piSessionId: string;
  signal: AbortSignal;
  onStatus?: (text: string | undefined) => void;
}

function findNode(tree: readonly TreeNode[], roles: readonly string[], name: string): TreeNode | undefined {
  return tree.find((n) => roles.includes(n.role) && n.name === name);
}

/** Runs the smoke test; never leaves a session behind, even on failure or abort. */
export async function runSmokeTest(options: SmokeOptions): Promise<SmokeOutcome> {
  const { runtime, signal } = options;
  const version = runtime.backend(options.backend).version;
  const status = (text: string) => options.onStatus?.(`smoke test: ${text}`);
  const empty = await mkdtemp(join(runtime.options.tmpRoot ?? tmpdir(), "pi-gui-probe-"));
  let live: LiveSession | undefined;
  const started = Date.now();
  let outcome: SmokeOutcome;
  try {
    status("starting a session");
    live = await runtime.openSession({
      backend: options.backend,
      projectRoot: empty,
      config: smokeConfig(),
      piSessionId: options.piSessionId,
      signal,
      transient: true,
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    });
    const { session } = live;
    const step = (name: string) => status(name);
    step("launching the GTK 3 test app");
    const launched = await session.request("launch", { cmd: SMOKE_APP.cmd, args: [...SMOKE_APP.args], env: {}, cwd: "/workspace" }, { signal });
    const firstScreenshotAfter = Date.now() - started;
    if (!launched.windows.some((w) => w.title === SMOKE_WINDOW_TITLE)) {
      const waited = await session.request("wait", { for: "window", value: SMOKE_WINDOW_TITLE, timeoutMs: 10_000 }, { signal });
      if (!waited.matched) throw new Error(`window "${SMOKE_WINDOW_TITLE}" did not appear`);
    }
    step("finding the button in the accessibility tree");
    const snapshot = await session.request("snapshot", { maxNodes: 500 }, { signal });
    const button = findNode(snapshot.tree, ["button", "push button"], SMOKE_BUTTON);
    if (!button) throw new Error(`button "${SMOKE_BUTTON}" not found (coverage ${snapshot.coverage}, ${snapshot.tree.length} nodes)`);
    step("clicking the button");
    await session.request("act", { ref: button.ref, action: "click" }, { signal });
    const changed = await session.request("wait", { for: "text", value: SMOKE_LABEL_AFTER, timeoutMs: 5_000 }, { signal });
    if (!changed.matched) throw new Error(`label did not change to "${SMOKE_LABEL_AFTER}" after the click`);
    step("taking a screenshot");
    const shot = await session.request("screenshot", {}, { signal });
    const png = decodePng(Buffer.from(shot.png_base64, "base64"));
    const expected = { width: Math.round(shot.width * shot.scale), height: Math.round(shot.height * shot.scale) };
    if (Math.abs(png.width - expected.width) > 1 || Math.abs(png.height - expected.height) > 1) {
      throw new Error(`screenshot is ${png.width}×${png.height}, expected ${expected.width}×${expected.height}`);
    }
    if (isUniform(png.rgb)) throw new Error("screenshot is a single uniform colour");
    outcome = {
      ok: true,
      observed: `GTK 3 app launched, button found by name, click changed the label, ${png.width}×${png.height} screenshot valid (launch ${firstScreenshotAfter} ms)`,
      arch: session.arch,
      // Recorded for the drift check before each launch (see currentVersions of the backend).
      facts: { "smoke.arch": session.arch, protocol: String(PROTOCOL_VERSION), ...(version ? { "package.version": version } : {}) },
    };
  } catch (error) {
    if (signal.aborted) {
      await cleanup(runtime, live, empty);
      // Report why setup was cancelled, not which request noticed it.
      throw signal.reason ?? error;
    }
    outcome = { ok: false, observed: (error as Error)?.message ?? String(error) };
  }
  status("stopping and auditing");
  const leftovers = await cleanup(runtime, live, empty);
  if (leftovers.length > 0) return { ...outcome, leftovers };
  return outcome;
}

async function cleanup(runtime: GuiRuntime, live: LiveSession | undefined, empty: string) {
  const outcome = live ? await runtime.closeSession(live.id) : { stopLeftovers: [], audit: [] };
  await rm(empty, { recursive: true, force: true });
  return [...outcome.stopLeftovers, ...outcome.audit];
}
