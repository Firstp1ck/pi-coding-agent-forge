import QtQuick

// Real Qt objects and signals, with the isolated fixture behind the ordinary JSONL bridge.
Item {
    id: checks
    required property var driver
    required property var bridge
    required property var shell
    property string originalKey: ""
    property string targetKey: ""

    function require(condition, message) {
        if (!condition) { driver.fail(message); throw new Error(message) }
    }

    function wait(description, condition, action) { driver.waitFor(description, condition, action) }

    function run() {
        driver.phase = "remediation"
        wait("initial projection", () => bridge.ready && shell.draftKeyInUse.length > 0, rejectPrompt)
    }

    function rejectPrompt() {
        const editor = shell.composerItem
        const pending = bridge.pendingRequestCount
        const serial = bridge.requestSerial
        bridge.pendingRequestCount = bridge.maxPendingRequests
        editor.setText("locally rejected text")
        editor.trySend("send")
        require(editor.text === "locally rejected text" && bridge.requestSerial === serial, "local saturation destroyed or sent text")
        bridge.pendingRequestCount = pending
        editor.setText("__QT_WEBUI_FAIL__")
        editor.trySend("send")
        require(editor.text === "__QT_WEBUI_FAIL__", "prompt cleared on admission")
        wait("prompt rejection", () => bridge.promptSubmissions.length === 0 && bridge.visibleError.indexOf("rejection") >= 0, () => {
            require(editor.text === "__QT_WEBUI_FAIL__", "rejected prompt lost")
            bridge.loadDraft(response => {
                require(response.ok && response.data.text === editor.text, "rejected prompt draft lost")
                delayedPrompt()
            })
        })
    }

    function delayedPrompt() {
        const editor = shell.composerItem
        editor.setText("__QT_WEBUI_ACCEPT_DELAY__")
        editor.trySend("send")
        editor.setText("newer unsent edit")
        wait("delayed acceptance", () => bridge.promptSubmissions.length === 0 && !bridge.active, () => {
            require(editor.text === "newer unsent edit", "late acceptance cleared a newer edit")
            editor.setText("__QT_WEBUI_ACCEPT_DELAY__")
            editor.trySend("send")
            const submission = bridge.promptSubmissions[0]
            bridge.pendingRequests[submission.id].deadline = 0
            bridge.sweepPending()
            require(submission.state === "unknown" && editor.text === "__QT_WEBUI_ACCEPT_DELAY__", "timeout destroyed text")
            require(!bridge.sendPrompt(editor.text, "send"), "unknown prompt resent")
            wait("late settlement after timeout", () => bridge.promptSubmissions.length === 0 && !bridge.active, () => {
                require(editor.text === "", "accepted matching draft was not cleared")
                driver.log("QT_WEBUI_REMEDIATION_PROMPTS")
                drafts()
            })
        })
    }

    function drafts() {
        const editor = shell.composerItem
        originalKey = bridge.draftKey
        targetKey = bridge.sessionCatalog.find(entry => entry.id === "resume-me").path
        bridge.saveDraftFor(targetKey, "draft B")
        editor.setText("draft A inside debounce")
        bridge.switchSession(targetKey + ".cancel-me.jsonl", response => {
            require(!response.ok && editor.text === "draft A inside debounce" && bridge.draftKey === originalKey, "cancelled replacement changed the draft")
            replaceDraft()
        })
    }

    function replaceDraft() {
        const editor = shell.composerItem
        bridge.switchSession(targetKey, response => {
            require(response.ok, "draft session switch refused")
            wait("replacement draft B", () => editor.text === "draft B", () => {
                bridge.request("draft_get", { key: originalKey }, result => {
                    require(result.data.text === "draft A inside debounce", "A saved under B key")
                    editor.setText("B newer edit")
                    bridge.newSession(next => {
                        require(next.ok, "new session refused")
                        require(bridge.sessionFile !== targetKey && bridge.draftKey !== targetKey, "new session retained its predecessor's draft owner")
                        wait("new draft blank", () => editor.text === "", () => {
                            bridge.switchSession(targetKey, back => {
                                require(back.ok, "return to B refused")
                                wait("return draft B", () => editor.text === "B newer edit", () => {
                                    driver.log("QT_WEBUI_REMEDIATION_DRAFTS")
                                    dialogs()
                                })
                            })
                        })
                    })
                })
            })
        })
    }

    function attachmentChecks() {
        bridge.addAttachment(bridge.callerCwd + "/src/main.mjs", false, response => {
            require(response.ok, "attachment add refused")
            const attachment = bridge.attachments[0]
            require(attachment.text === undefined, "attachment projection retained full text")
            shell.editAttachment(attachment.id)
            const editor = shell.attachmentEditor
            wait("fetched text editor", () => editor.opened, () => {
                require(editor.editedText.indexOf("export const") === 0, "attachment text not fetched")
                editor.setText("x".repeat(262144))
                editor.save()
                require(editor.opened && editor.failure.length > 0 && !editor.submitting, "unrepresentable edit lost")
                bridge.readAttachment(attachment.id, read => {
                    require(read.ok && read.data.text.indexOf("export const") === 0, "size rejection changed attachment")
                    editor.setText("valid edited text")
                    editor.save()
                    wait("accepted attachment edit", () => !editor.opened, () => {
                        driver.log("QT_WEBUI_REMEDIATION_ATTACHMENTS")
                        selectionChecks()
                    })
                })
            })
        })
    }

    function selectionChecks() {
        const a = bridge.activeTabId
        const file = bridge.sessionFile
        const rows = bridge.transcriptModel.count
        const attachmentId = bridge.attachments[0].id
        bridge.openTab(bridge.workspaceCwd, "", response => {
            require(response.ok, "second tab refused")
            const b = response.data.tab.id
            wait("second tab ready", () => bridge.ready, () => {
                const targets = [a, b, a]
                for (let i = 0; i < targets.length; i++) {
                    const last = i === targets.length - 1
                    bridge.request("tab_select", { tab: targets[i] }, selected => {
                        require(selected.ok, "batched selection refused")
                        bridge.applySnapshot(selected.data)
                        if (last) {
                            require(bridge.activeTabId === a && bridge.sessionFile === file, "old response changed selection identity")
                            require(bridge.transcriptModel.count === rows && rows > 0, "batched selection lost transcript")
                            require(bridge.attachments.length === 1 && bridge.attachments[0].id === attachmentId, "stale selection replaced attachments")
                            driver.log("QT_WEBUI_REMEDIATION_SELECTION")
                            searchChecks()
                        }
                    })
                }
            })
        })
    }

    function searchChecks() {
        const event = type => ({ type: type, tab: bridge.activeTabId, selectionGeneration: bridge.selectionGeneration })
        bridge.handleEvent(event("transcript.reset"))
        shell.openSearch("needle")
        bridge.appendRow({ rowId: "search-1", role: "assistant", kind: "text", text: "needle streamed", streaming: true })
        wait("search append", () => shell.searchMatchCount === 1, () => {
            bridge.setRow("search-1", { text: "no match" })
            require(shell.searchCurrentRow === -1, "search pointed at a changed nonmatching row")
            wait("search update", () => shell.searchMatchCount === 0, () => {
                bridge.handlePartRender({ partId: "search-1", text: "needle final", final: true })
                wait("search final", () => shell.searchMatchCount === 1, () => {
                    bridge.appendRow({ rowId: "search-2", role: "assistant", kind: "text", text: "needle second" })
                    bridge.appendRow({ rowId: "search-3", role: "assistant", kind: "text", text: "needle third" })
                    wait("search multiple", () => shell.searchMatchCount === 3, () => {
                        shell.searchNext()
                        require(shell.searchSelectedId === "search-2", "search selection did not preserve row identity")
                        const removal = event("part.remove"); removal.partId = "search-2"
                        bridge.handleEvent(removal)
                        wait("search removal", () => shell.searchMatchCount === 2, () => {
                            require(shell.searchSelectedId === "search-3", "search did not prefer the next surviving match")
                            bridge.handleEvent(event("transcript.reset"))
                            wait("search reset", () => shell.searchMatchCount === 0, () => {
                                const replay = event("transcript.row")
                                replay.row = { rowId: "search-replay", role: "user", kind: "user", text: "needle replay" }
                                bridge.handleEvent(replay)
                                wait("search replay", () => shell.searchMatchCount === 1, () => {
                                    for (let i = 0; i < bridge.maxTranscriptRows; i++) bridge.appendRow({ rowId: "eviction-" + i, role: "assistant", kind: "text", text: "not a match" })
                                    wait("search eviction", () => shell.searchMatchCount === 0, () => {
                                        require(shell.searchCurrentRow === -1 && shell.searchQuery === "needle", "evicted search row remained selected")
                                        driver.log("QT_WEBUI_REMEDIATION_SEARCH")
                                        // Quickshell must finish delegate incubation before engine destruction.
                                        wait("search rendering settled", () => driver.waitTicks >= 20, () => driver.schedule("quit"))
                                    })
                                })
                            })
                        })
                    })
                })
            })
        })
    }

    function dialogs() {
        bridge.sendPrompt("__QT_WEBUI_STREAM__", "send")
        const popup = shell.extensionDialog
        wait("dialog visible", () => popup.opened && popup.requestId === "dialog-select", () => {
            require(popup.submit({ confirmed: true }), "dialog admission refused")
            require(popup.opened, "dialog closed before settlement")
            wait("dialog rejection", () => popup.submissionState === "open" && popup.submissionError.length > 0, () => {
                require(popup.selectOption("Block"), "rejected dialog not actionable")
                wait("confirm dialog", () => popup.requestId === "dialog-confirm", () => {
                    popup.confirm(true)
                    wait("input dialog", () => popup.requestId === "dialog-input", () => {
                        popup.setInputText("x".repeat(bridge.maxDialogValueCharacters + 1))
                        require(!popup.submitText() && popup.opened, "oversized answer admitted")
                        popup.setInputText("kept answer")
                        require(popup.submitText(), "valid answer refused")
                        const id = Object.keys(bridge.pendingRequests).find(key => bridge.pendingRequests[key].type === "extension_response")
                        if (id) {
                            bridge.pendingRequests[id].deadline = 0
                            bridge.sweepPending()
                            require(popup.submissionState === "unknown" && popup.inputText === "kept answer", "dialog timeout lost text")
                            require(!popup.submitText(), "unknown dialog resent")
                        }
                        wait("editor dialog", () => popup.requestId === "dialog-editor", () => {
                            popup.setEditorText("editor to cancel")
                            const origin = bridge.activeTabId
                            bridge.openTab(bridge.workspaceCwd, "", opened => {
                                require(opened.ok, "dialog tab change refused")
                                bridge.selectTab(origin, selected => {
                                    require(selected.ok, "dialog origin selection refused")
                                    wait("dialog value after tab change", () => popup.opened && popup.requestId === "dialog-editor", () => {
                                        require(popup.inputText === "editor to cancel", "dialog value lost across tab change")
                                        wait("dialog restart admission", () => !bridge.active && !bridge.resourceLoading && !bridge.resourceActionPending && bridge.activeTab && !bridge.activeTab.mutating, () => {
                                            require(bridge.restartProcess(), "dialog restart refused locally")
                                            wait("cancelled popup", () => !popup.opened && bridge.ready, () => {
                                                driver.log("QT_WEBUI_REMEDIATION_DIALOGS")
                                                attachmentChecks()
                                            })
                                        })
                                    })
                                })
                            })
                        })
                    })
                })
            })
        })
    }
}
