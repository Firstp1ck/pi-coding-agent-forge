import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Prompt editor with explicit run modes: Send while idle; Steer, Follow-up, and Abort while a run
// is active; Restart while Pi is unavailable. The editor stays usable during a run so queued
// messages can be prepared. It also hosts attachment chips and the inline completion list for
// `/` commands and `@` workspace paths; accepting a completion only edits the text.
Rectangle {
    id: composer

    required property QtObject theme
    property alias text: prompt.text
    readonly property Item runActionButton: primaryButton
    property bool active: false
    property bool ready: false
    property bool processRunning: false
    property int maxCharacters: 8192
    property int maxAttachments: 8
    property var attachments: []
    property var lockedAttachmentIds: []
    property var completions: []
    property string completionKind: ""
    property string completionQuery: ""
    property string completionEmptyText: ""
    property string suppressedCompletion: ""
    property string completionIdentity: ""
    property int completionGeneration: 0
    property int completionResultGeneration: -1
    property bool completionLoading: false
    property string busyPromptMode: "steer"
    readonly property bool compactActions: width < 450
    readonly property bool overLimit: prompt.text.length > maxCharacters
    readonly property bool hasText: prompt.text.trim().length > 0 && !overLimit
    readonly property bool completionOpen: completionLoading || completionPopup.visible
    readonly property int completionIndex: completionPopup.currentIndex
    readonly property int cursorPosition: prompt.cursorPosition

    signal sendRequested(string text, string mode)
    signal abortRequested()
    signal restartRequested()
    signal attachRequested()
    signal attachmentRemoveRequested(string attachmentId)
    signal attachmentEditRequested(string attachmentId)
    signal completionRequested(string kind, string query, int generation)
    signal draftEdited(string text)

    readonly property real implicitMinimumWidth: Math.max(260, busyPromptActionButton.implicitWidth + primaryButton.implicitWidth + 2 * theme.controlHeight + 2 * theme.spaceXl + 3 * theme.spaceSm)
    implicitHeight: column.implicitHeight + theme.space4Xl
    radius: theme.radiusLarge
    color: theme.composerSurface
    border.width: theme.borderWidth
    border.color: prompt.activeFocus ? theme.focusRing : theme.composerBorder

    Behavior on border.color {
        ColorAnimation { duration: composer.theme.animationDuration }
    }

    function trySend(mode) {
        const value = prompt.text.trim()
        if (!ready || value.length === 0 || overLimit) return
        if (mode === "send" && active) return
        if ((mode === "steer" || mode === "followUp") && !active) mode = "send"
        sendRequested(value, mode)
    }

    function toggleBusyPromptMode() {
        busyPromptMode = busyPromptMode === "steer" ? "followUp" : "steer"
    }

    function clearAndFocus() {
        prompt.text = ""
        dismissCompletion()
        prompt.forceActiveFocus()
    }

    function focusEditor() {
        prompt.forceActiveFocus()
    }

    function setText(value) {
        prompt.text = String(value || "")
        prompt.cursorPosition = prompt.text.length
        prompt.forceActiveFocus()
    }

    // ---- completion --------------------------------------------------------------------------

    // The token under the cursor decides the completion kind: a leading "/" while the cursor is
    // still inside the first word means a command; a word starting with "@" means a path.
    function completionContext() {
        const value = prompt.text
        const cursor = prompt.cursorPosition
        if (value.startsWith("/")) {
            const firstSpace = value.search(/\s/)
            const end = firstSpace === -1 ? value.length : firstSpace
            if (cursor <= end) return { kind: "command", query: value.slice(1, cursor), start: 0, end: end }
        }
        let start = cursor
        while (start > 0 && !/\s/.test(value[start - 1])) start--
        const token = value.slice(start, cursor)
        if (token.startsWith("@")) return { kind: "path", query: token.slice(1), start: start, end: cursor }
        return { kind: "", query: "", start: 0, end: 0 }
    }

    function contextIdentity(context) {
        return JSON.stringify([context.kind, context.query, context.start, context.end])
    }

    function invalidateCompletion() {
        completionGeneration++
        completionResultGeneration = -1
        completionLoading = false
        completionIdentity = ""
        completionKind = ""
        completionQuery = ""
        completions = []
        completionEmptyText = ""
    }

    function refreshCompletion() {
        const context = completionContext()
        const identity = contextIdentity(context)
        if (context.kind.length === 0 || identity === suppressedCompletion) {
            if (context.kind.length === 0) suppressedCompletion = ""
            if (completionKind.length > 0) {
                invalidateCompletion()
                completionRequested("", "", completionGeneration)
            }
            return
        }
        suppressedCompletion = ""
        if (identity === completionIdentity) return
        // Drop selectable results before emitting a request or starting its debounce.
        invalidateCompletion()
        completionIdentity = identity
        completionKind = context.kind
        completionQuery = context.query
        completionLoading = true
        completionEmptyText = "Loading suggestions…"
        completionRequested(context.kind, context.query, completionGeneration)
    }

    function setCompletionResults(generation, items, emptyText) {
        if (generation !== completionGeneration || completionKind.length === 0
                || completionIdentity !== contextIdentity(completionContext())) return false
        completions = items
        completionResultGeneration = generation
        completionLoading = false
        completionEmptyText = emptyText
        return true
    }

    function dismissCompletion() {
        const context = completionContext()
        suppressedCompletion = context.kind.length > 0 ? contextIdentity(context) : ""
        invalidateCompletion()
    }

    // Replaces the token under the cursor with the chosen suggestion. Never sends.
    function acceptCompletion(index) {
        const context = completionContext()
        if (completionLoading || completionResultGeneration !== completionGeneration
                || completionIdentity !== contextIdentity(context)
                || context.kind.length === 0 || index < 0 || index >= completions.length) return false
        const item = completions[index]
        const replacement = context.kind === "command"
            ? "/" + String(item.value) + " "
            : "@" + String(item.value) + (item.directory === true ? "/" : " ")
        const value = prompt.text
        prompt.text = value.slice(0, context.start) + replacement + value.slice(context.end)
        prompt.cursorPosition = context.start + replacement.length
        suppressedCompletion = ""
        refreshCompletion()
        return true
    }

    function acceptCurrentCompletion() {
        const index = completionPopup.currentIndex >= 0 ? completionPopup.currentIndex : (completions.length > 0 ? 0 : -1)
        return acceptCompletion(index)
    }

    function handleEditorKey(event) {
        if (composer.completionOpen) {
            if (event.key === Qt.Key_Down) {
                completionPopup.move(1)
                event.accepted = true
                return
            }
            if (event.key === Qt.Key_Up) {
                completionPopup.move(-1)
                event.accepted = true
                return
            }
            if (event.key === Qt.Key_Escape) {
                composer.dismissCompletion()
                event.accepted = true
                return
            }
            if ((event.key === Qt.Key_Tab || event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && event.modifiers === Qt.NoModifier) {
                composer.acceptCurrentCompletion()
                event.accepted = true
                return
            }
        }
        const enter = event.key === Qt.Key_Return || event.key === Qt.Key_Enter
        if (!enter) return
        if (event.modifiers & Qt.ShiftModifier) return
        if (event.modifiers & Qt.AltModifier) composer.trySend(composer.active ? "followUp" : "send")
        else composer.trySend(composer.active ? composer.busyPromptMode : "send")
        event.accepted = true
    }

    function revealAttachment(button) {
        const view = attachmentViewport.contentItem
        const top = button.mapToItem(chipFlow, 0, 0).y
        if (top < view.contentY) view.contentY = top
        else if (top + button.height > view.contentY + view.height)
            view.contentY = top + button.height - view.height
    }

    function sizeLabel(bytes) {
        const size = Number(bytes) || 0
        if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + " MiB"
        if (size >= 1024) return Math.round(size / 1024) + " KiB"
        return size + " B"
    }

    ColumnLayout {
        id: column
        anchors.fill: parent
        anchors.margins: composer.theme.spaceXl
        spacing: composer.theme.spaceSm + 1

        RowLayout {
            Layout.fillWidth: true

            SelectableText {
                theme: composer.theme
                text: "PROMPT"
                color: composer.theme.muted
                font.family: composer.theme.monospaceFamily
                font.pixelSize: composer.theme.typeCaption
                font.bold: true
                font.letterSpacing: composer.theme.labelTracking
                Accessible.role: Accessible.StaticText
                Accessible.name: "Prompt editor"
            }

            Item { Layout.fillWidth: true }

            SelectableText {
                theme: composer.theme
                text: composer.active ? (composer.busyPromptMode === "steer" ? "STEER" : "FOLLOW-UP") : "READY"
                color: composer.active ? composer.theme.accentForeground : composer.theme.success
                font.family: composer.theme.monospaceFamily
                font.pixelSize: composer.theme.typeCaption
                font.bold: true
                font.letterSpacing: composer.theme.labelTracking
                Accessible.role: Accessible.StaticText
                Accessible.name: composer.active ? "Prompt mode " + composer.busyPromptMode : "Prompt ready"
            }
        }

        CompletionPopup {
            id: completionPopup
            Layout.fillWidth: true
            theme: composer.theme
            items: composer.completions
            kind: composer.completionKind
            emptyText: composer.completionEmptyText
            onAccepted: index => composer.acceptCompletion(index)
        }

        ScrollView {
            Layout.fillWidth: true
            Layout.preferredHeight: 84
            clip: true

            TextArea {
                id: prompt
                placeholderText: composer.ready ? (composer.active ? "Steer or queue a follow-up…" : "Ask Pi… ( / commands, @ paths )") : "Waiting for Pi…"
                enabled: composer.ready
                wrapMode: TextEdit.Wrap
                textFormat: TextEdit.PlainText
                selectByMouse: true
                focus: true
                color: composer.theme.foreground
                placeholderTextColor: composer.theme.muted
                font.family: composer.theme.monospaceFamily
                selectionColor: composer.theme.selection
                background: null
                Accessible.role: Accessible.EditableText
                Accessible.name: "Prompt"
                Accessible.description: composer.completionOpen ? "Suggestions are open: Up and Down choose, Tab or Enter completes without sending, Escape closes"
                    : composer.active ? (composer.busyPromptMode === "steer" ? "Enter steers the current run" : "Enter queues a follow-up") + ", Alt+Enter always queues a follow-up, Shift+Enter inserts a new line"
                    : "Enter sends the prompt, Shift+Enter inserts a new line"
                KeyNavigation.tab: primaryButton
                onTextChanged: {
                    composer.refreshCompletion()
                    composer.draftEdited(text)
                }
                onCursorPositionChanged: composer.refreshCompletion()
                Keys.onPressed: event => composer.handleEditorKey(event)
            }
        }

        // Keep the editor and run actions in view even with the full eight attachments.
        ScrollView {
            id: attachmentViewport
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(chipFlow.childrenRect.height, composer.theme.controlHeight * 2 + composer.theme.spaceMd)
            visible: composer.attachments.length > 0
            clip: true
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            Flow {
                id: chipFlow
                width: attachmentViewport.availableWidth
                height: childrenRect.height
                spacing: composer.theme.spaceSm
                Accessible.role: Accessible.Grouping
                Accessible.name: composer.attachments.length + " attachments"

                Repeater {
                    model: composer.attachments

                    delegate: Rectangle {
                        id: chip
                        required property var modelData
                        implicitWidth: chipRow.implicitWidth + composer.theme.spaceXl
                        width: Math.min(implicitWidth, parent ? parent.width : implicitWidth)
                        implicitHeight: chipRow.implicitHeight + composer.theme.spaceMd
                        radius: composer.theme.radiusSmall
                        color: composer.theme.surfaceRaised
                        border.width: composer.theme.borderWidth
                        border.color: composer.theme.border
                        Accessible.role: Accessible.Grouping
                        Accessible.name: "Attachment " + String(modelData.name) + ", " + String(modelData.kind) + ", " + composer.sizeLabel(modelData.size) + (modelData.edited ? ", edited" : "")

                        RowLayout {
                            id: chipRow
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.leftMargin: composer.theme.spaceSm
                            anchors.rightMargin: composer.theme.spaceSm
                            spacing: composer.theme.spaceSm

                            SelectableText {
                                Layout.fillWidth: true
                                Layout.minimumWidth: 48
                                Layout.maximumWidth: 240
                                theme: composer.theme
                                text: String(chip.modelData.kind === "image" ? "🖼 " : "📄 ") + String(chip.modelData.name)
                                color: composer.theme.foreground
                                font.family: composer.theme.monospaceFamily
                                font.pixelSize: composer.theme.typeBody
                            }

                            SelectableText {
                                visible: !composer.compactActions
                                Layout.maximumWidth: 76
                                theme: composer.theme
                                text: composer.sizeLabel(chip.modelData.size) + (chip.modelData.edited ? " · edited" : "")
                                color: composer.theme.muted
                                font.family: composer.theme.monospaceFamily
                                font.pixelSize: composer.theme.typeSmall
                            }

                            AppButton {
                                visible: chip.modelData.kind === "text"
                                enabled: composer.lockedAttachmentIds.indexOf(String(chip.modelData.id)) === -1
                                theme: composer.theme
                                variant: "ghost"
                                text: "Edit"
                                accessibleName: "Edit attachment " + String(chip.modelData.name)
                                padding: 2
                                leftPadding: 6
                                rightPadding: 6
                                onActiveFocusChanged: if (activeFocus) composer.revealAttachment(this)
                                onClicked: composer.attachmentEditRequested(String(chip.modelData.id))
                            }

                            AppButton {
                                theme: composer.theme
                                variant: "ghost"
                                text: "Remove"
                                enabled: composer.lockedAttachmentIds.indexOf(String(chip.modelData.id)) === -1
                                accessibleName: "Remove attachment " + String(chip.modelData.name)
                                padding: 2
                                leftPadding: 6
                                rightPadding: 6
                                onActiveFocusChanged: if (activeFocus) composer.revealAttachment(this)
                                onClicked: composer.attachmentRemoveRequested(String(chip.modelData.id))
                            }
                        }
                    }
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: composer.theme.spaceMd

            SelectableText {
                Layout.fillWidth: true
                theme: composer.theme
                wrapMode: TextEdit.Wrap
                text: composer.overLimit ? "Prompt exceeds " + composer.maxCharacters + " characters"
                    : composer.active ? "Pi is working · Enter " + (composer.busyPromptMode === "steer" ? "steers" : "queues a follow-up") + " · Alt+Enter queues a follow-up · Shift+Enter new line"
                    : composer.ready ? "Enter to send · Shift+Enter for a new line" : "Pi is not available"
                color: composer.overLimit ? composer.theme.destructive : composer.theme.muted
                font.family: composer.theme.monospaceFamily
                font.pixelSize: composer.theme.typeBody
            }

            SelectableText {
                visible: prompt.text.length > composer.maxCharacters * 0.8
                theme: composer.theme
                text: prompt.text.length + " / " + composer.maxCharacters
                color: composer.overLimit ? composer.theme.destructive : composer.theme.muted
                font.family: composer.theme.monospaceFamily
                font.pixelSize: composer.theme.typeSmall
            }

        }

        RowLayout {
            Layout.fillWidth: true
            spacing: composer.theme.spaceSm

            Item { Layout.fillWidth: true }

            AppButton {
                id: busyPromptModeButton
                visible: composer.ready && !composer.compactActions
                theme: composer.theme
                variant: "ghost"
                text: composer.busyPromptMode === "steer" ? "Steer mode" : "Follow-up mode"
                accessibleName: composer.busyPromptMode === "steer" ? "Busy prompt mode: Steer" : "Busy prompt mode: Follow-up"
                accessibleDescription: composer.busyPromptMode === "steer" ? "Click to make Enter and the run action queue follow-ups" : "Click to make Enter and the run action steer"
                active: composer.busyPromptMode === "followUp"
                Accessible.checked: composer.busyPromptMode === "followUp"
                onClicked: composer.toggleBusyPromptMode()
            }

            AppButton {
                id: busyPromptActionButton
                visible: composer.active && composer.ready && !composer.compactActions
                theme: composer.theme
                variant: "primary"
                text: composer.busyPromptMode === "steer" ? "Steer" : "Queue"
                accessibleName: composer.busyPromptMode === "steer" ? "Send as steering message" : "Queue as follow-up"
                enabled: composer.hasText
                onClicked: composer.trySend(composer.busyPromptMode)
            }

            AppButton {
                id: attachButton
                visible: composer.ready && !composer.compactActions
                theme: composer.theme
                variant: "ghost"
                text: "📎"
                accessibleName: "Attach files"
                accessibleDescription: "Opens the file picker; text files and images can be attached"
                enabled: composer.attachments.length < composer.maxAttachments
                Layout.preferredWidth: composer.theme.controlHeight
                leftPadding: composer.theme.spaceXs + 1
                rightPadding: composer.theme.spaceXs + 1
                onClicked: composer.attachRequested()
            }

            AppButton {
                visible: composer.compactActions && composer.ready
                theme: composer.theme
                variant: "ghost"
                text: "More"
                accessibleName: "More prompt actions"
                onClicked: compactMenu.open()

                Menu {
                    id: compactMenu
                    MenuItem {
                        text: composer.busyPromptMode === "steer" ? "Use follow-up mode" : "Use steer mode"
                        visible: composer.active
                        onTriggered: composer.toggleBusyPromptMode()
                    }
                    MenuItem {
                        text: composer.busyPromptMode === "steer" ? "Steer prompt" : "Queue follow-up"
                        visible: composer.active
                        enabled: composer.hasText
                        onTriggered: composer.trySend(composer.busyPromptMode)
                    }
                    MenuItem {
                        text: "Attach files"
                        enabled: composer.attachments.length < composer.maxAttachments
                        onTriggered: composer.attachRequested()
                    }
                }
            }

            AppButton {
                id: primaryButton
                theme: composer.theme
                variant: composer.active ? "destructive" : (composer.ready ? "primary" : "warning")
                text: composer.active ? "Abort" : (composer.ready ? "Send" : "Restart")
                accessibleName: composer.active ? "Abort the current run" : (composer.ready ? "Send prompt" : "Restart Pi")
                enabled: composer.active || !composer.ready || composer.hasText
                onClicked: {
                    if (composer.active) composer.abortRequested()
                    else if (!composer.ready) composer.restartRequested()
                    else composer.trySend("send")
                }
            }
        }
    }
}
