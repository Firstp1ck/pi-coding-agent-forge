/**
 * `cua` backend (spec §4.3, M3, Linux targets): each session runs in its own
 * Cua sandbox in the user's cloud account (AWS, Google Cloud, Hetzner, or
 * Modal), created and deleted through the `cua` CLI. The Linux helper is
 * deployed into the sandbox and speaks the usual protocol over
 * `cua sandbox exec -i`, so sessions behave like every other backend's.
 *
 * Cua Cloud (Cua-hosted sandboxes billed by Cua, `CUA_API_KEY`) ended on
 * 2026-10-18; see `./cua/api.ts`. The package stores no credential: the cua.ai
 * sign-in and the cloud credentials stay in the `cua` CLI.
 *
 * Lifecycle: the sandbox is recorded (ledger, `owner.json`, exit handler)
 * before `sandbox create` runs; `gui_stop`, a failed start, shutdown, and
 * `/gui-cleanup` delete it; the process `exit` handler runs a bounded
 * `cua sandbox rm --force`; whatever survives a crash is deleted by the next
 * start's sweep from the ledger, and at the latest by the cloud's expiry
 * (`cua cloud connect --ttl-hours`, default 8 h). `keepSandbox` keeps it.
 */
import { access, constants, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { SessionError, type Backend, type Session, type SessionStartOptions } from "../backend.ts";
import type { CommonCheckOptions } from "../checks/common.ts";
import type { Check, CheckResult } from "../checks/types.ts";
import type { BackendId, ResolvedConfig, TargetOs } from "../config/types.ts";
import { TextTail } from "../framing/log-event.ts";
import { PROTOCOL_VERSION, type Leftover, type LogEvent } from "../protocol.ts";
import { createSpawnRunner } from "../runner/spawn.ts";
import type { CommandRunner } from "../runner/types.ts";
import type { LocalSpawner } from "../transport/local-process.ts";
import type { CostEstimate } from "../usage/detector.ts";
import type { SessionUsage } from "../usage/types.ts";
import type { BillingCapability, BillingSetupInputs, BillingStatus, CostCapability, DriftCapability, OrphanAuditGate, ResetCapability, SmokeCapability, SweepAvailability } from "./capabilities.ts";
import { CuaApiError, isCloudLocation, sandboxRef, type CuaApi, type SandboxInfo } from "./cua/api.ts";
import { chooseLocation, cuaChecks } from "./cua/checks.ts";
import { CuaCliApi } from "./cua/cli-api.ts";
import { CuaCostLedger, reportedRate } from "./cua/cost.ts";
import { deployHelper, ensureHelperPackages, setupUsesPip, syncWorkspace } from "./cua/deploy.ts";
import { hostTag, projectKey, sandboxName, SandboxLedger, type LedgerRecord } from "./cua/ledger.ts";
import { auditCuaOrphans, deleteKeptSandboxes, hasDeadOwnerRecords, sweepCuaOrphans } from "./cua/orphans.ts";
import { redact } from "./cua/redact.ts";
import { CuaSession, GUEST_ROOT, guestDir, pendingSession, SandboxHandle, startError } from "./cua/session.ts";
import { billingAcknowledgementText, CuaSettingsStore, DEFAULT_IMAGE } from "./cua/settings.ts";
import { packageVersion } from "./docker/package.ts";
import { attachStartLeftovers, stopAfterFailedStart } from "./start-failure.ts";

export { CUA_HOST_SUPPORT } from "./cua/checks.ts";

/** Bound for one `setup` command (spec §7). */
export const CUA_SETUP_COMMAND_TIMEOUT_MS = 15 * 60_000;
/** Setup output kept for a failed setup command's message (characters; the message shows the last 2 000). */
const SETUP_TAIL_CHARS = 4 * 1024;

export interface CuaBackendOptions {
  /** Owner label of this extension instance (`<clientId>:<pid>:<startTime>:<bootId>`). */
  ownerLabel: () => string;
  /** The Cua seam; default {@link CuaCliApi} on `runner` and `spawner`. */
  api?: CuaApi;
  /** Local commands (`git ls-files`, the `cua` CLI); default `createSpawnRunner()`. */
  runner?: CommandRunner;
  spawner?: LocalSpawner;
  ledger?: SandboxLedger;
  settings?: CuaSettingsStore;
  cost?: CuaCostLedger;
  /** This machine's tag in sandbox names; default {@link hostTag}. */
  hostTag?: string;
  version?: string;
  procRoot?: string;
  common?: Partial<CommonCheckOptions>;
  /** Network probe of `cua.network` (tests). */
  probeNetwork?: (signal: AbortSignal) => Promise<string>;
  /** Targets for `cua.targets` (e.g. from `--targets`); default: the project's. */
  targets?: (projectRoot: string) => Promise<readonly TargetOs[]>;
  /** Whether a `cua` executable is on PATH (checked without running it). */
  cuaOnPath?: () => Promise<boolean>;
  /** Helper tooling archive (tests). */
  helperArchive?: () => Promise<Buffer>;
  setupTimeoutMs?: number;
  readyTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  exitWaitMs?: number;
  killWaitMs?: number;
}

/** `true` when an executable `name` is on `path` (no command runs). */
export async function executableOnPath(name: string, path: string | undefined = process.env.PATH): Promise<boolean> {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Not here; keep looking.
    }
  }
  return false;
}

