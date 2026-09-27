import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

// Single-line input with a validation message. Enter submits when valid; `submitted` fires at
// most once per presentation and never with an invalid value.
AppDialog {
    id: dialog

    property string placeholder: ""
    property string submitLabel: "OK"
    property int maxCharacters: 256
    property var validate: null // function(text) -> "" when valid, otherwise the problem
    property bool answered: false
    property var context: null
    readonly property string problem: validate ? String(validate(field.text) || "") : (field.text.trim().length === 0 ? "Enter a value" : "")
    readonly property bool valid: problem.length === 0 && field.text.length <= maxCharacters

    signal submitted(string text, var context)
    signal cancelled(var context)

    initialFocusItem: field

    function present(config) {
        title = String(config.title || "")
        message = String(config.message || "")
        placeholder = String(config.placeholder || "")
        submitLabel = String(config.submitLabel || "OK")
        maxCharacters = Number(config.maxCharacters) > 0 ? Number(config.maxCharacters) : 256
        validate = typeof config.validate === "function" ? config.validate : null
        context = config.context === undefined ? null : config.context
        field.text = String(config.prefill || "")
        answered = false
        open()
        field.selectAll()
    }

    function setText(value) {
        field.text = String(value)
    }

    function submit() {
        if (answered || !valid) return false
        answered = true
        submitted(field.text.trim(), context)
        close()
        return true
    }

    onClosed: if (!answered) cancelled(context)

    TextField {
        id: field
        Layout.fillWidth: true
        placeholderText: dialog.placeholder
        maximumLength: dialog.maxCharacters
        color: dialog.theme.foreground
        placeholderTextColor: dialog.theme.muted
        selectionColor: dialog.theme.selection
        background: Rectangle {
            radius: dialog.theme.radiusSmall
            color: dialog.theme.surfaceRaised
            border.width: dialog.theme.borderWidth
            border.color: field.activeFocus ? dialog.theme.focusRing : dialog.theme.border
        }
        Accessible.role: Accessible.EditableText
        Accessible.name: dialog.title
        Accessible.description: dialog.problem.length > 0 ? dialog.problem : "Enter submits"
        onAccepted: dialog.submit()
    }

    SelectableText {
        Layout.fillWidth: true
        visible: field.text.length > 0 && dialog.problem.length > 0
        theme: dialog.theme
        text: dialog.problem
        wrapMode: TextEdit.Wrap
        color: dialog.theme.destructive
        font.pixelSize: 11
    }

    actions: RowLayout {
        Layout.fillWidth: true
        spacing: 8

        Item { Layout.fillWidth: true }

        AppButton {
            theme: dialog.theme
            text: "Cancel"
            accessibleName: "Cancel " + dialog.title
            onClicked: dialog.close()
        }

        AppButton {
            theme: dialog.theme
            variant: "primary"
            text: dialog.submitLabel
            accessibleName: dialog.submitLabel + " " + dialog.title
            enabled: dialog.valid
            onClicked: dialog.submit()
        }
    }
}
