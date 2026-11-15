import { createHash } from "node:crypto";
import { lstat, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "pi-package-webui";
const DESTINATIONS = "pi-package-webui/docs/overhaul/feature-destinations.md";
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_OUTPUT = `${PACKAGE}/docs/overhaul/capability-inventory.json`;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const digest = (text) => createHash("sha256").update(text).digest("hex");
const sorted = (items) => items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Row order follows the canonical plan's feature destination map. These are
// evidence annotations, never handlers or a replacement companion registry.
const CONTRACTS = [
  ["sessions", "tab/workspace", "createTerminalTab openNativeResumeSelector saveWebuiWorkspace", "terminal-tab-workspace-static workspace-save-load-static tab-close-continuity-static", /mobileSession|terminal|workspace|newtab|closetab|resumesession|tab_storage|custom.groups/i],
  ["session-actions", "active tab / durable session", "openNativeForkSelector openNativeCloneDialog openNativeNameDialog openNativeTreeSelector openSessionSummaryForTab", "native-parity session-summary-core session-tree-event-targets", /newsession|session.summary|sessionSummary|native.*(?:fork|clone|name|tree|resume)|export|rename/i],
  ["split", "two independent tabs", "setTerminalSplitTab createTerminalTabSplitButton", "terminal-tab-workspace-static", /split|embed/i],
  ["directories", "new tab or explicitly selected active tab", "changeActiveTabCwd openBranchWorktreePicker", "cwd-footer-reliability-static windows-drive-cwd-picker-static", /pathpicker|path.fast|cwd|directory|branchworktree|fastpick/i],
  ["transcript", "tab transcript", "renderMessages setThinkingOutputVisible setToolOutputGloballyExpanded openChatSearch", "stream-output-isolation-static transcript-markdown-tail search-match-highlighting-static", /jumpToLatest|stickyUserPrompt|chatsearch|transcript|thinking.*visib|tool.output|renderMessages|outputMode|mainOutput|chatScroll/i],
  ["presentation", "origin browser", "setMobilePresentation", "mobile-phone-experience-static", /mobile.presentation|mobilePresentation|presentation/i],
  ["composer", "tab draft and attachments", "sendPrompt renderCommandSuggestions", "prompt-routing-input-clear-static composer-skill-tag-layout", /promptinput|composer|attach|upload|sendbutton|abortbutton|command.suggest|prompt.history|last.user.prompt|desktop.draft/i],
  ["model-runtime", "active tab; explicit defaults separately", "openNativeModelSelector renderSamplingParameters", "sampling-native-controls-user-flow session-sampling-ui-static", /nativeModel|sampling|thinking|effort|codex.*(?:fast|speed)|model(?:Select|Search|Option|Picker)|operating|planmode/i],
  ["queues", "originating tab", "renderQueue renderFollowUpQueueOverlay openPromptListDialog", "queue-edit-reorder-static queue-mutation-contract", /queue|followup|steer|promptlist|busy.prompt/i],
  ["agent-work", "tab/run/agent identity", "renderSubagents renderSubagentLaunchSlots", "subagent-launch-slots-static subagent-workflow-section-static todo-filter-static", /mobileActivity|todo|subagentlaunch|subagents|agent.run/i],
  ["intercom-btw", "conversation and tab identity", "activity-intercom-controller.mjs#createActivityIntercomController sendBtwQuestion", "intercom-tag-layout-static intercom-transcript-filter", /intercom|btw/i],
  ["files", "workspace browse / dirty buffer", "renderFileTree openFileTreeEntryInWebui", "file-tree-search-layout-static file-tree-git-ignored-static workspace-files-live-updates-static", /mobileProject|filetree|fileviewer|file.menu|fileMenu|fileEditor|fileContent|fileTab|fileSearch|filePreview/i],
  ["annotations", "file selection or attachment, originating tab", "sendFileSelectionToSession openImageLightbox", "file-selection-overlay-static document-artifact-static", /file.selection|fileSelection|imageLightbox|attachmentText|lightbox/i],
  ["artifacts", "artifact revision / originating message", "ensureDocumentArtifactDialog openDocumentArtifact", "document-artifact-static", /document.artifact|documentArtifact/i],
  ["git", "originating tab/repository", "openGitChangesDialog launchGuidedGitWorkflow", "guided-git-activation-static git-live-watcher", /git|branch|commit|pull|push|prDialog|worktree/i],
  ["git-tools", "repository; destructive operations confirmed", "openGitToolsFromFooter renderGitToolsSection", "guided-git-activation-static", /gittools|gitStash|gitUndo|gitWorktree|gitSubmodule|gitTag|gitSigning|stash|reflog/i],
  ["runners", "project task/process", "renderAppRunnerWidget openAppRunnerInfoDialog", "app-runner-terminal-static app-runner-process-tree-harness", /apprunner|app.runner/i],
  ["usage", "tab/provider/account/source", "activity-usage-controller.mjs#createActivityUsageController openStatsOverlay renderFooter", "stats-dashboard-static codex-usage-source", /stats|usage|cost|token|cache|footer/i],
  ["compaction", "active tab", "requestManualCompaction toggleFooterAutoCompaction", "compaction-static", /compact|contextMeter|contextUsage/i],
  ["resources", "Session / Global / Model", "openNativeToolsSelector openNativeSkillsSelector openNativeAppendSystemSelector", "resource-selection resource-defaults-helper scoped-models", /skill|scoped.model|scopedModel|native.*(?:tools|skills|append)|resource|append.system/i],
  ["appearance", "browser / server layout revision / theme", "openThemeCustomizer showAllControls resetControlVisibilityDefaults", "theme-contract persistent-ui-layout-static control-visibility-static", /showAllControls|nativeSettings|nativeSetting|mobileShell|tabletShell|webuiSettings|theme|background|sidepanel|control.deck|controlDeck|control.visibility|controlVisibility|visibility|interface|layout|shortcut|density|panel.width/i],
  ["companions", "installed package / enabled feature", "renderOptionalFeaturePanel", "optional-feature-migration optional-feature-resource-setup-static", /optional.feature|optionalFeature/i],
  ["releases", "project and extension-owned release job", "renderReleaseNpmOutputWidget renderReleaseAurOutputWidget", "aur-review-payload", /releaseNpm|releaseAur|aurReview|publish|release-npm|release-aur/i],
  ["accounts", "provider account; local administration", "openNativeAuthSelector", "session-auth-harness", /login|logout|authSelector|account/i],
  ["voice", "tab/microphone/conversation", "setNaturalConversationModeEnabled toggleVoiceConversationPaused", "voice-conversation", /voice|naturalConversation|conversationMode|conversationVoice/i],
  ["connection", "server admission / remote identity", "toggleRemoteAuth openRemoteWebuiQrPopup", "remote-auth-settings-harness", /remote|network|pin|connection/i],
  ["system", "server/process/install transaction", "refreshUpdateStatus renderComponentUpdateDialogs", "native-update-lifecycle update-api-harness update-tab-restore-harness", /update|restart|shutdown|piRelease|webuiPackage/i],
  ["diagnostics", "events / redacted support report", "activity-events-controller.mjs#createActivityEventsController renderIssueWizard", "events-tree-context-menu-static open-issue-wizard-static runtime-error-visibility", /event|issue|error|diagnostic/i],
  ["extensions", "originating tab/request; replay and timeout", "showNextDialog sendDialogResponse", "custom-message-markdown-static", /extension|dialogQueue|dialogResponse|widget|notification/i],
  ["responses", "originating message/action/request", "renderQuestionnaireOptionButton renderActionFeedbackControls", "questionnaire-dialog feature-decision-output-popup-static", /questionnaire|feedback|learning|editRetry|featureDecision/i],
  ["workflow", "run/gate/model-exception identity", "renderWorkflowModeControls renderSubagentGate", "workflow-status-stack subagent-gate subagent-gate-visibility", /workflow|classifier|classification|featureCategory|gate/i],
  ["projections", "retained external agent/run", "openSubagentTerminal renderSubagentTerminalView openSubagentCancelDialog", "subagent-observability-static subagent-reliability-integration", /subagent|agentDone|agent.done/i],
  ["recovery", "browser / notification target / server boot", "renderMobileInstallPage", "service-worker-lifecycle mobile-continuity-tablet-static", /install|offline|boot|reconnect|continuity|recovery|service.worker/i],
  ["help", "global navigation", "openPiReleaseNotes", "open-issue-wizard-static", /sponsor|help|release.notes|releaseNotes|about/i],
];

// Accepted W1-W6 owners and relevant scenarios; paths do not imply a measured pass.
const MIGRATION = {
  "sessions": [
    "session-context.mjs#createSessionContext session-attention-scheduler.mjs#createAttentionScheduler",
    "Tab mutations and bounded metadata reconciliation; source tab survives resume.",
    "session-ownership focused-shell-integration"
  ],
  "session-actions": [
    "session-context.mjs#createSessionContext",
    "Native session command replies, captured session generation and metadata.",
    "session-ownership session-summary"
  ],
  "split": [
    "",
    "Independent iframe/tab events; split dismissal does not close its tab.",
    "focused-shell-integration mobile-foundation"
  ],
  "directories": [
    "",
    "CWD and worktree HTTP results; selected tab owns the destination.",
    "windows-drive-parent project-git-tools-integration"
  ],
  "transcript": [
    "transcript-renderer.mjs#createTranscriptRenderer stream-output-controller.mjs#createStreamOutputController platform-event-stream.mjs#createSessionEventStream",
    "One active tab EventSource; transcript and derived-output render scheduling.",
    "interaction-continuity stream-output-isolation search-match-highlighting"
  ],
  "presentation": [
    "",
    "Origin-local presentation changes; transport output mode is independent.",
    "mobile-foundation"
  ],
  "composer": [
    "session-composer-store.mjs#createSessionComposerStore session-context.mjs#createSessionContext",
    "Tab-owned drafts/attachments, prompt acknowledgments and session-generation checks.",
    "session-ownership optimistic-prompt interaction-continuity"
  ],
  "model-runtime": [
    "",
    "Live model catalog, session state and explicit sampling/effort commands.",
    "model-search-focus sampling-tooltip footer-model-advanced-layout"
  ],
  "queues": [
    "activity-queue-controller.mjs#createActivityQueueController",
    "Tab queue snapshots and guarded reorder/edit/remove acknowledgments.",
    "activity-queue-controller activity-owner-integration"
  ],
  "agent-work": [
    "activity-agents-controller.mjs#createActivityAgentsController activity-todo-view.mjs#createActivityTodoView",
    "Tab agent/todo widget snapshots; exact run and gate identity.",
    "activity-owner-integration activity-todo-view subagent-observability"
  ],
  "intercom-btw": [
    "activity-intercom-controller.mjs#createActivityIntercomController",
    "Conversation identity, selected thread events and guarded send/cancel responses.",
    "activity-intercom-controller intercom-conversation-viewer"
  ],
  "files": [
    "project-file-viewer-controller.mjs#createProjectFileViewerController",
    "File tree HTTP/watch refresh and buffer-owned async content/save results.",
    "project-file-buffer-integration file-tree-git-ignored"
  ],
  "annotations": [
    "project-file-viewer-controller.mjs#createProjectFileViewerController",
    "Canonical selection and originating file/attachment identity at send.",
    "project-file-buffer-integration project-artifact-integration"
  ],
  "artifacts": [
    "project-artifact-controller.mjs#createProjectArtifactController",
    "Artifact revision/page loading; original message identity and canonical dialog.",
    "project-artifact-controller project-artifact-integration"
  ],
  "git": [
    "",
    "Repository watcher snapshots, guarded workflow command and review payloads.",
    "guided-git-extension-command guided-git-fallback"
  ],
  "git-tools": [
    "project-git-tools-controller.mjs#createProjectGitToolsController",
    "Repository-section HTTP reads/mutations bound to captured tab/cwd.",
    "project-git-tools-integration"
  ],
  "runners": [
    "project-runners-controller.mjs#createProjectRunnersController",
    "Tab-owned process/SSE output; stdin acknowledgment bound to run identity.",
    "focused-project-activity"
  ],
  "usage": [
    "activity-usage-controller.mjs#createActivityUsageController",
    "Provider snapshots and owned refresh/render timers; source-labelled usage.",
    "activity-usage-controller stats-overlay"
  ],
  "compaction": [
    "",
    "Active-tab compact events and queued prompt state; busy gating.",
    "focused-shell-integration"
  ],
  "resources": [
    "settings-resource-controller.mjs#createSettingsResourceController",
    "Explicit Session/Global/Model scope and exact model identity on reads/writes.",
    "settings-resource-lifetime resource-profiles"
  ],
  "appearance": [
    "settings-workspace.mjs#createSettingsWorkspace shell-preferences.mjs#readShellPreferences",
    "Browser appearance changes and revision-fenced durable layout snapshots.",
    "settings-navigation-integration persistent-ui-layout control-visibility"
  ],
  "companions": [
    "settings-workspace.mjs#createSettingsWorkspace",
    "Canonical package catalog plus tab capabilities and enabled/setup state.",
    "settings-workspace-integration settings-navigation-integration"
  ],
  "releases": [
    "",
    "Semantic extension release widgets and job actions; external publication remains mocked.",
    "feature-decision-output-popup"
  ],
  "accounts": [
    "",
    "Native auth selector and provider account responses; local administration guards.",
    "settings-navigation-integration"
  ],
  "voice": [
    "",
    "Microphone/conversation events and companion commands; voice selection persists shared config.",
    "settings-workspace-integration focused-shell-integration"
  ],
  "connection": [
    "",
    "Health/network/auth metadata; server admission remains authoritative.",
    "mobile-foundation"
  ],
  "system": [
    "",
    "Server-owned update plans/status, restart and reconnect reconciliation.",
    "update-reconnect control-deck-component-updates"
  ],
  "diagnostics": [
    "activity-events-controller.mjs#createActivityEventsController",
    "Bounded retained event DOM, filters/unread changes and redacted issue wizard.",
    "events-tree-context-menu activity-owner-integration"
  ],
  "extensions": [
    "session-extension-requests.mjs#createExtensionRequestStore",
    "Semantic SSE request/widget replay and exact originating tab/request response.",
    "session-ownership"
  ],
  "responses": [
    "",
    "Message/action and questionnaire request identity; Other/free-text submission.",
    "feature-decision-output-popup"
  ],
  "workflow": [
    "",
    "Tab workflow status, gate and model-exception widgets with exact run identity.",
    "subagent-observability activity-owner-integration"
  ],
  "projections": [
    "activity-agents-controller.mjs#createActivityAgentsController",
    "Retained run projection updates; cancellation is a separate explicit operation.",
    "subagent-observability intercom-conversation-viewer"
  ],
  "recovery": [
    "",
    "Service-worker lifecycle, boot/retry and target-aware notification navigation.",
    "mobile-foundation update-reconnect"
  ],
  "help": [
    "",
    "Global help/release-note actions; no session mutation.",
    "shell-tools-launcher"
  ]
};

const PLAN_ANCHORS = {
  "sessions": "New, close, resume and switch sessions",
  "session-actions": "New session within a tab",
  "split": "Split conversations",
  "directories": "CWD picker",
  "transcript": "Transcript",
  "presentation": "Mobile Essential/Detailed presentation",
  "composer": "Prompt editor",
  "model-runtime": "Model",
  "queues": "Steering",
  "agent-work": "Todo/workflow progress",
  "intercom-btw": "Intercom conversations and `/btw`",
  "files": "Files",
  "annotations": "File selection annotations sent to Pi",
  "artifacts": "Document artifact cards and page viewer",
  "git": "Git status",
  "git-tools": "Stash",
  "runners": "App runners",
  "usage": "Context",
  "compaction": "Compact now and automatic compaction on/off",
  "resources": "Tools",
  "appearance": "Theme selection/editor/backgrounds",
  "companions": "Optional packages",
  "releases": "npm/AUR release execution and progress",
  "accounts": "Provider sign-in/out and authentication state",
  "voice": "Voice and natural conversation",
  "connection": "Network access",
  "system": "Pi/WebUI updates",
  "diagnostics": "Events",
  "extensions": "Extension notifications",
  "responses": "Native questionnaires",
  "workflow": "Workflow Mode",
  "projections": "Read-only subagent terminal projections",
  "recovery": "PWA install education",
  "help": "Release notes"
};

// Specific families win before broad words such as Git, footer or composer.
const MATCH_ORDER = ["artifacts", "annotations", "split", "compaction", "presentation", "releases", "workflow", "projections", "agent-work", "intercom-btw", "voice", "responses", "queues", "runners", "companions", "resources", "accounts", "connection", "system", "help", "diagnostics", "directories", "git-tools", "git", "files", "model-runtime", "appearance", "session-actions", "sessions", "transcript", "composer", "usage", "extensions", "recovery"];
const DYNAMIC = [
  ["palette-tabs", "sessions", "commandPaletteTabItems", "tabs", "Runtime tab identities; no static session instances."],
  ["palette-models", "model-runtime", "commandPaletteModelItems", "availableModels", "Provider/model availability is tab catalog data."],
  ["slash-catalog", "resources", "refreshCommands visibleCommands commandPaletteSlashItems", "availableCommands / rawAvailableCommands", "Native, extension and skill commands depend on the selected tab; palette truncates to 140."],
  ["skills-catalog", "resources", "openNativeSkillsSelector renderSessionSkillTags", "resource response / skillUsageByTab", "Discovered skills and enabled scopes are dynamic."],
  ["native-selectors", "extensions", "openNativeCommandDialog renderNativeSelectorItems", "nativeCommandDialogGeneration / nativeCommandDialog", "One static dialog hosts many live selectors, resource profiles and settings forms."],
  ["extension-requests", "extensions", "showNextDialog createDialogResponder", "dialogQueue / activeDialog", "Extension blocking requests reuse extensionDialog; do not invent static request IDs."],
  ["questionnaire-responses", "responses", "renderQuestionnaireOptionButton renderQuestionnaireActionButton", "questionnaire widget rows", "Questionnaire controls depend on response data; preserve Other and explicit submission."],
  ["image-dialog", "annotations", "openImageLightbox", "imageLightbox", "DOM-created dialog has no source ID."],
  ["artifact-dialog", "artifacts", "ensureDocumentArtifactDialog openDocumentArtifact", "documentArtifactDialog", "DOM-created dialog plus live page/revision controls has no source ID."],
  ["feature-controls", "companions", "renderOptionalFeaturePanel", "OPTIONAL_FEATURES / server availability", "UI metadata is separate from canonical package identities."],
  ["agent-projections", "projections", "renderSubagentTerminalView renderSubagentGate", "tab/run/agent and pending gate projections", "Retained view identity differs from cancellation target."],
  ["file-and-git-rows", "files", "renderFileTree renderGitPanel renderGitToolsSection", "workspace entries and repository snapshots", "Rows/actions are data-dependent; no fictional per-file static controls."],
  ["computed-footer-controls", "usage", "footerMetric footerMeta footerTuiItem", "options.onClick / footer payload", "Computed button/span tags depend on the current payload and action callback."],
  ["shared-dom-primitives", "extensions", "make mobileButton addDialogButton", "caller-provided tag/label/action", "Shared constructors have no independent capability or runtime instance."],
  ["message-actions", "responses", "createMessageBubble renderActionFeedbackControls", "message/action identity", "Action buttons depend on message content and callbacks; preserve originating message."],
];

// Paths describe reviewed persistence contracts, not discovered user values.
// Wildcards retain dynamic project/model/session identity instead of inventing it.
const SERVER_PERSISTENCE = [
  ["webui-settings", "appearance", "server/settings-store", "normalizeWebuiSettings webuiSettingsFile mergeWebuiSettings initializeWebuiShellRollout", "~/.pi/webui/settings.json; PI_WEBUI_SETTINGS_FILE override; legacy XDG pi-webui/settings.json migration", "version remoteAuthEnabled appendSystemPromptPath appendSystemPromptRootPath outputModeDefault gitWorkflow resourceDefaults interfacePreferences uiLayout subagentLaunchSlots shellRollout.version shellRollout.cohort"],
  ["interface-preferences", "appearance", "server/settings-store", "normalizeInterfacePreferences", "WebUI settings.interfacePreferences", "sidePanelWidth"],
  ["ui-layout", "appearance", "ui-layout-settings", "defaultUiLayout normalizeUiLayout", "WebUI settings.uiLayout v3; browser fallback/pending keys remain independent", "version sidePanel.placement sidePanel.sectionLayout.order sidePanel.sectionLayout.leftSectionIds sidePanel.collapsedSectionIds sidePanel.hiddenSectionIds sidePanel.collapsedPanels.left sidePanel.collapsedPanels.right sidePanel.panelWidths.left sidePanel.panelWidths.right composerActions.order composerActions.grid controlVisibility.hiddenIds footerScopedModelOrder terminalTabs.layout terminalTabs.customGroups terminalTabs.sidebarWidth fileViewerWidth"],
  ["git-workflow", "git", "git-workflow-preference-values", "defaultGitWorkflowPreferences normalizeGitWorkflowPreferences", "WebUI settings.gitWorkflow", "setupVersion generation.provider generation.modelId generation.thinkingLevel generation.unavailablePolicy generation.fallback.provider generation.fallback.modelId generation.fallback.thinkingLevel commit.language commit.defaultVariant commit.scope stagingPolicy reviewProcessEnabled deliveryMode verificationPolicy"],
  ["resource-defaults", "resources", "resource-selection", "normalizeResourceDefaults normalizeModelProfiles", "WebUI settings.resourceDefaults; session branch directives in Pi session data", "tools.enabledTools skills.enabledSkills modelProfiles[].provider modelProfiles[].modelId modelProfiles[].tools.enabledTools modelProfiles[].skills.enabledSkills"],
  ["summary-preferences", "session-actions", "session-summary-preferences", "defaultSessionSummaryPreferences sessionSummaryConfigFile", "~/.pi/agent/session-summary.json; PI_SESSION_SUMMARY_CONFIG_FILE override", "version configured enabled model.provider model.modelId model.thinkingLevel prompts.title prompts.summary input.scope context.injectLatest title.enabled title.minSettledTurns"],
  ["saved-workspaces", "sessions", "webui-workspaces", "normalizeWebuiWorkspaces normalizeWebuiWorkspace normalizeWorkspaceTabDescriptor webuiWorkspacesFile", "XDG config pi-webui/workspaces.json; PI_WEBUI_WORKSPACES_FILE override", "version workspaces[].id workspaces[].name workspaces[].savedAt workspaces[].activeTabId workspaces[].tabs workspaces[].groups"],
  ["launch-slots", "agent-work", "subagent-launch-slots", "normalizeSubagentLaunchSlots normalizeSubagentLaunchSlotRoles", "WebUI settings.subagentLaunchSlots; dynamic project keys and role slots", "version user.roles projects.*.roles"],
];

const NATIVE_FAMILY = {
  "/changelog": "help", "/clone": "session-actions", "/copy": "transcript", "/fork": "session-actions",
  "/git-workflow-setup": "git", "/hotkeys": "appearance", "/import": "session-actions", "/model": "model-runtime",
  "/name": "session-actions", "/new": "session-actions", "/quit": "sessions", "/resume": "sessions",
  "/safety-guard-setup": "companions", "/session": "session-actions", "/settings": "appearance", "/share": "session-actions",
  "/tools": "resources", "/tree": "session-actions", "adapter.native-command-response": "extensions",
  "bash.exclude-context": "composer", "bash.include-context": "composer", "editor.external-expanded-modal": "composer",
  "editor.path-suggestions": "composer", "editor.slash-autocomplete": "composer", "security.trust-boundaries": "connection",
  "session.resume.delete": "sessions", "session.resume.switch": "sessions", "extension-ui.header-footer": "extensions",
  "shortcut.abort.escape": "composer", "shortcut.editor.clear": "composer", "shortcut.model.selector": "model-runtime",
  "shortcut.thinking.toggle": "transcript", "shortcut.tools.expand-toggle": "transcript", "tests.native-parity-harness": "extensions",
};

function functionsIn(text) {
  return [...text.matchAll(/^(?:export )?(?:async )?function\s+(\w+)\s*\(/gm)]
    .map((m) => ({ name: m[1], offset: m.index }));
}
function ownerAt(functions, offset) {
  // A lexical locator, not an AST-derived call graph or state ownership claim.
  return functions.findLast((fn) => fn.offset <= offset)?.name || "module";
}
function anchor(file, text, offset, symbol) {
  return { file, symbol, line: text.slice(0, offset).split("\n").length };
}
function familyFor(text) {
  const normalized = text.replaceAll("_", "").replaceAll("-", "");
  return MATCH_ORDER.find((id) => CONTRACTS.find((row) => row[0] === id)[4].test(text) || CONTRACTS.find((row) => row[0] === id)[4].test(normalized)) || null;
}
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map((m) => [m[1].toLowerCase(), m[2] ?? m[3]]));
}

