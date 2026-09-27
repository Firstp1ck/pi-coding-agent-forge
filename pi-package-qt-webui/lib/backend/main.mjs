#!/usr/bin/env node
import path from "node:path";
import { createPortalAppearanceMonitor } from "./appearance.mjs";
import { openExternalLink, openLocalPath, sendDesktopNotification } from "./desktop.mjs";
import { createDirectory, listDirectory } from "./directories.mjs";
import { createWorktree, listWorktrees, planWorktree } from "./git.mjs";
import { attachJsonlReader } from "./jsonl.mjs";
import { createPiSession } from "./pi-session.mjs";
import { killProcessTreeNow } from "./process-tree.mjs";
import {
  LIMITS,
  PROTOCOL_VERSION,
  ProtocolError,
  boundedError,
  encodeFrame,
  makeErrorResponse,
  makeEvent,
  makeResponse,
  validateRequest,
} from "./protocol.mjs";
import { createResourceStore, resolveEffective, resourceModelKey, updateProfile, validateProfile } from "./resources.mjs";
import { SAMPLING_KEYS, supportedSamplingValues } from "./sampling.mjs";
import { createSequenceStore } from "./sequences.mjs";
import { createSessionSyncMonitor, loadPersistedSessionSnapshot, sessionRevisionKey, snapshotLoadDiagnostics, stopSnapshotLoads } from "./session-sync.mjs";
import { createSessionCatalog, managedSessionPath, sessionsDirectory } from "./sessions-index.mjs";
import { createSettingsStore } from "./settings.mjs";
import { createStateStore, sessionSettlementKey } from "./state.mjs";
import { createTabRegistry } from "./tabs.mjs";
import { createThemeService } from "./themes.mjs";

// Backend entry point. Quickshell starts this process, writes protocol requests to its stdin,
// and reads responses and events from its stdout. The backend owns every Pi child (one per tab)
// and every helper it starts; closing stdin, SIGINT, SIGTERM, SIGHUP, or a fatal error all lead
// to the same bounded shutdown that terminates and reaps the whole process tree.

const COALESCABLE_EVENTS = new Set(["part.render", "tool.update"]);

// Every request that can persist session state is fenced here. Explicit switch/new/restart paths
// reconcile or replace the child themselves and therefore manage stale state in the registry.
export const SESSION_MUTATION_REQUESTS = new Set([
  "prompt",
  "sequence_run",
  "tab_rename",
  "compact",
  "model_set",
  "model_cycle",
  "thinking_set",
  "thinking_cycle",
  "resources_state",
  "tools_set",
  "skills_set",
  "sampling_set",
]);

