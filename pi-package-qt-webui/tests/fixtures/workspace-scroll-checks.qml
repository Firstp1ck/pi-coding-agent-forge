import QtQuick
import QtQuick.Controls
import QtTest

Item {
    width: 440
    height: 800
    Theme { id: theme }
    SessionList {
        id: workspaces
        width: 360
        height: 740
        theme: theme
    }
    SignalSpy { id: opened; target: workspaces; signalName: "sessionRequested" }

    TestCase {
        name: "WorkspaceScroll"
        when: windowShown

        function init() {
            theme.requestedMode = "dark"
            workspaces.settledExpanded = true
            workspaces.searchQuery = ""
            workspaces.warningText = ""
            workspaces.width = 360
            workspaces.forceActiveFocus()
            const rows = []
            for (let i = 0; i < 80; i++) rows.push({
                id: "session-" + i,
                path: "/fixture/session-" + i + ".jsonl",
                name: "Workspace " + i,
                cwd: "/fixture/project",
                settled: i >= 40,
                modified: Date.now() - 3600000 - i * 1000
            })
            workspaces.sessions = rows
            wait(100)
            for (const view of [workspaces.testWorking, workspaces.testSettled]) {
                view.cancelFlick()
                view.positionViewAtBeginning()
                view.forceLayout()
                compare(view.count, 40)
            }
            mouseMove(workspaces, 400, 760)
            opened.clear()
        }

        function test_catalogWarning_data() {
            return [
                { tag: "dark", mode: "dark", width: 360 },
                { tag: "light", mode: "light", width: 360 },
                { tag: "narrow dark", mode: "dark", width: 148 },
                { tag: "narrow light", mode: "light", width: 148 }
            ]
        }

        function test_catalogWarning(data) {
            theme.requestedMode = data.mode
            workspaces.width = data.width
            const icon = findChild(workspaces, "catalogWarningIcon")
            verify(icon !== null)
            compare(icon.visible, false)
            workspaces.warningText = "Session discovery reached its scan or retention limit; this catalog is incomplete"
            tryCompare(icon, "visible", true)
            compare(icon.contentItem.color, theme.warning)
            compare(icon.accessibleDescription, workspaces.warningText)
            // The first hover after the window appears is dropped until a frame has rendered.
            waitForRendering(workspaces)
            mouseMove(icon, icon.width / 2, icon.height / 2)
            tryCompare(icon.ToolTip.toolTip, "visible", true)
            compare(icon.ToolTip.text, workspaces.warningText)
            mouseMove(workspaces, 400, 760)
            tryCompare(icon.ToolTip.toolTip, "visible", false)
            icon.forceActiveFocus()
            tryCompare(icon.ToolTip.toolTip, "visible", true)
            compare(opened.count, 0, "warning inspection must not open a session")
            workspaces.warningText = ""
            tryCompare(icon, "visible", false)
            tryCompare(icon.ToolTip.toolTip, "visible", false)
        }

        function groups() {
            return [{ tag: "Working", settled: false }, { tag: "Settled", settled: true }]
        }

        function test_doubleWheelDistance_data() { return groups() }
        function test_doubleWheelDistance(data) {
            const view = data.settled ? workspaces.testSettled : workspaces.testWorking
            const other = data.settled ? workspaces.testWorking : workspaces.testSettled
            const start = view.contentY
            const otherStart = other.contentY
            mouseWheel(view, 50, 50, 0, -120)
            wait(100)
            compare(view.contentY - start, Qt.styleHints.wheelScrollLines * 24 * 2)
            compare(other.contentY, otherStart, "wheel input must affect only the hovered list")
            compare(opened.count, 0)
            mouseWheel(view, 50, 50, 0, 120)
            wait(100)
            verify(view.atYBeginning)
        }

        function test_pixelDistanceAndBounds_data() { return groups() }
        function test_pixelDistanceAndBounds(data) {
            const view = data.settled ? workspaces.testSettled : workspaces.testWorking
            const start = view.contentY
            verify(workspaces.scrollWorkspace(view, -120, -20))
            compare(view.contentY - start, 40)
            verify(!workspaces.scrollWorkspace(view, 0, 0))
            compare(view.contentY - start, 40)
            workspaces.scrollWorkspace(view, 0, -100000)
            verify(view.atYEnd)
            workspaces.scrollWorkspace(view, 0, 100000)
            verify(view.atYBeginning)
        }

        function luminance(color) {
            function linear(value) { return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4) }
            return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
        }

        function verifyContrast(bar) {
            const foreground = luminance(bar.contentItem.color)
            const background = luminance(bar.background.color)
            const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
            verify(ratio >= 3, "scrollbar contrast must reach 3:1; measured " + ratio)
            compare(bar.contentItem.opacity, 1)
            compare(bar.opacity, 1)
            verify(bar.visible)
        }

        function test_scrollbarStates_data() {
            return [
                { tag: "Working dark", settled: false, mode: "dark" },
                { tag: "Working light", settled: false, mode: "light" },
                { tag: "Settled dark", settled: true, mode: "dark" },
                { tag: "Settled light", settled: true, mode: "light" }
            ]
        }
        function test_scrollbarStates(data) {
            theme.requestedMode = data.mode
            const view = data.settled ? workspaces.testSettled : workspaces.testWorking
            const bar = data.settled ? workspaces.testSettledBar : workspaces.testWorkingBar
            wait(100)
            compare(bar.contentItem.color, theme.accent)
            verifyContrast(bar)
            verify(view.currentItem.width <= view.width - bar.width, "scrollbar must not cover row controls")
            const y = bar.contentItem.y + bar.contentItem.height / 2
            mouseMove(bar, bar.width / 2, y)
            wait(50)
            verify(bar.hovered)
            compare(bar.contentItem.color, theme.accentForeground)
            verifyContrast(bar)
            mousePress(bar, bar.width / 2, y)
            verify(bar.pressed)
            compare(bar.contentItem.color, theme.foreground)
            verifyContrast(bar)
            mouseMove(bar, bar.width / 2, y + 70, 50)
            mouseRelease(bar, bar.width / 2, y + 70)
            verify(view.contentY > view.originY, "scrollbar dragging must still work")
            compare(opened.count, 0, "scrollbar dragging must not open a session")
            mouseMove(workspaces, 400, 760)
            wait(600)
            compare(bar.contentItem.color, theme.accent)
            verifyContrast(bar)
        }

        function test_shortListsAndCollapse() {
            workspaces.sessions = workspaces.sessions.slice(0, 1)
            wait(100)
            for (const view of [workspaces.testWorking, workspaces.testSettled]) {
                workspaces.scrollWorkspace(view, 0, -1000)
                verify(view.atYBeginning && view.atYEnd)
            }
            workspaces.toggleSettled()
            verify(!workspaces.testSettled.visible)
        }
    }
}
