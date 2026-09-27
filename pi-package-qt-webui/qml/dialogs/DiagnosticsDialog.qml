import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

// Advanced diagnostics: process ids, session identity, paths, protocol health, and recent
// errors, as plain text that can be copied into a bug report.
AppDialog {
    id: dialog

    required property var bridge
    property var data: null
    property bool loading: false
    readonly property string report: buildReport(data, bridge.noticeRevision)

    title: "Diagnostics"
    width: Math.min(parent ? parent.width - 40 : 720, 720)
    initialFocusItem: reportEdit

    function present() {
        refresh()
        open()
    }

    function refresh() {
        loading = true
        bridge.loadDiagnostics(response => {
            loading = false
            data = response.ok ? response.data : null
            if (!response.ok) bridge.postNotice("error", "Diagnostics are unavailable: " + response.error.message)
        })
        return true
    }

    function buildReport(info, revision) {
        const lines = []
        lines.push("Qt WebUI diagnostics")
        lines.push("Backend: " + (bridge.backendRunning ? "running" : "stopped") + (info ? ", pid " + info.backendPid + ", uptime " + Math.round(info.uptimeMs / 1000) + " s, rss " + Math.round(info.memoryRssBytes / 1048576) + " MiB" : ""))
        lines.push("Launch directory: " + bridge.callerCwd)
        lines.push("Active tab: " + bridge.activeTabId + " (" + bridge.workspaceCwd + ")")
        lines.push("Pi: " + bridge.statusKind + " / " + bridge.statusText + (bridge.ready ? ", ready" : ", not ready") + (bridge.active ? ", active" : ""))
        lines.push("Model: " + (bridge.runtimeInfoText.length > 0 ? bridge.runtimeInfoText : "unknown"))
        lines.push("Session: " + (bridge.sessionName.length > 0 ? bridge.sessionName + " " : "") + (bridge.sessionFile.length > 0 ? bridge.sessionFile : "none"))
        lines.push("Client requests: pending " + bridge.pendingRequestCount + ", stale responses " + bridge.staleResponses + ", dropped events " + bridge.droppedEvents)
        if (info) {
            lines.push("Backend queue: peak " + info.stats.maxWritableLength + " bytes, dropped " + info.stats.droppedTotal + ", backpressure pauses " + info.stats.backpressurePauses + ", in flight " + info.stats.inflight + ", events " + info.stats.sequence)
            lines.push("Transport: current " + info.stats.queuedBytes + " bytes / " + info.stats.queuedRecords + " records; peak records " + info.stats.peakQueuedRecords + "; paused " + info.stats.producersPaused + "; peak admitted " + info.stats.peakAdmittedWork + "; slow-consumer exits " + info.stats.slowConsumerShutdowns)
            if (info.catalog) lines.push("Catalog: " + JSON.stringify(info.catalog))
            if (info.snapshotLoads) lines.push("Snapshot loads: " + JSON.stringify(info.snapshotLoads))
            lines.push("Paths: settings " + info.paths.settings + "; state " + info.paths.state + "; sequences " + info.paths.sequences)
            lines.push("Tabs (" + info.tabs.tabs.length + "):")
            for (const tab of info.tabs.tabs) lines.push("  " + tab.id + (tab.id === info.tabs.activeTab ? " *" : "") + " pid " + (tab.pid === null ? "-" : tab.pid) + " " + tab.statusKind + " " + tab.cwd + (tab.sessionFile ? " · " + tab.sessionFile : ""))
        }
        const errors = []
        const model = bridge.noticeModel
        for (let index = model.count - 1; index >= 0 && errors.length < 10; index--) {
            const notice = model.get(index)
            if (notice.level === "error") errors.push("  " + String(notice.message))
        }
        lines.push("Recent errors (" + errors.length + "):")
        for (const line of errors) lines.push(line)
        return lines.join("\n")
    }

    function copyReport() {
        return bridge.copyToClipboard(report)
    }

    ScrollView {
        Layout.fillWidth: true
        Layout.preferredHeight: 320
        clip: true

        TextEdit {
            id: reportEdit
            width: parent.width
            text: dialog.report
            textFormat: TextEdit.PlainText
            readOnly: true
            selectByMouse: true
            selectByKeyboard: true
            persistentSelection: true
            wrapMode: TextEdit.WrapAnywhere
            color: dialog.theme.foreground
            selectionColor: dialog.theme.selection
            font.family: dialog.theme.monospaceFamily
            font.pixelSize: 11
            Accessible.role: Accessible.StaticText
            Accessible.name: "Diagnostics report"
        }
    }

    actions: RowLayout {
        Layout.fillWidth: true
        spacing: 8

        SelectableText {
            Layout.fillWidth: true
            theme: dialog.theme
            text: dialog.loading ? "Refreshing…" : ""
            color: dialog.theme.muted
            font.pixelSize: 11
        }

        AppButton {
            theme: dialog.theme
            variant: "ghost"
            text: "Refresh"
            accessibleName: "Refresh diagnostics"
            enabled: !dialog.loading
            onClicked: dialog.refresh()
        }

        AppButton {
            theme: dialog.theme
            variant: "ghost"
            text: "Copy"
            accessibleName: "Copy the diagnostics report"
            onClicked: dialog.copyReport()
        }

        AppButton {
            theme: dialog.theme
            text: "Close"
            accessibleName: "Close diagnostics"
            onClicked: dialog.close()
        }
    }
}
