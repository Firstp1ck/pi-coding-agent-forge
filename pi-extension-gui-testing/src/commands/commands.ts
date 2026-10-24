/**
 * Slash commands (spec §5.1, §7a.5): `/gui-setup`, `/gui-doctor`,
 * `/gui-backend`, `/gui-usage`, `/gui-cleanup`, `/gui-reset`, `/gui-export`.
 *
 * Commands never prompt without a UI (plan invariant 11). Reports go to stderr
 * in print mode and to a custom message in JSON/RPC/TUI mode; a failure without
 * a UI sets `process.exitCode = 1` (spec §5.2 "Modes").
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BackendId } from "../config/types.ts";
import { IMPLEMENTED_BACKENDS } from "../config/types.ts";
import {
  FlagError,
  parseBackendArgs,
  parseCleanupArgs,
  parseDoctorArgs,
  parseExportArgs,
  parseResetArgs,
  parseSetupArgs,
  parseUsageArgs,
} from "../config/flags.ts";
import { updateGlobalConfig, updateLocalConfig } from "../config/load.ts";
import { markUnverified, markVerified, notAvailableMessage, verificationState } from "../config/verified.ts";
import type { Leftover } from "../protocol.ts";
import { createSpawnRunner } from "../runner/spawn.ts";
import type { CommandRunner, RunResult } from "../runner/types.ts";
import { runDoctor } from "../setup/doctor.ts";
import { runSetup } from "../setup/flow.ts";
import type { PlanItem } from "../setup/plan.ts";
import { emitReport, renderReport, summarizeReport, type RenderedReport } from "../setup/report.ts";
import { runSmokeTest } from "../setup/smoke.ts";
import { createSetupUi } from "../setup/ui.ts";
import { exportArtifacts } from "../tools/export.ts";
import { formatLeftovers } from "../tools/format.ts";
import { assertCurrent, type GuiRuntime, type RuntimeBackend } from "../tools/runtime.ts";
import { offerLocalConfigIgnore } from "./gitignore.ts";

type CommandPi = Pick<ExtensionAPI, "sendMessage">;
type Ctx = Pick<ExtensionCommandContext, "mode" | "hasUI" | "ui" | "cwd" | "sessionManager">;

/** Shape of Pi's argument completion items. */
interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface GuiCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: Ctx) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
}

/** One-line descriptions shown by the backend picker. */
export const BACKEND_DESCRIPTIONS: Partial<Record<BackendId, string>> = {
  "docker-linux": "Linux apps in a local Docker container with a virtual display (needs rootful Docker)",
};

function backendCompletions(prefix: string): AutocompleteItem[] {
  return IMPLEMENTED_BACKENDS.filter((b) => b.startsWith(prefix)).map((b) => ({ value: b, label: b, description: BACKEND_DESCRIPTIONS[b] }));
}

function runnerOf(backend: RuntimeBackend): CommandRunner {
  return (backend as { runner?: CommandRunner }).runner ?? createSpawnRunner();
}

function leftoverLines(title: string, leftovers: readonly Leftover[]): string {
  return leftovers.length === 0 ? `${title}: empty` : `${title}:\n${leftovers.map((l) => `- ${formatLeftovers([l])}`).join("\n")}`;
}

/** Sends one report for the running command (mode-aware, with config warnings appended). */
type Emit = (report: string | RenderedReport, failed: boolean) => void;

/** Appends the config warnings (unknown or misplaced fields) to a report, in every mode. */
export function withConfigWarnings(report: string | RenderedReport, warnings: readonly string[]): RenderedReport {
  const rendered = typeof report === "string" ? { text: report } : report;
  if (warnings.length === 0) return rendered;
  return { ...rendered, text: `${rendered.text}\n\nConfig warnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` };
}

