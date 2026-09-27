import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../components"

// Edits the enabled tools, enabled skills, and sampling values for one explicit scope. Drafts
// never apply implicitly: the user chooses a scope, sees inheritance/effective sources, and saves.
AppDialog {
    id: dialog

    required property var bridge
    property string scope: "session" // session | model | global
    property string section: "tools" // tools | skills | sampling
    property string listMode: "inherit" // inherit | custom
    property var listDraft: []
    property var samplingDraft: ({})
    readonly property var state: bridge.resourceState
    readonly property bool available: state !== null && state.available === true
    readonly property bool controlsEnabled: available && bridge.ready && !bridge.active && !bridge.modelActionPending && !bridge.resourceActionPending && !bridge.resourceLoading
    readonly property var samplingKeys: ["temperature", "top_p", "frequency_penalty", "presence_penalty", "seed", "top_k", "min_p"]
    readonly property var samplingRanges: ({
        temperature: { label: "Temperature", min: 0, max: 2, integer: false },
        top_p: { label: "Top P", min: 0, max: 1, integer: false },
        frequency_penalty: { label: "Frequency penalty", min: -2, max: 2, integer: false },
        presence_penalty: { label: "Presence penalty", min: -2, max: 2, integer: false },
        seed: { label: "Seed", min: 0, max: 9007199254740991, integer: true },
        top_k: { label: "Top K", min: 1, max: 1000, integer: true },
        min_p: { label: "Min P", min: 0, max: 1, integer: false }
    })
    readonly property var visibleInventory: inventoryForSection().slice(0, bridge.maxResourceNames)
    readonly property int visibleCount: visibleInventory.length
    readonly property string unavailableMessage: state && state.error && state.error.message
        ? String(state.error.message) : "Pi did not report resource capabilities."
    readonly property bool samplingDraftValid: samplingProblem().length === 0
    readonly property bool sessionNonDurable: available && scope === "session" && state.sessionDurability
        && state.sessionDurability.durable === false
    readonly property string sessionDurabilityReason: sessionNonDurable
        ? String(state.sessionDurability.reason || "This session profile applies only until the session ends.") : ""

    title: "Resource profiles"
    message: available ? "Choose where the profile applies. Changes take effect immediately in this idle tab."
        : bridge.resourceLoading ? "Loading Pi's tools, skills, and sampling capabilities…" : unavailableMessage
    width: Math.min(parent ? parent.width - 24 : 760, 760)
    initialFocusItem: sessionScopeButton

    function present() {
        scope = "session"
        section = "tools"
        syncDraft()
        open()
        bridge.refreshResources()
    }

    function profile() {
        if (!available || !state.profiles) return { tools: null, skills: null, sampling: {} }
        return state.profiles[scope] || { tools: null, skills: null, sampling: {} }
    }

    function inventoryForSection() {
        if (!available) return []
        if (section === "tools") return state.tools && Array.isArray(state.tools.all) ? state.tools.all : []
        if (section === "skills") return state.skills && Array.isArray(state.skills.all) ? state.skills.all : []
        return []
    }

    function effectiveList(field) {
        if (!available || !state.effective) return null
        return state.effective[field]
    }

    function effectiveSource(field) {
        if (!available || !state.effective) return "unavailable"
        const source = String(state.effective[field + "Source"] || "inherit")
        return source === "inherit" ? "Pi defaults" : scopeLabel(source)
    }

    function listSummary(values) {
        if (values === null || values === undefined) return "Pi defaults"
        if (!Array.isArray(values) || values.length === 0) return "Intentionally none"
        if (values.length <= 4) return values.join(", ")
        return values.slice(0, 4).join(", ") + " and " + (values.length - 4) + " more"
    }

    function scopeLabel(value) {
        if (value === "session") return "Session"
        if (value === "model") return "This model"
        if (value === "global") return "Global"
        return "Pi defaults"
    }

    function setScope(value) {
        if (bridge.active || ["session", "model", "global"].indexOf(value) === -1) return false
        scope = value
        syncDraft()
        return true
    }

    function setSection(value) {
        if (bridge.active || ["tools", "skills", "sampling"].indexOf(value) === -1) return false
        section = value
        syncDraft()
        return true
    }

    function syncDraft() {
        const current = profile()
        if (section === "tools" || section === "skills") {
            const values = current[section]
            listMode = values === null || values === undefined ? "inherit" : "custom"
            listDraft = Array.isArray(values) ? values.slice() : []
        }
        const nextSampling = {}
        const saved = current.sampling || {}
        for (const key of samplingKeys) if (saved[key] !== undefined) nextSampling[key] = String(saved[key])
        samplingDraft = nextSampling
    }

    function chooseInherit() {
        if (!controlsEnabled || section === "sampling") return false
        listMode = "inherit"
        listDraft = []
        return true
    }

    function chooseNone() {
        if (!controlsEnabled || section === "sampling") return false
        listMode = "custom"
        listDraft = []
        return true
    }

    function toggleName(name) {
        if (!controlsEnabled || section === "sampling") return false
        const value = String(name)
        const next = listMode === "custom" ? listDraft.slice() : []
        const index = next.indexOf(value)
        if (index === -1) {
            if (next.length >= bridge.maxResourceNames) return false
            next.push(value)
        } else next.splice(index, 1)
        listMode = "custom"
        listDraft = next
        return true
    }

    function visibleListDraft() {
        if (listMode === "inherit") return null
        const visibleNames = []
        for (const item of visibleInventory) {
            const name = item && item.name !== undefined ? String(item.name) : ""
            if (name.length > 0 && visibleNames.indexOf(name) === -1) visibleNames.push(name)
        }
        return listDraft.filter(name => visibleNames.indexOf(String(name)) !== -1).slice(0, bridge.maxResourceNames)
    }

    function samplingCapability(key) {
        if (!available || !state.sampling || !state.sampling.capabilities) return { supported: false, reason: "Capabilities are unavailable" }
        return state.sampling.capabilities[key] || { supported: false, reason: "Capability is unavailable" }
    }

    function samplingSupported(key) {
        return samplingCapability(key).supported === true
    }

    function samplingReason(key) {
        return String(samplingCapability(key).reason || "")
    }

    function samplingStored(key) {
        const saved = profile().sampling || {}
        return saved[key] !== undefined ? saved[key] : undefined
    }

    function samplingEffective(key) {
        return available && state.effective && state.effective.sampling && state.effective.sampling[key] !== undefined
            ? state.effective.sampling[key] : undefined
    }

    function samplingSource(key) {
        return available && state.effective && state.effective.samplingSources && state.effective.samplingSources[key]
            ? scopeLabel(String(state.effective.samplingSources[key])) : "Pi defaults"
    }

    function setSamplingValue(key, value) {
        if (!controlsEnabled || !samplingSupported(key) || samplingKeys.indexOf(key) === -1) return false
        const next = Object.assign({}, samplingDraft)
        const text = String(value).trim()
        if (text.length === 0) delete next[key]
        else next[key] = text
        samplingDraft = next
        return true
    }

    function numberProblemFor(key, text) {
        if (String(text || "").trim().length === 0) return ""
        const range = samplingRanges[key]
        const value = Number(text)
        if (!Number.isFinite(value)) return range.label + " must be a number"
        if (range.integer && !Number.isInteger(value)) return range.label + " must be a whole number"
        if (value < range.min || value > range.max) return range.label + " must be between " + range.min + " and " + (key === "seed" ? "2^53" : range.max)
        return ""
    }

    function samplingProblem() {
        for (const key of samplingKeys) {
            if (!samplingSupported(key)) continue
            const problem = numberProblemFor(key, samplingDraft[key])
            if (problem.length > 0) return problem
        }
        return ""
    }

    function samplingPatch() {
        const patch = {}
        for (const key of samplingKeys) {
            const text = samplingDraft[key]
            patch[key] = text === undefined || String(text).trim().length === 0 ? null : Number(text)
        }
        return patch
    }

    function saveCurrent(callback) {
        if (!controlsEnabled) return false
        if (section === "tools") return bridge.setEnabledTools(scope, visibleListDraft(), callback)
        if (section === "skills") return bridge.setEnabledSkills(scope, visibleListDraft(), callback)
        if (!samplingDraftValid) return false
        return bridge.setSampling(scope, samplingPatch(), callback)
    }

    Connections {
        target: dialog.bridge
        function onResourceStateChanged() { dialog.syncDraft() }
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 6
        Accessible.role: Accessible.Grouping
        Accessible.name: "Profile scope"

        AppButton {
            id: sessionScopeButton
            theme: dialog.theme
            variant: "ghost"
            text: "Session"
            active: dialog.scope === "session"
            accessibleName: "Session profile scope"
            accessibleDescription: "Overrides this Pi session only"
            enabled: !dialog.bridge.active
            onClicked: dialog.setScope("session")
        }
        AppButton {
            theme: dialog.theme
            variant: "ghost"
            text: "This model"
            active: dialog.scope === "model"
            accessibleName: "Exact model profile scope"
            accessibleDescription: dialog.available ? dialog.state.model.provider + "/" + dialog.state.model.id : "The active provider and model"
            enabled: !dialog.bridge.active
            onClicked: dialog.setScope("model")
        }
        AppButton {
            theme: dialog.theme
            variant: "ghost"
            text: "Global"
            active: dialog.scope === "global"
            accessibleName: "Global profile scope"
            accessibleDescription: "Applies when session and model profiles inherit"
            enabled: !dialog.bridge.active
            onClicked: dialog.setScope("global")
        }
        Item { Layout.fillWidth: true }
        AppButton {
            theme: dialog.theme
            variant: "ghost"
            text: dialog.bridge.resourceLoading ? "Refreshing…" : "Refresh"
            accessibleName: "Refresh resource capabilities"
            enabled: dialog.bridge.ready && !dialog.bridge.active && !dialog.bridge.resourceLoading && !dialog.bridge.resourceActionPending && !dialog.bridge.modelActionPending
            onClicked: dialog.bridge.refreshResources()
        }
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 6
        Accessible.role: Accessible.PageTabList
        Accessible.name: "Resource profile sections"

        Repeater {
            model: [{ key: "tools", label: "Tools" }, { key: "skills", label: "Skills" }, { key: "sampling", label: "Sampling" }]
            delegate: AppButton {
                required property var modelData
                theme: dialog.theme
                variant: "ghost"
                text: modelData.label
                active: dialog.section === modelData.key
                accessibleName: modelData.label + " profile"
                Accessible.role: Accessible.PageTab
                Accessible.selected: active
                enabled: !dialog.bridge.active
                onClicked: dialog.setSection(modelData.key)
            }
        }
        Item { Layout.fillWidth: true }
        SelectableText {
            theme: dialog.theme
            text: dialog.scopeLabel(dialog.scope)
            color: dialog.theme.muted
            font.pixelSize: 11
        }
    }

    Rectangle {
        Layout.fillWidth: true
        visible: !dialog.available || dialog.bridge.active
        implicitHeight: availabilityLabel.implicitHeight + 16
        radius: dialog.theme.radiusSmall
        color: dialog.theme.warningPanelBackground
        border.width: dialog.theme.borderWidth
        border.color: dialog.theme.warningPanelBorder
        Accessible.role: Accessible.AlertMessage
        Accessible.name: availabilityLabel.text

        SelectableText {
            id: availabilityLabel
            anchors.fill: parent
            anchors.margins: 8
            theme: dialog.theme
            text: dialog.bridge.active ? "Pi is working. Resource controls stay disabled until the run ends." : dialog.unavailableMessage
            wrapMode: TextEdit.Wrap
            color: dialog.theme.warningPanelForeground
            font.pixelSize: 12
        }
    }

    Rectangle {
        Layout.fillWidth: true
        visible: dialog.sessionNonDurable
        implicitHeight: durabilityLabel.implicitHeight + 16
        radius: dialog.theme.radiusSmall
        color: dialog.theme.warningPanelBackground
        border.width: dialog.theme.borderWidth
        border.color: dialog.theme.warningPanelBorder
        Accessible.role: Accessible.AlertMessage
        Accessible.name: durabilityLabel.text

        SelectableText {
            id: durabilityLabel
            anchors.fill: parent
            anchors.margins: 8
            theme: dialog.theme
            text: dialog.sessionDurabilityReason + " Changes apply now, but they are not saved durably."
            wrapMode: TextEdit.Wrap
            color: dialog.theme.warningPanelForeground
            font.pixelSize: 12
        }
    }

    ColumnLayout {
        Layout.fillWidth: true
        visible: dialog.available && dialog.section !== "sampling"
        spacing: 6

        SelectableText {
            Layout.fillWidth: true
            theme: dialog.theme
            text: "Effective " + dialog.section + ": " + dialog.listSummary(dialog.effectiveList(dialog.section)) + " · source: " + dialog.effectiveSource(dialog.section)
            wrapMode: TextEdit.Wrap
            color: dialog.theme.foreground
            font.pixelSize: 12
            Accessible.role: Accessible.StaticText
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 6
            AppButton {
                theme: dialog.theme
                variant: "ghost"
                text: "Inherit"
                active: dialog.listMode === "inherit"
                accessibleName: "Inherit " + dialog.section + " from the next scope"
                enabled: dialog.controlsEnabled
                onClicked: dialog.chooseInherit()
            }
            AppButton {
                theme: dialog.theme
                variant: "ghost"
                text: "None"
                active: dialog.listMode === "custom" && dialog.listDraft.length === 0
                accessibleName: "Enable no " + dialog.section + " intentionally"
                enabled: dialog.controlsEnabled
                onClicked: dialog.chooseNone()
            }
            SelectableText {
                Layout.fillWidth: true
                theme: dialog.theme
                text: dialog.listMode === "inherit" ? "Stored here: inherit" : dialog.listDraft.length === 0 ? "Stored here: intentionally none" : "Stored here: " + dialog.listDraft.length + " enabled"
                color: dialog.theme.muted
                font.pixelSize: 11
            }
        }

        ListView {
            id: resourceList
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(contentHeight, 220, Math.max(80, dialog.bodyViewportHeight * 0.65))
            model: dialog.visibleInventory
            clip: true
            keyNavigationEnabled: true
            keyNavigationWraps: true
            activeFocusOnTab: true
            Accessible.role: Accessible.List
            Accessible.name: "Available " + dialog.section

            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            delegate: CheckBox {
                id: resourceRow
                required property int index
                required property var modelData
                readonly property string resourceName: String(modelData.name || "")
                readonly property string details: dialog.section === "tools"
                    ? [String(modelData.description || ""), String(modelData.source || "")].filter(value => value.length > 0).join(" · ")
                    : [String(modelData.description || ""), modelData.disableModelInvocation === true ? "manual invocation only" : ""].filter(value => value.length > 0).join(" · ")
                width: resourceList.width
                checked: dialog.listMode === "custom" && dialog.listDraft.indexOf(resourceName) !== -1
                enabled: dialog.controlsEnabled
                text: details.length > 0 ? resourceName + " — " + details : resourceName
                focusPolicy: Qt.StrongFocus
                Accessible.role: Accessible.CheckBox
                Accessible.name: "Enable " + dialog.section.slice(0, -1) + " " + resourceName
                Accessible.description: details
                Accessible.checked: checked
                onToggled: dialog.toggleName(resourceName)
            }
        }

        SelectableText {
            Layout.fillWidth: true
            theme: dialog.theme
            text: dialog.visibleCount + " available (maximum " + dialog.bridge.maxResourceNames + ")"
            color: dialog.theme.muted
            font.pixelSize: 10
        }
    }

    ColumnLayout {
        Layout.fillWidth: true
        visible: dialog.available && dialog.section === "sampling"
        spacing: 5

        SelectableText {
            Layout.fillWidth: true
            theme: dialog.theme
            text: "Blank values inherit. Unsupported stored values remain saved but are not sent to the provider."
            wrapMode: TextEdit.Wrap
            color: dialog.theme.foreground
            font.pixelSize: 12
        }

        Repeater {
            model: dialog.samplingKeys
            delegate: RowLayout {
                id: samplingRow
                required property string modelData
                readonly property var range: dialog.samplingRanges[modelData]
                readonly property bool supported: dialog.samplingSupported(modelData)
                Layout.fillWidth: true
                spacing: 8
                Accessible.role: Accessible.Grouping
                Accessible.name: range.label + (supported ? "" : ", unavailable: " + dialog.samplingReason(modelData))

                SelectableText {
                    Layout.preferredWidth: 130
                    theme: dialog.theme
                    text: samplingRow.range.label
                    color: samplingRow.supported ? dialog.theme.foreground : dialog.theme.disabledForeground
                    font.pixelSize: 12
                }

                TextField {
                    id: samplingField
                    Layout.preferredWidth: 120
                    text: dialog.samplingDraft[samplingRow.modelData] === undefined ? "" : String(dialog.samplingDraft[samplingRow.modelData])
                    placeholderText: "Inherit"
                    enabled: dialog.controlsEnabled && samplingRow.supported
                    color: enabled ? dialog.theme.foreground : dialog.theme.disabledForeground
                    placeholderTextColor: dialog.theme.muted
                    selectionColor: dialog.theme.selection
                    inputMethodHints: Qt.ImhFormattedNumbersOnly
                    Accessible.role: Accessible.EditableText
                    Accessible.name: samplingRow.range.label + " for " + dialog.scopeLabel(dialog.scope)
                    Accessible.description: samplingRow.supported ? "Allowed range " + samplingRow.range.min + " to " + (samplingRow.modelData === "seed" ? "2^53" : samplingRow.range.max) : dialog.samplingReason(samplingRow.modelData)
                    onTextEdited: dialog.setSamplingValue(samplingRow.modelData, text)
                    background: Rectangle {
                        radius: dialog.theme.radiusSmall
                        color: dialog.theme.surfaceRaised
                        border.width: dialog.theme.borderWidth
                        border.color: samplingField.activeFocus ? dialog.theme.focusRing : dialog.theme.border
                    }
                }

                SelectableText {
                    Layout.fillWidth: true
                    theme: dialog.theme
                    text: {
                        const effective = dialog.samplingEffective(samplingRow.modelData)
                        const value = effective === undefined ? "Pi default" : String(effective)
                        const stored = dialog.samplingStored(samplingRow.modelData)
                        const preserved = !samplingRow.supported && stored !== undefined ? " · stored here: " + stored + " (preserved)" : ""
                        return "Effective " + value + " · source: " + dialog.samplingSource(samplingRow.modelData) + preserved
                            + (samplingRow.supported ? "" : " · " + dialog.samplingReason(samplingRow.modelData))
                    }
                    wrapMode: TextEdit.Wrap
                    color: samplingRow.supported ? dialog.theme.muted : dialog.theme.warningPanelForeground
                    font.pixelSize: 10
                    Accessible.role: Accessible.StaticText
                }
            }
        }

        SelectableText {
            Layout.fillWidth: true
            visible: !dialog.samplingDraftValid
            theme: dialog.theme
            text: dialog.samplingProblem()
            color: dialog.theme.destructive
            font.pixelSize: 11
            Accessible.role: Accessible.AlertMessage
        }
    }

    actions: RowLayout {
        Layout.fillWidth: true
        spacing: 8
        Item { Layout.fillWidth: true }
        AppButton {
            theme: dialog.theme
            text: "Close"
            accessibleName: "Close resource profiles"
            onClicked: dialog.close()
        }
        AppButton {
            theme: dialog.theme
            variant: "primary"
            text: dialog.bridge.resourceActionPending ? "Saving…" : "Save " + dialog.section
            accessibleName: "Save " + dialog.scopeLabel(dialog.scope).toLowerCase() + " " + dialog.section + " profile"
            accessibleDescription: dialog.controlsEnabled ? "Applies immediately to this idle tab" : dialog.bridge.active ? "Pi is working" : "Resource controls are unavailable"
            enabled: dialog.controlsEnabled && (dialog.section !== "sampling" || dialog.samplingDraftValid)
            onClicked: dialog.saveCurrent()
        }
    }
}
