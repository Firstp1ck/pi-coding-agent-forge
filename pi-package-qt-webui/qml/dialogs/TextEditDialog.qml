import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

// Multi-line editor dialog used for text attachments and other bounded plain-text values.
// Ctrl+Enter saves, Escape cancels; `saved` fires at most once per presentation.
AppDialog {
    id: dialog

    property string text: ""
    property int maxCharacters: 262144
    property bool answered: false
    property bool submitting: false
    property bool unknown: false
    property string failure: ""
    property int presentation: 0
    readonly property string editedText: editor.text
    readonly property bool overLimit: editor.text.length > maxCharacters

    signal saved(string text)
    signal cancelled()
    signal refreshRequested()

    initialFocusItem: editor

    function present(config) {
        title = String(config.title || "Edit text")
        message = String(config.message || "")
        maxCharacters = Number(config.maxCharacters) > 0 ? Number(config.maxCharacters) : 262144
        text = String(config.text || "")
        editor.text = text
        answered = false
        submitting = false
        unknown = false
        failure = ""
        presentation++
        open()
    }

    function save() {
        if (answered || overLimit || submitting || unknown) return false
        submitting = true
        saved(editor.text)
        return true
    }

    function settle(response) {
        submitting = false
        if (response.ok) { answered = true; close(); return }
        unknown = !response.local && ["timeout", "not_running"].indexOf(response.error.code) !== -1
        failure = response.error.message
    }

    function setText(value) {
        editor.text = String(value)
    }

    onClosed: if (!answered) cancelled()

    ScrollView {
        Layout.fillWidth: true
        Layout.preferredHeight: 260
        clip: true

        TextArea {
            id: editor
            wrapMode: TextEdit.Wrap
            textFormat: TextEdit.PlainText
            selectByMouse: true
            color: dialog.theme.foreground
            selectionColor: dialog.theme.selection
            font.family: dialog.theme.monospaceFamily
            font.pixelSize: 12
            background: Rectangle {
                radius: dialog.theme.radiusSmall
                color: dialog.theme.surfaceRaised
                border.width: dialog.theme.borderWidth
                border.color: editor.activeFocus ? dialog.theme.focusRing : dialog.theme.border
            }
            Accessible.role: Accessible.EditableText
            Accessible.name: dialog.title
            Accessible.description: "Ctrl+Enter saves, Escape cancels"
            Keys.onPressed: event => {
                if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && (event.modifiers & Qt.ControlModifier)) {
                    dialog.save()
                    event.accepted = true
                }
            }
        }
    }

    actions: RowLayout {
        Layout.fillWidth: true
        spacing: 8

        SelectableText {
            Layout.fillWidth: true
            theme: dialog.theme
            text: dialog.failure || (dialog.overLimit ? "Text exceeds " + dialog.maxCharacters + " characters" : editor.text.length + " characters")
            color: dialog.overLimit ? dialog.theme.destructive : dialog.theme.muted
            font.pixelSize: 11
        }

        AppButton {
            theme: dialog.theme
            visible: dialog.unknown
            text: "Check outcome"
            onClicked: dialog.refreshRequested()
        }

        AppButton {
            theme: dialog.theme
            text: "Cancel"
            accessibleName: "Cancel editing"
            onClicked: dialog.close()
        }

        AppButton {
            theme: dialog.theme
            variant: "primary"
            text: "Save"
            accessibleName: "Save text"
            enabled: !dialog.overLimit && !dialog.submitting && !dialog.unknown
            onClicked: dialog.save()
        }
    }
}
