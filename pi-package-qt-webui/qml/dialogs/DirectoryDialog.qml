import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

// Working-directory picker: direct path entry, folder list with Back/Up/Home, pinned and recent
// folders, a create-folder action, and one explicit Choose. Browsing deliberately leaves the
// current workspace because the user is choosing a new one; the backend bounds every listing.
AppDialog {
    id: dialog

    required property var bridge
    property string currentPath: ""
    property string parentPath: ""
    property var entries: []
    property var recent: []
    property var pinned: []
    property var history: []
    property bool showHidden: false
    property bool loading: false
    property bool answered: false
    property string listError: ""
    property string filter: ""
    readonly property var visibleEntries: filterEntries(entries, filter)
    readonly property var current: entryList.currentIndex >= 0 && entryList.currentIndex < visibleEntries.length ? visibleEntries[entryList.currentIndex] : null
    readonly property bool creating: newFolderField.visible

    signal chosen(string path)
    signal cancelled()

    title: "Open a folder"
    initialFocusItem: pathField
    width: Math.min(parent ? parent.width - 40 : 680, 680)

    function filterEntries(list, query) {
        const needle = String(query || "").trim().toLowerCase()
        return list.filter(entry => needle.length === 0 || String(entry.name).toLowerCase().indexOf(needle) !== -1)
    }

    function present(startPath) {
        answered = false
        history = []
        filter = ""
        filterField.text = ""
        newFolderField.visible = false
        listError = ""
        open()
        navigateTo(String(startPath || ""), false)
    }

    function navigateTo(path, remember) {
        if (loading) return false
        loading = true
        const target = String(path || "")
        bridge.listDirectory(target, showHidden, response => {
            loading = false
            if (!response.ok) {
                listError = response.error.message
                return
            }
            if (remember !== false && currentPath.length > 0 && currentPath !== response.data.path) history = history.concat([currentPath]).slice(-32)
            listError = ""
            currentPath = response.data.path
            parentPath = response.data.parent
            entries = response.data.entries
            recent = response.data.recent
            pinned = response.data.pinned
            pathField.text = currentPath
            entryList.currentIndex = visibleEntries.length > 0 ? 0 : -1
        })
        return true
    }

    function back() {
        if (history.length === 0) return false
        const previous = history[history.length - 1]
        history = history.slice(0, -1)
        return navigateTo(previous, false)
    }

    function up() {
        return parentPath.length > 0 ? navigateTo(parentPath, true) : false
    }

    function home() {
        return navigateTo("~", true)
    }

    function enterCurrent() {
        const entry = current
        return entry ? navigateTo(entry.path, true) : false
    }

    function enterNamed(name) {
        for (const entry of entries) if (entry.name === name) return navigateTo(entry.path, true)
        return false
    }

    function moveSelection(delta) {
        if (visibleEntries.length === 0) return
        entryList.currentIndex = entryList.currentIndex < 0 ? 0 : (entryList.currentIndex + delta + visibleEntries.length) % visibleEntries.length
    }

    function toggleHidden() {
        showHidden = !showHidden
        navigateTo(currentPath, false)
    }

    function togglePin() {
        if (currentPath.length === 0) return false
        bridge.pinDirectory(currentPath, response => {
            if (response.ok) pinned = response.data.pinned
        })
        return true
    }

    function startCreate() {
        newFolderField.visible = true
        newFolderField.text = ""
        newFolderField.forceActiveFocus()
    }

    function createFolder() {
        const name = newFolderField.text.trim()
        if (name.length === 0 || currentPath.length === 0) return false
        bridge.createDirectory(currentPath, name, response => {
            if (!response.ok) {
                listError = response.error.message
                return
            }
            newFolderField.visible = false
            navigateTo(response.data.path, true)
        })
        return true
    }

    // Choose is the only action that leaves the dialog with a result.
    function choose() {
        if (answered || currentPath.length === 0) return false
        answered = true
        chosen(currentPath)
        close()
        return true
    }

    function chooseCurrentEntry() {
        const entry = current
        if (!entry) return choose()
        if (answered) return false
        answered = true
        chosen(entry.path)
        close()
        return true
    }

    onClosed: if (!answered) cancelled()

    RowLayout {
        Layout.fillWidth: true
        spacing: 6

        AppButton {
            theme: dialog.theme
            variant: "ghost"
            text: "Back"
            accessibleName: "Back to the previous folder"
            enabled: dialog.history.length > 0 && !dialog.loading
            onClicked: dialog.back()
        }
        AppButton {
            theme: dialog.theme
            variant: "ghost"
            text: "Up"
            accessibleName: "Go to the parent folder"
            enabled: dialog.parentPath.length > 0 && !dialog.loading
            onClicked: dialog.up()
        }
        AppButton {
            theme: dialog.theme
            variant: "ghost"
            text: "Home"
            accessibleName: "Go to the home folder"
            enabled: !dialog.loading
            onClicked: dialog.home()
        }
        AppButton {
            theme: dialog.theme
            variant: "ghost"
            active: dialog.showHidden
            text: "Hidden"
            accessibleName: (dialog.showHidden ? "Hide" : "Show") + " hidden folders"
            onClicked: dialog.toggleHidden()
        }
        AppButton {
            theme: dialog.theme
            variant: "ghost"
            active: dialog.pinned.indexOf(dialog.currentPath) !== -1
            text: dialog.pinned.indexOf(dialog.currentPath) !== -1 ? "Unpin" : "Pin"
            accessibleName: (dialog.pinned.indexOf(dialog.currentPath) !== -1 ? "Unpin" : "Pin") + " this folder"
            enabled: dialog.currentPath.length > 0
            onClicked: dialog.togglePin()
        }
        AppButton {
            theme: dialog.theme
            variant: "ghost"
            text: "New folder"
            accessibleName: "Create a folder here"
            enabled: dialog.currentPath.length > 0 && !dialog.loading
            onClicked: dialog.startCreate()
        }
    }

    TextField {
        id: pathField
        Layout.fillWidth: true
        placeholderText: "Type a folder path and press Enter"
        color: dialog.theme.foreground
        placeholderTextColor: dialog.theme.muted
        selectionColor: dialog.theme.selection
        font.family: dialog.theme.monospaceFamily
        background: Rectangle {
            radius: dialog.theme.radiusSmall
            color: dialog.theme.surfaceRaised
            border.width: dialog.theme.borderWidth
            border.color: pathField.activeFocus ? dialog.theme.focusRing : dialog.theme.border
        }
        Accessible.role: Accessible.EditableText
        Accessible.name: "Folder path"
        Accessible.description: "Enter opens the folder"
        onAccepted: dialog.navigateTo(text, true)
        KeyNavigation.tab: filterField
    }

    TextField {
        id: newFolderField
        Layout.fillWidth: true
        visible: false
        placeholderText: "New folder name, Enter creates it"
        color: dialog.theme.foreground
        placeholderTextColor: dialog.theme.muted
        selectionColor: dialog.theme.selection
        background: Rectangle {
            radius: dialog.theme.radiusSmall
            color: dialog.theme.surfaceRaised
            border.width: dialog.theme.borderWidth
            border.color: newFolderField.activeFocus ? dialog.theme.focusRing : dialog.theme.border
        }
        Accessible.role: Accessible.EditableText
        Accessible.name: "New folder name"
        onAccepted: dialog.createFolder()
        Keys.onEscapePressed: event => {
            visible = false
            pathField.forceActiveFocus()
            event.accepted = true
        }
    }

    SelectableText {
        Layout.fillWidth: true
        visible: dialog.listError.length > 0
        theme: dialog.theme
        text: dialog.listError
        wrapMode: TextEdit.Wrap
        color: dialog.theme.destructive
        font.pixelSize: 12
        Accessible.role: Accessible.AlertMessage
        Accessible.name: dialog.listError
    }

    Flow {
        Layout.fillWidth: true
        visible: dialog.pinned.length > 0 || dialog.recent.length > 0
        spacing: 4

        Repeater {
            model: dialog.pinned.concat(dialog.recent.filter(entry => dialog.pinned.indexOf(entry) === -1)).slice(0, 12)
            delegate: AppButton {
                required property string modelData
                theme: dialog.theme
                variant: "ghost"
                text: (dialog.pinned.indexOf(modelData) !== -1 ? "★ " : "") + modelData.split("/").filter(part => part.length > 0).slice(-1).join("")
                accessibleName: (dialog.pinned.indexOf(modelData) !== -1 ? "Pinned folder " : "Recent folder ") + modelData
                padding: 2
                leftPadding: 8
                rightPadding: 8
                onClicked: dialog.navigateTo(modelData, true)
                ToolTip.visible: hovered
                ToolTip.text: modelData
                ToolTip.delay: 400
            }
        }
    }

    TextField {
        id: filterField
        Layout.fillWidth: true
        placeholderText: "Filter folders"
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
        Accessible.name: "Filter folders"
        Accessible.description: "Arrow keys move, Enter opens the highlighted folder"
        onTextChanged: {
            dialog.filter = text
            entryList.currentIndex = dialog.visibleEntries.length > 0 ? 0 : -1
        }
        Keys.onPressed: event => {
            if (event.key === Qt.Key_Down) {
                dialog.moveSelection(1)
                event.accepted = true
            } else if (event.key === Qt.Key_Up) {
                dialog.moveSelection(-1)
                event.accepted = true
            } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                dialog.enterCurrent()
                event.accepted = true
            } else if (event.key === Qt.Key_Backspace && text.length === 0) {
                dialog.up()
                event.accepted = true
            }
        }
    }

    SelectableText {
        Layout.fillWidth: true
        visible: dialog.visibleEntries.length === 0
        theme: dialog.theme
        text: dialog.loading ? "Loading…" : dialog.entries.length === 0 ? "No subfolders" : "No matching folders"
        color: dialog.theme.muted
        font.pixelSize: 12
    }

    ListView {
        id: entryList
        Layout.fillWidth: true
        Layout.preferredHeight: Math.min(contentHeight, 260, Math.max(80, dialog.bodyViewportHeight * 0.65))
        visible: dialog.visibleEntries.length > 0
        model: dialog.visibleEntries
        clip: true
        keyNavigationEnabled: true
        keyNavigationWraps: true
        activeFocusOnTab: true
        Accessible.role: Accessible.List
        Accessible.name: "Folders in " + dialog.currentPath
        Keys.onReturnPressed: dialog.enterCurrent()
        Keys.onEnterPressed: dialog.enterCurrent()
        Keys.onBacktabPressed: event => { filterField.forceActiveFocus(); event.accepted = true }
        onCurrentIndexChanged: if (currentIndex >= 0) positionViewAtIndex(currentIndex, ListView.Contain)

        ScrollBar.vertical: ScrollBar {
            policy: ScrollBar.AsNeeded
        }

        delegate: Rectangle {
            id: entryRow
            required property int index
            required property var modelData
            readonly property bool selected: ListView.isCurrentItem
            readonly property bool focused: selected && (entryList.activeFocus || filterField.activeFocus)
            width: entryList.width
            implicitHeight: entryLabel.implicitHeight + dialog.theme.spaceXl
            radius: dialog.theme.radiusSmall
            color: dialog.theme.interactiveFill(selected, entryHover.hovered, entryTap.pressed)
            border.width: dialog.theme.focusBorderWidth
            border.color: dialog.theme.interactiveBorder(selected, focused)
            Behavior on color { ColorAnimation { duration: dialog.theme.motionNormal } }
            Behavior on border.color { ColorAnimation { duration: dialog.theme.motionNormal } }
            Accessible.role: Accessible.ListItem
            Accessible.name: String(modelData.name) + (modelData.git ? ", Git repository" : "") + (modelData.hidden ? ", hidden" : "")
            Accessible.focusable: true
            Accessible.selected: ListView.isCurrentItem

            RowLayout {
                anchors.fill: parent
                anchors.margins: dialog.theme.spaceSm
                spacing: dialog.theme.spaceMd

                SelectableText {
                    id: entryLabel
                    Layout.fillWidth: true
                    theme: dialog.theme
                    text: String(entryRow.modelData.name)
                    color: entryRow.selected ? dialog.theme.selectionForeground : dialog.theme.foreground
                    font.pixelSize: dialog.theme.typeBody + 1
                    onTapped: entryList.currentIndex = entryRow.index
                }

                StatusBadge {
                    visible: entryRow.modelData.git === true
                    theme: dialog.theme
                    kind: "ok"
                    text: "git"
                    fontSize: 10
                }
            }

            HoverHandler {
                id: entryHover
                cursorShape: Qt.PointingHandCursor
            }

            function tapHitsText(eventPoint) {
                const point = entryLabel.mapFromItem(entryRow, eventPoint.position.x, eventPoint.position.y)
                return entryLabel.contains(point)
            }

            TapHandler {
                id: entryTap
                acceptedButtons: Qt.LeftButton
                gesturePolicy: TapHandler.DragThreshold
                onTapped: entryList.currentIndex = entryRow.index
                onDoubleTapped: eventPoint => {
                    if (entryRow.tapHitsText(eventPoint)) return
                    entryList.currentIndex = entryRow.index
                    dialog.enterCurrent()
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
            text: dialog.currentPath
            color: dialog.theme.muted
            font.family: dialog.theme.monospaceFamily
            font.pixelSize: dialog.theme.typeSmall
        }

        AppButton {
            theme: dialog.theme
            text: "Cancel"
            accessibleName: "Cancel opening a folder"
            onClicked: dialog.close()
        }

        AppButton {
            theme: dialog.theme
            variant: "primary"
            text: "Open this folder"
            accessibleName: "Open " + dialog.currentPath + " in a new tab"
            enabled: dialog.currentPath.length > 0 && !dialog.loading
            onClicked: dialog.choose()
        }
    }
}
