/**
 * Model-facing tools (spec §8): launch, wait, snapshot, screenshot, act, logs,
 * stop, export. Every tool refuses unless the backend is set up and verified
 * (R8), never switches backends (R6), names the backend that ran, honours the
 * call's abort signal, and feeds the non-blocking usage check (§8.1).
 */
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { SessionError } from "../backend.ts";
import { hasDrift } from "../backends/capabilities.ts";
import { bindHost, hasRemoteHost } from "../backends/remote/host.ts";
import { decodeTreeDump } from "../backends/response.ts";
import type { TargetOs } from "../config/types.ts";
import { notSetUpMessage, verificationState } from "../config/verified.ts";
import type { ActAction, TreeNode, WaitFor } from "../protocol.ts";
import type { ToolName, UsageWarning } from "../usage/types.ts";
import { nextArtifactName, writeArtifact } from "./artifacts.ts";
import { exportArtifacts } from "./export.ts";
import { formatLeftovers, formatUsageWarnings, renderTree, TEMP_NOTE } from "./format.ts";
import type { GuiRuntime, LiveSession } from "./runtime.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolOutput {
  content: Content[];
  details: Record<string, unknown>;
}

export const DEFAULT_SNAPSHOT_NODES = 300;
export const MAX_SNAPSHOT_NODES = 5_000;
export const DEFAULT_WAIT_MS = 10_000;
export const MAX_WAIT_MS = 10 * 60_000;
export const DEFAULT_LOG_LINES = 100;

const sessionParam = Type.String({ description: "Session id returned by gui_launch, e.g. gui-1a2b3c4d" });
const actions = ["click", "double_click", "right_click", "type", "key", "scroll", "set_value"] as const;
const waits = ["window", "text", "ref", "idle"] as const;

const LAUNCH_PARAMS = Type.Object({
  target: Type.Optional(Type.String({ description: 'Target OS ("linux", "windows", or "macos"); each backend runs only its own targets. Default from .pi/gui.json.' })),
  cmd: Type.Optional(Type.String({ description: "Executable to start inside the session, relative to /workspace or on PATH. Default: launch.cmd from .pi/gui.json." })),
  args: Type.Optional(Type.Array(Type.String(), { description: "Arguments. Default: launch.args from .pi/gui.json." })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra environment variables for the app." })),
});
const WAIT_PARAMS = Type.Object({
  session: sessionParam,
  for: Type.Union(waits.map((w) => Type.Literal(w)), { description: "window: a window title contains value (or any window); text: an accessible name/value contains value; ref: the ref is showing; idle: the screen stopped changing" }),
  value: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WAIT_MS, description: `Default ${DEFAULT_WAIT_MS}` })),
});
const SNAPSHOT_PARAMS = Type.Object({
  session: sessionParam,
  maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SNAPSHOT_NODES, description: `Nodes returned inline (default ${DEFAULT_SNAPSHOT_NODES}); the full tree is saved to the session temp dir` })),
});
const SCREENSHOT_PARAMS = Type.Object({
  session: sessionParam,
  window: Type.Optional(Type.String({ description: "Window ref (win:0x…) from gui_launch or gui_snapshot; default the whole screen" })),
  maxEdge: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096, description: "Longest edge of the returned image in pixels (default 1280)" })),
});
const ACT_PARAMS = Type.Object({
  session: sessionParam,
  action: Type.Union(actions.map((a) => Type.Literal(a))),
  ref: Type.Optional(Type.String({ description: "Element ref from the latest gui_snapshot (preferred)" })),
  x: Type.Optional(Type.Number({ description: "X in the pixels of the latest gui_screenshot image, when the element has no ref" })),
  y: Type.Optional(Type.Number({ description: "Y in the pixels of the latest gui_screenshot image" })),
  captureId: Type.Optional(Type.String({ description: "Capture the coordinates refer to; default the latest screenshot" })),
  text: Type.Optional(Type.String({ description: 'type/set_value: the text; key: xdotool keys such as "ctrl+a BackSpace"; scroll: "up|down|left|right [1-100]"' })),
  screenshot: Type.Optional(Type.Boolean({ description: "Return a screenshot after the action (default false)" })),
});
const LOGS_PARAMS = Type.Object({
  session: sessionParam,
  tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 5_000, description: `Last lines to return (default ${DEFAULT_LOG_LINES})` })),
  source: Type.Optional(Type.Union([Type.Literal("app"), Type.Literal("setup")])),
});
const STOP_PARAMS = Type.Object({ session: sessionParam });
const EXPORT_PARAMS = Type.Object({
  session: sessionParam,
  dest: Type.String({ description: "Directory to copy screenshots, dumps, and logs into (relative to the project or absolute)" }),
});