export function createBackend({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  exit = (code) => process.exit(code),
  onFatal = null,
  createSessionMonitor = createSessionSyncMonitor,
  loadSessionSnapshot = loadPersistedSessionSnapshot,
  createTabSession = (options) => createPiSession(options),
  sessionSyncNow = () => Date.now(),
} = {}) {
  const smokeMode = env.QT_WEBUI_SMOKE_MODE === "1";
  const nodeExecutable = env.QT_WEBUI_NODE_EXECUTABLE || process.execPath;
  const piCliEntry = env.QT_WEBUI_PI_CLI_ENTRY || "";
  const cwd = env.QT_WEBUI_CALLER_CWD || process.cwd();
  const startupReadinessMs = Number.parseInt(env.QT_WEBUI_PI_STARTUP_TIMEOUT_MS ?? "", 10);
  const piRequestTimeoutMs = smokeMode ? Number.parseInt(env.QT_WEBUI_PI_REQUEST_TIMEOUT_MS ?? "", 10) : Number.NaN;
  const helperTimeoutMs = smokeMode ? Number.parseInt(env.QT_WEBUI_HELPER_TIMEOUT_MS ?? "", 10) : Number.NaN;
  const smokeNowMs = smokeMode ? Number.parseInt(env.QT_WEBUI_SMOKE_NOW_MS ?? "", 10) : Number.NaN;
  const now = Number.isSafeInteger(smokeNowMs) && smokeNowMs >= 0 ? () => smokeNowMs : () => Date.now();

  let sequence = 0;
  let dropped = 0;
  let droppedTotal = 0;
  let queuedRecords = 0;
  let maxWritableLength = 0;
  let backpressured = false;
  let backpressurePauses = 0;
  let drainTimer = null;
  let slowConsumerShutdowns = 0;
  let peakQueuedRecords = 0;
  let peakAdmittedWork = 0;
  const controlRequests = new Set(["abort", "shutdown"]);

  function transportSnapshot() {
    return { queuedBytes: output.writableLength, queuedRecords, maxWritableLength, peakQueuedRecords,
      backpressurePauses, producersPaused: backpressured, admittedWork: inflight.size, peakAdmittedWork,
      admittedResponseBytes: inflight.size * LIMITS.maxOutboundFrameBytes, slowConsumerShutdowns, rss: process.memoryUsage().rss, peakRss: process.resourceUsage().maxRSS * 1024, droppedTotal };
  }

  function slowConsumer(reason) {
    if (slowConsumerShutdowns || closing) return;
    slowConsumerShutdowns++;
    void shutdown(75, `slow consumer: ${reason}`);
  }
  let closing = false;
  let attachmentMetadata = false;

  function attachmentOptions(request, tab) {
    return { metadataOnly: attachmentMetadata, preflight: data => {
      if (!attachmentMetadata && Buffer.byteLength(JSON.stringify(data.attachments)) > LIMITS.maxAttachmentLegacyListBytes) throw new ProtocolError("limit_exceeded", "Legacy attachment lists exceeded their wire budget; use metadata attachment negotiation");
      for (const record of [makeResponse(request.id, data), makeResponse(request.id, { ...tabSnapshot(tab), attachments: data.attachments })]) {
        if (Buffer.byteLength(encodeFrame(record)) > LIMITS.maxOutboundFrameBytes) throw new ProtocolError("limit_exceeded", "Attachment result would exceed the wire budget");
      }
    } };
  }
  let shutdownPromise = null;
  const inflight = new Map();
  const exclusiveTabOperations = new Set();
  const mutatingTabOperations = new Map();

  // Slow-consumer policy: coalescable records (streaming renders, tool progress) are dropped
  // while the outbound queue is over budget. Both Pi streams pause, ordinary requests refuse
  // admission, and a hard ceiling or drain deadline triggers controlled shutdown.
  function engageBackpressure() {
    if (backpressured) return;
    backpressured = true;
    backpressurePauses += 1;
    for (const tab of allTabs()) tab.session.pauseInput();
    drainTimer = setTimeout(() => slowConsumer("drain deadline exceeded"), LIMITS.transportDrainMs);
    emit("backend.backpressure", { paused: true, queuedBytes: output.writableLength });
    output.once("drain", () => {
      clearTimeout(drainTimer);
      backpressured = false;
      for (const tab of allTabs()) { if (backpressured || closing) break; tab.session.resumeInput(); }
      if (!backpressured && !closing) emit("backend.backpressure", { paused: false, queuedBytes: output.writableLength });
    });
  }

  function writeFrame(record, { essential }) {
    let text = encodeFrame(record);
    if (Buffer.byteLength(text, "utf8") > LIMITS.maxOutboundFrameBytes) {
      const replacement = record.kind === "response"
        ? makeErrorResponse(record.id, "limit_exceeded", "response exceeded the outbound frame limit")
        : makeEvent("notice", { seq: record.seq, level: "error", message: `Dropped an oversized ${record.type} event` });
      text = encodeFrame(replacement);
    }
    const bytes = Buffer.byteLength(text, "utf8");
    const queuedBytes = output.writableLength;
    const control = record.type === "backend.closing" || record.type === "backend.fatal" || record.data?.closing === true;
    if (queuedBytes + bytes > LIMITS.maxTransportBytes + (control ? LIMITS.transportControlBytes : 0)
      || (!control && queuedRecords >= LIMITS.maxTransportRecords)) {
      slowConsumer("transport retention limit exceeded");
      return false;
    }
    if (slowConsumerShutdowns && !control) return false;
    const overBudget = queuedBytes + bytes > LIMITS.maxQueuedBytes;
    if ((overBudget || queuedRecords >= LIMITS.maxQueuedRecords) && !essential) {
      dropped += 1;
      droppedTotal += 1;
      return false;
    }
    queuedRecords += 1;
    peakQueuedRecords = Math.max(peakQueuedRecords, queuedRecords);
    maxWritableLength = Math.max(maxWritableLength, queuedBytes + bytes);
    const flushed = output.write(text, () => {
      queuedRecords = Math.max(0, queuedRecords - 1);
      if (dropped > 0 && queuedRecords === 0) {
        const count = dropped;
        dropped = 0;
        emit("events.dropped", { count });
      }
    });
    // Node emits "drain" only after a write returned false, so engage only on that path.
    if ((overBudget || queuedRecords >= LIMITS.maxQueuedRecords) && !flushed && !closing) engageBackpressure();
    return true;
  }

  function emit(type, payload = {}) {
    sequence += 1;
    const essential = !COALESCABLE_EVENTS.has(type) || payload.final === true;
    return writeFrame(makeEvent(type, { seq: sequence, ...payload }), { essential });
  }

  function respond(id, data) {
    writeFrame(makeResponse(id, data), { essential: true });
  }

  function respondError(id, code, message) {
    writeFrame(makeErrorResponse(id, code, message), { essential: true });
  }

  const appearance = createPortalAppearanceMonitor({
    env,
    onChange: (portalColorScheme) => emit("appearance.changed", { portalColorScheme }),
  });
  const settings = createSettingsStore({ env });
  const state = createStateStore({ env, now });
  const sequences = createSequenceStore({ env });
  const resources = createResourceStore({ env });
  const sessionCatalog = createSessionCatalog({ env, now });
  const themes = createThemeService({
    cwd,
    settingsStore: settings,
    onChange: (themeState) => emit("themes.changed", { state: themeState }),
  });
  const sessionOptions = {
    nodeExecutable,
    piCliEntry,
    env,
    ...(Number.isFinite(startupReadinessMs) && startupReadinessMs > 0 ? { startupReadinessMs } : {}),
    ...(Number.isFinite(piRequestTimeoutMs) && piRequestTimeoutMs > 0
      ? { requestTimeouts: { ...LIMITS.requestTimeoutMs, prompt: piRequestTimeoutMs, abort: piRequestTimeoutMs, state: piRequestTimeoutMs } }
      : {}),
    ...(Number.isFinite(helperTimeoutMs) && helperTimeoutMs > 0 ? { helperTimeoutMs } : {}),
  };
  let sessionMonitor = null;
  let monitorPathsPromise = Promise.resolve();
  let monitorPathsRunning = false;
  let monitorPathsDirty = false;
  let registryPathGeneration = 0;
  let registryOwnedSessionPaths = new Set();
  let monitoredSessionPaths = new Set();
  let futureSessionPaths = new Set();
  const pendingSessionChanges = new Map();
  const reconcilingSessionPaths = new Set();
  const reconciliationFailures = new Map();
  const reconciliationWarnings = new Set();
  const reconciliationBackoffBaseMs = 2_000;
  const reconciliationBackoffMaxMs = 60_000;

  function warnSessionSyncOnce(operation, error, tab = "") {
    const code = typeof error?.code === "string" ? error.code : error?.name || "Error";
    const key = `${operation}:${code}`;
    if (reconciliationWarnings.has(key)) return;
    if (reconciliationWarnings.size >= LIMITS.maxSessionSyncWarnings) reconciliationWarnings.delete(reconciliationWarnings.values().next().value);
    reconciliationWarnings.add(key);
    emit("notice", { ...(tab ? { tab } : {}), level: "warning", message: `Session synchronization: ${boundedError(error?.message ?? String(error))}` });
  }

  function pruneSessionSyncState() {
    for (const sessionPath of pendingSessionChanges.keys()) {
      if (registryOwnedSessionPaths.has(path.resolve(sessionPath))) continue;
      pendingSessionChanges.delete(sessionPath);
      reconcilingSessionPaths.delete(sessionPath);
      reconciliationFailures.delete(sessionPath);
    }
    for (const sessionPath of reconciliationFailures.keys()) {
      if (!registryOwnedSessionPaths.has(path.resolve(sessionPath))) reconciliationFailures.delete(sessionPath);
    }
    futureSessionPaths = new Set([...futureSessionPaths].filter((sessionPath) => registryOwnedSessionPaths.has(sessionPath)));
  }

  function samePathSet(left, right) {
    return left.size === right.size && [...left].every((sessionPath) => right.has(sessionPath));
  }

  async function runMonitoredPathValidation() {
    const requested = [...registryOwnedSessionPaths];
    const validated = await Promise.all(requested.map(async (sessionPath) => {
      try {
        return { path: (await managedSessionPath(sessionPath, { env })).path, valid: true, retry: false };
      } catch (error) {
        return { path: sessionPath, valid: false, retry: error?.code === "unavailable" };
      }
    }));
    const nextMonitored = new Set(validated
      .filter((entry) => entry.valid && registryOwnedSessionPaths.has(path.resolve(entry.path)))
      .map((entry) => entry.path));
    const nextFuture = new Set(validated
      .filter((entry) => entry.retry && registryOwnedSessionPaths.has(entry.path))
      .map((entry) => entry.path));
    if (!samePathSet(monitoredSessionPaths, nextMonitored)) registryPathGeneration += 1;
    monitoredSessionPaths = nextMonitored;
    futureSessionPaths = nextFuture;
    pruneSessionSyncState();
    return sessionMonitor.setOpenSessionPaths([...monitoredSessionPaths]);
  }

  function validateMonitoredPaths() {
    if (!sessionMonitor) return monitorPathsPromise;
    if (monitorPathsRunning) {
      monitorPathsDirty = true;
      return monitorPathsPromise;
    }
    monitorPathsRunning = true;
    monitorPathsPromise = (async () => {
      do {
        monitorPathsDirty = false;
        try {
          await runMonitoredPathValidation();
        } catch (error) {
          warnSessionSyncOnce("open-paths", error);
        }
      } while (monitorPathsDirty);
    })().finally(() => {
      monitorPathsRunning = false;
    });
    return monitorPathsPromise;
  }

  function updateMonitoredPaths(paths) {
    registryOwnedSessionPaths = new Set(paths.map((entry) => path.resolve(entry.path)));
    registryPathGeneration += 1;
    pruneSessionSyncState();
    return validateMonitoredPaths();
  }

  const registry = createTabRegistry({
    emit,
    state,
    callerCwd: cwd,
    createSession: ({ cwd: tabCwd, emit: tabEmit }) => createTabSession({ ...sessionOptions, cwd: tabCwd, emit: tabEmit }),
    onSessionPathsChange: (paths) => updateMonitoredPaths(paths),
    onSessionIdle: (tab) => retryPendingSessionChanges(tab),
  });

  function tabForSessionPath(sessionPath) {
    const resolved = path.resolve(sessionPath);
    return registry.ownerOf(sessionPath) ?? allTabs().find((tab) => tab.sessionFile && path.resolve(tab.sessionFile) === resolved) ?? null;
  }

  function tabSessionSyncBusy(tab) {
    return tab.session.snapshot().active
      || exclusiveTabOperations.has(tab.id)
      || (mutatingTabOperations.get(tab.id) ?? 0) > 0
      || registry.isPreparingMutation(tab.id);
  }

  function recordReconciliationFailure(pending) {
    const previous = reconciliationFailures.get(pending.path);
    const attempts = previous?.revisionKey === pending.revisionKey ? previous.attempts + 1 : 1;
    const delayMs = Math.min(reconciliationBackoffBaseMs * (2 ** Math.min(attempts - 1, 10)), reconciliationBackoffMaxMs);
    reconciliationFailures.set(pending.path, {
      revisionKey: pending.revisionKey,
      attempts,
      retryAfterMs: sessionSyncNow() + delayMs,
    });
  }

  async function reconcileSessionChange(change) {
    if (closing) return;
    const resolvedPath = path.resolve(change.path);
    const normalizedChange = { ...change, path: resolvedPath };
    const previousFailure = reconciliationFailures.get(resolvedPath);
    if (previousFailure && previousFailure.revisionKey !== change.revisionKey) reconciliationFailures.delete(resolvedPath);
    pendingSessionChanges.set(resolvedPath, normalizedChange);
    if (reconcilingSessionPaths.has(resolvedPath)) return;
    reconcilingSessionPaths.add(resolvedPath);
    try {
      while (pendingSessionChanges.has(resolvedPath)) {
        const pending = pendingSessionChanges.get(resolvedPath);
        const tab = tabForSessionPath(pending.path);
        if (!tab || !registryOwnedSessionPaths.has(pending.path) || !monitoredSessionPaths.has(pending.path)) {
          pendingSessionChanges.delete(pending.path);
          reconciliationFailures.delete(pending.path);
          sessionMonitor?.acknowledgeSessionRevision(pending.path, pending.revisionKey);
          break;
        }
        if (tabSessionSyncBusy(tab)) break;
        const failure = reconciliationFailures.get(pending.path);
        if (failure?.revisionKey === pending.revisionKey && sessionSyncNow() < failure.retryAfterMs) break;

        const loadRegistryGeneration = registryPathGeneration;
        const loadTabGeneration = registry.sessionSyncGeneration(tab.id);
        try {
          const managed = await managedSessionPath(pending.path, { env });
          if (managed.path !== pending.path) throw new Error("The monitored session path changed during validation");
        } catch (error) {
          pendingSessionChanges.delete(pending.path);
          reconciliationFailures.delete(pending.path);
          sessionMonitor?.acknowledgeSessionRevision(pending.path, pending.revisionKey);
          warnSessionSyncOnce("snapshot-path", error, tab.id);
          break;
        }

        let snapshot;
        try {
          snapshot = await loadSessionSnapshot(pending.path, { isCurrent: () => pendingSessionChanges.get(pending.path) === pending
            && registryPathGeneration === loadRegistryGeneration && registry.sessionSyncGeneration(tab.id) === loadTabGeneration });
        } catch (error) {
          if (pendingSessionChanges.get(pending.path) !== pending || error.code === "stale_request") continue;
          recordReconciliationFailure(pending);
          warnSessionSyncOnce(`snapshot-load:${pending.path}:${pending.revisionKey}`, error, tab.id);
          break;
        }
        if (pendingSessionChanges.get(pending.path) !== pending) continue;
        const currentTab = tabForSessionPath(pending.path);
        if (!currentTab
          || currentTab.id !== tab.id
          || registryPathGeneration !== loadRegistryGeneration
          || registry.sessionSyncGeneration(tab.id) !== loadTabGeneration) continue;
        if (tabSessionSyncBusy(tab)) break;
        if (!registryOwnedSessionPaths.has(pending.path) || !monitoredSessionPaths.has(pending.path)) {
          pendingSessionChanges.delete(pending.path);
          reconciliationFailures.delete(pending.path);
          sessionMonitor?.acknowledgeSessionRevision(pending.path, pending.revisionKey);
          break;
        }
        if (sessionRevisionKey(snapshot.revision) !== pending.revisionKey) {
          recordReconciliationFailure(pending);
          break;
        }
        reconciliationFailures.delete(pending.path);
        const result = registry.applyExternalSnapshot(pending.path, snapshot);
        if (result.reason === "active") break;
        if (pendingSessionChanges.get(pending.path) === pending) pendingSessionChanges.delete(pending.path);
        sessionMonitor?.acknowledgeSessionRevision(pending.path, pending.revisionKey);
      }
    } finally {
      reconcilingSessionPaths.delete(resolvedPath);
    }
  }

  function retryPendingSessionChanges(tab) {
    if (closing) return;
    for (const change of pendingSessionChanges.values()) {
      if (!tab.sessionFile || path.resolve(change.path) !== path.resolve(tab.sessionFile)) continue;
      void reconcileSessionChange(change);
    }
  }

  sessionMonitor = createSessionMonitor({
    sessionsRoot: sessionsDirectory(env),
    onCatalogChange: (event) => {
      sessionCatalog.invalidate();
      emit("sessions.changed", { reason: event.reason });
      if (futureSessionPaths.size > 0) void validateMonitoredPaths();
    },
    onSessionChange: (change) => {
      registry.noteSessionRevision(change.path, change.revisionKey);
      void reconcileSessionChange(change);
    },
    onWarning: (warning) => warnSessionSyncOnce(warning.operation, warning),
  });

  function allTabs() {
    return registry.list().tabs.map((entry) => registry.get(entry.id)).filter(Boolean);
  }

  function tabFor(request) {
    return registry.require(request.tab);
  }

  function tabSnapshot(tab) {
    const summary = registry.list().tabs.find((entry) => entry.id === tab.id);
    const snapshot = tab.session.snapshot();
    return { selectionGeneration: registry.selectionGeneration, tab: summary,
      session: { ...snapshot, ready: summary.ready, statusKind: summary.statusKind, statusText: summary.statusText },
      attachments: tab.attachments.list({ metadataOnly: attachmentMetadata }) };
  }

  function normalizedNames(value, known, field) {
    if (value === null) return null;
    if (!Array.isArray(value)) throw new ProtocolError("unavailable", `The helper did not report a valid ${field} session override`);
    const result = [];
    for (const entry of value) {
      if (typeof entry !== "string" || !known.has(entry) || result.includes(entry)) throw new ProtocolError("unavailable", `The helper reported an invalid ${field} name`);
      result.push(entry);
      if (result.length > LIMITS.maxResourceNames) throw new ProtocolError("unavailable", `The helper reported too many ${field} names`);
    }
    return result;
  }

  function normalizeHelperState(tab, raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProtocolError("unavailable", "The helper did not report resource capability state");
    const runtime = tab.session.snapshot().runtime;
    const model = raw.model && typeof raw.model === "object" ? raw.model : null;
    if (!model || model.provider !== runtime.provider || model.id !== runtime.modelId || typeof model.api !== "string") {
      throw new ProtocolError("unavailable", "The helper resource capability state is stale for the active model");
    }
    const toolRows = raw.tools && Array.isArray(raw.tools.all) ? raw.tools.all : null;
    const skillRows = raw.skills && Array.isArray(raw.skills.all) ? raw.skills.all : null;
    if (!toolRows || !skillRows || toolRows.length > LIMITS.maxResourceNames || skillRows.length > LIMITS.maxResourceNames) {
      throw new ProtocolError("unavailable", "The helper did not report bounded tool and skill inventories");
    }
    const tools = toolRows.filter((entry) => entry && typeof entry.name === "string" && entry.name.length > 0 && entry.name.length <= 128)
      .map((entry) => ({ name: entry.name, description: String(entry.description || "").slice(0, 256), source: String(entry.source || "").slice(0, 128) }));
    const skills = skillRows.filter((entry) => entry && typeof entry.name === "string" && entry.name.length > 0 && entry.name.length <= 128)
      .map((entry) => ({ name: entry.name, description: String(entry.description || "").slice(0, 256), filePath: typeof entry.filePath === "string" && entry.filePath.length <= LIMITS.maxPathCharacters ? entry.filePath : "", disableModelInvocation: entry.disableModelInvocation === true }));
    if (new Set(tools.map((entry) => entry.name)).size !== tools.length || new Set(skills.map((entry) => entry.name)).size !== skills.length) {
      throw new ProtocolError("unavailable", "The helper reported duplicate resource names");
    }
    const capabilities = raw.sampling && raw.sampling.capabilities && typeof raw.sampling.capabilities === "object" ? raw.sampling.capabilities : null;
    if (!capabilities || SAMPLING_KEYS.some((key) => !capabilities[key] || typeof capabilities[key].supported !== "boolean" || typeof capabilities[key].reason !== "string")) {
      throw new ProtocolError("unavailable", "The helper did not report complete sampling capabilities");
    }
    const toolNames = new Set(tools.map((entry) => entry.name));
    const skillNames = new Set(skills.map((entry) => entry.name));
    const activeTools = normalizedNames(raw.tools.active, toolNames, "active tool");
    const enabledSkills = normalizedNames(raw.skills.enabled, skillNames, "enabled skill");
    if (!Array.isArray(activeTools) || !Array.isArray(enabledSkills) || !raw.sampling.applied || typeof raw.sampling.applied !== "object" || Array.isArray(raw.sampling.applied)) {
      throw new ProtocolError("unavailable", "The helper did not report validated applied resource values");
    }
    const appliedSampling = validateProfile({ sampling: raw.sampling.applied }).sampling;
    const sessionRaw = raw.session && typeof raw.session === "object" ? raw.session : {};
    const sessionProfile = validateProfile({
      tools: normalizedNames(sessionRaw.tools ?? null, toolNames, "tool"),
      skills: normalizedNames(sessionRaw.skills ?? null, skillNames, "skill"),
      sampling: sessionRaw.sampling,
    });
    const durabilityRaw = sessionRaw.durability;
    if (!durabilityRaw || typeof durabilityRaw !== "object" || typeof durabilityRaw.durable !== "boolean" || typeof durabilityRaw.reason !== "string") {
      throw new ProtocolError("unavailable", "The helper did not report session profile durability");
    }
    const durability = { durable: durabilityRaw.durable, reason: boundedError(durabilityRaw.reason) };
    return {
      model: { provider: model.provider, id: model.id, api: model.api },
      thinkingLevel: typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : "",
      sessionProfile,
      durability,
      tools,
      skills,
      toolNames,
      skillNames,
      activeTools,
      enabledSkills,
      appliedSampling,
      sampling: { api: model.api, capabilities, thinkingActive: raw.sampling.thinkingActive === true },
    };
  }

  function resourceContextFrom(tab, helper, stored) {
    const modelProfile = stored.value.models[resourceModelKey(helper.model.provider, helper.model.id)] ?? validateProfile(null);
    const effective = resolveEffective({ session: helper.sessionProfile, model: modelProfile, global: stored.value.global });
    return { tab, helper, stored, modelProfile, effective };
  }

  async function resourceContext(tab) {
    await registry.prepareMutation(tab.id);
    const helper = normalizeHelperState(tab, await tab.session.helperState());
    return resourceContextFrom(tab, helper, await resources.read());
  }

  function helperEffective(context) {
    return {
      tools: context.effective.tools === null ? null : context.effective.tools.filter((name) => context.helper.toolNames.has(name)),
      skills: context.effective.skills === null ? null : context.effective.skills.filter((name) => context.helper.skillNames.has(name)),
      sampling: supportedSamplingValues(context.effective.sampling, context.helper.sampling.capabilities),
    };
  }

  function validateAppliedHelper(context, helper) {
    const expected = helperEffective(context);
    if (expected.tools !== null && JSON.stringify(helper.activeTools) !== JSON.stringify(expected.tools)) {
      throw new ProtocolError("unavailable", "The helper did not apply the requested enabled tools exactly");
    }
    if (expected.skills !== null && JSON.stringify(helper.enabledSkills) !== JSON.stringify(expected.skills)) {
      throw new ProtocolError("unavailable", "The helper did not apply the requested enabled skills exactly");
    }
    if (JSON.stringify(helper.appliedSampling) !== JSON.stringify(expected.sampling)) {
      throw new ProtocolError("unavailable", "The helper did not apply the requested sampling values exactly");
    }
    if (JSON.stringify(helper.sessionProfile) !== JSON.stringify(context.helper.sessionProfile)) {
      throw new ProtocolError("unavailable", "The helper did not retain the requested session resource profile exactly");
    }
    return helper;
  }

  function resourceResult(context) {
    return {
      available: true,
      model: context.helper.model,
      thinkingLevel: context.helper.thinkingLevel,
      profiles: { session: context.helper.sessionProfile, model: context.modelProfile, global: context.stored.value.global },
      sessionDurability: context.helper.durability,
      effective: context.effective,
      tools: { all: context.helper.tools },
      skills: { all: context.helper.skills },
      sampling: { ...context.helper.sampling, applied: context.helper.appliedSampling },
      problems: context.stored.problems,
      path: context.stored.path,
      sharedPath: context.stored.sharedPath,
    };
  }

  async function readResources(tab, { apply = true } = {}) {
    const context = await resourceContext(tab);
    if (!apply) return resourceResult(context);
    const applied = normalizeHelperState(tab, await tab.session.helperApply({ effective: helperEffective(context) }));
    validateAppliedHelper(context, applied);
    return resourceResult(resourceContextFrom(tab, applied, context.stored));
  }

  async function safeReadResources(tab) {
    try {
      return await readResources(tab);
    } catch (error) {
      return { available: false, error: { code: error instanceof ProtocolError ? error.code : "unavailable", message: boundedError(error?.message ?? String(error)) } };
    }
  }

  function assertExclusiveTabOperationAvailable(tab) {
    if (exclusiveTabOperations.has(tab.id)) throw new ProtocolError("busy", "Another resource, model, or session operation is already in progress for this tab");
  }

  async function withExclusiveTabOperation(tab, operation) {
    assertExclusiveTabOperationAvailable(tab);
    exclusiveTabOperations.add(tab.id);
    try {
      return await operation();
    } finally {
      exclusiveTabOperations.delete(tab.id);
      retryPendingSessionChanges(tab);
    }
  }

  function prospectiveStored(before, scope, field, value) {
    if (scope === "session") return before.stored;
    const nextValue = structuredClone(before.stored.value);
    if (scope === "global") nextValue.global = updateProfile(nextValue.global, field, value);
    else {
      const key = resourceModelKey(before.helper.model.provider, before.helper.model.id);
      nextValue.models[key] = updateProfile(nextValue.models[key] ?? validateProfile(null), field, value);
    }
    return { ...before.stored, value: nextValue };
  }

  function prospectiveContext(before, scope, field, value, stored) {
    const helper = scope === "session"
      ? { ...before.helper, sessionProfile: updateProfile(before.helper.sessionProfile, field, value) }
      : before.helper;
    return resourceContextFrom(before.tab, helper, stored);
  }

  async function rollbackResources(attempted, beforeById, scope, field, cause) {
    const failures = [];
    for (const target of attempted.slice().reverse()) {
      const before = beforeById.get(target.id);
      if (!before) continue;
      try {
        const session = scope === "session" ? { [field]: before.helper.sessionProfile[field] } : undefined;
        await target.session.helperApply({ ...(session ? { session } : {}), effective: helperEffective(before) });
      } catch (error) {
        failures.push(`${target.id}: ${boundedError(error?.message ?? String(error))}`);
      }
    }
    if (failures.length > 0) {
      throw new ProtocolError("internal_error", `The resource change did not commit, and rollback failed (${failures.join("; ")}). The affected session state may be inconsistent. Original error: ${boundedError(cause?.message ?? String(cause))}`);
    }
    throw cause;
  }

  async function setResource(tab, scope, field, value) {
    const acquired = [];
    let targets = [tab];
    try {
      if (scope === "global") targets = allTabs();
      else if (scope === "model") {
        const runtime = tab.session.snapshot().runtime;
        targets = allTabs().filter((candidate) => {
          const candidateRuntime = candidate.session.snapshot().runtime;
          return candidateRuntime.provider === runtime.provider && candidateRuntime.modelId === runtime.modelId;
        });
      }
      for (const target of targets) {
        if (target.session.snapshot().active) throw new ProtocolError("busy", "A broader resource profile cannot change while an affected tab is active");
        if (target.id !== tab.id) {
          if (exclusiveTabOperations.has(target.id)) throw new ProtocolError("busy", "Another resource, model, or session operation is already in progress for an affected tab");
          const reservation = registry.reserveMutation(target.id);
          exclusiveTabOperations.add(target.id);
          acquired.push({ id: target.id, reservation });
        }
      }

      const beforeById = new Map();
      for (const target of targets) {
        const owned = acquired.find(entry => entry.id === target.id);
        beforeById.set(target.id, await (owned ? owned.reservation.run(() => resourceContext(target)) : resourceContext(target)));
      }
      const before = beforeById.get(tab.id);
      const known = field === "tools" ? before.helper.toolNames : before.helper.skillNames;
      if (field !== "sampling" && value !== null) {
        const unknown = value.find((name) => !known.has(name));
        if (unknown) throw new ProtocolError("invalid_request", `Unknown ${field === "tools" ? "tool" : "skill"} ${unknown}`);
      }
      const storedBefore = before.stored;
      const storedProspective = prospectiveStored(before, scope, field, value);
      const prospectiveById = new Map();
      for (const target of targets) prospectiveById.set(target.id, prospectiveContext(beforeById.get(target.id), scope, field, value, storedProspective));

      const attempted = [];
      const appliedHelpers = new Map();
      for (const target of targets) {
        attempted.push(target);
        const prospective = prospectiveById.get(target.id);
        const session = scope === "session" ? { [field]: prospective.helper.sessionProfile[field] } : undefined;
        try {
          const raw = await target.session.helperApply({ ...(session ? { session } : {}), effective: helperEffective(prospective) });
          const applied = normalizeHelperState(target, raw);
          validateAppliedHelper(prospective, applied);
          appliedHelpers.set(target.id, applied);
        } catch (error) {
          await rollbackResources(attempted, beforeById, scope, field, error);
        }
      }

      let committedStored = storedBefore;
      if (scope !== "session") {
        try {
          committedStored = await resources.update(
            scope,
            { provider: before.helper.model.provider, modelId: before.helper.model.id },
            field,
            value,
            { visibleNames: field === "tools" || field === "skills" ? [...known] : null },
          );
        } catch (error) {
          await rollbackResources(attempted, beforeById, scope, field, error);
        }
      }

      const reconciliationFailures = [];
      for (const target of targets) {
        const applied = appliedHelpers.get(target.id);
        const prospective = prospectiveById.get(target.id);
        let committed = resourceContextFrom(target, applied, committedStored);
        if (JSON.stringify(helperEffective(prospective)) !== JSON.stringify(helperEffective(committed))) {
          try {
            const raw = await target.session.helperApply({ effective: helperEffective(committed) });
            const reconciled = normalizeHelperState(target, raw);
            committed = resourceContextFrom(target, reconciled, committedStored);
            validateAppliedHelper(committed, reconciled);
            appliedHelpers.set(target.id, reconciled);
          } catch (error) {
            reconciliationFailures.push(`${target.id}: ${boundedError(error?.message ?? String(error))}`);
          }
        }
      }
      if (reconciliationFailures.length > 0) {
        throw new ProtocolError("internal_error", `The resource change was saved, but runtime reconciliation failed (${reconciliationFailures.join("; ")}). The affected session state may be inconsistent until resources are refreshed or the session restarts.`);
      }

      let requestedResult = null;
      for (const target of targets) {
        const finalContext = resourceContextFrom(target, appliedHelpers.get(target.id), committedStored);
        const stateResult = resourceResult(finalContext);
        emit("resources.changed", { tab: target.id, scope, field, state: stateResult });
        if (target.id === tab.id) requestedResult = stateResult;
      }
      return requestedResult;
    } finally {
      for (const { id, reservation } of acquired) { exclusiveTabOperations.delete(id); reservation.release(); }
    }
  }

  const handlers = {
    async hello(request) {
      if (request.attachmentMetadata) attachmentMetadata = true;
      const active = registry.active();
      const selectionGeneration = registry.selectionGeneration;
      const tabList = registry.list();
      if (active) registry.replay(active);
      const themeState = await themes.refresh();
      return {
        protocolVersion: PROTOCOL_VERSION,
        backendPid: process.pid,
        cwd,
        limits: LIMITS,
        smokeMode,
        tabs: tabList,
        selectionGeneration,
        session: active ? tabSnapshot(active).session : null,
        attachments: active ? active.attachments.list({ metadataOnly: attachmentMetadata }) : [],
        attachmentMetadata,
        settings: settings.read().settings,
        appearance: appearance.snapshot(),
        themeState,
        recentActions: state.read().value.recentActions,
        stats: transportSnapshot(),
      };
    },
    async prompt(request) {
      const tab = tabFor(request);
      assertExclusiveTabOperationAvailable(tab);
      await registry.prepareMutation(tab.id);
      // Attachments are consumed only once stale-state reconciliation and prompt validation pass.
      tab.session.assertPromptAllowed(request.mode);
      const taken = request.attachments.length > 0 ? tab.attachments.take(request.attachments) : null;
      return tab.session.prompt({ message: request.message, mode: request.mode, attachments: taken });
    },
    async abort(request) {
      return tabFor(request).session.abort();
    },
    async state(request) {
      return tabFor(request).session.requestState();
    },
    async restart(request) {
      const tab = tabFor(request);
      return withExclusiveTabOperation(tab, () => registry.restart(tab.id));
    },
    async extension_response(request) {
      return tabFor(request).session.answerDialog(request);
    },
    async settings_get() {
      const result = settings.read();
      for (const problem of result.problems) emit("notice", { level: "warning", message: `Settings: ${problem}` });
      return { settings: result.settings, path: result.path };
    },
    async settings_set(request) {
      const result = settings.write(request.values);
      emit("settings.changed", { settings: result.settings });
      if (Object.hasOwn(request.values, "appearanceMode") || Object.hasOwn(request.values, "selectedThemeName")) {
        emit("themes.changed", { state: await themes.refresh() });
      }
      return { settings: result.settings, path: result.path };
    },
    async themes_list() {
      return themes.list();
    },
    async theme_select(request) {
      try {
        const state = await themes.select(request.selection);
        emit("settings.changed", { settings: settings.read().settings });
        emit("themes.changed", { state });
        return state;
      } catch (error) {
        if (error?.code === "theme_unavailable") throw new ProtocolError("stale_request", error.message);
        throw error;
      }
    },
    async open_link(request) {
      if (smokeMode) return { delivered: false, suppressed: "smoke-mode", url: request.url };
      const result = await openExternalLink({ url: request.url });
      if (!result.delivered) throw new ProtocolError("rejected", result.reason || "could not open link");
      return result;
    },
    async open_path(request) {
      if (smokeMode) return { delivered: false, suppressed: "smoke-mode", path: request.path };
      const result = await openLocalPath({ path: request.path });
      if (!result.delivered) throw new ProtocolError("rejected", result.reason || "could not open the file");
      return result;
    },
    async session_stats(request) {
      return tabFor(request).session.sessionStats();
    },
    async recent_action(request) {
      return { recentActions: state.pushRecent("recentActions", request.action) };
    },
    async diagnostics() {
      const saved = state.read().value;
      return {
        backendPid: process.pid,
        cwd,
        smokeMode,
        uptimeMs: Math.round(process.uptime() * 1000),
        memoryRssBytes: process.memoryUsage().rss,
        stats: { ...transportSnapshot(), sequence, inflight: inflight.size },
        catalog: sessionCatalog.diagnostics(),
        snapshotLoads: snapshotLoadDiagnostics(),
        tabs: registry.list(),
        recentActions: saved.recentActions,
        paths: { settings: settings.path, state: state.path, sequences: sequences.path, resources: resources.path, sharedResources: resources.sharedPath },
        limits: LIMITS,
      };
    },
    async notify(request) {
      if (smokeMode) return { delivered: false, suppressed: "smoke-mode" };
      return sendDesktopNotification({ title: request.title, body: request.body });
    },
    async models_list(request) {
      return tabFor(request).session.listModels();
    },
    async model_set(request) {
      const tab = tabFor(request);
      return withExclusiveTabOperation(tab, async () => {
        await registry.prepareMutation(tab.id);
        const result = await tab.session.setModel({ provider: request.provider, modelId: request.modelId });
        return { ...result, resources: await safeReadResources(tab) };
      });
    },
    async model_cycle(request) {
      const tab = tabFor(request);
      return withExclusiveTabOperation(tab, async () => {
        await registry.prepareMutation(tab.id);
        const result = await tab.session.cycleModel();
        return { ...result, resources: await safeReadResources(tab) };
      });
    },
    async thinking_levels(request) {
      return tabFor(request).session.listThinkingLevels();
    },
    async thinking_set(request) {
      const tab = tabFor(request);
      return withExclusiveTabOperation(tab, async () => {
        await registry.prepareMutation(tab.id);
        const result = await tab.session.setThinkingLevel({ level: request.level });
        return { ...result, resources: await safeReadResources(tab) };
      });
    },
    async thinking_cycle(request) {
      const tab = tabFor(request);
      return withExclusiveTabOperation(tab, async () => {
        await registry.prepareMutation(tab.id);
        const result = await tab.session.cycleThinkingLevel();
        return { ...result, resources: await safeReadResources(tab) };
      });
    },
    async resources_state(request) {
      const tab = tabFor(request);
      try {
        return await withExclusiveTabOperation(tab, () => safeReadResources(tab));
      } catch (error) {
        return { available: false, error: { code: error.code || "unavailable", message: boundedError(error.message) } };
      }
    },
    async tools_set(request) {
      const tab = tabFor(request);
      return withExclusiveTabOperation(tab, () => setResource(tab, request.scope, "tools", request.names));
    },
    async skills_set(request) {
      const tab = tabFor(request);
      return withExclusiveTabOperation(tab, () => setResource(tab, request.scope, "skills", request.names));
    },
    async sampling_set(request) {
      const tab = tabFor(request);
      return withExclusiveTabOperation(tab, () => setResource(tab, request.scope, "sampling", request.params));
    },
    async compact(request) {
      const tab = tabFor(request);
      return withExclusiveTabOperation(tab, async () => {
        await registry.prepareMutation(tab.id);
        return tab.session.compact({ instructions: request.instructions });
      });
    },
    async draft_get(request) {
      return { key: request.key, text: state.getDraft(request.key) };
    },
    async draft_set(request) {
      return { key: request.key, text: state.setDraft(request.key, request.text, request.expectedText) };
    },
    async sequences_list() {
      const result = sequences.list();
      for (const problem of result.problems) emit("notice", { level: "warning", message: `Sequences: ${problem}` });
      return { sequences: result.sequences, path: result.path };
    },
    async sequence_save(request) {
      const saved = sequences.save({ id: request.sequenceId, name: request.name, entries: request.entries });
      return { sequence: saved, sequences: sequences.list().sequences };
    },
    async sequence_delete(request) {
      const removed = sequences.remove(request.sequenceId);
      return { removed: removed.id, sequences: sequences.list().sequences };
    },
    async sequence_move(request) {
      return { sequences: sequences.move(request.sequenceId, request.delta) };
    },
    async sequence_run(request) {
      const sequence = sequences.get(request.sequenceId);
      if (!sequence) throw new ProtocolError("stale_request", "That sequence no longer exists");
      const tab = tabFor(request);
      assertExclusiveTabOperationAvailable(tab);
      await registry.prepareMutation(tab.id);
      return tab.session.runSequence({ sequenceId: sequence.id, entries: sequence.entries });
    },
    async commands_list(request) {
      return tabFor(request).session.listCommands();
    },
    async attachment_add(request) {
      const tab = tabFor(request);
      return { attachment: tab.attachments.add({ path: request.path, granted: request.granted }, attachmentOptions(request, tab)), attachments: tab.attachments.list({ metadataOnly: attachmentMetadata }) };
    },
    async attachment_update(request) {
      const tab = tabFor(request);
      return { attachment: tab.attachments.update(request.attachmentId, request.text, attachmentOptions(request, tab)), attachments: tab.attachments.list({ metadataOnly: attachmentMetadata }) };
    },
    async attachment_remove(request) {
      const tab = tabFor(request);
      tab.attachments.remove(request.attachmentId, attachmentOptions(request, tab));
      return { attachments: tab.attachments.list({ metadataOnly: attachmentMetadata }) };
    },
    async attachment_read(request) {
      return tabFor(request).attachments.readText(request.attachmentId, request.offset, request.revision);
    },
    async path_complete(request) {
      return tabFor(request).workspace.complete(request.query);
    },
    async tabs_list() {
      return registry.list();
    },
    async tab_open(request) {
      const base = request.tab ? registry.require(request.tab) : registry.active();
      const tab = registry.open({ cwd: request.cwd || (base ? base.cwd : cwd), sessionPath: request.sessionPath, name: request.name, select: true });
      registry.select(tab.id);
      if (request.cwd) state.pushRecent("recentDirectories", tab.cwd);
      return tabSnapshot(tab);
    },
    async tab_close(request) {
      const tab = tabFor(request);
      return withExclusiveTabOperation(tab, async () => {
        const wasActive = registry.activeId === tab.id;
        const result = await registry.close(tab.id, { force: request.force });
        const next = wasActive ? registry.active() : null;
        return { ...result, ...(next ? tabSnapshot(next) : {}) };
      });
    },
    async tab_select(request) {
      const tab = registry.select(tabFor(request).id);
      return tabSnapshot(tab);
    },
    async tab_rename(request) {
      const tab = tabFor(request);
      return withExclusiveTabOperation(tab, async () => {
        await registry.prepareMutation(tab.id);
        const summary = registry.rename(tab.id, request.name);
        let sessionRenamed = false;
        try {
          await tab.session.setSessionName(request.name);
          sessionRenamed = true;
        } catch (error) {
          emit("notice", { tab: tab.id, level: "warning", message: `The tab was renamed but Pi did not record the session name: ${boundedError(error.message)}` });
        }
        return { tab: summary, sessionRenamed };
      });
    },
    async tab_move(request) {
      return registry.move(tabFor(request).id, request.delta);
    },
    async sessions_list(request) {
      const tab = request.scope === "all" ? (registry.get(request.tab) ?? registry.active()) : tabFor(request);
      const catalogCwd = tab?.cwd ?? cwd;
      const catalogNow = now();
      const openSessionPaths = registry.sessionPaths();
      const [result, managedOpenSessions] = await Promise.all([
        sessionCatalog.list(catalogCwd, { scope: request.scope, offset: request.offset, cursor: request.cursor }),
        Promise.all(openSessionPaths.map(async (entry) => {
          try {
            const managed = await managedSessionPath(entry.path, { env });
            return { tabId: entry.tabId, identity: managed.identity };
          } catch {
            // A stale or unmanaged open path cannot be associated with a catalog row.
            return null;
          }
        })),
      ]);
      const openTabsByIdentity = new Map();
      for (const entry of managedOpenSessions) {
        if (entry && !openTabsByIdentity.has(entry.identity)) openTabsByIdentity.set(entry.identity, entry.tabId);
      }
      const sessionSettleDays = settings.read().settings.sessionSettleDays;
      const settledKeys = state.reconcileAutomaticSessionSettlement(result.sessions, {
        openSessionIdentities: openTabsByIdentity.keys(),
        thresholdMs: sessionSettleDays * 24 * 60 * 60 * 1000,
        nowMs: catalogNow,
      });
      const sessions = result.sessions.map(({ identity, ...session }) => ({
        ...session,
        settled: settledKeys.has(sessionSettlementKey(identity)),
        openTabId: openTabsByIdentity.get(identity) ?? "",
      }));
      return { ...result, sessions, current: tab?.sessionFile ?? "", cwd: catalogCwd };
    },
    async session_settled(request) {
      const managed = await managedSessionPath(request.sessionPath, { env });
      if (request.settled) {
        const openSessions = await Promise.all(allTabs().filter((tab) => tab.sessionFile).map(async (tab) => {
          try {
            const openSession = await managedSessionPath(tab.sessionFile, { env });
            return { tab, identity: openSession.identity };
          } catch {
            return null;
          }
        }));
        if (openSessions.some((entry) => entry && entry.identity === managed.identity && entry.tab.session.snapshot().active)) {
          throw new ProtocolError("busy", "A session cannot be settled while its run is active");
        }
      }
      let settled;
      try {
        settled = state.setSessionSettled(managed.identity, request.settled);
      } catch (error) {
        if (String(error?.message ?? "").startsWith("at most ")) throw new ProtocolError("limit_exceeded", boundedError(error.message));
        throw error;
      }
      emit("sessions.changed", { path: managed.path, settled });
      return { path: managed.path, settled };
    },
    async session_switch(request) {
      const tab = tabFor(request);
      return withExclusiveTabOperation(tab, () => registry.switchSession(tab.id, request.sessionPath));
    },
    async session_new(request) {
      const tab = tabFor(request);
      return withExclusiveTabOperation(tab, () => registry.newSession(tab.id));
    },
    async directory_list(request) {
      const listing = listDirectory(request.path, { showHidden: request.showHidden });
      const saved = state.read().value;
      return { ...listing, recent: saved.recentDirectories, pinned: saved.pinnedDirectories };
    },
    async directory_create(request) {
      return createDirectory(request.path, request.name);
    },
    async directory_pin(request) {
      return { pinned: state.togglePinned(request.path) };
    },
    async worktrees_list(request) {
      const tab = tabFor(request);
      return { worktrees: await listWorktrees(tab.cwd), cwd: tab.cwd };
    },
    async worktree_plan(request) {
      const tab = tabFor(request);
      return planWorktree({ cwd: tab.cwd, branch: request.branch, base: request.base, targetPath: request.path });
    },
    async worktree_create(request) {
      const tab = tabFor(request);
      const worktree = await createWorktree({ cwd: tab.cwd, branch: request.branch, base: request.base, targetPath: request.path });
      let opened = null;
      if (request.openTab) {
        const newTab = registry.open({ cwd: worktree.path, name: worktree.branch, select: true });
        registry.select(newTab.id);
        state.pushRecent("recentDirectories", newTab.cwd);
        opened = tabSnapshot(newTab);
      }
      return { worktree, tab: opened };
    },
    async shutdown() {
      // Let the request promise enqueue its response before cleanup can make the process exit.
      setImmediate(() => shutdown(0, "shutdown request"));
      return { closing: true };
    },
    async debug_crash() {
      if (!smokeMode) throw new ProtocolError("unknown_request", "debug_crash is only available in smoke mode");
      setImmediate(() => {
        throw new Error("deterministic backend crash for smoke testing");
      });
      return { crashing: true };
    },
  };

  function handleRequest(frame) {
    let request;
    try {
      request = validateRequest(frame);
    } catch (error) {
      const id = frame && typeof frame.id === "string" ? frame.id.slice(0, LIMITS.maxRequestIdCharacters) : "";
      if (id) respondError(id, error.code ?? "invalid_request", error.message);
      else emit("notice", { level: "error", message: `Rejected request: ${boundedError(error.message)}` });
      return;
    }
    const control = controlRequests.has(request.type);
    if (backpressured && !control) { respondError(request.id, "busy", "The UI is not draining responses; ordinary work is paused"); return; }
    if (inflight.has(request.id)) {
      respondError(request.id, "duplicate_request", `request id ${request.id} is already in flight`);
      return;
    }
    const controls = [...inflight.values()].filter(entry => controlRequests.has(entry.type)).length;
    if ((!control && (inflight.size - controls >= LIMITS.maxPendingRequests || (inflight.size - controls + 1) * LIMITS.maxOutboundFrameBytes > LIMITS.maxAdmittedResponseBytes))
      || (control && controls >= LIMITS.maxControlRequests)) {
      respondError(request.id, "busy", "too many requests are in flight");
      return;
    }
    let reservation;
    const lifecycleMutation = ["session_switch", "session_new", "restart", "tab_close"].includes(request.type);
    const requestedTab = registry.get(request.tab || registry.activeId);
    const compatibleControl = (request.type === "prompt" && request.mode !== "send" && requestedTab?.session.snapshot().active === true)
      || (request.type === "tab_close" && request.force);
    // Closing an auto-resuming tab cancels that child and its pending switch; it must not wait
    // behind the registry's internal resume reservation or silently fail as busy.
    const closingAutoResume = request.type === "tab_close" && requestedTab?.resumeInFlight === true;
    if ((SESSION_MUTATION_REQUESTS.has(request.type) || lifecycleMutation) && !compatibleControl && !closingAutoResume) {
      try { reservation = registry.reserveMutation(tabFor(request).id); }
      catch (error) { respondError(request.id, error.code ?? "busy", error.message); return; }
    }
    const timeoutMs = LIMITS.requestTimeoutMs[request.type];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Keep timed-out work admitted until its handler actually finishes.
      respondError(request.id, "timeout", `${request.type} did not complete within ${timeoutMs} ms`);
    }, timeoutMs);
    inflight.set(request.id, { type: request.type, timer });
    peakAdmittedWork = Math.max(peakAdmittedWork, inflight.size);
    let mutatingTabId = "";
    Promise.resolve()
      .then(() => (reservation ? reservation.run : operation => operation())(async () => {
        if (SESSION_MUTATION_REQUESTS.has(request.type)) {
          mutatingTabId = tabFor(request).id;
          mutatingTabOperations.set(mutatingTabId, (mutatingTabOperations.get(mutatingTabId) ?? 0) + 1);
          // A queued external snapshot is not yet evidence that Pi's in-memory branch is current.
          if ([...pendingSessionChanges.values()].some(change => tabForSessionPath(change.path)?.id === mutatingTabId)) registry.markForRebind(mutatingTabId);
          await registry.prepareMutation(mutatingTabId);
        }
        return handlers[request.type](request);
      }))
      .finally(() => {
        reservation?.release();
        if (!mutatingTabId) return;
        const remaining = (mutatingTabOperations.get(mutatingTabId) ?? 1) - 1;
        if (remaining > 0) mutatingTabOperations.set(mutatingTabId, remaining);
        else mutatingTabOperations.delete(mutatingTabId);
        const tab = registry.get(mutatingTabId);
        if (tab) retryPendingSessionChanges(tab);
      })
      .then((data) => {
        clearTimeout(timer);
        inflight.delete(request.id);
        if (settled) return;
        settled = true;
        respond(request.id, data ?? null);
      }, (error) => {
        clearTimeout(timer);
        inflight.delete(request.id);
        if (settled) return;
        settled = true;
        respondError(request.id, error instanceof ProtocolError ? error.code : "internal_error", error?.message ?? String(error));
      });
  }

  function killAllNow() {
    themes.stop();
    sessionCatalog.stop();
    appearance.stopNow();
    void sessionMonitor.stop();
    void stopSnapshotLoads();
    for (const child of registry.children()) killProcessTreeNow(child);
  }

  function shutdown(code, reason) {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    clearTimeout(drainTimer);
    sessionCatalog.stop();
    themes.stop();
    const appearanceStop = appearance.stop();
    emit("backend.closing", { reason, transport: transportSnapshot() });
    const forced = setTimeout(() => {
      killAllNow();
      exit(code);
    }, LIMITS.shutdownGraceMs + 1_000);
    shutdownPromise = Promise.all([appearanceStop, sessionMonitor.stop(), registry.stopAll(), stopSnapshotLoads()]).then(() => {
      clearTimeout(forced);
      for (const entry of inflight.values()) clearTimeout(entry.timer);
      inflight.clear();
      exit(code);
    });
    return shutdownPromise;
  }

  function fatal(error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    try {
      emit("backend.fatal", { message: boundedError(message) });
    } catch {
      // Output may already be closed.
    }
    killAllNow();
    if (onFatal) onFatal(error);
    exit(70);
  }

  function run() {
    if (!piCliEntry || !path.isAbsolute(piCliEntry)) {
      emit("backend.fatal", { message: "QT_WEBUI_PI_CLI_ENTRY must be an absolute path" });
      exit(64);
      return;
    }
    process.on("uncaughtException", fatal);
    process.on("unhandledRejection", fatal);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => shutdown(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129, signal));
    }
    output.on("error", (error) => {
      if (error && (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED")) shutdown(0, "stdout closed");
      else fatal(error);
    });
    input.setEncoding("utf8");
    attachJsonlReader(input, {
      maxFrameBytes: LIMITS.maxInboundFrameBytes,
      onRecord: (record) => {
        if (!closing) handleRequest(record);
      },
      onInvalid: (error) => emit("notice", { level: "error", message: `Rejected malformed request: ${boundedError(error.message)}` }),
      onOversized: (bytes) => emit("notice", { level: "error", message: `Rejected a request larger than ${LIMITS.maxInboundFrameBytes} bytes (${bytes} bytes)` }),
    });
    input.on("end", () => shutdown(0, "stdin closed"));
    input.on("error", () => shutdown(0, "stdin error"));
    // Smoke backends must not attach helper processes to the developer's live desktop portal.
    // The monitor itself is covered with injected fakes in appearance.test.mjs.
    if (!smokeMode) appearance.start();
    emit("backend.ready", { protocolVersion: PROTOCOL_VERSION, backendPid: process.pid, limits: LIMITS, cwd, smokeMode, appearance: appearance.snapshot() });
    // Restored tabs start their Pi children now; their events carry tab ids from the first frame.
    try {
      registry.restore();
      void updateMonitoredPaths(registry.sessionPaths())
        .then(() => sessionMonitor.start())
        .catch((error) => warnSessionSyncOnce("start", error));
    } catch (error) {
      fatal(error);
    }
  }

  return {
    run,
    shutdown,
    emit,
    registry,
    sessionMonitor,
    transportSnapshot,
    catalogSnapshot: sessionCatalog.diagnostics,
    sessionSyncSnapshot: () => ({
      pendingPaths: [...pendingSessionChanges.keys()],
      reconcilingPaths: [...reconcilingSessionPaths],
      failurePaths: [...reconciliationFailures.keys()],
      monitoredPaths: [...monitoredSessionPaths],
      futurePaths: [...futureSessionPaths],
    }),
    get session() { return registry.active()?.session ?? null; },
  };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) createBackend().run();
