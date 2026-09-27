import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

// Saved prompt sequences: a list view with run, load, reorder, and delete, and an edit view for
// the name and entries (one prompt per paragraph). Running only happens from the explicit Run
// action; deleting needs a second confirmation press and never runs anything.
AppDialog {
    id: dialog

    required property var bridge
    property var sequences: []
    property string mode: "list" // list | edit
    property string editingId: ""
    property bool confirmingDelete: false
    property bool busy: false
    readonly property int count: sequences.length
    readonly property var current: optionList.currentIndex >= 0 && optionList.currentIndex < count ? sequences[optionList.currentIndex] : null
    readonly property int maxEntries: 16

    signal ranSequence(string sequenceId)
    signal loadRequested(var entries)

    title: mode === "edit" ? (editingId.length > 0 ? "Edit sequence" : "New sequence") : "Prompt sequences"
    message: mode === "edit" ? "One prompt per paragraph; separate prompts with a blank line. The first prompt is sent, the rest are queued as follow-ups." : ""
    initialFocusItem: mode === "edit" ? nameField : optionList
    width: Math.min(parent ? parent.width - 40 : 640, 640)

    function present() {
        mode = "list"
        confirmingDelete = false
        busy = false
        refresh()
        open()
    }

    function refresh() {
        busy = true
        bridge.loadSequences(response => {
            busy = false
            if (!response.ok) return
            sequences = response.data.sequences
            if (optionList.currentIndex < 0 || optionList.currentIndex >= count) optionList.currentIndex = count > 0 ? 0 : -1
        })
    }

    function splitEntries(text) {
        return String(text).split(/\n\s*\n/).map(entry => entry.trim()).filter(entry => entry.length > 0).slice(0, maxEntries)
    }

    function startNew(prefill) {
        editingId = ""
        nameField.text = ""
        entriesArea.text = typeof prefill === "string" ? prefill : ""
        confirmingDelete = false
        mode = "edit"
        nameField.forceActiveFocus()
    }

    function startEdit() {
        const sequence = current
        if (!sequence) return false
        editingId = sequence.id
        nameField.text = sequence.name
        entriesArea.text = sequence.entries.join("\n\n")
        confirmingDelete = false
        mode = "edit"
        nameField.forceActiveFocus()
        return true
    }

    function saveEdit() {
        const name = nameField.text.trim()
        const entries = splitEntries(entriesArea.text)
        if (name.length === 0 || entries.length === 0 || busy) return false
        busy = true
        bridge.saveSequence(editingId, name, entries, response => {
            busy = false
            if (!response.ok) return
            sequences = response.data.sequences
            mode = "list"
            for (let index = 0; index < count; index++) if (sequences[index].id === response.data.sequence.id) optionList.currentIndex = index
            optionList.forceActiveFocus()
        })
        return true
    }

    function cancelEdit() {
        mode = "list"
        optionList.forceActiveFocus()
    }

    function runCurrent() {
        const sequence = current
        if (!sequence || busy || !bridge.ready || bridge.active) return false
        busy = true
        bridge.runSequence(sequence.id, response => {
            busy = false
            if (!response.ok) return
            ranSequence(sequence.id)
            close()
        })
        return true
    }

    function loadCurrent() {
        const sequence = current
        if (!sequence) return false
        loadRequested(sequence.entries)
        close()
        return true
    }

    // First press arms the deletion, second press deletes; any other action disarms it.
    function deleteCurrent() {
        const sequence = current
        if (!sequence || busy) return false
        if (!confirmingDelete) {
            confirmingDelete = true
            return true
        }
        confirmingDelete = false
        busy = true
        bridge.deleteSequence(sequence.id, response => {
            busy = false
            if (!response.ok) return
            sequences = response.data.sequences
            if (optionList.currentIndex >= count) optionList.currentIndex = count - 1
        })
        return true
    }

    function moveCurrent(delta) {
        const sequence = current
        if (!sequence || busy) return false
        const target = optionList.currentIndex + delta
        if (target < 0 || target >= count) return false
        busy = true
        bridge.moveSequence(sequence.id, delta, response => {
            busy = false
            if (!response.ok) return
            sequences = response.data.sequences
            optionList.currentIndex = target
        })
        return true
    }

    function moveSelection(delta) {
        if (count === 0) return
        confirmingDelete = false
        optionList.currentIndex = optionList.currentIndex < 0 ? 0 : (optionList.currentIndex + delta + count) % count
    }

    onClosed: {
        confirmingDelete = false
        mode = "list"
    }

    // ---- list view -------------------------------------------------------------------------

    SelectableText {
        Layout.fillWidth: true
        visible: dialog.mode === "list" && dialog.count === 0
        theme: dialog.theme
        text: dialog.busy ? "Loading…" : "No saved sequences yet. Create one to reuse a series of prompts."
        color: dialog.theme.muted
        font.pixelSize: 12
    }

    ListView {
        id: optionList
        Layout.fillWidth: true
        Layout.preferredHeight: Math.min(contentHeight, 260, Math.max(80, dialog.bodyViewportHeight * 0.65))
        visible: dialog.mode === "list" && dialog.count > 0
        model: dialog.sequences
        clip: true
        keyNavigationEnabled: true
        keyNavigationWraps: true
        activeFocusOnTab: true
        Accessible.role: Accessible.List
        Accessible.name: "Saved sequences"
        Keys.onReturnPressed: dialog.runCurrent()
        Keys.onEnterPressed: dialog.runCurrent()
        onCurrentIndexChanged: {
            dialog.confirmingDelete = false
            if (currentIndex >= 0) positionViewAtIndex(currentIndex, ListView.Contain)
        }

        ScrollBar.vertical: ScrollBar {
            policy: ScrollBar.AsNeeded
        }

        delegate: Rectangle {
            id: sequenceRow
            required property int index
            required property var modelData
            readonly property bool selected: ListView.isCurrentItem
            readonly property bool focused: selected && optionList.activeFocus
            width: optionList.width
            implicitHeight: sequenceColumn.implicitHeight + dialog.theme.spaceXl + dialog.theme.spaceXxs
            radius: dialog.theme.radiusSmall
            color: dialog.theme.interactiveFill(selected, sequenceHover.hovered, sequenceTap.pressed)
            border.width: dialog.theme.focusBorderWidth
            border.color: dialog.theme.interactiveBorder(selected, focused)
            Behavior on color { ColorAnimation { duration: dialog.theme.motionNormal } }
            Behavior on border.color { ColorAnimation { duration: dialog.theme.motionNormal } }
            Accessible.role: Accessible.ListItem
            Accessible.name: String(modelData.name) + ", " + modelData.entries.length + " prompts"
            Accessible.focusable: true
            Accessible.selected: ListView.isCurrentItem

            ColumnLayout {
                id: sequenceColumn
                anchors.fill: parent
                anchors.margins: dialog.theme.spaceSm + 1
                spacing: dialog.theme.spaceXxs

                SelectableText {
                    Layout.fillWidth: true
                    theme: dialog.theme
                    text: String(sequenceRow.modelData.name)
                    color: sequenceRow.selected ? dialog.theme.selectionForeground : dialog.theme.foreground
                    font.pixelSize: dialog.theme.typeBody + 1
                    font.bold: true
                    onTapped: optionList.currentIndex = sequenceRow.index
                }

                SelectableText {
                    Layout.fillWidth: true
                    theme: dialog.theme
                    text: sequenceRow.modelData.entries.length + (sequenceRow.modelData.entries.length === 1 ? " prompt · " : " prompts · ") + String(sequenceRow.modelData.entries[0] || "").replace(/\s+/g, " ")
                    color: dialog.theme.muted
                    font.pixelSize: dialog.theme.typeSmall
                    onTapped: optionList.currentIndex = sequenceRow.index
                }
            }

            HoverHandler {
                id: sequenceHover
                cursorShape: Qt.PointingHandCursor
            }

            TapHandler {
                id: sequenceTap
                acceptedButtons: Qt.LeftButton
                gesturePolicy: TapHandler.DragThreshold
                onTapped: optionList.currentIndex = sequenceRow.index
            }
        }
    }

    // ---- edit view -------------------------------------------------------------------------

    TextField {
        id: nameField
        Layout.fillWidth: true
        visible: dialog.mode === "edit"
        placeholderText: "Sequence name"
        maximumLength: 64
        color: dialog.theme.foreground
        placeholderTextColor: dialog.theme.muted
        selectionColor: dialog.theme.selection
        background: Rectangle {
            radius: dialog.theme.radiusSmall
            color: dialog.theme.surfaceRaised
            border.width: dialog.theme.borderWidth
            border.color: nameField.activeFocus ? dialog.theme.focusRing : dialog.theme.border
        }
        Accessible.role: Accessible.EditableText
        Accessible.name: "Sequence name"
        KeyNavigation.tab: entriesArea
    }

    ScrollView {
        Layout.fillWidth: true
        Layout.preferredHeight: 220
        visible: dialog.mode === "edit"
        clip: true

        TextArea {
            id: entriesArea
            placeholderText: "First prompt\n\nSecond prompt"
            wrapMode: TextEdit.Wrap
            textFormat: TextEdit.PlainText
            selectByMouse: true
            color: dialog.theme.foreground
            placeholderTextColor: dialog.theme.muted
            selectionColor: dialog.theme.selection
            background: Rectangle {
                radius: dialog.theme.radiusSmall
                color: dialog.theme.surfaceRaised
                border.width: dialog.theme.borderWidth
                border.color: entriesArea.activeFocus ? dialog.theme.focusRing : dialog.theme.border
            }
            Accessible.role: Accessible.EditableText
            Accessible.name: "Sequence prompts"
            Accessible.description: "Ctrl+Enter saves, Escape cancels"
            Keys.onPressed: event => {
                if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && (event.modifiers & Qt.ControlModifier)) {
                    dialog.saveEdit()
                    event.accepted = true
                }
            }
        }
    }

    actions: ColumnLayout {
        Layout.fillWidth: true
        spacing: 8

        Flow {
            Layout.fillWidth: true
            visible: dialog.mode === "list"
            Layout.preferredHeight: childrenRect.height
            spacing: 8

            AppButton {
                theme: dialog.theme
                variant: "primary"
                text: "Run"
                accessibleName: "Run the selected sequence"
                enabled: dialog.current !== null && !dialog.busy && dialog.bridge.ready && !dialog.bridge.active
                onClicked: dialog.runCurrent()
            }
            AppButton {
                theme: dialog.theme
                text: "Load into prompt"
                accessibleName: "Load the selected sequence into the prompt editor"
                enabled: dialog.current !== null
                onClicked: dialog.loadCurrent()
            }
            AppButton {
                theme: dialog.theme
                text: "New"
                accessibleName: "Create a new sequence"
                onClicked: dialog.startNew("")
            }
            AppButton {
                theme: dialog.theme
                text: "Edit"
                accessibleName: "Edit the selected sequence"
                enabled: dialog.current !== null
                onClicked: dialog.startEdit()
            }
            AppButton {
                theme: dialog.theme
                text: "Move up"
                accessibleName: "Move the selected sequence up"
                enabled: dialog.current !== null && optionList.currentIndex > 0 && !dialog.busy
                onClicked: dialog.moveCurrent(-1)
            }
            AppButton {
                theme: dialog.theme
                text: "Move down"
                accessibleName: "Move the selected sequence down"
                enabled: dialog.current !== null && optionList.currentIndex < dialog.count - 1 && !dialog.busy
                onClicked: dialog.moveCurrent(1)
            }
            AppButton {
                theme: dialog.theme
                variant: dialog.confirmingDelete ? "destructive" : "secondary"
                text: dialog.confirmingDelete ? "Confirm delete" : "Delete"
                accessibleName: dialog.confirmingDelete ? "Confirm deleting the selected sequence" : "Delete the selected sequence"
                enabled: dialog.current !== null && !dialog.busy
                onClicked: dialog.deleteCurrent()
            }
            AppButton {
                theme: dialog.theme
                text: "Close"
                accessibleName: "Close sequences"
                onClicked: dialog.close()
            }
        }

        RowLayout {
            Layout.fillWidth: true
            visible: dialog.mode === "edit"
            spacing: 8

            SelectableText {
                Layout.fillWidth: true
                theme: dialog.theme
                text: dialog.splitEntries(entriesArea.text).length + " of " + dialog.maxEntries + " prompts"
                color: dialog.theme.muted
                font.pixelSize: 11
            }

            AppButton {
                theme: dialog.theme
                text: "Back"
                accessibleName: "Back to the sequence list"
                onClicked: dialog.cancelEdit()
            }

            AppButton {
                theme: dialog.theme
                variant: "primary"
                text: "Save"
                accessibleName: "Save the sequence"
                enabled: nameField.text.trim().length > 0 && dialog.splitEntries(entriesArea.text).length > 0 && !dialog.busy
                onClicked: dialog.saveEdit()
            }
        }
    }
}
