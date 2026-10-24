/**
 * Slash commands (spec §5.1, §7a.5): `/gui-setup`, `/gui-doctor`,
 * `/gui-backend`, `/gui-usage`, `/gui-cleanup`, `/gui-reset`, `/gui-export`.
 *
 * Commands never prompt without a UI (plan invariant 11). Reports go to stderr
 * in print mode and to a custom message in JSON/RPC/TUI mode; a failure without
 * a UI sets `process.exitCode = 1` (spec §5.2 "Modes").
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { hasBilling, hasImage, hasOrphanAuditGate, hasReset, hasRunner, IMAGE_CHECK_ID } from "../backends/capabilities.ts";
import { bindHost, hasRemoteHost } from "../backends/remote/host.ts";
import { DEFAULT_REGISTRY } from "../backends/registry.ts";
import { requiredChecksPass } from "../checks/runner.ts";
import type { BackendId, PersonalConfig } from "../config/types.ts";
import { DepsCache } from "../deps/store.ts";
import {
  FlagError,
  parseBackendArgs,
  parseCleanupArgs,
  parseDoctorArgs,
  parseExportArgs,
  parseResetArgs,
  parseSetupArgs,
  parseUsageArgs,
  SETUP_USAGE,
} from "../config/flags.ts";
import { updateGlobalConfig, updateLocalConfig } from "../config/load.ts";
import { markUnverified, markVerified, verificationState } from "../config/verified.ts";
import type { Leftover } from "../protocol.ts";
import { createSpawnRunner } from "../runner/spawn.ts";
import type { CommandRunner, RunResult } from "../runner/types.ts";
import { runDoctor } from "../setup/doctor.ts";
import { runSetup } from "../setup/flow.ts";
import { pickHost } from "../setup/hosts.ts";
import type { PlanItem } from "../setup/plan.ts";
import { emitReport, renderReport, summarizeReport, type RenderedReport } from "../setup/report.ts";
import { runSmokeTest } from "../setup/smoke.ts";
import { createSetupUi } from "../setup/ui.ts";
import { exportArtifacts } from "../tools/export.ts";
import { formatLeftovers } from "../tools/format.ts";
import { assertCurrent, type BackendViews, type GuiRuntime, type RuntimeBackend } from "../tools/runtime.ts";
import { configuredHost, configuredView, hasRemoteSudo, setupFlagProblem } from "./backend-inputs.ts";
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

/** One-line descriptions shown by the backend picker (from the registry of this build). */
export const BACKEND_DESCRIPTIONS: Partial<Record<BackendId, string>> = Object.fromEntries(DEFAULT_REGISTRY.entries().map((e) => [e.id, e.description]));

function runnerOf(backend: RuntimeBackend): CommandRunner {
  return hasRunner(backend) ? backend.runner : createSpawnRunner();
}

/** Text of `/gui-reset`'s confirmation when the backend does not describe its own reset. */
const DEFAULT_RESET_SUMMARY = "Stops its sessions and removes its verified state and backend choice.";

function leftoverLines(title: string, leftovers: readonly Leftover[]): string {
  return leftovers.length === 0 ? `${title}: empty` : `${title}:\n${leftovers.map((l) => `- ${formatLeftovers([l])}`).join("\n")}`;
}

/**
 * An audit leftover that reports the audit's own failure (some audits return
 * one in-band, e.g. cua's failed sandbox listing or the remote Docker audit),
 * so it could not establish what is gone.
 */
const AUDIT_FAILURE = /\bfailed\b/;

/**
 * The sweep findings a reset left in place: `/gui-reset` sweeps before its
 * `resetData`, which may resolve some of them (cua deletes sandboxes pending
 * deletion). A fresh audit decides; a finding it no longer reports is gone.
 * When the audit fails (thrown, or reported as a leftover), every finding
 * stands with the failure, marked as possibly stale and possibly incomplete.
 */
