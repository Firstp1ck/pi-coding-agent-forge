import QtQuick
import Quickshell
import Quickshell.Io

// Owns the Node backend process and turns its typed events into QML state. QML never sees a
// raw Pi record: the backend translates, bounds, and renders content before it reaches here.
Scope {
    id: bridge

    readonly property int protocolVersion: 1
    readonly property int maxTranscriptRows: 80
    readonly property int maxMessageCharacters: 8192
    readonly property int maxErrorCharacters: 512
    readonly property int maxRuntimeInfoCharacters: 160
    readonly property int maxModels: 256
    readonly property int maxNotices: 200
    property int noticeRevision: 0
    property var usage: null
    property var recentActions: []
    readonly property int maxPendingRequests: 64
    property int maxInboundFrameBytes: 262144
    property int maxDialogValueCharacters: 16384
    property int maxControlRequests: 8
    property int maxTextAttachmentBytes: 262144
    property int maxAttachmentReadCharacters: 32768
    property int backendGeneration: 0
    property var sessionGenerations: ({})
    property var promptSubmissions: []
    property var dialogStates: ({})
    readonly property int maxDialogStates: 128
    readonly property var sessionScopedRequestTypes: ({
        "prompt": true, "abort": true, "state": true, "restart": true, "extension_response": true,
        "models_list": true, "model_set": true, "model_cycle": true, "thinking_levels": true,
        "thinking_set": true, "thinking_cycle": true, "resources_state": true, "tools_set": true,
        "skills_set": true, "sampling_set": true, "compact": true, "commands_list": true,
        "attachment_add": true, "attachment_update": true, "attachment_remove": true, "attachment_read": true,
        "path_complete": true, "session_stats": true, "sessions_list": true, "session_switch": true,
        "session_new": true, "worktrees_list": true, "worktree_plan": true
    })
    readonly property int defaultRequestTimeoutMs: 10000
    readonly property int backendStartupMs: 8000
    readonly property bool smokeMode: Quickshell.env("QT_WEBUI_SMOKE_MODE") === "1"
    readonly property string callerCwd: String(Quickshell.env("QT_WEBUI_CALLER_CWD") || "")
    readonly property string homeDirectory: String(Quickshell.env("HOME") || "")
    readonly property int maxTabs: 8
    readonly property int maxResourceNames: 512
    // The saved-session catalog is global across Pi projects. It is loaded one bounded backend
    // page at a time and replaced only after a complete successful pass.
    property var sessionCatalog: []
    property int maxCatalogRows: 2000
    property bool sessionCatalogLoading: false
    property string sessionCatalogError: ""
    property string sessionCatalogWarning: ""
    property int sessionCatalogGeneration: 0
    property var sessionSettlementPending: ({})
    property bool sessionSettleAllPending: false
    // Tabs: one Pi session per tab. Only the active tab is materialized here; the backend keeps a
    // bounded mirror of every tab and replays it when the active tab changes.
    property var tabs: []
    property string activeTabId: ""
    property int selectionGeneration: 0
    readonly property int tabCount: tabs.length
    readonly property var activeTab: tabById(activeTabId)
    readonly property string workspaceCwd: activeTab ? String(activeTab.cwd) : callerCwd
    readonly property string displayCwd: shortenPath(workspaceCwd)
    readonly property string runtimeInfoText: currentProvider.length > 0
        && currentModelId.length > 0 && currentThinkingLevel.length > 0
        ? currentProvider + "/" + currentModelId + " · thinking " + currentThinkingLevel
        : ""

    property alias transcriptModel: transcript
    property int transcriptRevision: 0
    property alias noticeModel: notices
    property bool backendRunning: backendProcess.running
    property bool backendReady: false
    property bool ready: false
    property bool canRecover: false
    property bool active: false
    property bool quitting: false
    property string statusKind: "stopped"
    property string statusText: "Starting…"
    property string visibleError: ""
    property string currentProvider: ""
    property string currentModelId: ""
    property string currentModelName: ""
    property bool currentModelReasoning: false
    property string currentThinkingLevel: ""
    property bool modelActionPending: false
    property bool resourceActionPending: false
    property bool resourceLoading: false
    property var resourceState: null
    readonly property bool resourcesAvailable: resourceState !== null && resourceState.available === true
    property bool compacting: false
    property string sessionName: ""
    property string sessionFile: ""
    // Drafts follow the Pi session file when one exists and the tab's workspace otherwise.
    readonly property string draftKey: sessionFile.length > 0 ? sessionFile : workspaceCwd
    property var attachments: []
    property var commands: []
    property bool commandsLoaded: false
    property bool syntaxHighlighting: true
    property string extensionStatusText: ""
    property var statusChips: []
    property var statusTexts: ({})
    property var statusEntries: []
    property bool restarting: false
    property var steeringQueue: []
    property var followUpQueue: []
    readonly property bool compactTranscript: true
    property bool showThinking: true
    property bool desktopNotifications: true
    property string appearanceMode: "automatic"
    property bool reducedMotion: false
    readonly property int maxThemeInventory: 131
    readonly property int maxThemeDiagnostics: 64
    property var themeState: ({
        generation: 0,
        requested: { kind: "builtin", name: "automatic" },
        effective: { kind: "builtin", name: "automatic" },
        fallbackReason: "",
        inventory: [
            { identity: { kind: "builtin", name: "automatic" }, label: "Automatic" },
            { identity: { kind: "builtin", name: "light" }, label: "Light" },
            { identity: { kind: "builtin", name: "dark" }, label: "Dark" }
        ],
        diagnostics: [],
        palette: null,
        projectTrusted: false
    })
    property int sessionSettleDays: 30
    property bool sessionSettleDaysPending: false
    property var modelOrder: []
    property string portalColorScheme: normalizedPortalColorScheme(Quickshell.env("QT_WEBUI_SYSTEM_COLOR_SCHEME"))
    readonly property int desktopCornerRadius: validatedDesktopMetric(Quickshell.env("QT_WEBUI_DESKTOP_CORNER_RADIUS"), 0)
    readonly property int desktopEdgeGap: validatedDesktopMetric(Quickshell.env("QT_WEBUI_DESKTOP_EDGE_GAP"), 8)
    property bool windowActive: true
    property int requestSerial: 0
    property var pendingRequests: ({})
    property int pendingRequestCount: 0
    property int staleResponses: 0
    property int droppedEvents: 0
    property var requestTimeouts: ({})
    property var dialogQueue: []
    property var activeDialog: null
    property int backendExitCode: 0
    property bool backendRestartPending: false
    property string windowTitle: "Qt WebUI"

    signal backendBecameReady()
    signal runStarted()
    signal runEnded(bool ok, bool aborted)
    signal dialogRequested(var dialog)
    signal dialogFinished(string requestId)
    signal noticePosted(string level, string message)
    signal composerTextRequested(string text)
    signal eventReceived(var event)
    signal backendExited(int exitCode)
    signal modelsLoaded(var data)
    signal thinkingLevelsLoaded(var data)
    signal resourcesLoaded(var data)
    signal compactionFinished(bool ok)
    signal draftLoaded(string key, string text)
    signal sequenceRan(string sequenceId)
    signal tabSwitching()
    signal tabSwitched(string tabId)
    signal sessionReplacing()
    signal sessionReplaced()
    signal dialogStateChanged(string requestId, string state, string message)
    signal sessionsLoaded(var data)
    signal sessionCatalogLoaded(var sessions)

    ListModel {
        id: transcript
    }

    ListModel {
        id: notices
    }

    // ---- bounded helpers -------------------------------------------------------------

    function normalizedPortalColorScheme(value) {
        const mode = String(value || "").toLowerCase()
        return mode === "dark" || mode === "light" ? mode : "unknown"
    }

    function validatedDesktopMetric(value, fallback) {
        const metric = Number(value)
        return Number.isInteger(metric) && metric >= 0 && metric <= 64 ? metric : fallback
    }

    function applyAppearance(data) {
        if (!data || typeof data !== "object") return false
        const mode = normalizedPortalColorScheme(data.portalColorScheme)
        if (mode === "unknown") return false
        portalColorScheme = mode
        return true
    }

    function boundedText(value, limit) {
        const text = typeof value === "string" ? value : String(value ?? "")
        const max = limit || maxMessageCharacters
        if (text.length <= max) return text
        return text.slice(0, max - 1) + "…"
    }

    function boundedError(value) {
        return boundedText(typeof value === "string" && value.length > 0 ? value : "Unknown error", maxErrorCharacters)
    }

    function showError(value) {
        visibleError = boundedError(value)
        statusKind = "error"
        statusText = "Error"
    }

    function shortenPath(value) {
        const text = String(value || "")
        if (homeDirectory.length > 1 && text.indexOf(homeDirectory + "/") === 0) return "~" + text.slice(homeDirectory.length)
        return text === homeDirectory && homeDirectory.length > 0 ? "~" : text
    }

    function tabById(tabId) {
        for (const tab of tabs) if (tab.id === tabId) return tab
        return null
    }

    function tabLabel(tab) {
        if (!tab) return ""
        if (tab.name && tab.name.length > 0) return tab.name
        if (tab.sessionName && tab.sessionName.length > 0) return tab.sessionName
        const parts = String(tab.cwd || "").split("/").filter(part => part.length > 0)
        return parts.length > 0 ? parts[parts.length - 1] : "/"
    }

    function postNotice(level, message, tab) {
        const text = boundedText(message, maxErrorCharacters)
        while (notices.count >= maxNotices) notices.remove(0)
        notices.append({ "level": level, "message": text, "at": Date.now(), "tab": typeof tab === "string" ? tab : "" })
        noticeRevision++
        noticePosted(level, text)
    }

    function clearNotices() {
        notices.clear()
        noticeRevision++
    }

    // ---- transcript model ------------------------------------------------------------

    function rowIndexById(rowId) {
        for (let index = transcript.count - 1; index >= 0; index--) {
            if (transcript.get(index).rowId === rowId) return index
        }
        return -1
    }

    function appendRow(row) {
        while (transcript.count >= maxTranscriptRows) transcript.remove(0)
        transcript.append({
            "rowId": row.rowId,
            "messageId": row.messageId || "",
            "role": row.role,
            "kind": row.kind,
            "text": boundedText(row.text || ""),
            "blocksJson": row.blocksJson || "[]",
            "truncated": row.truncated === true,
            "streaming": row.streaming === true,
            "modeLabel": row.modeLabel || "",
            "attachments": row.attachments || "",
            "toolName": row.toolName || "",
            "toolSummary": row.toolSummary || "",
            "toolStatus": row.toolStatus || "",
            "toolDurationMs": row.toolDurationMs || 0,
            "toolOutput": row.toolOutput || "",
            "toolError": row.toolError || ""
        })
        transcriptRevision++
        return transcript.count - 1
    }

    function setRow(rowId, values) {
        const index = rowIndexById(rowId)
        if (index < 0) return false
        for (const key in values) transcript.setProperty(index, key, values[key])
        transcriptRevision++
        return true
    }

    function messageText(messageId) {
        let text = ""
        for (let index = 0; index < transcript.count; index++) {
            const row = transcript.get(index)
            if (row.messageId !== messageId) continue
            if (row.kind !== "text" && row.kind !== "user") continue
            text += (text.length > 0 ? "\n\n" : "") + row.text
        }
        return text
    }

    function copyToClipboard(text) {
        if (typeof text !== "string" || text.length === 0) return false
        Quickshell.clipboardText = text
        postNotice("info", "Copied " + text.length + " characters")
        return true
    }

    // ---- requests ----------------------------------------------------------------------

    function timeoutFor(type) {
        const configured = requestTimeouts && typeof requestTimeouts[type] === "number" ? requestTimeouts[type] : 0
        return configured > 0 ? configured : defaultRequestTimeoutMs
    }

    function utf8Bytes(text) {
        let bytes = 0
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i)
            if (code < 128) bytes++
            else if (code < 2048) bytes += 2
            else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
                    && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++ }
            else bytes += 3
        }
        return bytes
    }

    function sessionGenerationFor(tabId) {
        return backendGeneration + ":" + String(sessionGenerations[tabId] || 0)
    }

    function request(type, fields, callback, sessionScopedOverride, settlement) {
        if (!backendProcess.running) {
            const failure = { ok: false, local: true, error: { code: "not_running", message: "Backend is not running" } }
            if (settlement) settlement(failure)
            if (callback) callback(failure)
            return ""
        }
        const control = type === "abort" || type === "shutdown"
        if ((!control && pendingRequestCount >= maxPendingRequests) || pendingRequestCount >= maxPendingRequests + maxControlRequests) {
            const failure = { ok: false, local: true, error: { code: "busy", message: "Too many requests are pending" } }
            if (settlement) settlement(failure)
            if (callback) callback(failure)
            return ""
        }
        requestSerial++
        const id = "q-" + requestSerial
        const frame = Object.assign({ "v": protocolVersion, "id": id, "type": type }, fields || {})
        if (activeTabId.length > 0 && frame.tab === undefined) frame.tab = activeTabId
        const encoded = JSON.stringify(frame) + "\n"
        if (utf8Bytes(encoded) > maxInboundFrameBytes) {
            const failure = { ok: false, local: true, error: { code: "limit_exceeded", message: "The encoded request exceeds the transport limit; your text has been kept" } }
            if (settlement) settlement(failure)
            if (callback) callback(failure)
            return ""
        }
        const pending = pendingRequests
        pending[id] = {
            type: type,
            callback: callback || null,
            settlement: settlement || null,
            timedOut: false,
            deadline: Date.now() + timeoutFor(type),
            originTab: type === "tab_select" ? String(frame.tab) : activeTabId,
            selectionGeneration: selectionGeneration,
            sessionScoped: sessionScopedOverride === undefined ? sessionScopedRequestTypes[type] === true : sessionScopedOverride === true
        }
        pendingRequests = pending
        pendingRequestCount++
        pendingSweepTimer.start()
        backendProcess.write(encoded)
        return id
    }

    function settlePending(id, response) {
        const pending = pendingRequests
        const entry = pending[id]
        if (!entry) return false
        const late = entry.timedOut
        const retain = entry.settlement && response.clientTimeout === true
        if (retain) { entry.timedOut = true; entry.deadline = Infinity }
        else {
            delete pending[id]
            pendingRequestCount = Math.max(0, pendingRequestCount - 1)
        }
        pendingRequests = pending
        if (pendingRequestCount === 0) pendingSweepTimer.stop()
        // Settlement belongs to the operation, not to whichever tab is now selected.
        if (entry.settlement) entry.settlement(response)
        if (late || quitting) return true
        if (entry.sessionScoped && entry.originTab.length > 0 && entry.originTab !== activeTabId) {
            staleResponses++
            return true
        }
        if (entry.callback) entry.callback(response)
        return true
    }

    function failAllPending(code, message) {
        const pending = pendingRequests
        for (const id in pending) settlePending(id, { ok: false, error: { code: code, message: message } })
    }

    function sweepPending() {
        const now = Date.now()
        const pending = pendingRequests
        for (const id in pending) {
            if (pending[id].deadline <= now) {
                const type = pending[id].type
                settlePending(id, { ok: false, clientTimeout: true, error: { code: "timeout", message: type + " timed out in the client; outcome unknown" } })
            }
        }
    }

    // ---- public actions ------------------------------------------------------------------

    function sendPrompt(text, mode, settlement, draftText) {
        const message = typeof text === "string" ? text.trim() : ""
        if (!ready || message.length === 0 || message.length > maxMessageCharacters) return false
        const promptMode = mode || (active ? "steer" : "send")
        if (promptMode === "send" && active) return false
        visibleError = ""
        const attachmentIds = attachments.map(attachment => String(attachment.id))
        const generation = sessionGenerationFor(activeTabId)
        promptSubmissions = promptSubmissions.filter(entry => entry.generation === sessionGenerationFor(entry.tab))
        if (promptSubmissions.length >= maxPendingRequests) {
            showError("Too many submissions have unresolved outcomes")
            return false
        }
        if (promptSubmissions.some(entry => entry.tab === activeTabId && entry.generation === generation
                && entry.text === message && (entry.state === "admitted" || entry.state === "unknown"))) {
            showError("This submission is still pending or its outcome is unknown; it has not been sent again")
            return false
        }
        const submission = { id: "", tab: activeTabId, generation: generation, draftKey: draftKey,
            text: message, draftText: draftText === undefined ? text : draftText, mode: promptMode,
            attachmentIds: attachmentIds, state: "admitted" }
        const id = request("prompt", { "message": message, "mode": promptMode, "attachments": attachmentIds }, response => {
            if (!response.ok) showError(response.error.message)
            // The backend consumes attachments once the prompt is accepted for delivery; only a
            // refusal before that point (busy, not ready, backend gone) leaves them attached.
            const kept = !response.ok && ["busy", "not_ready", "not_running"].indexOf(response.error.code) !== -1
            if (attachmentIds.length > 0 && !kept) attachments = []
        }, true, response => {
            submission.state = response.ok ? "accepted" : !response.local && ["timeout", "not_running"].indexOf(response.error.code) !== -1 ? "unknown" : "rejected"
            submission.superseded = submission.generation !== sessionGenerationFor(submission.tab)
            if (settlement) settlement(response, submission)
            if (submission.state !== "unknown") promptSubmissions = promptSubmissions.filter(entry => entry !== submission)
        })
        submission.id = id
        if (id.length > 0) promptSubmissions = promptSubmissions.concat([submission])
        return id.length > 0
    }

    // ---- composer support: commands, paths, attachments, drafts, sequences --------------

    function loadCommands(callback) {
        if (!ready) return false
        request("commands_list", {}, response => {
            if (!response.ok) postNotice("error", "Could not list commands: " + response.error.message)
            else {
                commands = response.data.commands
                commandsLoaded = true
            }
            if (callback) callback(response)
        })
        return true
    }

    function completePath(query, callback) {
        request("path_complete", { "query": boundedText(query, 256) }, response => {
            if (callback) callback(response)
        })
    }

    function addAttachment(path, granted, callback) {
        request("attachment_add", { "path": String(path), "granted": granted === true }, response => {
            if (!response.ok) postNotice("error", "Could not attach file: " + response.error.message)
            else attachments = response.data.attachments
            if (callback) callback(response)
        })
    }

    function readAttachment(attachmentId, callback, offset, revision, accumulated, chunks) {
        if ((chunks || 0) >= Math.ceil(maxTextAttachmentBytes / maxAttachmentReadCharacters)) {
            callback({ ok: false, error: { code: "limit_exceeded", message: "Attachment read exceeded its transfer count limit" } })
            return ""
        }
        const fields = { attachmentId: String(attachmentId), offset: offset || 0 }
        if (revision !== undefined) fields.revision = revision
        return request("attachment_read", fields, response => {
            if (!response.ok) { callback(response); return }
            const text = (accumulated || "") + response.data.text
            if (utf8Bytes(text) > maxTextAttachmentBytes) { callback({ ok: false, error: { code: "limit_exceeded", message: "Attachment read exceeded its byte limit" } }); return }
            if (response.data.nextOffset !== null) {
                if (response.data.nextOffset <= fields.offset) { callback({ ok: false, error: { code: "invalid_request", message: "Invalid attachment read progress" } }); return }
                readAttachment(attachmentId, callback, response.data.nextOffset, response.data.revision, text, (chunks || 0) + 1)
            } else callback({ ok: true, data: { text: text, revision: response.data.revision } })
        })
    }

    function updateAttachment(attachmentId, text, callback) {
        const tab = activeTabId
        const generation = sessionGenerationFor(tab)
        return request("attachment_update", { "attachmentId": String(attachmentId), "text": String(text) }, response => {
            if (!response.ok) postNotice("error", "Could not update attachment: " + response.error.message)
            else if (generation === sessionGenerationFor(tab)) attachments = response.data.attachments
        }, true, callback)
    }

    function removeAttachment(attachmentId, callback) {
        request("attachment_remove", { "attachmentId": String(attachmentId) }, response => {
            if (!response.ok && response.error.code !== "stale_request") postNotice("error", "Could not remove attachment: " + response.error.message)
            if (response.ok) attachments = response.data.attachments
            // A definite rejection leaves the selected metadata unchanged.
            if (callback) callback(response)
        })
    }

    function loadDraft(callback) {
        const key = draftKey
        request("draft_get", { "key": key }, response => {
            if (response.ok) draftLoaded(key, String(response.data.text || ""))
            if (callback) callback(response)
        })
    }

    function saveDraft(text) {
        return saveDraftFor(draftKey, text)
    }

    function saveDraftFor(key, text, expectedText) {
        if (typeof key !== "string" || key.length === 0) return ""
        const fields = { key: key, text: boundedText(String(text || ""), 8192) }
        if (expectedText !== undefined) fields.expectedText = expectedText
        return request("draft_set", fields, () => {})
    }

    function loadSequences(callback) {
        request("sequences_list", {}, response => {
            if (!response.ok) postNotice("error", "Could not load sequences: " + response.error.message)
            if (callback) callback(response)
        })
    }

    function saveSequence(sequenceId, name, entries, callback) {
        const fields = { "name": boundedText(name, 64), "entries": entries }
        if (typeof sequenceId === "string" && sequenceId.length > 0) fields["sequenceId"] = sequenceId
        request("sequence_save", fields, response => {
            if (!response.ok) postNotice("error", "Could not save sequence: " + response.error.message)
            if (callback) callback(response)
        })
    }

    function deleteSequence(sequenceId, callback) {
        request("sequence_delete", { "sequenceId": String(sequenceId) }, response => {
            if (!response.ok) postNotice("error", "Could not delete sequence: " + response.error.message)
            if (callback) callback(response)
        })
    }

    function moveSequence(sequenceId, delta, callback) {
        request("sequence_move", { "sequenceId": String(sequenceId), "delta": delta < 0 ? -1 : 1 }, response => {
            if (!response.ok) postNotice("error", "Could not reorder sequences: " + response.error.message)
            if (callback) callback(response)
        })
    }

    // Runs only from the sequences dialog's explicit Run action; the backend sends the first
    // entry and queues the rest as follow-ups.
    function runSequence(sequenceId, callback) {
        if (!ready || active) {
            if (callback) callback({ ok: false, error: { code: "busy", message: "Pi is busy" } })
            return false
        }
        visibleError = ""
        request("sequence_run", { "sequenceId": String(sequenceId) }, response => {
            if (!response.ok) showError("Sequence failed: " + response.error.message)
            else {
                postNotice("info", "Sequence started: 1 prompt sent, " + response.data.queued + " queued")
                sequenceRan(String(sequenceId))
            }
            if (callback) callback(response)
        })
        return true
    }

    function abortRun() {
        if (!active) return false
        statusKind = "running"
        statusText = "Stopping…"
        request("abort", {}, response => {
            if (!response.ok && response.error.code !== "not_running") showError(response.error.message)
        })
        return true
    }

    function restartProcess() {
        if (!backendProcess.running) {
            backendRestartPending = false
            startBackend()
            return true
        }
        if (restarting || active) return false
        restarting = true
        statusKind = "running"
        statusText = "Restarting…"
        visibleError = ""
        postNotice("info", "Restarting Pi…")
        request("restart", {}, response => {
            if (!response.ok) {
                restarting = false
                const current = tabById(activeTabId)
                if (current) {
                    statusKind = String(current.statusKind)
                    statusText = String(current.statusText)
                    ready = current.ready === true
                    active = current.active === true
                }
                if (response.error.code === "busy") postNotice("warning", response.error.message)
                else showError(response.error.message)
            }
        })
        return true
    }

    function refreshState() {
        return request("state", {}, () => {})
    }

    function validThemeIdentity(identity) {
        if (!identity || typeof identity !== "object") return false
        if (identity.kind !== "builtin" && identity.kind !== "external") return false
        const name = String(identity.name || "")
        if (name.length < 1 || name.length > 64 || name.indexOf("/") !== -1 || name.trim() !== name) return false
        if (identity.kind === "builtin" && ["automatic", "light", "dark"].indexOf(name) === -1) return false
        return true
    }

    function resetThemeGeneration() {
        themeState = Object.assign({}, themeState, { generation: 0 })
    }

    function applyThemeState(data) {
        if (!data || typeof data !== "object" || !Number.isInteger(data.generation) || data.generation < 0) return false
        if (themeState && Number.isInteger(themeState.generation) && data.generation < themeState.generation) return false
        if (!validThemeIdentity(data.requested) || !validThemeIdentity(data.effective)) return false
        if (!Array.isArray(data.inventory) || data.inventory.length > maxThemeInventory
                || !Array.isArray(data.diagnostics) || data.diagnostics.length > maxThemeDiagnostics) return false
        if (data.palette !== null && (!data.palette || typeof data.palette !== "object" || Array.isArray(data.palette))) return false
        for (const entry of data.inventory) {
            if (!entry || typeof entry !== "object" || !validThemeIdentity(entry.identity)
                    || typeof entry.label !== "string" || entry.label.length > 64) return false
        }
        themeState = {
            generation: data.generation,
            requested: { kind: data.requested.kind, name: data.requested.name },
            effective: { kind: data.effective.kind, name: data.effective.name },
            fallbackReason: typeof data.fallbackReason === "string" ? boundedText(data.fallbackReason, 64) : "",
            inventory: data.inventory.slice(0, maxThemeInventory),
            diagnostics: data.diagnostics.slice(0, maxThemeDiagnostics),
            palette: data.palette,
            projectTrusted: data.projectTrusted === true
        }
        return true
    }

    function listThemes(callback) {
        return request("themes_list", {}, response => {
            if (response.ok && !applyThemeState(response.data)) {
                response = { ok: false, error: { code: "invalid_response", message: "The backend returned invalid theme state" } }
            }
            if (!response.ok) postNotice("error", "Could not refresh themes: " + response.error.message)
            if (callback) callback(response)
        }, false)
    }

    function selectTheme(identity, callback) {
        if (!validThemeIdentity(identity)) {
            const response = { ok: false, error: { code: "invalid_request", message: "Choose a valid theme" } }
            if (callback) callback(response)
            return false
        }
        request("theme_select", { "selection": { "kind": identity.kind, "name": identity.name } }, response => {
            if (response.ok && !applyThemeState(response.data)) {
                response = { ok: false, error: { code: "invalid_response", message: "The backend returned invalid theme state" } }
            }
            if (!response.ok) postNotice("error", "Could not select theme: " + response.error.message)
            if (callback) callback(response)
        }, false)
        return true
    }

    function updateSetting(name, value) {
        const values = {}
        values[name] = value
        request("settings_set", { "values": values }, response => {
            if (!response.ok) postNotice("error", "Could not save setting: " + response.error.message)
            else applySettings(response.data.settings)
        })
    }

    function setSessionSettleDays(value, callback) {
        const days = Number(value)
        if (sessionSettleDaysPending || !Number.isInteger(days) || days < 1 || days > 3650) {
            if (callback) callback({ ok: false, error: { code: "invalid_request", message: "Enter a whole number from 1 to 3,650" } })
            return false
        }
        sessionSettleDaysPending = true
        request("settings_set", { "values": { "sessionSettleDays": days } }, response => {
            sessionSettleDaysPending = false
            if (!response.ok) {
                postNotice("error", "Could not save automatic settlement: " + response.error.message)
            } else if (!response.data || !response.data.settings
                    || !Number.isInteger(response.data.settings.sessionSettleDays)
                    || response.data.settings.sessionSettleDays < 1
                    || response.data.settings.sessionSettleDays > 3650) {
                response = { ok: false, error: { code: "invalid_response", message: "The backend returned an invalid settlement setting" } }
                postNotice("error", response.error.message)
            } else {
                applySettings(response.data.settings)
                refreshSessionCatalog()
                postNotice("info", "Automatic settlement: " + sessionSettleDays + " days")
            }
            if (callback) callback(response)
        })
        return true
    }

    function applySettings(settings) {
        if (!settings || typeof settings !== "object") return
        if (typeof settings.showThinking === "boolean") showThinking = settings.showThinking
        if (typeof settings.desktopNotifications === "boolean") desktopNotifications = settings.desktopNotifications
        if (typeof settings.syntaxHighlighting === "boolean") syntaxHighlighting = settings.syntaxHighlighting
        if (["automatic", "light", "dark"].indexOf(settings.appearanceMode) !== -1) appearanceMode = settings.appearanceMode
        if (typeof settings.reducedMotion === "boolean") reducedMotion = settings.reducedMotion
        if (Number.isInteger(settings.sessionSettleDays) && settings.sessionSettleDays >= 1 && settings.sessionSettleDays <= 3650) sessionSettleDays = settings.sessionSettleDays
        if (Array.isArray(settings.modelOrder)) modelOrder = settings.modelOrder.slice(0, maxModels)
    }

    function openLink(url, callback) {
        request("open_link", { "url": String(url) }, response => {
            if (!response.ok) postNotice("error", "Could not open link: " + response.error.message)
            else if (response.data && response.data.suppressed) postNotice("info", "Link opening is suppressed in this mode")
            if (callback) callback(response)
        })
    }

    function tabSessionIsSettled(tabId) {
        const id = String(tabId || "")
        if (id.length === 0) return false
        for (const session of sessionCatalog) {
            if (!session || session.settled !== true) continue
            const tab = sessionTab(session)
            if (tab && String(tab.id || "") === id) return true
        }
        return false
    }

    function notificationSessionLabel(tabId) {
        const id = String(tabId || "")
        const tab = tabById(id)
        if (tab && typeof tab.name === "string" && tab.name.trim().length > 0) return tab.name.trim()
        if (tab && typeof tab.sessionName === "string" && tab.sessionName.trim().length > 0) return tab.sessionName.trim()
        if (id === activeTabId && sessionName.trim().length > 0) return sessionName.trim()
        return tabLabel(tab)
    }

    function notificationBody(body, tabId) {
        const label = notificationSessionLabel(tabId)
        const details = String(body || "").trim()
        if (label.length === 0) return details
        if (details.length === 0 || details === label) return label
        return label + "\n" + details
    }

    function notifyDesktop(title, body, sourceTabId) {
        const tabId = sourceTabId === undefined ? activeTabId : String(sourceTabId || "")
        if (!desktopNotifications || windowActive || tabSessionIsSettled(tabId)) return false
        request("notify", { "title": boundedText(title, 256), "body": boundedText(notificationBody(body, tabId), 256) }, response => {
            if (smokeMode && response.ok) console.log("QT_WEBUI_SMOKE_NOTIFICATION_REQUESTED")
        })
        return true
    }

    // ---- models, thinking, resource profiles, and compaction -----------------------------

    function applyResourceState(data) {
        if (!data || typeof data !== "object") {
            resourceState = { available: false, error: { code: "unavailable", message: "Resource state is unavailable" } }
        } else {
            resourceState = data
        }
        resourcesLoaded(resourceState)
    }

    function refreshResources(callback) {
        if (!ready || active || resourceLoading || resourceActionPending || modelActionPending) {
            if (callback) callback({ ok: false, error: { code: active ? "busy" : "unavailable", message: active ? "Pi is busy" : "Resource state cannot be refreshed now" } })
            return false
        }
        resourceLoading = true
        request("resources_state", {}, response => {
            resourceLoading = false
            if (response.ok) applyResourceState(response.data)
            else applyResourceState({ available: false, error: response.error })
            if (callback) callback(response)
        })
        return true
    }

    function setEnabledTools(scope, names, callback) {
        return setResourceProfile("tools_set", scope, "enabledTools", names, callback)
    }

    function setEnabledSkills(scope, names, callback) {
        return setResourceProfile("skills_set", scope, "enabledSkills", names, callback)
    }

    function setSampling(scope, params, callback) {
        return setResourceProfile("sampling_set", scope, "params", params, callback)
    }

    function setResourceProfile(type, scope, field, value, callback) {
        if (!ready || active || modelActionPending || resourceActionPending || resourceLoading || !resourcesAvailable) {
            if (callback) callback({ ok: false, error: { code: active ? "busy" : "unavailable", message: active ? "Pi is busy" : "Resource profiles are unavailable" } })
            return false
        }
        resourceActionPending = true
        const fields = { "scope": String(scope) }
        fields[field] = value
        const finish = response => {
            resourceActionPending = false
            if (!response.ok) postNotice("error", "Could not save resource profile: " + response.error.message)
            else {
                applyResourceState(response.data)
                if (scope === "session" && response.data.sessionDurability && response.data.sessionDurability.durable === false) {
                    postNotice("warning", String(response.data.sessionDurability.reason || "This session profile is not durable."))
                }
            }
            if (callback) callback(response)
        }
        if (type === "tools_set") request("tools_set", fields, finish)
        else if (type === "skills_set") request("skills_set", fields, finish)
        else request("sampling_set", fields, finish)
        return true
    }

    function orderedModelData(data) {
        if (!data || !data.scope || data.scope.explicit !== true || !Array.isArray(data.models)) return data
        const byIdentity = {}
        for (const model of data.models) byIdentity[String(model.provider) + "/" + String(model.id)] = model
        const ordered = []
        const used = {}
        for (const identity of modelOrder) {
            if (byIdentity[identity] === undefined || used[identity] === true) continue
            ordered.push(byIdentity[identity])
            used[identity] = true
        }
        for (const model of data.models) {
            const identity = String(model.provider) + "/" + String(model.id)
            if (used[identity] === true) continue
            ordered.push(model)
            used[identity] = true
        }
        return Object.assign({}, data, { "models": ordered })
    }

    function mergedModelOrder(currentIdentities) {
        const merged = []
        const current = {}
        for (const value of Array.isArray(currentIdentities) ? currentIdentities : []) {
            const identity = String(value)
            if (identity.length === 0 || current[identity] === true || merged.length >= maxModels) continue
            current[identity] = true
            merged.push(identity)
        }
        for (const value of modelOrder) {
            const identity = String(value)
            if (identity.length === 0 || current[identity] === true || merged.indexOf(identity) !== -1 || merged.length >= maxModels) continue
            merged.push(identity)
        }
        return merged
    }

    function saveModelOrder(currentIdentities, callback) {
        const merged = mergedModelOrder(currentIdentities)
        request("settings_set", { "values": { "modelOrder": merged } }, response => {
            if (!response.ok) postNotice("error", "Could not save model order: " + response.error.message)
            else applySettings(response.data.settings)
            if (callback) callback(response)
        })
        return merged
    }

    function loadModels(callback) {
        if (!ready) return false
        request("models_list", {}, response => {
            if (!response.ok) postNotice("error", "Could not list models: " + response.error.message)
            else {
                response.data = orderedModelData(response.data)
                modelsLoaded(response.data)
            }
            if (callback) callback(response)
        })
        return true
    }

    function selectModel(provider, modelId) {
        if (!ready || active || modelActionPending || resourceActionPending) return false
        if (provider === currentProvider && modelId === currentModelId) return false
        modelActionPending = true
        request("model_set", { "provider": String(provider), "modelId": String(modelId) }, response => {
            modelActionPending = false
            if (!response.ok) postNotice("error", "Could not change the model: " + response.error.message)
            else {
                applyResourceState(response.data.resources)
                postNotice("info", "Model: " + response.data.model.provider + "/" + response.data.model.id + " · thinking " + response.data.thinkingLevel)
            }
        })
        return true
    }

    function cycleModel() {
        if (!ready || active || modelActionPending || resourceActionPending) return false
        modelActionPending = true
        request("model_cycle", {}, response => {
            modelActionPending = false
            if (!response.ok) postNotice("error", "Could not change the model: " + response.error.message)
            else {
                applyResourceState(response.data.resources)
                if (!response.data.changed) postNotice("info", "Only one model is configured")
                else postNotice("info", "Model: " + response.data.model.provider + "/" + response.data.model.id + " · thinking " + response.data.thinkingLevel)
            }
        })
        return true
    }

    function loadThinkingLevels(callback) {
        if (!ready) return false
        request("thinking_levels", {}, response => {
            if (!response.ok) postNotice("error", "Could not list thinking levels: " + response.error.message)
            else thinkingLevelsLoaded(response.data)
            if (callback) callback(response)
        })
        return true
    }

    function setThinkingLevel(level) {
        if (!ready || active || modelActionPending || resourceActionPending) return false
        if (level === currentThinkingLevel) return false
        modelActionPending = true
        request("thinking_set", { "level": String(level) }, response => {
            modelActionPending = false
            if (!response.ok) postNotice("error", "Could not change the thinking level: " + response.error.message)
            else {
                applyResourceState(response.data.resources)
                postNotice("info", "Thinking " + response.data.level)
            }
        })
        return true
    }

    function cycleThinkingLevel() {
        if (!ready || active || modelActionPending || resourceActionPending) return false
        modelActionPending = true
        request("thinking_cycle", {}, response => {
            modelActionPending = false
            if (!response.ok) postNotice("error", "Could not change the thinking level: " + response.error.message)
            else {
                applyResourceState(response.data.resources)
                if (!response.data.changed) postNotice("info", "This model has no thinking levels")
                else postNotice("info", "Thinking " + response.data.level)
            }
        })
        return true
    }

    function compactContext(instructions) {
        if (!ready || active || compacting) return false
        compacting = true
        visibleError = ""
        const fields = typeof instructions === "string" && instructions.trim().length > 0 ? { "instructions": boundedText(instructions.trim(), 1024) } : {}
        request("compact", fields, response => {
            compacting = false
            if (!response.ok && response.error.code !== "busy") showError("Compaction failed: " + response.error.message)
            compactionFinished(response.ok === true)
        })
        return true
    }

    // ---- tabs, sessions, directories, worktrees ------------------------------------------

    // Everything scoped to one Pi session. Pending dialogs belong to the other tab and stay
    // pending in the backend; they are dropped here without being answered.
    function resetTabState() {
        transcript.clear()
        transcriptRevision = 0
        visibleError = ""
        statusKind = "stopped"
        statusText = "Starting…"
        ready = false
        canRecover = false
        active = false
        currentProvider = ""
        currentModelId = ""
        currentModelName = ""
        currentModelReasoning = false
        currentThinkingLevel = ""
        sessionName = ""
        sessionFile = ""
        steeringQueue = []
        followUpQueue = []
        attachments = []
        commands = []
        commandsLoaded = false
        statusChips = []
        statusEntries = []
        statusTexts = ({})
        extensionStatusText = ""
        compacting = false
        modelActionPending = false
        resourceActionPending = false
        resourceLoading = false
        resourceState = null
        restarting = false
        const wasActive = activeDialog ? activeDialog.requestId : ""
        dialogQueue = []
        activeDialog = null
        if (wasActive.length > 0) dialogFinished(wasActive)
    }

    function beginTabSwitch(tabId) {
        if (tabId === activeTabId) return
        tabSwitching()
        activeTabId = tabId
        resetTabState()
        usage = null
        tabSwitched(tabId)
    }

    function applyTabSummary(tab, refreshOnReady = true) {
        if (!tab) return
        const wasReady = ready
        ready = tab.ready === true
        canRecover = tab.canRecover === true
        statusKind = String(tab.statusKind || "stopped")
        statusText = boundedText(tab.statusText || "", maxRuntimeInfoCharacters)
        // A transition target in tabs.update is not yet the editor's confirmed conversation.
        if (tab.ready === true && tab.mutating !== true) {
            sessionName = boundedText(tab.sessionName || "", maxRuntimeInfoCharacters)
            const previousSessionFile = sessionFile
            sessionFile = typeof tab.sessionFile === "string" ? tab.sessionFile : ""
            if (sessionFile !== previousSessionFile && sessionFile.length > 0) scheduleSessionCatalogRefresh()
        }
        if (refreshOnReady && !wasReady && ready) {
            usageTimer.restart()
            bridge.refreshResources()
        }
    }

    // Applies a backend snapshot ({tab, session, attachments}); the transcript itself arrives as
    // transcript.reset and transcript.row events before the snapshot response.
    function applySnapshot(data) {
        if (!data || !data.session || !data.tab || data.tab.id !== activeTabId
                || data.selectionGeneration !== selectionGeneration) return
        const snapshot = data.session
        statusKind = String(snapshot.statusKind || "stopped")
        statusText = boundedText(snapshot.statusText || "", maxRuntimeInfoCharacters)
        ready = snapshot.ready === true
        active = snapshot.active === true
        compacting = snapshot.compacting === true
        modelActionPending = false
        resourceActionPending = false
        // A selection snapshot can arrive while its resource read is still admitted. Keep the
        // busy indicator until that response settles instead of allowing a second read or close.
        resourceLoading = Object.values(pendingRequests).some(entry => entry.type === "resources_state" && entry.originTab === activeTabId)
        resourceState = null
        restarting = false
        handleRuntime(snapshot.runtime || {})
        applyTabSummary(data.tab, false)
        visibleError = typeof snapshot.error === "string" && snapshot.error.trim().length > 0 ? boundedError(snapshot.error) : ""
        if (visibleError.length === 0 && statusKind === "error") statusKind = "stopped"
        steeringQueue = snapshot.queues && Array.isArray(snapshot.queues.steering) ? snapshot.queues.steering : []
        followUpQueue = snapshot.queues && Array.isArray(snapshot.queues.followUp) ? snapshot.queues.followUp : []
        statusChips = []
        statusEntries = []
        statusTexts = ({})
        extensionStatusText = ""
        for (const record of Array.isArray(snapshot.statusRecords) ? snapshot.statusRecords : []) handleExtensionStatus(record)
        attachments = Array.isArray(data.attachments) ? data.attachments : []
        for (const dialog of Array.isArray(snapshot.dialogs) ? snapshot.dialogs : []) enqueueDialog(dialog, false)
        presentNextDialog()
        if (ready) {
            usageTimer.restart()
            bridge.refreshResources()
        }
    }

    function selectTab(tabId, callback) {
        const tab = tabById(tabId)
        if (!tab || tabId === activeTabId) return false
        request("tab_select", { "tab": tabId }, response => {
            if (!response.ok) postNotice("error", "Could not switch tabs: " + response.error.message)
            else applySnapshot(response.data)
            if (callback) callback(response)
        })
        return true
    }

    function selectTabIndex(index) {
        if (index < 0 || index >= tabs.length) return false
        return selectTab(String(tabs[index].id))
    }

    function cycleTab(delta) {
        if (tabs.length < 2) return false
        let index = 0
        for (let position = 0; position < tabs.length; position++) if (tabs[position].id === activeTabId) index = position
        return selectTabIndex((index + delta + tabs.length) % tabs.length)
    }

    function openTab(cwd, sessionPath, callback) {
        if (tabs.length >= maxTabs) {
            postNotice("warning", "At most " + maxTabs + " tabs can be open")
            return false
        }
        const fields = {}
        if (typeof cwd === "string" && cwd.length > 0) fields["cwd"] = cwd
        if (typeof sessionPath === "string" && sessionPath.length > 0) fields["sessionPath"] = sessionPath
        request("tab_open", fields, response => {
            if (!response.ok) postNotice("error", "Could not open a tab: " + response.error.message)
            else applySnapshot(response.data)
            if (callback) callback(response)
        })
        return true
    }

    // Refused by the backend with `busy` while a run is active unless force is true; the shell
    // asks for confirmation before forcing.
    function closeTab(tabId, force, callback) {
        if (!tabById(tabId)) return false
        request("tab_close", { "tab": tabId, "force": force === true }, response => {
            if (!response.ok) {
                if (response.error.code !== "busy") postNotice("error", "Could not close the tab: " + response.error.message)
            } else if (response.data && response.data.session) applySnapshot(response.data)
            if (callback) callback(response)
        })
        return true
    }

    function renameTab(tabId, name, callback) {
        request("tab_rename", { "tab": tabId, "name": boundedText(name, 64) }, response => {
            if (!response.ok) postNotice("error", "Could not rename the tab: " + response.error.message)
            if (callback) callback(response)
        })
        return true
    }

    function moveTab(tabId, delta) {
        request("tab_move", { "tab": tabId, "delta": delta < 0 ? -1 : 1 }, response => {
            if (!response.ok) postNotice("error", "Could not move the tab: " + response.error.message)
        })
    }

    function loadSessionStats(callback) {
        if (!ready) return false
        request("session_stats", {}, response => {
            if (response.ok) usage = response.data
            if (callback) callback(response)
        })
        return true
    }

    function loadDiagnostics(callback) {
        request("diagnostics", {}, response => {
            if (callback) callback(response)
        })
    }

    // Local files (for example a skill file) open only after the shell confirmed the exact path.
    function openPath(path, callback) {
        request("open_path", { "path": String(path) }, response => {
            if (!response.ok) postNotice("error", "Could not open the file: " + response.error.message)
            else if (response.data && response.data.suppressed) postNotice("info", "Opening files is suppressed in this mode")
            if (callback) callback(response)
        })
    }

    function recordAction(action) {
        request("recent_action", { "action": boundedText(String(action), 128) }, response => {
            if (response.ok) recentActions = response.data.recentActions
        })
    }

    function refreshTabs(callback) {
        request("tabs_list", {}, response => {
            if (response.ok) {
                tabs = response.data.tabs
                if (typeof response.data.activeTab === "string" && response.data.activeTab !== activeTabId) beginTabSwitch(response.data.activeTab)
            }
            if (callback) callback(response)
        })
    }

    function listWorktrees(callback) {
        request("worktrees_list", {}, response => {
            if (!response.ok) postNotice("error", "Could not list worktrees: " + response.error.message)
            if (callback) callback(response)
        })
    }

    // Legacy workspace-only listing used by the existing resume picker and command palette.
    function listSessions(callback) {
        if (!ready && !canRecover) return false
        request("sessions_list", {}, response => {
            if (!response.ok) postNotice("error", "Could not list sessions: " + response.error.message)
            else sessionsLoaded(response.data)
            if (callback) callback(response)
        })
        return true
    }

    function scheduleSessionCatalogRefresh() {
        if (!backendReady || quitting) return false
        sessionCatalogRefreshTimer.restart()
        return true
    }

    function refreshSessionCatalog() {
        if (!backendReady || quitting) return false
        sessionCatalogRefreshTimer.stop()
        const generation = ++sessionCatalogGeneration
        sessionCatalogLoading = true
        sessionCatalogError = ""
        loadSessionCatalogPage(generation, 0, [], ({}))
        return true
    }

    function loadSessionCatalogPage(generation, offset, merged, seen, cursor, retries) {
        const fields = { scope: "all", offset: offset }
        if (cursor) fields.cursor = cursor
        request("sessions_list", fields, response => {
            if (generation !== sessionCatalogGeneration) return
            if (!response.ok) {
                if (response.error.code === "stale_request" && (retries || 0) < 1) {
                    loadSessionCatalogPage(generation, 0, [], ({}), "", (retries || 0) + 1)
                    return
                }
                sessionCatalogLoading = false
                sessionCatalogError = boundedError(response.error.message)
                postNotice("error", "Could not refresh sessions: " + sessionCatalogError)
                return
            }
            const rows = response.data && Array.isArray(response.data.sessions) ? response.data.sessions : []
            for (const session of rows) {
                const path = String(session.path || "")
                if (path.length === 0 || seen[path] === true) continue
                if (merged.length >= maxCatalogRows) {
                    sessionCatalogLoading = false
                    sessionCatalogError = "Catalog exceeds its declared retention limit"
                    return
                }
                seen[path] = true
                merged.push(session)
            }
            const nextOffset = response.data ? response.data.nextOffset : null
            if (nextOffset !== null) {
                if (!Number.isInteger(nextOffset) || nextOffset <= offset || typeof response.data.cursor !== "string" || response.data.cursor.length > 64) {
                    sessionCatalogLoading = false
                    sessionCatalogError = "The session catalog returned an invalid next page"
                    postNotice("error", sessionCatalogError)
                    return
                }
                loadSessionCatalogPage(generation, nextOffset, merged, seen, response.data.cursor, retries)
                return
            }
            sessionCatalog = merged
            sessionCatalogLoading = false
            sessionCatalogError = ""
            sessionCatalogWarning = response.data.truncated
                ? "Session discovery reached its scan or retention limit; this catalog is incomplete" : ""
            sessionCatalogLoaded(merged)
        }, false)
    }

    function sessionTab(session) {
        if (!session || typeof session !== "object") return null
        const openTabId = String(session.openTabId || "")
        if (openTabId.length > 0) return tabById(openTabId)
        const path = String(session.path || "")
        if (path.length === 0) return null
        for (const tab of tabs) if (String(tab.sessionFile || "") === path) return tab
        return null
    }

    function catalogSession(sessionPath) {
        const path = String(sessionPath || "")
        for (const session of sessionCatalog) if (String(session.path || "") === path) return session
        return null
    }

    function sessionSettlementIsPending(sessionPath) {
        return sessionSettlementPending[String(sessionPath || "")] === true
    }

    function updateCatalogSettlement(sessionPath, settled) {
        const path = String(sessionPath || "")
        sessionCatalog = sessionCatalog.map(session => String(session.path || "") === path
            ? Object.assign({}, session, { "settled": settled === true }) : session)
    }

    function setSessionSettled(sessionPath, settled, callback) {
        const path = String(sessionPath || "")
        const nextSettled = settled === true
        if (path.length === 0 || sessionSettlementIsPending(path)) return false
        const matchingTab = sessionTab(catalogSession(path))
        if (nextSettled && matchingTab && matchingTab.active) {
            postNotice("warning", "Wait for this session to become idle before settling it")
            return false
        }
        const pending = Object.assign({}, sessionSettlementPending)
        pending[path] = true
        sessionSettlementPending = pending
        request("session_settled", { "sessionPath": path, "settled": nextSettled }, response => {
            const remaining = Object.assign({}, sessionSettlementPending)
            delete remaining[path]
            sessionSettlementPending = remaining
            if (!response.ok) postNotice(response.error.code === "busy" ? "warning" : "error", "Could not update session: " + response.error.message)
            else updateCatalogSettlement(String(response.data.path || path), response.data.settled === true)
            if (callback) callback(response)
        }, false)
        return true
    }

    function finishSettleAll(settledCount, failedCount, skippedActive, callback) {
        sessionSettleAllPending = false
        const skippedCount = failedCount + skippedActive
        const summary = "Settled " + settledCount + " session" + (settledCount === 1 ? "" : "s")
            + (skippedCount > 0 ? "; skipped " + skippedCount : "")
        postNotice(skippedCount > 0 ? "warning" : "info", summary)
        if (callback) callback({
            ok: failedCount === 0,
            data: { settled: settledCount, failed: failedCount, skippedActive: skippedActive }
        })
    }

    function settleSessionBatch(paths, index, settledCount, failedCount, skippedActive, callback) {
        if (!sessionSettleAllPending) return
        if (index >= paths.length) {
            finishSettleAll(settledCount, failedCount, skippedActive, callback)
            return
        }
        const started = setSessionSettled(paths[index], true, response => {
            settleSessionBatch(paths, index + 1, settledCount + (response.ok ? 1 : 0), failedCount + (response.ok ? 0 : 1), skippedActive, callback)
        })
        if (!started) settleSessionBatch(paths, index + 1, settledCount, failedCount + 1, skippedActive, callback)
    }

    function settleAllSessions(callback) {
        if (sessionSettleAllPending || !backendReady || quitting) return false
        const paths = []
        let skippedActive = 0
        for (const session of sessionCatalog) {
            if (!session || session.settled === true) continue
            const path = String(session.path || "")
            const matchingTab = sessionTab(session)
            if (matchingTab && matchingTab.active) {
                skippedActive += 1
                continue
            }
            if (path.length > 0 && !sessionSettlementIsPending(path)) paths.push(path)
        }
        if (paths.length === 0) return false
        sessionSettleAllPending = true
        settleSessionBatch(paths, 0, 0, 0, skippedActive, callback)
        return true
    }

    function openCatalogSession(session, callback) {
        if (!session || typeof session !== "object") return false
        const path = String(session.path || "")
        const matchingTab = sessionTab(session)
        if (matchingTab) {
            if (matchingTab.id === activeTabId) {
                if (callback) callback({ ok: true, data: { tab: matchingTab, reused: true } })
                return true
            }
            return selectTab(String(matchingTab.id), callback)
        }
        if (tabs.length >= maxTabs) {
            postNotice("warning", "At most " + maxTabs + " tabs can be open")
            return false
        }
        return openTab(String(session.cwd || ""), path, callback)
    }

    function switchSession(sessionPath, callback) {
        if ((!ready && !canRecover) || active) return false
        visibleError = ""
        request("session_switch", { "sessionPath": String(sessionPath) }, response => {
            if (!response.ok) postNotice("error", "Could not resume the session: " + response.error.message)
            else postNotice("info", "Resumed " + (response.data.sessionName || "session") + " (" + response.data.rows + " entries shown)")
            if (callback) callback(response)
        })
        return true
    }

    function newSession(callback) {
        if ((!ready && !canRecover) || active) return false
        visibleError = ""
        request("session_new", {}, response => {
            if (!response.ok) postNotice("error", "Could not start a new session: " + response.error.message)
            else postNotice("info", "Started a new session")
            if (callback) callback(response)
        })
        return true
    }

    function listDirectory(path, showHidden, callback) {
        request("directory_list", { "path": String(path || ""), "showHidden": showHidden === true }, response => {
            if (callback) callback(response)
        })
    }

    function createDirectory(path, name, callback) {
        request("directory_create", { "path": String(path), "name": String(name) }, response => {
            if (callback) callback(response)
        })
    }

    function pinDirectory(path, callback) {
        request("directory_pin", { "path": String(path) }, response => {
            if (callback) callback(response)
        })
    }

    function planWorktree(branch, callback) {
        request("worktree_plan", { "branch": boundedText(branch, 128) }, response => {
            if (!response.ok) postNotice("error", "Cannot create a worktree: " + response.error.message)
            if (callback) callback(response)
        })
        return true
    }

    // Only called after the user confirmed the exact branch, base, and path from worktree_plan.
    function createWorktree(branch, base, path, callback) {
        request("worktree_create", { "branch": boundedText(branch, 128), "base": String(base || ""), "path": String(path || ""), "confirmed": true, "openTab": true }, response => {
            if (!response.ok) postNotice("error", "Worktree creation failed: " + response.error.message)
            else {
                postNotice("info", "Created worktree " + response.data.worktree.path)
                if (response.data.tab) applySnapshot(response.data.tab)
            }
            if (callback) callback(response)
        })
        return true
    }

    // Events from tabs that are not shown: keep the user informed without touching the view.
    function handleInactiveTabEvent(event) {
        const label = tabLabel(tabById(event.tab)) || String(event.tab)
        switch (event.type) {
        case "extension.request":
            postNotice("warning", label + " needs your input", label)
            notifyDesktop("Pi needs your input", label, event.tab)
            break
        case "run.end":
            postNotice(event.ok ? "info" : "error", label + (event.aborted ? " stopped" : event.ok ? " finished" : " failed"), label)
            notifyDesktop(event.aborted ? "Pi stopped" : event.ok ? "Pi finished" : "Pi failed", label, event.tab)
            break
        case "pi.error":
            if (typeof event.message === "string" && event.message.length > 0) postNotice("error", label + ": " + event.message, label)
            break
        case "pi.exit":
            if (event.code !== 0) postNotice("error", label + ": Pi exited (" + (event.code ?? event.signal ?? "unknown") + ")", label)
            break
        case "notice":
            postNotice(String(event.level || "info"), label + ": " + String(event.message || ""), label)
            break
        default:
            break
        }
    }

    // ---- extension dialogs -----------------------------------------------------------

    function enqueueDialog(event, notify) {
        const requestId = String(event.requestId)
        if ((activeDialog && activeDialog.requestId === requestId) || dialogQueue.some(entry => entry.requestId === requestId)) return false
        const key = dialogKey(activeTabId, requestId)
        const cached = dialogStates[key]
        if (cached && cached.state === "finished") return false
        const queue = dialogQueue
        const dialog = cached || {
            requestId: requestId, method: String(event.method), title: String(event.title || ""),
            message: String(event.message || ""), options: Array.isArray(event.options) ? event.options : [],
            placeholder: String(event.placeholder || ""), prefill: String(event.prefill || ""),
            timeoutMs: Number(event.timeoutMs) || 0, state: "open", originTab: activeTabId,
            generation: sessionGenerationFor(activeTabId), draftValue: String(event.prefill || "")
        }
        const states = Object.assign({}, dialogStates)
        if (!cached && Object.keys(states).length >= maxDialogStates) {
            const expired = Object.keys(states).find(id => states[id].state === "finished" || states[id].generation !== sessionGenerationFor(states[id].originTab))
            if (expired) delete states[expired]
            else { postNotice("error", "Too many retained dialogs"); return false }
        }
        states[key] = dialog
        dialogStates = states
        queue.push(dialog)
        dialogQueue = queue
        if (notify) notifyDesktop("Pi needs your input", String(event.title || event.method))
        return true
    }

    function presentNextDialog() {
        if (activeDialog !== null || dialogQueue.length === 0) return
        const queue = dialogQueue
        activeDialog = queue.shift()
        dialogQueue = queue
        dialogRequested(activeDialog)
    }

    function dialogKey(tab, requestId, generation) {
        return tab + ":" + (generation === undefined ? sessionGenerationFor(tab) : generation) + ":" + requestId
    }

    function updateDialogDraft(requestId, value) {
        if (activeDialog && activeDialog.requestId === requestId) activeDialog.draftValue = value
    }

    function answerDialog(requestId, answer) {
        if (!activeDialog || activeDialog.requestId !== requestId || activeDialog.state !== "open") return false
        const dialog = activeDialog
        if (typeof answer.value === "string" && answer.value.length > maxDialogValueCharacters) {
            dialogStateChanged(requestId, "open", "Answers are limited to " + maxDialogValueCharacters + " characters")
            return false
        }
        dialog.state = "submitting"
        dialogStateChanged(requestId, "submitting", "")
        const fields = Object.assign({ "requestId": requestId, tab: dialog.originTab }, answer)
        const id = request("extension_response", fields, null, true, response => {
            if (dialog.state === "finished") return
            if (response.ok || response.error.code === "stale_request") {
                finishDialog(requestId, dialog.originTab, dialog.generation)
                return
            }
            dialog.state = !response.local && ["timeout", "not_running"].indexOf(response.error.code) !== -1 ? "unknown" : "open"
            if (activeDialog === dialog) dialogStateChanged(requestId, dialog.state, response.error.message)
            postNotice("error", "Dialog answer " + (dialog.state === "unknown" ? "outcome unknown: " : "failed: ") + response.error.message)
        })
        return id.length > 0
    }

    function finishDialog(requestId, tabId, generation) {
        const tab = tabId === undefined ? activeTabId : tabId
        const key = dialogKey(tab, requestId, generation)
        const dialog = dialogStates[key]
        if (dialog) dialog.state = "finished"
        if (tab !== activeTabId || (generation !== undefined && generation !== sessionGenerationFor(tab))) return
        if (activeDialog && activeDialog.requestId === requestId && (!dialog || activeDialog === dialog)) {
            activeDialog = null
            dialogFinished(requestId)
        } else {
            dialogQueue = dialogQueue.filter(entry => entry.requestId !== requestId)
        }
        presentNextDialog()
    }

    function clearDialogs(reason) {
        const wasActive = activeDialog ? activeDialog.requestId : ""
        dialogQueue = []
        activeDialog = null
        if (wasActive.length > 0) dialogFinished(wasActive)
        if (reason) postNotice("warning", reason)
    }

    // ---- event handling ------------------------------------------------------------------

    function handleStatus(event) {
        statusKind = String(event.statusKind || "stopped")
        statusText = boundedText(event.text || "", maxRuntimeInfoCharacters)
        ready = event.ready === true
        canRecover = event.canRecover === true
        active = event.active === true
        if (restarting && (ready || statusKind === "error")) {
            restarting = false
            if (ready) postNotice("info", "Pi restarted")
        }
    }

    function handleExtensionStatus(event) {
        const key = String(event.key || "")
        const texts = statusTexts
        const chips = Array.isArray(event.chips) ? event.chips.slice(0, 18) : []
        if (chips.length > 0) {
            statusChips = chips
            delete texts[key]
        } else if (typeof event.text === "string" && event.text.length > 0) {
            texts[key] = { text: boundedText(event.text, maxRuntimeInfoCharacters), hint: boundedText(event.hint || "", maxErrorCharacters) }
        } else {
            delete texts[key]
            if (key === "git-footer-webui") statusChips = []
        }
        statusTexts = texts
        const entries = []
        const parts = []
        for (const name in texts) {
            // The header already shows the workspace; pi-extension-cd's "cwd …" status repeats it.
            if (texts[name].text.indexOf("cwd ") === 0) continue
            // The Git footer's plain TUI strings repeat its structured metrics when both are published.
            if (statusChips.length > 0 && name.indexOf("git-footer") === 0 && name !== "git-footer-webui") continue
            const label = statusLabel(name)
            const value = texts[name].text
            // "remote webui" + "Remote WebUI": keep the value only when it already names the extension.
            const shownLabel = value.toLowerCase().replace(/[^a-z0-9]+/g, "") === label.toLowerCase().replace(/[^a-z0-9]+/g, "") ? "" : label
            entries.push({ key: name, label: shownLabel, value: value, title: texts[name].hint, icon: "", tone: "" })
            parts.push((shownLabel.length > 0 ? shownLabel + " " : "") + value)
        }
        statusEntries = entries
        extensionStatusText = boundedText(parts.join(" · "), maxRuntimeInfoCharacters)
    }

    // "pi-remote-webui:controls" → "remote webui", "plan-mode" → "plan mode".
    function statusLabel(key) {
        let name = String(key || "")
        const colon = name.indexOf(":")
        if (colon > 0) name = name.slice(0, colon)
        name = name.replace(/^pi-(?:extension-|package-)?/, "").replace(/[-_]+/g, " ").trim()
        return boundedText(name, 32)
    }

    function handleRuntime(event) {
        const previousSessionFile = sessionFile
        currentProvider = boundedText(event.provider || "", maxRuntimeInfoCharacters)
        currentModelId = boundedText(event.modelId || "", maxRuntimeInfoCharacters)
        currentModelName = boundedText(event.modelName || "", maxRuntimeInfoCharacters)
        currentModelReasoning = event.modelReasoning === true
        currentThinkingLevel = boundedText(event.thinkingLevel || "", maxRuntimeInfoCharacters)
        // A fresh child's runtime cannot replace the tab's retained conversation while resuming.
        const currentTab = tabById(activeTabId)
        if (typeof event.sessionFile === "string" && event.sessionFile.length > 0
                && (!currentTab || !currentTab.sessionFile || currentTab.ready || currentTab.sessionFile === event.sessionFile)) {
            sessionName = boundedText(event.sessionName || "", maxRuntimeInfoCharacters)
            sessionFile = event.sessionFile
        }
        if (sessionFile !== previousSessionFile && sessionFile.length > 0) scheduleSessionCatalogRefresh()
        if (smokeMode && runtimeInfoText.length > 0) console.log("QT_WEBUI_SMOKE_RUNTIME_INFO")
    }

    function handlePartRender(event) {
        const blocksJson = Array.isArray(event.blocks) ? JSON.stringify(event.blocks) : "[]"
        const values = {
            "text": boundedText(event.text || ""),
            "blocksJson": blocksJson,
            "truncated": event.truncated === true,
            "streaming": event.final !== true
        }
        if (!setRow(event.partId, values)) {
            appendRow({
                rowId: event.partId, messageId: event.messageId, role: "assistant", kind: event.partKind,
                text: event.text, blocksJson: blocksJson, truncated: event.truncated, streaming: event.final !== true
            })
        }
    }

    function handleEvent(event) {
        eventReceived(event)
        if (event.type === "pi.started" || (event.type === "session.replaced" && !event.rebind)) {
            const generations = sessionGenerations
            generations[event.tab] = (generations[event.tab] || 0) + 1
            sessionGenerations = generations
        }
        if (event.type === "extension.answered" || event.type === "extension.cancelled") {
            finishDialog(String(event.requestId), String(event.tab || activeTabId))
            return
        }
        // Session events name their tab; only the active tab drives the view.
        if (typeof event.tab === "string" && event.tab !== activeTabId) {
            handleInactiveTabEvent(event)
            return
        }
        switch (event.type) {
        case "backend.ready":
            backendReady = true
            maxInboundFrameBytes = event.limits.maxInboundFrameBytes
            maxDialogValueCharacters = event.limits.maxDialogValueCharacters
            maxCatalogRows = event.limits.maxCatalogRows
            maxControlRequests = event.limits.maxControlRequests
            maxTextAttachmentBytes = event.limits.maxTextAttachmentBytes
            maxAttachmentReadCharacters = event.limits.maxAttachmentReadCharacters
            resetThemeGeneration()
            requestTimeouts = event.limits && event.limits.requestTimeoutMs ? event.limits.requestTimeoutMs : {}
            applyAppearance(event.appearance)
            backendStartupTimer.stop()
            request("hello", { attachmentMetadata: true }, response => {
                if (!response.ok) return
                applySettings(response.data.settings)
                applyAppearance(response.data.appearance)
                applyThemeState(response.data.themeState)
                if (Array.isArray(response.data.recentActions)) recentActions = response.data.recentActions
                if (response.data.tabs) {
                    if (response.data.selectionGeneration === selectionGeneration) tabs = response.data.tabs.tabs
                }
                applySnapshot({ tab: tabById(response.data.tabs.activeTab), selectionGeneration: response.data.selectionGeneration, session: response.data.session, attachments: response.data.attachments })
                refreshSessionCatalog()
            })
            backendBecameReady()
            break
        case "tabs.update":
            if (!Number.isInteger(event.selectionGeneration) || event.selectionGeneration < selectionGeneration) break
            selectionGeneration = event.selectionGeneration
            tabs = Array.isArray(event.tabs) ? event.tabs : []
            const liveTabs = tabs.map(tab => String(tab.id))
            const generations = Object.assign({}, sessionGenerations)
            for (const tab of Object.keys(generations)) if (liveTabs.indexOf(tab) === -1) delete generations[tab]
            sessionGenerations = generations
            const dialogs = Object.assign({}, dialogStates)
            for (const key of Object.keys(dialogs)) if (liveTabs.indexOf(dialogs[key].originTab) === -1) delete dialogs[key]
            dialogStates = dialogs
            const selectionChanged = typeof event.activeTab === "string" && event.activeTab !== activeTabId
            if (selectionChanged) beginTabSwitch(event.activeTab)
            applyTabSummary(tabById(activeTabId), !selectionChanged)
            break
        case "sessions.changed":
            scheduleSessionCatalogRefresh()
            break
        case "transcript.reset":
            if (event.selectionGeneration !== selectionGeneration) break
            transcript.clear()
            transcriptRevision++
            break
        case "transcript.row":
            if (event.selectionGeneration !== selectionGeneration) break
            if (event.row && typeof event.row === "object") appendRow(event.row)
            break
        case "backend.closing":
            break
        case "backend.fatal":
            showError("Backend failure: " + String(event.message || "unknown"))
            break
        case "pi.status":
            handleStatus(event)
            break
        case "pi.error":
            if (typeof event.message === "string" && event.message.length > 0) showError(event.message)
            else visibleError = ""
            break
        case "session.replaced":
            if (event.rebind) break
            sessionReplacing()
            sessionName = ""
            sessionFile = String(event.sessionFile || "")
            sessionReplaced()
            break
        case "pi.runtime":
            handleRuntime(event)
            break
        case "pi.started":
            visibleError = ""
            resourceState = null
            resourceActionPending = false
            resourceLoading = false
            commands = []
            commandsLoaded = false
            break
        case "pi.exit":
            modelActionPending = false
            resourceActionPending = false
            resourceLoading = false
            resourceState = null
            compacting = false
            commands = []
            commandsLoaded = false
            clearDialogs(activeDialog || dialogQueue.length > 0 ? "Pending extension dialogs were cancelled because Pi exited" : "")
            steeringQueue = []
            followUpQueue = []
            extensionStatusText = ""
            statusChips = []
            statusEntries = []
            statusTexts = ({})
            break
        case "message.user":
            appendRow({ rowId: "user-" + event.messageId, messageId: event.messageId, role: "user", kind: "user", text: event.text,
                        modeLabel: event.mode === "steer" ? "Steering" : event.mode === "followUp" ? "Follow-up" : "",
                        attachments: Array.isArray(event.attachments) ? event.attachments.map(name => String(name)).join(", ") : "" })
            break
        case "message.begin":
            break
        case "part.begin":
            appendRow({ rowId: event.partId, messageId: event.messageId, role: "assistant", kind: event.partKind, text: "", streaming: true })
            break
        case "part.render":
            handlePartRender(event)
            break
        case "part.remove": {
            const index = rowIndexById(event.partId)
            if (index >= 0) { transcript.remove(index); transcriptRevision++ }
            break
        }
        case "message.end":
            if (event.truncatedParts > 0) postNotice("warning", event.truncatedParts + " message parts were omitted to stay within limits")
            break
        case "tool.start":
            appendRow({ rowId: "tool-" + event.toolCallId, messageId: event.messageId, role: "assistant", kind: "tool",
                        toolName: event.name, toolSummary: event.summary, toolStatus: "running" })
            break
        case "tool.update":
            setRow("tool-" + event.toolCallId, { "toolOutput": boundedText(event.output || "", 4096) })
            break
        case "tool.end":
            if (!setRow("tool-" + event.toolCallId, {
                    "toolStatus": event.ok ? "ok" : "error",
                    "toolDurationMs": Number(event.durationMs) || 0,
                    "toolOutput": boundedText(event.output || "", 4096),
                    "toolError": boundedText(event.error || "", maxErrorCharacters),
                    "toolName": event.name || ""
                })) {
                appendRow({ rowId: "tool-" + event.toolCallId, role: "assistant", kind: "tool", toolName: event.name,
                            toolStatus: event.ok ? "ok" : "error", toolDurationMs: Number(event.durationMs) || 0,
                            toolOutput: event.output, toolError: event.error })
            }
            break
        case "run.start":
            runStarted()
            break
        case "run.end":
            runEnded(event.ok === true, event.aborted === true)
            usageTimer.restart()
            scheduleSessionCatalogRefresh()
            if (event.aborted) notifyDesktop("Pi stopped", "The run was aborted")
            else if (event.ok) notifyDesktop("Pi finished", sessionName.length > 0 ? sessionName : workspaceCwd)
            else notifyDesktop("Pi failed", visibleError)
            break
        case "extension.request":
            enqueueDialog(event, true)
            presentNextDialog()
            break
        case "extension.notify":
            postNotice(String(event.level || "info"), String(event.message || ""))
            if (smokeMode && typeof event.message === "string" && event.message.indexOf("QT_WEBUI_SMOKE_") === 0) console.log(event.message)
            break
        case "extension.status":
            handleExtensionStatus(event)
            break
        case "composer.setText":
            composerTextRequested(String(event.text || ""))
            break
        case "window.title":
            windowTitle = typeof event.title === "string" && event.title.length > 0 ? boundedText(event.title, 120) : "Qt WebUI"
            break
        case "queue.update":
            steeringQueue = Array.isArray(event.steering) ? event.steering : []
            followUpQueue = Array.isArray(event.followUp) ? event.followUp : []
            break
        case "notice":
            postNotice(String(event.level || "info"), String(event.message || ""))
            if (smokeMode && /invalid Pi RPC record/i.test(String(event.message))) console.log("QT_WEBUI_SMOKE_PARSE_RECOVERED")
            break
        case "events.dropped":
            droppedEvents += Number(event.count) || 0
            postNotice("warning", (Number(event.count) || 0) + " backend events were dropped while the window was busy")
            break
        case "settings.changed":
            applySettings(event.settings)
            break
        case "appearance.changed":
            applyAppearance(event)
            break
        case "themes.changed":
            applyThemeState(event.state)
            break
        case "resources.changed":
            applyResourceState(event.state)
            break
        default:
            break
        }
    }

    function handleFrame(frame) {
        if (!frame || typeof frame !== "object") return
        if (frame.v !== protocolVersion) {
            showError("Backend protocol version mismatch: " + String(frame.v))
            return
        }
        if (frame.kind === "response") {
            if (!settlePending(String(frame.id), frame)) staleResponses++
            return
        }
        if (frame.kind === "event" && typeof frame.type === "string") handleEvent(frame)
    }

    function handleLine(data) {
        let line = typeof data === "string" ? data : String(data)
        if (line.endsWith("\r")) line = line.slice(0, -1)
        if (line.length === 0) return
        try {
            handleFrame(JSON.parse(line))
        } catch (error) {
            showError("Invalid backend record: " + error)
        }
    }

    // ---- backend lifecycle ---------------------------------------------------------------

    function startBackend() {
        if (backendProcess.running) return
        backendReady = false
        ready = false
        canRecover = false
        active = false
        visibleError = ""
        statusKind = "stopped"
        statusText = "Starting…"
        backendProcess.running = true
    }

    function shutdown() {
        quitting = true
        if (backendProcess.running) request("shutdown", {}, () => {})
        shutdownTimer.start()
    }

    // Usage statistics are re-read shortly after a run ends or a tab is shown.
    Timer {
        id: usageTimer
        interval: 250
        repeat: false
        onTriggered: bridge.loadSessionStats()
    }

    // Coalesce session-file, run, and settlement events so a burst produces one paged pass.
    Timer {
        id: sessionCatalogRefreshTimer
        interval: 500
        repeat: false
        onTriggered: bridge.refreshSessionCatalog()
    }

    Timer {
        id: pendingSweepTimer
        interval: 500
        repeat: true
        onTriggered: bridge.sweepPending()
    }

    Timer {
        id: backendStartupTimer
        interval: bridge.backendStartupMs
        repeat: false
        onTriggered: if (!bridge.backendReady && backendProcess.running) bridge.showError("Backend did not report readiness in time")
    }

    Timer {
        id: shutdownTimer
        interval: 1500
        repeat: false
        onTriggered: {
            backendProcess.running = false
            Qt.quit()
        }
    }

    Process {
        id: backendProcess
        command: [
            String(Quickshell.env("QT_WEBUI_NODE_EXECUTABLE") || ""),
            String(Quickshell.env("QT_WEBUI_BACKEND_ENTRY") || "")
        ]
        workingDirectory: bridge.callerCwd
        stdinEnabled: true
        running: true

        stdout: SplitParser {
            splitMarker: "\n"
            onRead: data => bridge.handleLine(data)
        }

        stderr: SplitParser {
            splitMarker: "\n"
            onRead: data => {
                if (String(data).trim().length > 0) bridge.postNotice("error", "Backend: " + String(data))
            }
        }

        onStarted: {
            bridge.selectionGeneration = 0
            bridge.backendGeneration++
            bridge.sessionGenerations = ({})
            bridge.dialogStates = ({})
            bridge.backendReady = false
            bridge.ready = false
            bridge.canRecover = false
            bridge.active = false
            bridge.statusKind = "stopped"
            bridge.statusText = "Starting…"
            backendStartupTimer.start()
        }

        onExited: (exitCode, exitStatus) => {
            backendStartupTimer.stop()
            if (bridge.quitting) {
                bridge.failAllPending("not_running", "Backend exited")
                Qt.quit()
                return
            }
            bridge.backendReady = false
            bridge.ready = false
            bridge.canRecover = false
            bridge.active = false
            bridge.backendExitCode = exitCode
            bridge.restarting = false
            bridge.statusChips = []
            bridge.currentProvider = ""
            bridge.currentModelId = ""
            bridge.currentModelName = ""
            bridge.currentModelReasoning = false
            bridge.currentThinkingLevel = ""
            bridge.modelActionPending = false
            bridge.resourceActionPending = false
            bridge.resourceLoading = false
            bridge.resourceState = null
            bridge.compacting = false
            bridge.attachments = []
            bridge.commands = []
            bridge.commandsLoaded = false
            bridge.tabs = []
            bridge.activeTabId = ""
            bridge.usage = null
            bridge.sessionCatalogGeneration++
            // Keep the last complete catalog until the replacement backend finishes a scan.
            bridge.sessionCatalogLoading = false
            bridge.sessionCatalogError = ""
            bridge.sessionSettlementPending = ({})
            bridge.sessionSettleAllPending = false
            bridge.sessionSettleDaysPending = false
            bridge.failAllPending("not_running", "Backend exited")
            bridge.clearDialogs(bridge.activeDialog || bridge.dialogQueue.length > 0 ? "Pending extension dialogs were cancelled because the backend exited" : "")
            bridge.statusKind = "error"
            bridge.statusText = "Backend exited (" + exitCode + ")"
            bridge.visibleError = bridge.boundedError("The Qt WebUI backend exited with code " + exitCode + ". Use Restart to start it again.")
            bridge.backendExited(exitCode)
        }
    }
}
