import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

// Bounded event history: every notice the bridge posted (from any tab), newest last, with
// severity filters, a text filter, repeat grouping, copy, and clear. Entries are plain text.
AppDialog {
    id: dialog

    required property var bridge
    property string levelFilter: "all" // all | info | warning | error
    property string textFilter: ""
    readonly property var entries: collectEntries(bridge.noticeRevision, levelFilter, textFilter)
    readonly property int count: entries.length

    title: "Events"
    width: Math.min(parent ? parent.width - 40 : 720, 720)
    initialFocusItem: filterField

    function present() {
        open()
    }

    // Consecutive identical messages collapse into one row with a count.
    function collectEntries(revision, level, text) {
        const needle = String(text || "").trim().toLowerCase()
        const result = []
        const model = bridge.noticeModel
        for (let index = 0; index < model.count; index++) {
            const notice = model.get(index)
            if (level !== "all" && notice.level !== level) continue
            if (needle.length > 0 && String(notice.message).toLowerCase().indexOf(needle) === -1) continue
            const previous = result.length > 0 ? result[result.length - 1] : null
            if (previous && previous.level === notice.level && previous.message === notice.message && previous.tab === notice.tab) {
                previous.count += 1
                previous.at = notice.at
                continue
            }
            result.push({ level: String(notice.level), message: String(notice.message), tab: String(notice.tab || ""), at: Number(notice.at) || 0, count: 1 })
        }
        return result
    }

    function timeLabel(at) {
        const date = new Date(at)
        const pad = value => (value < 10 ? "0" : "") + value
        return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds())
    }

    function copyAll() {
        const lines = []
        for (const entry of entries) lines.push(timeLabel(entry.at) + " " + entry.level + (entry.tab.length > 0 ? " [" + entry.tab + "]" : "") + (entry.count > 1 ? " ×" + entry.count : "") + " " + entry.message)
        return bridge.copyToClipboard(lines.join("\n"))
    }

    function clearAll() {
        bridge.clearNotices()
        return true
    }

    function setLevel(level) {
        levelFilter = level
        return true
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 6

        Repeater {
            model: ["all", "info", "warning", "error"]
            delegate: AppButton {
                required property string modelData
                theme: dialog.theme
                variant: "ghost"
                active: dialog.levelFilter === modelData
                text: modelData === "all" ? "All" : modelData.charAt(0).toUpperCase() + modelData.slice(1)
                accessibleName: "Show " + (modelData === "all" ? "all events" : modelData + " events")
                padding: 2
                leftPadding: 8
                rightPadding: 8
                onClicked: dialog.setLevel(modelData)
            }
        }

    }

    TextField {
        id: filterField
        Layout.fillWidth: true
        placeholderText: "Filter events"
        color: dialog.theme.foreground
        placeholderTextColor: dialog.theme.muted
        selectionColor: dialog.theme.selection
        background: Rectangle {
            radius: dialog.theme.radiusSmall
            color: dialog.theme.surfaceRaised
            border.width: dialog.theme.borderWidth
            border.color: filterField.activeFocus ? dialog.theme.focusRing : dialog.theme.border
        }
        Accessible.role: Accessible.EditableText
        Accessible.name: "Filter events"
        onTextChanged: dialog.textFilter = text
    }

    SelectableText {
        Layout.fillWidth: true
        visible: dialog.count === 0
        theme: dialog.theme
        text: dialog.bridge.noticeModel.count === 0 ? "No events yet" : "No events match the filter"
        color: dialog.theme.muted
        font.pixelSize: 12
    }

    ListView {
        id: eventList
        Layout.fillWidth: true
        Layout.preferredHeight: Math.min(contentHeight, 360, Math.max(80, dialog.bodyViewportHeight * 0.65))
        visible: dialog.count > 0
        model: dialog.entries
        clip: true
        keyNavigationEnabled: true
        activeFocusOnTab: true
        Accessible.role: Accessible.List
        Accessible.name: dialog.count + " events"

        ScrollBar.vertical: ScrollBar {
            policy: ScrollBar.AsNeeded
        }

        delegate: Rectangle {
            id: eventRow
            required property int index
            required property var modelData
            readonly property bool selected: ListView.isCurrentItem
            readonly property bool focused: selected && eventList.activeFocus
            width: eventList.width
            implicitHeight: eventColumn.implicitHeight + dialog.theme.spaceXl
            radius: dialog.theme.radiusSmall
            color: dialog.theme.interactiveFill(selected, eventHover.hovered, eventTap.pressed)
            border.width: dialog.theme.focusBorderWidth
            border.color: dialog.theme.interactiveBorder(selected, focused)
            Behavior on color { ColorAnimation { duration: dialog.theme.motionNormal } }
            Behavior on border.color { ColorAnimation { duration: dialog.theme.motionNormal } }
            Accessible.role: Accessible.ListItem
            Accessible.name: modelData.level + ": " + modelData.message + (modelData.count > 1 ? ", repeated " + modelData.count + " times" : "")

            RowLayout {
                anchors.fill: parent
                anchors.margins: dialog.theme.spaceSm
                spacing: dialog.theme.spaceMd

                StatusBadge {
                    theme: dialog.theme
                    kind: eventRow.modelData.level === "error" ? "error" : eventRow.modelData.level === "warning" ? "tool" : "neutral"
                    text: eventRow.modelData.level
                    fontSize: 10
                }

                ColumnLayout {
                    id: eventColumn
                    Layout.fillWidth: true
                    spacing: dialog.theme.spaceXxs

                    SelectableText {
                        Layout.fillWidth: true
                        theme: dialog.theme
                        text: eventRow.modelData.message
                        wrapMode: TextEdit.Wrap
                        color: eventRow.selected ? dialog.theme.selectionForeground : dialog.theme.foreground
                        font.pixelSize: dialog.theme.typeBody
                        onTapped: eventList.currentIndex = eventRow.index
                    }

                    SelectableText {
                        theme: dialog.theme
                        text: dialog.timeLabel(eventRow.modelData.at) + (eventRow.modelData.tab.length > 0 ? " · " + eventRow.modelData.tab : "") + (eventRow.modelData.count > 1 ? " · ×" + eventRow.modelData.count : "")
                        color: dialog.theme.muted
                        font.pixelSize: dialog.theme.typeCaption
                        onTapped: eventList.currentIndex = eventRow.index
                    }
                }
            }

            HoverHandler {
                id: eventHover
                cursorShape: Qt.PointingHandCursor
            }

            TapHandler {
                id: eventTap
                acceptedButtons: Qt.LeftButton
                gesturePolicy: TapHandler.DragThreshold
                onTapped: eventList.currentIndex = eventRow.index
            }
        }
    }

    actions: RowLayout {
        Layout.fillWidth: true
        spacing: 8

        SelectableText {
            Layout.fillWidth: true
            theme: dialog.theme
            text: dialog.count + " of " + dialog.bridge.noticeModel.count + " events (last " + dialog.bridge.maxNotices + " are kept)"
            color: dialog.theme.muted
            font.pixelSize: 11
        }

        AppButton {
            theme: dialog.theme
            variant: "ghost"
            text: "Copy"
            accessibleName: "Copy the listed events"
            enabled: dialog.count > 0
            onClicked: dialog.copyAll()
        }

        AppButton {
            theme: dialog.theme
            variant: "ghost"
            text: "Clear"
            accessibleName: "Clear the event history"
            enabled: dialog.bridge.noticeModel.count > 0
            onClicked: dialog.clearAll()
        }

        AppButton {
            theme: dialog.theme
            text: "Close"
            accessibleName: "Close events"
            onClicked: dialog.close()
        }
    }
}