function text(lines: (string | undefined)[]): Content {
  return { type: "text", text: lines.filter((l) => l !== undefined).join("\n") };
}

/** Message for a failed session request, with the spec's wording for stale refs and hand-offs. */
export function requestErrorMessage(error: unknown): string {
  if (error instanceof SessionError) {
    if (error.code === "STALE_REF") return `${error.message}; take a new gui_snapshot (or gui_screenshot for coordinates) and retry`;
    if (error.code === "HANDOFF") return `app handed off to another instance: ${error.message}`;
    return `${error.code}: ${error.message}`;
  }
  return (error as Error)?.message ?? String(error);
}

function rethrow(error: unknown): never {
  throw new Error(requestErrorMessage(error));
}

interface ToolEnv {
  runtime: GuiRuntime;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
}

/**
 * Shared frame of every session tool: verification, per-session order,
 * activity (from admission to the end of the call), usage, backend name, and
 * config warnings not yet shown. A session belongs to the backend that started
 * it: that backend is verified and named, whatever the active backend is now
 * (the active backend governs new launches only).
 */
async function onSession(
  env: ToolEnv,
  tool: ToolName,
  sessionId: string,
  run: (live: LiveSession) => Promise<{ output: ToolOutput; usage?: { action?: string; ref?: string; x?: number; y?: number; screenshotSha256?: string; allBlack?: boolean } }>,
): Promise<ToolOutput> {
  const { runtime, ctx } = env;
  // Admission is the call's arrival: before any await, so idle reaping never races it.
  const release = runtime.admit(sessionId);
  try {
    runtime.setNotifier(ctx.hasUI ? (m, t) => ctx.ui.notify(m, t) : undefined);
    const known = runtime.find(sessionId);
    // Without such a session, the active backend's state decides the refusal text (R8).
    const { config, global } = known ? await runtime.config(ctx.cwd).then(({ resolved, global }) => ({ config: resolved, global })) : await runtime.verifiedBackend(ctx.cwd);
    if (known && verificationState(global, known.backend).state !== "verified") throw new Error(notSetUpMessage(known.backend));
    let backend = known?.backend ?? "";
    const { output, usage } = await runtime.withSession(sessionId, (live) => {
      backend = live.backend;
      return run(live);
    });
    const warnings = runtime.recordUsage({ session: sessionId, tool, ...usage });
    return finish(output, backend, warnings, runtime.takeConfigWarnings(config.warnings));
  } finally {
    release();
  }
}

