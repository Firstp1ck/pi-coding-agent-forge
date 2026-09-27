import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

// The body scrolls independently of the actions; neither a long question nor a long list can
// push the confirmation controls below the overlay.
Popup {
    id: dialog

    required property QtObject theme
    property string title: ""
    property string message: ""
    property Item initialFocusItem: null
    property Item returnFocusItem: null
    property bool focusedOnOpen: false
    default property alias content: body.data
    property alias actions: actionArea.data
    readonly property real bodyViewportHeight: bodyViewport.height

    parent: Overlay.overlay
    anchors.centerIn: parent
    width: Math.min(parent ? parent.width - theme.space4Xl - theme.space2Xl : 560, 560)
    height: Math.min(implicitHeight, parent ? Math.max(0, parent.height - theme.space4Xl - theme.space2Xl) : implicitHeight)
    modal: true
    focus: true
    closePolicy: Popup.CloseOnEscape
    padding: theme.space3Xl

    Overlay.modal: Rectangle { color: dialog.theme.dialogOverlay }

    background: Rectangle {
        radius: dialog.theme.radiusLarge
        color: dialog.theme.surface
        border.width: dialog.theme.borderWidth
        border.color: dialog.theme.border
    }

    function reveal(item) {
        if (!item || !bodyViewport.height || !bodyViewport.visible) return
        let ancestor = item
        while (ancestor && ancestor !== body) ancestor = ancestor.parent
        if (ancestor !== body) return
        const point = item.mapToItem(body, 0, 0)
        if (point.y < bodyViewport.contentY)
            bodyViewport.contentY = Math.max(0, point.y)
        else if (point.y + item.height > bodyViewport.contentY + bodyViewport.height)
            bodyViewport.contentY = Math.min(bodyViewport.contentHeight - bodyViewport.height,
                                              point.y + item.height - bodyViewport.height)
    }

    onOpened: {
        const target = initialFocusItem
        if (target) {
            target.forceActiveFocus()
            focusedOnOpen = target.activeFocus
            Qt.callLater(() => dialog.reveal(target))
        } else {
            focusedOnOpen = dialog.activeFocus
        }
    }

    onClosed: if (returnFocusItem) returnFocusItem.forceActiveFocus()

    Connections {
        target: dialog.parent ? dialog.parent.Window.window : null
        function onActiveFocusItemChanged() {
            if (dialog.opened) dialog.reveal(dialog.parent.Window.window.activeFocusItem)
        }
    }

    contentItem: ColumnLayout {
        spacing: dialog.theme.spaceXl
        Accessible.role: Accessible.Dialog
        Accessible.name: dialog.title

        Flickable {
            id: bodyViewport
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.minimumHeight: 0
            Layout.preferredHeight: body.implicitHeight
            contentWidth: width
            contentHeight: body.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            ColumnLayout {
                id: body
                width: bodyViewport.width
                spacing: dialog.theme.spaceLg

                SelectableText {
                    Layout.fillWidth: true
                    theme: dialog.theme
                    text: dialog.title
                    wrapMode: TextEdit.Wrap
                    color: dialog.theme.heading
                    font.pixelSize: dialog.theme.typeTitle + 1
                    font.bold: true
                    Accessible.role: Accessible.Heading
                }

                SelectableText {
                    Layout.fillWidth: true
                    visible: dialog.message.length > 0
                    theme: dialog.theme
                    text: dialog.message
                    wrapMode: TextEdit.Wrap
                    color: dialog.theme.foreground
                    font.pixelSize: dialog.theme.typeBody + 1
                }
            }
        }

        ColumnLayout {
            id: actionArea
            Layout.fillWidth: true
            spacing: dialog.theme.spaceSm
        }
    }
}
