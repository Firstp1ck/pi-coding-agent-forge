import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtTest
import "dialogs"
import "components"

Item {
    width: 560
    height: 520
    Theme { id: theme }
    ConfirmDialog { id: confirm; theme: theme }
    PickerDialog { id: picker; theme: theme }
    ListModel { id: notices }
    QtObject {
        id: mockBridge
        property var noticeModel: notices
        property int noticeRevision: 0
        property var resourceState: null
        property bool ready: true
        property bool active: false
        property bool resourceLoading: false
        property bool resourceActionPending: false
        property bool modelActionPending: false
        property int maxResourceNames: 64
        property bool backendRunning: false
        property string callerCwd: "/fixture"
        property string activeTabId: "fixture"
        property string workspaceCwd: "/fixture"
        property string statusKind: "idle"
        property string statusText: "Ready"
        property string runtimeInfoText: "model"
        property string sessionName: "fixture"
        property string sessionFile: ""
        property int pendingRequestCount: 0
        property int staleResponses: 0
        property int droppedEvents: 0
        property int maxDialogValueCharacters: 16384
        function updateDialogDraft(id, text) {}
        function answerDialog(id, answer) { return false }
    }
    ExtensionDialog { id: extension; theme: theme; bridge: mockBridge }
    DiagnosticsDialog { id: diagnostics; theme: theme; bridge: mockBridge }
    DirectoryDialog { id: directory; theme: theme; bridge: mockBridge }
    EventsDialog { id: events; theme: theme; bridge: mockBridge }
    InputDialog { id: input; theme: theme }
    LinkDialog { id: link; theme: theme; bridge: mockBridge }
    ResourceProfilesDialog { id: resources; theme: theme; bridge: mockBridge }
    SequencesDialog { id: sequences; theme: theme; bridge: mockBridge }
    TextEditDialog { id: textEditor; theme: theme }
    WorktreeDialog { id: worktree; theme: theme }
    Composer { id: composer; x: 0; y: 0; width: 260; theme: theme; ready: true; active: true }

    TestCase {
        name: "BoundedDialogsAndRunControls"
        when: windowShown

        function find(item, predicate) {
            if (predicate(item)) return item
            for (const child of item.children) {
                const match = find(child, predicate)
                if (match) return match
            }
            return null
        }

        function assertBounds(dialog) {
            wait(50)
            const overlay = dialog.parent
            verify(dialog.x >= 0 && dialog.y >= 0, "dialog starts within overlay")
            verify(dialog.x + dialog.width <= overlay.width + 1, "dialog width within overlay")
            verify(dialog.y + dialog.height <= overlay.height + 1, "dialog height within overlay: " + (dialog.y + dialog.height) + "/" + overlay.height)
            verify(dialog.testBody.height > 0)
            verify(dialog.testBody.contentHeight >= dialog.testBody.height)
            const actions = dialog.testActions
            const origin = actions.mapToItem(dialog.contentItem, 0, 0)
            verify(origin.y >= 0 && origin.y + actions.height <= dialog.contentItem.height + 1,
                   "action area visible: " + origin.y + " + " + actions.height + " <= " + dialog.height)
            let buttonCount = 0
            function checkButtons(item) {
                for (const child of item.children) {
                    if (!child.visible || child.width <= 0 || child.height <= 0) continue
                    if (child.accessibleName !== undefined && child.accessibleName.length > 0) {
                        buttonCount++
                        const rect = child.mapToItem(dialog.contentItem, 0, 0)
                        verify(rect.y >= 0 && rect.y + child.height <= dialog.contentItem.height + 1, "button in dialog")
                        verify(rect.x >= 0 && rect.x + child.width <= dialog.contentItem.width + 1, "button " + child.accessibleName + " horizontally in dialog: " + rect.x + "+" + child.width + "/" + dialog.contentItem.width)
                    }
                    checkButtons(child)
                }
            }
            checkButtons(actions)
            verify(buttonCount > 0, "each dialog mode has persistent action buttons")
        }

        function test_geometry_data() {
            return [{ tag: "light", mode: "light" }, { tag: "dark", mode: "dark" }]
        }

        function test_geometry(data) {
            theme.requestedMode = data.mode
            confirm.present({ title: "A very long heading ".repeat(36), message: "An untrusted plain question <script> ".repeat(110),
                              detail: "Validation failed: ".repeat(80), confirmLabel: "Confirm " .repeat(30) })
            assertBounds(confirm)
            verify(confirm.testBody.contentHeight > confirm.testBody.height)
            confirm.testBody.contentY = confirm.testBody.contentHeight - confirm.testBody.height
            verify(confirm.testBody.contentY > 0)
            confirm.close()

            const choices = []
            for (let i = 0; i < 64; i++) choices.push({ value: String(i), label: "Option " + i + " " + "long label ".repeat(36), detail: "detail " .repeat(12) })
            picker.present({ title: "Select", message: "Long question ".repeat(90), items: choices })
            assertBounds(picker)
            verify(picker.testOptions.height <= picker.testBody.height)
            const longLabel = find(picker.testOptions.currentItem, item => item.text === choices[0].label)
            verify(longLabel !== null && longLabel.height > 2 * theme.typeBody, "long choice wraps instead of eliding")
            for (let i = 0; i < choices.length; i++) {
                picker.testOptions.currentIndex = i
                picker.testOptions.positionViewAtIndex(i, ListView.Contain)
                wait(25)
                picker.testOptions.positionViewAtIndex(i, ListView.Contain)
                verify(picker.testOptions.currentItem !== null)
                const row = picker.testOptions.currentItem
                verify(row.y + row.height > picker.testOptions.contentY - 1 && row.y < picker.testOptions.contentY + picker.testOptions.height + 1,
                       "choice " + i + " is reachable")
            }
            picker.close()

            extension.present({ method: "select", requestId: "geometry", title: "Extension question " .repeat(40),
                                message: "Prompt " .repeat(120), options: choices.map(item => item.label), placeholder: "", state: "open" })
            extension.settle("open", "Validation error " .repeat(55))
            assertBounds(extension)
            for (let i = 0; i < choices.length; i++) {
                extension.testOptions.currentIndex = i
                extension.testOptions.positionViewAtIndex(i, ListView.Contain)
                wait(25)
                extension.testOptions.positionViewAtIndex(i, ListView.Contain)
                const row = extension.testOptions.currentItem
                verify(row !== null && row.y + row.height > extension.testOptions.contentY - 1
                       && row.y < extension.testOptions.contentY + extension.testOptions.height + 1,
                       "extension choice " + i + " is reachable")
            }
            extension.close()
            extension.present({ method: "editor", requestId: "editor", title: "Edit reply", message: "Question " .repeat(95),
                                prefill: "Attached text ".repeat(150), placeholder: "", state: "open" })
            extension.setEditorText("x".repeat(16385))
            extension.settle("open", "Validation error " .repeat(55))
            assertBounds(extension)
            extension.close()

            input.present({ title: "Long input question ".repeat(40), message: "Details ".repeat(80),
                            prefill: "invalid", validate: value => "Validation error ".repeat(60) })
            assertBounds(input)
            input.close()
            textEditor.present({ title: "Edit attachment", message: "Instructions ".repeat(80), text: "Long entry ".repeat(100) })
            assertBounds(textEditor)
            textEditor.close()
            link.url = "https://example.invalid/" + "long-path/".repeat(80)
            for (const other of [link, worktree, directory, events, diagnostics, resources]) {
                other.open()
                assertBounds(other)
                other.close()
            }
            sequences.sequences = Array.from({ length: 32 }, (_, i) => ({ id: String(i), name: "Name " + i, entries: ["Example"] }))
            sequences.mode = "list"
            sequences.open()
            assertBounds(sequences)
            for (const action of ["Run the selected sequence", "Load the selected sequence into the prompt editor",
                                  "Create a new sequence", "Edit the selected sequence", "Move the selected sequence up",
                                  "Move the selected sequence down", "Delete the selected sequence", "Close sequences"]) {
                verify(find(sequences.testActions, item => item.accessibleName === action) !== null,
                       action + " stays outside the scrollable body")
            }
            sequences.mode = "edit"
            assertBounds(sequences)
            sequences.close()

            composer.attachments = [{ id: "one", name: "long-name-".repeat(30), kind: "text", size: 200, edited: false }]
            composer.lockedAttachmentIds = ["one"]
            wait(40)
            for (const action of ["Edit attachment ", "Remove attachment "]) {
                const button = find(composer, item => item.accessibleName !== undefined && item.accessibleName.indexOf(action) === 0)
                verify(button !== null && !button.enabled, "pending attachment action remains locked")
                const chipPosition = button.mapToItem(composer, 0, 0)
                verify(chipPosition.x >= 0 && chipPosition.x + button.width <= composer.width + 1,
                       "locked attachment control visible at narrow width")
            }
            const abort = find(composer, item => item.accessibleName === "Abort the current run")
            verify(abort !== null && abort.visible)
            const pos = abort.mapToItem(composer, 0, 0)
            verify(pos.x >= 0 && pos.x + abort.width <= composer.width + 1,
                   "Abort within 260px: " + pos.x + " + " + abort.width)
            verify(pos.y >= 0 && pos.y + abort.height <= composer.height + 1)

        }
    }
}
