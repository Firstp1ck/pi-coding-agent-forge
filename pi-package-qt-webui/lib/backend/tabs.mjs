import { existsSync, realpathSync, statSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createAttachmentStore } from "./attachments.mjs";
import { resolveWorkspaceDirectory } from "./directories.mjs";
import { LIMITS, ProtocolError, boundedString } from "./protocol.mjs";
import { temporaryDraftKey } from "./state.mjs";
import { createTranscriptMirror, rowsFromHistory } from "./transcript.mjs";
import { createWorkspaceIndex } from "./workspace.mjs";

// One tab = one Pi session in one working directory, with its own attachments, path index, and a
// bounded transcript mirror. Every event a session emits is tagged with the tab id; the client
// only materializes the active tab and rebuilds it from the mirror when switching. Tabs, their
// directories, session files, and names are saved so a normal restart restores them.

const BADGE_EVENTS = new Set(["message.end", "run.end"]);

export function createTabRegistry({
  emit,
  state,
  createSession,
  callerCwd,
  now = () => Date.now(),
  onSessionPathsChange = () => {},
  onSessionIdle = () => {},
}) {
  const tabs = new Map();
  const identityOwners = new Map();
  const closingTabs = new Map();
  const mutationContext = new AsyncLocalStorage();

  function canonicalIdentity(file) {
    if (!file) return "";
    try { return realpathSync(file); } catch { return ""; }
  }

  function ownerOf(file) {
    const id = identityOwners.get(canonicalIdentity(file));
    return id ? tabs.get(id) ?? closingTabs.get(id) ?? null : null;
  }

  function claim(tab, file) {
    const identity = canonicalIdentity(file);
    if (!identity) return "";
    const owner = identityOwners.get(identity);
    if (owner && owner !== tab.id) throw new ProtocolError("busy", `That session is already open or reserved by ${owner}`);
    identityOwners.set(identity, tab.id);
    return identity;
  }

  function refreshClaims(tab) {
    if (closingTabs.has(tab.id)) return;
    const retained = new Set([tab.sessionFile, tab.pendingResume, tab.transitionSessionFile, tab.previousSessionFile].map(canonicalIdentity).filter(Boolean));
    for (const [identity, owner] of identityOwners) if (owner === tab.id && ((!tabs.has(tab.id) && !closingTabs.has(tab.id)) || !retained.has(identity))) identityOwners.delete(identity);
  }

  function reserveMutation(id) {
    const tab = require(id);
    const inherited = mutationContext.getStore()?.get(tab.id);
    if (tab.mutationReservation) {
      if (inherited === tab.mutationReservation) return { run: operation => operation(), release() {} };
      throw new ProtocolError("busy", "Another session mutation is already in progress for this tab");
    }
    const token = Object.freeze({ tab: tab.id });
    tab.mutationReservation = token;
    const context = new Map(mutationContext.getStore() ?? []);
    context.set(tab.id, token);
    return {
      run: operation => mutationContext.run(context, operation),
      release() {
        if (tab.mutationReservation !== token) return;
        tab.mutationReservation = null;
        if (tabs.has(tab.id)) {
          emitTabs();
          resumePending(tab);
          try { Promise.resolve(onSessionIdle(tab)).catch(() => {}); } catch {}
        }
      },
    };
  }

  function withMutation(id, operation) {
    const reservation = reserveMutation(id);
    return reservation.run(async () => {
      try { return await operation(); } finally { reservation.release(); }
    });
  }
  let order = [];
  let activeId = "";
  let selectionGeneration = 0;

  function commitSelection(id) {
    if (activeId !== id) { activeId = id; selectionGeneration += 1; }
  }
  let serial = 0;
  let quiet = false; // suppresses tabs.update while a batch (restore) is in progress

  function get(id) {
    return tabs.get(id) ?? null;
  }

  function require(id) {
    const tab = get(id || activeId);
    if (!tab) throw new ProtocolError("stale_request", "That tab no longer exists");
    return tab;
  }

  function active() {
    return get(activeId);
  }

  function summary(tab) {
    const snapshot = tab.session.snapshot();
    const representedSessionFile = tab.transitionSessionFile || tab.pendingResume || tab.sessionFile;
    const awaitingResume = Boolean(tab.pendingResume || tab.resumeInFlight);
    const resumeUnavailable = Boolean(tab.pendingResume && tab.resumeBlocked && !tab.transitionSessionFile);
    const activityState = snapshot.active
      ? snapshot.pendingDialogs > 0 ? "blocked" : "working"
      : tab.unacknowledgedCompletion ? "done" : "idle";
    return {
      id: tab.id,
      draftId: tab.draftId,
      draftFile: tab.durableSessionFile ? tab.sessionFile : "",
      selectionGeneration,
      cwd: tab.cwd,
      name: tab.name,
      sessionFile: representedSessionFile,
      sessionName: tab.sessionName,
      statusKind: awaitingResume && snapshot.ready ? resumeUnavailable ? "error" : "stopped" : snapshot.statusKind,
      statusText: awaitingResume && snapshot.ready ? resumeUnavailable ? "Session not resumed" : "Resuming session…" : snapshot.statusText,
      ready: snapshot.ready && !awaitingResume,
      canRecover: snapshot.ready && resumeUnavailable && !tab.mutationReservation && !snapshot.active,
      mutating: Boolean(tab.mutationReservation),
      active: snapshot.active,
      activityState,
      unread: tab.unread,
      needsInput: snapshot.pendingDialogs,
      pid: snapshot.pid,
    };
  }

  function list() {
    return { tabs: order.map((id) => summary(tabs.get(id))), activeTab: activeId, selectionGeneration, maxTabs: LIMITS.maxTabs };
  }

  let lastTabsJson = "";

  // Only changed summaries are sent, so status churn during a run does not flood the client.
  function emitTabs() {
    if (quiet) return;
    const next = list();
    const serialized = JSON.stringify(next);
    if (serialized === lastTabsJson) return;
    lastTabsJson = serialized;
    emit("tabs.update", next);
  }

  function saveState() {
    try {
      state.saveTabs(order.map((id) => {
        const tab = tabs.get(id);
        return { cwd: tab.cwd, sessionFile: tab.durableSessionFile ? tab.sessionFile : "", name: tab.name, draftId: tab.draftId,
          ...(!tab.durableSessionFile && tab.pendingResume ? { pendingResume: tab.pendingResume } : {}) };
      }), activeId ? order.indexOf(activeId) : -1, order.flatMap(id => tabs.get(id).retiredDraftIds));
    } catch (error) {
      emit("notice", { level: "warning", message: `Could not save the tab layout: ${boundedString(error.message, 200)}` });
    }
  }

  function sessionPathsChanged() {
    try {
      const result = onSessionPathsChange(sessionPaths());
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // Monitoring is advisory and must not break tab lifecycle operations.
    }
  }

  function comparableRows(rows) {
    return rows.map((row) => [
      row.role,
      row.kind,
      row.text,
      row.blocksJson,
      row.truncated,
      row.modeLabel,
      row.attachments,
      row.toolName,
      row.toolSummary,
      row.toolStatus,
      row.toolOutput,
      row.toolError,
    ]);
  }

  function snapshotMetadata(snapshot) {
    return {
      sessionId: snapshot.sessionId,
      name: snapshot.name,
      thinkingLevel: snapshot.thinkingLevel,
      model: snapshot.model
        ? { provider: snapshot.model.provider ?? "", modelId: snapshot.model.modelId ?? snapshot.model.id ?? "" }
        : null,
    };
  }

  // Replays the mirror to the client as tagged events so a switch or resume rebuilds the
  // transcript from authoritative state. Rows go one per frame to respect the frame budget.
  function replay(tab) {
    emit("transcript.reset", { tab: tab.id, selectionGeneration });
    for (const row of tab.mirror.rows()) emit("transcript.row", { tab: tab.id, selectionGeneration, row });
  }

  function open({ cwd = callerCwd, sessionPath = "", name = "", select = true, notify = true, confirmedSession = false, draftId = "" } = {}) {
    const owner = sessionPath ? ownerOf(sessionPath) : null;
    if (owner) {
      if (closingTabs.has(owner.id)) throw new ProtocolError("busy", `That session is still closing in ${owner.id}`);
      if (select) selectTabOwner(owner);
      return owner;
    }
    if (tabs.size + closingTabs.size >= LIMITS.maxTabs) throw new ProtocolError("limit_exceeded", `At most ${LIMITS.maxTabs} tabs can be open`);
    const directory = resolveWorkspaceDirectory(cwd);
    serial += 1;
    const id = `tab-${serial}`;
    const tab = {
      id,
      draftId: draftId || randomUUID(),
      retiredDraftIds: [],
      cwd: directory,
      name: boundedString(name, LIMITS.maxTabNameCharacters, ""),
      sessionFile: confirmedSession ? sessionPath : "",
      durableSessionFile: confirmedSession && Boolean(sessionPath),
      sessionName: "",
      unread: 0,
      unacknowledgedCompletion: false,
      pendingResume: sessionPath,
      resumeBlocked: false,
      resumeInFlight: false,
      transitionSessionFile: "",
      previousSessionFile: "",
      staleSessionFile: "",
      staleGeneration: 0,
      preparationPromise: null,
      mutationReservation: null,
      persistedMetadataJson: "",
      mirror: createTranscriptMirror(),
      attachments: createAttachmentStore({ workspaceRoot: directory }),
      workspace: createWorkspaceIndex({ root: directory }),
      session: null,
      createdAt: now(),
    };
    claim(tab, tab.pendingResume);
    try {
      tab.session = createSession({
        cwd: directory,
        emit: (type, payload = {}) => handleSessionEvent(tab, type, payload),
      });
    } catch (error) {
      refreshClaims(tab);
      throw error;
    }
    tabs.set(id, tab);
    order.push(id);
    if (!sessionPath) {
      try { state.adoptLegacyDraft(directory, temporaryDraftKey(tab.draftId)); }
      catch (error) { emit("notice", { level: "warning", message: `Could not migrate the workspace draft: ${boundedString(error.message, 200)}` }); }
    }
    if (select || !activeId) commitSelection(id);
    tab.session.start();
    if (notify) {
      saveState();
      emitTabs();
      sessionPathsChanged();
    }
    return tab;
  }

  function resumeWarning(tab, target, reason) {
    emit("notice", { tab: tab.id, level: "warning", message: `Could not resume ${path.basename(target)}: ${reason}. Restore the saved file, then restart this tab, or explicitly choose another session` });
  }

  function resumePending(tab) {
    if (!tab.pendingResume || tab.resumeBlocked || tab.mutationReservation || !tabs.has(tab.id) || !tab.session.snapshot().ready) return;
    const target = tab.pendingResume;
    if (!existsSync(target)) {
      tab.resumeBlocked = true;
      resumeWarning(tab, target, "the saved session file is missing");
      emitTabs();
      return;
    }
    // Hold the target until Pi confirms the switch. A failed switch must not unlock mutations
    // on the new child's empty session or cause an automatic retry loop.
    tab.resumeBlocked = true;
    tab.resumeInFlight = true;
    switchSession(tab.id, target).then(() => {
      tab.resumeInFlight = false;
      emitTabs();
      if (tabs.has(tab.id)) {
        const effective = summary(tab);
        emit("pi.status", { tab: tab.id, selectionGeneration, statusKind: effective.statusKind, text: effective.statusText, ready: effective.ready, canRecover: effective.canRecover, active: tab.session.snapshot().active });
      }
    }, error => {
      tab.resumeInFlight = false;
      if (tabs.has(tab.id) && tab.pendingResume === target) resumeWarning(tab, target, boundedString(error.message, 200));
      emitTabs();
    });
  }

  function promoteSavedFile(tab) {
    if (tab.durableSessionFile || tab.pendingResume || !tab.sessionFile || !existsSync(tab.sessionFile)) return;
    try { claim(tab, tab.sessionFile); }
    catch (error) {
      emit("notice", { tab: tab.id, level: "error", message: error.message });
      void tab.session.stop();
      return;
    }
    try { state.moveDraft(temporaryDraftKey(tab.draftId), tab.sessionFile); }
    catch (error) {
      emit("notice", { tab: tab.id, level: "warning", message: `Could not migrate the draft: ${boundedString(error.message, 200)}` });
      return;
    }
    tab.durableSessionFile = true;
    refreshClaims(tab);
    emitTabs();
    saveState();
    sessionPathsChanged();
  }

  function handleSessionEvent(tab, type, payload) {
    if (type === "transcript.row" && payload.row) tab.mirror.replace([...tab.mirror.rows(), payload.row]);
    else tab.mirror.apply(type, payload);
    let tabsChanged = false;
    if (type === "run.end" || type === "pi.exit") promoteSavedFile(tab);
    if (type === "pi.exit") {
      if (tab.durableSessionFile) tab.pendingResume = tab.sessionFile;
      tab.resumeBlocked = false;
    }
    if (type === "session.replaced") {
      if (!payload.rebind) {
        tab.retiredDraftIds.push(tab.draftId);
        tab.retiredDraftIds = tab.retiredDraftIds.slice(-8);
        tab.draftId = randomUUID();
      }
      tab.pendingResume = "";
      tab.resumeBlocked = false;
    }
    // An empty/failed runtime is not an identity transition. While a child is awaiting a
    // resume, even its successful startup get_state describes only its fresh temporary branch.
    if (type === "session.replaced" || (type === "pi.runtime" && !tab.pendingResume && payload.sessionFile)) {
      const sessionFile = typeof payload.sessionFile === "string" ? payload.sessionFile : "";
      const sessionName = typeof payload.sessionName === "string" ? payload.sessionName : "";
      if (sessionFile === tab.sessionFile && type === "session.replaced" && tab.durableSessionFile !== Boolean(sessionFile)) {
        tab.durableSessionFile = Boolean(sessionFile);
        saveState();
      }
      if (sessionFile === tab.sessionFile && type === "pi.runtime") promoteSavedFile(tab);
      if (sessionFile !== tab.sessionFile || sessionName !== tab.sessionName) {
        try { claim(tab, sessionFile); }
        catch (error) {
          emit("notice", { tab: tab.id, level: "error", message: error.message });
          void tab.session.stop();
          return;
        }
        let draftMigrated = true;
        if (type === "pi.runtime" && !tab.sessionFile && sessionFile && existsSync(sessionFile)) {
          try { state.moveDraft(temporaryDraftKey(tab.draftId), sessionFile); }
          catch (error) {
            draftMigrated = false;
            emit("notice", { tab: tab.id, level: "warning", message: `Could not migrate the draft: ${boundedString(error.message, 200)}` });
          }
        }
        tab.sessionFile = sessionFile;
        tab.durableSessionFile = type === "session.replaced" ? Boolean(sessionFile) : Boolean(sessionFile && existsSync(sessionFile) && draftMigrated);
        refreshClaims(tab);
        tab.sessionName = sessionName;
        tabsChanged = true;
        saveState();
        sessionPathsChanged();
      }
    }
    if (type === "session.replaced" && !payload.rebind) {
      saveState();
      tabsChanged = true;
    }
    if (type === "pi.status") {
      tabsChanged = true;
      if (payload.ready) resumePending(tab);
    }
    if (type === "pi.exit" || type === "pi.started") tabsChanged = true;
    if (type === "run.start") {
      tab.unacknowledgedCompletion = false;
      tabsChanged = true;
    }
    if (type === "run.end") {
      tab.unacknowledgedCompletion = tab.id !== activeId;
      tabsChanged = true;
    }
    if (type === "run.end" || (type === "pi.status" && payload.ready === true && payload.active === false)) {
      try {
        const result = onSessionIdle(tab);
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch {
        // A monitor retry must not disturb Pi event processing.
      }
    }
    if (tab.id !== activeId && BADGE_EVENTS.has(type)) {
      tab.unread += 1;
      tabsChanged = true;
    }
    if (type === "extension.request" || type === "extension.cancelled" || type === "extension.answered") {
      tabsChanged = true;
    }
    const projectedStatus = type === "pi.status" ? summary(tab) : null;
    emit(type, { tab: tab.id, selectionGeneration, ...payload,
      ...(type === "session.replaced" ? { draftId: tab.draftId } : {}),
      ...(projectedStatus ? { ready: projectedStatus.ready, canRecover: projectedStatus.canRecover, statusKind: projectedStatus.statusKind, text: projectedStatus.statusText } : {}) });
    if (tabsChanged) emitTabs();
  }

  // The client switches on tabs.update, so it is sent before the transcript replay.
  function selectTabOwner(tab) { return select(tab.id); }

  function select(id) {
    const tab = require(id);
    commitSelection(tab.id);
    tab.unread = 0;
    tab.unacknowledgedCompletion = false;
    saveState();
    emitTabs();
    replay(tab);
    return tab;
  }

  async function close(id, { force = false } = {}) {
    const tab = require(id);
    const snapshot = tab.session.snapshot();
    if (snapshot.active && !force) throw new ProtocolError("busy", "A run is still in progress in that tab; closing it aborts the run and stops its Pi process");
    closingTabs.set(tab.id, tab);
    tabs.delete(tab.id);
    order = order.filter((entry) => entry !== tab.id);
    if (activeId === tab.id) commitSelection("");
    emitTabs();
    await tab.session.stop();
    closingTabs.delete(tab.id);
    refreshClaims(tab);
    tab.attachments.clear();
    saveState();
    emitTabs();
    sessionPathsChanged();
    if (activeId) {
      const next = tabs.get(activeId);
      next.unread = 0;
      replay(next);
    }
    return { closed: tab.id, activeTab: activeId, pid: snapshot.pid };
  }

  function rename(id, name) {
    const tab = require(id);
    tab.name = boundedString(name, LIMITS.maxTabNameCharacters, "").trim();
    saveState();
    emitTabs();
    return summary(tab);
  }

  function move(id, delta) {
    const tab = require(id);
    const index = order.indexOf(tab.id);
    const target = Math.max(0, Math.min(order.length - 1, index + delta));
    order.splice(index, 1);
    order.splice(target, 0, tab.id);
    saveState();
    emitTabs();
    return list();
  }

  // Restores saved tabs whose directories still exist. An explicit -1 selection preserves the
  // empty workspace; older state still opens and selects the directory the user launched from.
  function restore() {
    let saved = [];
    let savedActive = 0;
    try {
      const read = state.read();
      saved = read.value.tabs;
      savedActive = read.value.activeTab;
      for (const problem of read.problems) emit("notice", { level: "warning", message: `State: ${problem}` });
    } catch (error) {
      emit("notice", { level: "warning", message: `Could not read the saved tabs: ${boundedString(error.message, 200)}` });
    }
    let restored = 0;
    quiet = true;
    for (const entry of saved) {
      if (tabs.size >= LIMITS.maxTabs) break;
      let usable = false;
      try {
        usable = statSync(entry.cwd).isDirectory();
      } catch {
        usable = false;
      }
      if (!usable) {
        emit("notice", { level: "info", message: `Skipped the saved tab for ${boundedString(entry.cwd, 120)}: the folder no longer exists` });
        continue;
      }
      try {
        open({ cwd: entry.cwd, sessionPath: entry.pendingResume || entry.sessionFile, name: entry.name, draftId: entry.draftId, select: false, notify: false, confirmedSession: !entry.pendingResume });
        restored += 1;
      } catch (error) {
        emit("notice", { level: "warning", message: `Could not restore the tab for ${boundedString(entry.cwd, 120)}: ${boundedString(error.message, 160)}` });
      }
    }
    if (savedActive !== -1) {
      const callerReal = resolveWorkspaceDirectory(callerCwd);
      let callerTab = order.map((id) => tabs.get(id)).find((tab) => tab.cwd === callerReal);
      if (!callerTab) callerTab = tabs.size < LIMITS.maxTabs ? open({ cwd: callerReal, select: false, notify: false }) : tabs.get(order[0]);
      commitSelection(callerTab.id);
    } else {
      commitSelection("");
    }
    quiet = false;
    saveState();
    emitTabs();
    sessionPathsChanged();
    return { restored, activeTab: activeId };
  }

  // Session targets stay registry-private while Pi is starting or changing sessions, so catalog
  // reconciliation can treat every path owned by an open tab as open throughout the transition.
  function switchSession(id, sessionPath, options = {}) {
    return withMutation(id, () => switchReservedSession(id, sessionPath, options));
  }

  async function switchReservedSession(id, sessionPath, { staleGeneration = null } = {}) {
    const tab = require(id);
    claim(tab, sessionPath);
    tab.previousSessionFile = tab.sessionFile;
    tab.transitionSessionFile = sessionPath;
    sessionPathsChanged();
    try {
      const result = await tab.session.switchSession(sessionPath, { rebind: staleGeneration !== null });
      if (get(id) !== tab) throw new ProtocolError("stale_request", "The tab closed during session replacement");
      const clearsPreparedGeneration = staleGeneration === null
        || (tab.staleGeneration === staleGeneration && tab.staleSessionFile === sessionPath);
      if (clearsPreparedGeneration) {
        tab.staleSessionFile = "";
        tab.persistedMetadataJson = "";
        if (staleGeneration === null) tab.staleGeneration += 1;
      }
      return result;
    } finally {
      if (tab.transitionSessionFile === sessionPath) tab.transitionSessionFile = "";
      tab.previousSessionFile = "";
      refreshClaims(tab);
      emitTabs();
      sessionPathsChanged();
    }
  }

  function prepareMutation(id) {
    const tab = require(id);
    if (tab.pendingResume) throw new ProtocolError("unavailable", `Resume ${path.basename(tab.pendingResume)} before changing this session; restore the file and restart this tab, or explicitly choose another session`);
    if (tab.preparationPromise) return tab.preparationPromise;
    if (!tab.staleSessionFile) return Promise.resolve(false);
    const current = tab.sessionFile;
    const staleGeneration = tab.staleGeneration;
    if (!current || current !== tab.staleSessionFile) {
      if (tab.staleGeneration === staleGeneration) tab.staleSessionFile = "";
      return Promise.resolve(false);
    }
    const preparation = withMutation(tab.id, async () => {
      for (let attempt = 0; attempt < LIMITS.maxSessionRebindAttempts; attempt++) {
        const generation = tab.staleGeneration;
        await switchReservedSession(tab.id, current, { staleGeneration: generation });
        if (!tab.staleSessionFile) return true;
      }
      throw new ProtocolError("busy", "The saved session keeps changing; retry after its writer settles");
    });
    tab.preparationPromise = preparation.finally(() => {
      if (tab.preparationPromise === preparationWithCleanup) tab.preparationPromise = null;
      try { Promise.resolve(onSessionIdle(tab)).catch(() => {}); } catch {}
    });
    const preparationWithCleanup = tab.preparationPromise;
    return preparationWithCleanup;
  }

  function markForRebind(id) {
    const tab = require(id);
    if (!tab.sessionFile || tab.session.snapshot().active) return;
    tab.staleGeneration++;
    tab.staleSessionFile = tab.sessionFile;
  }

  function noteSessionRevision(file, revision) {
    const tab = ownerOf(file);
    if (!tab || tab.observedSessionRevision === revision) return;
    tab.observedSessionRevision = revision;
    if (tab.preparationPromise && canonicalIdentity(tab.sessionFile) === canonicalIdentity(file)) {
      tab.staleGeneration++;
      tab.staleSessionFile = tab.sessionFile;
    }
  }

  function isPreparingMutation(id) {
    return Boolean(get(id)?.preparationPromise || get(id)?.mutationReservation);
  }

  function sessionSyncGeneration(id) {
    return get(id)?.staleGeneration ?? -1;
  }

  function newSession(id) {
    return withMutation(id, () => newReservedSession(id));
  }

  async function newReservedSession(id) {
    const tab = require(id);
    tab.transitionSessionFile = tab.sessionFile;
    sessionPathsChanged();
    try {
      const result = await tab.session.newSession();
      tab.staleSessionFile = "";
      tab.staleGeneration += 1;
      tab.persistedMetadataJson = "";
      return result;
    } finally {
      tab.transitionSessionFile = "";
      refreshClaims(tab);
      sessionPathsChanged();
    }
  }

  function applyExternalSnapshot(sessionPath, snapshot) {
    const resolved = path.resolve(sessionPath);
    const tab = ownerOf(sessionPath) ?? order.map((id) => tabs.get(id)).find((candidate) => candidate.sessionFile && path.resolve(candidate.sessionFile) === resolved);
    if (!tab) return { applied: false, reason: "not-open" };
    if (tab.sessionFile === sessionPath) promoteSavedFile(tab);
    if (tab.session.snapshot().active || tab.mutationReservation) return { applied: false, reason: "active" };

    const projected = rowsFromHistory(snapshot.messages);
    const rowsEqual = JSON.stringify(comparableRows(tab.mirror.rows())) === JSON.stringify(comparableRows(projected.rows));
    const metadata = snapshotMetadata(snapshot);
    const metadataJson = JSON.stringify(metadata);
    const runtime = tab.session.snapshot().runtime;
    const metadataEqual = tab.persistedMetadataJson
      ? metadataJson === tab.persistedMetadataJson
      : metadata.sessionId === runtime.sessionId
        && metadata.name === tab.sessionName
        && metadata.thinkingLevel === runtime.thinkingLevel
        && (metadata.model?.provider ?? "") === runtime.provider
        && (metadata.model?.modelId ?? "") === runtime.modelId;
    if (rowsEqual && metadataEqual) {
      tab.persistedMetadataJson = metadataJson;
      return { applied: false, reason: "equal" };
    }

    tab.mirror.replace(projected.rows);
    tab.persistedMetadataJson = metadataJson;
    tab.staleGeneration += 1;
    tab.staleSessionFile = tab.sessionFile;
    tab.session.applyPersistedSnapshotMetadata(snapshot, projected.messageCount);
    if (snapshot.name !== tab.sessionName) {
      tab.sessionName = snapshot.name;
      saveState();
    }
    if (tab.id === activeId) replay(tab);
    else {
      tab.unread += 1;
      emitTabs();
    }
    return { applied: true, reason: "different", tabId: tab.id, active: tab.id === activeId };
  }

  function sessionPaths() {
    const entries = [];
    for (const id of order) {
      const tab = tabs.get(id);
      const seen = new Set();
      for (const sessionPath of [tab.sessionFile, tab.pendingResume, tab.transitionSessionFile]) {
        if (!sessionPath || seen.has(sessionPath)) continue;
        seen.add(sessionPath);
        entries.push({ tabId: tab.id, path: sessionPath });
      }
    }
    return entries;
  }

  // Restart keeps continuity: the new Pi child resumes the session file the tab was showing.
  function restart(id) {
    return withMutation(id, () => restartReserved(id));
  }

  async function restartReserved(id) {
    const tab = require(id);
    tab.pendingResume = (tab.durableSessionFile ? tab.sessionFile : "") || tab.pendingResume;
    tab.resumeBlocked = false;
    // The replacement child cannot deliver the previous run's output, so an unseen completion is void.
    tab.unacknowledgedCompletion = false;
    sessionPathsChanged();
    return tab.session.restart();
  }

  async function stopAll() {
    await Promise.all([...tabs.values(), ...closingTabs.values()].map(tab => tab.session.stop()));
  }

  function children() {
    return [...tabs.values(), ...closingTabs.values()].map(tab => tab.session.child).filter(Boolean);
  }

  return {
    open,
    ownerOf,
    noteSessionRevision,
    markForRebind,
    reserveMutation,
    withMutation,
    close,
    select,
    rename,
    move,
    restart,
    restore,
    switchSession,
    prepareMutation,
    isPreparingMutation,
    sessionSyncGeneration,
    newSession,
    applyExternalSnapshot,
    sessionPaths,
    list,
    get,
    require,
    active,
    replay,
    stopAll,
    children,
    saveState,
    ownsTemporaryDraft(key) {
      return [...tabs.values()].some(tab => !tab.durableSessionFile && temporaryDraftKey(tab.draftId) === key
        || tab.retiredDraftIds.some(id => temporaryDraftKey(id) === key));
    },
    get activeId() { return activeId; },
    get selectionGeneration() { return selectionGeneration; },
    get size() { return tabs.size; },
  };
}
