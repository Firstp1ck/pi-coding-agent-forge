import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

// Keyboard-first list picker used for models and thinking levels. Items are plain data
// ({value, label, detail, current}); typing filters, arrows move, Enter picks, Escape cancels.
// Picking never happens as a side effect of filtering or navigation.
AppDialog {
    id: dialog

    property var items: []
    property bool searchable: true
    property string emptyText: "Nothing to choose from"
    property string filter: ""
    property bool answered: false
    readonly property var visibleItems: filterItems(items, filter)
    readonly property int visibleCount: visibleItems.length

    signal picked(string value)
    signal cancelled()

    initialFocusItem: searchable ? filterField : optionList

    function filterItems(list, query) {
        const needle = String(query || "").trim().toLowerCase()
        const result = []
        for (const item of list) {
            if (!item || typeof item !== "object") continue
            const haystack = (String(item.group || "") + " " + String(item.label || "") + " " + String(item.detail || "") + " " + String(item.value || "")).toLowerCase()
            if (needle.length === 0 || haystack.indexOf(needle) !== -1) result.push(item)
        }
        return result
    }

    function present(config) {
        title = String(config.title || "")
        message = String(config.message || "")
        searchable = config.searchable !== false
        emptyText = String(config.emptyText || "Nothing to choose from")
        items = Array.isArray(config.items) ? config.items : []
        filter = ""
        answered = false
        filterField.text = ""
        open()
        selectCurrentItem()
    }

    function selectCurrentItem() {
        let index = 0
        for (let position = 0; position < visibleItems.length; position++) {
            if (visibleItems[position].current === true) index = position
        }
        optionList.currentIndex = visibleItems.length > 0 ? index : -1
    }

    function moveSelection(delta) {
        if (visibleCount === 0) return
        const next = optionList.currentIndex < 0 ? 0 : (optionList.currentIndex + delta + visibleCount) % visibleCount
        optionList.currentIndex = next
    }

    function pickIndex(index) {
        if (index < 0 || index >= visibleItems.length) return false
        if (answered) return false
        answered = true
        const value = String(visibleItems[index].value)
        picked(value)
        close()
        return true
    }

    function pickCurrent() {
        return pickIndex(optionList.currentIndex)
    }

    function pickValue(value) {
        for (let index = 0; index < visibleItems.length; index++) {
            if (String(visibleItems[index].value) === String(value)) return pickIndex(index)
        }
        return false
    }

    function setFilter(text) {
        filterField.text = String(text)
    }

    onFilterChanged: {
        if (optionList.currentIndex < 0 || optionList.currentIndex >= visibleCount) optionList.currentIndex = visibleCount > 0 ? 0 : -1
    }

    // Closing without a pick (Escape, Cancel, click outside) is a cancellation; a pick is not.
    onClosed: if (!answered) cancelled()

    TextField {
        id: filterField
        Layout.fillWidth: true
        visible: dialog.searchable
        placeholderText: "Type to filter"
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
        Accessible.name: "Filter " + dialog.title
        Accessible.description: "Arrow keys move the selection, Enter chooses"
        onTextChanged: dialog.filter = text
        Keys.onPressed: event => {
            if (event.key === Qt.Key_Down) {
                dialog.moveSelection(1)
                event.accepted = true
            } else if (event.key === Qt.Key_Up) {
                dialog.moveSelection(-1)
                event.accepted = true
            } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                dialog.pickCurrent()
                event.accepted = true
            }
        }
    }

    SelectableText {
        Layout.fillWidth: true
        visible: dialog.visibleCount === 0
        theme: dialog.theme
        text: dialog.items.length === 0 ? dialog.emptyText : "No matches"
        color: dialog.theme.muted
        font.pixelSize: 12
    }

    ListView {
        id: optionList
        Layout.fillWidth: true
        Layout.preferredHeight: Math.min(contentHeight, 320, Math.max(80, dialog.bodyViewportHeight * 0.65))
        visible: dialog.visibleCount > 0
        model: dialog.visibleItems
        clip: true
        keyNavigationEnabled: true
        keyNavigationWraps: true
        activeFocusOnTab: true
        Accessible.role: Accessible.List
        Accessible.name: dialog.title + " options"
        Keys.onReturnPressed: dialog.pickCurrent()
        Keys.onEnterPressed: dialog.pickCurrent()
        Keys.onSpacePressed: dialog.pickCurrent()
        onCurrentIndexChanged: if (currentIndex >= 0) positionViewAtIndex(currentIndex, ListView.Contain)

        ScrollBar.vertical: ScrollBar {
            policy: ScrollBar.AsNeeded
        }

        delegate: Rectangle {
            id: optionRow
            required property int index
            required property var modelData
            readonly property bool current: modelData.current === true
            readonly property bool selected: ListView.isCurrentItem
            readonly property bool focused: selected && (optionList.activeFocus || filterField.activeFocus)
            width: optionList.width
            implicitHeight: optionColumn.implicitHeight + dialog.theme.spaceXl + dialog.theme.spaceXxs
            radius: dialog.theme.radiusSmall
            color: dialog.theme.interactiveFill(selected, optionHover.hovered, optionTap.pressed)
            border.width: dialog.theme.focusBorderWidth
            border.color: dialog.theme.interactiveBorder(selected, focused)
            Behavior on color { ColorAnimation { duration: dialog.theme.motionNormal } }
            Behavior on border.color { ColorAnimation { duration: dialog.theme.motionNormal } }
            Accessible.role: Accessible.ListItem
            Accessible.name: (String(modelData.group || "").length > 0 ? String(modelData.group) + ": " : "") + String(modelData.label || "") + (String(modelData.detail || "").length > 0 ? ", " + String(modelData.detail) : "") + (current ? ", current" : "")
            Accessible.focusable: true
            Accessible.selected: ListView.isCurrentItem

            function activateRow() {
                optionList.currentIndex = optionRow.index
                dialog.pickCurrent()
            }

            RowLayout {
                anchors.fill: parent
                anchors.margins: dialog.theme.spaceSm + 1
                spacing: dialog.theme.spaceMd

                ColumnLayout {
                    id: optionColumn
                    Layout.fillWidth: true
                    Layout.minimumWidth: 0
                    spacing: dialog.theme.spaceXxs / 2

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: dialog.theme.spaceSm

                        SelectableText {
                            visible: String(optionRow.modelData.group || "").length > 0
                            theme: dialog.theme
                            text: String(optionRow.modelData.group || "")
                            color: dialog.theme.accentForeground
                            font.pixelSize: dialog.theme.typeCaption
                            font.bold: true
                            onTapped: optionRow.activateRow()
                        }

                        SelectableText {
                            Layout.fillWidth: true
                            theme: dialog.theme
                            text: String(optionRow.modelData.label || "")
                            Layout.minimumWidth: 0
                            wrapMode: TextEdit.Wrap
                            color: optionRow.selected ? dialog.theme.selectionForeground : dialog.theme.foreground
                            font.pixelSize: dialog.theme.typeBody + 1
                            font.bold: optionRow.current
                            onTapped: optionRow.activateRow()
                        }
                    }

                    SelectableText {
                        Layout.fillWidth: true
                        visible: String(optionRow.modelData.detail || "").length > 0
                        theme: dialog.theme
                        text: String(optionRow.modelData.detail || "")
                        Layout.minimumWidth: 0
                        wrapMode: TextEdit.Wrap
                        color: dialog.theme.muted
                        font.pixelSize: dialog.theme.typeSmall
                        onTapped: optionRow.activateRow()
                    }
                }

                StatusBadge {
                    visible: optionRow.current
                    theme: dialog.theme
                    kind: "ok"
                    text: "current"
                    fontSize: 10
                }
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

    actions: RowLayout {
        Layout.fillWidth: true
        spacing: 8

        SelectableText {
            Layout.fillWidth: true
            theme: dialog.theme
            text: dialog.visibleCount + " of " + dialog.items.length
            color: dialog.theme.muted
            font.pixelSize: 11
        }

        AppButton {
            theme: dialog.theme
            text: "Cancel"
            accessibleName: "Cancel " + dialog.title
            onClicked: dialog.close()
        }

        AppButton {
            theme: dialog.theme
            variant: "primary"
            text: "Choose"
            accessibleName: "Choose highlighted option"
            enabled: optionList.currentIndex >= 0 && optionList.currentIndex < dialog.visibleCount
            onClicked: dialog.pickCurrent()
        }
    }
}