export function scanMarkup(file, source) {
  const text = source.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const functions = functionsIn(text);
  const records = [];
  const occurrences = new Map();
  const stack = [];
  const isHtml = file.endsWith(".html");
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const tags = /<\/?([a-z][\w-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  for (const match of text.matchAll(tags)) {
    const tag = match[1].toLowerCase();
    if (match[0].startsWith("</")) {
      if (isHtml) {
        const index = stack.findLastIndex((item) => item.tag === tag);
        if (index >= 0) stack.length = index;
      }
      continue;
    }
    const attrs = attributes(match[0]);
    const data = Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith("data-") && key !== "data-tooltip"));
    const actionable = ["button", "input", "select", "textarea", "summary", "a"].includes(tag) || ["button", "menuitem", "tab", "checkbox", "switch"].includes(attrs.role);
    const ancestors = stack.map((item) => item.id).filter(Boolean);
    const symbol = isHtml ? (attrs.id ? `#${attrs.id}` : ancestors.at(-1) ? `#${ancestors.at(-1)}` : "document") : ownerAt(functions, match.index);
    if (attrs.id || actionable || tag === "dialog" || Object.keys(data).length) {
      const dynamic = !isHtml && /\$\{|\\["']/.test(match[0]);
      const identity = attrs.id ? `id:${attrs.id}` : Object.keys(data).length ? `data:${JSON.stringify(data)}` : `tag:${digest(match[0].replace(/\s+/g, " ")).slice(0, 16)}`;
      const baseId = `${file}#${isHtml ? "" : `${symbol}/`}${identity}`;
      const occurrence = (occurrences.get(baseId) || 0) + 1;
      occurrences.set(baseId, occurrence);
      const family = [attrs.id, JSON.stringify(data), symbol, ...ancestors.slice().reverse()].filter(Boolean).map(familyFor).find(Boolean) || null;
      const shared = /^(?:confirmation|textPrompt|nativeCommand|extensionDialog|dialog(?:Title|Message|Input|Buttons)|mobile(?:More|Surface|Search)|undoToast)/.test(attrs.id || "") || /commandPalette/.test(attrs.id || "") || Boolean(data["data-mobile-route-button"]);
      records.push({
        id: occurrence === 1 ? baseId : `${baseId}/occurrence:${occurrence}`,
        sourceId: attrs.id || null,
        tag,
        actionable,
        data,
        anchor: anchor(file, text, match.index, symbol),
        ancestors,
        classification: dynamic ? "dynamic-template" : shared ? "shared-chrome" : family ? "family" : !actionable && tag !== "dialog" ? "non-action" : "unresolved",
        family,
      });
    }
    if (isHtml && !voidTags.has(tag) && !match[0].endsWith("/>")) stack.push({ tag, id: attrs.id });
  }
  return sorted(records);
}

export function scanDomConstruction(file, text) {
  const functions = functionsIn(text);
  const records = [];
  const occurrences = new Map();
  const patterns = [
    { regex: /\b(make|document\.createElement)\(\s*["'](button|input|select|textarea|summary|a|dialog)["']([^\n]*)/g, kind: "construction" },
    { regex: /\b(make|document\.createElement)\(\s*([^"'\s][^,\n]*)/g, kind: "computed-construction" },
    { regex: /\b([\w.]+)\.id\s*=(?!=)\s*([^;\n]+)(?:;|$)/gm, kind: "id-assignment" },
    { regex: /\b([\w.]+)\.dataset\.(\w+)\s*=(?!=)\s*([^;\n]+)(?:;|$)/gm, kind: "data-assignment" },
    { regex: /\b([\w.]+)\.dataset\[([^\]\n]+)\]\s*=(?!=)\s*([^;\n]+)(?:;|$)/gm, kind: "computed-data-assignment" },
    { regex: /\b([\w.]+)\.setAttribute\(\s*["'](data-[\w-]+)["']\s*,\s*([^\n]+)/g, kind: "data-attribute" },
  ];
  for (const { regex, kind } of patterns) for (const match of text.matchAll(regex)) {
    const symbol = ownerAt(functions, match.index);
    if (kind === "id-assignment") {
      const start = functions.findLast((fn) => fn.offset <= match.index)?.offset || 0;
      if (!/\b(?:make|createElement)\(/.test(text.slice(start, match.index))) continue;
    }
    const expression = match[0].trim();
    const token = kind === "construction" ? `${match[1]}:${match[2]}:${digest(match[3]).slice(0, 16)}` : `${match[1]}:${match[2]}`;
    const baseId = `${file}#${symbol}/${kind}:${token}`;
    const occurrence = (occurrences.get(baseId) || 0) + 1;
    occurrences.set(baseId, occurrence);
    const sourceId = kind === "id-assignment" ? match[2].match(/^["']([^"']+)["']$/)?.[1] || null : null;
    records.push({ id: occurrence === 1 ? baseId : `${baseId}/occurrence:${occurrence}`, sourceId, tag: kind === "construction" ? match[2] : null, actionable: kind === "construction" && match[2] !== "dialog", data: {}, expression, anchor: anchor(file, text, match.index, symbol), ancestors: [], classification: "dynamic-template", family: familyFor(`${symbol} ${expression}`) });
  }
  return sorted(records);
}

export function scanPersistence(file, text) {
  const records = [];
  const functions = functionsIn(text);
  for (const m of text.matchAll(/\b(?:const|let)\s+(\w*(?:STORAGE_(?:KEY|PREFIX)|PAYLOAD_CACHE_KEY|IDB_(?:NAME|STORE)|_FILE_ENV)\w*)\s*=\s*(["'])([^"'\n]+)\2/g)) {
    records.push({ id: `${file}#${m[1]}`, key: m[3], kind: m[1].includes("IDB") ? "indexeddb-declaration" : m[1].endsWith("_FILE_ENV") ? "file-override-environment" : "browser-key-declaration", family: familyFor(`${m[1]} ${m[3]}`), anchor: anchor(file, text, m.index, m[1]) });
  }
  for (const m of text.matchAll(/\b(localStorage|sessionStorage)\.(getItem|setItem|removeItem)\(\s*([^,\n)]+)/g)) {
    const expression = m[3].trim();
    const symbol = ownerAt(functions, m.index);
    records.push({ id: `${file}#${symbol}/${m[1]}.${m[2]}:${expression}`, keyExpression: expression, kind: "browser-access", operation: `${m[1]}.${m[2]}`, family: familyFor(`${symbol} ${expression}`), anchor: anchor(file, text, m.index, symbol) });
  }
  // Duplicate references within a function are one semantic anchor, not new keys.
  return sorted([...new Map(records.map((item) => [item.id, item])).values()]);
}

async function readBounded(root) {
  const files = [];
  let entries = 0;
  async function walk(relative) {
    if (++entries > 2048 || relative.split("/").length > 10) throw new Error("Source traversal bound exceeded");
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Source symlink is not allowed: ${relative}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await walk(`${relative}/${name}`);
    } else if (/\.(?:mjs|js|html|ts)$/.test(relative) || relative.endsWith("WEBUI_TUI_NATIVE_PARITY.json") || relative === DESTINATIONS) {
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`Source exceeds file bound or is not regular: ${relative}`);
      files.push(relative);
      if (files.length > MAX_FILES) throw new Error(`Source exceeds ${MAX_FILES} files`);
    }
  }
  for (const relative of [`${PACKAGE}/public`, `${PACKAGE}/lib`, `${PACKAGE}/bin`, `${PACKAGE}/index.ts`, `${PACKAGE}/session-summary.ts`, `${PACKAGE}/webui-rpc-helper.mjs`, DESTINATIONS]) await walk(relative);
  const sources = new Map();
  let totalBytes = 0;
  for (const file of files.sort()) {
    const text = await readFile(path.join(root, file), "utf8");
    totalBytes += Buffer.byteLength(text);
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Source exceeds ${MAX_TOTAL_BYTES} bytes`);
    sources.set(file, text);
  }
  return sources;
}

function requireSymbol(sources, file, symbol) {
  const text = sources.get(file);
  const fn = functionsIn(text).find((item) => item.name === symbol);
  if (!fn) throw new Error(`Missing source function ${file}#${symbol}; update the evidence contract`);
  return anchor(file, text, fn.offset, symbol);
}

function requireBrowserSymbol(sources, reference) {
  const [module, symbol] = reference.includes("#") ? reference.split("#") : ["app.js", reference];
  if (!/^[a-z][a-z0-9-]*\.(?:mjs|js)$/.test(module) || !sources.has(`${PACKAGE}/public/${module}`)) {
    throw new Error(`Missing or invalid browser owner ${reference}`);
  }
  return requireSymbol(sources, `${PACKAGE}/public/${module}`, symbol);
}

export async function buildInventory(root = DEFAULT_ROOT) {
  const sources = await readBounded(path.resolve(root));
  const appFile = `${PACKAGE}/public/app.js`;
  const app = sources.get(appFile);
  const html = sources.get(`${PACKAGE}/public/index.html`);
  if (!app || !html || !/<html\b/i.test(html) || !/<\/html>/.test(html)) throw new Error("Missing or malformed app.js / index.html source");
  const plan = sources.get(DESTINATIONS);
  const table = plan.split("### Feature destination map\n")[1]?.split("\n## ")[0];
  const rows = [...(table || "").matchAll(/^\| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)].filter((row) => row[1] !== "Capability" && !/^[- ]+$/.test(row[1]));
  if (rows.length !== CONTRACTS.length) throw new Error(`Canonical feature map has ${rows.length} rows; expected ${CONTRACTS.length}. Reconcile before regenerating.`);
  const controls = sorted([...sources].filter(([file]) => file.startsWith(`${PACKAGE}/public/`) && /\.(?:html|js|mjs)$/.test(file)).flatMap(([file, text]) => [...scanMarkup(file, text), ...(file.endsWith(".html") ? [] : scanDomConstruction(file, text))]));
  const persistence = sorted([...sources].flatMap(([file, text]) => scanPersistence(file, text)));
  const declaredKeys = new Map(persistence.filter((item) => item.key).map((item) => [item.anchor.symbol, item.key]));
  for (const item of persistence.filter((item) => item.kind === "browser-access")) {
    item.resolvedKey = item.keyExpression.match(/^["']([^"']+)["']$/)?.[1] || declaredKeys.get(item.keyExpression) || null;
  }
  const families = [];
  for (const [index, [id, scope, symbols, testNames]] of CONTRACTS.entries()) {
    if (!rows[index][1].startsWith(PLAN_ANCHORS[id])) throw new Error(`Canonical feature anchor changed for ${id}; reconcile row ownership before regenerating`);
    const owners = symbols.split(" ").map((symbol) => requireBrowserSymbol(sources, symbol));
    const tests = testNames.split(" ").map((name) => `${PACKAGE}/tests/${name}.test.mjs`);
    for (const test of tests) await lstat(path.join(root, test));
    const migration = MIGRATION[id];
    if (!migration) throw new Error(`Missing migration contract for ${id}`);
    const extractedOwners = migration[0].split(" ").filter(Boolean).map((reference) => requireBrowserSymbol(sources, reference));
    const targetOwners = [...extractedOwners, ...owners].filter((owner, index, all) =>
      all.findIndex((item) => item.file === owner.file && item.symbol === owner.symbol) === index);
    const acceptanceScenarios = migration[2].split(" ").map((name) => `${PACKAGE}/tests/browser/${name}.spec.mjs`);
    for (const scenario of acceptanceScenarios) await lstat(path.join(root, scenario));
    families.push({ id, capability: rows[index][1], destination: rows[index][2], preservation: rows[index][3], scope, currentOwners: owners, targetOwners, targetOwner: targetOwners.map((owner) => `${owner.file}#${owner.symbol}`).join("; "), eventSources: migration[1], acceptanceScenarios, acceptanceStatus: "Scenario coverage is partial; final W7 feature-access evidence remains pending", availability: "Source present; runtime, companion, trust, busy and preference checks still apply", legacyActive: true, controls: controls.filter((item) => item.family === id).map((item) => item.id), persistedKeys: persistence.filter((item) => item.family === id).map((item) => item.id), startingTests: tests });
  }
  const catalogFile = `${PACKAGE}/lib/optional-feature-catalog.mjs`;
  const catalog = sources.get(catalogFile);
  let entries;
  try { entries = JSON.parse(catalog.match(/const entries = (\[[\s\S]*?\n\]);/)[1].replace(/,\s*]/g, "]")); }
  catch { throw new Error("Malformed/unrecognized canonical optional feature entries"); }
  if (!Array.isArray(entries) || entries.some((row) => !Array.isArray(row) || row.length !== 3 || row.some((value) => typeof value !== "string" || !value)) || new Set(entries.map((row) => row[0])).size !== entries.length) throw new Error("Malformed/duplicate canonical optional feature identity");
  const companions = entries.map(([id, packageName, expectedSpec]) => ({ id, packageName, expectedSpec, anchor: anchor(catalogFile, catalog, catalog.indexOf('["' + id + '"'), 'entries[' + id + ']'), availability: "Catalog identity only; installation, enablement and runtime support unobserved" }));
  if (!companions.length || !catalog.includes("OPTIONAL_FEATURE_CATALOG")) throw new Error("Malformed/unrecognized canonical optional feature catalog");
  const uiFeatureStart = app.indexOf("const OPTIONAL_FEATURES = [");
  const uiFeatureEnd = app.indexOf("\n];", uiFeatureStart);
  if (uiFeatureStart < 0 || uiFeatureEnd < 0) throw new Error("Missing UI companion metadata boundaries");
  const uiCompanionDefinitions = [...app.slice(uiFeatureStart, uiFeatureEnd).matchAll(/\{\s*id: "([^"]+)",([\s\S]*?)\n  }/g)].map((m) => ({ id: m[1], packageName: m[2].match(/packageName: "([^"]+)"/)?.[1] || null, capabilityLabel: m[2].match(/capabilityLabel: "([^"]+)"/)?.[1] || null, anchor: anchor(appFile, app, uiFeatureStart + m.index, `OPTIONAL_FEATURES[id=${m[1]}]`) }));
  const companionIdentityDifferences = [...new Set([...companions, ...uiCompanionDefinitions].map((item) => item.id))].sort().filter((id) => companions.find((item) => item.id === id)?.packageName !== uiCompanionDefinitions.find((item) => item.id === id)?.packageName);
  let parity;
  const parityFile = `${PACKAGE}/lib/WEBUI_TUI_NATIVE_PARITY.json`;
  try { parity = JSON.parse(sources.get(parityFile)); } catch (error) { throw new Error(`Malformed native parity catalog: ${error.message}`); }
  if (!Array.isArray(parity.surfaces) || parity.surfaces.some((surface) => !surface.id || !surface.kind || !["implemented", "degraded", "unsupported"].includes(surface.webStatus) || !Array.isArray(surface.guards)) || new Set(parity.surfaces.map((surface) => surface.id)).size !== parity.surfaces.length) throw new Error("Malformed native parity surfaces");
  const nativeDefinitions = sorted(parity.surfaces.map((surface) => ({ id: surface.id, kind: surface.kind, command: surface.command || null, declaredWebStatus: surface.webStatus, guards: surface.guards, family: NATIVE_FAMILY[surface.id] || familyFor(`${surface.id} ${surface.title}`), anchor: { file: parityFile, symbol: `surfaces[id=${surface.id}]` }, availability: "Declared catalog status; not a runtime probe" })));
  const paletteStart = app.indexOf("function commandPaletteCoreItems()");
  const paletteEnd = app.indexOf("function commandPaletteTabItems()", paletteStart);
  if (paletteStart < 0 || paletteEnd < 0) throw new Error("Missing palette source boundaries");
  const paletteDefinitions = [...app.slice(paletteStart, paletteEnd).matchAll(/\{ [^\n]*?kind: "([^"]+)", label: ([^\n]+?), description:/g)].map((m) => {
    const offset = paletteStart + m.index;
    const row = app.slice(offset, app.indexOf("\n", offset));
    const handler = row.match(/run: (.+)/)?.[1] || "unresolved";
    return { id: `palette:commandPaletteCoreItems/${digest(handler).slice(0, 16)}`, kind: m[1], labelExpression: m[2], handlerExpression: handler, family: NATIVE_FAMILY[m[2].slice(1, -1)] || familyFor(`${m[2]} ${handler}`), anchor: anchor(appFile, app, offset, "commandPaletteCoreItems"), availability: "Definition only; surrounding conditions and invocation guards apply" };
  });
  if (!paletteDefinitions.length) throw new Error("No palette definitions found; reconcile the source scanner");
  const commandDefinitions = [...app.matchAll(/^const ([A-Z_]*COMMAND[A-Z_]*)\s*=\s*([\s\S]*?);/gm)].map((m) => ({ id: m[1], expression: m[2], strings: [...m[2].matchAll(/["']([^"'\n]+)["']/g)].map((item) => item[1]), additions: [...app.matchAll(new RegExp(m[1] + String.raw`\.add\((["'])([^"'\n]+)\1\)`, "g"))].map((item) => item[2]), anchor: anchor(appFile, app, m.index, m[1]), availability: "Static command routing/filter metadata; live tab catalog remains authoritative" }));
  const commandRegistrations = sorted([...sources].flatMap(([file, text]) => [...text.matchAll(/\bpi\.registerCommand\(\s*([^,\n]+)/g)].map((m) => ({ id: `${file}#registerCommand:${m[1]}`, nameExpression: m[1], anchor: anchor(file, text, m.index, `registerCommand(${m[1]})`) }))));
  const dynamicFamilies = DYNAMIC.map(([id, family, symbols, stateSource, limit]) => ({ id, family, owners: symbols.split(" ").map((symbol) => requireBrowserSymbol(sources, symbol)), stateSource, limit, availability: "Dynamic; no instances enumerated" }));
  const serverPersistence = SERVER_PERSISTENCE.map(([id, family, module, symbols, location, keyPaths]) => ({ id, family, location, keyPaths: keyPaths.split(" "), owners: symbols.split(" ").map((symbol) => requireSymbol(sources, `${PACKAGE}/lib/${module}.mjs`, symbol)), method: "Reviewed schema paths; unknown future fields may also survive normalization. No settings file read." }));
  for (const family of families) family.serverPersistence = serverPersistence.filter((item) => item.family === family.id).map((item) => item.id);
  const categories = ["family", "shared-chrome", "non-action", "dynamic-template", "unresolved"];
  return {
    schemaVersion: 1,
    purpose: "Static capability inventory and accepted ownership mapping; not an executable action registry or proof of runtime parity",
    reference: { productionBaseline: "06351edae0d87829dfa8c747d31a061825568b0e", integrationSeed: "cff3432ee63131ebb6150a906d9c06594ca2c401", provenance: "Reference revisions supplied by integration owner; scanned content is identified by source hashes below" },
    method: { bounds: { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES }, sourceScope: "Recursive regular source files in public/lib/bin, three package entry sources, native parity JSON and feature destination contract; no dependencies, tests, app execution or settings reads", limits: ["Quoted HTML attributes and literal markup candidates only; JS-created controls are represented by source functions/dynamic families, not complete DOM instances.", "JavaScript scanning is lexical, not an AST or call graph. Nearest preceding named function is a locator only; anonymous callbacks inherit that locator.", "Source IDs and symbol/data anchors identify records; line numbers are navigation hints. Anonymous tag hashes can change when markup changes; duplicate instances use occurrence suffixes.", "Browser key declarations and access expressions are enumerated. Dynamic keys remain expressions. Server settings contracts are linked in capability-ledger.md; schema references do not prove writes or runtime availability.", "Family matching is a deterministic lexical annotation. Unresolved entries require human reconciliation; zero unresolved would not establish runtime parity."] },
    sources: [...sources].map(([file, text]) => ({ file, bytes: Buffer.byteLength(text), sha256: digest(text) })),
    reconciliation: { records: controls.length, classifications: Object.fromEntries(categories.map((category) => [category, controls.filter((item) => item.classification === category).length])), staticDialogs: controls.filter((item) => item.tag === "dialog" && item.anchor.file.endsWith("index.html")).length, actionableRecords: controls.filter((item) => item.actionable).length, unassignedPersistence: persistence.filter((item) => !item.family).map((item) => item.id), unresolvedControls: controls.filter((item) => item.classification === "unresolved").map((item) => item.id), unassignedNativeDefinitions: nativeDefinitions.filter((item) => !item.family).map((item) => item.id), unassignedPaletteDefinitions: paletteDefinitions.filter((item) => !item.family).map((item) => item.id), companionIdentityDifferences },
    families, controls, persistence, serverPersistence: sorted(serverPersistence), companions: sorted(companions), uiCompanionDefinitions: sorted(uiCompanionDefinitions), nativeDefinitions, paletteDefinitions: sorted(paletteDefinitions), commandDefinitions: sorted(commandDefinitions), commandRegistrations, dynamicFamilies: sorted(dynamicFamilies),
  };
}

export function serializeInventory(inventory) { return `${JSON.stringify(inventory, null, 2)}\n`; }

async function main(args) {
  let root = DEFAULT_ROOT;
  let output;
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") check = true;
    else if (arg === "--root" || arg === "--output") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--root") root = path.resolve(value);
      else output = path.resolve(value);
    } else if (arg === "--help") {
      console.log("node pi-package-webui/scripts/overhaul-inventory.mjs [--root REPOSITORY] [--output JSON_FILE] [--check]");
      return;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  output ||= path.join(root, DEFAULT_OUTPUT);
  // Prevent an accidental --output from overwriting application source or plan.
  if (!output.endsWith(".json") || path.relative(path.join(root, PACKAGE, "docs/overhaul"), output).startsWith("..") && output.startsWith(`${root}${path.sep}`)) throw new Error("Output must be an overhaul docs JSON file or an external JSON file");
  const text = serializeInventory(await buildInventory(root));
  if (check) {
    if (await readFile(output, "utf8") !== text) throw new Error(`Stale inventory: regenerate ${output}`);
    console.log(`Inventory current: ${output}`);
  } else {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, text);
    console.log(`Inventory written: ${output}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`overhaul-inventory: ${error.message}`); process.exitCode = 1; });
}
