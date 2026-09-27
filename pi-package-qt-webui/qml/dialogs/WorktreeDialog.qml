import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

// Collects a conventional branch type and branch name separately, then submits the combined
// branch only after the existing Git branch-name validator accepts it.
AppDialog {
    id: dialog

    property var validate: null // function(branch) -> "" when valid, otherwise the problem
    property bool answered: false
    property var typeSuggestions: ["feat", "fix", "change", "perf", "test", "chore", "refactor", "docs", "style", "build", "ci", "revert"]
    readonly property string branchType: typeField.editText.trim()
    readonly property string branchName: nameField.text.trim()
    readonly property string branch: branchType.length > 0 && branchName.length > 0 ? branchType + "/" + branchName : ""
    readonly property string problem: branchType.length === 0 ? "Choose or enter a branch type"
        : branchName.length === 0 ? "Enter a branch name"
        : branch.length > 128 ? "Branch names can use at most 128 characters"
        : validate ? String(validate(branch) || "") : ""
    readonly property bool valid: problem.length === 0

    signal submitted(string branch)
    signal cancelled()

    title: "New worktree"
    message: "Create a branch and check it out in a new folder next to the repository, then open it in a new tab."
    initialFocusItem: typeField

    function present() {
        typeField.currentIndex = -1
        typeField.editText = ""
        nameField.text = ""
        answered = false
        open()
    }

    function setFields(type, name) {
        typeField.currentIndex = -1
        typeField.editText = String(type || "")
        nameField.text = String(name || "")
    }

    function submit() {
        if (answered || !valid) return false
        answered = true
        submitted(branch)
        close()
        return true
    }

    onClosed: if (!answered) cancelled()

    RowLayout {
        Layout.fillWidth: true
        spacing: 8

        ComboBox {
            id: typeField
            Layout.preferredWidth: 150
            Layout.minimumWidth: 112
            editable: true
            model: dialog.typeSuggestions
            currentIndex: -1
            rightPadding: 28
            font.family: dialog.theme.monospaceFamily
            font.pixelSize: 13
            palette.text: dialog.theme.foreground
            palette.buttonText: dialog.theme.foreground
            palette.base: dialog.theme.surfaceRaised
            palette.button: dialog.theme.surfaceRaised
            palette.highlight: dialog.theme.selection
            palette.highlightedText: dialog.theme.foreground
            Accessible.role: Accessible.ComboBox
            Accessible.name: "Branch type"
            Accessible.description: "Choose a suggested type or enter a custom type"

            background: Rectangle {
                radius: dialog.theme.radiusSmall
                color: dialog.theme.surfaceRaised
                border.width: dialog.theme.borderWidth
                border.color: typeField.activeFocus ? dialog.theme.focusRing : dialog.theme.border
            }

            indicator: Label {
                anchors.right: parent.right
                anchors.rightMargin: 9
                anchors.verticalCenter: parent.verticalCenter
                text: "▾"
                textFormat: Text.PlainText
                color: dialog.theme.accentForeground
                font.pixelSize: 12
            }

            Label {
                anchors.left: parent.left
                anchors.leftMargin: 12
                anchors.verticalCenter: parent.verticalCenter
                visible: typeField.editText.length === 0
                enabled: false
                text: "type"
                textFormat: Text.PlainText
                color: dialog.theme.muted
                font.family: dialog.theme.monospaceFamily
                font.pixelSize: 13
                z: 2
            }

            delegate: ItemDelegate {
                width: typeField.width
                text: String(modelData)
                highlighted: typeField.highlightedIndex === index
                font.family: dialog.theme.monospaceFamily
                font.pixelSize: 12
                palette.text: dialog.theme.foreground
                palette.highlightedText: dialog.theme.foreground
                background: Rectangle {
                    radius: dialog.theme.radiusSmall
                    color: parent.highlighted ? dialog.theme.selection : dialog.theme.transparent
                }
            }

            popup: Popup {
                y: typeField.height + 4
                width: typeField.width
                implicitHeight: Math.min(contentItem.implicitHeight + topPadding + bottomPadding, 230)
                padding: 4

                contentItem: ListView {
                    clip: true
                    implicitHeight: contentHeight
                    model: typeField.popup.visible ? typeField.delegateModel : null
                    currentIndex: typeField.highlightedIndex
                    ScrollIndicator.vertical: ScrollIndicator { }
                }

                background: Rectangle {
                    radius: dialog.theme.radiusMedium
                    color: dialog.theme.surfaceRaised
                    border.width: dialog.theme.borderWidth
                    border.color: dialog.theme.border
                }
            }

            onAccepted: {
                nameField.forceActiveFocus()
                nameField.selectAll()
            }
        }

        Label {
            text: "/"
            textFormat: Text.PlainText
            color: dialog.theme.accentForeground
            font.family: dialog.theme.monospaceFamily
            font.pixelSize: 16
            font.bold: true
            Accessible.role: Accessible.StaticText
            Accessible.name: "slash"
        }

        TextField {
            id: nameField
            Layout.fillWidth: true
            placeholderText: "short-feature-name"
            maximumLength: 128
            color: dialog.theme.foreground
            placeholderTextColor: dialog.theme.muted
            selectionColor: dialog.theme.selection
            font.family: dialog.theme.monospaceFamily
            font.pixelSize: 13
            background: Rectangle {
                radius: dialog.theme.radiusSmall
                color: dialog.theme.surfaceRaised
                border.width: dialog.theme.borderWidth
                border.color: nameField.activeFocus ? dialog.theme.focusRing : dialog.theme.border
            }
            Accessible.role: Accessible.EditableText
            Accessible.name: "Branch name"
            Accessible.description: dialog.problem.length > 0 ? dialog.problem : "Enter submits"
            onAccepted: dialog.submit()
        }
    }

    SelectableText {
        Layout.fillWidth: true
        visible: (dialog.branchType.length > 0 || dialog.branchName.length > 0) && dialog.problem.length > 0
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
            accessibleName: "Cancel new worktree"
            onClicked: dialog.close()
        }

        AppButton {
            theme: dialog.theme
            variant: "primary"
            text: "Continue"
            accessibleName: "Continue with new worktree"
            enabled: dialog.valid
            onClicked: dialog.submit()
        }
    }
}