/** Builds the command set bound to `pi` and `runtime`. */
export function createGuiCommands(pi: CommandPi, runtime: GuiRuntime): GuiCommand[] {
  const notifierFrom = (ctx: Ctx) => runtime.setNotifier(ctx.hasUI ? (m, t) => ctx.ui.notify(m, t) : undefined);

  /**
   * Wraps a handler: flag errors and unexpected failures become a failed
   * report, never a thrown error; every report carries the config warnings.
   * The runtime generation is captured before the first await and handed to
   * the body: a body that starts sessions or setup runs, or writes config,
   * refuses to continue once that generation has shut down.
   */
  const guarded =
    (name: string, body: (args: string, ctx: Ctx, emit: Emit, generation: AbortSignal) => Promise<void>) =>
    async (args: string, ctx: Ctx): Promise<void> => {
      const generation = runtime.signal;
      notifierFrom(ctx);
      // A malformed config is reported by the commands that need it; here it only means "no warnings".
      const warnings = await runtime.config(ctx.cwd).then(
        (c) => c.resolved.warnings,
        () => [],
      );
      const emit: Emit = (report, failed) => emitReport(pi, ctx, withConfigWarnings(report, warnings), failed);
      try {
        await body(args, ctx, emit, generation);
      } catch (error) {
        emit(error instanceof FlagError ? error.message : `/${name}: ${(error as Error)?.message ?? String(error)}`, true);
      }
    };

  const applyWith = (backend: RuntimeBackend, setStatus: (text: string) => void) => async (item: PlanItem, signal: AbortSignal): Promise<RunResult> => {
    if (item.checkId === "image.base" && backend.buildImage) {
      setStatus("building the base image (this can take several minutes)");
      return backend.buildImage(signal, (line) => {
        const trimmed = line.trim();
        if (trimmed) setStatus(`building the base image: ${trimmed.slice(0, 100)}`);
      });
    }
    return runnerOf(backend).run(item.remediation.command!, { timeoutMs: item.remediation.timeoutMs ?? 60_000, signal });
  };

  const setup: GuiCommand = {
    name: "gui-setup",
    description: "Set up and verify a GUI testing backend: /gui-setup [backend] [--fix|--no-fix] [--project]",
    getArgumentCompletions: backendCompletions,
    handler: guarded("gui-setup", async (args, ctx, emit, generation) => {
      const parsed = parseSetupArgs(args);
      if (!parsed.backend && !ctx.hasUI) return emit(`/gui-setup needs a backend when there is no interactive UI; run /gui-setup ${IMPLEMENTED_BACKENDS.join(" or /gui-setup ")}`, true);
      if (parsed.backend && !IMPLEMENTED_BACKENDS.includes(parsed.backend)) return emit(notAvailableMessage(parsed.backend), true);
      // Registered before the first dialog: shutdown and /gui-cleanup cancel the picker too,
      // and a late answer after either can no longer start setup or save anything.
      const controller = runtime.beginSetup("/gui-setup", generation);
      try {
        const ui = createSetupUi(ctx, { controller });
        let id = parsed.backend;
        if (!id) {
          const labels = IMPLEMENTED_BACKENDS.map((b) => `${b} — ${BACKEND_DESCRIPTIONS[b] ?? ""}`);
          let choice: string | undefined;
          try {
            choice = await ui.select("Choose a GUI testing backend", labels, { flags: IMPLEMENTED_BACKENDS.map((b) => `/gui-setup ${b}`) });
          } catch (error) {
            if (!controller.signal.aborted && (error as Error)?.name !== "AbortError") throw error;
            return emit(`GUI setup cancelled${error instanceof Error && error.message ? ` (${error.message})` : ""}; nothing was changed`, false);
          }
          if (choice === undefined) return emit("GUI setup cancelled; nothing was changed", false);
          id = IMPLEMENTED_BACKENDS[labels.indexOf(choice)];
          if (!id) return emit("GUI setup cancelled; nothing was changed", false);
        }
        const backendId = id;
        const backend = runtime.backend(backendId);
        const report = await runSetup({
          backend: backendId,
          checks: backend.checks(),
          runner: runnerOf(backend),
          ui,
          flags: { fix: parsed.fix, noFix: parsed.noFix },
          projectRoot: ctx.cwd,
          signal: controller.signal,
          smoke: (signal) => runSmokeTest({ runtime, backend: backendId, piSessionId: ctx.sessionManager.getSessionId(), signal, onStatus: (t) => ui.setStatus(t) }),
          persist: async (record) => {
            // A run cancelled by shutdown or /gui-cleanup never saves, whatever finished late.
            controller.signal.throwIfAborted();
            await markVerified(backendId, record, runtime.options.globalConfigPath);
            if (parsed.project) await updateLocalConfig(ctx.cwd, (c) => void (c.backend = backendId));
            else await updateGlobalConfig((c) => void (c.backend = backendId), runtime.options.globalConfigPath);
          },
          applyRemediation: applyWith(backend, (t) => ui.setStatus(t)),
          inputs: { backend: backendId, scope: parsed.project ? "project" : "global" },
        });
        const extra: string[] = [];
        if (parsed.project && report.status === "verified") {
          // Spec §7: the personal file must not end up in Git; ask once, apply with --fix, or warn.
          const offer = await offerLocalConfigIgnore({
            runner: runnerOf(backend),
            projectRoot: ctx.cwd,
            fix: parsed.fix,
            noFix: parsed.noFix,
            ...(ctx.hasUI ? { confirm: (title: string, message: string) => ui.confirm(title, message, { flags: ["--fix", "--no-fix"] }) } : {}),
            signal: controller.signal,
          });
          if (offer.line) extra.push(offer.line);
        }
        emit({ text: [renderReport(report), ...extra].join("\n\n"), summary: summarizeReport(report) }, report.status !== "verified");
      } finally {
        runtime.endSetup(controller);
      }
    }),
  };

  const doctor: GuiCommand = {
    name: "gui-doctor",
    description: "Re-run every check and the smoke test of a backend without changing anything: /gui-doctor [backend]",
    getArgumentCompletions: backendCompletions,
    handler: guarded("gui-doctor", async (args, ctx, emit, generation) => {
      const parsed = parseDoctorArgs(args);
      const { resolved, global } = await runtime.config(ctx.cwd);
      const id = parsed.backend ?? resolved.backend ?? IMPLEMENTED_BACKENDS[0];
      if (!IMPLEMENTED_BACKENDS.includes(id)) return emit(notAvailableMessage(id), true);
      const backend = runtime.backend(id);
      const controller = runtime.beginSetup("/gui-doctor", generation);
      const setStatus = (text: string | undefined) => ctx.hasUI && ctx.ui.setStatus("gui-testing", text);
      try {
        const existing = global.verified[id];
        const report = await runDoctor({
          backend: id,
          checks: backend.checks(),
          runner: runnerOf(backend),
          projectRoot: ctx.cwd,
          signal: controller.signal,
          smoke: (signal) => runSmokeTest({ runtime, backend: id, piSessionId: ctx.sessionManager.getSessionId(), signal, onStatus: setStatus }),
          // A run cancelled by shutdown or /gui-cleanup never writes, whatever finished late.
          persist: async (record) => {
            controller.signal.throwIfAborted();
            await markVerified(id, record, runtime.options.globalConfigPath);
          },
          // Doctor never creates config files; it only removes a record that exists.
          unverify: async () => {
            controller.signal.throwIfAborted();
            if (existing) await markUnverified(id, runtime.options.globalConfigPath);
          },
          ...(existing?.inputs ? { inputs: existing.inputs } : {}),
          onStatus: setStatus,
        });
        const dockerReachable = report.results.some((r) => r.id === "docker.permission" && r.status === "pass");
        const orphans = report.status === "cancelled" ? [] : await runtime.auditOrphans(dockerReachable ? id : undefined, controller.signal);
        const text = `${renderReport(report)}\n\n${leftoverLines("Footprint audit (orphans of ended sessions)", orphans)}`;
        emit({ text, summary: summarizeReport(report) }, report.status !== "verified");
      } finally {
        runtime.endSetup(controller);
      }
    }),
  };

  const backendCommand: GuiCommand = {
    name: "gui-backend",
    description: "Switch the active GUI testing backend (must be verified): /gui-backend <backend> [--project]",
    getArgumentCompletions: backendCompletions,
    handler: guarded("gui-backend", async (args, ctx, emit, generation) => {
      const parsed = parseBackendArgs(args);
      if (!IMPLEMENTED_BACKENDS.includes(parsed.backend)) return emit(notAvailableMessage(parsed.backend), true);
      const { global } = await runtime.config(ctx.cwd);
      if (verificationState(global, parsed.backend).state !== "verified") {
        return emit(`backend "${parsed.backend}" is not verified; run /gui-setup ${parsed.backend} first`, true);
      }
      const lines = [`GUI testing backend is now ${parsed.backend} (${parsed.project ? ".pi/gui.local.json" : "global config"})`];
      assertCurrent(generation);
      if (parsed.project) {
        await updateLocalConfig(ctx.cwd, (c) => void (c.backend = parsed.backend));
        // The confirm goes through the setup dialog adapter: bound to Pi's shutdown and a timeout.
        const controller = new AbortController();
        const shutdown = generation;
        const onShutdown = () => controller.abort(shutdown.reason);
        if (shutdown.aborted) onShutdown();
        else shutdown.addEventListener("abort", onShutdown, { once: true });
        try {
          const ui = createSetupUi(ctx, { controller });
          const offer = await offerLocalConfigIgnore({
            runner: runnerOf(runtime.backend(parsed.backend)),
            projectRoot: ctx.cwd,
            fix: false,
            ...(ctx.hasUI ? { confirm: (title: string, message: string) => ui.confirm(title, message, { flags: ["/gui-setup --project --fix"] }) } : {}),
            signal: controller.signal,
          });
          if (offer.line) lines.push(offer.line);
        } finally {
          shutdown.removeEventListener("abort", onShutdown);
        }
      } else await updateGlobalConfig((c) => void (c.backend = parsed.backend), runtime.options.globalConfigPath);
      emit(lines.join("\n"), false);
    }),
  };

  const usage: GuiCommand = {
    name: "gui-usage",
    description: "Show GUI testing usage and loop warnings for current and recent sessions: /gui-usage [session]",
    getArgumentCompletions: (prefix) => runtime.tracker.sessions().filter((s) => s.session.startsWith(prefix)).map((s) => ({ value: s.session, label: s.session })),
    handler: guarded("gui-usage", async (args, ctx, emit) => {
      const parsed = parseUsageArgs(args);
      const sessions = runtime.tracker.sessions().filter((s) => !parsed.session || s.session === parsed.session);
      if (parsed.session && sessions.length === 0) return emit(`/gui-usage: no usage recorded for session "${parsed.session}"`, true);
      const live = new Set(runtime.list().map((s) => s.id));
      const lines = sessions.map((s) => {
        const calls = Object.entries(s.toolCalls).map(([tool, n]) => `${tool} ${n}`).join(", ") || "no calls";
        const minutes = ((Date.now() - s.startedAt) / 60_000).toFixed(1);
        const warn = s.warnings.length ? `\n  warnings: ${s.warnings.map((w) => w.signal).join(", ")}` : "";
        return `${s.session} (${s.backend}, ${live.has(s.session) ? "running" : "stopped"}, ${minutes} min): ${calls}; actions ${s.actions}, screenshots ${s.screenshots}${s.allBlackScreenshots ? ` (${s.allBlackScreenshots} all black)` : ""}, synced ${s.bytesSynced} bytes${warn}`;
      });
      emit(lines.length ? `GUI testing usage:\n${lines.join("\n")}` : "GUI testing usage: no sessions in this Pi session yet", false);
    }),
  };

  const cleanup: GuiCommand = {
    name: "gui-cleanup",
    description: "Cancel a running setup, stop sessions, sweep orphans, and audit: /gui-cleanup [backend|--all] [--deps]",
    getArgumentCompletions: backendCompletions,
    handler: guarded("gui-cleanup", async (args, ctx, emit) => {
      const parsed = parseCleanupArgs(args);
      const lines: string[] = [];
      if (parsed.backend && !IMPLEMENTED_BACKENDS.includes(parsed.backend)) return emit(notAvailableMessage(parsed.backend), true);
      const cancelled = runtime.cancelSetup("cancelled by /gui-cleanup");
      if (cancelled) lines.push(`cancelled the running ${cancelled}`);
      // Cleanup never depends on a readable config: a malformed .pi/gui.json is a warning, and
      // without an explicit backend every implemented backend is cleaned.
      let configured: BackendId | undefined;
      let configError: string | undefined;
      try {
        configured = (await runtime.config(ctx.cwd)).resolved.backend;
      } catch (error) {
        configError = (error as Error)?.message ?? String(error);
      }
      let backends: BackendId[];
      if (parsed.all || (configError !== undefined && !parsed.backend)) backends = [...IMPLEMENTED_BACKENDS];
      else {
        const id = parsed.backend ?? configured ?? IMPLEMENTED_BACKENDS[0];
        if (!IMPLEMENTED_BACKENDS.includes(id)) return emit(notAvailableMessage(id), true);
        backends = [id];
      }
      if (configError !== undefined) lines.push(`warning: could not read the GUI testing config (${configError}); cleanup does not need it${parsed.all || parsed.backend ? "" : ", so every backend is cleaned"}`);
      const controller = new AbortController();
      const stopped = runtime.list().filter((s) => backends.includes(s.backend)).map((s) => s.id);
      const stopLeftovers: Leftover[] = [];
      for (const b of backends) stopLeftovers.push(...(await runtime.stopAll(b)));
      lines.push(stopped.length ? `stopped sessions: ${stopped.join(", ")}` : "no running sessions");
      // Sweep Docker whenever a docker executable exists, verified or not; a host without one gets no docker command.
      const sweepable = (await runtime.dockerAvailable()) ? backends.filter((b) => b === "docker-linux") : [];
      const sweep = await runtime.sweepNow(sweepable, controller.signal);
      lines.push(`swept: ${sweep.removedDirs.length} temp dir(s), ${sweep.killed.length} process(es)`);
      if (parsed.deps) lines.push("dependency cache: not used in this version; nothing to clear");
      const audit = [...stopLeftovers, ...sweep.leftovers, ...sweep.unknown, ...(await runtime.auditOrphans(sweepable[0], controller.signal))];
      const unique = [...new Map(audit.map((l) => [`${l.kind}:${l.id}`, l])).values()];
      lines.push(leftoverLines("Footprint audit", unique));
      emit(`GUI testing cleanup (${backends.join(", ")}):\n${lines.join("\n")}`, unique.length > 0);
    }),
  };

  const reset: GuiCommand = {
    name: "gui-reset",
    description: "Remove a backend's config, base images, and verified state: /gui-reset <backend>",
    getArgumentCompletions: backendCompletions,
    handler: guarded("gui-reset", async (args, ctx, emit, generation) => {
      const { backend: id } = parseResetArgs(args);
      if (!IMPLEMENTED_BACKENDS.includes(id)) return emit(notAvailableMessage(id), true);
      if (!ctx.hasUI) return emit(`/gui-reset ${id} deletes images and config and needs your confirmation in an interactive Pi session`, true);
      const ok = await ctx.ui.confirm(`Reset ${id}?`, "Stops its sessions and removes its base images, verified state, and backend choice. Docker itself stays installed.");
      if (!ok) return emit(`GUI reset ${id} cancelled; nothing was changed`, false);
      assertCurrent(generation);
      runtime.cancelSetup(`cancelled by /gui-reset ${id}`);
      const backend = runtime.backend(id);
      const lines: string[] = [];
      const leftovers = await runtime.stopAll(id);
      const controller = new AbortController();
      const sweep = await runtime.sweepNow([id], controller.signal);
      leftovers.push(...sweep.leftovers);
      if (backend.removeBaseImages) {
        try {
          const images = await backend.removeBaseImages(controller.signal);
          lines.push(`removed ${images.removed.length} base image(s)`);
          leftovers.push(...images.leftovers);
        } catch (error) {
          leftovers.push({ kind: "image", id: "pi-gui-testing.base", detail: (error as Error).message });
        }
      }
      await markUnverified(id, runtime.options.globalConfigPath);
      await updateGlobalConfig((c) => void (c.backend === id && delete c.backend), runtime.options.globalConfigPath);
      await updateLocalConfig(ctx.cwd, (c) => void (c.backend === id && delete c.backend)).catch(() => undefined);
      lines.push("removed the verified state and backend choice");
      lines.push("system packages: setup installs none for docker-linux; Docker itself is yours and stays installed");
      lines.push(leftoverLines("Leftovers", leftovers));
      emit(`GUI testing reset ${id}:\n${lines.join("\n")}`, leftovers.length > 0);
    }),
  };

  const exportCommand: GuiCommand = {
    name: "gui-export",
    description: "Copy a running session's screenshots, dumps, and logs to a directory: /gui-export <session> <dest>",
    getArgumentCompletions: (prefix) => runtime.list().filter((s) => !s.transient && s.id.startsWith(prefix)).map((s) => ({ value: s.id, label: s.id })),
    handler: guarded("gui-export", async (args, ctx, emit, generation) => {
      const parsed = parseExportArgs(args);
      assertCurrent(generation);
      const result = await runtime.withSession(parsed.session, (live) => exportArtifacts(live, parsed.dest, ctx.cwd, { signal: generation }));
      emit(
        `exported ${result.copied.length} file(s) from ${parsed.session} to ${result.dest}${result.skipped.length ? `; skipped existing: ${result.skipped.join(", ")}` : ""}`,
        false,
      );
    }),
  };

  return [setup, doctor, backendCommand, usage, cleanup, reset, exportCommand];
}

/** Registers every command with Pi. */
export function registerGuiCommands(pi: ExtensionAPI, runtime: GuiRuntime): void {
  for (const command of createGuiCommands(pi, runtime)) {
    pi.registerCommand(command.name, {
      description: command.description,
      handler: command.handler,
      ...(command.getArgumentCompletions ? { getArgumentCompletions: command.getArgumentCompletions } : {}),
    });
  }
}