async function stillThere(found: readonly Leftover[], audit: () => Promise<Leftover[]>, id: BackendId): Promise<Leftover[]> {
  if (found.length === 0) return [];
  let now: Leftover[];
  try {
    now = await audit();
  } catch (error) {
    return [...found, { kind: "audit", id, detail: `the audit after the reset failed, so these findings may be resolved already: ${(error as Error).message}` }];
  }
  const key = (l: Leftover) => `${l.kind}:${l.id}`;
  const before = new Set(found.map(key));
  const failures = now.filter((l) => !before.has(key(l)) && AUDIT_FAILURE.test(l.detail ?? ""));
  if (failures.length > 0) {
    return [...found, ...failures, { kind: "audit", id, detail: "the audit after the reset could not finish, so this list may be incomplete and some findings may be resolved already" }];
  }
  const remaining = new Set(now.map(key));
  return found.filter((l) => remaining.has(key(l)));
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
  const registry = runtime.registry;
  const implemented = registry.ids;
  /** Backends whose host support includes this client's OS: the only ones the picker and hints offer. */
  const offered = (): BackendId[] => {
    const platform = runtime.options.platform ?? process.platform;
    return implemented.filter((b) => registry.entry(b)?.hostSupport.platforms.includes(platform));
  };
  const backendCompletions = (prefix: string): AutocompleteItem[] =>
    registry
      .entries()
      .filter((e) => e.id.startsWith(prefix))
      .map((e) => ({ value: e.id, label: e.id, description: e.description }));
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
    if (item.checkId === IMAGE_CHECK_ID && hasImage(backend)) {
      setStatus("building the base image (this can take several minutes)");
      return backend.buildImage(signal, (line) => {
        const trimmed = line.trim();
        if (trimmed) setStatus(`building the base image: ${trimmed.slice(0, 100)}`);
      });
    }
    return runnerOf(backend).run(item.remediation.command!, { timeoutMs: item.remediation.timeoutMs ?? 60_000, signal });
  };

  /** Dialog errors caused by a cancel (shutdown, /gui-cleanup, timeout) become a "cancelled" report. */
  const cancelledBy = (error: unknown, controller: AbortController): string | undefined => {
    if (!controller.signal.aborted && (error as Error)?.name !== "AbortError") return undefined;
    return `GUI setup cancelled${error instanceof Error && error.message ? ` (${error.message})` : ""}; nothing was changed`;
  };

  const setup: GuiCommand = {
    name: "gui-setup",
    description: `Set up and verify a GUI testing backend: ${SETUP_USAGE}`,
    getArgumentCompletions: backendCompletions,
    handler: guarded("gui-setup", async (args, ctx, emit, generation) => {
      const parsed = parseSetupArgs(args);
      if (!parsed.backend && !ctx.hasUI) {
        const ids = offered();
        return emit(ids.length ? `/gui-setup needs a backend when there is no interactive UI; run /gui-setup ${ids.join(" or /gui-setup ")}` : `/gui-setup: no backend of this build runs on ${runtime.options.platform ?? process.platform}`, true);
      }
      if (parsed.backend && !runtime.implemented(parsed.backend)) return emit(runtime.notAvailableMessage(parsed.backend), true);
      if (parsed.backend) {
        const problem = setupFlagProblem(parsed.backend, runtime.backend(parsed.backend), parsed);
        if (problem) return emit(problem, true);
      }
      // Registered before the first dialog: shutdown and /gui-cleanup cancel the picker too,
      // and a late answer after either can no longer start setup or save anything.
      const controller = runtime.beginSetup("/gui-setup", generation);
      try {
        const ui = createSetupUi(ctx, { controller });
        let id = parsed.backend;
        if (!id) {
          // Only backends that run on this client's OS are offered (an explicit `/gui-setup <id>` still reports host.os).
          const ids = offered();
          if (ids.length === 0) return emit(`/gui-setup: no backend of this build runs on ${runtime.options.platform ?? process.platform}`, true);
          const labels = ids.map((b) => `${b} — ${registry.entry(b)?.description ?? ""}`);
          let choice: string | undefined;
          try {
            choice = await ui.select("Choose a GUI testing backend", labels, { flags: ids.map((b) => `/gui-setup ${b}`) });
          } catch (error) {
            const cancelled = cancelledBy(error, controller);
            if (!cancelled) throw error;
            return emit(cancelled, false);
          }
          if (choice === undefined) return emit("GUI setup cancelled; nothing was changed", false);
          id = ids[labels.indexOf(choice)];
          if (!id) return emit("GUI setup cancelled; nothing was changed", false);
          const problem = setupFlagProblem(id, runtime.backend(id), parsed);
          if (problem) return emit(problem, true);
        }
        const backendId = id;
        // Remote backends: replaced below by a view bound to this run's host (the shared backend never changes).
        let backend = runtime.backend(backendId);
        const inputs: Record<string, string> = { backend: backendId, scope: parsed.project ? "project" : "global" };
        const notes: string[] = [];

        // Remote backends: --host → remote.host (.pi/gui.local.json, then global) → picker (UI only).
        let remoteHost: string | undefined;
        if (hasRemoteHost(backend)) {
          const { resolved } = await runtime.config(ctx.cwd);
          let host = parsed.host ?? resolved.remote?.host;
          if (!host) {
            if (!ctx.hasUI) return emit(`/gui-setup ${backendId} needs an SSH host when there is no interactive UI; run /gui-setup ${backendId} --host <ssh-alias-or-user@host>`, true);
            let choice;
            try {
              choice = await (runtime.options.hostPicker ?? pickHost)(ui, { backend: backendId, runner: runnerOf(backend), signal: controller.signal });
            } catch (error) {
              const cancelled = cancelledBy(error, controller);
              if (!cancelled) throw error;
              return emit(cancelled, false);
            }
            if (!choice) return emit("GUI setup cancelled; nothing was changed", false);
            host = choice.host;
            if (choice.template) notes.push(`To give this host an alias, you can add this block to ~/.ssh/config (the package never writes it):\n${choice.template}`);
          }
          const bound = bindHost(backend, host);
          remoteHost = hasRemoteHost(bound) ? bound.remoteHost : undefined;
          backend = bound;
          if (remoteHost) inputs.host = remoteHost;
        }

        // Billing backends: one acknowledgement (--accept-billing or one confirm); never a prompt without a UI.
        if (hasBilling(backend)) {
          const choices = {
            ...(parsed.cloud !== undefined ? { location: parsed.cloud } : {}),
            ...(parsed.rateUsdPerHour !== undefined ? { rateUsdPerHour: parsed.rateUsdPerHour } : {}),
            ...(parsed.image !== undefined ? { image: parsed.image } : {}),
          };
          const status = await backend.billingStatus(choices, controller.signal).catch((error: Error) => ({ acknowledged: false, problem: error.message }) as { acknowledged: boolean; location?: string; text?: string; problem?: string; image?: string });
          let acknowledgedLocation: string | undefined;
          if (!status.acknowledged && status.location) {
            if (parsed.acceptBilling) acknowledgedLocation = status.location;
            else if (ctx.hasUI) {
              let ok: boolean;
              try {
                ok = await ui.confirm(`Allow ${backendId} sessions to bill your ${status.location} account?`, status.text ?? "", { flags: ["--accept-billing"] });
              } catch (error) {
                const cancelled = cancelledBy(error, controller);
                if (!cancelled) throw error;
                return emit(cancelled, false);
              }
              if (!ok) return emit(`GUI setup cancelled: billing and upload were not acknowledged; nothing was changed (or run /gui-setup ${backendId} --accept-billing)`, false);
              acknowledgedLocation = status.location;
            } else notes.push(`Billing and upload are not acknowledged for ${status.location}; re-run with /gui-setup ${backendId} --accept-billing`);
          }
          controller.signal.throwIfAborted();
          assertCurrent(generation);
          await backend.recordSetupInputs({ ...choices, ...(acknowledgedLocation ? { acknowledgedLocation } : {}) });
          if (status.location) inputs.cloud = parsed.cloud ?? status.location;
          if (parsed.image ?? status.image) inputs.image = (parsed.image ?? status.image)!;
          if (parsed.targets) inputs.targets = parsed.targets.join(",");
        }

        const report = await runSetup({
          backend: backendId,
          checks: backend.checks(),
          runner: runnerOf(backend),
          ui,
          flags: { fix: parsed.fix, noFix: parsed.noFix },
          projectRoot: ctx.cwd,
          signal: controller.signal,
          ...(parsed.targets ? { targets: parsed.targets } : {}),
          smoke: (signal) => runSmokeTest({ runtime, backend: backendId, view: backend, piSessionId: ctx.sessionManager.getSessionId(), signal, onStatus: (t) => ui.setStatus(t) }),
          persist: async (record) => {
            // A run cancelled by shutdown or /gui-cleanup never saves, whatever finished late.
            controller.signal.throwIfAborted();
            await markVerified(backendId, record, runtime.options.globalConfigPath);
            // The backend choice and the SSH alias (never resolved values) go to the same file.
            const choose = (c: PersonalConfig) => {
              c.backend = backendId;
              if (remoteHost) c.remote = { ...c.remote, host: remoteHost, ...(parsed.purgeTooling ? { purgeTooling: true } : {}) };
            };
            if (parsed.project) await updateLocalConfig(ctx.cwd, choose);
            else await updateGlobalConfig(choose, runtime.options.globalConfigPath);
          },
          applyRemediation: applyWith(backend, (t) => ui.setStatus(t)),
          ...(hasRemoteSudo(backend) ? { passwordlessSudo: (signal: AbortSignal) => backend.passwordlessSudo(signal) } : {}),
          inputs,
        });
        const extra: string[] = [...notes];
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
        if (remoteHost && parsed.purgeTooling && report.status === "verified") {
          extra.push(`purgeTooling: the base image is removed from ${remoteHost} after every session and rebuilt at the next session start (several minutes)`);
        }
        emit({ text: [renderReport(report), ...extra].join("\n\n"), summary: summarizeReport(report) }, report.status !== "verified");
      } finally {
        runtime.endSetup(controller);
      }
    }),
  };

  const doctor: GuiCommand = {
    name: "gui-doctor",
    description: "Re-run every check and the smoke test of a backend without changing anything: /gui-doctor [backend] [--host <ssh-alias-or-user@host>]",
    getArgumentCompletions: backendCompletions,
    handler: guarded("gui-doctor", async (args, ctx, emit, generation) => {
      const parsed = parseDoctorArgs(args);
      const { resolved, global } = await runtime.config(ctx.cwd);
      const id = parsed.backend ?? resolved.backend ?? registry.defaultId;
      if (!runtime.implemented(id)) return emit(runtime.notAvailableMessage(id), true);
      const shared = runtime.backend(id);
      if (!hasRemoteHost(shared) && parsed.host !== undefined) return emit(`/gui-doctor: --host only applies to the remote backends (remote-linux, remote-linux-docker), not ${id}`, true);
      // The guard comes first: a doctor refused because another run is active changes nothing.
      const controller = runtime.beginSetup("/gui-doctor", generation);
      const setStatus = (text: string | undefined) => ctx.hasUI && ctx.ui.setStatus("gui-testing", text);
      try {
        // Remote backends check the configured host, or the --host given (never stored), through a view bound to it.
        let backend = shared;
        let probeOnly: string | undefined;
        if (hasRemoteHost(shared)) {
          const configured = configuredHost(id, resolved, global);
          backend = bindHost(shared, parsed.host ?? configured);
          const host = hasRemoteHost(backend) ? backend.remoteHost : undefined;
          if (parsed.host !== undefined && host !== configured) {
            probeOnly = `checked ${host} given by --host; the verified state is unchanged because the configured host is ${configured ?? "not set"} (run /gui-setup ${id} --host ${host} to switch)`;
          }
        }
        const existing = global.verified[id];
        // The record names the host it was verified for.
        const inputs = existing?.inputs && hasRemoteHost(backend) && backend.remoteHost ? { ...existing.inputs, host: backend.remoteHost } : existing?.inputs;
        const report = await runDoctor({
          backend: id,
          checks: backend.checks(),
          runner: runnerOf(backend),
          projectRoot: ctx.cwd,
          signal: controller.signal,
          smoke: (signal) => runSmokeTest({ runtime, backend: id, view: backend, piSessionId: ctx.sessionManager.getSessionId(), signal, onStatus: setStatus }),
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
          ...(inputs ? { inputs } : {}),
          ...(probeOnly ? { recordState: false } : {}),
          onStatus: setStatus,
        });
        // The backend's orphan audit runs only when the checks showed it reachable.
        const reachable = hasOrphanAuditGate(backend) ? backend.orphanAuditReady(report.results) : requiredChecksPass(report.results);
        const orphans = report.status === "cancelled" ? [] : await runtime.auditOrphans(reachable ? id : undefined, controller.signal, { [id]: backend });
        const text = [renderReport(report), ...(probeOnly ? [probeOnly] : []), leftoverLines("Footprint audit (orphans of ended sessions)", orphans)].join("\n\n");
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
      if (!runtime.implemented(parsed.backend)) return emit(runtime.notAvailableMessage(parsed.backend), true);
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
      // Billing backends (cua) estimate each session and today's total of that backend.
      const today = new Map<string, number>();
      const lines = sessions.map((s) => {
        const calls = Object.entries(s.toolCalls).map(([tool, n]) => `${tool} ${n}`).join(", ") || "no calls";
        const minutes = ((Date.now() - s.startedAt) / 60_000).toFixed(1);
        const estimate = runtime.tracker.estimate(s.session);
        if (estimate) today.set(s.backend, estimate.dailyUsd);
        const cost = estimate ? `, estimated cost $${estimate.sessionUsd.toFixed(2)}` : "";
        const warn = s.warnings.length ? `\n  warnings: ${s.warnings.map((w) => w.signal).join(", ")}` : "";
        return `${s.session} (${s.backend}, ${live.has(s.session) ? "running" : "stopped"}, ${minutes} min): ${calls}; actions ${s.actions}, screenshots ${s.screenshots}${s.allBlackScreenshots ? ` (${s.allBlackScreenshots} all black)` : ""}, synced ${s.bytesSynced} bytes${cost}${warn}`;
      });
      if (today.size > 0) {
        const total = [...today.values()].reduce((sum, usd) => sum + usd, 0);
        lines.push(`estimated cost today: $${total.toFixed(2)} (${[...today.keys()].join(", ")}; your cloud's bill is what counts)`);
      }
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
      if (parsed.backend && !runtime.implemented(parsed.backend)) return emit(runtime.notAvailableMessage(parsed.backend), true);
      const cancelled = runtime.cancelSetup("cancelled by /gui-cleanup");
      if (cancelled) lines.push(`cancelled the running ${cancelled}`);
      // Cleanup never depends on a readable config: a malformed .pi/gui.json is a warning, and
      // without an explicit backend every implemented backend is cleaned.
      let configured: BackendId | undefined;
      let configError: string | undefined;
      let config: Awaited<ReturnType<GuiRuntime["config"]>> | undefined;
      try {
        config = await runtime.config(ctx.cwd);
        configured = config.resolved.backend;
      } catch (error) {
        configError = (error as Error)?.message ?? String(error);
      }
      let backends: BackendId[];
      if (parsed.all || (configError !== undefined && !parsed.backend)) backends = [...implemented];
      else {
        const id = parsed.backend ?? configured ?? registry.defaultId;
        if (!runtime.implemented(id)) return emit(runtime.notAvailableMessage(id), true);
        backends = [id];
      }
      if (configError !== undefined) lines.push(`warning: could not read the GUI testing config (${configError}); cleanup does not need it${parsed.all || parsed.backend ? "" : ", so every backend is cleaned"}`);
      const controller = new AbortController();
      const stopped = runtime.list().filter((s) => backends.includes(s.backend)).map((s) => s.id);
      const stopLeftovers: Leftover[] = [];
      for (const b of backends) stopLeftovers.push(...(await runtime.stopAll(b)));
      lines.push(stopped.length ? `stopped sessions: ${stopped.join(", ")}` : "no running sessions");
      // Remote backends sweep their configured host (a view bound to it); without one their gate says no.
      const views: BackendViews = {};
      for (const b of backends) {
        try {
          views[b] = configuredView(b, runtime.backend(b), config?.resolved, config?.global);
        } catch (error) {
          lines.push(`warning: ${b}: ${(error as Error).message}; its remote host is not swept`);
        }
      }
      // Each backend's gate decides, verified or not, without running a command (Docker: a docker executable on PATH).
      const sweepable = await runtime.sweepableBackends(backends, { startup: false }, views);
      const sweep = await runtime.sweepNow(sweepable, controller.signal, views);
      lines.push(`swept: ${sweep.removedDirs.length} temp dir(s), ${sweep.killed.length} process(es)`);
      const depsLeftovers: Leftover[] = [];
      if (parsed.deps) {
        // Spec §4.8, §7a.5: the whole client-side cache (every project); it only ever saves setup time.
        const cache = new DepsCache({ root: runtime.depsCacheRoot });
        try {
          const cleared = await cache.clear();
          lines.push(
            cleared.entries > 0
              ? `dependency cache: removed ${cleared.entries} entr${cleared.entries === 1 ? "y" : "ies"} (${(cleared.bytes / 1024 ** 2).toFixed(1)} MB) from ${cache.root}`
              : `dependency cache: already empty (${cache.root})`,
          );
        } catch (error) {
          depsLeftovers.push({ kind: "deps-cache", id: cache.root, detail: `could not remove the dependency cache: ${(error as Error).message}` });
        }
      }
      const audit = [...stopLeftovers, ...sweep.leftovers, ...sweep.unknown, ...depsLeftovers, ...(await runtime.auditOrphans(sweepable, controller.signal, views))];
      const unique = [...new Map(audit.map((l) => [`${l.kind}:${l.id}`, l])).values()];
      lines.push(leftoverLines("Footprint audit", unique));
      emit(`GUI testing cleanup (${backends.join(", ")}):\n${lines.join("\n")}`, unique.length > 0);
    }),
  };

  const reset: GuiCommand = {
    name: "gui-reset",
    description: "Remove a backend's config, setup data (such as base images), and verified state: /gui-reset <backend>",
    getArgumentCompletions: backendCompletions,
    handler: guarded("gui-reset", async (args, ctx, emit, generation) => {
      const { backend: id } = parseResetArgs(args);
      if (!runtime.implemented(id)) return emit(runtime.notAvailableMessage(id), true);
      if (!ctx.hasUI) return emit(`/gui-reset ${id} deletes its setup data and config and needs your confirmation in an interactive Pi session`, true);
      // Remote backends reset (sweep, base images) on their configured host, through a view bound to it.
      const config = await runtime.config(ctx.cwd).catch(() => undefined);
      const backend = configuredView(id, runtime.backend(id), config?.resolved, config?.global);
      const resetCapability = hasReset(backend) ? backend : undefined;
      const ok = await ctx.ui.confirm(`Reset ${id}?`, resetCapability?.resetSummary ?? DEFAULT_RESET_SUMMARY);
      if (!ok) return emit(`GUI reset ${id} cancelled; nothing was changed`, false);
      assertCurrent(generation);
      runtime.cancelSetup(`cancelled by /gui-reset ${id}`);
      const lines: string[] = [];
      const leftovers = await runtime.stopAll(id);
      const controller = new AbortController();
      // The client scope, then the backend's own sweep, whose findings resetData may resolve: they are
      // reconciled with a fresh audit afterwards, so the report lists only what remains.
      const sweep = await runtime.sweepNow([], controller.signal);
      leftovers.push(...sweep.leftovers);
      let found: Leftover[] = [];
      try {
        found = await backend.sweepOrphans(controller.signal);
      } catch (error) {
        leftovers.push({ kind: "sweeper", id, detail: `sweep failed: ${(error as Error).message}` });
      }
      if (resetCapability?.resetData) {
        try {
          const data = await resetCapability.resetData(controller.signal);
          lines.push(...data.lines);
          leftovers.push(...data.leftovers);
        } catch (error) {
          leftovers.push({ kind: "reset", id, detail: (error as Error).message });
        }
      }
      leftovers.push(...(await stillThere(found, () => backend.auditOrphans(controller.signal), id)));
      await markUnverified(id, runtime.options.globalConfigPath);
      await updateGlobalConfig((c) => void (c.backend === id && delete c.backend), runtime.options.globalConfigPath);
      await updateLocalConfig(ctx.cwd, (c) => void (c.backend === id && delete c.backend)).catch(() => undefined);
      lines.push("removed the verified state and backend choice");
      if (resetCapability) lines.push(resetCapability.resetNote);
      // One line per leftover; the first report of one (the reset's own, before the audit's) is the most specific.
      const unique = leftovers.filter((l, i) => leftovers.findIndex((o) => o.kind === l.kind && o.id === l.id) === i);
      lines.push(leftoverLines("Leftovers", unique));
      emit(`GUI testing reset ${id}:\n${lines.join("\n")}`, unique.length > 0);
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
