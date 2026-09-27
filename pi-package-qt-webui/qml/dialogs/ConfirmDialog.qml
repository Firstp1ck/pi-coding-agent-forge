import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

// Explicit confirmation for consequential actions. Destructive confirmations start with focus on
// Cancel so Enter never confirms by accident; `confirmed` fires at most once per presentation.
AppDialog {
    id: dialog

    property string confirmLabel: "Confirm"
    property string detail: ""
    property bool destructive: false
    property bool answered: false
    property var context: null

    signal confirmed(var context)
    signal cancelled(var context)

    initialFocusItem: destructive ? cancelButton : confirmButton

    function present(config) {
        title = String(config.title || "Confirm")
        message = String(config.message || "")
        detail = String(config.detail || "")
        confirmLabel = String(config.confirmLabel || "Confirm")
        destructive = config.destructive === true
        context = config.context === undefined ? null : config.context
        answered = false
        open()
    }

    function confirm() {
        if (answered) return false
        answered = true
        confirmed(context)
        close()
        return true
    }

    function cancel() {
        if (answered) return false
        answered = true
        cancelled(context)
        close()
        return true
    }

    onClosed: {
        if (!answered) {
            answered = true
            cancelled(context)
        }
    }

    SelectableText {
        Layout.fillWidth: true
        visible: dialog.detail.length > 0
        theme: dialog.theme
        text: dialog.detail
        wrapMode: TextEdit.Wrap
        color: dialog.theme.foreground
        font.family: dialog.theme.monospaceFamily
        font.pixelSize: 12
    }

    actions: RowLayout {
        Layout.fillWidth: true
        spacing: 8

        Item { Layout.fillWidth: true }

        AppButton {
            id: cancelButton
            theme: dialog.theme
            text: "Cancel"
            accessibleName: "Cancel: " + dialog.title
            onClicked: dialog.cancel()
        }

        AppButton {
            id: confirmButton
            Layout.maximumWidth: Math.max(80, dialog.width - 2 * dialog.padding - cancelButton.implicitWidth - 16)
            theme: dialog.theme
            variant: dialog.destructive ? "destructive" : "primary"
            text: dialog.confirmLabel
            accessibleName: dialog.confirmLabel + ": " + dialog.title
            onClicked: dialog.confirm()
        }
    }
}
