import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

// Presents one queued extension request (select, confirm, input, editor) and answers it exactly
// once. Closing the dialog without an explicit answer cancels the request.
AppDialog {
    id: dialog

    required property var bridge
    property var request: null
    property string submissionState: "open"
    property string submissionError: ""
    readonly property bool answered: submissionState === "accepted"
    readonly property string inputText: method === "editor" ? editorArea.text : inputField.text
    closePolicy: Popup.NoAutoClose
    readonly property string method: request ? String(request.method) : ""
    readonly property string requestId: request ? String(request.requestId) : ""
    readonly property var options: request && Array.isArray(request.options) ? request.options : []

    title: request ? request.title : ""
    message: request ? request.message : ""
    initialFocusItem: method === "select" ? optionList
        : method === "confirm" ? yesButton
        : method === "input" ? inputField
        : method === "editor" ? editorArea : cancelButton

    function present(nextRequest) {
        request = nextRequest
        submissionState = nextRequest.state || "open"
        submissionError = ""
        inputField.text = method === "input" ? String(nextRequest.draftValue || "") : ""
        editorArea.text = method === "editor" ? String(nextRequest.draftValue || nextRequest.prefill || "") : ""
        optionList.currentIndex = options.length > 0 ? 0 : -1
        open()
    }

    function submit(answer) {
        if (submissionState !== "open" || !request) return false
        if (typeof answer.value === "string" && answer.value.length > bridge.maxDialogValueCharacters) {
            submissionError = "Answers are limited to " + bridge.maxDialogValueCharacters + " characters"
            return false
        }
        return bridge.answerDialog(requestId, answer)
    }

    function selectOption(value) {
        if (method !== "select" || options.indexOf(value) === -1) return false
        return submit({ "value": value })
    }

    function selectCurrent() {
        if (optionList.currentIndex < 0 || optionList.currentIndex >= options.length) return false
        return selectOption(options[optionList.currentIndex])
    }

    function confirm(value) {
        if (method !== "confirm") return false
        return submit({ "confirmed": value === true })
    }

    function submitText() {
        if (method === "input") return submit({ "value": inputField.text })
        if (method === "editor") return submit({ "value": editorArea.text })
        return false
    }

    function cancel() {
        if (answered || !request) return false
        return submit({ "cancelled": true })
    }

    function setInputText(value) {
        inputField.text = String(value)
    }

    function setEditorText(value) {
        editorArea.text = String(value)
    }

    function finish() {
        submissionState = "accepted"
        close()
    }

    function settle(state, message) {
        submissionState = state
        submissionError = message
    }

    onClosed: request = null

    Shortcut {
        sequence: "Escape"
        enabled: dialog.opened
        onActivated: dialog.cancel()
    }

    SelectableText {
        Layout.fillWidth: true
        visible: dialog.submissionState !== "open" || dialog.submissionError.length > 0
        theme: dialog.theme
        text: dialog.submissionError || (dialog.submissionState === "unknown" ? "Outcome unknown. Your answer has been kept; it will not be resent automatically." : "Submitting…")
        wrapMode: TextEdit.Wrap
        color: dialog.theme.muted
    }

    SelectableText {
        Layout.fillWidth: true
        visible: request && request.timeoutMs > 0
        theme: dialog.theme
        text: request && request.timeoutMs > 0 ? "This request expires after " + Math.round(request.timeoutMs / 1000) + " seconds" : ""
        color: dialog.theme.muted
        font.pixelSize: 11
    }

    ListView {
        id: optionList
        Layout.fillWidth: true
        Layout.preferredHeight: Math.min(contentHeight, 280, Math.max(80, dialog.bodyViewportHeight * 0.65))
        visible: dialog.method === "select"
        model: dialog.options
        clip: true
        keyNavigationEnabled: true
        keyNavigationWraps: true
        focus: visible
        activeFocusOnTab: true
        onCurrentIndexChanged: if (currentIndex >= 0) positionViewAtIndex(currentIndex, ListView.Contain)
        Accessible.role: Accessible.List
        Accessible.name: "Options"
        Keys.onReturnPressed: dialog.selectCurrent()
        Keys.onEnterPressed: dialog.selectCurrent()
        Keys.onSpacePressed: dialog.selectCurrent()

        delegate: Rectangle {
            id: optionRow
            required property int index
            required property var modelData
            readonly property bool selected: ListView.isCurrentItem
            readonly property bool focused: selected && optionList.activeFocus
            width: optionList.width
            implicitHeight: optionLabel.implicitHeight + dialog.theme.space2Xl
            radius: dialog.theme.radiusSmall
            color: dialog.theme.interactiveFill(selected, optionHover.hovered, optionTap.pressed)
            border.width: dialog.theme.focusBorderWidth
            border.color: dialog.theme.interactiveBorder(selected, focused)
            Behavior on color { ColorAnimation { duration: dialog.theme.motionNormal } }
            Behavior on border.color { ColorAnimation { duration: dialog.theme.motionNormal } }
            Accessible.role: Accessible.ListItem
            Accessible.name: String(modelData)
            Accessible.focusable: true
            Accessible.selected: ListView.isCurrentItem

            function activateRow() {
                optionList.currentIndex = optionRow.index
                dialog.selectCurrent()
            }

            SelectableText {
                id: optionLabel
                anchors.fill: parent
                anchors.margins: dialog.theme.spaceMd
                theme: dialog.theme
                text: String(optionRow.modelData)
                wrapMode: TextEdit.Wrap
                color: optionRow.selected ? dialog.theme.selectionForeground : dialog.theme.foreground
                font.pixelSize: dialog.theme.typeBody + 1
                onTapped: optionRow.activateRow()
            }

            HoverHandler {
                id: optionHover
                cursorShape: Qt.PointingHandCursor
            }

            TapHandler {
                id: optionTap
                acceptedButtons: Qt.LeftButton
                gesturePolicy: TapHandler.DragThreshold
                onTapped: optionRow.activateRow()
            }
        }
    }

    TextField {
        id: inputField
        Layout.fillWidth: true
        visible: dialog.method === "input"
        placeholderText: dialog.request ? dialog.request.placeholder : ""
        color: dialog.theme.foreground
        placeholderTextColor: dialog.theme.muted
        selectionColor: dialog.theme.selection
        background: Rectangle {
            radius: dialog.theme.radiusSmall
            color: dialog.theme.surfaceRaised
            border.width: inputField.activeFocus ? dialog.theme.focusBorderWidth : dialog.theme.borderWidth
            border.color: inputField.activeFocus ? dialog.theme.focusRing : dialog.theme.border
        }
        Accessible.role: Accessible.EditableText
        Accessible.name: dialog.title
        onTextChanged: if (dialog.method === "input") dialog.bridge.updateDialogDraft(dialog.requestId, text)
        readOnly: dialog.submissionState !== "open"
        onAccepted: dialog.submitText()
    }

    ScrollView {
        Layout.fillWidth: true
        Layout.preferredHeight: 180
        visible: dialog.method === "editor"
        clip: true

        TextArea {
            id: editorArea
            readOnly: dialog.submissionState !== "open"
            onTextChanged: if (dialog.method === "editor") dialog.bridge.updateDialogDraft(dialog.requestId, text)
            wrapMode: TextEdit.Wrap
            textFormat: TextEdit.PlainText
            selectByMouse: true
            color: dialog.theme.foreground
            selectionColor: dialog.theme.selection
            background: Rectangle {
                radius: dialog.theme.radiusSmall
                color: dialog.theme.surfaceRaised
                border.width: dialog.theme.borderWidth
                border.color: editorArea.activeFocus ? dialog.theme.focusRing : dialog.theme.border
            }
            Accessible.role: Accessible.EditableText
            Accessible.name: dialog.title
            Accessible.description: "Ctrl+Enter saves, Escape cancels"
            Keys.onPressed: event => {
                if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && (event.modifiers & Qt.ControlModifier)) {
                    dialog.submitText()
                    event.accepted = true
                }
            }
        }
    }

    actions: RowLayout {
        Layout.fillWidth: true
        spacing: 8

        Item { Layout.fillWidth: true }

        AppButton {
            id: cancelButton
            theme: dialog.theme
            text: dialog.method === "confirm" ? "No" : "Cancel"
            accessibleName: dialog.method === "confirm" ? "Answer no" : "Cancel request"
            onClicked: dialog.method === "confirm" ? dialog.confirm(false) : dialog.cancel()
        }

        AppButton {
            id: yesButton
            visible: dialog.method === "confirm"
            theme: dialog.theme
            variant: "primary"
            text: "Yes"
            accessibleName: "Answer yes"
            onClicked: dialog.confirm(true)
        }

        AppButton {
            visible: dialog.method === "select"
            theme: dialog.theme
            variant: "primary"
            text: "Choose"
            accessibleName: "Choose highlighted option"
            enabled: optionList.currentIndex >= 0
            onClicked: dialog.selectCurrent()
        }

        AppButton {
            visible: dialog.method === "input" || dialog.method === "editor"
            theme: dialog.theme
            variant: "primary"
            text: dialog.method === "editor" ? "Save" : "OK"
            accessibleName: dialog.method === "editor" ? "Save text" : "Submit value"
            onClicked: dialog.submitText()
        }
    }
}