export class CuaBackend implements Backend, DriftCapability, ResetCapability, SweepAvailability, OrphanAuditGate, SmokeCapability, CostCapability, BillingCapability {
  readonly id: BackendId = "cua";
  readonly version: string;
  readonly api: CuaApi;
  readonly runner: CommandRunner;
  readonly ledger: SandboxLedger;
  readonly settings: CuaSettingsStore;
  /** Billed sandbox time of this process's sessions; feed {@link estimateCost} to `UsageTracker`. */
  readonly cost: CuaCostLedger;
  readonly #options: CuaBackendOptions;
  #hostTag?: string;

  constructor(options: CuaBackendOptions) {
    this.#options = options;
    this.runner = options.runner ?? createSpawnRunner();
    this.api = options.api ?? new CuaCliApi({ runner: this.runner, ...(options.spawner ? { spawner: options.spawner } : {}) });
    this.ledger = options.ledger ?? new SandboxLedger();
    this.settings = options.settings ?? new CuaSettingsStore();
    this.cost = options.cost ?? new CuaCostLedger();
    this.version = options.version ?? packageVersion();
  }

  /** This machine's sandbox name tag (read lazily: construction runs nothing). */
  get hostTag(): string {
    return (this.#hostTag ??= this.#options.hostTag ?? hostTag());
  }

  checks(): Check[] {
    return cuaChecks({
      api: this.api,
      settings: () => this.settings.read(),
      ...(this.#options.targets ? { targets: this.#options.targets } : {}),
      ...(this.#options.probeNetwork ? { probeNetwork: this.#options.probeNetwork } : {}),
      ...(this.#options.common ? { common: this.#options.common } : {}),
    });
  }

  /** Kept or orphaned sandboxes deleted (or found gone) outside a session stop billing. */
  readonly #onDeleted = (ref: string): void => this.cost.sandboxDeleted(ref);

  /** `UsageTrackerOptions.estimateCost` for `cua` sessions. */
  estimateCost(usage: SessionUsage): CostEstimate | undefined {
    return this.cost.estimate(usage);
  }

  /**
   * `/gui-setup`: the cloud sandboxes would use (`--cloud`, else the stored
   * choice, else Cua's default cloud) and whether billing is acknowledged for
   * it. Reads `cua cloud status`; creates nothing.
   */
  async billingStatus(inputs: BillingSetupInputs, signal: AbortSignal): Promise<BillingStatus> {
    const settings = await this.settings.read();
    const providers = await this.api.cloudStatus(signal);
    const location = inputs.location !== undefined && isCloudLocation(inputs.location) ? inputs.location : undefined;
    const chosen = chooseLocation(location ? { ...settings, location } : settings, providers);
    if (!chosen.location) return { acknowledged: false, problem: chosen.why };
    const image = inputs.image ?? settings.image ?? DEFAULT_IMAGE;
    const rate = reportedRate(providers, chosen.location, image) ?? inputs.rateUsdPerHour ?? settings.rateUsdPerHour;
    const acknowledged = settings.billingAcceptedAt !== undefined && (settings.billingLocation === undefined || settings.billingLocation === chosen.location);
    return { location: chosen.location, acknowledged, text: billingAcknowledgementText(chosen.location, rate), image };
  }

  /** `/gui-setup`: stores `--cloud`, `--rate-usd-per-hour`, `--image`, and the acknowledgement in `cua.json`. */
  async recordSetupInputs(inputs: BillingSetupInputs & { acknowledgedLocation?: string }): Promise<void> {
    if (inputs.location !== undefined && !isCloudLocation(inputs.location)) throw new Error(`unknown cloud "${inputs.location}"`);
    if (inputs.acknowledgedLocation !== undefined && !isCloudLocation(inputs.acknowledgedLocation)) throw new Error(`unknown cloud "${inputs.acknowledgedLocation}"`);
    const change: Parameters<CuaSettingsStore["update"]>[0] = {};
    if (inputs.location !== undefined) change.location = inputs.location;
    if (inputs.rateUsdPerHour !== undefined) change.rateUsdPerHour = inputs.rateUsdPerHour;
    if (inputs.image !== undefined) change.image = inputs.image;
    if (inputs.acknowledgedLocation !== undefined) {
      change.billingAcceptedAt = new Date().toISOString();
      change.billingLocation = inputs.acknowledgedLocation;
    }
    if (Object.keys(change).length > 0) await this.settings.update(change);
  }

  async currentVersions(signal?: AbortSignal): Promise<Record<string, string>> {
    const versions: Record<string, string> = {
      "package.version": this.version,
      "pi.version": this.#options.common?.piVersion ?? PI_VERSION,
      protocol: String(PROTOCOL_VERSION),
      "cua.cli": await this.api.version(signal),
    };
    const providers = await this.api.cloudStatus(signal);
    const settings = await this.settings.read();
    // A different sandbox image is a different system: drift until /gui-doctor verifies it.
    versions["cua.image"] = settings.image ?? DEFAULT_IMAGE;
    const chosen = chooseLocation(settings, providers);
    if (chosen.location) {
      versions["cua.location"] = chosen.location;
      const region = providers.find((p) => p.name === chosen.location)?.region;
      if (region) versions["cua.region"] = region;
    }
    return versions;
  }

  async startSession(options: SessionStartOptions): Promise<Session> {
    const { signal, config } = options;
    const shared = config.shared;
    const fail = (message: string, code = "START_FAILED") => new SessionError(code, message);
    if (shared.network === "none") throw fail('"network": "none" is not available on cua: sandboxes always have outbound network. Remove it or use docker-linux', "UNSUPPORTED");

    let settings;
    try {
      settings = await this.settings.read();
    } catch (error) {
      throw fail(`cua settings: ${(error as Error).message}; run /gui-setup cua again`);
    }
    if (!settings.billingAcceptedAt) throw fail("billing and upload were not acknowledged; ask the user to run /gui-setup cua", "NOT_SET_UP");
    let providers;
    try {
      providers = await this.api.cloudStatus(signal);
    } catch (error) {
      throw startError("reading the cloud status", error);
    }
    const chosen = chooseLocation(settings, providers);
    if (!chosen.location) throw fail(`no cloud for sandboxes: ${chosen.why}; ask the user to run /gui-setup cua`, "NOT_SET_UP");
    const location = chosen.location;
    if (settings.billingLocation && settings.billingLocation !== location) {
      throw fail(`billing was acknowledged for ${settings.billingLocation}, but sandboxes would run in ${location}; ask the user to run /gui-setup cua`, "NOT_SET_UP");
    }
    const image = settings.image ?? DEFAULT_IMAGE;
    const rate = reportedRate(providers, location, image) ?? settings.rateUsdPerHour;
    const keep = config.keepSandbox;
    const project = projectKey(options.projectRoot);

    // A kept sandbox of this project is reused only when it was made from the configured image and still exists.
    let reused: LedgerRecord | undefined;
    const warnings: string[] = [];
    if (keep) {
      const owner = { ownerLabel: options.ownerLabel, sessionId: options.sessionId };
      const tried = new Set<string>();
      // A claimed record that is not used goes back to the kept set (or is forgotten when its sandbox is gone).
      // When that ledger transition fails, the start fails with the claim attached, so the runtime tracks
      // it and its retries (gui_stop, /gui-cleanup, shutdown) finish the transition.
      const settle = async (claimed: LedgerRecord, step: "keep" | "forget", failure: SessionError): Promise<void> => {
        const back = new SandboxHandle({ api: this.api, ledger: this.ledger, cost: this.cost, sessionId: options.sessionId, name: claimed.name, ref: claimed.ref, keep: true });
        const leftovers = step === "keep" ? await back.returnToKept() : await back.forgetGone();
        if (leftovers.length > 0) throw attachStartLeftovers(failure, pendingSession(options.sessionId, this.id, back), leftovers);
      };
      while (!reused) {
        let claimed: LedgerRecord | undefined;
        try {
          claimed = await this.ledger.claimKept(location, project, owner, { image, exclude: tried });
        } catch (error) {
          const failure = startError("claiming a kept sandbox", error);
          // The claim may have committed before the failure (for example in releasing the ledger lock): a
          // record that now names this session goes back to the kept set, or is attached to the failure.
          const committed = await this.#claimedBy(owner, tried);
          if (committed) await settle(committed, "keep", failure);
          throw failure;
        }
        if (!claimed) break;
        tried.add(claimed.name);
        let exists: SandboxInfo | undefined;
        try {
          exists = await this.api.getSandbox(claimed.ref, signal);
        } catch (error) {
          if (!(error instanceof CuaApiError && error.code === "NOT_FOUND")) {
            // Not a confirmed absence: the sandbox may still exist and bill. Keep its record (back in
            // the kept set) and fail without creating a new sandbox.
            const failure = startError(`checking the kept sandbox ${claimed.ref} (kept; try again, or delete it with /gui-reset cua)`, error);
            await settle(claimed, "keep", failure);
            throw failure;
          }
        }
        if (!exists) {
          // Only a confirmed absence (expired or deleted elsewhere) forgets the record; it no longer bills.
          this.#onDeleted(claimed.ref);
          await settle(claimed, "forget", new SessionError("START_FAILED", `forgetting the kept sandbox ${claimed.ref}, which no longer exists, failed`));
        } else if (exists.image !== undefined && exists.image !== image) {
          // Cua reports another image than the record: never reuse it. It stays kept.
          await settle(claimed, "keep", new SessionError("START_FAILED", `returning the kept sandbox ${claimed.ref} (image "${exists.image}", not "${image}") to the kept set failed`));
          warnings.push(`the kept sandbox ${claimed.ref} runs the image "${exists.image}", not "${image}", so a new sandbox was created; it keeps billing until it expires or you delete it with /gui-reset cua`);
        } else {
          reused = claimed;
        }
      }
      if (!reused) warnings.push(...(await this.#unusableKept(location, project, image, tried)));
    }
    const name = reused?.name ?? sandboxName(options.sessionId, this.hostTag);
    const ref = reused?.ref ?? sandboxRef(location, name);
    const handle = new SandboxHandle({ api: this.api, ledger: this.ledger, cost: this.cost, sessionId: options.sessionId, name, ref, keep });
    const pending = pendingSession(options.sessionId, this.id, handle);

    let stage = "creating the sandbox";
    let sync;
    try {
      // A reused sandbox exists already: a failure from here on keeps it (keepSandbox), never deletes it.
      if (reused) handle.markCreated();
      // owner.json, the ledger, and the exit handler know the sandbox before it exists (spec §7a.2).
      await options.recordResource("sandbox", ref);
      if (reused) {
        // Billed since it was created (counted once, also between sessions), not since this session.
        this.cost.start(options.sessionId, rate, undefined, { id: ref, since: Date.parse(reused.createdAt) });
        options.onExitCleanup?.(handle.forceRemoveArgv());
        stage = "preparing the kept sandbox";
        options.onStatus?.(`reusing the kept Cua sandbox ${ref}`);
        await this.api.exec(ref, ["rm", "-rf", "--", GUEST_ROOT], { timeoutMs: 60_000, signal });
      } else {
        await this.ledger.write({
          version: 1,
          name,
          ref,
          location,
          ownerLabel: options.ownerLabel,
          sessionId: options.sessionId,
          projectKey: project,
          phase: "creating",
          keep,
          createdAt: new Date().toISOString(),
          image,
        });
        options.onExitCleanup?.(this.api.forceDeleteArgv(ref));
        this.cost.start(options.sessionId, rate, undefined, { id: ref });
        options.onStatus?.(`creating a Cua sandbox in your ${location} account (billed by ${location} until it is deleted)`);
        await this.api.createSandbox({ name, location, image }, signal);
        handle.markCreated();
        await this.ledger.update(name, { phase: "created" }, { sessionId: options.sessionId });
        // With keepSandbox the exit handler leaves it alone from now on.
        options.onExitCleanup?.(handle.forceRemoveArgv());
      }
      stage = "deploying the helper";
      const deploy = { api: this.api, ref, sessionId: options.sessionId, sessionDir: options.sessionDir, signal, ...(options.onStatus ? { onStatus: options.onStatus } : {}) };
      await deployHelper({ ...deploy, ...(this.#options.helperArchive ? { helperArchive: this.#options.helperArchive } : {}) });
      stage = "installing the helper's packages";
      await ensureHelperPackages({ ...deploy, pip: setupUsesPip(shared.setup ?? []) });
      stage = "uploading the workspace";
      sync = await syncWorkspace({ ...deploy, projectRoot: options.projectRoot, allow: shared.sync?.allow, deny: shared.sync?.deny, runner: this.runner });
    } catch (error) {
      const failure = startError(stage, error);
      await stopAfterFailedStart(pending, failure);
      throw failure;
    }

    const setupTail = new TextTail(SETUP_TAIL_CHARS);
    const onLog = (event: LogEvent) => {
      if (event.source === "setup") setupTail.push(typeof event.data === "string" ? event.data : String(event.data));
      options.onLog(event);
    };
    const session = new CuaSession({
      id: options.sessionId,
      backend: this.id,
      api: this.api,
      handle,
      packageVersion: this.version,
      sync,
      onLog,
      warnings,
      ...(this.#options.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.#options.readyTimeoutMs } : {}),
      ...(this.#options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: this.#options.heartbeatIntervalMs } : {}),
      ...(this.#options.exitWaitMs !== undefined ? { exitWaitMs: this.#options.exitWaitMs } : {}),
      ...(this.#options.killWaitMs !== undefined ? { killWaitMs: this.#options.killWaitMs } : {}),
    });
    options.onStatus?.("starting the helper in the sandbox");
    // On failure start() has already stopped the session (sandbox deleted or left attached to the error).
    await session.start(signal);

    const commands = shared.setup ?? [];
    const timeoutMs = this.#options.setupTimeoutMs ?? CUA_SETUP_COMMAND_TIMEOUT_MS;
    const workspace = `${guestDir(options.sessionId)}/workspace`;
    try {
      for (const [index, cmd] of commands.entries()) {
        options.onStatus?.(`setup ${index + 1}/${commands.length}: ${cmd}`);
        const result = await session.request("exec", { cmd, cwd: workspace, env: { ...(shared.deps?.env ?? {}) }, timeoutMs }, { signal, timeoutMs: timeoutMs + 30_000 });
        if (result.exitCode !== 0) {
          const tail = setupTail.text.trim().slice(-2000);
          throw new SessionError("SETUP_FAILED", `setup command ${JSON.stringify(cmd)} exited with ${result.exitCode}${tail ? `; last output:\n${tail}` : ""}`);
        }
      }
    } catch (error) {
      await stopAfterFailedStart(session, error);
      throw error;
    }
    return session;
  }

  /** The active record a claim of `owner` committed (not one of `tried`, which are settled already), if any. */
  async #claimedBy(owner: { ownerLabel: string; sessionId: string }, tried: ReadonlySet<string>): Promise<LedgerRecord | undefined> {
    const entries = await this.ledger.entries().catch(() => []);
    return entries.find((e) => !e.kept && e.record && e.record.sessionId === owner.sessionId && e.record.ownerLabel === owner.ownerLabel && e.record.phase === "created" && !tried.has(e.record.name))?.record;
  }

  /** Launch warnings for kept sandboxes of this project that cannot be reused with `image` (not already reported). */
  async #unusableKept(location: string, project: string, image: string, reported: ReadonlySet<string>): Promise<string[]> {
    const warnings: string[] = [];
    for (const entry of await this.ledger.entries().catch(() => [])) {
      const r = entry.record;
      if (!entry.kept || !r || r.phase === "deleting" || r.location !== location || r.projectKey !== project || r.image === image || reported.has(r.name)) continue;
      const why = r.image === undefined ? "was kept by an older version that did not record its image" : `was made from the image "${r.image}", not "${image}"`;
      warnings.push(`the kept sandbox ${r.ref} ${why}, so it was not reused; it keeps billing until it expires or you delete it with /gui-reset cua`);
    }
    return warnings;
  }

  /**
   * Startup: only when a ledger record names a dead owner (files and `/proc`
   * only, no network) and `cua` is on PATH. `/gui-cleanup`: whenever `cua` is
   * on PATH.
   */
  async sweepAvailable(context: { startup: boolean }): Promise<boolean> {
    if (!(await (this.#options.cuaOnPath ?? (() => executableOnPath("cua")))().catch(() => false))) return false;
    if (!context.startup) return true;
    return hasDeadOwnerRecords(this.ledger, this.#options.procRoot).catch(() => false);
  }

  /** Doctor audits Cua orphans only when the authenticated call passed. */
  orphanAuditReady(results: readonly CheckResult[]): boolean {
    return results.some((r) => r.id === "cua.auth" && r.status === "pass");
  }

  auditOrphans(signal: AbortSignal): Promise<Leftover[]> {
    return auditCuaOrphans({ api: this.api, ledger: this.ledger, hostTag: this.hostTag, signal, ...(this.#options.procRoot ? { procRoot: this.#options.procRoot } : {}) });
  }

  async sweepOrphans(signal: AbortSignal): Promise<Leftover[]> {
    return (await sweepCuaOrphans({ api: this.api, ledger: this.ledger, hostTag: this.hostTag, signal, onDeleted: this.#onDeleted, ...(this.#options.procRoot ? { procRoot: this.#options.procRoot } : {}) })).leftovers;
  }

  readonly resetSummary =
    "Stops its sessions, deletes the sandboxes kept by keepSandbox (and any whose deletion did not finish), and removes the billing acknowledgement, cua settings, verified state, and backend choice. The cua CLI, your cua.ai sign-in, and your cloud connection stay.";
  readonly resetNote = "system packages: setup installs nothing on this computer for cua; sign out with `cua auth logout` and disconnect clouds with `cua cloud disconnect` yourself if you want";

  /** `/gui-reset`: kept sandboxes, sandboxes pending deletion, and the settings file. */
  async resetData(signal: AbortSignal): Promise<{ lines: string[]; leftovers: Leftover[] }> {
    const lines: string[] = [];
    const leftovers: Leftover[] = [];
    try {
      const kept = await deleteKeptSandboxes({ api: this.api, ledger: this.ledger, hostTag: this.hostTag, signal, onDeleted: this.#onDeleted });
      lines.push(`deleted ${kept.deleted.length} kept sandbox(es)`);
      leftovers.push(...kept.leftovers);
    } catch (error) {
      leftovers.push({ kind: "sandbox", id: "kept", detail: `deleting kept sandboxes failed: ${redact((error as Error).message)}` });
    }
    try {
      await this.settings.remove();
      lines.push("removed the cua settings (billing acknowledgement, cloud, image, rate)");
    } catch (error) {
      leftovers.push({ kind: "file", id: this.settings.path, detail: (error as Error).message });
    }
    return { lines, leftovers };
  }

  /** The bundled GTK 3 app, deployed with the helper (relative to the workspace, the launch cwd). */
  smokeApp(): { cmd: string; args: string[] } {
    return { cmd: "python3", args: ["../tools/testapps/gtk3-smoke/app.py"] };
  }

  /** Sandboxes have no mounts and always have outbound network. */
  smokeConfig(base: ResolvedConfig): ResolvedConfig {
    return { ...base, shared: { ...base.shared, workspaceMode: "copy", network: "default" } };
  }
}