function finish(output: ToolOutput, backend: string, warnings: UsageWarning[], configWarnings: readonly string[] = []): ToolOutput {
  const content = [...output.content];
  const first = content.findIndex((c) => c.type === "text");
  const footer = [
    `backend: ${backend}`,
    configWarnings.length ? `config warnings:\n${configWarnings.map((w) => `- ${w}`).join("\n")}` : undefined,
    warnings.length ? formatUsageWarnings(warnings) : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  if (first === -1) content.unshift({ type: "text", text: footer });
  else content[first] = { type: "text", text: `${(content[first] as { text: string }).text}\n${footer}` };
  return {
    content,
    details: { ...output.details, backend, ...(warnings.length ? { usageWarning: warnings } : {}), ...(configWarnings.length ? { configWarnings: [...configWarnings] } : {}) },
  };
}

/** Saves a screenshot under a client-generated name (never a helper-supplied one). */
function saveScreenshot(live: LiveSession, pngBase64: string): Promise<string> {
  return writeArtifact(live.artifactsDir, nextArtifactName(live, "screenshot", "png"), Buffer.from(pngBase64, "base64"));
}

async function takeScreenshot(live: LiveSession, params: { window?: string; maxEdge?: number }, signal: AbortSignal | undefined) {
  const shot = await live.session.request("screenshot", { ...(params.window ? { window: params.window } : {}), ...(params.maxEdge ? { maxEdge: params.maxEdge } : {}) }, { signal }).catch(rethrow);
  const path = await saveScreenshot(live, shot.png_base64);
  live.lastCapture = { captureId: shot.captureId, target: shot.target, scale: shot.scale, width: shot.width, height: shot.height };
  const imageWidth = Math.round(shot.width * shot.scale);
  const imageHeight = Math.round(shot.height * shot.scale);
  const summary = [
    `screenshot ${shot.captureId} of ${shot.target}: image ${imageWidth}×${imageHeight}` +
      (shot.scale !== 1 ? ` (scaled ×${shot.scale} from ${shot.width}×${shot.height})` : "") +
      `, origin ${shot.origin.x},${shot.origin.y} on screen`,
    shot.allBlack ? "warning: the capture is entirely black" : undefined,
    `saved: ${path} (temporary)`,
  ].filter((line): line is string => line !== undefined);
  return { shot, path, imageWidth, imageHeight, summary };
}

function toolDefinition<P extends TSchema>(
  runtime: GuiRuntime,
  def: { name: ToolName; label: string; description: string; promptSnippet?: string; promptGuidelines?: string[]; parameters: P },
  run: (params: Static<P>, env: ToolEnv, onStatus: (text: string) => void) => Promise<ToolOutput>,
): ToolDefinition<P, Record<string, unknown>> {
  return {
    ...def,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const onStatus = (status: string) => onUpdate?.({ content: [{ type: "text", text: status }], details: { status } });
      // Pi bundles its own typebox copy, so its Static<P> differs nominally from ours.
      return run(params as unknown as Static<P>, { runtime, ctx, signal }, onStatus);
    },
  };
}

/** Workspace path of sessions whose backend does not report one. */
const DEFAULT_WORKSPACE_PATH = "/workspace";

const TARGET_NAMES: Record<TargetOs, string> = { linux: "Linux", windows: "Windows", macos: "macOS" };

