import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtQuick.Layouts
import Quickshell
import "components"
import "dialogs"

ShellRoot {
    id: root

    readonly property bool smokeMode: Quickshell.env("QT_WEBUI_SMOKE_MODE") === "1"
    readonly property bool themeDark: appTheme.dark
    readonly property int themeAnimationDuration: appTheme.animationDuration
    readonly property color themeAccent: appTheme.accent
    readonly property bool externalThemeEffective: appTheme.externalPalette !== null
    readonly property var backendBridge: bridge
    readonly property bool hasActiveSession: bridge.activeTabId.length > 0
    readonly property var extensionDialog: extensionDialogItem
    readonly property bool linkDialogOpened: linkDialogItem.opened
    readonly property var pickerDialog: pickerDialogItem
    readonly property var modelDropUp: modelDropUpItem
    readonly property var thinkingDropUp: thinkingDropUpItem
    readonly property var statusOverlay: statusOverlayItem
    readonly property var composerItem: composer
    readonly property var sequencesDialog: sequencesDialogItem
    readonly property var attachmentEditor: attachmentEditorItem
    readonly property var directoryDialog: directoryDialogItem
    readonly property var confirmDialog: confirmDialogItem
    readonly property var inputDialog: inputDialogItem
    readonly property var worktreeDialog: worktreeDialogItem
    readonly property var eventsDialog: eventsDialogItem
    readonly property var diagnosticsDialog: diagnosticsDialogItem
    readonly property var resourceProfilesDialog: resourceProfilesDialogItem
    readonly property var sessionListItem: sessionListItem
    readonly property var noticeBarItem: noticeBar
    property var paletteModels: []
    property var paletteSessions: []
    property string draftKeyInUse: ""
    property string draftOwnerInUse: ""
    property int draftEditRevision: 0
    property string pickerKind: ""
    property int composerPickerGeneration: 0
    property int modelPickerGeneration: -1
    property int thinkingPickerGeneration: -1
    property string modelPickerTabId: ""
    property string thinkingPickerTabId: ""
    property bool modelPickerLoading: false
    property bool thinkingPickerLoading: false
    property bool themePickerLoading: false
    property bool changingDraft: false
    property int draftRestoreGeneration: 0
    property var draftRecords: ({})
    property string pendingPathQuery: ""
    property int pendingPathGeneration: 0
    property bool searchOpen: false
    property string searchQuery: ""
    property var searchMatches: []
    property int searchIndex: -1
    readonly property int searchMatchCount: searchMatches.length
    property int searchAnchorIndex: -1
    readonly property string searchSelectedId: searchIndex >= 0 && searchIndex < searchMatches.length ? searchMatches[searchIndex] : ""
    readonly property int searchCurrentRow: {
        const revision = bridge.transcriptRevision
        const index = bridge.rowIndexById(searchSelectedId)
        return revision >= 0 && index >= 0 && searchQuery.trim().length > 0
            && rowSearchText(bridge.transcriptModel.get(index)).toLowerCase().indexOf(searchQuery.trim().toLowerCase()) !== -1 ? index : -1
    }
    onSearchCurrentRowChanged: if (searchCurrentRow >= 0) searchAnchorIndex = searchCurrentRow
    readonly property int workspaceRailMinimumWidth: 200
    readonly property int workspaceMinimumWidth: composer.implicitMinimumWidth + (contentRoot.width <= 640 ? 20 : 36) + 2 * appTheme.borderWidth
    readonly property int workspaceRailMaximumWidth: Math.max(workspaceRailMinimumWidth, contentRoot.width - workspaceMinimumWidth)
    property bool workspaceRailCollapsed: false
    readonly property bool workspaceRailVisible: !workspaceRailCollapsed && contentRoot.width >= workspaceRailMinimumWidth + workspaceMinimumWidth
    property real workspaceRailRequestedWidth: 0

    // Metrics keep the publisher's sections inside the on-demand status overlay.
    readonly property var statusGroups: groupStatusChips(bridge.statusChips, bridge.statusEntries, bridge.usage)
    readonly property int statusEntryCount: {
        let count = 0
        for (const group of statusGroups) count += group.entries.length
        return count
    }

    signal linkOpenResult(string url, var response)

    function formatCount(value) {
        const number = Number(value) || 0
        if (number >= 1000000) return (number / 1000000).toFixed(1) + "M"
        if (number >= 1000) return Math.round(number / 1000) + "k"
        return String(number)
    }

    function clampWorkspaceRailWidth(width) {
        return Math.min(workspaceRailMaximumWidth, Math.max(workspaceRailMinimumWidth, width))
    }

    function toggleWorkspaceRail() {
        workspaceRailCollapsed = !workspaceRailCollapsed
    }

    function smokeGeometryItems() {
        if (!smokeMode) return null
        return { window: window, frame: contentRoot, rail: workspaceRail, abort: composer.runActionButton,
            sessions: recoverySessionsButton, newSession: recoveryNewSessionButton }
    }

    function setWorkspaceRailWidth(width) {
        workspaceRailRequestedWidth = clampWorkspaceRailWidth(width)
    }

    function shiftWorkspaceRailWidth(delta) {
        setWorkspaceRailWidth(workspaceRail.width + delta)
    }

    function groupStatusChips(chips, entries, usage) {
        const groups = []
        const byName = {}
        const add = (name, entry) => {
            if (!byName[name]) {
                byName[name] = { name: name, entries: [] }
                groups.push(byName[name])
            }
            byName[name].entries.push(entry)
        }
        // Usage from Pi's own statistics: context fill, token totals, and cost for this session.
        if (usage) {
            if (usage.context && usage.context.percent !== null) add("Usage", { key: "context", label: "context", value: Math.round(usage.context.percent) + "%", title: formatCount(usage.context.tokens) + " of " + formatCount(usage.context.contextWindow) + " tokens in the context window", icon: "", tone: usage.context.percent >= 90 ? "error" : usage.context.percent >= 75 ? "warning" : "" })
            else if (usage.context) add("Usage", { key: "context", label: "context", value: "—", title: "Context usage is unknown until the next answer", icon: "", tone: "" })
            add("Usage", { key: "tokens", label: "tokens", value: formatCount(usage.tokens.total), title: "input " + formatCount(usage.tokens.input) + ", output " + formatCount(usage.tokens.output) + ", cache read " + formatCount(usage.tokens.cacheRead) + ", cache write " + formatCount(usage.tokens.cacheWrite), icon: "", tone: "" })
            add("Usage", { key: "cost", label: "cost", value: "$" + Number(usage.cost).toFixed(usage.cost >= 10 ? 0 : 2), title: usage.totalMessages + " messages, " + usage.toolCalls + " tool calls", icon: "", tone: "" })
        }
        for (const chip of chips) add(chip.group === "meta" ? "Git" : "Session", chip)
        for (const entry of entries) add("Extensions", entry)
        return groups
    }

    // ---- command palette --------------------------------------------------------------------

    function paletteActions() {
        return [
            ["new-tab", "New tab in this folder", "Ctrl+N"], ["open-folder", "Open a folder in a new tab", "Ctrl+O"], ["close-tab", "Close this tab", "Ctrl+W"], ["rename-tab", "Rename this tab", "F2"],
            ["resume-session", "Resume a saved session", "Ctrl+Shift+O"], ["new-session", "Start a new session", "Ctrl+Shift+N"], ["worktree", "Create a Git worktree", "Ctrl+Shift+B"],
            ["attach", "Attach files", "Ctrl+Shift+A"], ["sequences", "Saved prompt sequences", "Ctrl+Shift+S"], ["search", "Search the transcript", "Ctrl+F"],
            ["toggle-thinking", (bridge.showThinking ? "Hide" : "Show") + " thinking sections", "Ctrl+T"],
            ["toggle-highlighting", bridge.syntaxHighlighting ? "Turn off syntax highlighting" : "Turn on syntax highlighting", ""], ["toggle-notifications", bridge.desktopNotifications ? "Turn off desktop notifications" : "Turn on desktop notifications", ""],
            ["choose-theme", "Theme: " + root.themeSelectionLabel(), ""], ["cycle-appearance", "Appearance: " + root.appearanceModeLabel(), ""], ["toggle-reduced-motion", bridge.reducedMotion ? "Use standard motion" : "Reduce motion", ""],
            ["session-settle-days", "Automatic settlement: " + bridge.sessionSettleDays + " days", ""],
            ["choose-model", "Choose a model", "Ctrl+M"], ["cycle-model", "Cycle to the next model", "Ctrl+Shift+P"], ["choose-thinking", "Choose the thinking effort", "Ctrl+E"], ["cycle-thinking", "Cycle the thinking effort", "Ctrl+Shift+E"],
            ["resource-profiles", "Configure tools, skills, and sampling", "Ctrl+Shift+R"], ["compact-context", "Compact the conversation context", ""], ["abort", "Abort the current run", "Ctrl+Shift+X"], ["restart", "Restart Pi in this tab", ""],
            ["events", "Show events", "Ctrl+Shift+L"], ["diagnostics", "Show diagnostics", "Ctrl+Shift+D"], ["focus-prompt", "Focus the prompt", "Ctrl+L"],
        ]
    }

    // Grouped, stably ordered: recent actions first, then actions, tabs, models, sessions, and
    // Pi commands. Capability-dependent groups are reloaded every time the palette opens.
    function paletteItems() {
        const recents = bridge.recentActions
        const items = []
        const push = (group, value, label, detail) => items.push({ group: group, value: value, label: label, detail: detail, current: false })
        const actions = paletteActions()
        const byRecency = key => { const index = recents.indexOf(key); return index === -1 ? recents.length : index }
        const sorted = actions.slice().sort((a, b) => byRecency("action:" + a[0]) - byRecency("action:" + b[0]))
        for (const action of sorted) push(recents.indexOf("action:" + action[0]) !== -1 ? "Recent" : "Action", "action:" + action[0], action[1], action[2])
        for (const tab of bridge.tabs) push("Tab", "tab:" + tab.id, "Switch to " + bridge.tabLabel(tab), tab.id === bridge.activeTabId ? "current tab" : String(tab.cwd))
        for (const model of paletteModels) push("Model", "model:" + model.provider + "/" + model.id, "Use " + (model.name.length > 0 ? model.name : model.id), model.provider + "/" + model.id + (model.provider === bridge.currentProvider && model.id === bridge.currentModelId ? " · current" : ""))
        for (const session of paletteSessions) push("Session", "session:" + session.path, "Resume " + (session.name && session.name.length > 0 ? session.name : session.firstMessage && session.firstMessage.length > 0 ? session.firstMessage : session.id), ageLabel(session.ageMs) + " · " + session.messageCount + " messages")
        for (const command of bridge.commands) {
            push("Pi command", "command:" + command.name, "/" + command.name, command.description)
            if (command.source === "skill" && command.path.length > 0) push("Skill", "skill:" + command.path, "Open skill file " + command.name.replace(/^skill:/, ""), command.path)
        }
        return items
    }

    function themeIdentityMatches(first, second) {
        return first && second && first.kind === second.kind && first.name === second.name
    }

    function themeIdentityLabel(identity) {
        if (!identity || typeof identity !== "object") return "Unknown"
        for (const entry of bridge.themeState.inventory) {
            if (themeIdentityMatches(entry.identity, identity)) return String(entry.label)
        }
        if (identity.kind === "builtin") return identity.name === "automatic" ? "Automatic" : identity.name === "light" ? "Light" : "Dark"
        return String(identity.name || "Unknown")
    }

    function themeSelectionLabel() {
        return themeIdentityLabel(bridge.themeState.requested)
    }

    function themeStatusMessage() {
        const requested = themeIdentityLabel(bridge.themeState.requested)
        const effective = themeIdentityLabel(bridge.themeState.effective)
        if (bridge.themeState.fallbackReason.length > 0) {
            return "Requested theme " + requested + " is unavailable. Using " + effective + ". Qt WebUI will retry the saved choice when it returns."
        }
        return "Current theme: " + effective + "."
    }

    function themeItems() {
        const items = []
        for (const entry of bridge.themeState.inventory) {
            const identity = entry.identity
            items.push({
                value: JSON.stringify({ kind: identity.kind, name: identity.name }),
                label: String(entry.label),
                detail: identity.kind === "builtin" ? "Qt WebUI built-in" : "Pi JSON theme",
                current: themeIdentityMatches(identity, bridge.themeState.requested)
            })
        }
        return items
    }

    function openThemePicker() {
        if (!bridge.backendReady || themePickerLoading || pickerDialogItem.opened) return false
        themePickerLoading = true
        const requestId = bridge.listThemes(response => {
            themePickerLoading = false
            if (!response.ok || pickerDialogItem.opened) return
            root.pickerKind = "theme"
            pickerDialogItem.present({ title: "Choose a theme", message: root.themeStatusMessage(), items: root.themeItems(), searchable: true, emptyText: "No themes are available" })
        })
        if (!requestId) themePickerLoading = false
        return requestId.length > 0
    }

    function appearanceModeLabel() {
        if (bridge.appearanceMode === "light") return "Light"
        if (bridge.appearanceMode === "dark") return "Dark"
        return "Automatic"
    }

    function cycleAppearanceMode() {
        const modes = ["automatic", "light", "dark"]
        const current = modes.indexOf(bridge.appearanceMode)
        bridge.updateSetting("appearanceMode", modes[(current + 1) % modes.length])
        return true
    }

    function sessionSettleDaysProblem(text) {
        const value = String(text || "").trim()
        if (value.length === 0) return "Enter a number of days"
        if (!/^[0-9]+$/.test(value)) return "Enter a whole number from 1 to 3,650"
        const days = Number(value)
        if (!Number.isInteger(days) || days < 1 || days > 3650) return "Enter a whole number from 1 to 3,650"
        return ""
    }

    function openSessionSettleDays() {
        if (!bridge.backendReady || bridge.sessionSettleDaysPending || inputDialogItem.opened) return false
        inputDialogItem.present({
            title: "Automatic session settlement",
            message: "Closed inactive sessions move to Settled after this many days. Lowering the value may settle closed inactive sessions when the catalog refreshes.",
            placeholder: "Days (1–3,650)", prefill: String(bridge.sessionSettleDays), submitLabel: "Save",
            maxCharacters: 4, validate: text => root.sessionSettleDaysProblem(text),
            context: { action: "session-settle-days", previousDays: bridge.sessionSettleDays }
        })
        return true
    }

    function openPalette() {
        if (pickerDialogItem.opened) return false
        root.pickerKind = "palette"
        pickerDialogItem.present({ title: "Command palette", message: "", items: paletteItems(), searchable: true, emptyText: "Nothing matches" })
        // Refresh the capability-dependent groups; the list updates in place while it is open.
        if (bridge.ready) {
            bridge.loadModels(response => { if (response.ok) { paletteModels = response.data.models; refreshPalette() } })
            bridge.listSessions(response => { if (response.ok) { paletteSessions = response.data.sessions.slice(0, 10); refreshPalette() } })
            if (!bridge.commandsLoaded) bridge.loadCommands(() => refreshPalette())
        }
        return true
    }

    function refreshPalette() {
        if (pickerDialogItem.opened && root.pickerKind === "palette") pickerDialogItem.items = paletteItems()
    }

    function runPaletteAction(key) {
        switch (key) {
        case "new-tab": return bridge.openTab("", "")
        case "open-folder": return root.openDirectoryPicker()
        case "close-tab": return root.closeTab(bridge.activeTabId)
        case "rename-tab": return root.renameActiveTab()
        case "resume-session": return root.openSessionsPicker()
        case "new-session": return root.newSessionInTab()
        case "worktree": return root.planWorktree()
        case "attach": if (bridge.ready) fileDialog.open(); return true
        case "sequences": return root.openSequences()
        case "search": root.openSearch(); return true
        case "toggle-thinking": bridge.updateSetting("showThinking", !bridge.showThinking); return true
        case "toggle-highlighting": bridge.updateSetting("syntaxHighlighting", !bridge.syntaxHighlighting); return true
        case "toggle-notifications": bridge.updateSetting("desktopNotifications", !bridge.desktopNotifications); return true
        case "choose-theme": return root.openThemePicker()
        case "cycle-appearance": return root.cycleAppearanceMode()
        case "toggle-reduced-motion": bridge.updateSetting("reducedMotion", !bridge.reducedMotion); return true
        case "session-settle-days": return root.openSessionSettleDays()
        case "choose-model": return root.openModelPicker()
        case "cycle-model": return bridge.cycleModel()
        case "choose-thinking": return root.openThinkingPicker()
        case "cycle-thinking": return bridge.cycleThinkingLevel()
        case "resource-profiles": return root.openResourceProfiles()
        case "compact-context": return root.compactContext()
        case "abort": return bridge.abortRun()
        case "restart": return bridge.restartProcess()
        case "events": return root.openEvents()
        case "diagnostics": return root.openDiagnostics()
        case "focus-prompt": composer.focusEditor(); return true
        default: return false
        }
    }

    // Palette values are typed by prefix; a Pi command is inserted into the prompt, never sent.
    function palettePicked(value) {
        const colon = value.indexOf(":")
        const kind = colon > 0 ? value.slice(0, colon) : ""
        const payload = colon > 0 ? value.slice(colon + 1) : ""
        if (kind === "action") {
            bridge.recordAction(value)
            paletteActionTimer.action = payload
            paletteActionTimer.start()
        } else if (kind === "tab") {
            bridge.selectTab(payload)
        } else if (kind === "model") {
            const slash = payload.indexOf("/")
            if (slash > 0) bridge.selectModel(payload.slice(0, slash), payload.slice(slash + 1))
        } else if (kind === "session") {
            bridge.switchSession(payload)
        } else if (kind === "command") {
            bridge.recordAction(value)
            composer.setText("/" + payload + " ")
        } else if (kind === "skill") {
            confirmDialogItem.present({ title: "Open skill file?", message: "The file opens in your default application.", detail: payload, confirmLabel: "Open file", destructive: false, context: { action: "open-path", path: payload } })
        }
    }

    function openEvents() {
        if (eventsDialogItem.opened) return false
        eventsDialogItem.present()
        return true
    }

    function openDiagnostics() {
        if (diagnosticsDialogItem.opened) return false
        diagnosticsDialogItem.present()
        return true
    }

    function openResourceProfiles() {
        if (!bridge.ready || bridge.active || bridge.modelActionPending || bridge.resourceActionPending || resourceProfilesDialogItem.opened) return false
        resourceProfilesDialogItem.present()
        return true
    }

    Theme {
        id: appTheme
        requestedMode: bridge.appearanceMode
        portalMode: bridge.portalColorScheme
        themeState: bridge.themeState
        reducedMotion: bridge.reducedMotion
        desktopCornerRadius: bridge.desktopCornerRadius
        desktopEdgeGap: bridge.desktopEdgeGap
    }

    BackendBridge {
        id: bridge
        windowActive: root.smokeMode && smokeLoader.item && smokeLoader.item.forceUnfocused ? false : contentRoot.Window.active
        onComposerTextRequested: text => composer.setText(text)
        onNoticePosted: (level, message) => noticeBar.show(level, message)
        onDialogRequested: dialog => extensionDialogItem.present(dialog)
        onDialogFinished: requestId => {
            if (extensionDialogItem.opened && extensionDialogItem.requestId === requestId) {
                extensionDialogItem.finish()
            }
        }
        onDialogStateChanged: (requestId, state, message) => {
            if (extensionDialogItem.requestId === requestId) extensionDialogItem.settle(state, message)
        }
        onTranscriptRevisionChanged: {
            if (root.searchOpen && !searchRefreshTimer.running) {
                searchRefreshTimer.ownerGeneration = bridge.selectionGeneration
                searchRefreshTimer.start()
            }
        }
    }

    Timer {
        id: searchRefreshTimer
        property int ownerGeneration: 0
        interval: 60
        repeat: false
        onTriggered: if (ownerGeneration === bridge.selectionGeneration && root.searchOpen) root.runSearch()
    }

    // ---- search ---------------------------------------------------------------------------

    function rowSearchText(row) {
        if (row.kind === "tool") return row.toolName + "\n" + row.toolSummary + "\n" + row.toolOutput + "\n" + row.toolError
        return row.text
    }

    function runSearch() {
        const query = searchQuery.trim().toLowerCase()
        if (query.length === 0) {
            searchMatches = []
            searchIndex = -1
            return
        }
        const selected = searchSelectedId
        const anchor = searchAnchorIndex
        const matches = []
        for (let index = 0; index < bridge.transcriptModel.count; index++) {
            const row = bridge.transcriptModel.get(index)
            if (rowSearchText(row).toLowerCase().indexOf(query) !== -1) matches.push(String(row.rowId))
        }
        let next = matches.indexOf(selected)
        if (next < 0 && selected.length > 0) next = matches.findIndex(id => bridge.rowIndexById(id) >= anchor)
        if (next < 0 && matches.length > 0) next = matches.length - 1
        searchMatches = matches
        searchIndex = next
        revealSearchRow()
    }

    function revealSearchRow() {
        if (searchCurrentRow >= 0) {
            transcriptList.followOutput = false
            transcriptList.positionViewAtIndex(searchCurrentRow, ListView.Center)
        }
    }

    function openSearch(query) {
        searchOpen = true
        if (typeof query === "string") searchBar.query = query
        searchQuery = searchBar.query
        runSearch()
        searchBar.focusField()
    }

    function closeSearch() {
        searchRefreshTimer.stop()
        searchAnchorIndex = -1
        searchOpen = false
        searchQuery = ""
        searchMatches = []
        searchIndex = -1
        composer.focusEditor()
    }

    function searchNext() {
        if (searchMatches.length === 0) return
        searchIndex = (searchIndex + 1) % searchMatches.length
        revealSearchRow()
    }

    function searchPrevious() {
        if (searchMatches.length === 0) return
        searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length
        revealSearchRow()
    }

    // ---- models, thinking, and compaction ------------------------------------------------

    function composerPickerOpen() {
        return pickerDialogItem.opened || composerMenuDropUpItem.opened || modelDropUpItem.opened || thinkingDropUpItem.opened || modelPickerLoading || thinkingPickerLoading
    }

    function invalidateComposerPickers() {
        composerPickerGeneration++
        modelPickerLoading = false
        thinkingPickerLoading = false
        modelPickerGeneration = -1
        thinkingPickerGeneration = -1
        modelPickerTabId = ""
        thinkingPickerTabId = ""
        if (composerMenuDropUpItem.opened) composerMenuDropUpItem.close()
        if (modelDropUpItem.opened) modelDropUpItem.close()
        if (thinkingDropUpItem.opened) thinkingDropUpItem.close()
    }

    function composerMenuItems() {
        return [
            { value: "resource-profiles", label: "Resources", detail: "Tools, skills, and sampling · Ctrl+Shift+R", current: false },
            { value: "sequences", label: "Sequences", detail: "Saved prompt sequences · Ctrl+Shift+S", current: false },
            { value: "toggle-thinking", label: (bridge.showThinking ? "Hide" : "Show") + " thinking sections", detail: "Ctrl+T", current: false },
            { value: "toggle-highlighting", label: (bridge.syntaxHighlighting ? "Turn off" : "Turn on") + " syntax highlighting", detail: "Code blocks", current: false },
            { value: "toggle-notifications", label: (bridge.desktopNotifications ? "Turn off" : "Turn on") + " desktop notifications", detail: "Background runs and input requests", current: false },
            { value: "choose-theme", label: "Theme", detail: root.themeSelectionLabel(), current: false },
            { value: "cycle-appearance", label: "Appearance", detail: root.appearanceModeLabel(), current: false },
            { value: "toggle-reduced-motion", label: bridge.reducedMotion ? "Use standard motion" : "Reduce motion", detail: bridge.reducedMotion ? "Reduced motion is on" : "Reduced motion is off", current: false },
            { value: "session-settle-days", label: "Automatic settlement", detail: bridge.sessionSettleDays + " days", current: false },
            { value: "events", label: "Events", detail: "Recent notices · Ctrl+Shift+L", current: false },
            { value: "diagnostics", label: "Diagnostics", detail: "Runtime report · Ctrl+Shift+D", current: false },
        ]
    }

    function openComposerMenu() {
        if (!bridge.ready || bridge.active || bridge.modelActionPending || bridge.resourceActionPending || bridge.resourceLoading || composerPickerOpen()) return false
        composerMenuDropUpItem.present({ title: "More options", message: "", items: composerMenuItems(), searchable: false })
        return true
    }

    function composerMenuPicked(value) {
        Qt.callLater(() => {
            if (root.runPaletteAction(value)) bridge.recordAction("action:" + value)
        })
    }

    function modelPickerResult(originTab, generation, response) {
        if (generation !== composerPickerGeneration || generation !== modelPickerGeneration || originTab !== modelPickerTabId) return false
        modelPickerLoading = false
        if (!response.ok) {
            modelPickerGeneration = -1
            modelPickerTabId = ""
            return false
        }
        const items = []
        for (const model of response.data.models) {
            const identity = model.provider + "/" + model.id
            const traits = [model.reasoning ? "thinking" : "no thinking", model.acceptsImages ? "images" : "", model.contextWindow > 0 ? Math.round(model.contextWindow / 1000) + "k context" : ""]
            items.push({ value: identity, label: model.name.length > 0 ? model.name + "  ·  " + identity : identity,
                         detail: traits.filter(trait => trait.length > 0).join(" · "),
                         current: model.provider === bridge.currentProvider && model.id === bridge.currentModelId })
        }
        if (!bridge.ready || bridge.active || bridge.activeTabId !== originTab || generation !== composerPickerGeneration
                || generation !== modelPickerGeneration || originTab !== modelPickerTabId || pickerDialogItem.opened || composerMenuDropUpItem.opened || thinkingDropUpItem.opened) {
            modelPickerGeneration = -1
            modelPickerTabId = ""
            return false
        }
        const reorderable = response.data.scope && response.data.scope.explicit === true && items.length >= 2
        modelDropUpItem.present({ title: "Choose a model", message: response.data.omitted > 0 ? response.data.omitted + " configured models are not listed" : "", items: items, searchable: true, reorderable: reorderable, emptyText: "Pi reports no configured models" })
        return true
    }

    function thinkingPickerResult(originTab, generation, response) {
        if (generation !== composerPickerGeneration || generation !== thinkingPickerGeneration || originTab !== thinkingPickerTabId) return false
        thinkingPickerLoading = false
        if (!response.ok) {
            thinkingPickerGeneration = -1
            thinkingPickerTabId = ""
            return false
        }
        const items = []
        for (const level of response.data.levels) items.push({ value: level, label: level, detail: "", current: level === bridge.currentThinkingLevel })
        if (!bridge.ready || bridge.active || bridge.activeTabId !== originTab || generation !== composerPickerGeneration
                || generation !== thinkingPickerGeneration || originTab !== thinkingPickerTabId || pickerDialogItem.opened || composerMenuDropUpItem.opened || modelDropUpItem.opened) {
            thinkingPickerGeneration = -1
            thinkingPickerTabId = ""
            return false
        }
        thinkingDropUpItem.present({ title: "Thinking effort", message: response.data.levels.length <= 1 ? "The current model has no thinking levels" : "", items: items, searchable: false })
        return true
    }

    function openModelPicker() {
        if (!bridge.ready || bridge.active || bridge.modelActionPending || bridge.resourceActionPending || composerPickerOpen()) return false
        const originTab = bridge.activeTabId
        const generation = ++composerPickerGeneration
        modelPickerGeneration = generation
        modelPickerTabId = originTab
        modelPickerLoading = true
        const requested = bridge.loadModels(response => root.modelPickerResult(originTab, generation, response))
        if (!requested && generation === composerPickerGeneration && generation === modelPickerGeneration) {
            modelPickerLoading = false
            modelPickerGeneration = -1
            modelPickerTabId = ""
        }
        return requested
    }

    function openThinkingPicker() {
        if (!bridge.ready || bridge.active || bridge.modelActionPending || bridge.resourceActionPending || composerPickerOpen()) return false
        const originTab = bridge.activeTabId
        const generation = ++composerPickerGeneration
        thinkingPickerGeneration = generation
        thinkingPickerTabId = originTab
        thinkingPickerLoading = true
        const requested = bridge.loadThinkingLevels(response => root.thinkingPickerResult(originTab, generation, response))
        if (!requested && generation === composerPickerGeneration && generation === thinkingPickerGeneration) {
            thinkingPickerLoading = false
            thinkingPickerGeneration = -1
            thinkingPickerTabId = ""
        }
        return requested
    }

    function modelPicked(value) {
        if (!bridge.ready || bridge.active || bridge.activeTabId !== modelPickerTabId || modelPickerGeneration !== composerPickerGeneration) return
        const slash = value.indexOf("/")
        if (slash > 0) bridge.selectModel(value.slice(0, slash), value.slice(slash + 1))
    }

    function modelsReordered(values) {
        if (!bridge.ready || bridge.active || !modelDropUpItem.opened || !modelDropUpItem.reorderable
                || bridge.activeTabId !== modelPickerTabId || modelPickerGeneration !== composerPickerGeneration) return false
        const identities = Array.isArray(values) ? values.map(value => String(value)) : []
        if (identities.length !== modelDropUpItem.items.length) return false
        for (let index = 0; index < identities.length; index++) {
            if (identities[index] !== String(modelDropUpItem.items[index].value)) return false
        }
        bridge.saveModelOrder(identities)
        return true
    }

    function thinkingPicked(value) {
        if (!bridge.ready || bridge.active || bridge.activeTabId !== thinkingPickerTabId || thinkingPickerGeneration !== composerPickerGeneration) return
        bridge.setThinkingLevel(value)
    }

    function pickerPicked(value) {
        const kind = root.pickerKind
        root.pickerKind = ""
        if (kind === "session") {
            bridge.switchSession(value)
        } else if (kind === "palette") {
            root.palettePicked(value)
        } else if (kind === "theme") {
            try {
                const identity = JSON.parse(value)
                bridge.selectTheme(identity)
            } catch (error) {
                bridge.postNotice("error", "Could not read the selected theme")
            }
        }
    }

    // ---- tabs, sessions, directories, worktrees --------------------------------------------

    function ageLabel(ageMs) {
        const minutes = Math.round(Number(ageMs) / 60000)
        if (minutes < 2) return "just now"
        if (minutes < 60) return minutes + " min ago"
        const hours = Math.round(minutes / 60)
        if (hours < 48) return hours + " h ago"
        return Math.round(hours / 24) + " days ago"
    }

    function openSessionsPicker() {
        if ((!bridge.ready && !bridge.canRecover) || bridge.active || pickerDialogItem.opened) return false
        return bridge.listSessions(response => {
            if (!response.ok) return
            const items = []
            for (const session of response.data.sessions) {
                const label = session.name && session.name.length > 0 ? session.name : (session.firstMessage && session.firstMessage.length > 0 ? session.firstMessage : session.id)
                items.push({ value: session.path, label: label, detail: ageLabel(session.ageMs) + " · " + session.messageCount + (session.messageCount === 1 ? " message" : " messages") + (session.scanTruncated ? " (partial scan)" : ""),
                             current: session.path === response.data.current })
            }
            root.pickerKind = "session"
            pickerDialogItem.present({ title: "Resume a session", message: response.data.omitted > 0 ? response.data.omitted + " older sessions are not listed" : "", items: items, searchable: true, emptyText: "No saved sessions for this folder" })
        })
    }

    function newSessionInTab() {
        return root.hasActiveSession ? bridge.newSession() : bridge.openTab("", "")
    }

    function openCatalogSession(session) {
        if (!session || typeof session !== "object") return false
        const openTabId = String(session.openTabId || "")
        if (openTabId.length > 0) {
            if (openTabId === bridge.activeTabId) return true
            return bridge.selectTab(openTabId)
        }
        return bridge.openCatalogSession(session)
    }

    function openDirectoryPicker() {
        if (directoryDialogItem.opened) return false
        directoryDialogItem.present(bridge.workspaceCwd)
        return true
    }

    // Idle tabs close at once; a working tab asks first because closing aborts its run.
    function closeTab(tabId) {
        const tab = bridge.tabById(tabId)
        if (!tab) return false
        if (tab.active) {
            confirmDialogItem.present({
                title: "Close tab while Pi is working?",
                message: "Closing " + bridge.tabLabel(tab) + " aborts the current run and stops its Pi process.",
                detail: String(tab.cwd), confirmLabel: "Abort and close", destructive: true, context: { action: "close-tab", tabId: tabId }
            })
            return true
        }
        return bridge.closeTab(tabId, false)
    }

    function renameActiveTab() {
        const tab = bridge.activeTab
        if (!tab) return false
        inputDialogItem.present({ title: "Rename tab", message: "The name is also stored as the Pi session name.", placeholder: "Tab name", prefill: bridge.tabLabel(tab), maxCharacters: 64,
                                  validate: text => text.trim().length === 0 ? "Enter a name" : "", context: { action: "rename-tab", tabId: tab.id } })
        return true
    }

    function branchProblem(text) {
        const value = String(text || "").trim()
        if (value.length === 0) return "Enter a branch name"
        if (/[\s~^:?*\[\\]/.test(value) || value.indexOf("..") !== -1 || value.indexOf("@{") !== -1 || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return "Branch names cannot contain spaces, ~ ^ : ? * [ \\, or \"..\", and cannot start with - or /"
        return ""
    }

    // Collects a branch type and name (unless already given), shows the exact path and base from
    // the backend's plan, and creates the worktree only after confirmation.
    function planWorktree(branch) {
        if (typeof branch !== "string") {
            worktreeDialogItem.validate = root.branchProblem
            worktreeDialogItem.present()
            return true
        }
        return bridge.planWorktree(branch, response => {
            if (!response.ok) return
            const plan = response.data
            if (plan.problems.length > 0) {
                bridge.postNotice("error", "Cannot create the worktree: " + plan.problems.join("; "))
                return
            }
            confirmDialogItem.present({
                title: "Create worktree?",
                message: "Branch " + plan.branch + " from " + plan.base + (plan.detachedBase ? " (detached HEAD)" : "") + (plan.nested ? ", inside the repository" : "") + ". The worktree opens in a new tab.",
                detail: plan.path, confirmLabel: "Create worktree", destructive: false, context: { action: "worktree", plan: plan }
            })
        })
    }

    function confirmAccepted(context) {
        if (!context) return
        if (context.action === "close-tab") bridge.closeTab(String(context.tabId), true)
        else if (context.action === "worktree") bridge.createWorktree(context.plan.branch, context.plan.base, context.plan.path)
        else if (context.action === "open-path") bridge.openPath(String(context.path))
    }

    function inputSubmitted(text, context) {
        if (!context) return
        if (context.action === "rename-tab") bridge.renameTab(String(context.tabId), text)
        else if (context.action === "session-settle-days") bridge.setSessionSettleDays(text)
    }

    // The composer follows confirmed identity, not volatile runtime state.
    function boundedDraftRecords(records) {
        const keys = Object.keys(records)
        for (let i = 0; i < keys.length - 64; i++) delete records[keys[i]]
        return records
    }

    function rememberDraft(text) {
        if (changingDraft || draftKeyInUse.length === 0) return
        draftEditRevision++
        draftRestoreGeneration++
        const records = Object.assign({}, draftRecords)
        delete records[draftKeyInUse]
        records[draftKeyInUse] = { text: text, revision: draftEditRevision }
        draftRecords = boundedDraftRecords(records)
    }

    function beginDraftReplacement() {
        draftRestoreGeneration++
        draftTimer.stop()
        if (draftKeyInUse.length > 0 && (!draftKeyInUse.startsWith("draft:")
                || bridge.tabs.some(tab => tab.id === draftOwnerInUse.split(":")[0])))
            bridge.saveDraftFor(draftKeyInUse, composer.text)
        changingDraft = true
        composer.text = ""
        draftEditRevision++
    }

    function commitDraftReplacement() {
        draftOwnerInUse = bridge.draftOwner
        draftKeyInUse = bridge.draftKey
        changingDraft = false
        restoreCurrentDraft()
    }

    function restoreCurrentDraft() {
        if (!bridge.ready || changingDraft || !draftKeyInUse) return
        const generation = ++draftRestoreGeneration
        const revision = draftEditRevision
        const owner = draftOwnerInUse
        const key = draftKeyInUse
        const cached = draftRecords[key]
        if (cached) { restoreDraft(owner, key, cached.text); return }
        bridge.loadDraft(response => {
            if (!response.ok || generation !== draftRestoreGeneration || revision !== draftEditRevision
                    || owner !== draftOwnerInUse || key !== draftKeyInUse) return
            restoreDraft(owner, key, String(response.data.text || ""))
        }, key)
    }

    function handleDraftKeyChanged() {
        if (changingDraft || !bridge.draftKey || draftKeyInUse === bridge.draftKey) return
        if (draftOwnerInUse && draftOwnerInUse !== bridge.draftOwner) {
            beginDraftReplacement()
            commitDraftReplacement()
            return
        }
        draftTimer.stop()
        const oldKey = draftKeyInUse
        const previous = draftRecords[oldKey]
        draftRestoreGeneration++
        draftKeyInUse = bridge.draftKey
        draftOwnerInUse = bridge.draftOwner
        if (previous && previous.text === composer.text && composer.text.length > 0) {
            const records = Object.assign({}, draftRecords)
            records[draftKeyInUse] = previous
            draftRecords = boundedDraftRecords(records)
        }
        // First filename assignment preserves the editor and moves its pending unsent text.
        if (composer.text.length > 0) bridge.saveDraftFor(draftKeyInUse, composer.text)
        else restoreCurrentDraft()
    }

    function submitComposer(text, mode) {
        rememberDraft(composer.text)
        const key = draftKeyInUse
        const original = draftRecords[key]
        const submitted = composer.text
        const originTab = bridge.activeTabId
        bridge.saveDraftFor(key, submitted)
        return bridge.sendPrompt(text, mode, (response, operation) => {
            if (!response.ok || operation.superseded || draftRecords[key] !== original) return
            const currentMatches = draftRecords[draftKeyInUse] === original
            const records = Object.assign({}, draftRecords)
            for (const savedKey of Object.keys(records)) {
                if (records[savedKey] !== original) continue
                bridge.saveDraftFor(savedKey, "", submitted)
                records[savedKey] = { text: "", revision: ++draftRestoreGeneration }
            }
            draftRecords = records
            if (bridge.activeTabId === originTab && currentMatches && composer.text === submitted) {
                draftTimer.stop()
                composer.clearAndFocus()
                draftTimer.stop()
            }
        }, submitted)
    }

    function compactContext() {
        return bridge.compactContext("")
    }

    // ---- composer: completion, attachments, drafts, sequences --------------------------------

    function commandSuggestions(query) {
        const needle = String(query || "").toLowerCase()
        const items = []
        for (const command of bridge.commands) {
            const name = String(command.name)
            if (needle.length > 0 && name.toLowerCase().indexOf(needle) !== 0) continue
            const source = command.source === "skill" ? "skill" : command.source === "prompt" ? "prompt template" : ""
            items.push({ value: name, label: "/" + name, detail: [command.description, source].filter(part => part && part.length > 0).join(" · ") })
            if (items.length >= 50) break
        }
        return items
    }

    function requestCompletion(kind, query, generation) {
        pathCompletionTimer.stop()
        if (kind === "command") {
            if (bridge.commandsLoaded) {
                const items = commandSuggestions(query)
                composer.setCompletionResults(generation, items, items.length === 0 ? "No matching command" : "")
            } else {
                bridge.loadCommands(response => {
                    const items = response.ok ? commandSuggestions(query) : []
                    composer.setCompletionResults(generation, items, response.ok ? "No matching command" : "Commands are unavailable")
                })
            }
        } else if (kind === "path") {
            pendingPathQuery = query
            pendingPathGeneration = generation
            pathCompletionTimer.restart()
        }
    }

    function completePendingPath() {
        const query = pendingPathQuery
        const generation = pendingPathGeneration
        bridge.completePath(query, response => {
            if (composer.completionKind !== "path" || composer.completionQuery !== query) return
            if (!response.ok) {
                composer.setCompletionResults(generation, [], "Paths are unavailable")
                return
            }
            const items = response.data.suggestions.map(entry => ({
                value: entry.path, label: entry.path + (entry.directory ? "/" : ""), detail: entry.directory ? "directory" : "", directory: entry.directory === true
            }))
            composer.setCompletionResults(generation, items, items.length === 0 ? "No matching workspace path" : "")
        })
    }

    function urlToPath(url) {
        let text = String(url)
        if (text.indexOf("file://") === 0) text = text.slice(7)
        try {
            return decodeURIComponent(text)
        } catch (error) {
            return text
        }
    }

    function editAttachment(attachmentId) {
        if (bridge.attachmentLocked(attachmentId)) return
        for (const attachment of bridge.attachments) {
            if (String(attachment.id) !== String(attachmentId) || attachment.kind !== "text") continue
            const tab = bridge.activeTabId
            bridge.readAttachment(attachmentId, response => {
                if (!response.ok) { bridge.postNotice("error", response.error.message); return }
                if (bridge.activeTabId !== tab) return
                attachmentEditorItem.attachmentId = String(attachmentId)
                attachmentEditorItem.present({ title: "Edit " + attachment.name, text: response.data.text, maxCharacters: 262144 })
            })
            return true
        }
        return false
    }

    function openSequences() {
        if (sequencesDialogItem.opened) return false
        sequencesDialogItem.present()
        return true
    }

    function restoreDraft(owner, key, text) {
        if (owner !== draftOwnerInUse || key !== draftKeyInUse || text.length === 0 || composer.text.length > 0) return
        changingDraft = true
        composer.setText(text)
        changingDraft = false
        draftEditRevision++
        const records = Object.assign({}, draftRecords)
        records[key] = { text: text, revision: draftEditRevision }
        draftRecords = boundedDraftRecords(records)
    }

    // ---- links and dialogs ---------------------------------------------------------------

    function confirmLink(url) {
        linkDialogItem.present(url)
    }

    function acceptLink() {
        linkDialogItem.accept()
    }

    function extensionDialogInputText(value) {
        extensionDialogItem.setInputText(value)
    }

    function extensionDialogEditorText(value) {
        extensionDialogItem.setEditorText(value)
    }

    FloatingWindow {
        id: window
        visible: true
        title: bridge.windowTitle
        implicitWidth: root.smokeMode && Quickshell.env("QT_WEBUI_THEME_MODE") === "layout-geometry" ? 560 : 860
        implicitHeight: root.smokeMode && Quickshell.env("QT_WEBUI_THEME_MODE") === "layout-geometry" ? 520 : 760
        minimumSize: Qt.size(560, 520)
        color: appTheme.windowBackground
        surfaceFormat.opaque: true

        Rectangle {
            id: contentRoot
            parent: window.contentItem
            anchors.fill: parent
            color: appTheme.windowBackground
            border.width: appTheme.borderWidth
            border.color: appTheme.frameBorder

            Shortcut {
                sequence: "Ctrl+Alt+B"
                onActivated: root.toggleWorkspaceRail()
            }
            Shortcut {
                sequence: "Ctrl+F"
                onActivated: root.openSearch()
            }
            Shortcut {
                sequence: "Ctrl+T"
                onActivated: bridge.updateSetting("showThinking", !bridge.showThinking)
            }
            Shortcut {
                sequence: "Ctrl+Shift+X"
                onActivated: bridge.abortRun()
            }
            Shortcut {
                sequence: "Ctrl+L"
                onActivated: composer.focusEditor()
            }
            Shortcut {
                sequence: "Ctrl+M"
                onActivated: root.openModelPicker()
            }
            Shortcut {
                sequence: "Ctrl+Shift+P"
                onActivated: bridge.cycleModel()
            }
            Shortcut {
                sequence: "Ctrl+E"
                onActivated: root.openThinkingPicker()
            }
            Shortcut {
                sequence: "Ctrl+Shift+E"
                onActivated: bridge.cycleThinkingLevel()
            }
            Shortcut {
                sequence: "Ctrl+Shift+R"
                onActivated: root.openResourceProfiles()
            }
            Shortcut {
                sequence: "Ctrl+Shift+S"
                onActivated: root.openSequences()
            }
            Shortcut {
                sequence: "Ctrl+Shift+A"
                onActivated: if (bridge.ready) fileDialog.open()
            }
            Shortcut {
                sequence: "Ctrl+N"
                onActivated: bridge.openTab("", "")
            }
            Shortcut {
                sequence: "Ctrl+O"
                onActivated: root.openDirectoryPicker()
            }
            Shortcut {
                sequence: "Ctrl+W"
                onActivated: root.closeTab(bridge.activeTabId)
            }
            Shortcut {
                sequence: "Ctrl+Tab"
                onActivated: bridge.cycleTab(1)
            }
            Shortcut {
                sequence: "Ctrl+Shift+Tab"
                onActivated: bridge.cycleTab(-1)
            }
            Shortcut {
                sequence: "Ctrl+Shift+O"
                onActivated: root.openSessionsPicker()
            }
            Shortcut {
                sequence: "Ctrl+Shift+N"
                onActivated: root.newSessionInTab()
            }
            Shortcut {
                sequence: "Ctrl+Shift+B"
                onActivated: root.planWorktree()
            }
            Shortcut {
                sequence: "F2"
                onActivated: root.renameActiveTab()
            }
            Shortcut {
                sequence: "Ctrl+K"
                onActivated: root.openPalette()
            }
            Shortcut {
                sequence: "Ctrl+Shift+L"
                onActivated: root.openEvents()
            }
            Shortcut {
                sequence: "Ctrl+Shift+D"
                onActivated: root.openDiagnostics()
            }

            // Palette actions run after the picker has closed so dialogs they open get focus.
            Timer {
                id: paletteActionTimer
                property string action: ""
                interval: 30
                repeat: false
                onTriggered: root.runPaletteAction(action)
            }
            Instantiator {
                model: 8
                delegate: Shortcut {
                    required property int index
                    sequence: "Ctrl+" + (index + 1)
                    onActivated: bridge.selectTabIndex(index)
                }
            }

            // Drafts are saved shortly after typing stops and restored when the same session is
            // shown again with an empty editor.
            Timer {
                id: draftTimer
                interval: 600
                repeat: false
                property var pending: null
                onTriggered: {
                    const save = pending
                    if (save && save.owner === root.draftOwnerInUse && save.key === root.draftKeyInUse
                            && save.revision === root.draftEditRevision) bridge.saveDraftFor(save.key, save.text)
                }
            }

            Timer {
                id: pathCompletionTimer
                interval: 120
                repeat: false
                onTriggered: root.completePendingPath()
            }

            Connections {
                target: bridge
                function onReadyChanged() {
                    if (!bridge.ready) {
                        root.invalidateComposerPickers()
                    } else {
                        if (!root.changingDraft && !root.draftKeyInUse) root.handleDraftKeyChanged()
                        else if (!root.changingDraft && root.draftOwnerInUse === bridge.draftOwner) root.restoreCurrentDraft()
                    }
                }
                function onActiveChanged() {
                    if (bridge.active) root.invalidateComposerPickers()
                }
                function onDraftKeyChanged() {
                    root.handleDraftKeyChanged()
                }
                function onTabSwitching() {
                    transcriptAutoScroll.stop()
                    root.beginDraftReplacement()
                }
                function onSessionReplacing() {
                    transcriptAutoScroll.stop()
                    root.beginDraftReplacement()
                }
                function onSessionReplaced() { root.commitDraftReplacement() }
                function onTabSwitched(tabId) {
                    root.invalidateComposerPickers()
                    root.commitDraftReplacement()
                    root.closeSearch()
                }
            }

            FileDialog {
                id: fileDialog
                title: "Attach files"
                fileMode: FileDialog.OpenFiles
                currentFolder: "file://" + bridge.workspaceCwd
                onAccepted: {
                    // Files chosen through the picker are explicitly granted, even outside the workspace.
                    for (const url of selectedFiles) bridge.addAttachment(root.urlToPath(url), true)
                    composer.focusEditor()
                }
                onRejected: composer.focusEditor()
            }

            RowLayout {
                anchors.fill: parent
                spacing: 0

                // Persistent workspace rail: identity, current status, tabs, and workspace actions.
                Rectangle {
                    id: workspaceRail
                    visible: root.workspaceRailVisible
                    Layout.fillHeight: true
                    Layout.preferredWidth: root.workspaceRailRequestedWidth > 0
                        ? root.clampWorkspaceRailWidth(root.workspaceRailRequestedWidth)
                        : root.clampWorkspaceRailWidth(contentRoot.width * 0.24)
                    Layout.minimumWidth: root.workspaceRailMinimumWidth
                    Layout.maximumWidth: root.workspaceRailMaximumWidth
                    color: appTheme.surfaceRaised
                    Accessible.role: Accessible.Grouping
                    Accessible.name: "Workspace navigation"

                    Rectangle {
                        anchors.right: parent.right
                        width: appTheme.borderWidth
                        height: parent.height
                        color: appTheme.frameBorder
                    }

                    Item {
                        id: workspaceRailResizeHandle
                        z: 2
                        width: 12
                        height: parent.height
                        anchors.horizontalCenter: parent.right
                        activeFocusOnTab: true
                        Accessible.role: Accessible.Slider
                        Accessible.name: "Resize workspace panel"
                        Accessible.description: "Drag left or right, or press Shift+Left or Shift+Right"

                        property real dragStartWidth: 0

                        Rectangle {
                            anchors.centerIn: parent
                            width: appTheme.borderWidth
                            height: parent.height
                            color: workspaceRailResizeHandle.activeFocus || workspaceRailDrag.active ? appTheme.focusRing : appTheme.border
                        }

                        HoverHandler {
                            cursorShape: Qt.SplitHCursor
                        }

                        DragHandler {
                            id: workspaceRailDrag
                            target: null
                            yAxis.enabled: false
                            onActiveChanged: {
                                if (active) {
                                    workspaceRailResizeHandle.forceActiveFocus()
                                    workspaceRailResizeHandle.dragStartWidth = workspaceRail.width
                                }
                            }
                            onTranslationChanged: root.setWorkspaceRailWidth(workspaceRailResizeHandle.dragStartWidth + translation.x)
                        }

                        Keys.onPressed: event => {
                            if (!(event.modifiers & Qt.ShiftModifier)) return
                            if (event.key === Qt.Key_Left) {
                                root.shiftWorkspaceRailWidth(-16)
                                event.accepted = true
                            } else if (event.key === Qt.Key_Right) {
                                root.shiftWorkspaceRailWidth(16)
                                event.accepted = true
                            }
                        }
                    }

                    ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: 10
                        spacing: 8

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 6

                            Label {
                                text: "◆"
                                textFormat: Text.PlainText
                                color: appTheme.accentForeground
                                font.family: appTheme.monospaceFamily
                                font.pixelSize: appTheme.typeHeading
                                Accessible.role: Accessible.Graphic
                                Accessible.name: "Qt WebUI identity mark"
                            }

                            SelectableText {
                                Layout.fillWidth: true
                                theme: appTheme
                                text: "Qt WebUI"
                                color: appTheme.heading
                                font.family: appTheme.monospaceFamily
                                font.pixelSize: appTheme.typeHeading
                                font.bold: true
                                Accessible.role: Accessible.Heading
                            }

                            StatusBadge {
                                theme: appTheme
                                kind: root.hasActiveSession ? bridge.statusKind : "stopped"
                                text: root.hasActiveSession ? bridge.statusText : "No session"
                                fontSize: 10
                                Accessible.name: "Status " + (root.hasActiveSession ? bridge.statusText : "No session")
                            }
                        }

                        SelectableText {
                            Layout.fillWidth: true
                            theme: appTheme
                            text: "WORKSPACES"
                            color: appTheme.muted
                            font.family: appTheme.monospaceFamily
                            font.pixelSize: appTheme.typeCaption
                            font.bold: true
                            font.letterSpacing: appTheme.labelTracking
                        }

                        SessionList {
                            id: sessionListItem
                            Layout.fillWidth: true
                            Layout.fillHeight: true
                            theme: appTheme
                            sessions: bridge.sessionCatalog
                            tabs: bridge.tabs
                            pendingSettlements: bridge.sessionSettlementPending
                            settleAllPending: bridge.sessionSettleAllPending
                            activeTabId: bridge.activeTabId
                            maxTabs: bridge.maxTabs
                            homeDirectory: bridge.homeDirectory
                            loading: bridge.sessionCatalogLoading
                            errorText: bridge.sessionCatalogError
                            warningText: bridge.sessionCatalogWarning
                            onSessionRequested: session => root.openCatalogSession(session)
                            onSettlementRequested: (sessionPath, settled) => bridge.setSessionSettled(sessionPath, settled)
                            onSettleAllRequested: bridge.settleAllSessions()
                            onCloseRequested: tabId => root.closeTab(tabId)
                            onNewTabRequested: bridge.openTab("", "")
                            onOpenDirectoryRequested: root.openDirectoryPicker()
                            onRefreshRequested: bridge.refreshSessionCatalog()
                        }

                        Flow {
                            Layout.fillWidth: true
                            Layout.preferredHeight: childrenRect.height
                            spacing: 4

                            AppButton {
                                id: recoverySessionsButton
                                visible: bridge.ready || bridge.canRecover
                                theme: appTheme
                                variant: "ghost"
                                text: "Sessions"
                                accessibleName: "Resume a saved session in this tab"
                                accessibleDescription: "Ctrl+Shift+O opens the list, Ctrl+Shift+N starts a new session"
                                enabled: !bridge.active
                                padding: 4
                                leftPadding: 8
                                rightPadding: 8
                                onClicked: root.openSessionsPicker()
                            }

                            AppButton {
                                id: recoveryNewSessionButton
                                visible: bridge.canRecover
                                theme: appTheme
                                variant: "ghost"
                                text: "New session"
                                accessibleName: "Start a new session instead of the missing one"
                                enabled: !bridge.active
                                padding: 4
                                leftPadding: 8
                                rightPadding: 8
                                onClicked: root.newSessionInTab()
                            }

                            AppButton {
                                visible: bridge.ready
                                theme: appTheme
                                variant: "ghost"
                                text: "Worktree"
                                accessibleName: "Create a Git worktree in a new tab"
                                accessibleDescription: "Ctrl+Shift+B"
                                padding: 4
                                leftPadding: 8
                                rightPadding: 8
                                onClicked: root.planWorktree()
                            }
                        }

                        Flow {
                            Layout.fillWidth: true
                            Layout.preferredHeight: childrenRect.height
                            spacing: 4

                            AppButton {
                                theme: appTheme
                                variant: "ghost"
                                text: "Palette"
                                accessibleName: "Open the command palette"
                                accessibleDescription: "Ctrl+K"
                                padding: 4
                                leftPadding: 8
                                rightPadding: 8
                                onClicked: root.openPalette()
                            }

                            AppButton {
                                id: reloadPiButton
                                visible: bridge.ready
                                theme: appTheme
                                variant: "ghost"
                                text: "Reload Pi"
                                accessibleName: "Reload Pi resources"
                                enabled: !bridge.active
                                padding: 4
                                leftPadding: 8
                                rightPadding: 8
                                onClicked: bridge.sendPrompt("/reload", "send")
                            }

                            AppButton {
                                visible: root.hasActiveSession || !bridge.backendRunning
                                theme: appTheme
                                variant: bridge.backendRunning && bridge.ready ? "ghost" : "warning"
                                text: bridge.restarting ? "Restarting…" : (bridge.backendRunning ? "Restart Pi" : "Start backend")
                                accessibleName: bridge.restarting ? "Pi is restarting" : "Restart Pi"
                                enabled: !bridge.active && !bridge.restarting
                                padding: 4
                                leftPadding: 8
                                rightPadding: 8
                                onClicked: bridge.restartProcess()
                            }
                        }
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    color: appTheme.windowBackground

                    ColumnLayout {
                        anchors.fill: parent
                        anchors.leftMargin: contentRoot.width <= 640 ? 10 : 18
                        anchors.rightMargin: contentRoot.width <= 640 ? 10 : 18
                        anchors.topMargin: 10
                        anchors.bottomMargin: 10
                        spacing: 8

                        // Compact main header: active workspace, path, and transcript search.
                        RowLayout {
                            id: workspaceHeader
                            visible: root.hasActiveSession
                            Layout.fillWidth: true
                            spacing: 8

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 1

                                SelectableText {
                                    Layout.fillWidth: true
                                    theme: appTheme
                                    text: bridge.sessionName
                                    color: appTheme.heading
                                    font.family: appTheme.monospaceFamily
                                    font.pixelSize: appTheme.typeTitle
                                    font.bold: true
                                    Accessible.role: Accessible.Heading
                                }

                                SelectableText {
                                    Layout.fillWidth: true
                                    theme: appTheme
                                    text: bridge.displayCwd
                                    color: appTheme.muted
                                    font.family: appTheme.monospaceFamily
                                    font.pixelSize: appTheme.typeSmall
                                    Accessible.role: Accessible.StaticText
                                    Accessible.name: "Workspace " + bridge.workspaceCwd
                                }
                            }

                            AppButton {
                                theme: appTheme
                                variant: "ghost"
                                active: root.searchOpen
                                text: "Search"
                                accessibleName: "Search transcript"
                                accessibleDescription: "Ctrl+F"
                                padding: 4
                                leftPadding: 8
                                rightPadding: 8
                                onClicked: root.searchOpen ? root.closeSearch() : root.openSearch()
                            }
                        }

                        // Transcript, composer, queues, notices, and status share one readable width.
                        Item {
                            Layout.fillWidth: true
                            Layout.fillHeight: true

                            ColumnLayout {
                                anchors.top: parent.top
                                anchors.bottom: parent.bottom
                                anchors.horizontalCenter: parent.horizontalCenter
                                width: Math.min(parent.width, 820)
                                spacing: 8

                                Rectangle {
                                    Layout.fillWidth: true
                                    visible: bridge.visibleError.length > 0
                                    implicitHeight: errorLabel.implicitHeight + 20
                                    radius: appTheme.radiusMedium
                                    color: appTheme.errorPanelBackground
                                    border.width: appTheme.borderWidth
                                    border.color: appTheme.errorPanelBorder
                                    Accessible.role: Accessible.AlertMessage
                                    Accessible.name: "Error: " + bridge.visibleError

                                    SelectableText {
                                        id: errorLabel
                                        anchors.fill: parent
                                        anchors.margins: 10
                                        theme: appTheme
                                        text: bridge.visibleError
                                        color: appTheme.errorPanelForeground
                                        wrapMode: TextEdit.Wrap
                                        font.pixelSize: 12
                                    }
                                }

                                SearchBar {
                                    id: searchBar
                                    Layout.fillWidth: true
                                    visible: root.hasActiveSession && root.searchOpen
                                    theme: appTheme
                                    matchCount: root.searchMatchCount
                                    currentIndex: root.searchIndex
                                    onQueryEdited: query => {
                                        root.searchQuery = query
                                        root.runSearch()
                                    }
                                    onNextRequested: root.searchNext()
                                    onPreviousRequested: root.searchPrevious()
                                    onCloseRequested: root.closeSearch()
                                }

                                Item {
                                    Layout.fillWidth: true
                                    Layout.fillHeight: !root.hasActiveSession || transcriptList.count > 0
                                    Layout.preferredHeight: root.hasActiveSession && transcriptList.count === 0
                                        ? Math.min(480, Math.max(260, contentRoot.height * 0.42))
                                        : -1
                                    clip: true

                                    ListView {
                                        id: transcriptList
                                        anchors.fill: parent
                                        anchors.rightMargin: 4
                                        model: bridge.transcriptModel
                                        spacing: bridge.compactTranscript ? 6 : 12
                                        boundsBehavior: Flickable.StopAtBounds
                                        cacheBuffer: 400
                                        property bool followOutput: true
                                        Accessible.role: Accessible.List
                                        Accessible.name: "Conversation transcript"

                                        ScrollBar.vertical: ScrollBar {
                                            id: transcriptScrollBar
                                            policy: ScrollBar.AsNeeded
                                            onPressedChanged: {
                                                if (pressed) transcriptList.followOutput = false
                                                else transcriptList.resumeFollowingAtEnd()
                                            }
                                        }

                                        WheelHandler {
                                            target: null
                                            blocking: true
                                            acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
                                            onWheel: event => {
                                                event.accepted = transcriptList.scrollWheel(event.angleDelta.y, event.pixelDelta.y)
                                            }
                                        }

                                        TranscriptAutoScroll {
                                            id: transcriptAutoScroll
                                            parent: transcriptList
                                            view: transcriptList
                                            theme: appTheme
                                        }

                                        function scrollWheel(angleDelta, pixelDelta) {
                                            if (angleDelta === 0 && pixelDelta === 0) return false
                                            transcriptAutoScroll.stop()
                                            cancelFlick()
                                            followOutput = false
                                            // Qt's wheel baseline is 24 pixels per configured scroll line.
                                            const distance = pixelDelta !== 0 ? pixelDelta : angleDelta / 120 * Qt.styleHints.wheelScrollLines * 24
                                            scrollByPixels(-distance * 2)
                                            Qt.callLater(resumeFollowingAtEnd)
                                            return true
                                        }

                                        function scrollByPixels(delta) {
                                            const nextY = contentY + delta
                                            const bottom = originY + Math.max(0, contentHeight - height)
                                            if (nextY <= originY) positionViewAtBeginning()
                                            else if (nextY >= bottom) positionViewAtEnd()
                                            else contentY = nextY
                                        }

                                        function followToEnd() {
                                            // A queued layout callback must not undo a later scroll gesture.
                                            if (!followOutput || moving || transcriptScrollBar.pressed || transcriptAutoScroll.scrolling) return
                                            positionViewAtEnd()
                                        }

                                        function resumeFollowingAtEnd() {
                                            if (!moving && !transcriptScrollBar.pressed && !transcriptAutoScroll.scrolling && atYEnd) followOutput = true
                                        }

                                        function jumpToLatest() {
                                            transcriptAutoScroll.stop()
                                            cancelFlick()
                                            followOutput = true
                                            followToEnd()
                                        }

                                        onMovementStarted: followOutput = false
                                        onMovementEnded: resumeFollowingAtEnd()
                                        onContentHeightChanged: if (followOutput) Qt.callLater(followToEnd)
                                        onCountChanged: if (followOutput) Qt.callLater(followToEnd)

                                        footer: WorkingIndicator {
                                            width: transcriptList.width
                                            theme: appTheme
                                            running: bridge.active
                                            statusText: bridge.statusText
                                        }

                                        delegate: TranscriptRow {
                                            required property int index
                                            width: transcriptList.width
                                            theme: appTheme
                                            compact: bridge.compactTranscript
                                            showThinking: bridge.showThinking
                                            highlightCode: bridge.syntaxHighlighting
                                            searchMatch: root.searchMatches.indexOf(rowId) !== -1
                                            searchCurrent: root.searchCurrentRow === index
                                            onCopyRequested: text => bridge.copyToClipboard(text)
                                            onLinkActivated: link => root.confirmLink(link)
                                        }
                                    }

                                    EmptyState {
                                        anchors.fill: parent
                                        visible: !root.hasActiveSession || transcriptList.count === 0
                                        theme: appTheme
                                        ready: bridge.ready
                                        canRecover: bridge.canRecover
                                        backendReady: bridge.backendReady
                                        sessionOpen: root.hasActiveSession
                                        onRestartRequested: bridge.restartProcess()
                                        onNewSessionRequested: root.newSessionInTab()
                                        onResumeRequested: root.openSessionsPicker()
                                        onOpenDirectoryRequested: root.openDirectoryPicker()
                                    }

                                    AppButton {
                                        id: latestButton
                                        anchors.horizontalCenter: parent.horizontalCenter
                                        anchors.bottom: parent.bottom
                                        anchors.bottomMargin: appTheme.spaceMd
                                        z: 2
                                        visible: root.hasActiveSession && transcriptList.count > 0 && !transcriptList.followOutput
                                        theme: appTheme
                                        text: "Latest ↓"
                                        accessibleName: "Go to latest output"
                                        accessibleDescription: "Move to the newest message and follow new output"
                                        onClicked: transcriptList.jumpToLatest()
                                    }
                                }

                                Rectangle {
                                    Layout.fillWidth: true
                                    visible: root.hasActiveSession && (bridge.steeringQueue.length > 0 || bridge.followUpQueue.length > 0)
                                    implicitHeight: queueLabel.implicitHeight + 16
                                    radius: appTheme.radiusMedium
                                    color: appTheme.surfaceRaised
                                    border.width: appTheme.borderWidth
                                    border.color: appTheme.border
                                    Accessible.role: Accessible.StaticText
                                    Accessible.name: queueLabel.text

                                    SelectableText {
                                        id: queueLabel
                                        anchors.fill: parent
                                        anchors.margins: 8
                                        theme: appTheme
                                        text: (bridge.steeringQueue.length > 0 ? "Steering queued: " + bridge.steeringQueue.join(" · ") : "")
                                            + (bridge.steeringQueue.length > 0 && bridge.followUpQueue.length > 0 ? "\n" : "")
                                            + (bridge.followUpQueue.length > 0 ? "Follow-up queued: " + bridge.followUpQueue.join(" · ") : "")
                                        wrapMode: TextEdit.Wrap
                                        maximumLineCount: 4
                                        color: appTheme.muted
                                        font.pixelSize: 12
                                    }
                                }

                                NoticeBar {
                                    id: noticeBar
                                    Layout.fillWidth: true
                                    theme: appTheme
                                }

                                Composer {
                                    id: composer
                                    visible: root.hasActiveSession
                                    Layout.minimumWidth: implicitMinimumWidth
                                    Layout.fillWidth: true
                                    active: bridge.active
                                    ready: bridge.ready
                                    processRunning: bridge.backendRunning
                                    theme: appTheme
                                    maxCharacters: bridge.maxMessageCharacters
                                    maxAttachments: bridge.maxAttachments
                                    attachments: bridge.attachments
                                    lockedAttachmentIds: bridge.attachments.filter(item => bridge.attachmentLocked(String(item.id))).map(item => String(item.id))
                                    onSendRequested: (text, mode) => root.submitComposer(text, mode)
                                    onAbortRequested: bridge.abortRun()
                                    onRestartRequested: bridge.restartProcess()
                                    onAttachRequested: fileDialog.open()
                                    onAttachmentRemoveRequested: attachmentId => bridge.removeAttachment(attachmentId)
                                    onAttachmentEditRequested: attachmentId => root.editAttachment(attachmentId)
                                    onCompletionRequested: (kind, query, generation) => root.requestCompletion(kind, query, generation)
                                    onDraftEdited: text => {
                                        if (root.changingDraft) return
                                        root.rememberDraft(text)
                                        draftTimer.pending = { owner: root.draftOwnerInUse, key: root.draftKeyInUse,
                                            revision: root.draftEditRevision, text: text }
                                        draftTimer.restart()
                                    }
                                }

                                // Response and transcript controls belong with the prompt they affect,
                                // rather than occupying a second row beneath the workspace title.
                                RowLayout {
                                    id: responseControls
                                    visible: root.hasActiveSession
                                    Layout.fillWidth: true
                                    spacing: 4
                                    Accessible.role: Accessible.Grouping
                                    Accessible.name: "Response and transcript controls for workspace " + bridge.workspaceCwd

                                    Flow {
                                        id: primaryResponseControls
                                        Layout.fillWidth: true
                                        Layout.leftMargin: 4
                                        Layout.preferredHeight: childrenRect.height
                                        spacing: 4

                                        AppButton {
                                            id: modelButton
                                        visible: bridge.runtimeInfoText.length > 0
                                        theme: appTheme
                                        variant: "ghost"
                                        text: bridge.currentProvider + "/" + bridge.currentModelId
                                        accessibleName: "Model " + bridge.currentProvider + "/" + bridge.currentModelId + (bridge.currentModelName.length > 0 ? " (" + bridge.currentModelName + ")" : "") + ", choose a model"
                                        accessibleDescription: "Ctrl+M opens the list, Ctrl+Shift+P cycles"
                                        enabled: bridge.ready && !bridge.active && !bridge.modelActionPending && !bridge.resourceActionPending
                                        padding: 4
                                        leftPadding: 8
                                        rightPadding: 8
                                        onClicked: root.openModelPicker()
                                        ToolTip.visible: hovered && bridge.currentModelName.length > 0
                                        ToolTip.text: bridge.currentModelName
                                        ToolTip.delay: 400
                                    }

                                    AppButton {
                                        id: thinkingButton
                                        visible: bridge.runtimeInfoText.length > 0
                                        theme: appTheme
                                        variant: "ghost"
                                        text: "thinking " + bridge.currentThinkingLevel
                                        accessibleName: "Thinking effort " + bridge.currentThinkingLevel + ", choose a level"
                                        accessibleDescription: "Ctrl+E opens the list, Ctrl+Shift+E cycles"
                                        enabled: bridge.ready && !bridge.active && !bridge.modelActionPending && !bridge.resourceActionPending
                                        padding: 4
                                        leftPadding: 8
                                        rightPadding: 8
                                        onClicked: root.openThinkingPicker()
                                    }

                                    AppButton {
                                        visible: bridge.ready && bridge.transcriptModel.count > 0
                                        theme: appTheme
                                        variant: "ghost"
                                        text: bridge.compacting ? "Compacting…" : "Compact context"
                                        accessibleName: bridge.compacting ? "Context compaction is running" : "Compact the conversation context"
                                        accessibleDescription: "Summarizes older conversation so Pi keeps room for new work"
                                        enabled: !bridge.active && !bridge.compacting
                                        padding: 4
                                        leftPadding: 8
                                        rightPadding: 8
                                        onClicked: root.compactContext()
                                    }

                                    AppButton {
                                        id: statusButton
                                        visible: root.statusEntryCount > 0
                                        theme: appTheme
                                        variant: "ghost"
                                        active: statusOverlayItem.opened
                                        text: "Status " + root.statusEntryCount + (statusOverlayItem.opened ? " ▲" : " ▼")
                                        accessibleName: (statusOverlayItem.opened ? "Hide" : "Show") + " session details, " + root.statusEntryCount + " entries"
                                        accessibleDescription: "Shows Pi, Git, usage, and extension status without sending a prompt"
                                        padding: 4
                                        leftPadding: 8
                                        rightPadding: 8
                                        onClicked: {
                                            if (statusOverlayItem.opened) statusOverlayItem.close()
                                            else statusOverlayItem.present()
                                        }
                                    }

                                    }

                                    AppButton {
                                        id: composerMenuButton
                                        visible: bridge.ready
                                        Layout.alignment: Qt.AlignRight | Qt.AlignTop
                                        theme: appTheme
                                        variant: "ghost"
                                        text: "☰"
                                        accessibleName: "More options"
                                        accessibleDescription: "Resources, saved prompt sequences, automatic settlement, display settings, events, and diagnostics"
                                        enabled: !bridge.active && !bridge.modelActionPending && !bridge.resourceActionPending && !bridge.resourceLoading
                                        padding: 4
                                        leftPadding: 8
                                        rightPadding: 8
                                        onClicked: root.openComposerMenu()
                                        ToolTip.visible: hovered
                                        ToolTip.text: "More options"
                                        ToolTip.delay: 400
                                    }
                                }

                            }
                        }
                    }
                }
            }

            ExtensionDialog {
                id: extensionDialogItem
                theme: appTheme
                bridge: bridge
                returnFocusItem: composer
            }

            LinkDialog {
                id: linkDialogItem
                theme: appTheme
                bridge: bridge
                returnFocusItem: composer
                onLinkOpened: (url, response) => root.linkOpenResult(url, response)
            }

            DropUpPicker {
                id: composerMenuDropUpItem
                theme: appTheme
                boundsItem: contentRoot
                anchorItem: composerMenuButton
                returnFocusItem: composerMenuButton
                maximumWidth: 360
                onPicked: value => root.composerMenuPicked(value)
            }

            StatusOverlay {
                id: statusOverlayItem
                theme: appTheme
                boundsItem: contentRoot
                anchorItem: statusButton
                returnFocusItem: statusButton
                groups: root.statusGroups
            }

            DropUpPicker {
                id: modelDropUpItem
                theme: appTheme
                boundsItem: contentRoot
                anchorItem: modelButton
                returnFocusItem: modelButton
                onPicked: value => root.modelPicked(value)
                onReordered: values => root.modelsReordered(values)
                onCancelled: {
                    root.modelPickerGeneration = -1
                    root.modelPickerTabId = ""
                }
            }

            DropUpPicker {
                id: thinkingDropUpItem
                theme: appTheme
                boundsItem: contentRoot
                anchorItem: thinkingButton
                returnFocusItem: thinkingButton
                maximumWidth: 320
                onPicked: value => root.thinkingPicked(value)
                onCancelled: {
                    root.thinkingPickerGeneration = -1
                    root.thinkingPickerTabId = ""
                }
            }

            PickerDialog {
                id: pickerDialogItem
                theme: appTheme
                returnFocusItem: composer
                onPicked: value => root.pickerPicked(value)
                onCancelled: root.pickerKind = ""
            }

            SequencesDialog {
                id: sequencesDialogItem
                theme: appTheme
                bridge: bridge
                returnFocusItem: composer
                onLoadRequested: entries => composer.setText(entries.join("\n\n"))
            }

            EventsDialog {
                id: eventsDialogItem
                theme: appTheme
                bridge: bridge
                returnFocusItem: composer
            }

            DiagnosticsDialog {
                id: diagnosticsDialogItem
                theme: appTheme
                bridge: bridge
                returnFocusItem: composer
            }

            ResourceProfilesDialog {
                id: resourceProfilesDialogItem
                theme: appTheme
                bridge: bridge
                returnFocusItem: composer
            }

            DirectoryDialog {
                id: directoryDialogItem
                theme: appTheme
                bridge: bridge
                returnFocusItem: composer
                onChosen: path => bridge.openTab(path, "")
            }

            ConfirmDialog {
                id: confirmDialogItem
                theme: appTheme
                returnFocusItem: composer
                onConfirmed: context => root.confirmAccepted(context)
            }

            InputDialog {
                id: inputDialogItem
                theme: appTheme
                returnFocusItem: composer
                onSubmitted: (text, context) => root.inputSubmitted(text, context)
            }

            WorktreeDialog {
                id: worktreeDialogItem
                theme: appTheme
                returnFocusItem: composer
                onSubmitted: branch => root.planWorktree(branch)
            }

            TextEditDialog {
                id: attachmentEditorItem
                property string attachmentId: ""
                theme: appTheme
                returnFocusItem: composer
                onSaved: text => {
                    const version = presentation
                    bridge.updateAttachment(attachmentId, text, response => {
                        if (opened && version === presentation) settle(response)
                    })
                }
                onRefreshRequested: {
                    const version = presentation
                    bridge.readAttachment(attachmentId, response => {
                        if (!opened || version !== presentation) return
                        if (response.ok && response.data.text === editedText) settle({ ok: true })
                        else if (response.ok) { unknown = false; failure = "Stored content refreshed; your edit is still available to save" }
                        else failure = response.error.message
                    })
                }
            }

            Loader {
                id: smokeLoader
                active: root.smokeMode
                sourceComponent: SmokeDriver {
                    bridge: root.backendBridge
                    shell: root
                }
            }
        }
    }
}
