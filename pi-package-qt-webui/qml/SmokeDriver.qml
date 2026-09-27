import QtQuick
import Quickshell

// Deterministic smoke scenario used only when QT_WEBUI_SMOKE_MODE=1. It drives the real UI
// objects (bridge, dialogs, search, settings) against the fake Pi fixture behind the real
// backend and prints markers that tests/qml-smoke.test.mjs asserts on.
Item {
    id: driver

    required property var bridge
    required property var shell
    readonly property string testMode: String(Quickshell.env("QT_WEBUI_THEME_MODE") || "normal")
    readonly property bool remediationOnly: testMode === "remediation"
    readonly property bool recoveryOnly: testMode === "recovery"
    readonly property bool draftOwnershipOnly: testMode === "draft-ownership"
    readonly property bool orderOnly: testMode === "order-only"
    RemediationChecks { id: remediation; driver: driver; bridge: driver.bridge; shell: driver.shell }
    readonly property bool screenshotOnly: testMode === "screenshot"
    readonly property bool themeOnly: testMode === "theme-only"
    property string phase: "boot"
    property string nextAction: ""
    property bool forceUnfocused: false
    property bool piReadyOnce: false
    property bool backendReadyOnce: false
    property int dialogsAnswered: 0
    property bool streamRunEnded: false
    property bool linkConfirmed: false
    property bool searchChecked: false
    property bool notificationChecked: false
    property bool crashObserved: false
    property string modelStep: ""
    property string composerStep: ""
    property var waitCondition: null
    property var waitAction: null
    property int waitTicks: 0

    // Polls a condition every 40 ms (up to 3 s) before running the next composer step, because
    // completion and attachment results arrive asynchronously from the backend.
    function waitFor(description, condition, action) {
        waitCondition = condition
        waitAction = action
        waitTicks = 0
        waitTimer.description = description
        waitTimer.start()
    }

    Timer {
        id: waitTimer
        property string description: ""
        interval: 40
        repeat: true
        onTriggered: {
            if (driver.waitCondition && driver.waitCondition()) {
                stop()
                const action = driver.waitAction
                driver.waitCondition = null
                driver.waitAction = null
                action()
                return
            }
            driver.waitTicks++
            if (driver.waitTicks > 75) {
                stop()
                driver.fail("timed out waiting for " + description)
            }
        }
    }

    function log(marker) {
        console.log(marker)
    }

    function fail(reason) {
        log("QT_WEBUI_SMOKE_FAILURE " + reason)
        const rows = []
        for (let index = 0; index < bridge.transcriptModel.count; index++) {
            const row = bridge.transcriptModel.get(index)
            rows.push(row.kind + ":" + row.rowId + ":" + (row.streaming ? "streaming:" : "") + JSON.stringify(String(row.text).slice(0, 40)) + ":" + row.toolStatus)
        }
        log("QT_WEBUI_SMOKE_ROWS " + rows.join(" | "))
        const notices = []
        for (let index = Math.max(0, bridge.noticeModel.count - 5); index < bridge.noticeModel.count; index++) {
            const notice = bridge.noticeModel.get(index)
            notices.push(notice.level + ":" + JSON.stringify(String(notice.message).slice(0, 160)))
        }
        log("QT_WEBUI_SMOKE_NOTICES " + notices.join(" | "))
        log("QT_WEBUI_SMOKE_TABS active=" + bridge.activeTabId + " count=" + bridge.tabCount + " ready=" + bridge.ready + " status=" + bridge.statusKind + " " + JSON.stringify(bridge.tabs.map(tab => tab.id + ":" + tab.statusKind + ":" + tab.cwd.slice(-20))))
        bridge.showError("Smoke failure: " + reason)
        bridge.shutdown()
    }

    function schedule(action) {
        nextAction = action
        actionTimer.start()
    }

    function lastRowOfKind(kind) {
        for (let index = bridge.transcriptModel.count - 1; index >= 0; index--) {
            const row = bridge.transcriptModel.get(index)
            if (row.kind === kind) return row
        }
        return null
    }

    function findRowContaining(kind, needle) {
        for (let index = bridge.transcriptModel.count - 1; index >= 0; index--) {
            const row = bridge.transcriptModel.get(index)
            if (row.kind === kind && row.text.indexOf(needle) !== -1) return row
        }
        return null
    }

    function answerDialog(dialog) {
        if (!dialog || !dialog.request) return
        if (dialog.focusedOnOpen && dialogsAnswered === 0) log("QT_WEBUI_SMOKE_DIALOG_FOCUS")
        const id = dialog.requestId
        let accepted = false
        if (id === "dialog-select") accepted = dialog.selectOption("Block")
        else if (id === "dialog-confirm") accepted = dialog.confirm(true)
        else if (id === "dialog-input") {
            shell.extensionDialogInputText("typed value")
            accepted = dialog.submitText()
        } else if (id === "dialog-editor") {
            shell.extensionDialogEditorText("Line 1\nLine 2\nLine 3")
            accepted = dialog.submitText()
        } else if (id === "dialog-cancel") accepted = dialog.cancel()
        if (!accepted) fail("dialog " + id + " was not accepted")
        dialogsAnswered++
        if (dialog.submit({ "cancelled": true })) fail("dialog " + id + " accepted a second answer")
        maybeAdvanceFromStream()
    }

    // The fixture settles the run while dialogs may still be queued; advance once both are done.
    function maybeAdvanceFromStream() {
        if (phase !== "stream" || !streamRunEnded || dialogsAnswered < 5) return
        if (dialogsAnswered !== 5) return fail("expected 5 dialogs, saw " + dialogsAnswered)
        log("QT_WEBUI_SMOKE_AGENT_SETTLED")
        schedule("markdown")
    }

    function checkStreamPhase() {
        const text = lastRowOfKind("text")
        if (!text || text.text !== "authoritative final" || text.streaming) return fail("stream reconciliation")
        log("QT_WEBUI_SMOKE_STREAM_RECONCILED")
        const thinking = lastRowOfKind("thinking")
        if (!thinking || thinking.text !== "**Planning user notification strategy**\n\n**Deciding on partial validation response**") return fail("thinking row")
        log("QT_WEBUI_SMOKE_THINKING_RENDERED")
        const tool = lastRowOfKind("tool")
        if (!tool || tool.toolStatus !== "ok" || tool.toolName !== "<b>read</b>" || tool.toolDurationMs < 0 || tool.toolOutput !== "final tool output") return fail("tool card")
        log("QT_WEBUI_SMOKE_TOOL_CARD")
        streamRunEnded = true
        maybeAdvanceFromStream()
    }

    function checkMarkdownPhase() {
        const row = findRowContaining("text", "Heading one")
        if (!row) return fail("markdown row missing")
        let blocks = []
        try { blocks = JSON.parse(row.blocksJson) } catch (error) { return fail("blocks json") }
        const types = blocks.map(block => block.type)
        const styled = JSON.stringify(blocks.filter(block => block.type !== "code"))
        if (types.indexOf("heading") === -1 || types.indexOf("code") === -1 || types.indexOf("table") === -1 || types.indexOf("listItem") === -1) return fail("markdown block types " + types.join(","))
        if (styled.indexOf("&lt;script&gt;") === -1 || styled.indexOf("<img") !== -1 || styled.indexOf("javascript:alert(1))\"") !== -1) return fail("markdown escaping")
        if (styled.indexOf("<a href=\\\"https://example.com/docs\\\">") === -1) return fail("markdown safe link")
        log("QT_WEBUI_SMOKE_MARKDOWN_RENDERED")
        const code = blocks.find(block => block.type === "code")
        if (!code || !Array.isArray(code.tokens) || code.tokens.length === 0 || code.language !== "js") return fail("code highlighting tokens")
        if (code.tokens.some(token => /[<>]/.test(String(token[1])))) return fail("code tokens must be escaped")
        log("QT_WEBUI_SMOKE_CODE_HIGHLIGHTED")
        shell.confirmLink("https://example.com/docs")
        schedule("accept-link")
    }

    function checkSearch() {
        shell.openSearch("heading one")
        if (shell.searchMatchCount < 1) return fail("search matches " + shell.searchMatchCount)
        shell.searchNext()
        if (shell.searchCurrentRow < 0) return fail("search current row")
        const text = bridge.transcriptModel.get(shell.searchCurrentRow).text
        if (text.toLowerCase().indexOf("heading one") === -1) return fail("search original text")
        log("QT_WEBUI_SMOKE_SEARCH_MATCHED")
        shell.closeSearch()
        searchChecked = true
        forceUnfocused = true
        schedule("immediate")
    }

    function startAppearanceChecks() {
        phase = "appearance-light"
        bridge.updateSetting("appearanceMode", "light")
    }

    function startThemeChecks() {
        phase = "theme-builtin"
        if (!shell.openThemePicker()) return fail("theme picker refused")
        waitFor("theme picker inventory", () => shell.pickerDialog.opened && shell.pickerDialog.items.length >= 5, () => {
            const builtinLight = JSON.stringify({ kind: "builtin", name: "light" })
            const externalLight = JSON.stringify({ kind: "external", name: "light" })
            if (!shell.pickerDialog.items.some(item => item.value === builtinLight)
                    || !shell.pickerDialog.items.some(item => item.value === externalLight)) return fail("typed light theme identities")
            if (!shell.pickerDialog.pickValue(builtinLight)) return fail("built-in light selection")
            waitFor("built-in light theme", () => bridge.themeState.requested.kind === "builtin" && bridge.themeState.requested.name === "light", () => selectExternalLight())
        })
    }

    function selectExternalLight() {
        phase = "theme-external"
        if (!shell.openThemePicker()) return fail("external theme picker refused")
        waitFor("external theme picker", () => shell.pickerDialog.opened, () => {
            if (!shell.pickerDialog.pickValue(JSON.stringify({ kind: "external", name: "light" }))) return fail("external light selection")
            waitFor("external theme palette", () => bridge.themeState.requested.kind === "external"
                    && bridge.themeState.requested.name === "light" && shell.externalThemeEffective, () => checkExternalTheme())
        })
    }

    function checkExternalTheme() {
        if (String(shell.themeAccent).toLowerCase() !== "#654321") return fail("external palette accent " + String(shell.themeAccent))
        log("QT_WEBUI_SMOKE_EXTERNAL_THEME_APPLIED")
        log("QT_WEBUI_SMOKE_THEME_TYPED_COLLISION")
        log("QT_WEBUI_SMOKE_THEME_SELECTION_PERSISTED")
        const active = bridge.themeState
        const fallback = {
            generation: active.generation + 1,
            requested: { kind: "external", name: "light" },
            effective: { kind: "builtin", name: "light" },
            fallbackReason: "requested_theme_unavailable",
            inventory: active.inventory,
            diagnostics: active.diagnostics,
            palette: null,
            projectTrusted: active.projectTrusted
        }
        if (!bridge.applyThemeState(fallback) || shell.externalThemeEffective
                || shell.themeStatusMessage().indexOf("unavailable") === -1) return fail("external theme fallback")
        log("QT_WEBUI_SMOKE_THEME_FALLBACK")
        const recovered = {
            generation: fallback.generation + 1,
            requested: { kind: "external", name: "light" },
            effective: { kind: "external", name: "light" },
            fallbackReason: "",
            inventory: active.inventory,
            diagnostics: active.diagnostics,
            palette: active.palette,
            projectTrusted: active.projectTrusted
        }
        if (!bridge.applyThemeState(recovered) || !shell.externalThemeEffective
                || String(shell.themeAccent).toLowerCase() !== "#654321") return fail("external theme recovery")
        log("QT_WEBUI_SMOKE_THEME_RECOVERED")
        schedule(themeOnly ? "quit" : "composer")
    }

    // Composer phase: command and path completion through the composer's own entry points (never
    // sending), an attachment carried by a prompt, a persisted draft, and a saved sequence that
    // runs from the sequences dialog and is then deleted with the two-step confirmation.
    function startComposer() {
        phase = "composer"
        composerStep = "commands"
        if (!bridge.loadCommands(response => {
            if (!response.ok || bridge.commands.length !== 3 || bridge.commands[0].name !== "review") return fail("commands list " + bridge.commands.length)
            log("QT_WEBUI_SMOKE_COMMANDS_LOADED")
            composerCommandCompletion()
        })) fail("commands request refused")
    }

    function composerCommandCompletion() {
        const composer = shell.composerItem
        composerStep = "command-completion"
        composer.setText("/rev")
        waitFor("command completion", () => composer.completionKind === "command" && composer.completions.length === 1, () => {
            if (!composer.acceptCurrentCompletion() || composer.text !== "/review " || composer.completionOpen) return fail("command completion text " + JSON.stringify(composer.text))
            log("QT_WEBUI_SMOKE_COMMAND_COMPLETED")
            composerPathCompletion()
        })
    }

    function composerPathCompletion() {
        const composer = shell.composerItem
        composerStep = "path-completion"
        composer.setText("look at @main")
        waitFor("path completion", () => composer.completionKind === "path" && composer.completions.length >= 1, () => {
            if (composer.completions[0].value !== "src/main.mjs") return fail("path suggestion " + composer.completions[0].value)
            if (!composer.acceptCurrentCompletion() || composer.text !== "look at @src/main.mjs " || composer.completionOpen) return fail("path completion text " + JSON.stringify(composer.text) + " kind=" + composer.completionKind + " query=" + composer.completionQuery + " index=" + composer.completionIndex + " cursor=" + composer.cursorPosition + " open=" + composer.completionOpen)
            log("QT_WEBUI_SMOKE_PATH_COMPLETED")
            composerCompletionRaces()
        })
    }

    function composerCompletionRaces() {
        const composer = shell.composerItem
        composer.setText("@main")
        const oldGeneration = composer.completionGeneration
        const oldResults = [{ value: "src/main.mjs" }]
        if (!composer.setCompletionResults(oldGeneration, oldResults, "")) return fail("completion setup")
        composer.setText("@missing")
        if (!composer.completionLoading || composer.completions.length !== 0 || composer.acceptCurrentCompletion()) return fail("stale completion stayed selectable")
        for (const key of [Qt.Key_Tab, Qt.Key_Return, Qt.Key_Enter]) {
            const event = { key: key, modifiers: Qt.NoModifier, accepted: false }
            composer.handleEditorKey(event)
            if (!event.accepted || composer.text !== "@missing") return fail("loading completion key " + key)
        }
        if (composer.setCompletionResults(oldGeneration, oldResults, "")) return fail("old completion reply accepted")
        composer.setText("@main")
        if (composer.setCompletionResults(oldGeneration, oldResults, "")) return fail("completion revisit accepted old generation")
        const generation = composer.completionGeneration
        composer.dismissCompletion()
        if (composer.setCompletionResults(generation, oldResults, "")) return fail("dismissed completion reopened")
        composer.setText("/rev")
        if (composer.setCompletionResults(generation, oldResults, "")) return fail("completion kind change accepted old reply")
        if (!composer.acceptCurrentCompletion() || composer.text !== "/review ") return fail("current command completion refused")
        log("QT_WEBUI_SMOKE_COMPLETION_GENERATIONS")
        composer.clearAndFocus()
        composerAttachment()
    }

    function composerAttachment() {
        const composer = shell.composerItem
        composerStep = "attachment"
        bridge.addAttachment(bridge.callerCwd + "/src/main.mjs", false)
        waitFor("attachment added", () => bridge.attachments.length === 1 && bridge.attachments[0].name === "main.mjs", () => {
            log("QT_WEBUI_SMOKE_ATTACHMENT_ADDED")
            composer.setText("__QT_WEBUI_IMMEDIATE__")
            composer.trySend("send")
            waitFor("attachment sent", () => bridge.attachments.length === 0 && !bridge.active && bridge.statusKind === "ready" && composer.text.length === 0, () => {
                const row = lastRowOfKind("user")
                if (!row || row.attachments !== "main.mjs") return fail("user row attachments " + (row ? row.attachments : "none"))
                log("QT_WEBUI_SMOKE_ATTACHMENT_SENT")
                composerDraft()
            })
        })
    }

    function composerDraft() {
        const composer = shell.composerItem
        composerStep = "draft"
        composer.setText("draft to keep")
        // The shell saves the draft 600 ms after the last edit; wait for that, then read it back.
        waitFor("draft delay", () => waitTicks >= 20, () => {
            bridge.loadDraft(response => {
                if (!response.ok || response.data.text !== "draft to keep") return fail("draft text " + JSON.stringify(response.data ? response.data.text : null))
                log("QT_WEBUI_SMOKE_DRAFT_PERSISTED")
                composer.clearAndFocus()
                bridge.saveDraft("")
                composerSequences()
            })
        })
    }

    function composerSequences() {
        composerStep = "sequences"
        bridge.saveSequence("", "Smoke sequence", ["__QT_WEBUI_IMMEDIATE__", "queued follow-up"], response => {
            if (!response.ok) return fail("sequence save")
            if (!shell.openSequences()) return fail("sequences dialog refused")
            const dialog = shell.sequencesDialog
            waitFor("sequences listed", () => dialog.opened && dialog.count === 1, () => {
                if (!dialog.runCurrent()) return fail("sequence run refused")
                waitFor("sequence finished", () => !dialog.opened && !bridge.active && bridge.statusKind === "ready", () => {
                    log("QT_WEBUI_SMOKE_SEQUENCE_RUN")
                    shell.openSequences()
                    waitFor("sequences reopened", () => dialog.opened && dialog.count === 1, () => {
                        if (!dialog.deleteCurrent() || !dialog.confirmingDelete || dialog.count !== 1) return fail("delete must ask for confirmation")
                        if (!dialog.deleteCurrent()) return fail("delete confirmation refused")
                        waitFor("sequence deleted", () => dialog.count === 0, () => {
                            log("QT_WEBUI_SMOKE_SEQUENCE_DELETED")
                            dialog.close()
                            composerStep = ""
                            schedule("models")
                        })
                    })
                })
            })
        })
    }

    // Global session phase: settle and restore a saved session, collapse and expand the bottom
    // section, open the saved session in a new tab, then reuse that tab from the same row.
    function catalogSession(sessionId) {
        for (const session of bridge.sessionCatalog) if (String(session.id) === sessionId) return session
        return null
    }

    function finishScreenshotSetup() {
        bridge.visibleError = ""
        bridge.clearNotices()
        shell.noticeBarItem.message = ""
        log("QT_WEBUI_SCREENSHOT_READY")
    }

    function startScreenshot() {
        phase = "screenshot"
        waitFor("screenshot session catalog", () => !bridge.sessionCatalogLoading && catalogSession("resume-me") !== null, () => {
            const target = catalogSession("resume-me")
            if (!target) return fail("screenshot session missing")
            if (target.settled === true) {
                finishScreenshotSetup()
                return
            }
            if (!bridge.setSessionSettled(target.path, true, response => {
                if (!response.ok) return fail("screenshot settle " + response.error.message)
                waitFor("screenshot settled row", () => {
                    const current = catalogSession("resume-me")
                    return current !== null && current.settled === true
                }, () => finishScreenshotSetup())
            })) fail("screenshot settle request refused")
        })
    }

    function checkWorkspaceSearch(target, settled) {
        const list = shell.sessionListItem
        const workingBefore = list.workingSessions.length
        const settledBefore = list.settledSessions.length
        list.searchQuery = "  RESUMABLE SMOKE  "
        const matches = settled ? list.settledSessions : list.workingSessions
        const otherMatches = settled ? list.workingSessions : list.settledSessions
        if (matches.length !== 1 || String(matches[0].id) !== String(target.id) || otherMatches.length !== 0) {
            fail("workspace search match " + list.workingSessions.length + "/" + list.settledSessions.length)
            return false
        }
        list.searchQuery = "no-workspace-has-this-title"
        if (list.workingSessions.length !== 0 || list.settledSessions.length !== 0) {
            fail("workspace search empty result")
            return false
        }
        list.searchQuery = "   "
        if (list.workingSessions.length !== workingBefore || list.settledSessions.length !== settledBefore) {
            fail("workspace search whitespace clear")
            return false
        }
        list.searchQuery = ""
        return true
    }

    function checkSessionAgeLabels() {
        const list = shell.sessionListItem
        const hourMs = 60 * 60 * 1000
        const dayMs = 24 * hourMs
        const now = new Date(2026, 7, 31, 12, 0, 0).getTime()
        const oldModified = new Date(2025, 0, 9, 12, 0, 0).getTime()
        if (list.sessionAgeLabel({ modified: now - 22 * hourMs }, now) !== "22h") return fail("session age hours")
        if (list.sessionAgeLabel({ modified: now - 7 * dayMs }, now) !== "7d") return fail("session age days")
        if (list.sessionAgeLabel({ modified: now - 30 * dayMs }, now) !== "30d") return fail("session age 30 day boundary")
        if (list.sessionAgeLabel({ modified: oldModified }, now) !== "09.01.2025") return fail("session age calendar date")
        if (list.sessionAgeLabel({}, now) !== "") return fail("temporary session age")
        return true
    }

    function checkSessionActivitySortGrace() {
        const list = shell.sessionListItem
        const minuteMs = 60 * 1000
        const now = new Date(2026, 7, 31, 12, 0, 0).getTime()
        const initialRows = [
            { path: "/sessions/first.jsonl", id: "first", modified: now - minuteMs },
            { path: "/sessions/second.jsonl", id: "second", modified: now - 2 * minuteMs }
        ]
        const initial = list.deferredSessionOrder(initialRows, ({}), now)
        const activeRows = [
            { path: "/sessions/second.jsonl", id: "second", modified: now },
            initialRows[0]
        ]
        const held = list.deferredSessionOrder(activeRows, initial.committedByKey, now + 5 * minuteMs - 1)
        if (held.sessions.map(session => session.id).join(",") !== "first,second") return fail("session ordering grace")
        const released = list.deferredSessionOrder(activeRows, held.committedByKey, now + 5 * minuteMs)
        if (released.sessions.map(session => session.id).join(",") !== "second,first") return fail("session ordering release")

        const restartedRows = [Object.assign({}, activeRows[0], { modified: now + 4 * minuteMs }), initialRows[0]]
        const restarted = list.deferredSessionOrder(restartedRows, initial.committedByKey, now + 4 * minuteMs)
        const stillHeld = list.deferredSessionOrder(restartedRows, restarted.committedByKey, now + 5 * minuteMs)
        if (stillHeld.sessions.map(session => session.id).join(",") !== "first,second") return fail("session ordering grace restart")
        const removed = list.deferredSessionOrder([initialRows[0]], stillHeld.committedByKey, now + 5 * minuteMs)
        if (Object.keys(removed.committedByKey).length !== 1) return fail("session ordering state pruning")
        return true
    }

    function startDraftOwnershipChecks() {
        phase = "draft-ownership"
        waitFor("saved draft owner", () => bridge.ready && bridge.draftKey.length > 0
                && bridge.draftKey === bridge.tabs.find(tab => tab.id === bridge.activeTabId)?.draftFile
                && bridge.tabs.find(tab => tab.id === bridge.activeTabId)?.mutating === false && waitTicks >= 8, () => {
            const savedKey = bridge.draftKey
            shell.composerItem.setText("saved edit just before close")
            bridge.closeTab(bridge.activeTabId, false, response => {
                if (!response.ok) return fail("saved tab close refused: " + JSON.stringify(response.error))
                bridge.request("draft_get", { key: savedKey }, draft => {
                    if (!draft.ok || draft.data.text !== "saved edit just before close") return fail("saved tab close lost pending edit")
                    log("QT_WEBUI_DRAFT_SAVED_CLOSE")
                    openFirstUnsavedDraft()
                })
            })
        })
    }

    function openFirstUnsavedDraft() {
        bridge.openTab("", "", response => {
            if (!response.ok) return fail("first unsaved tab refused")
            waitFor("first unsaved ready", () => bridge.ready && bridge.draftKey.startsWith("draft:"), () => {
                const firstTab = bridge.activeTabId
                const firstKey = bridge.draftKey
                shell.composerItem.setText("unsaved A")
                bridge.openTab("", "", second => {
                    if (!second.ok) return fail("second unsaved tab refused")
                    waitFor("second unsaved ready", () => bridge.ready && bridge.draftKey.startsWith("draft:")
                            && bridge.activeTabId !== firstTab, () => {
                        const secondKey = bridge.draftKey
                        if (firstKey === secondKey) return fail("two unsaved tabs shared a draft owner")
                        shell.composerItem.setText("unsaved B")
                        bridge.selectTab(firstTab, selected => {
                            if (!selected.ok) return fail("first unsaved selection refused")
                            waitFor("first unsaved draft restored", () => shell.composerItem.text === "unsaved A", () => {
                                bridge.selectTab(second.data.tab.id, back => {
                                    if (!back.ok) return fail("second unsaved selection refused")
                                    waitFor("second unsaved draft restored", () => shell.composerItem.text === "unsaved B", () => {
                                        log("QT_WEBUI_DRAFT_TWO_UNSAVED")
                                        promoteInactiveDraft(firstTab, firstKey, secondKey)
                                    })
                                })
                            })
                        })
                    })
                })
            })
        })
    }

    function promoteInactiveDraft(firstTab, firstKey, secondKey) {
        const first = bridge.tabs.find(tab => tab.id === firstTab)
        if (!first || !first.sessionFile || first.draftFile) return fail("inactive tab not temporary")
        const file = first.sessionFile
        bridge.request("draft_set", { key: file, text: "older file draft" }, saved => {
            if (!saved.ok) return fail("older file draft refused")
            bridge.request("prompt", { tab: firstTab, message: "__QT_WEBUI_SAVE_FIRST__", mode: "send" }, response => {
                if (!response.ok) return fail("inactive save prompt refused")
                waitFor("inactive filename promotion", () => bridge.tabs.find(tab => tab.id === firstTab)?.draftFile === file, () => {
                    bridge.request("draft_get", { key: file }, draft => {
                        if (!draft.ok || draft.data.text !== "unsaved A" || shell.composerItem.text !== "unsaved B"
                                || bridge.draftKey !== secondKey) return fail("inactive promotion discarded or moved a draft")
                        bridge.request("draft_get", { key: firstKey }, old => {
                            if (!old.ok || old.data.text !== "") return fail("inactive promotion retained a duplicate temporary draft")
                            log("QT_WEBUI_DRAFT_INACTIVE_PROMOTION")
                            schedule("quit")
                        })
                    })
                })
            }, false)
        })
    }

    function startRecoveryChecks() {
        waitFor("recovery catalog", () => bridge.sessionCatalog.some(session => session.id === "resume-me"), () => {
            const target = bridge.sessionCatalog.find(session => session.id === "resume-me").path
            const missing = bridge.workspaceCwd + "/missing-recovery.jsonl"
            function blocked(action) {
                bridge.switchSession(missing, response => {
                    if (!response.ok || !bridge.restartProcess()) return driver.fail("could not prepare missing-session recovery")
                    waitFor("missing-session recovery", () => bridge.canRecover && !bridge.ready, action)
                })
            }
            blocked(() => {
                if (bridge.sendPrompt("__QT_WEBUI_IMMEDIATE__", "send") || !shell.openSessionsPicker()) return driver.fail("blocked tab admitted a prompt or hid Sessions")
                waitFor("recovery picker", () => shell.pickerDialog.opened, () => {
                    shell.pickerDialog.close()
                    bridge.switchSession(target, response => {
                        if (!response.ok) return driver.fail("recovery switch refused")
                        waitFor("recovered session ready", () => bridge.ready && !bridge.canRecover && !bridge.resourceLoading && !bridge.activeTab.mutating, () => {
                            driver.log("QT_WEBUI_RECOVERY_SWITCH")
                            blocked(() => {
                                if (bridge.sendPrompt("__QT_WEBUI_IMMEDIATE__", "send")) return driver.fail("blocked tab sent a prompt")
                                bridge.newSession(response => {
                                    if (!response.ok) return driver.fail("recovery new session refused")
                                    waitFor("new session ready", () => bridge.ready && !bridge.canRecover && bridge.sessionFile !== missing, () => {
                                        driver.log("QT_WEBUI_RECOVERY_NEW")
                                        driver.schedule("quit")
                                    })
                                })
                            })
                        })
                    })
                })
            })
        })
    }

    function startSessionCatalog() {
        phase = "sessions"
        waitFor("global session catalog", () => !bridge.sessionCatalogLoading && catalogSession("resume-me") !== null, () => {
            const target = catalogSession("resume-me")
            if (!target || target.settled === true) return fail("initial session catalog")
            if (!shell.sessionListItem.settledExpanded) return fail("settled section was not expanded by default")
            if (!checkSessionAgeLabels()) return
            log("QT_WEBUI_SMOKE_SESSION_AGE_LABELS")
            if (!checkSessionActivitySortGrace()) return
            log("QT_WEBUI_SMOKE_SESSION_SORT_GRACE")
            if (!checkWorkspaceSearch(target, false)) return
            log("QT_WEBUI_SMOKE_SESSION_CATALOG_LOADED")
            if (!bridge.setSessionSettled(target.path, true, response => {
                if (!response.ok) return fail("session settle " + response.error.message)
                waitFor("session settled", () => {
                    const current = catalogSession("resume-me")
                    return current !== null && current.settled === true
                }, () => {
                    const settledTarget = catalogSession("resume-me")
                    if (!checkWorkspaceSearch(settledTarget, true)) return
                    log("QT_WEBUI_SMOKE_WORKSPACE_SEARCH_FILTERED")
                    log("QT_WEBUI_SMOKE_SESSION_SETTLED")
                    if (shell.sessionListItem.toggleSettled() !== false) return fail("settled section collapse")
                    log("QT_WEBUI_SMOKE_SETTLED_COLLAPSED")
                    if (shell.sessionListItem.toggleSettled() !== true) return fail("settled section expand")
                    log("QT_WEBUI_SMOKE_SETTLED_EXPANDED")
                    if (!bridge.setSessionSettled(settledTarget.path, false, response => {
                        if (!response.ok) return fail("session restore " + response.error.message)
                        waitFor("session restored to working", () => {
                            const current = catalogSession("resume-me")
                            return current !== null && current.settled !== true
                        }, () => {
                            log("QT_WEBUI_SMOKE_SESSION_RESTORED")
                            resumeCatalogSessionInNewTab()
                        })
                    })) fail("session restore request refused")
                })
            })) fail("session settle request refused")
        })
    }

    function resumeCatalogSessionInNewTab() {
        const firstTab = bridge.activeTabId
        const before = bridge.tabCount
        const target = catalogSession("resume-me")
        if (!target || !shell.openCatalogSession(target)) return fail("catalog new-tab resume refused")
        waitFor("catalog session new tab", () => bridge.tabCount === before + 1 && bridge.activeTabId !== firstTab && bridge.sessionFile.indexOf("resume-me") !== -1 && bridge.transcriptModel.count === 5 && bridge.ready, () => {
            const resumedTab = bridge.activeTabId
            log("QT_WEBUI_SMOKE_SESSION_NEW_TAB_RESUMED")
            if (!bridge.selectTab(firstTab)) return fail("catalog original tab select refused")
            waitFor("catalog original tab", () => bridge.activeTabId === firstTab && bridge.ready, () => {
                const current = catalogSession("resume-me")
                if (!current || !shell.openCatalogSession(current)) return fail("catalog existing-tab resume refused")
                waitFor("catalog existing tab", () => bridge.activeTabId === resumedTab && bridge.tabCount === before + 1 && bridge.ready && !bridge.resourceLoading, () => {
                    log("QT_WEBUI_SMOKE_SESSION_EXISTING_TAB_REUSED")
                    if (!bridge.closeTab(resumedTab, false)) return fail("catalog resumed tab close refused")
                    waitFor("catalog resumed tab closed", () => bridge.tabCount === before && bridge.activeTabId === "" && !shell.hasActiveSession, () => {
                        log("QT_WEBUI_SMOKE_EMPTY_SESSION_STATE")
                        if (!bridge.selectTab(firstTab)) return fail("catalog original tab reselect refused")
                        waitFor("catalog original tab reselected", () => bridge.activeTabId === firstTab && bridge.ready, () => schedule("tabs"))
                    })
                })
            })
        })
    }

    // Tabs phase: a second tab in another folder, work there, switch back and see the first tab's
    // transcript replayed, resume a persisted session from the picker, start a new session, open
    // a third tab through the directory dialog, create a worktree behind its confirmation, then
    // close every extra tab so the exit and restart phases see one tab again.
    // The smoke workspace name contains "</b>", so the sibling folder is derived from the
    // fixture state file, which lives directly in the temporary directory.
    function smokeSiblingDirectory(name) {
        const statePath = String(Quickshell.env("QT_WEBUI_SMOKE_STATE_PATH") || "")
        return statePath.slice(0, statePath.lastIndexOf("/")) + "/" + name
    }

    function startTabs() {
        phase = "tabs"
        const firstTab = bridge.activeTabId
        const firstRows = bridge.transcriptModel.count
        if (!bridge.openTab(smokeSiblingDirectory("other"), "")) return fail("tab open refused")
        waitFor("second tab", () => bridge.tabCount === 2 && bridge.activeTabId !== firstTab && bridge.ready && bridge.transcriptModel.count === 0, () => {
            const secondTab = bridge.activeTabId
            if (bridge.workspaceCwd.indexOf("/other") === -1 || bridge.displayCwd.indexOf("other") === -1) return fail("second tab workspace " + bridge.workspaceCwd)
            if (!bridge.resourcesAvailable && !bridge.resourceLoading && !bridge.refreshResources()) return fail("second tab resource refresh refused")
            waitFor("second tab initial resources", () => bridge.activeTabId === secondTab && bridge.resourcesAvailable && !bridge.resourceLoading, () => {
                tabsPickerInvalidation(firstTab, secondTab, firstRows)
            })
        })
    }

    function tabsPickerInvalidation(firstTab, secondTab, firstRows) {
        log("QT_WEBUI_SMOKE_TAB_OPENED")
        if (!shell.openModelPicker() || !shell.modelPickerLoading) return fail("tab-switch model picker did not start loading")
        const staleGeneration = shell.modelPickerGeneration
        if (!bridge.selectTab(firstTab)) return fail("picker tab-switch request refused")
        waitFor("picker tab invalidation", () => bridge.activeTabId === firstTab && bridge.ready, () => {
            if (shell.modelPickerLoading || shell.thinkingPickerLoading || shell.modelDropUp.opened || shell.thinkingDropUp.opened
                    || shell.modelPickerGeneration === staleGeneration) return fail("tab switch did not invalidate composer pickers")
            if (shell.modelPickerResult(secondTab, staleGeneration, { ok: true, data: { models: [], omitted: 0 } }) || shell.modelDropUp.opened) return fail("stale tab model result presented")
            log("QT_WEBUI_SMOKE_TAB_PICKER_INVALIDATED")
            log("QT_WEBUI_SMOKE_TAB_PICKER_LOADING_RECOVERED")
            if (!bridge.selectTab(secondTab)) return fail("picker second tab reselect refused")
            waitFor("picker second tab restored", () => bridge.activeTabId === secondTab && bridge.ready && bridge.resourcesAvailable && !bridge.resourceLoading, () => {
                tabsSecondPrompt(firstTab, secondTab, firstRows)
            })
        })
    }

    function tabsSecondPrompt(firstTab, secondTab, firstRows) {
        bridge.sendPrompt("__QT_WEBUI_IMMEDIATE__", "send")
        waitFor("second tab prompt", () => !bridge.active && bridge.statusKind === "ready" && lastRowOfKind("user") !== null, () => {
            const staleBeforeRead = bridge.staleResponses
            if (!bridge.refreshResources() || !bridge.selectTab(firstTab)) return fail("delayed resource read switch refused")
            waitFor("stale resource read", () => bridge.activeTabId === firstTab && bridge.staleResponses > staleBeforeRead, () => {
                log("QT_WEBUI_SMOKE_STALE_RESOURCE_READ_IGNORED")
                waitFor("first tab resources", () => bridge.ready && bridge.resourcesAvailable && bridge.resourceState.profiles.session.sampling.top_k === 55, () => {
                    if (!bridge.selectTab(secondTab)) return fail("second tab reselect refused")
                    waitFor("second tab resources", () => bridge.activeTabId === secondTab && bridge.ready && bridge.resourcesAvailable && !bridge.resourceLoading, () => {
                        const staleBeforeMutation = bridge.staleResponses
                        if (!bridge.setEnabledTools("session", ["write"]) || !bridge.selectTab(firstTab)) return fail("delayed resource mutation switch refused")
                        waitFor("stale resource mutation", () => bridge.activeTabId === firstTab && bridge.staleResponses > staleBeforeMutation, () => {
                            log("QT_WEBUI_SMOKE_STALE_RESOURCE_MUTATION_IGNORED")
                            waitFor("first tab replayed", () => bridge.ready && bridge.transcriptModel.count === firstRows && bridge.resourcesAvailable && bridge.resourceState.profiles.session.tools === null, () => {
                                if (bridge.workspaceCwd !== bridge.callerCwd) return fail("first tab workspace " + bridge.workspaceCwd)
                                if (lastRowOfKind("user") === null || lastRowOfKind("user").text !== "queued follow-up") return fail("first tab rows " + (lastRowOfKind("user") ? lastRowOfKind("user").text : "none"))
                                log("QT_WEBUI_SMOKE_TAB_SWITCHED")
                                tabsSessions(firstTab)
                            })
                        })
                    })
                })
            })
        })
    }

    function tabsSessions(firstTab) {
        if (!shell.openSessionsPicker()) return fail("sessions picker refused")
        const picker = shell.pickerDialog
        waitFor("sessions picker", () => picker.opened && picker.items.length >= 1, () => {
            let target = ""
            for (const item of picker.items) if (String(item.value).indexOf("resume-me") !== -1) target = String(item.value)
            if (target.length === 0 || !picker.pickValue(target)) return fail("resume-me session missing")
            waitFor("session resumed", () => bridge.sessionName === "Resumed session" && bridge.transcriptModel.count === 5 && !bridge.active && bridge.ready, () => {
                const tool = lastRowOfKind("tool")
                if (!tool || tool.toolOutput !== "file contents" || tool.toolStatus !== "ok") return fail("resumed tool row")
                log("QT_WEBUI_SMOKE_SESSION_RESUMED")
                if (!bridge.newSession()) return fail("new session refused")
                waitFor("new session", () => bridge.transcriptModel.count === 0 && bridge.sessionFile.indexOf("fixture-session-1") !== -1 && bridge.ready, () => {
                    log("QT_WEBUI_SMOKE_SESSION_NEW")
                    tabsDirectory(firstTab)
                })
            })
        })
    }

    function tabsDirectory(firstTab) {
        if (!shell.openDirectoryPicker()) return fail("directory picker refused")
        const dialog = shell.directoryDialog
        const workspace = bridge.workspaceCwd
        // "<b>project</b>" is really two nested folders, so Up lands in "<b>project<"; the
        // temporary directory that holds "other" is then entered by direct path entry.
        const temporary = smokeSiblingDirectory("").slice(0, -1)
        waitFor("directory listing", () => dialog.opened && dialog.currentPath === workspace && !dialog.loading, () => {
            if (!dialog.up()) return fail("directory up refused")
            waitFor("parent listing", () => dialog.currentPath !== workspace && !dialog.loading && dialog.history.length === 1, () => {
                if (!dialog.navigateTo(temporary, true)) return fail("direct path entry refused")
                waitFor("temporary listing", () => dialog.currentPath === temporary && !dialog.loading && dialog.entries.length >= 2, () => {
                if (!dialog.enterNamed("other")) return fail("directory entry missing")
                waitFor("entered other", () => dialog.currentPath.indexOf("/other") !== -1 && !dialog.loading, () => {
                    if (!dialog.choose() || dialog.opened) return fail("directory choose")
                    waitFor("third tab", () => bridge.tabCount === 3 && bridge.ready && bridge.workspaceCwd.indexOf("/other") !== -1, () => {
                        log("QT_WEBUI_SMOKE_DIRECTORY_PICKED")
                        tabsWorktree(firstTab)
                    })
                })
                })
            })
        })
    }

    function tabsWorktree(firstTab) {
        if (!bridge.selectTab(firstTab)) return fail("tab select refused")
        waitFor("first tab again", () => bridge.activeTabId === firstTab && bridge.ready, () => {
            if (!shell.planWorktree()) return fail("worktree dialog refused")
            waitFor("worktree dialog", () => shell.worktreeDialog.opened, () => {
                shell.worktreeDialog.setFields("smoke", "branch")
                if (shell.worktreeDialog.branch !== "smoke/branch") return fail("worktree split fields " + shell.worktreeDialog.branch)
                if (!shell.worktreeDialog.valid) return fail("worktree split validation " + shell.worktreeDialog.problem)
                if (!shell.worktreeDialog.submit()) return fail("worktree dialog submit refused")
                waitFor("worktree confirmation", () => shell.confirmDialog.opened, () => {
                    if (shell.confirmDialog.detail.indexOf("-smoke-branch") === -1) return fail("worktree path " + shell.confirmDialog.detail)
                    if (!shell.confirmDialog.confirm()) return fail("worktree confirm refused")
                    waitFor("worktree tab", () => bridge.tabCount === 4 && bridge.workspaceCwd.indexOf("-smoke-branch") !== -1 && bridge.ready, () => {
                        log("QT_WEBUI_SMOKE_WORKTREE_CREATED")
                        tabsClose(firstTab)
                    })
                })
            })
        })
    }

    function tabsClose(firstTab) {
        const extras = bridge.tabs.filter(tab => tab.id !== firstTab).map(tab => tab.id)
        const closeNext = () => {
            if (extras.length === 0) {
                if (bridge.activeTabId !== firstTab && !bridge.selectTab(firstTab)) return fail("final original tab reselect refused")
                waitFor("single tab", () => bridge.tabCount === 1 && bridge.activeTabId === firstTab && bridge.ready, () => {
                    log("QT_WEBUI_SMOKE_TAB_CLOSED")
                    phase = "tabs-done"
                    startPalette()
                })
                return
            }
            const id = extras.shift()
            const before = bridge.tabCount
            if (!shell.closeTab(id)) return fail("close tab refused")
            waitFor("tab closed", () => bridge.tabCount === before - 1, closeNext)
        }
        closeNext()
    }

    // Palette phase: usage statistics, a palette action picked through the picker's own entry
    // points (never sending), the events view with a filter, and the diagnostics report.
    function startPalette() {
        phase = "palette"
        waitFor("usage loaded", () => bridge.usage !== null && bridge.usage.context && bridge.usage.context.percent === 30 && bridge.usage.tokens.total === 105000, () => {
            if (!shell.statusGroups.some(group => group.name === "Usage" && group.entries.some(entry => entry.label === "context" && entry.value === "30%"))) return fail("usage segment")
            log("QT_WEBUI_SMOKE_USAGE_LOADED")
            const wasShowingThinking = bridge.showThinking
            if (!shell.openPalette()) return fail("palette refused")
            const picker = shell.pickerDialog
            waitFor("palette groups", () => picker.opened && picker.items.some(item => item.group === "Model") && picker.items.some(item => item.group === "Pi command") && picker.items.some(item => item.group === "Skill"), () => {
                picker.setFilter(wasShowingThinking ? "Hide thinking sections" : "Show thinking sections")
                if (picker.visibleCount !== 1 || picker.visibleItems[0].value !== "action:toggle-thinking") return fail("palette filter " + picker.visibleCount)
                if (!picker.pickCurrent()) return fail("palette pick refused")
                waitFor("palette action", () => bridge.showThinking !== wasShowingThinking && bridge.recentActions.indexOf("action:toggle-thinking") === 0, () => {
                    log("QT_WEBUI_SMOKE_PALETTE_ACTION")
                    if (!shell.openPalette()) return fail("palette reopen refused")
                    waitFor("palette recents", () => picker.opened && picker.items.length > 0 && picker.items[0].group === "Recent" && picker.items[0].value === "action:toggle-thinking", () => {
                        picker.close()
                        paletteEvents()
                    })
                })
            })
        })
    }

    function paletteEvents() {
        if (!shell.openEvents()) return fail("events refused")
        const events = shell.eventsDialog
        waitFor("events listed", () => events.opened && events.count > 0, () => {
            const total = events.count
            events.setLevel("error")
            if (events.count >= total || !events.entries.every(entry => entry.level === "error")) return fail("events filter " + events.count + "/" + total)
            events.setLevel("all")
            if (!events.copyAll()) return fail("events copy")
            log("QT_WEBUI_SMOKE_EVENTS_LISTED")
            events.close()
            if (!shell.openDiagnostics()) return fail("diagnostics refused")
            const diagnostics = shell.diagnosticsDialog
            waitFor("diagnostics report", () => diagnostics.opened && diagnostics.data !== null && diagnostics.report.indexOf("Backend: running, pid") !== -1 && diagnostics.report.indexOf("Tabs (1)") !== -1, () => {
                log("QT_WEBUI_SMOKE_DIAGNOSTICS_SHOWN")
                diagnostics.close()
                schedule("exit")
            })
        })
    }

    // Models phase: open the real picker from the model inventory, pick through its own entry
    // points, cycle both values, then compact. Each step waits for the bridge state it changes.
    function startModels() {
        phase = "models"
        modelStep = orderOnly ? "order-picker" : "active-popup"
        if (!shell.openModelPicker()) return fail("model picker request refused")
    }

    function checkModelOrdering() {
        const picker = shell.modelDropUp
        if (!picker.opened || picker.reorderable || picker.items.length !== 3) return fail("unscoped model list unexpectedly enabled ordering")
        if (picker.items[0].value !== "fixture-provider/fixture-model" || picker.currentIndex !== 0 || picker.items[0].current !== true) return fail("initial model order or selection")
        // The fixture's default list is intentionally unscoped. Enable the reusable picker seam
        // only inside this smoke scenario; shell gating for explicit scopes is covered statically.
        picker.reorderable = true
        bridge.modelOrder = ["absent-provider/absent-model"]
        const fullScope = []
        for (let index = 0; index < bridge.maxModels; index++) fullScope.push("bulk/provider-" + index)
        const bounded = bridge.mergedModelOrder(fullScope)
        if (bounded.length !== bridge.maxModels || bounded[0] !== "bulk/provider-0" || bounded[bridge.maxModels - 1] !== "bulk/provider-255" || bounded.indexOf("absent-provider/absent-model") !== -1) return fail("current model identities did not win the saved-order bound")
        if (!picker.reorderEnabled) return fail("smoke reorder seam was not enabled")
        picker.setFilter("fixture")
        if (picker.reorderEnabled || picker.moveCurrentItem(1)) return fail("filtered model reorder was enabled")
        picker.setFilter("")
        picker.focusOptions()
        if (!picker.optionsFocused || !picker.handleOptionListKey(Qt.Key_Down, Qt.ControlModifier | Qt.ShiftModifier)) return fail("keyboard model reorder was not handled")
        if (!picker.opened || picker.currentIndex !== 1 || picker.items[0].value !== "fixture-provider/fixture-fast" || picker.items[1].value !== "fixture-provider/fixture-model" || picker.items[1].current !== true) return fail("completed model reorder changed selection or popup state")
        log("QT_WEBUI_SMOKE_MODEL_REORDER_COMPLETED")
        modelStep = "order-save"
        waitFor("model order save", () => bridge.modelOrder.length === 4 && bridge.modelOrder[0] === "fixture-provider/fixture-fast" && bridge.modelOrder[1] === "fixture-provider/fixture-model" && bridge.modelOrder[2] === "other-provider/other-model" && bridge.modelOrder[3] === "absent-provider/absent-model", () => {
            log("QT_WEBUI_SMOKE_MODEL_REORDER_SAVED")
            const sourceModels = picker.items.map(item => {
                const slash = String(item.value).indexOf("/")
                return { provider: String(item.value).slice(0, slash), id: String(item.value).slice(slash + 1) }
            }).reverse()
            const reapplied = bridge.orderedModelData({ scope: { explicit: true }, models: sourceModels })
            if (reapplied.models.length !== 3 || reapplied.models[0].id !== "fixture-fast" || reapplied.models[1].id !== "fixture-model" || reapplied.models[2].id !== "other-model") return fail("saved model order was not reapplied")
            log("QT_WEBUI_SMOKE_MODEL_REORDER_REAPPLIED")
            picker.close()
            log("QT_WEBUI_SMOKE_COMPLETE")
            bridge.shutdown()
        })
    }

    function checkActiveModelPicker() {
        const picker = shell.modelDropUp
        if (!picker.opened) return fail("model drop-up did not open before active invalidation")
        const popupGeneration = shell.modelPickerGeneration
        const originTab = bridge.activeTabId
        bridge.active = true
        if (picker.opened || shell.modelPickerLoading || shell.thinkingPickerLoading || shell.modelPickerGeneration === popupGeneration) return fail("active run did not invalidate open composer pickers")
        bridge.active = false
        if (shell.modelPickerResult(originTab, popupGeneration, { ok: true, data: { models: [], omitted: 0 } }) || picker.opened) return fail("stale model result presented after active invalidation")
        log("QT_WEBUI_SMOKE_ACTIVE_PICKER_INVALIDATED")
        log("QT_WEBUI_SMOKE_STALE_PICKER_RESULT_REFUSED")

        modelStep = "pending-active"
        if (!shell.openModelPicker() || !shell.modelPickerLoading) return fail("pending model picker was not loading")
        const pendingGeneration = shell.modelPickerGeneration
        bridge.active = true
        if (shell.modelPickerLoading || shell.thinkingPickerLoading || picker.opened || shell.modelPickerGeneration === pendingGeneration) return fail("active run did not recover picker loading flags")
        bridge.active = false
        if (shell.modelPickerResult(originTab, pendingGeneration, { ok: true, data: { models: [], omitted: 0 } }) || picker.opened) return fail("pending stale model result presented")
        log("QT_WEBUI_SMOKE_PICKER_LOADING_RECOVERED")
    }

    function startFinalModelPicker() {
        modelStep = "picker"
        if (!shell.openModelPicker()) fail("final model picker request refused")
    }

    function checkModelPicker() {
        const picker = shell.modelDropUp
        if (!picker.opened || picker.items.length !== 3) return fail("model drop-up items " + picker.items.length)
        if (picker.items[0].current !== true) return fail("current model not marked")
        if (!picker.focusedOnOpen) return fail("model drop-up focus")
        if (picker.x < picker.edgeMargin || picker.x + picker.width > picker.boundsItem.width - picker.edgeMargin + 0.5
                || picker.y < picker.edgeMargin || picker.y + picker.height > picker.anchorPosition.y - picker.anchorGap + 0.5) return fail("model drop-up bounds x=" + picker.x + " y=" + picker.y + " w=" + picker.width + " h=" + picker.height + " bounds=" + picker.boundsItem.width + "x" + picker.boundsItem.height + " anchor=" + picker.anchorPosition.x + "," + picker.anchorPosition.y)
        log("QT_WEBUI_SMOKE_MODEL_DROPUP_BOUNDED")
        if (picker.currentIndex !== 0) return fail("initial model selection index " + picker.currentIndex)
        picker.focusOptions()
        if (!picker.optionsFocused || !picker.handleOptionListKey(Qt.Key_Down) || picker.currentIndex !== 1) return fail("model list arrow selection " + picker.currentIndex)
        log("QT_WEBUI_SMOKE_REAL_LIST_ARROW_SELECTION")
        log("QT_WEBUI_SMOKE_MODEL_PICKER")
        modelStep = "select"
        if (!picker.handleOptionListKey(Qt.Key_Return)) return fail("model list Enter was not handled")
    }

    // Runtime events arrive before the request response, so every step waits until the bridge
    // has settled its pending model action before asking for the next change.
    function advanceModels() {
        if (phase !== "models" || bridge.modelActionPending) return
        if (modelStep === "select" && bridge.currentModelId === "fixture-fast" && bridge.currentThinkingLevel === "off") {
            modelStep = "model-focus"
            waitFor("model drop-up focus return", () => shell.modelDropUp.returnFocusItem.activeFocus, () => {
                log("QT_WEBUI_SMOKE_MODEL_DROPUP_FOCUS_RETURNED")
                log("QT_WEBUI_SMOKE_MODEL_SELECTED")
                modelStep = "thinking-picker"
                if (!shell.openThinkingPicker()) fail("thinking picker request refused")
            })
        } else if (modelStep === "cycle-model" && bridge.currentModelId === "other-model") {
            log("QT_WEBUI_SMOKE_MODEL_CYCLED")
            modelStep = "cycle-thinking"
            if (!bridge.cycleThinkingLevel()) fail("thinking cycle refused")
        } else if (modelStep === "cycle-thinking" && bridge.currentThinkingLevel === "minimal") {
            log("QT_WEBUI_SMOKE_THINKING_CYCLED")
            modelStep = "compact"
            if (!shell.compactContext()) fail("compaction refused")
        }
    }

    function checkThinkingPicker() {
        const picker = shell.thinkingDropUp
        if (!picker.opened || picker.items.length !== 1 || picker.items[0].value !== "off" || picker.items[0].current !== true) return fail("thinking picker for a model without thinking")
        if (!picker.focusedOnOpen) return fail("thinking drop-up focus")
        if (picker.x < picker.edgeMargin || picker.x + picker.width > picker.boundsItem.width - picker.edgeMargin + 0.5
                || picker.y < picker.edgeMargin || picker.y + picker.height > picker.anchorPosition.y - picker.anchorGap + 0.5) return fail("thinking drop-up bounds x=" + picker.x + " y=" + picker.y + " w=" + picker.width + " h=" + picker.height + " bounds=" + picker.boundsItem.width + "x" + picker.boundsItem.height + " anchor=" + picker.anchorPosition.x + "," + picker.anchorPosition.y)
        log("QT_WEBUI_SMOKE_THINKING_DROPUP_BOUNDED")
        log("QT_WEBUI_SMOKE_THINKING_PICKER")
        modelStep = "thinking-focus"
        // Picking the current level closes the picker; the bridge treats it as a no-op.
        if (!picker.pickValue("off") || picker.opened) return fail("thinking pick did not close the picker")
        waitFor("thinking drop-up focus return", () => picker.returnFocusItem.activeFocus, () => {
            log("QT_WEBUI_SMOKE_THINKING_DROPUP_FOCUS_RETURNED")
            modelStep = "cycle-model"
            if (!bridge.cycleModel()) fail("model cycle refused")
        })
    }

    // Resource phase: drive the real dialog through all three scopes. Tools intentionally select
    // none, skills send enabled names, and sampling proves a value survives a model capability loss.
    function startResources() {
        phase = "resources"
        const dialog = shell.resourceProfilesDialog
        if (!shell.openResourceProfiles()) return fail("resource profiles refused")
        waitFor("resource profiles", () => dialog.opened && dialog.available && dialog.controlsEnabled && dialog.visibleCount === 3, () => {
            if (dialog.effectiveSource("tools") !== "Pi defaults" || dialog.listSummary(null) !== "Pi defaults" || dialog.listSummary([]) !== "Intentionally none") return fail("resource inheritance labels")
            log("QT_WEBUI_SMOKE_RESOURCES_LOADED")
            dialog.setScope("global")
            dialog.setSection("tools")
            if (!dialog.chooseNone() || !dialog.saveCurrent(response => {
                if (!response.ok || bridge.resourceState.effective.toolsSource !== "global" || bridge.resourceState.effective.tools.length !== 0) return fail("global tool profile")
                log("QT_WEBUI_SMOKE_RESOURCE_TOOLS_NONE")
                resourceSkills()
            })) fail("global tool save refused")
        })
    }

    function resourceSkills() {
        const dialog = shell.resourceProfilesDialog
        dialog.setScope("model")
        dialog.setSection("skills")
        if (!dialog.chooseNone() || !dialog.toggleName("review") || !dialog.saveCurrent(response => {
            if (!response.ok || bridge.resourceState.effective.skillsSource !== "model" || bridge.resourceState.effective.skills.length !== 1 || bridge.resourceState.effective.skills[0] !== "review") return fail("model skill profile")
            log("QT_WEBUI_SMOKE_RESOURCE_SKILLS_ENABLED")
            resourceSampling()
        })) fail("model skill save refused")
    }

    function resourceSampling() {
        const dialog = shell.resourceProfilesDialog
        dialog.setScope("session")
        dialog.setSection("sampling")
        if (!dialog.samplingSupported("top_k") || !dialog.setSamplingValue("temperature", "0.4") || !dialog.setSamplingValue("top_k", "55")) return fail("supported sampling edit")
        if (!dialog.saveCurrent(response => {
            if (!response.ok || bridge.resourceState.effective.samplingSources.top_k !== "session" || bridge.resourceState.sampling.applied.top_k !== 55) return fail("session sampling profile")
            log("QT_WEBUI_SMOKE_RESOURCE_SAMPLING_SAVED")
            if (!bridge.selectModel("fixture-provider", "fixture-model")) return fail("capability-loss model change refused")
            waitFor("unsupported sampling preservation", () => !bridge.modelActionPending && bridge.currentModelId === "fixture-model" && bridge.resourcesAvailable && bridge.resourceState.model.id === "fixture-model", () => {
                if (dialog.samplingSupported("top_k") || dialog.samplingStored("top_k") !== 55 || dialog.samplingEffective("top_k") !== 55) return fail("unsupported sampling was not preserved")
                if (bridge.resourceState.sampling.applied.top_k !== undefined || dialog.samplingReason("top_k").length === 0) return fail("unsupported sampling was applied or has no reason")
                log("QT_WEBUI_SMOKE_RESOURCE_UNSUPPORTED_PRESERVED")
                dialog.close()
                schedule("sessions")
            })
        })) fail("session sampling save refused")
    }

    Timer {
        id: actionTimer
        interval: 40
        repeat: false
        onTriggered: {
            const action = driver.nextAction
            driver.nextAction = ""
            switch (action) {
            case "stream":
                if (!driver.bridge.ready || driver.bridge.resourceLoading) {
                    driver.waitFor("stable initial ready state", () => driver.bridge.ready && !driver.bridge.resourceLoading, () => driver.schedule("stream"))
                    break
                }
                if (driver.bridge.visibleError === "Unknown error") return driver.fail("generic startup error")
                driver.log("QT_WEBUI_SMOKE_STARTUP_ERROR_MAPPED")
                driver.phase = "stream"
                if (!driver.bridge.sendPrompt("__QT_WEBUI_STREAM__", "send")) driver.fail("initial stream prompt refused")
                break
            case "markdown":
                driver.phase = "markdown"
                driver.bridge.sendPrompt("__QT_WEBUI_MARKDOWN__", "send")
                break
            case "accept-link":
                if (!driver.shell.linkDialogOpened) return driver.fail("link dialog did not open")
                driver.shell.acceptLink()
                break
            case "search":
                driver.checkSearch()
                break
            case "immediate":
                driver.phase = "immediate"
                driver.bridge.sendPrompt("__QT_WEBUI_IMMEDIATE__", "send")
                break
            case "provider-error":
                driver.phase = "provider-error"
                driver.bridge.sendPrompt("__QT_WEBUI_PROVIDER_ERROR__", "send")
                break
            case "failure":
                driver.phase = "failure"
                driver.bridge.sendPrompt("__QT_WEBUI_FAIL__", "send")
                break
            case "abort":
                driver.phase = "abort"
                driver.bridge.sendPrompt("__QT_WEBUI_DELAYED_ABORT__", "send")
                driver.schedule("abort-before-start")
                break
            case "abort-before-start":
                driver.bridge.abortRun()
                break
            case "limits":
                driver.phase = "limits"
                driver.bridge.sendPrompt("__QT_WEBUI_LIMITS__", "send")
                break
            case "settings":
                driver.phase = "settings"
                if (!driver.bridge.compactTranscript) return driver.fail("compact layout must ignore the legacy false setting")
                driver.bridge.updateSetting("showThinking", false)
                break
            case "composer":
                driver.startComposer()
                break
            case "models":
                driver.startModels()
                break
            case "sessions":
                driver.startSessionCatalog()
                break
            case "tabs":
                driver.startTabs()
                break
            case "check-model-ordering":
                driver.checkModelOrdering()
                break
            case "check-active-model-picker":
                driver.checkActiveModelPicker()
                break
            case "start-final-model-picker":
                driver.startFinalModelPicker()
                break
            case "check-model-picker":
                driver.checkModelPicker()
                break
            case "check-thinking-picker":
                driver.checkThinkingPicker()
                break
            case "exit":
                driver.phase = "exit"
                driver.bridge.sendPrompt("__QT_WEBUI_EXIT__", "send")
                break
            case "restart-failed":
                driver.phase = "restart-failed"
                driver.bridge.restartProcess()
                break
            case "restart-missing":
                driver.phase = "restart-missing"
                driver.bridge.restartProcess()
                break
            case "restart-recovered":
                driver.phase = "restart-recovered"
                driver.bridge.restartProcess()
                break
            case "backend-crash":
                driver.phase = "backend-crash"
                driver.bridge.request("debug_crash", {}, () => {})
                break
            case "backend-restart":
                driver.phase = "backend-restart"
                driver.bridge.restartProcess()
                break
            case "quit":
                driver.log("QT_WEBUI_SMOKE_COMPLETE")
                driver.bridge.shutdown()
                break
            default:
                break
            }
        }
    }

    Connections {
        target: driver.bridge

        function onBackendBecameReady() {
            if (!driver.backendReadyOnce) {
                driver.backendReadyOnce = true
                driver.log("QT_WEBUI_SMOKE_BACKEND_READY")
            } else if (driver.phase === "backend-restart") {
                driver.log("QT_WEBUI_SMOKE_BACKEND_RESTARTED")
            }
        }

        function onBackendExited(exitCode) {
            if (driver.phase === "backend-crash" && exitCode === 70) {
                driver.crashObserved = true
                driver.log("QT_WEBUI_SMOKE_BACKEND_CRASH_OBSERVED")
                driver.schedule("backend-restart")
            } else {
                driver.fail("unexpected backend exit " + exitCode)
            }
        }

        function onReadyChanged() {
            if (!driver.bridge.ready) return
            if (!driver.piReadyOnce) {
                driver.piReadyOnce = true
                driver.log("QT_WEBUI_SMOKE_READY")
                if (driver.remediationOnly) remediation.run()
                else if (driver.draftOwnershipOnly) driver.startDraftOwnershipChecks()
                else if (driver.recoveryOnly) driver.startRecoveryChecks()
                else if (driver.screenshotOnly) driver.startScreenshot()
                else if (driver.orderOnly) driver.startModels()
                else if (driver.themeOnly) driver.startThemeChecks()
                else driver.schedule("stream")
            } else if (driver.phase === "restart-recovered") {
                driver.log("QT_WEBUI_SMOKE_RESTART_RECEIPT")
                driver.schedule("backend-crash")
            } else if (driver.phase === "backend-restart") {
                driver.log("QT_WEBUI_SMOKE_BACKEND_CRASH_RECOVERED")
                driver.schedule("quit")
            }
        }

        function onActiveChanged() {
            if (driver.phase === "immediate" && !driver.bridge.active && driver.bridge.statusKind === "ready") {
                driver.log("QT_WEBUI_SMOKE_IMMEDIATE_PROMPT_RECONCILED")
                driver.phase = "immediate-done"
                driver.schedule("provider-error")
            }
        }

        function onVisibleErrorChanged() {
            const error = driver.bridge.visibleError
            if (driver.phase === "failure" && error === "deterministic prompt rejection") {
                driver.log("QT_WEBUI_SMOKE_FAILED_RESPONSE_RECOVERED")
                driver.phase = "failure-done"
                driver.schedule("abort")
            } else if (driver.phase === "restart-failed" && error === "deterministic startup state failure") {
                driver.log("QT_WEBUI_SMOKE_FAILED_STATE_RECOVERABLE")
                driver.schedule("restart-missing")
            } else if (driver.phase === "restart-missing" && error === "Pi did not report readiness in time") {
                driver.log("QT_WEBUI_SMOKE_MISSING_STATE_RECOVERABLE")
                driver.schedule("restart-recovered")
            }
        }

        function onStatusTextChanged() {
            const text = driver.bridge.statusText
            if (driver.phase === "exit" && text === "Pi exited (23)") {
                driver.phase = "exit-done"
                driver.schedule("restart-failed")
            } else if (driver.phase === "restart-failed" && text === "Starting…") {
                driver.log("QT_WEBUI_SMOKE_FAILED_STATE_RESTART")
            } else if (driver.phase === "restart-missing" && text === "Starting…") {
                driver.log("QT_WEBUI_SMOKE_MISSING_STATE_RESTART")
            }
        }

        function onRunEnded(ok, aborted) {
            switch (driver.phase) {
            case "stream":
                driver.checkStreamPhase()
                break
            case "markdown":
                driver.checkMarkdownPhase()
                break
            case "provider-error":
                if (driver.bridge.statusKind !== "error" || driver.bridge.visibleError.indexOf("deterministic provider failure") !== 0
                        || driver.bridge.visibleError.length > driver.bridge.maxErrorCharacters || ok) return driver.fail("provider error preservation")
                driver.log("QT_WEBUI_SMOKE_PROVIDER_ERROR_PRESERVED")
                driver.schedule("failure")
                break
            case "abort":
                if (!aborted) return driver.fail("delayed abort was not honored")
                driver.log("QT_WEBUI_SMOKE_DELAYED_ABORT_RECEIPT")
                driver.schedule("limits")
                break
            case "limits": {
                let withinLimit = true
                for (let index = 0; index < driver.bridge.transcriptModel.count; index++) {
                    if (driver.bridge.transcriptModel.get(index).text.length > driver.bridge.maxMessageCharacters) withinLimit = false
                }
                if (driver.bridge.transcriptModel.count > driver.bridge.maxTranscriptRows || !withinLimit) return driver.fail("transcript bounds")
                driver.log("QT_WEBUI_SMOKE_TRANSCRIPT_BOUNDED rows=" + driver.bridge.transcriptModel.count)
                driver.schedule("settings")
                break
            }
            default:
                break
            }
        }

        function onShowThinkingChanged() {
            if (driver.phase === "settings" && !driver.bridge.showThinking) {
                driver.log("QT_WEBUI_SMOKE_SETTINGS_PERSISTED")
                driver.startAppearanceChecks()
            }
        }

        function onAppearanceModeChanged() {
            if (driver.phase === "appearance-light" && driver.bridge.appearanceMode === "light" && !driver.shell.themeDark) {
                driver.log("QT_WEBUI_SMOKE_THEME_LIGHT_OVERRIDE")
                driver.phase = "appearance-dark"
                driver.bridge.updateSetting("appearanceMode", "dark")
            } else if (driver.phase === "appearance-dark" && driver.bridge.appearanceMode === "dark" && driver.shell.themeDark) {
                driver.log("QT_WEBUI_SMOKE_THEME_DARK_OVERRIDE")
                driver.phase = "appearance-reduced"
                driver.bridge.updateSetting("reducedMotion", true)
            } else if (driver.phase === "appearance-automatic" && driver.bridge.appearanceMode === "automatic" && driver.shell.themeDark) {
                driver.log("QT_WEBUI_SMOKE_THEME_AUTOMATIC")
                driver.phase = "appearance-restore-motion"
                driver.bridge.updateSetting("reducedMotion", false)
            }
        }

        function onReducedMotionChanged() {
            if (driver.phase === "appearance-reduced" && driver.bridge.reducedMotion && driver.shell.themeAnimationDuration === 0) {
                driver.log("QT_WEBUI_SMOKE_REDUCED_MOTION")
                driver.phase = "appearance-automatic"
                driver.bridge.updateSetting("appearanceMode", "automatic")
            } else if (driver.phase === "appearance-restore-motion" && !driver.bridge.reducedMotion && driver.shell.themeAnimationDuration > 0) {
                driver.startThemeChecks()
            }
        }

        function onCurrentModelIdChanged() {
            driver.advanceModels()
        }

        function onCurrentThinkingLevelChanged() {
            driver.advanceModels()
        }

        function onModelActionPendingChanged() {
            driver.advanceModels()
        }

        function onCompactionFinished(ok) {
            if (driver.phase !== "models" || driver.modelStep !== "compact") return
            if (!ok || driver.bridge.active || driver.bridge.compacting) return driver.fail("compaction result")
            driver.log("QT_WEBUI_SMOKE_CONTEXT_COMPACTED")
            driver.modelStep = ""
            driver.startResources()
        }

        function onModelsLoaded(data) {
            if (driver.phase !== "models") return
            if (driver.modelStep === "order-picker") driver.schedule("check-model-ordering")
            else if (driver.modelStep === "active-popup") driver.schedule("check-active-model-picker")
            else if (driver.modelStep === "pending-active") driver.schedule("start-final-model-picker")
            else if (driver.modelStep === "picker") driver.schedule("check-model-picker")
        }

        function onThinkingLevelsLoaded(data) {
            if (driver.phase === "models" && driver.modelStep === "thinking-picker") driver.schedule("check-thinking-picker")
        }

        function onDialogRequested(dialog) {
            if (!driver.remediationOnly) dialogAnswerTimer.start()
        }
    }

    Timer {
        id: dialogAnswerTimer
        interval: 30
        repeat: false
        onTriggered: driver.answerDialog(driver.shell.extensionDialog)
    }

    Connections {
        target: driver.shell

        function onLinkOpenResult(url, response) {
            if (driver.linkConfirmed) return
            if (!response.ok || url !== "https://example.com/docs") return driver.fail("link confirmation")
            driver.linkConfirmed = true
            driver.log("QT_WEBUI_SMOKE_LINK_CONFIRMED")
            driver.schedule("search")
        }
    }

    Component.onCompleted: {
        log("QT_WEBUI_SMOKE_THEME_" + (shell.themeDark ? "DARK" : "LIGHT"))
    }
}
