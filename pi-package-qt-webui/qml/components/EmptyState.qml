import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Shown when no session is selected or while the selected session has no transcript. The panel
// stays focused on the next useful action and remains scrollable in a short window.
Item {
    id: empty

    required property QtObject theme
    property bool ready: false
    property bool canRecover: false
    property bool backendReady: false
    property bool sessionOpen: true

    signal restartRequested()
    signal newSessionRequested()
    signal resumeRequested()
    signal openDirectoryRequested()

    implicitHeight: content.implicitHeight
    Accessible.role: Accessible.Grouping
    Accessible.name: empty.sessionOpen ? "Empty transcript" : "No session open"

    Flickable {
        anchors.fill: parent
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        contentWidth: width
        contentHeight: Math.max(height, content.implicitHeight + empty.theme.space4Xl + empty.theme.spaceMd)

        ColumnLayout {
            id: content
            x: Math.max(empty.theme.spaceXl, (parent.width - width) / 2)
            y: Math.max(empty.theme.space2Xl, (parent.height - implicitHeight) / 2)
            width: Math.max(0, Math.min(parent.width - empty.theme.space4Xl, 420))
            spacing: empty.theme.spaceXl

            RowLayout {
                Layout.alignment: Qt.AlignHCenter
                spacing: empty.theme.spaceXxs
                Accessible.role: Accessible.Graphic
                Accessible.name: "Prompt landmark"

                Label {
                    text: ">"
                    textFormat: Text.PlainText
                    color: empty.theme.accentForeground
                    font.family: empty.theme.monospaceFamily
                    font.pixelSize: empty.theme.typeDisplayLarge
                    font.bold: true
                    Accessible.ignored: true
                }

                Rectangle {
                    Layout.preferredWidth: empty.theme.spaceXl
                    Layout.preferredHeight: empty.theme.borderWidth * 2
                    Layout.alignment: Qt.AlignBottom
                    Layout.bottomMargin: empty.theme.spaceSm
                    color: empty.theme.accentForeground
                    Accessible.ignored: true
                }
            }

            SelectableText {
                Layout.fillWidth: true
                theme: empty.theme
                text: !empty.sessionOpen ? "NO SESSION OPEN" : empty.ready ? "SESSION READY" : empty.canRecover ? "SESSION RECOVERY" : "WORKSPACE STARTUP"
                color: empty.theme.muted
                font.family: empty.theme.monospaceFamily
                font.pixelSize: empty.theme.typeCaption
                font.bold: true
                font.letterSpacing: empty.theme.labelTracking
                horizontalAlignment: TextEdit.AlignHCenter
            }

            SelectableText {
                Layout.fillWidth: true
                theme: empty.theme
                text: !empty.sessionOpen ? "Choose where to continue" : empty.ready ? "Start a conversation" : empty.canRecover ? "Saved session unavailable" : empty.backendReady ? "Starting Pi…" : "Starting Qt WebUI…"
                color: empty.theme.heading
                font.family: empty.theme.monospaceFamily
                font.pixelSize: empty.theme.typeDisplay
                font.bold: true
                horizontalAlignment: TextEdit.AlignHCenter
                Accessible.role: Accessible.Heading
            }

            SelectableText {
                Layout.fillWidth: true
                theme: empty.theme
                text: !empty.sessionOpen
                    ? "Select a session from the workspace list, start a new one, or open another folder."
                    : empty.ready ? "Ask about this workspace, resume earlier work, or open another folder." : empty.canRecover ? "Restore the saved file and restart Pi, resume another session, or start a new one." : "Your workspace will be ready shortly."
                color: empty.theme.muted
                font.family: empty.theme.monospaceFamily
                font.pixelSize: empty.theme.typeBody
                wrapMode: TextEdit.Wrap
                horizontalAlignment: TextEdit.AlignHCenter
            }

            Flow {
                Layout.fillWidth: true
                Layout.preferredHeight: childrenRect.height
                visible: !empty.sessionOpen || empty.ready || empty.canRecover
                spacing: empty.theme.spaceMd

                AppButton {
                    visible: !empty.sessionOpen || empty.canRecover
                    theme: empty.theme
                    variant: "primary"
                    text: "New session"
                    accessibleName: "Start a new session"
                    accessibleDescription: "Ctrl+N"
                    onClicked: empty.newSessionRequested()
                }

                AppButton {
                    visible: empty.sessionOpen
                    theme: empty.theme
                    text: "Resume session"
                    accessibleName: "Resume a saved session in this tab"
                    accessibleDescription: "Ctrl+Shift+O"
                    onClicked: empty.resumeRequested()
                }

                AppButton {
                    theme: empty.theme
                    text: "Open folder"
                    accessibleName: "Open another folder in a new tab"
                    accessibleDescription: "Ctrl+O"
                    onClicked: empty.openDirectoryRequested()
                }
            }

            SelectableText {
                Layout.fillWidth: true
                visible: empty.sessionOpen && empty.ready
                theme: empty.theme
                text: "Enter sends  ·  Shift+Enter adds a line  ·  Ctrl+F searches  ·  Ctrl+K opens the palette"
                color: empty.theme.muted
                font.family: empty.theme.monospaceFamily
                font.pixelSize: empty.theme.typeSmall
                wrapMode: TextEdit.Wrap
                horizontalAlignment: TextEdit.AlignHCenter
            }

            AppButton {
                Layout.alignment: Qt.AlignHCenter
                visible: empty.sessionOpen && !empty.ready
                theme: empty.theme
                variant: "warning"
                text: "Restart Pi"
                accessibleName: "Restart Pi"
                onClicked: empty.restartRequested()
            }
        }
    }
}