/** "Linux", "Linux and Windows", "Linux, Windows, and macOS". */
function targetList(targets: readonly TargetOs[]): string {
  const names = targets.map((t) => TARGET_NAMES[t] ?? t);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/** The body of `gui_launch`: verification, drift check, session start, app launch. */
async function launchApp(params: Static<typeof LAUNCH_PARAMS>, rt: GuiRuntime, ctx: ExtensionContext, signal: AbortSignal | undefined, onStatus: (text: string) => void): Promise<ToolOutput> {
  // Captured before the first await: a call that outlives a shutdown starts nothing.
  const generation = rt.signal;
  const { id: backendId, backend, config, global } = await rt.verifiedBackend(ctx.cwd);
  const targets = config.shared.targets;
  const target = params.target ?? targets[0] ?? "linux";
  const supported = rt.registry.entry(backendId)?.targets ?? ["linux"];
  if (!supported.includes(target as TargetOs)) throw new Error(`backend "${backendId}" runs ${targetList(supported)} apps only; target "${target}" is not available on it`);
  // Remote backends observe the configured host, so a changed remote.host is drift (run /gui-doctor).
  // The host is bound to this launch (a view, and the session config); the shared backend never changes.
  const host = hasRemoteHost(backend) ? bindHost(backend, config.remote?.host ?? global.verified[backendId]?.inputs?.host).remoteHost : undefined;
  const view = bindHost(backend, host);
  if (hasDrift(view)) {
    let current: Record<string, string>;
    try {
      current = await view.currentVersions(signal);
    } catch (error) {
      throw new Error(`backend "${backendId}" is not reachable (${(error as Error).message}); ask the user to run /gui-doctor ${backendId}`);
    }
    const state = verificationState(global, backendId, current);
    if (state.state === "stale") throw new Error(state.message);
  }
  const configured = config.shared.launch;
  const cmd = params.cmd ?? configured?.cmd;
  if (!cmd) throw new Error('no app to launch: pass cmd, or add "launch": {"cmd": …} to .pi/gui.json');
  const args = params.args ?? (params.cmd ? [] : (configured?.args ?? []));
  const appEnv = { ...(configured?.env ?? {}), ...(params.env ?? {}) };
  const sessionConfig = { ...config, shared: { ...config.shared, launch: { cmd, args, env: appEnv } }, ...(host ? { remote: { ...config.remote, host } } : {}) };
  const live = await rt.openSession({
    backend: backendId,
    projectRoot: ctx.cwd,
    config: sessionConfig,
    piSessionId: ctx.sessionManager.getSessionId(),
    target: target as TargetOs,
    ...(signal ? { signal } : {}),
    generation,
    onStatus: (s) => s && onStatus(s),
  }).catch(rethrow);
  const workspace = live.session.workspacePath ?? DEFAULT_WORKSPACE_PATH;
  let launched;
  try {
    onStatus(`launching ${cmd}`);
    launched = await live.session.request("launch", { cmd, args, env: appEnv, cwd: workspace }, { signal });
  } catch (error) {
    const outcome = await rt.closeSession(live.id);
    const leftovers = [...outcome.stopLeftovers, ...outcome.audit];
    const logs = live.logs.tail(20, "app");
    throw new Error(
      `${requestErrorMessage(error)}; the session was stopped` +
        (leftovers.length ? `; leftovers: ${formatLeftovers(leftovers)}` : "") +
        (logs.length ? `\napp output:\n${logs.join("\n")}` : ""),
    );
  }
  const sync = live.session.sync;
  const backendWarnings = [...(live.session.warnings ?? [])];
  const depsCache = live.session.depsCache;
  // gui_launch always repeats the config warnings: it starts the session the config describes.
  rt.takeConfigWarnings(config.warnings);
  const configWarnings = config.warnings;
  const warnings = rt.recordUsage({ session: live.id, tool: "gui_launch", ...(sync ? { bytesSynced: sync.bytes } : {}) });
  const windows = launched.windows.map((w) => `${w.ref} "${w.title}" @${w.bounds.x},${w.bounds.y} ${w.bounds.width}×${w.bounds.height}`);
  return finish(
    {
      content: [
        text([
          `session ${live.id} started; app pid ${launched.pid} (${cmd}${args.length ? ` ${args.join(" ")}` : ""})`,
          `arch: ${live.session.arch}`,
          `workspace: ${live.session.workspaceDescription ?? (config.shared.workspaceMode === "copy" ? "writable filtered copy" : "read-only mount")} at ${workspace}; network: ${config.shared.network}`,
          sync ? `sync: ${sync.files} files, ${sync.bytes} bytes, ${sync.excluded} excluded` : undefined,
          depsCache ? `dependency cache: ${depsCache.detail}` : undefined,
          backendWarnings.length ? `${backendId} warnings:\n${backendWarnings.map((w) => `- ${w}`).join("\n")}` : undefined,
          windows.length ? `windows:\n${windows.join("\n")}` : "no window yet; use gui_wait for: window",
          launched.truncated ? "the window list was cut to the helper's result size (too many windows, or very long titles)" : undefined,
        ]),
      ],
      details: { session: live.id, arch: live.session.arch, pid: launched.pid, windows: launched.windows, ...(launched.truncated ? { windowsTruncated: true } : {}), ...(sync ? { sync } : {}), ...(depsCache ? { depsCache: { ...depsCache } } : {}), ...(backendWarnings.length ? { backendWarnings } : {}) },
    },
    backendId,
    warnings,
    configWarnings,
  );
}

/** Builds the eight tool definitions bound to `runtime`. */
export function createGuiTools(runtime: GuiRuntime): ToolDefinition<TSchema, Record<string, unknown>>[] {
  const launch = toolDefinition(
    runtime,
    {
      name: "gui_launch",
      label: "GUI launch",
      description:
        "Start an isolated GUI session (never on the user's desktop) and launch an app in it. Defaults come from .pi/gui.json (launch, setup, workspaceMode). " +
        "Returns the session id, backend, architecture, windows, and where the workspace is and whether the app can write to it (depends on the backend and workspaceMode).",
      promptSnippet: "Launch a GUI app in an isolated background session to inspect, operate, and screenshot it",
      promptGuidelines: [
        "Use gui_launch → gui_snapshot → gui_act by ref → gui_screenshot to check GUI work; use coordinates only when an element has no ref (coverage none, e.g. Tk).",
        "Use gui_wait instead of sleeping. Stop and reassess when a result carries a usageWarning.",
        "If a GUI tool says the backend is not set up, tell the user to run the named /gui-setup command; never try another backend.",
      ],
      parameters: LAUNCH_PARAMS,
    },
    async (params, { runtime: rt, ctx, signal }, onStatus) => {
      rt.setNotifier(ctx.hasUI ? (m, t) => ctx.ui.notify(m, t) : undefined);
      try {
        return await launchApp(params, rt, ctx, signal, onStatus);
      } catch (error) {
        // Every attempt counts toward launch-storm detection, including refusals and failed starts.
        const warnings = rt.recordFailedLaunch();
        // A refused or failed launch still names config problems (often the cause). They are not marked
        // shown: the once-only delivery to other tools is for results that actually ran.
        const configWarnings = await rt.config(ctx.cwd).then(
          (c) => c.resolved.warnings,
          () => [] as string[],
        );
        if (warnings.length === 0 && configWarnings.length === 0) throw error;
        const extra = [
          configWarnings.length ? `config warnings:\n${configWarnings.map((w) => `- ${w}`).join("\n")}` : undefined,
          warnings.length ? formatUsageWarnings(warnings) : undefined,
        ].filter(Boolean);
        throw Object.assign(new Error(`${(error as Error)?.message ?? String(error)}\n${extra.join("\n")}`), {
          ...(warnings.length ? { usageWarning: warnings } : {}),
          ...(configWarnings.length ? { configWarnings: [...configWarnings] } : {}),
        });
      }
    },
  );

  const wait = toolDefinition(
    runtime,
    { name: "gui_wait", label: "GUI wait", description: "Wait until a window, text, ref, or an idle screen appears in a GUI session, instead of sleeping. Returns matched and the elapsed time.", parameters: WAIT_PARAMS },
    (params, env) =>
      onSession(env, "gui_wait", params.session, async (live) => {
        const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_MS;
        const result = await live.session
          .request("wait", { for: params.for as WaitFor, ...(params.value !== undefined ? { value: params.value } : {}), timeoutMs }, { signal: env.signal, timeoutMs: timeoutMs + 10_000 })
          .catch(rethrow);
        return {
          output: {
            content: [text([`${result.matched ? "matched" : "not matched"} after ${result.elapsedMs} ms (for ${params.for}${params.value ? ` ${JSON.stringify(params.value)}` : ""})`])],
            details: { ...result },
          },
        };
      }),
  );

  const snapshot = toolDefinition(
    runtime,
    {
      name: "gui_snapshot",
      label: "GUI snapshot",
      description:
        "Read the accessibility tree of the app in a GUI session. Returns refs for gui_act and coverage (full/partial/none); with coverage none use gui_screenshot and coordinates. Refs expire at the next snapshot.",
      parameters: SNAPSHOT_PARAMS,
    },
    (params, env) =>
      onSession(env, "gui_snapshot", params.session, async (live) => {
        const maxNodes = params.maxNodes ?? DEFAULT_SNAPSHOT_NODES;
        const snap = await live.session.request("snapshot", { maxNodes }, { signal: env.signal }).catch(rethrow);
        let full: TreeNode[] = snap.tree;
        if (snap.truncated) {
          const dump = await live.session.request("snapshotFull", { snapshotId: snap.snapshotId }, { signal: env.signal }).catch(rethrow);
          full = (() => {
            try {
              return decodeTreeDump(dump.tree_gz_base64);
            } catch (error) {
              rethrow(error);
            }
          })();
        }
        // The file name is the session's own counter; the helper's snapshotId never reaches a host path.
        const path = await writeArtifact(live.artifactsDir, nextArtifactName(live, "snapshot", "json"), JSON.stringify(full, null, 1));
        const header = `snapshot ${snap.snapshotId}: coverage ${snap.coverage}, ${snap.tree.length}${snap.truncated ? ` of ${full.length}` : ""} nodes`;
        return {
          output: {
            content: [
              text([
                header,
                snap.coverage === "none" ? "no accessibility tree: use gui_screenshot and act by coordinates" : undefined,
                renderTree(snap.tree) || "(empty tree)",
                snap.truncated ? `truncated; full tree: ${path} (temporary)` : `saved: ${path} (temporary)`,
              ]),
            ],
            details: { snapshotId: snap.snapshotId, coverage: snap.coverage, nodes: snap.tree.length, totalNodes: full.length, truncated: snap.truncated, path, tree: snap.tree },
          },
        };
      }),
  );

  const screenshot = toolDefinition(
    runtime,
    {
      name: "gui_screenshot",
      label: "GUI screenshot",
      description: "Capture the screen (or one window) of a GUI session as an image. Coordinates for gui_act refer to the pixels of the latest screenshot image.",
      parameters: SCREENSHOT_PARAMS,
    },
    (params, env) =>
      onSession(env, "gui_screenshot", params.session, async (live) => {
        const { shot, path, imageWidth, imageHeight, summary } = await takeScreenshot(live, params, env.signal);
        return {
          output: {
            content: [text([...summary, TEMP_NOTE]), { type: "image", data: shot.png_base64, mimeType: "image/png" }],
            details: { captureId: shot.captureId, target: shot.target, origin: shot.origin, width: imageWidth, height: imageHeight, scale: shot.scale, sha256: shot.sha256, ...(shot.allBlack ? { allBlack: true } : {}), path },
          },
          usage: { screenshotSha256: shot.sha256, ...(shot.allBlack ? { allBlack: true } : {}) },
        };
      }),
  );

  const act = toolDefinition(
    runtime,
    {
      name: "gui_act",
      label: "GUI act",
      description:
        "Interact with the app in a GUI session: click, double_click, right_click, type, key, scroll, set_value. Target an element by ref from the latest gui_snapshot, or by x,y in the pixels of the latest gui_screenshot image.",
      parameters: ACT_PARAMS,
    },
    (params, env) =>
      onSession(env, "gui_act", params.session, async (live) => {
        const hasRef = params.ref !== undefined;
        const hasPoint = params.x !== undefined || params.y !== undefined;
        if (hasRef === hasPoint) throw new Error("give either ref, or x and y");
        const request: { ref?: string; captureId?: string; x?: number; y?: number; action: ActAction; text?: string } = { action: params.action as ActAction };
        if (params.text !== undefined) request.text = params.text;
        let point: { x: number; y: number } | undefined;
        if (hasRef) request.ref = params.ref;
        else {
          if (params.x === undefined || params.y === undefined) throw new Error("x and y must both be given");
          const capture = live.lastCapture;
          if (!capture) throw new Error("coordinates refer to a screenshot; take a gui_screenshot first");
          if (params.captureId !== undefined && params.captureId !== capture.captureId) {
            throw new Error(`capture ${params.captureId} is stale; take a new gui_screenshot and use its coordinates`);
          }
          point = { x: params.x, y: params.y };
          request.captureId = capture.captureId;
          request.x = Math.round(params.x / capture.scale);
          request.y = Math.round(params.y / capture.scale);
        }
        await live.session.request("act", request, { signal: env.signal }).catch(rethrow);
        const lines = [`${params.action} on ${hasRef ? params.ref : `${point!.x},${point!.y} of ${request.captureId}`}: ok`];
        const content: Content[] = [];
        let usageShot: { screenshotSha256?: string; allBlack?: boolean } = {};
        const details: Record<string, unknown> = { action: params.action, ...(hasRef ? { ref: params.ref } : { x: point!.x, y: point!.y, captureId: request.captureId }) };
        if (params.screenshot) {
          await live.session.request("wait", { for: "idle", timeoutMs: 2_000 }, { signal: env.signal }).catch(() => undefined);
          const target = live.lastCapture?.target;
          const taken = await takeScreenshot(live, target && target !== "screen" ? { window: target } : {}, env.signal);
          lines.push(...taken.summary);
          content.push({ type: "image", data: taken.shot.png_base64, mimeType: "image/png" });
          usageShot = { screenshotSha256: taken.shot.sha256, ...(taken.shot.allBlack ? { allBlack: true } : {}) };
          details.screenshot = { captureId: taken.shot.captureId, path: taken.path, sha256: taken.shot.sha256 };
        }
        return {
          output: { content: [text(lines), ...content], details },
          usage: { action: params.action, ...(hasRef ? { ref: params.ref } : { x: point!.x, y: point!.y }), ...usageShot },
        };
      }),
  );

  const logs = toolDefinition(
    runtime,
    { name: "gui_logs", label: "GUI logs", description: "Show the app's stdout/stderr (and setup output) of a GUI session.", parameters: LOGS_PARAMS },
    (params, env) =>
      onSession(env, "gui_logs", params.session, async (live) => {
        const lines = live.logs.tail(params.tail ?? DEFAULT_LOG_LINES, params.source);
        return {
          output: {
            content: [text([lines.length ? lines.join("\n") : "(no output yet)", live.logs.dropped ? `(${live.logs.dropped} older chunks dropped from memory; the session temp dir keeps more in app.log, which may itself be truncated: it stops at 64 MiB and skips writes when the disk falls behind)` : undefined])],
            details: { lines: lines.length },
          },
        };
      }),
  );

  const stop = toolDefinition(
    runtime,
    { name: "gui_stop", label: "GUI stop", description: "Stop a GUI session, delete its temporary files, and audit that nothing is left behind.", parameters: STOP_PARAMS },
    async (params, env) => {
      // Stopping is always safe: a live session is stopped even if its backend became unverified meanwhile.
      const known = env.runtime.find(params.session);
      const usable = known && !known.transient ? known : undefined;
      if (!usable) {
        if (!known) await env.runtime.verifiedBackend(env.ctx.cwd); // Refuses with the spec's text when nothing is set up.
        env.runtime.get(params.session); // Throws for an unknown id.
        throw new Error(`GUI session ${params.session} belongs to a running /gui-setup or /gui-doctor; cancel it with /gui-cleanup`);
      }
      // The session's own backend, whatever the active backend is now.
      const backend = usable.backend;
      env.runtime.recordUsage({ session: params.session, tool: "gui_stop" });
      // A session whose earlier teardown failed is retried directly; a running one waits for its queue.
      const outcome =
        usable.state === "running"
          ? await env.runtime.withSession(params.session, () => env.runtime.closeSession(params.session))
          : await env.runtime.closeSession(params.session);
      const leftovers = [...outcome.stopLeftovers, ...outcome.audit];
      if (leftovers.length > 0) {
        const kept = env.runtime.find(params.session) ? "; its temp dir and cleanup record are kept: run gui_stop again or ask the user to run /gui-cleanup" : "";
        throw new Error(`session ${params.session} stopped, but the footprint audit is not empty: ${formatLeftovers(leftovers)}${kept} (backend: ${backend})`);
      }
      return finish({ content: [text([`session ${params.session} stopped; footprint audit: empty; temporary files deleted`])], details: { session: params.session, audit: [] } }, backend, []);
    },
  );

  const exporter = toolDefinition(
    runtime,
    {
      name: "gui_export",
      label: "GUI export",
      description: "Copy a running session's screenshots, accessibility dumps, and logs out of its temporary dir into a directory you choose. Run it before gui_stop.",
      parameters: EXPORT_PARAMS,
    },
    (params, env) =>
      onSession(env, "gui_export", params.session, async (live) => {
        const result = await exportArtifacts(live, params.dest, env.ctx.cwd, { ...(env.signal ? { signal: env.signal } : {}) });
        return {
          output: {
            content: [text([`exported ${result.copied.length} file(s) to ${result.dest}`, result.skipped.length ? `skipped (already present): ${result.skipped.join(", ")}` : undefined])],
            details: { ...result },
          },
        };
      }),
  );

  return [launch, wait, snapshot, screenshot, act, logs, stop, exporter] as unknown as ToolDefinition<TSchema, Record<string, unknown>>[];
}
