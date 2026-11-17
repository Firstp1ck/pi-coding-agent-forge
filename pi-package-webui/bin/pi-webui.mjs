#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { access, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, networkInterfaces, platform, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, brotliCompressSync, constants as zlibConstants, gzip, gzipSync } from "node:zlib";
import { SessionManager, SettingsManager, DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import {
  ThemeContractError,
  WEBUI_THEME_EXPORT_FIELDS,
  canonicalizeTheme,
  normalizeThemeFileName,
  serializeTheme,
  themeNameFromFileName,
  validateTheme,
} from "../public/theme-contract.mjs";
import { authProvidersPayload, createAuthContext, logoutStoredProvider } from "../lib/auth-actions.mjs";
import {
  APPEND_SYSTEM_DIAGNOSTIC_MESSAGES,
  APPEND_SYSTEM_DISCOVERY_LIMITS,
  discoverAppendSystemFiles,
  validateAppendSystemSelection,
  validateSavedAppendSystemSelection,
} from "../lib/append-system-selection.mjs";
import { CODEX_USAGE_DIRECT_TOKEN_MESSAGE, codexUsageLoginGuidance, resolveCodexUsageAuth } from "../lib/codex-usage-auth.mjs";
import { readCodexCliUsage } from "../lib/codex-cli-usage.mjs";
import { createCodexUsageReader } from "../lib/codex-usage-source.mjs";
import { AgentRunIndex, canonicalAgentRunId, normalizeAgentInstance } from "../lib/agent-run-protocol.mjs";
import { AgentRunRegistry } from "../lib/agent-run-registry.mjs";
import { resolveScopedModelsFromPatterns } from "../lib/scoped-models.mjs";
import { projectIntercomConversations } from "../lib/intercom-conversations.mjs";
import { filterIntercomTranscriptMessages } from "../lib/intercom-transcript-filter.mjs";
import { sessionTreeEventTargets } from "../lib/session-tree-event-targets.mjs";
import {
  readSessionSummaryPreferences,
  supportedSessionSummaryThinkingLevels,
  writeSessionSummaryPreferences,
} from "../lib/session-summary-preferences.mjs";
import {
  deleteWebuiWorkspace,
  getWebuiWorkspace,
  listWebuiWorkspaces,
  saveWebuiWorkspace,
} from "../lib/webui-workspaces.mjs";
import { allocateNoProjectWorkspace, resolveNoProjectWorkspace, validateNoProjectCreateIntent, noProjectPiArgs } from "../lib/server/no-project-workspaces.mjs";
import { nativeExportDownloadPayload } from "../lib/native-export-payload.mjs";
import { discoverStartAttachRpcSupervisor } from "../lib/rpc-supervisor-client.mjs";
import { deriveSupervisorRecoveryToken } from "../lib/rpc-supervisor-protocol.mjs";
import { readSupervisorState, supervisorPaths } from "../lib/rpc-supervisor-state.mjs";
import {
  collectOpenSessionFiles,
  deleteSessionFile,
  isSessionPathAllowed,
  renameSessionMetadata,
  validateSessionDelete,
} from "../lib/session-actions.mjs";
import { sweepStaleTempEntries } from "../lib/temp-artifacts.mjs";
import { ThinkingStreamRecovery } from "../lib/thinking-stream-recovery.mjs";
import {
  classifyGitPathFailure,
  findWindowsReservedGitPath,
  windowsReservedGitPathFailure,
} from "../lib/git-command-errors.mjs";
import {
  WINDOWS_DRIVES_PICKER_PATH,
  createWindowsDriveRootDiscovery,
  isWindowsDriveRoot,
  windowsDrivesPickerData,
} from "../lib/windows-drive-roots.mjs";
import { createPackageUpdates } from "../lib/package-updates.mjs";
import { ComponentUpdateState, sanitizeComponentUpdateError, validateUpdateApplyRequest, validateUpdatePlanRequest } from "../lib/component-update-state.mjs";
import { parseRuntimeVersion, resolveCanonicalPiRuntime, resolveWebuiRuntimeIdentity } from "../lib/update/resolver.mjs";
import { resolveUpdatePathPi } from "../lib/update/path-pi.mjs";
import { npmGlobalWebuiTarget, piUserWebuiTarget, selfUpdateCommand } from "../lib/update/native-targets.mjs";
import { acknowledgeUpdateFence, affectedParticipants, assertEffectAdmission, createUpdateAdmissionCounter, effectLockForRoot, persistSharedJob, readSharedJob, registerUpdateParticipant, releaseEffectLocks, sharedUpdateRoot, unregisterUpdateParticipant } from "../lib/update/coordination.mjs";
import { affectedActivePiDependency, createNativeUpdatePlan, inspectNativeJob, launchNativeUpdate, validateNativePlan } from "../lib/update/native-jobs.mjs";
import { publicNativeJob } from "../lib/update/discovery.mjs";
import { assertRestoredPiState, nativeUpdateOutcome } from "../lib/update/verification.mjs";
import { frozenUpdateEnvironment, readUpdateContext } from "./pi-webui-update-context.mjs";
import { packageOwnerRoot } from "../lib/update/package-layout.mjs";
import { updateStatePaths } from "../lib/update/journal.mjs";
import { createRestoreFile, listenWithRetry, probeStartupRestore, readRestoreFileOnce, sweepRestoreFiles } from "../lib/update/supervisor.mjs";
import { OPTIONAL_FEATURE_BY_ID, OPTIONAL_FEATURE_CATALOG } from "../lib/optional-feature-catalog.mjs";
import { createWorkspaceFilesService, FILE_VIEWER_BODY_LIMIT_BYTES } from "../lib/server/workspace-files.mjs";
import { createExtensionUiRequestService } from "../lib/server/extension-ui-requests.mjs";
import { createRpcTransportTypes } from "../lib/server/rpc-transports.mjs";
import { createSseDelivery } from "../lib/server/sse-delivery.mjs";
import { createHelperRequestService, WEBUI_HELPER_COMMAND } from "../lib/server/helper-requests.mjs";
import { createConversationVoiceService, VOICE_AUDIO_JSON_BODY_LIMIT_BYTES } from "../lib/server/conversation-voice.mjs";
import { createGitReadService } from "../lib/server/git-reads.mjs";
import { createConversationModeService, NATURAL_CONVERSATION_FEATURE_ID } from "../lib/server/conversation-mode.mjs";
import { createCodexFastModeService } from "../lib/server/codex-fast-mode.mjs";
import { createGitGenerationService } from "../lib/server/git-generation.mjs";
import { createGitMutationService, formatGitCommand } from "../lib/server/git-mutations.mjs";
import { createGitWorktreeSessionService } from "../lib/server/git-worktree-sessions.mjs";
import { createAppRunnerService } from "../lib/server/app-runners.mjs";
import {
  OptionalFeatureAuditCoordinator,
  OptionalFeatureMigrationStore,
} from "../lib/optional-feature-migration.mjs";
import { resolveNpmCommandInvocation, resolvePiCommandInvocation } from "../lib/npm-command.mjs";
import {
  GIT_WORKFLOW_DEFAULT_VARIANTS,
  GIT_WORKFLOW_DELIVERY_MODES,
  GIT_WORKFLOW_LANGUAGES,
  GIT_WORKFLOW_SCOPE_POLICIES,
  GIT_WORKFLOW_STAGING_POLICIES,
  GIT_WORKFLOW_THINKING_LEVELS,
  GIT_WORKFLOW_VERIFICATION_POLICIES,
  isGitWorkflowSetupComplete,
  mergeGitWorkflowPreferences,
  readGitWorkflowPreferences,
  supportedGitWorkflowThinkingLevels,
  writeGitWorkflowPreferences,
} from "../lib/git-workflow-preferences.mjs";
import {
  WEBUI_SIDE_PANEL_WIDTH_MAX_PX,
  WEBUI_SIDE_PANEL_WIDTH_MIN_PX,
  initializeWebuiShellRollout,
  legacyWebuiSettingsFile,
  validatedShellRolloutCohort,
  readWebuiSettings,
  updateWebuiSettings,
  webuiSettingsFile,
  writeWebuiSettings,
} from "../lib/server/settings-store.mjs";
import {
  exactModelProfile,
  preserveUnavailableResourceNames,
  resolveResourceSelection,
  setExactModelProfile,
} from "../lib/resource-selection.mjs";
import {
  UI_LAYOUT_REQUEST_MAX_BYTES,
  mergeUiLayout,
  uiLayoutRevision,
  validateUiLayoutPatch,
} from "../lib/ui-layout-settings.mjs";
import {
  SUBAGENT_LAUNCH_SLOT_LIMITS,
  SUBAGENT_LAUNCH_SLOT_ROLE_CATALOG,
  SUBAGENT_LAUNCH_SLOT_THINKING_LEVELS,
  normalizeSubagentLaunchSlots,
  resolveSubagentLaunchSlotProjectKey,
  subagentLaunchSlotModelKey,
  subagentLaunchSlotProjectLabel,
  subagentLaunchSlotRevision,
  subagentLaunchSlotScopeEntry,
  supportedSubagentLaunchSlotThinkingLevels,
  validateSubagentLaunchSlotRoles,
} from "../lib/subagent-launch-slots.mjs";
import {
  negotiateOutputMode,
  normalizeOutputMode,
  OUTPUT_MODE_COMPACT_V1,
  OUTPUT_MODE_NORMAL,
  OUTPUT_MODE_PROTOCOL_VERSION,
  resolveOutputModeDefault,
} from "../lib/webui-output-mode.mjs";
import {
  evaluateDispatchTrustGuards,
  guardsForNativeCommand,
  isLocalRequest,
  isLoopbackHostAuthority,
  projectTrustDecision,
  remoteShellTrustWarning,
  requireLocalhost,
  requireLocalhostRoute,
} from "../lib/trust-boundaries.mjs";
import {
  nativeCommandBlocked,
  nativeCommandResponse,
  nativeCommandUnavailable,
  nativeSlashCommandEntries,
  parseSlashCommand as parseNativeSlashCommand,
} from "../lib/native-command-adapter.mjs";
import {
  gitWorktreeErrorPayload,
  isGitLockFailure,
  listGitWorktrees,
  pathInside,
} from "../lib/git-worktrees.mjs";
import { createGitLiveWatcher } from "../lib/git-live-watcher.mjs";
import { createWorkspaceFilesLiveWatcher } from "../lib/workspace-files-live-watcher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packageRoot = path.resolve(__dirname, "..");
const publicDir = path.join(packageRoot, "public");
const webuiHelperExtensionPath = path.join(packageRoot, "webui-rpc-helper.mjs");
const sessionSummaryExtensionPath = path.join(packageRoot, "session-summary.ts");
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
const OPTIONAL_FEATURE_INSTALL_ROOT_ENV = "PI_WEBUI_OPTIONAL_FEATURE_INSTALL_ROOT";
const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
let piPackageJson = {};
try {
  const piPackageEntryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const piPackageJsonPath = path.resolve(path.dirname(piPackageEntryPath), "..", "package.json");
  piPackageJson = JSON.parse(await readFile(piPackageJsonPath, "utf8"));
} catch {
  piPackageJson = {};
}
const nativeParityMatrix = JSON.parse(await readFile(path.join(packageRoot, "lib", "WEBUI_TUI_NATIVE_PARITY.json"), "utf8"));
const webuiDevServer = isTruthyEnv(process.env.PI_WEBUI_DEV) || isSourceCheckout(packageRoot);
let remoteQrCorePromise = null;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 31415;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
// Keep supervisor waits bounded while preserving the existing two-hour prompt
// contract. A detached owner may legitimately outlive the HTTP server request.
const RPC_SUPERVISOR_COMMAND_TIMEOUT_MAX_MS = 24 * 60 * 60 * 1000;
const PROMPT_REQUEST_TIMEOUT_MS = Math.max(REQUEST_TIMEOUT_MS, Number.parseInt(process.env.PI_WEBUI_PROMPT_TIMEOUT_MS || "7200000", 10) || 7200000);
const SAMPLING_PARAMS_HTTP_MAX_BYTES = 20 * 1024;
const WEBUI_SUBAGENTS_STATUS_KEY = "webui-subagents";
const WEBUI_SUBAGENTS_PAYLOAD_PREFIX = "PI_WEBUI_SUBAGENTS_V1 ";
const WEBUI_SUBAGENTS_V2_STATUS_KEY = "webui-subagents-v2";
const WEBUI_SUBAGENTS_V2_PAYLOAD_PREFIX = "PI_WEBUI_SUBAGENTS_V2 ";
const WEBUI_AGENT_RUN_LIMIT = 512;
const WEBUI_AGENT_RUN_DIAGNOSTIC_LIMIT = 128;
const WEBUI_SUBAGENT_RUN_LIMIT = 128;
const WEBUI_SUBAGENT_AGENT_LIMIT = 256;
const WEBUI_SUBAGENT_GATE_LIMIT = 32;
const WEBUI_SUBAGENT_GATE_ATTEMPT_LIMIT = 100;
const WEBUI_SUBAGENT_OUTPUT_LINE_LIMIT = 120;
const WEBUI_SUBAGENT_OUTPUT_LINE_LENGTH = 1000;
const WEBUI_SUBAGENT_TELEMETRY_TOKEN_LIMIT = 1_000_000_000;
const WEBUI_SUBAGENT_TELEMETRY_CONTEXT_WINDOW_LIMIT = 16_000_000;
const WEBUI_SUBAGENT_TELEMETRY_SPEED_LIMIT = 1_000_000;
const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const WEBUI_PACKAGE = packageJson.name || "@firstpick/pi-package-webui";
const PI_LATEST_VERSION_URL = process.env.PI_WEBUI_PI_LATEST_VERSION_URL || "https://pi.dev/api/latest-version";
const PI_RELEASES_API_BASE_URL = (process.env.PI_WEBUI_PI_RELEASES_API_BASE_URL || "https://api.github.com/repos/earendil-works/pi/releases/tags").replace(/\/+$/, "");
const PI_RELEASES_PAGE_BASE_URL = "https://github.com/earendil-works/pi/releases/tag";
const NPM_REGISTRY_URL = (process.env.PI_WEBUI_NPM_REGISTRY_URL || "https://registry.npmjs.org").replace(/\/+$/, "");
const UPDATE_STATUS_CACHE_MS = 10 * 60 * 1000;
const UPDATE_STATUS_TIMEOUT_MS = 10 * 1000;
const PI_RELEASE_NOTES_MAX_CHARS = 250_000;
const PI_UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
const PI_UPDATE_OUTPUT_MAX_CHARS = 120_000;
const CORE_UPDATE_PACKAGE_NAMES = [PI_CODING_AGENT_PACKAGE, WEBUI_PACKAGE];
const PACKAGE_UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
const PACKAGE_UPDATE_OUTPUT_MAX_CHARS = 120_000;
const CODEX_USAGE_TIMEOUT_MS = 15 * 1000;
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_USAGE_ENDPOINT = process.env.PI_WEBUI_CODEX_USAGE_URL || "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_USAGE_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.PI_WEBUI_CLAUDE_USAGE_TIMEOUT_MS || "30000", 10) || 30000);
const CLAUDE_USAGE_OUTPUT_MAX_CHARS = 60_000;
const CLAUDE_USAGE_COMMAND = process.env.PI_WEBUI_CLAUDE_BIN || "claude";
const CLAUDE_USAGE_ARGS = ["--safe-mode", "--no-session-persistence", "-p", "/usage", "--output-format", "json"];
const BODY_LIMIT_BYTES = 1024 * 1024;
const CUSTOM_THEME_BODY_LIMIT_BYTES = 256 * 1024;
const SESSION_SUMMARY_REQUEST_MAX_BYTES = 32 * 1024;
const SESSION_SUMMARY_RPC_TYPE = "firstpick:session-summary-rpc";
const SESSION_SUMMARY_DISPLAY_TYPE = "firstpick:session-summary-display";
const SESSION_SUMMARY_PROTOCOL_VERSION = 1;
const SESSION_SUMMARY_TITLE_MAX_CHARS = 44;
const SESSION_SUMMARY_MARKDOWN_MAX_CHARS = 16 * 1024;
const SESSION_SUMMARY_PROMPT_MAX_CHARS = 8 * 1024;
const SESSION_SUMMARY_FAILURE_MAX_CHARS = 512;
const SESSION_SUMMARY_GENERATE_TIMEOUT_MS = 105 * 1000;
const SESSION_SUMMARY_KINDS = new Set(["setup", "state", "generating", "success", "failure", "title"]);
const RECOVERY_ENDPOINT_PATH = "/api/recovery/plan";
const RECOVERY_BODY_LIMIT_BYTES = 256 * 1024;
const RECOVERY_PROMPT_MAX_CHARS = 200_000;
const RECOVERY_TITLE = "Anthropic compatibility recovery";
const SKILL_FILE_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const PROMPT_BODY_LIMIT_BYTES = 24 * 1024 * 1024;
const QUEUE_MUTATION_MAX_ITEMS = 512;
const UPLOAD_BODY_LIMIT_BYTES = 96 * 1024 * 1024;
const ATTACHMENT_UPLOAD_MAX_FILES = 12;
const ATTACHMENT_UPLOAD_MAX_FILE_BYTES = 64 * 1024 * 1024;
const ATTACHMENT_UPLOAD_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const INLINE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const INLINE_IMAGE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
const RPC_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SETTINGS_TRANSPORT_CHOICES = ["sse", "websocket", "websocket-cached", "auto"];
const SETTINGS_HTTP_IDLE_TIMEOUT_CHOICES = [
  { label: "30 sec", timeoutMs: 30_000 },
  { label: "1 min", timeoutMs: 60_000 },
  { label: "2 min", timeoutMs: 120_000 },
  { label: "5 min", timeoutMs: 300_000 },
  { label: "disabled", timeoutMs: 0 },
];
const SETTINGS_DOUBLE_ESCAPE_ACTIONS = ["tree", "fork", "none"];
const SETTINGS_TREE_FILTER_MODES = ["default", "no-tools", "user-only", "labeled-only", "all"];
const SETTINGS_IMAGE_WIDTH_CELLS = [60, 80, 120];
const SETTINGS_EDITOR_PADDING_X = [0, 1, 2, 3];
const SETTINGS_AUTOCOMPLETE_MAX_VISIBLE = [3, 5, 7, 10, 15, 20];
const SETTINGS_RELOAD_RECOMMENDED_KEYS = new Set(["transport", "httpIdleTimeoutMs", "autoResizeImages", "blockImages", "enableSkillCommands"]);
const SETTINGS_RELOAD_LABELS = new Map([
  ["transport", "Transport"],
  ["httpIdleTimeoutMs", "HTTP idle timeout"],
  ["autoResizeImages", "Auto-resize images"],
  ["blockImages", "Block images"],
  ["enableSkillCommands", "Skill commands"],
]);
const EVENT_HISTORY_LIMIT = 200;
const STATUS_RPC_TIMEOUT_MS = 1_800;
const FAST_PICK_LIMIT = 30;
const PATH_SUGGESTION_LIMIT = 20;
const BANG_SUGGESTION_LIMIT = 24;
const BANG_SUGGESTION_QUERY_LIMIT = 512;
const PATH_SUGGESTION_QUERY_LIMIT = 512;
const PATH_SUGGESTION_SCAN_LIMIT = 5000;
const PATH_SUGGESTION_MAX_OUTPUT_LENGTH = 300000;
const PATH_SUGGESTION_EXCLUDED_DIRS = new Set([".git", "node_modules"]);
const RESTORE_TAB_LIMIT = 256;
const TAB_PROMPT_PATH_MAX_LENGTH = 4096;
const UPDATE_HEALTH_GATE_MS = Math.max(90_000, Number.parseInt(process.env.PI_WEBUI_UPDATE_HEALTH_GATE_MS || "90000", 10) || 90_000);
const bootIdentity = randomUUID();
const SESSION_SELECTOR_LIMIT = 200;
const TREE_SELECTOR_TEXT_LIMIT = 260;
const NETWORK_REBIND_DELAY_MS = 100;
const NETWORK_REBIND_FORCE_CLOSE_MS = 750;
const NATIVE_DOWNLOAD_TOKEN_TTL_MS = 10 * 60 * 1000;
const UPLOAD_TEMP_ROOT = path.join(tmpdir(), "pi-webui-uploads");
const NATIVE_EXPORT_TEMP_ROOT = path.join(tmpdir(), "pi-webui-native-exports");
const UPLOAD_TEMP_TTL_MS = 24 * 60 * 60 * 1000;
const NATIVE_EXPORT_TEMP_TTL_MS = 60 * 60 * 1000;
const TEMP_ARTIFACT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_TAB_TITLE_MAX_LENGTH = 44;
const AUTO_TAB_TITLE_DISPLAY_MAX_LENGTH = 160;
const AUTO_TAB_TITLE_WORD_LIMIT = 8;
const AUTO_TAB_TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "best",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "s",
  "should",
  "that",
  "the",
  "this",
  "to",
  "way",
  "what",
  "whats",
  "when",
  "with",
  "you",
  "your",
]);

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".jsonl", "application/x-ndjson; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".json", "application/json; charset=utf-8"],
  [".webp", "image/webp"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

function isTruthyEnv(value) {
  return ["1", "true", "yes", "dev"].includes(String(value || "").trim().toLowerCase());
}

function isSourceCheckout(root) {
  const normalized = String(root || "").replace(/\\/g, "/");
  if (normalized.includes("/node_modules/")) return false;
  try {
    const gitMarker = statSync(path.join(root, "..", ".git"));
    return gitMarker.isDirectory() || gitMarker.isFile();
  } catch {
    return false;
  }
}

const NATIVE_SLASH_COMMANDS = nativeSlashCommandEntries(nativeParityMatrix);
const NATIVE_SLASH_COMMAND_NAMES = new Set(NATIVE_SLASH_COMMANDS.map((command) => command.name));
const respondNative = (command, data = {}) => nativeCommandResponse(command, data, nativeParityMatrix);
const unavailableNative = (command, details = {}) => nativeCommandUnavailable(command, details, nativeParityMatrix);

function parseSlashCommand(message) {
  return parseNativeSlashCommand(message, NATIVE_SLASH_COMMAND_NAMES);
}
const OPTIONAL_FEATURE_PACKAGES = new Map(OPTIONAL_FEATURE_CATALOG.map(({ featureId, packageName }) => [featureId, packageName]));
const OPTIONAL_FEATURE_PACKAGE_NAMES = new Set(OPTIONAL_FEATURE_PACKAGES.values());
const WEBUI_RESOURCE_EXCLUDED_PACKAGES = new Set([WEBUI_PACKAGE]);
let optionalFeatureMigrationStore;
let optionalFeatureAuditCoordinator;
let optionalFeatureStartupReady = false;
const UPDATE_PACKAGE_NAMES = [...CORE_UPDATE_PACKAGE_NAMES].sort();
const REPLAYABLE_CLEARED_EXTENSION_STATUS_KEYS = new Set(["feature-decision-output", "feature-category"]);
const GUIDED_GIT_START_STATUS_KEY = "git-guided-workflow:webui-start";
const GUIDED_GIT_START_PAYLOAD_TYPE = "firstpick.pi-extension-git-guided-workflow.start";
const GUIDED_GIT_START_PAYLOAD_VERSION = 1;
const GUIDED_GIT_LAUNCH_TTL_MS = 15_000;
const GUIDED_GIT_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GUIDED_GIT_COMMAND_MESSAGE = /^\/git-guided-workflow(?::\d+)?$/u;
const PACKAGE_NAME_CACHE = new Map();

function usage() {
  console.log(`pi-webui ${packageJson.version}

Pi Web UI companion server for Pi coding agent RPC mode.

Usage:
  pi-webui [options] [-- <pi args...>]

Options:
  --host <host>       HTTP bind host (default: ${DEFAULT_HOST})
  --port <port>       HTTP port (default: ${DEFAULT_PORT})
  --cwd <path>        Start the first Pi terminal in this working directory
  --pi <command>      Pi executable to spawn (default: bundled dependency, then "pi")
  --no-session        Start Pi RPC with --no-session
  --name <name>       Initial Web UI tab display name
  --remote-auth       Enable startup PIN authentication for non-local clients
  --no-remote-auth    Disable startup PIN authentication
  --output-mode <mode>  Web UI output default: normal or compact-v1
  --migrate-optional-features  Migrate audit-selected legacy optional features
  --migration-dry-run  Print the startup migration plan without package mutation
  -h, --help          Show this help
  -v, --version       Print version

If --cwd is omitted, the server starts first and the browser asks for
  the first terminal CWD.

Examples:
  pi-webui
  pi-webui --cwd ~/src/my-project
  pi-webui --port 3000 -- --model anthropic/claude-sonnet-4-5:high
  PI_WEBUI_PI_BIN=/path/to/pi pi-webui --no-session

Security:
  The web UI controls Pi tools. It binds to localhost by default. Remote PIN
  authentication is off by default on first use; enabling it in Controls saves
  that preference for later starts.
`);
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function requiredOutputMode(value, source) {
  const mode = String(value || "").trim();
  if (![OUTPUT_MODE_NORMAL, OUTPUT_MODE_COMPACT_V1].includes(mode)) {
    throw new Error(`${source} must be one of: ${OUTPUT_MODE_NORMAL}, ${OUTPUT_MODE_COMPACT_V1}`);
  }
  return mode;
}

function parseArgs(argv) {
  const options = {
    host: process.env.PI_WEBUI_HOST || DEFAULT_HOST,
    port: Number.parseInt(process.env.PI_WEBUI_PORT || String(DEFAULT_PORT), 10),
    cwd: process.cwd(),
    cwdExplicit: false,
    piBin: process.env.PI_WEBUI_PI_BIN || "pi",
    piBinExplicit: !!process.env.PI_WEBUI_PI_BIN,
    noSession: false,
    name: undefined,
    remoteAuth: isTruthyEnv(process.env.PI_WEBUI_REMOTE_AUTH),
    remoteAuthExplicit: process.env.PI_WEBUI_REMOTE_AUTH !== undefined,
    outputMode: undefined,
    envOutputMode: process.env.PI_WEBUI_OUTPUT_MODE === undefined ? undefined : requiredOutputMode(process.env.PI_WEBUI_OUTPUT_MODE, "PI_WEBUI_OUTPUT_MODE"),
    migrateOptionalFeatures: false,
    migrationDryRun: false,
    piArgs: [],
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      options.piArgs.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      options.version = true;
      continue;
    }
    if (arg === "--host") {
      options.host = takeValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--port") {
      const value = Number.parseInt(takeValue(argv, i, arg), 10);
      if (!Number.isFinite(value) || value <= 0 || value > 65535) {
        throw new Error("--port must be a TCP port between 1 and 65535");
      }
      options.port = value;
      i++;
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = path.resolve(expandUserPath(takeValue(argv, i, arg)));
      options.cwdExplicit = true;
      i++;
      continue;
    }
    if (arg === "--pi") {
      options.piBin = takeValue(argv, i, arg);
      options.piBinExplicit = true;
      i++;
      continue;
    }
    if (arg === "--no-session") {
      options.noSession = true;
      continue;
    }
    if (arg === "--name") {
      options.name = takeValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--output-mode") {
      options.outputMode = requiredOutputMode(takeValue(argv, i, arg), "--output-mode");
      i++;
      continue;
    }
    if (arg === "--migrate-optional-features") {
      options.migrateOptionalFeatures = true;
      continue;
    }
    if (arg === "--migration-dry-run") {
      options.migrationDryRun = true;
      continue;
    }
    if (arg === "--remote-auth") {
      options.remoteAuth = true;
      options.remoteAuthExplicit = true;
      continue;
    }
    if (arg === "--no-remote-auth") {
      options.remoteAuth = false;
      options.remoteAuthExplicit = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}. Pass Pi CLI args after --.`);
  }

  if (!Number.isFinite(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error("Invalid PI_WEBUI_PORT; expected a TCP port between 1 and 65535");
  }

  return options;
}

async function validateStartupCwd(cwd) {
  const normalized = path.resolve(String(cwd || ""));
  let info;
  try {
    info = await stat(normalized);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new Error(`--cwd does not exist: ${normalized}`);
    }
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw new Error(`--cwd is not accessible: ${normalized}`);
    }
    throw new Error(`Cannot access --cwd ${normalized}: ${formatCliError(error)}`);
  }
  if (!info.isDirectory()) throw new Error(`--cwd is not a directory: ${normalized}`);
  return normalized;
}

function isLocalHost(host) {
  return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

function formatUrlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function makeUserFacingError(message, props = {}) {
  const text = String(message || "Unknown error").trim() || "Unknown error";
  const error = new Error(text);
  error.userMessage = text;
  Object.assign(error, props);
  return error;
}

function sanitizeError(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error.userMessage) return error.userMessage;
  return error.stack || error.message || String(error);
}

function formatCliError(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  return error.userMessage || error.message || String(error);
}

function formatCommandSpawnError(command, error) {
  const commandText = String(command || "command");
  const executable = commandText.split(/[\\/]/).pop() || commandText;
  const isGit = /^git(?:\.exe)?$/i.test(executable);
  if (error?.code === "ENOENT") {
    if (isGit) {
      const windowsHint = process.platform === "win32"
        ? " On Windows, install Git for Windows and choose 'Git from the command line and also from 3rd-party software', or add Git's cmd/bin directory to PATH."
        : "";
      return `Git executable not found on PATH (spawn ${executable} ENOENT). Install Git and ensure the 'git' command is available to the Pi Web UI process, then restart Pi Web UI.${windowsHint}`;
    }
    return `${executable} executable not found on PATH (spawn ${executable} ENOENT). Install it or add it to PATH, then restart Pi Web UI.`;
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return `Cannot start ${executable}: permission denied. Check executable permissions and PATH.`;
  }
  return formatCliError(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateLongText(value, maxLength = 8000) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function stripAnsi(text) {
  return String(text ?? "").replace(/(?:\x1B|\u241B)(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function parsePackageVersion(version) {
  const match = String(version || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!match) return undefined;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4],
  };
}

function comparePackageVersions(leftVersion, rightVersion) {
  const left = parsePackageVersion(leftVersion);
  const right = parsePackageVersion(rightVersion);
  if (!left || !right) return undefined;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

function isNewerPackageVersion(candidateVersion, currentVersion) {
  const comparison = comparePackageVersions(candidateVersion, currentVersion);
  if (comparison !== undefined) return comparison > 0;
  return String(candidateVersion || "").trim() !== String(currentVersion || "").trim();
}

async function fetchJsonWithTimeout(url, { timeoutMs = UPDATE_STATUS_TIMEOUT_MS, headers = {} } = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
  return response.json();
}

function piRelease(version = piPackageJson.version) {
  const cleanVersion = String(version || "").trim().replace(/^v/i, "");
  if (!parsePackageVersion(cleanVersion)) throw makeHttpError(503, "The Pi release version could not be determined");
  const tagName = `v${cleanVersion}`;
  return {
    version: cleanVersion,
    tagName,
    apiUrl: `${PI_RELEASES_API_BASE_URL}/${encodeURIComponent(tagName)}`,
    pageUrl: `${PI_RELEASES_PAGE_BASE_URL}/${encodeURIComponent(tagName)}`,
  };
}

let piReleaseNotesCache = null;

async function piReleaseNotes() {
  const cachedUpdateStatus = updateStatusCache && Date.now() - updateStatusCacheAt < UPDATE_STATUS_CACHE_MS
    ? updateStatusCache.pi
    : null;
  const piStatus = cachedUpdateStatus || await checkLatestPiReleaseStatus();
  const currentVersion = String(piStatus?.currentVersion || piStatus?.activeRuntimeVersion || piPackageJson.version || "").trim().replace(/^v/i, "");
  const latestVersion = String(piStatus?.latestVersion || "").trim().replace(/^v/i, "");
  const release = piRelease(piStatus?.updateAvailable && parsePackageVersion(latestVersion) ? latestVersion : currentVersion);
  if (piReleaseNotesCache?.tagName === release.tagName) return piReleaseNotesCache;
  if (process.env.PI_OFFLINE) throw makeHttpError(503, "Pi release notes are unavailable while PI_OFFLINE is set");

  let data;
  try {
    data = await fetchJsonWithTimeout(release.apiUrl, {
      headers: {
        "User-Agent": `pi-webui/${packageJson.version} pi/${release.version}`,
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (error) {
    throw makeHttpError(502, `Could not fetch Pi ${release.tagName} release notes from GitHub: ${sanitizeError(error)}`);
  }

  const responseTag = typeof data?.tag_name === "string" ? data.tag_name.trim() : "";
  if (responseTag && responseTag !== release.tagName) {
    throw makeHttpError(502, `GitHub returned release ${responseTag} instead of ${release.tagName}`);
  }
  const fullBody = typeof data?.body === "string" ? data.body.trim() : "";
  piReleaseNotesCache = {
    version: release.version,
    tagName: release.tagName,
    title: truncateLongText(typeof data?.name === "string" ? data.name.trim() : "", 240) || `Pi ${release.tagName}`,
    body: truncateLongText(fullBody, PI_RELEASE_NOTES_MAX_CHARS),
    truncated: fullBody.length > PI_RELEASE_NOTES_MAX_CHARS,
    publishedAt: typeof data?.published_at === "string" ? data.published_at : "",
    url: release.pageUrl,
  };
  return piReleaseNotesCache;
}

let nativeAdmissionState = null;
const nativeAdmittedWork = createUpdateAdmissionCounter();
let startupProbeReady = false;

async function assertNativeMutationAdmission() {
  if (process.env.PI_WEBUI_STARTUP_PROBE === "1") throw makeHttpError(409, "Isolated startup probes cannot mutate packages or restart.");
  if (!nativeAdmissionState) throw makeHttpError(409, "Update admission is not initialized.");
  try { await assertEffectAdmission(nativeAdmissionState.root, nativeAdmissionState.participant.canonicalRoots); }
  catch (error) {
    if (error?.code === "UPDATE_FENCED") throw makeHttpError(409, "An affected package installation is fenced for update or recovery.");
    throw error;
  }
}

async function assertNativeRpcAdmission(command) {
  if (["get_state", "get_messages", "get_session_stats", "get_available_models", "get_commands"].includes(command?.type)) return;
  if (!nativeAdmissionState) throw new Error("Update admission is not initialized.");
  await assertEffectAdmission(nativeAdmissionState.root, nativeAdmissionState.participant.canonicalRoots);
}

// JSON responses are compact and, when the client accepts it, compressed. Boot alone fetches
// ~1.5 MB of JSON (models, commands, tools, subagent config); over remote access or a phone the
// pretty-printed uncompressed payloads were seconds of transfer per reload.
const JSON_COMPRESSION_MIN_BYTES = 2048;

function sendJson(res, statusCode, payload, headers = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const responseHeaders = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  };
  let body = raw;
  const encoding = raw.length >= JSON_COMPRESSION_MIN_BYTES ? res.piAcceptedEncoding || "" : "";
  if (encoding === "br") {
    body = brotliCompressSync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
    responseHeaders["content-encoding"] = "br";
    responseHeaders.vary = "Accept-Encoding";
  } else if (encoding === "gzip") {
    body = gzipSync(raw, { level: 5 });
    responseHeaders["content-encoding"] = "gzip";
    responseHeaders.vary = "Accept-Encoding";
  }
  responseHeaders["content-length"] = body.length;
  res.writeHead(statusCode, responseHeaders);
  res.end(body);
}

function makeHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendError(res, statusCode, error) {
  const message = error?.gitWorkflowGeneration
    ? "Guided Git generation failed after the configured model attempts."
    : statusCode >= 500 ? sanitizeError(error) : formatCliError(error);
  const payload = { ok: false, error: message };
  const isThemeError = typeof error?.code === "string" && error.code.startsWith("THEME_");
  if (isThemeError) payload.code = error.code;
  if (isThemeError && error?.details && typeof error.details === "object") payload.details = error.details;
  if (error?.optionalFeatureInstall) payload.optionalFeatureInstall = error.optionalFeatureInstall;
  if (error?.gitWorkflowGeneration && typeof error.gitWorkflowGeneration === "object") {
    payload.gitWorkflowGeneration = error.gitWorkflowGeneration;
  }
  sendJson(res, statusCode, payload);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let scaled = value / 1024;
  for (const unit of units) {
    if (scaled < 1024 || unit === units[units.length - 1]) return `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${unit}`;
    scaled /= 1024;
  }
  return `${value} B`;
}

async function readJsonBody(req, { limitBytes = BODY_LIMIT_BYTES, emptyError } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw makeHttpError(413, `Request body too large (limit ${formatBytes(limitBytes)})`);
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    if (emptyError) throw makeHttpError(400, emptyError);
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    if (emptyError) throw makeHttpError(400, emptyError);
    return {};
  }
  return JSON.parse(text);
}

function parseCookieHeader(header = "") {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) {
      try {
        cookies.set(name, decodeURIComponent(value));
      } catch {
        cookies.set(name, value);
      }
    }
  }
  return cookies;
}

function safeTimingEqual(a = "", b = "") {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeReturnPath(value) {
  const text = String(value || "/").trim();
  if (!text.startsWith("/") || text.startsWith("//")) return "/";
  return text;
}

function remoteAuthCookie(token = remoteAuth.token) {
  const maxAge = Math.max(0, Math.floor((remoteAuth.tokenExpiresAt - Date.now()) / 1000));
  return `pi_remote_auth=${encodeURIComponent(token || "")}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearRemoteAuthCookie() {
  return "pi_remote_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

function requestHasRemoteAuth(req) {
  if (!remoteAuthRequired()) return true;
  const token = parseCookieHeader(req.headers.cookie).get("pi_remote_auth");
  return !!(token && remoteAuth.token && remoteAuth.tokenExpiresAt > Date.now() && safeTimingEqual(token, remoteAuth.token));
}

function isRemoteAuthPublicPath(pathname) {
  return pathname === "/remote-auth" || pathname === "/api/remote-auth" || pathname === "/favicon.svg";
}

function shouldChallengeRemoteAuth(req, url) {
  if (isLocalRequest(req) || !remoteAuthRequired() || isRemoteAuthPublicPath(url.pathname)) return false;
  return !requestHasRemoteAuth(req);
}

function sendRemoteAuthPage(res, returnPath = "/") {
  const safeReturn = safeReturnPath(returnPath);
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pi Web UI Remote PIN</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e5e7eb; }
    body { min-height: 100vh; display: grid; place-items: center; margin: 0; padding: 24px; box-sizing: border-box; }
    main { width: min(420px, 100%); padding: 28px; border: 1px solid rgba(148, 163, 184, 0.28); border-radius: 20px; background: rgba(15, 23, 42, 0.92); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35); }
    h1 { margin: 0 0 8px; font-size: 1.45rem; }
    p { margin: 0 0 20px; color: #94a3b8; line-height: 1.5; }
    label { display: block; margin-bottom: 8px; color: #cbd5e1; font-weight: 650; }
    input { width: 100%; box-sizing: border-box; border: 1px solid rgba(148, 163, 184, 0.36); border-radius: 14px; padding: 14px 16px; background: #020617; color: #f8fafc; font: inherit; font-size: 1.6rem; letter-spacing: 0.32em; text-align: center; }
    button { width: 100%; margin-top: 16px; border: 0; border-radius: 14px; padding: 14px 16px; background: #22c55e; color: #052e16; font: inherit; font-weight: 800; cursor: pointer; }
    button:disabled { opacity: 0.65; cursor: wait; }
    .error { min-height: 1.4em; margin-top: 14px; color: #fca5a5; }
  </style>
</head>
<body>
  <main>
    <h1>Remote PIN required</h1>
    <p>Scan a trusted /remote QR code to unlock automatically, or enter the 4-digit PIN shown in the local Pi terminal or local Web UI.</p>
    <form id="pinForm" autocomplete="off">
      <label for="pin">PIN</label>
      <input id="pin" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autofocus required>
      <button id="submit" type="submit">Unlock Web UI</button>
      <div id="error" class="error" role="alert"></div>
    </form>
  </main>
  <script>
    const returnPath = ${JSON.stringify(safeReturn).replace(/</g, "\\u003c")};
    const form = document.getElementById("pinForm");
    const input = document.getElementById("pin");
    const button = document.getElementById("submit");
    const error = document.getElementById("error");
    function pinFromHash() {
      const params = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
      const pin = String(params.get("pin") || "").trim();
      return /^\\d{4}$/.test(pin) ? pin : "";
    }
    async function submitPin(pin) {
      button.disabled = true;
      error.textContent = "";
      try {
        const response = await fetch("/api/remote-auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pin }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.error || "Incorrect PIN");
        window.location.replace(returnPath || "/");
      } catch (err) {
        error.textContent = err?.message || String(err);
        input.select();
      } finally {
        button.disabled = false;
      }
    }
    input.addEventListener("input", () => { input.value = input.value.replace(/\\D/g, "").slice(0, 4); error.textContent = ""; });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await submitPin(input.value);
    });
    const autoPin = pinFromHash();
    if (autoPin) {
      input.value = autoPin;
      window.history.replaceState(null, "", window.location.pathname + (window.location.search || ""));
      submitPin(autoPin);
    }
  </script>
</body>
</html>`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendRemoteAuthRequired(req, res, url) {
  const acceptsHtml = String(req.headers.accept || "").includes("text/html");
  if (req.method === "GET" && (acceptsHtml || url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/remote-auth")) {
    sendRemoteAuthPage(res, `${url.pathname}${url.search || ""}`);
    return;
  }
  sendJson(res, 401, { ok: false, error: "Remote PIN required", remoteAuthRequired: true }, { "www-authenticate": "PiRemotePin" });
}

// A false ServerResponse.write() result means the frame was accepted but the
// writable buffer crossed its high-water mark. Treating that as a dead client
// disconnects healthy Chromium EventSource streams as soon as a frame exceeds
// roughly 16 KiB. Queue subsequent frames until "drain", with strict bounds so
// a client that truly stops reading cannot grow server memory indefinitely.







function rpcSuccess(command, data = {}) {
  return { type: "response", command, success: true, data };
}

const nativeDownloadTokens = new Map();

function pruneNativeDownloadTokens(now = Date.now()) {
  for (const [token, item] of nativeDownloadTokens) {
    if (!item || item.expiresAt <= now) nativeDownloadTokens.delete(token);
  }
}

function safeDownloadFileName(name, fallback = "pi-export") {
  const text = String(name || fallback).replace(/[\r\n\\/]+/g, " ").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 180);
}

function contentDispositionHeader(fileName, disposition = "attachment") {
  const safeName = safeDownloadFileName(fileName);
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function contentDispositionAttachment(fileName) {
  return contentDispositionHeader(fileName, "attachment");
}

function contentDispositionInline(fileName) {
  return contentDispositionHeader(fileName, "inline");
}

function registerNativeDownload(filePath, { fileName, contentType, command = "native" } = {}) {
  pruneNativeDownloadTokens();
  const token = randomUUID();
  const expiresAt = Date.now() + NATIVE_DOWNLOAD_TOKEN_TTL_MS;
  const record = {
    path: filePath,
    fileName: safeDownloadFileName(fileName || path.basename(filePath)),
    contentType: contentType || MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
    command,
    expiresAt,
  };
  nativeDownloadTokens.set(token, record);
  const url = `/api/native-download/${encodeURIComponent(token)}`;
  return {
    url,
    openUrl: record.contentType === MIME_TYPES.get(".html") ? `${url}?disposition=inline` : undefined,
    fileName: record.fileName,
    contentType: record.contentType,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

async function sendNativeDownload(res, token, { inline = false } = {}) {
  pruneNativeDownloadTokens();
  const item = nativeDownloadTokens.get(token);
  if (!item) throw makeHttpError(404, "Download token expired or not found");
  const fileStats = await stat(item.path).catch(() => null);
  if (!fileStats?.isFile()) {
    nativeDownloadTokens.delete(token);
    throw makeHttpError(404, "Download file expired or not found");
  }
  const canRenderInline = inline === true && item.contentType === MIME_TYPES.get(".html");
  res.writeHead(200, {
    "content-type": item.contentType,
    "content-length": String(fileStats.size),
    "content-disposition": canRenderInline ? contentDispositionInline(item.fileName) : contentDispositionAttachment(item.fileName),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  await new Promise((resolve, reject) => {
    const stream = createReadStream(item.path);
    stream.on("error", reject);
    res.on("error", reject);
    res.on("close", resolve);
    stream.on("end", resolve);
    stream.pipe(res);
  });
}

const documentArtifactTokens = new Map();
const DEFAULT_DOCUMENT_ARTIFACT_ROOT = path.join(tmpdir(), "pi-extension-docx");
const DOCUMENT_ARTIFACT_MANIFEST_LIMIT_BYTES = 2 * 1024 * 1024;
const DOCUMENT_ARTIFACT_PAGE_LIMIT = 10_000;

function documentArtifactRoots() {
  return [...new Set([DEFAULT_DOCUMENT_ARTIFACT_ROOT, ...String(process.env.PI_WEBUI_ARTIFACT_ROOTS || "").split(path.delimiter).map((item) => item.trim()).filter(Boolean)].map((item) => path.resolve(item)))];
}

function documentArtifactPath(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("artifact path is unavailable");
  const info = statSync(filePath, { throwIfNoEntry: false });
  if (!info?.isFile()) throw new Error("artifact file is unavailable");
  const real = realpathSync(filePath);
  const root = documentArtifactRoots().map((candidate) => { try { return realpathSync(candidate); } catch { return null; } }).find((candidate) => candidate && (candidate === real || pathInside(candidate, real)));
  if (!root) throw new Error("artifact path is outside configured roots");
  return { path: real, root, size: info.size };
}

function pruneDocumentArtifactTokens(now = Date.now()) {
  for (const [token, item] of documentArtifactTokens) if (!item || item.expiresAt <= now) documentArtifactTokens.delete(token);
}

const PRIVATE_ARTIFACT_KEYS = new Set(["manifestPath", "downloadPath", "outputPath", "sourcePath", "stagedPath", "pdfPath", "workspace", "recoveryPath", "artifactPath", "fullOutputPath"]);
function sanitizeArtifactMetadata(value, depth = 0) {
  if (depth > 20) return "[depth limit]";
  if (Array.isArray(value)) return value.map((item) => sanitizeArtifactMetadata(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" && value.length > 100_000 ? `${value.slice(0, 100_000)}…` : value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_ARTIFACT_KEYS.has(key)).map(([key, item]) => [key, sanitizeArtifactMetadata(item, depth + 1)]));
}

function artifactSessionIdentity(tab) {
  return normalizedRestoreString(tab?.lastState?.sessionId || tabRestorableSessionFile(tab), 4096) || null;
}

function publicDocumentArtifact(record) {
  const tabQuery = `tab=${encodeURIComponent(record.tabId)}`;
  const base = `/api/artifacts/${encodeURIComponent(record.token)}`;
  return {
    schema: "pi.artifact/v1",
    kind: "document",
    id: record.id,
    revisionId: record.revisionId,
    title: record.title,
    mimeType: record.mimeType,
    pageCount: record.pageCount,
    expiresAt: new Date(record.expiresAt).toISOString(),
    manifestUrl: `${base}/manifest?${tabQuery}`,
    downloadUrl: record.downloadPath ? `${base}/download?${tabQuery}` : undefined,
  };
}

function registerDocumentArtifact(tab, artifact) {
  if (!artifact || artifact.schema !== "pi.artifact/v1" || artifact.kind !== "document" || typeof artifact.id !== "string" || !artifact.id.trim()) throw new Error("invalid pi.artifact/v1 document envelope");
  pruneDocumentArtifactTokens();
  const sessionIdentity = artifactSessionIdentity(tab), existing = [...documentArtifactTokens.values()].find((item) => item.tabId === tab.id && item.sessionIdentity === sessionIdentity && item.id === artifact.id && item.revisionId === (artifact.revisionId || undefined));
  if (existing) return publicDocumentArtifact(existing);
  const manifestFile = documentArtifactPath(artifact.manifestPath);
  if (manifestFile.size > DOCUMENT_ARTIFACT_MANIFEST_LIMIT_BYTES) throw new Error("artifact manifest is too large");
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile.path, "utf8")); } catch { throw new Error("artifact manifest is malformed"); }
  const declared = manifest?.artifact;
  if (declared?.schema !== "pi.artifact/v1" || declared?.kind !== "document" || declared?.id !== artifact.id || (declared?.revisionId || undefined) !== (artifact.revisionId || undefined)) throw new Error("artifact manifest identity mismatch");
  const downloadPath = artifact.downloadPath ? documentArtifactPath(artifact.downloadPath).path : undefined;
  const rawPages = Array.isArray(manifest.pages) ? manifest.pages : [];
  if (rawPages.length > DOCUMENT_ARTIFACT_PAGE_LIMIT) throw new Error("artifact page count exceeds the registry limit");
  const pages = rawPages.map((page, index) => {
    const pageNum = Number(page?.pageNum);
    if (!Number.isInteger(pageNum) || pageNum < 1) throw new Error(`artifact page ${index + 1} is invalid`);
    const image = documentArtifactPath(page.outputPath);
    if (MIME_TYPES.get(path.extname(image.path).toLowerCase()) !== "image/png") throw new Error(`artifact page ${pageNum} is not PNG`);
    return { pageNum, width: Number(page.width) || undefined, height: Number(page.height) || undefined, bytes: image.size, path: image.path };
  });
  const declaredExpiry = Date.parse(String(artifact.expiresAt || declared?.expiresAt || "")), now = Date.now();
  if (!Number.isFinite(declaredExpiry) || declaredExpiry <= now) throw new Error("artifact is expired");
  const token = randomUUID(), expiresAt = Math.min(declaredExpiry, now + NATIVE_DOWNLOAD_TOKEN_TTL_MS);
  const record = {
    token,
    tabId: tab.id,
    sessionIdentity,
    id: artifact.id,
    revisionId: artifact.revisionId || undefined,
    title: safeDownloadFileName(artifact.title || declared?.title || "document.docx", "document.docx"),
    mimeType: String(artifact.mimeType || declared?.mimeType || "application/octet-stream"),
    pageCount: Number(artifact.pageCount ?? declared?.pageCount ?? pages.length) || pages.length,
    manifest: {
      sourceSha256: typeof manifest.sourceSha256 === "string" ? manifest.sourceSha256 : undefined,
      renderer: manifest.renderer && typeof manifest.renderer === "object" ? sanitizeArtifactMetadata(manifest.renderer) : undefined,
      warnings: Array.isArray(manifest.warnings) ? sanitizeArtifactMetadata(manifest.warnings.slice(0, 100)) : [],
      outline: Array.isArray(manifest.outline) ? sanitizeArtifactMetadata(manifest.outline.slice(0, 10_000)) : [],
      comments: Array.isArray(manifest.comments) ? sanitizeArtifactMetadata(manifest.comments.slice(0, 10_000)) : [],
      revisions: Array.isArray(manifest.revisions) ? sanitizeArtifactMetadata(manifest.revisions.slice(0, 10_000)) : [],
      diff: manifest.diff && typeof manifest.diff === "object" ? sanitizeArtifactMetadata(manifest.diff) : undefined,
    },
    manifestPath: manifestFile.path,
    downloadPath,
    pages,
    expiresAt,
  };
  documentArtifactTokens.set(token, record);
  return publicDocumentArtifact(record);
}

function rewriteArtifactInResult(tab, result) {
  if (!result || typeof result !== "object") return result;
  const details = result.details;
  if (!details || typeof details !== "object" || details.artifact?.schema !== "pi.artifact/v1") return result;
  let artifact;
  try { artifact = registerDocumentArtifact(tab, details.artifact); }
  catch { artifact = { schema: "pi.artifact/v1", kind: "document", id: String(details.artifact?.id || "unavailable"), title: safeDownloadFileName(details.artifact?.title || "Document"), unavailable: true }; }
  return { ...result, details: { ...details, artifact } };
}

function rewriteArtifactsForTab(tab, payload) {
  if (!payload || typeof payload !== "object") return payload;
  let next = payload;
  if (payload.result) next = { ...next, result: rewriteArtifactInResult(tab, payload.result) };
  if (payload.partialResult) next = { ...next, partialResult: rewriteArtifactInResult(tab, payload.partialResult) };
  if (payload.message?.role === "toolResult") next = { ...next, message: rewriteArtifactInResult(tab, payload.message) };
  if (Array.isArray(payload.data?.messages)) next = { ...next, data: { ...payload.data, messages: payload.data.messages.map((message) => message?.role === "toolResult" ? rewriteArtifactInResult(tab, message) : message) } };
  return next;
}

function documentArtifactRecord(req, url, token) {
  pruneDocumentArtifactTokens();
  const record = documentArtifactTokens.get(token);
  if (!record) throw makeHttpError(404, "Artifact token expired or not found");
  const tab = getRequestedTab(req, url);
  if (tab.id !== record.tabId || (record.sessionIdentity && artifactSessionIdentity(tab) !== record.sessionIdentity)) throw makeHttpError(404, "Artifact token expired or not found");
  return record;
}

async function sendDocumentArtifactFile(req, res, filePath, { contentType, fileName, inline = false } = {}) {
  const resolved = documentArtifactPath(filePath), range = String(req.headers.range || "").trim();
  let start = 0, end = resolved.size - 1, status = 200;
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) throw makeHttpError(416, "Unsupported artifact byte range");
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    if (!match[1] && match[2]) { const suffix = Number(match[2]); start = Math.max(0, resolved.size - suffix); end = resolved.size - 1; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= resolved.size) throw makeHttpError(416, "Artifact byte range is unsatisfiable");
    end = Math.min(end, resolved.size - 1); status = 206;
  }
  const headers = {
    "content-type": contentType || MIME_TYPES.get(path.extname(resolved.path).toLowerCase()) || "application/octet-stream",
    "content-length": String(Math.max(0, end - start + 1)),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  };
  if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${resolved.size}`;
  if (fileName) headers["content-disposition"] = inline ? contentDispositionInline(fileName) : contentDispositionAttachment(fileName);
  res.writeHead(status, headers);
  await new Promise((resolve, reject) => { const stream = createReadStream(resolved.path, { start, end }); stream.on("error", reject); res.on("error", reject); res.on("close", resolve); stream.on("end", resolve); stream.pipe(res); });
}

const ACTION_FEEDBACK_REACTIONS = new Set(["up", "down", "question"]);

function trimFeedbackField(value, maxLength) {
  const text = String(value || "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeActionFeedbackItems(body) {
  const rawItems = Array.isArray(body?.feedback) ? body.feedback : Array.isArray(body?.items) ? body.items : [];
  if (rawItems.length === 0) throw new Error("feedback is required");
  if (rawItems.length > 20) throw new Error("feedback is limited to 20 reactions per submission");
  return rawItems.map((item, index) => {
    const reaction = String(item?.reaction || "").trim();
    if (!ACTION_FEEDBACK_REACTIONS.has(reaction)) throw new Error(`Invalid feedback reaction at item ${index + 1}`);
    return {
      reaction,
      comment: trimFeedbackField(item?.comment, 800),
      kind: trimFeedbackField(item?.kind || "action", 80),
      title: trimFeedbackField(item?.title || `item ${index + 1}`, 240),
      snippet: trimFeedbackField(item?.snippet, 2000),
      messageIndex: Number.isFinite(Number(item?.messageIndex)) ? Number(item.messageIndex) : index,
      createdAt: trimFeedbackField(item?.createdAt, 80),
    };
  });
}

function actionFeedbackReactionLabel(reaction) {
  if (reaction === "up") return "👍 thumbs up — Good job; repeat this pattern when appropriate.";
  if (reaction === "down") return "👎 thumbs down — avoid or reconsider this target/pattern; prioritize the user comment.";
  return "? question mark — explain this target in detail in the final output.";
}

function formatActionFeedbackLearningPrompt(items) {
  const lines = [
    "The user submitted direct feedback on specific Web UI action or final-output cards from your last run.",
    "Use it to steer future behavior and create or update a concise LEARNING note from this feedback.",
    "Reaction semantics:",
    "- 👍 thumbs up: treat as 'Good job!' and reinforce the action/pattern.",
    "- 👎 thumbs down: avoid or reconsider this target/pattern; include any user comment.",
    "- ? question mark: explain the target in detail in your final output.",
    "",
    "Feedback items:",
  ];

  items.forEach((item, index) => {
    lines.push(
      `${index + 1}. ${actionFeedbackReactionLabel(item.reaction)}`,
      `   Target (${item.kind}): ${item.title}`,
      item.comment ? `   User comment: ${item.comment}` : undefined,
      item.snippet ? `   Action excerpt:\n${item.snippet.split(/\r?\n/).map((line) => `     ${line}`).join("\n")}` : undefined,
    );
  });

  lines.push(
    "",
    "After processing this feedback, report which LEARNING was created or updated. If any item used '?', include the requested detailed explanation in the final response.",
  );
  return lines.filter((line) => line !== undefined).join("\n");
}

async function handleActionFeedback(tab, body) {
  const feedbackItems = normalizeActionFeedbackItems(body);
  const state = await tab.rpc.send({ type: "get_state" });
  if (state.success === false) return state;
  if (state.data?.isStreaming || state.data?.isCompacting) {
    throw makeHttpError(409, "Wait for the current agent run or compaction to finish before sending feedback.");
  }

  const command = { type: "prompt", message: formatActionFeedbackLearningPrompt(feedbackItems) };
  markTabWorking(tab);
  const response = await tab.rpc.send(command);
  if (response.success === false) markTabIdle(tab);
  return response;
}

function truncateTabTitle(title, maxLength = AUTO_TAB_TITLE_MAX_LENGTH) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  if (!maxLength || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function titleCaseTabTitle(title) {
  return title ? `${title.charAt(0).toUpperCase()}${title.slice(1)}` : "";
}

function generatedTabTitleFromPrompt(message) {
  const line = String(message || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("```"));
  if (!line) return "";

  const cleaned = line
    .replace(/https?:\/\/\S+/gi, "link")
    .replace(/^\/+/, "")
    .replace(/[-_]+/g, " ")
    .replace(/[`*_~#>{}\[\]()<>'"“”‘’,;:!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/i, "")
    .replace(/^(?:please\s+)?(?:help\s+me\s+|i\s+(?:need|want)\s+(?:you\s+to\s+)?)/i, "")
    .replace(/^(?:for|in|on)\s+the\s+/i, "");
  if (!cleaned) return "";

  const words = cleaned.split(/\s+/).map((word) => word.replace(/^[^\w]+|[^\w]+$/g, "")).filter(Boolean);
  const meaningfulWords = words.filter((word) => !AUTO_TAB_TITLE_STOP_WORDS.has(word.toLowerCase()));
  const selectedWords = (meaningfulWords.length >= 3 ? meaningfulWords : words).slice(0, AUTO_TAB_TITLE_WORD_LIMIT);
  return truncateTabTitle(titleCaseTabTitle(selectedWords.join(" ")), AUTO_TAB_TITLE_DISPLAY_MAX_LENGTH);
}

function uniqueTabTitle(title, currentTab, maxLength = AUTO_TAB_TITLE_MAX_LENGTH) {
  const base = truncateTabTitle(title, maxLength);
  if (!base) return "";
  const existing = new Set([...tabs.values()].filter((tab) => tab.id !== currentTab?.id).map((tab) => tab.title));
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix++) {
    const suffixText = ` ${suffix}`;
    const candidate = `${truncateTabTitle(base, Math.max(1, maxLength - suffixText.length))}${suffixText}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${truncateTabTitle(base, Math.max(1, maxLength - 4))} ${currentTab?.index || 1}`;
}

const eventHistory = [];

function truncateStatusText(value, maxLength = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function statusEventSummary(event) {
  const summary = {
    timestamp: new Date().toISOString(),
    type: String(event?.type || "event"),
  };
  for (const key of ["id", "tabId", "tabTitle", "previousTabTitle", "titleSource", "pid", "cwd", "code", "signal", "command", "method", "replayed", "queueLength", "pendingMessageCount", "pendingExtensionUiRequestCount"]) {
    if (event?.[key] !== undefined) summary[key] = event[key];
  }
  if (event?.assistantMessageEvent?.type) summary.updateType = event.assistantMessageEvent.type;
  if (event?.message?.role) summary.messageRole = event.message.role;
  if (event?.error) summary.error = truncateStatusText(event.error);
  if (event?.text && summary.type === "pi_stderr") summary.text = truncateStatusText(event.text);
  return summary;
}

function deltaHistorySummary(event) {
  const update = event?.assistantMessageEvent;
  if (event?.type !== "message_update" || !update || typeof update !== "object" || !["text_delta", "thinking_delta", "toolcall_delta"].includes(update.type) || typeof update.delta !== "string") return null;
  return {
    type: "message_update",
    firstTimestamp: new Date().toISOString(),
    lastTimestamp: new Date().toISOString(),
    tabId: event.tabId,
    updateType: update.type,
    contentIndex: update.contentIndex ?? event.contentIndex ?? null,
    deltaCount: 1,
    deltaChars: update.delta.length,
    deltaUtf8Bytes: Buffer.byteLength(update.delta),
  };
}

function recordEvent(event) {
  const delta = deltaHistorySummary(event);
  const previous = eventHistory.at(-1);
  if (delta && previous?.type === delta.type && previous.tabId === delta.tabId && previous.updateType === delta.updateType && previous.contentIndex === delta.contentIndex && Number.isInteger(previous.deltaCount)) {
    previous.lastTimestamp = delta.lastTimestamp;
    previous.deltaCount += delta.deltaCount;
    previous.deltaChars += delta.deltaChars;
    previous.deltaUtf8Bytes += delta.deltaUtf8Bytes;
  } else {
    eventHistory.push(delta || statusEventSummary(event));
  }
  if (eventHistory.length > EVENT_HISTORY_LIMIT) eventHistory.splice(0, eventHistory.length - EVENT_HISTORY_LIMIT);
}

function latestEvents(limit = 40) {
  return eventHistory.slice(-Math.max(0, Math.min(EVENT_HISTORY_LIMIT, limit)));
}

function runCommand(command, args, { cwd, timeoutMs = 2000, maxOutputLength = 20000, env = {}, input, utf8Output = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      // LC_ALL=C keeps tool output in English so error classification works
      // regardless of locale.
      env: { ...process.env, ...env, LC_ALL: "C" },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (utf8Output) child.stdout.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdoutTruncated, ...result });
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exitCode: undefined, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > maxOutputLength) {
        stdout = stdout.slice(-maxOutputLength);
        stdoutTruncated = true;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > maxOutputLength) stderr = stderr.slice(-maxOutputLength);
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    child.on("error", (error) => {
      const message = formatCommandSpawnError(command, error);
      finish({ exitCode: undefined, stdout, stderr: message, error: message, errorCode: error?.code });
    });
    // "close", not "exit": exit can fire before the stdio pipes flush, which
    // intermittently truncates stdout (empty `git rev-parse --show-toplevel`
    // output resolves to process.cwd() and reads the wrong repository).
    child.on("close", (exitCode) => finish({ exitCode, stdout, stderr, timedOut: false }));
  });
}

function nodeModulesParentForPackageRoot(root = packageRoot) {
  return packageOwnerRoot(root);
}

function packageNodeModulesPath(nodeModulesRoot, packageName) {
  return path.join(nodeModulesRoot, ...String(packageName).split("/").filter(Boolean));
}

function prependNodePathEntries(entries) {
  const existing = String(process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean);
  const seen = new Set();
  const next = [];
  for (const entry of [...entries, ...existing]) {
    if (!entry) continue;
    const normalized = path.resolve(entry);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(normalized);
  }
  if (next.length) process.env.NODE_PATH = next.join(path.delimiter);
}

async function configureDevDependencyResolution() {
  if (!webuiDevServer) return;
  const workspaceRoot = await devWorkspaceRoot();
  prependNodePathEntries([
    workspaceRoot ? path.join(workspaceRoot, "node_modules") : "",
    path.join(packageRoot, "node_modules"),
    path.join(configuredAgentNpmRoot(), "node_modules"),
  ]);
}

function declaredDependencySpec(pkg, packageName) {
  return firstDefined(
    pkg?.dependencies?.[packageName],
    pkg?.optionalDependencies?.[packageName],
    pkg?.devDependencies?.[packageName],
    pkg?.peerDependencies?.[packageName],
  );
}

function configuredAgentNpmRoot() {
  const root = process.env.PI_CODING_AGENT_DIR ? path.resolve(expandUserPath(process.env.PI_CODING_AGENT_DIR)) : agentDir;
  return path.join(root, "npm");
}

function minimumPackageVersionFromSpec(spec) {
  const match = String(spec || "").match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match?.[0] || "";
}

function packageVersionBelowSpec(currentVersion, spec) {
  const minimum = minimumPackageVersionFromSpec(spec);
  return !!(currentVersion && minimum && isNewerPackageVersion(minimum, currentVersion));
}

function formatCommandForDisplay(command, args) {
  return [command, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

async function npmGlobalNodeModulesRoot() {
  const invocation = resolveNpmCommandInvocation(["root", "-g"]);
  const result = await runCommand(invocation.command, invocation.args, { timeoutMs: 10_000, maxOutputLength: 8_000 });
  if (result.exitCode !== 0 || result.timedOut || result.error) return null;
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || null;
}

async function bunGlobalNodeModulesRoots() {
  const available = await runCommand("bun", ["--version"], { timeoutMs: 10_000, maxOutputLength: 2_000 });
  if (available.exitCode !== 0 || available.timedOut || available.error) return [];
  const roots = new Set([path.join(homedir(), ".bun", "install", "global", "node_modules")]);
  const binResult = await runCommand("bun", ["pm", "bin", "-g"], { timeoutMs: 10_000, maxOutputLength: 8_000 });
  if (binResult.exitCode === 0 && !binResult.timedOut && !binResult.error) {
    const binDir = binResult.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (binDir) roots.add(path.join(path.dirname(binDir), "install", "global", "node_modules"));
  }
  return [...roots];
}

let optionalPackageNodeModulesRootsCache = null;
async function optionalPackageNodeModulesRoots() {
  if (optionalPackageNodeModulesRootsCache) return optionalPackageNodeModulesRootsCache;
  const roots = [];
  const seen = new Set();
  const add = (root) => {
    if (!root) return;
    const normalized = path.resolve(root);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    roots.push(normalized);
  };
  const configuredRoot = process.env[OPTIONAL_FEATURE_INSTALL_ROOT_ENV];
  if (configuredRoot) add(path.join(path.resolve(expandUserPath(configuredRoot)), "node_modules"));
  add(path.join(packageRoot, "node_modules"));
  add(path.join(nodeModulesParentForPackageRoot(packageRoot), "node_modules"));
  add(path.join(configuredAgentNpmRoot(), "node_modules"));
  const npmGlobalRoot = await npmGlobalNodeModulesRoot();
  if (npmGlobalRoot) add(npmGlobalRoot);
  for (const bunRoot of await bunGlobalNodeModulesRoots()) add(bunRoot);
  optionalPackageNodeModulesRootsCache = roots;
  return roots;
}

async function optionalPackageCandidateRoots(packageName) {
  return (await optionalPackageNodeModulesRoots()).map((root) => packageNodeModulesPath(root, packageName));
}

async function resolveInstalledPackageRoot(packageName) {
  const workspaceRoot = await workspacePackageRootForName(packageName);
  if (workspaceRoot) return workspaceRoot;
  for (const candidate of await optionalPackageCandidateRoots(packageName)) {
    if (await directoryExists(candidate)) return candidate;
  }
  return null;
}

async function resolveInstalledPackageSubpath(packageName, subpath = "") {
  const root = await resolveInstalledPackageRoot(packageName);
  if (!root) return null;
  const candidate = path.join(root, subpath || "");
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function npmPackageNameFromPiSource(source) {
  const spec = String(source || "").trim();
  if (!spec.startsWith("npm:")) return "";
  const npmSpec = spec.slice("npm:".length);
  if (!npmSpec) return "";
  if (npmSpec.startsWith("@")) {
    const slashIndex = npmSpec.indexOf("/");
    if (slashIndex < 2) return "";
    const versionIndex = npmSpec.indexOf("@", slashIndex);
    return versionIndex === -1 ? npmSpec : npmSpec.slice(0, versionIndex);
  }
  const versionIndex = npmSpec.indexOf("@");
  return versionIndex === -1 ? npmSpec : npmSpec.slice(0, versionIndex);
}

async function configuredOptionalFeaturePackages(packageName, cwd = options.cwd) {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const matches = [];
  for (const configuredPackage of packageManager.listConfiguredPackages()) {
    if (npmPackageNameFromPiSource(configuredPackage.source) === packageName) {
      matches.push(configuredPackage);
      continue;
    }
    const manifest = configuredPackage.installedPath
      ? await readJsonFileIfExists(path.join(configuredPackage.installedPath, "package.json"))
      : null;
    if (manifest?.name === packageName) matches.push(configuredPackage);
  }
  return matches;
}

async function topLevelOptionalFeatureResourceIndex(cwd = options.cwd) {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await packageManager.resolve(async () => "skip");
  const resourcesByPackage = new Map();
  for (const resourceType of ["extensions", "skills", "prompts", "themes"]) {
    for (const resource of resolved[resourceType] || []) {
      if (!resource.enabled || resource.metadata?.origin === "package") continue;
      let ownershipPath = resource.path;
      try {
        ownershipPath = await realpath(resource.path);
      } catch {
        // Keep the reported path when the resource disappears during status collection.
      }
      const packageName = await packageNameForResourcePath(ownershipPath);
      if (!packageName) continue;
      const resourcePaths = resourcesByPackage.get(packageName) || [];
      resourcePaths.push(resource.path);
      resourcesByPackage.set(packageName, resourcePaths);
    }
  }
  return resourcesByPackage;
}

async function topLevelOptionalFeatureResources(packageName, cwd = options.cwd, resourceIndex) {
  const resourcesByPackage = resourceIndex || await topLevelOptionalFeatureResourceIndex(cwd);
  return [...new Set(resourcesByPackage.get(packageName) || [])];
}

async function installedOptionalFeatureRoot(packageName, configuredPackages) {
  const discoveredRoot = await resolveInstalledPackageRoot(packageName);
  const candidates = [discoveredRoot, ...configuredPackages.map(({ installedPath }) => installedPath)].filter(Boolean);
  for (const candidate of candidates) {
    const manifest = await readJsonFileIfExists(path.join(candidate, "package.json"));
    if (manifest?.name === packageName) return candidate;
  }
  return null;
}

async function optionalFeaturePackageStatus(featureId, cwd = options.cwd, topLevelResourceIndex) {
  const feature = OPTIONAL_FEATURE_BY_ID.get(featureId);
  if (!feature) throw makeHttpError(400, `Unknown optional feature: ${featureId}`);
  const { packageName, expectedSpec } = feature;
  const [configuredPackages, topLevelResources] = await Promise.all([
    configuredOptionalFeaturePackages(packageName, cwd),
    topLevelOptionalFeatureResources(packageName, cwd, topLevelResourceIndex),
  ]);
  const installedRoot = await installedOptionalFeatureRoot(packageName, configuredPackages);
  const manifest = installedRoot ? await readJsonFileIfExists(path.join(installedRoot, "package.json")) : null;
  const installedVersion = typeof manifest?.version === "string" ? manifest.version : "";
  const installed = !!installedRoot;
  const configured = configuredPackages.length > 0;
  const locallyConfigured = topLevelResources.length > 0;
  const legacyRoot = path.join(packageRoot, "node_modules", ...packageName.split("/"));
  const legacyManifest = await readJsonFileIfExists(path.join(legacyRoot, "package.json"));
  const legacyEvidence = legacyManifest?.name === packageName;
  const disabled = configuredPackages.length > 0 && configuredPackages.every((entry) => entry.enabled === false);
  const resourceConflict = configured && locallyConfigured;
  const ready = installed && (configured || locallyConfigured) && !resourceConflict;
  const updateAvailable = !!(installedVersion && packageVersionBelowSpec(installedVersion, expectedSpec));
  return {
    featureId,
    packageName,
    expectedSpec,
    declaredSpec: expectedSpec,
    installed,
    configured,
    locallyConfigured,
    resourceConflict,
    ready,
    installedVersion,
    installedRoot,
    topLevelResources,
    legacyEvidence,
    disabled,
    updateAvailable,
    updateReason: updateAvailable ? `installed ${installedVersion} is older than Web UI expects (${expectedSpec})` : "",
  };
}

async function optionalFeaturePackageStatuses(cwd = options.cwd) {
  const features = [];
  const topLevelResourceIndex = await topLevelOptionalFeatureResourceIndex(cwd);
  for (const { featureId } of OPTIONAL_FEATURE_CATALOG) {
    features.push(await optionalFeaturePackageStatus(featureId, cwd, topLevelResourceIndex));
  }
  return { features };
}

function optionalFeatureInstallOutputTail(result, maxLength = 4000) {
  const text = stripAnsi([result?.stderr, result?.stdout].filter(Boolean).join("\n").trim());
  if (text.length <= maxLength) return text;
  return `…${text.slice(-Math.max(0, maxLength - 1))}`;
}

function optionalFeatureInstallFailureKind(result, message = "") {
  const combined = `${message}\n${result?.error || ""}\n${result?.stderr || ""}\n${result?.stdout || ""}`;
  if (result?.timedOut) return "timeout";
  if (/\b(?:ENOENT|command not found|not recognized|spawn\s+\S+\s+ENOENT)\b/i.test(combined)) return "pi-not-found";
  if (/\b(?:EACCES|EPERM|permission denied|access denied)\b/i.test(combined)) return "permission";
  if (/\b(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|network timeout|registry\.npmjs\.org|fetch failed)\b/i.test(combined)) return "network";
  return "pi-exit";
}

function optionalFeatureInstallFailureHint(kind, { command } = {}) {
  switch (kind) {
    case "pi-not-found":
      return "The selected Pi CLI could not be started. Check --pi or PI_WEBUI_PI_BIN, then restart the Web UI.";
    case "permission":
      return "Pi could not update its user package root or settings. Retry as the owning user or run the copied command manually.";
    case "network":
      return "Pi could not reach the npm registry reliably. Check network/proxy/registry settings, then retry or run the copied command manually.";
    case "timeout":
      return "Pi did not finish within 5 minutes. Check for a stuck package manager, lock contention, or slow network, then retry manually.";
    case "local-resource-conflict":
      return "This companion is already enabled as a top-level Pi resource. Keep that local resource, or disable/remove its extensions/skills/prompts/themes alias before registering the npm package.";
    case "status-check":
      return "Pi finished, but Web UI could not verify both installation and registration. Reload the Web UI and recheck Optional features.";
    default:
      return command ? "Run the copied Pi command manually on the Web UI host to see full diagnostics." : "Check the activity log and Pi output, then retry.";
  }
}

function makeOptionalFeatureInstallError(statusCode, message, details = {}) {
  const error = makeHttpError(statusCode, message);
  error.optionalFeatureInstall = {
    kind: details.kind || "unknown",
    featureId: details.featureId || "",
    packageName: details.packageName || "",
    installRoot: details.installRoot || "",
    command: details.command || "",
    exitCode: details.exitCode,
    timedOut: details.timedOut === true,
    message,
    hint: details.hint || optionalFeatureInstallFailureHint(details.kind, details),
    outputTail: details.outputTail || "",
  };
  return error;
}

async function installOptionalFeaturePackage(featureId, cwd = options.cwd) {
  await assertNativeMutationAdmission();
  const beforeStatus = await optionalFeaturePackageStatus(featureId, cwd);
  const packageName = beforeStatus.packageName;
  const source = `npm:${packageName}`;
  if (beforeStatus.locallyConfigured) {
    const message = beforeStatus.resourceConflict
      ? `${packageName} is configured both as a Pi package and as a top-level resource; installing it again would preserve the duplicate-load conflict`
      : `${packageName} is already enabled as a top-level Pi resource; installing the npm package would load it twice`;
    throw makeOptionalFeatureInstallError(409, message, {
      kind: "local-resource-conflict",
      featureId,
      packageName,
      command: `pi install ${source}`,
      hint: optionalFeatureInstallFailureHint("local-resource-conflict"),
    });
  }
  const piCommand = await resolvePiCommand(["install", source]);
  await assertNativeMutationAdmission();
  const command = piCommand.displayCommand;
  const result = await runCommand(piCommand.command, piCommand.args, {
    cwd,
    timeoutMs: 5 * 60 * 1000,
    maxOutputLength: 80000,
  });
  const ok = result.exitCode === 0 && !result.timedOut && !result.error;
  if (!ok) {
    const kind = optionalFeatureInstallFailureKind(result);
    const message = result.timedOut
      ? `Optional feature install timed out after 5 minutes: ${command}`
      : result.error
        ? `Optional feature install could not start: ${command}`
        : `Optional feature install failed with exit code ${result.exitCode ?? "unknown"}: ${command}`;
    throw makeOptionalFeatureInstallError(result.timedOut ? 504 : 500, message, {
      kind,
      featureId,
      packageName,
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outputTail: optionalFeatureInstallOutputTail(result),
    });
  }

  let afterStatus;
  try {
    afterStatus = await optionalFeaturePackageStatus(featureId, cwd);
    if (!afterStatus.ready) {
      throw new Error(`Pi did not leave ${packageName} both installed and registered`);
    }
  } catch (error) {
    const message = `Optional feature install finished, but status verification failed: ${formatCliError(error)}`;
    throw makeOptionalFeatureInstallError(error?.statusCode || 500, message, {
      kind: "status-check",
      featureId,
      packageName,
      command,
      outputTail: optionalFeatureInstallOutputTail(result),
    });
  }

  const operation = beforeStatus.ready ? "Updated" : beforeStatus.installed ? "Registered" : "Installed";
  return {
    featureId,
    packageName,
    source,
    command,
    stdout: result.stdout,
    stderr: result.stderr,
    status: afterStatus,
    message: `${operation} optional feature package ${packageName}${afterStatus.installedVersion ? ` at ${afterStatus.installedVersion}` : ""} with Pi. Reload the active Pi thread to load new resources.`,
  };
}

function validateOptionalFeatureBatch(featureIds) {
  if (!Array.isArray(featureIds)) throw makeHttpError(400, "featureIds must be an array");
  if (featureIds.length > OPTIONAL_FEATURE_CATALOG.length) {
    throw makeHttpError(400, `featureIds must contain at most ${OPTIONAL_FEATURE_CATALOG.length} entries`);
  }
  const deduplicated = [];
  const seen = new Set();
  for (const value of featureIds) {
    if (typeof value !== "string" || !OPTIONAL_FEATURE_BY_ID.has(value)) {
      throw makeHttpError(400, `Unknown optional feature: ${String(value || "")}`);
    }
    if (seen.has(value)) continue;
    seen.add(value);
    deduplicated.push(value);
  }
  return deduplicated;
}

async function installOptionalFeaturePackages(featureIds, cwd = options.cwd) {
  const requestedFeatureIds = validateOptionalFeatureBatch(featureIds);
  const results = [];
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const migration = optionalFeatureAuditCoordinator.current().progress?.migration === true;
  let index = 0;
  for (const featureId of requestedFeatureIds) {
    const packageName = OPTIONAL_FEATURE_BY_ID.get(featureId)?.packageName || "";
    optionalFeatureAuditCoordinator.setProgress({
      phase: "migrating",
      migration,
      startedAt,
      elapsedMs: Date.now() - startedAtMs,
      currentFeatureId: featureId,
      currentPackageName: packageName,
      index: index + 1,
      total: requestedFeatureIds.length,
      completed: index,
      remaining: requestedFeatureIds.length - index,
      results: results.map(optionalFeatureProgressResult),
    });
    try {
      results.push({ ok: true, featureId, data: await installOptionalFeaturePackage(featureId, cwd) });
    } catch (error) {
      results.push({
        ok: false,
        featureId,
        packageName,
        error: formatCliError(error),
        optionalFeatureInstall: error?.optionalFeatureInstall || null,
      });
    }
    index++;
  }
  const succeeded = results.filter((result) => result.ok).length;
  return {
    featureIds: requestedFeatureIds,
    results,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
  };
}

function optionalFeatureProgressResult(result) {
  return {
    featureId: result.featureId,
    packageName: result.packageName || result.data?.packageName || "",
    ok: result.ok,
    kind: result.optionalFeatureInstall?.kind || "",
    message: result.ok ? result.data?.message || "Installed and verified" : "Installation failed; see the localhost response for details",
  };
}

async function runOptionalFeatureBatchMutation({ revision, featureIds, cwd = options.cwd, migration = false, tab = null, install = null }) {
  await assertNativeMutationAdmission();
  return optionalFeatureAuditCoordinator.runMutation(revision, async () => {
    optionalFeatureAuditCoordinator.setProgress({ phase: "migrating", migration, startedAt: new Date().toISOString(), completed: 0, remaining: Array.isArray(featureIds) ? featureIds.length : 0, total: Array.isArray(featureIds) ? featureIds.length : 0, results: [] });
    const batch = install ? await install() : await installOptionalFeaturePackages(featureIds, cwd);
    if (migration && batch.failed === 0) await optionalFeatureMigrationStore.completeMigration();
    await optionalFeatureAuditCoordinator.recheck({ reason: migration ? "post-migration" : "post-install" });
    const restart = { autoRestarted: false, restartDeferred: false };
    if (batch.failed === 0 && batch.total > 0 && tab) {
      const busy = tab.activity?.isWorking === true
        || pendingExtensionUiRequests(tab).length > 0
        || (tab.browserPromptRequests?.size || 0) > 0
        || (tab.bashQueue?.length || 0) > 0
        || (tab.compactionQueue?.length || 0) > 0;
      if (busy) {
        restart.restartDeferred = true;
      } else {
        try {
          await restartTabRpc(tab, "optional-feature-migration");
          restart.autoRestarted = true;
        } catch (error) {
          restart.restartDeferred = true;
          restart.reason = error?.statusCode === 409 ? "tab-busy" : "restart-failed";
        }
      }
      broadcastTabEvent(tab, {
        type: restart.autoRestarted ? "webui_optional_feature_restart_completed" : "webui_optional_feature_restart_deferred",
        tabId: tab.id,
        tabTitle: tab.title,
        ...restart,
      });
    }
    batch.restart = restart;
    optionalFeatureAuditCoordinator.setProgress({
      phase: batch.failed ? "partial" : "complete",
      migration,
      completedAt: new Date().toISOString(),
      currentFeatureId: null,
      currentPackageName: null,
      index: batch.total,
      total: batch.total,
      completed: batch.total,
      remaining: 0,
      succeeded: batch.succeeded,
      failed: batch.failed,
      results: batch.results.map(optionalFeatureProgressResult),
      ...restart,
    });
    return batch;
  });
}

function displayPath(cwd) {
  const normalized = cwd.replace(/\\/g, "/");
  const home = (process.env.USERPROFILE || process.env.HOME || "").replace(/\\/g, "/");
  if (home && normalized.toLowerCase().startsWith(home.toLowerCase())) {
    return `~${normalized.slice(home.length)}` || "~";
  }
  return normalized;
}

function expandUserPath(value) {
  const input = String(value || "").trim();
  if (input === "~") {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) throw makeHttpError(400, "Cannot expand ~ because no home directory is configured");
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) throw makeHttpError(400, "Cannot expand ~ because no home directory is configured");
    return path.join(home, input.slice(2));
  }
  return input;
}

async function resolveCwd(value, baseCwd = options.cwd) {
  const input = expandUserPath(value);
  if (!input) throw makeHttpError(400, "cwd is required");
  const cwd = path.resolve(baseCwd, input);
  let info;
  try {
    info = await stat(cwd);
  } catch {
    throw makeHttpError(400, `cwd does not exist: ${cwd}`);
  }
  if (!info.isDirectory()) throw makeHttpError(400, `cwd is not a directory: ${cwd}`);
  return cwd;
}

function uniquePathItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item?.cwd || seen.has(item.cwd)) continue;
    seen.add(item.cwd);
    result.push(item);
  }
  return result;
}

function normalizePathFastPicks(value) {
  const items = Array.isArray(value) ? value : Array.isArray(value?.picks) ? value.picks : [];
  const seen = new Set();
  const picks = [];
  for (const item of items) {
    const rawCwd = typeof item === "string" ? item : item?.cwd;
    if (!rawCwd) continue;
    let cwd;
    try {
      cwd = path.resolve(options.cwd, expandUserPath(rawCwd));
    } catch {
      continue;
    }
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    const displayCwd = String(typeof item === "object" && item?.displayCwd ? item.displayCwd : displayPath(cwd)).slice(0, 4096);
    picks.push({ cwd, displayCwd });
    if (picks.length >= FAST_PICK_LIMIT) break;
  }
  return picks;
}

function fastPicksStorageFile() {
  if (process.env.PI_WEBUI_FAST_PICKS_FILE) return path.resolve(expandUserPath(process.env.PI_WEBUI_FAST_PICKS_FILE));
  const stateRoot = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(stateRoot, "pi-webui", "fast-picks.json");
}

let pathFastPicksCache = null;

async function readPathFastPicks() {
  if (pathFastPicksCache) return pathFastPicksCache;
  try {
    const parsed = JSON.parse(await readFile(fastPicksStorageFile(), "utf8"));
    pathFastPicksCache = normalizePathFastPicks(parsed);
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`failed to read path fast picks: ${sanitizeError(error)}`);
    pathFastPicksCache = [];
  }
  return pathFastPicksCache;
}

async function writePathFastPicks(picks) {
  const normalized = normalizePathFastPicks(picks);
  const storageFile = fastPicksStorageFile();
  await mkdir(path.dirname(storageFile), { recursive: true });
  const tmpFile = `${storageFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify({ version: 1, picks: normalized }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpFile, storageFile);
  pathFastPicksCache = normalized;
  return normalized;
}

async function readPersistedRemoteAuthEnabled() {
  return (await readWebuiSettings()).remoteAuthEnabled === true;
}

async function saveRemoteAuthPreference(enabled) {
  const nextEnabled = enabled === true;
  await writeWebuiSettings({ remoteAuthEnabled: nextEnabled });
  persistedRemoteAuthEnabled = nextEnabled;
  return persistedRemoteAuthEnabled;
}

const WORKFLOW_POLICY_MODULE_API = ["readWorkflowPolicyState", "writeWorkflowPolicyState"];
// Advisory draft catalog owned by the workflow package; the browser never invents suggestions.
const WORKFLOW_POLICY_MODULE_CATALOG_API = ["WORKFLOW_POLICY_SUGGESTIONS"];
let workflowPolicyModulePromise;

async function workflowPolicyModule() {
  if (!workflowPolicyModulePromise) {
    workflowPolicyModulePromise = (async () => {
      const specifiers = [
        "@firstpick/pi-extension-workflows/src/workflow-policy.mjs",
        new URL("../../pi-extension-workflows/src/workflow-policy.mjs", import.meta.url).href,
      ];
      const failures = [];
      for (const specifier of specifiers) {
        try {
          const module = await import(specifier);
          const missing = [
            ...WORKFLOW_POLICY_MODULE_API.filter((name) => typeof module?.[name] !== "function"),
            ...WORKFLOW_POLICY_MODULE_CATALOG_API.filter((name) => !module?.[name] || typeof module[name] !== "object" || Array.isArray(module[name])),
          ];
          if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
          return module;
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      throw makeHttpError(503, `Workflow policy setup support is unavailable. Install or update @firstpick/pi-extension-workflows and restart Web UI. ${failures.at(-1) || ""}`.trim());
    })().catch((error) => {
      workflowPolicyModulePromise = undefined;
      throw error;
    });
  }
  return workflowPolicyModulePromise;
}

function requireWorkflowPolicyJsonRequest(req) {
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw makeHttpError(415, "Workflow policy saves require Content-Type: application/json.");
  const fetchSite = String(req.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw makeHttpError(403, "Cross-origin workflow policy saves are blocked.");
  }
}

function requireSessionSummaryJsonRequest(req) {
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw makeHttpError(415, "Session summary changes require Content-Type: application/json.");
  const fetchSite = String(req.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw makeHttpError(403, "Cross-origin session summary changes are blocked.");
  }
}

function workflowPolicySaveBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw makeHttpError(400, "Workflow policy save body must be an object with only policy and expectedRevision.");
  }
  const allowedFields = new Set(["policy", "expectedRevision"]);
  const unknownFields = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unknownFields.length) {
    throw makeHttpError(400, `Workflow policy save body contains unsupported field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}.`);
  }
  if (!Object.prototype.hasOwnProperty.call(body, "policy") || !Object.prototype.hasOwnProperty.call(body, "expectedRevision")) {
    throw makeHttpError(400, "Workflow policy save body requires policy and expectedRevision.");
  }
  if (body.expectedRevision !== null && typeof body.expectedRevision !== "string") {
    throw makeHttpError(400, "expectedRevision must be a read revision string or null for a missing policy.");
  }
  return body;
}

function workflowPolicyRequestError(error) {
  if (error?.statusCode) return error;
  if (error?.code === "WORKFLOW_POLICY_INVALID") return makeHttpError(400, formatCliError(error));
  if (error?.code === "WORKFLOW_POLICY_STALE_REVISION") return makeHttpError(409, formatCliError(error));
  if (error?.code === "WORKFLOW_POLICY_UNSAFE_TARGET") return makeHttpError(409, formatCliError(error));
  if (error instanceof TypeError) return makeHttpError(400, formatCliError(error));
  return error;
}

function ensureWorkflowPolicyMutationAllowed() {
  // The policy is global, so any active Natural Conversation tab blocks a global mutation.
  for (const tab of tabs.values()) ensureNaturalConversationRouteAllowed(tab, "workflow policy changes are blocked");
}

let safetyGuardConfigModulePromise;

async function safetyGuardConfigModule() {
  if (!safetyGuardConfigModulePromise) {
    safetyGuardConfigModulePromise = (async () => {
      const specifiers = [
        "@firstpick/pi-extension-safety-guard/src/config.mjs",
        new URL("../../pi-extension-safety-guard/src/config.mjs", import.meta.url).href,
      ];
      const failures = [];
      const requiredExports = [
        "SAFETY_GUARD_CATEGORIES",
        "SAFETY_GUARD_CONTEXT_LINES_MAX",
        "SAFETY_GUARD_CONTEXT_LINES_MIN",
        "SAFETY_GUARD_CONFIG_VERSION",
        "SAFETY_GUARD_THINKING_LEVELS",
        "assertSafetyGuardConfigPatch",
        "defaultSafetyGuardConfig",
        "mergeSafetyGuardConfig",
        "readSafetyGuardConfig",
        "safetyGuardConfigFile",
        "writeSafetyGuardConfig",
      ];
      for (const specifier of specifiers) {
        try {
          const module = await import(specifier);
          const missing = requiredExports.filter((name) => module[name] === undefined);
          if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
          return module;
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      throw makeHttpError(503, `Safety guard setup support is unavailable. Update @firstpick/pi-extension-safety-guard and restart Web UI. ${failures.at(-1) || ""}`.trim());
    })().catch((error) => {
      safetyGuardConfigModulePromise = undefined;
      throw error;
    });
  }
  return safetyGuardConfigModulePromise;
}

function safetyGuardModelKey(model) {
  return model?.provider && model?.id ? `${model.provider}/${model.id}` : "";
}

async function safetyGuardConfigData(tab, { config: suppliedConfig, models: suppliedModels } = {}) {
  const settingsModule = await safetyGuardConfigModule();
  const config = suppliedConfig || settingsModule.readSafetyGuardConfig();
  const models = suppliedModels || await availableGitWorkflowModels(tab);
  return {
    config,
    defaults: settingsModule.defaultSafetyGuardConfig(),
    categories: [...settingsModule.SAFETY_GUARD_CATEGORIES],
    contextLines: {
      min: settingsModule.SAFETY_GUARD_CONTEXT_LINES_MIN,
      max: settingsModule.SAFETY_GUARD_CONTEXT_LINES_MAX,
    },
    models,
    modelThinkingLevels: Object.fromEntries(models.map((model) => [
      safetyGuardModelKey(model),
      supportedGitWorkflowThinkingLevels(model),
    ])),
    thinkingLevels: [...settingsModule.SAFETY_GUARD_THINKING_LEVELS],
    version: settingsModule.SAFETY_GUARD_CONFIG_VERSION,
    path: settingsModule.safetyGuardConfigFile(),
  };
}

async function saveSafetyGuardConfigData(tab, body = {}) {
  const settingsModule = await safetyGuardConfigModule();
  const submitted = body.config && typeof body.config === "object" ? body.config : body;
  try {
    settingsModule.assertSafetyGuardConfigPatch(submitted);
  } catch (error) {
    throw makeHttpError(400, error instanceof Error ? error.message : String(error));
  }

  const next = settingsModule.mergeSafetyGuardConfig(settingsModule.readSafetyGuardConfig(), submitted);
  let models;
  if (next.autoReview.enabled) {
    models = await availableGitWorkflowModels(tab);
    const provider = next.autoReview.model.provider;
    const modelId = next.autoReview.model.modelId;
    const model = models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
    if (!model) throw makeHttpError(400, `Selected auto-review model is not currently available: ${provider || "unset"}/${modelId || "unset"}`);
    const supportedLevels = supportedGitWorkflowThinkingLevels(model);
    if (!supportedLevels.includes(next.autoReview.model.thinkingLevel)) {
      throw makeHttpError(400, `${provider}/${modelId} does not support thinking level ${next.autoReview.model.thinkingLevel}`);
    }
  }

  let config;
  try {
    config = settingsModule.writeSafetyGuardConfig(submitted);
  } catch (error) {
    throw makeHttpError(500, error instanceof Error ? error.message : String(error));
  }
  return safetyGuardConfigData(tab, { config, models });
}

function requireSubagentLaunchSlotScope(value) {
  const scope = String(value || "").trim();
  if (!["user", "project"].includes(scope)) throw makeHttpError(400, "scope must be user or project");
  return scope;
}

async function availableSubagentLaunchSlotModels(tab) {
  const response = await safeRpcData(tab, { type: "get_available_models" });
  if (!response.ok) throw makeHttpError(400, response.error || "Failed to load available models");
  return (Array.isArray(response.data?.models) ? response.data.models : [])
    .filter((model) => subagentLaunchSlotModelKey(model))
    .sort((left, right) => subagentLaunchSlotModelKey(left).localeCompare(subagentLaunchSlotModelKey(right)));
}

async function subagentLaunchSlotProjectContext(tab) {
  const projectKey = await resolveSubagentLaunchSlotProjectKey(tab.cwd);
  return { projectKey, projectLabel: subagentLaunchSlotProjectLabel(projectKey) };
}

function subagentLaunchSlotConfigPayload(settings, scope, project, models, extra = {}) {
  const config = normalizeSubagentLaunchSlots(settings?.subagentLaunchSlots);
  const effective = subagentLaunchSlotScopeEntry(config, scope, project.projectKey);
  return {
    scope,
    projectKey: project.projectKey,
    projectLabel: project.projectLabel,
    inherited: effective.inherited,
    revision: subagentLaunchSlotRevision(config, scope, project.projectKey),
    roles: effective.entry.roles,
    roleMetadata: SUBAGENT_LAUNCH_SLOT_ROLE_CATALOG,
    models,
    modelThinkingLevels: Object.fromEntries(models.map((model) => [
      subagentLaunchSlotModelKey(model),
      supportedSubagentLaunchSlotThinkingLevels(model),
    ])),
    limits: SUBAGENT_LAUNCH_SLOT_LIMITS,
    thinkingLevels: SUBAGENT_LAUNCH_SLOT_THINKING_LEVELS,
    reloadRequired: false,
    ...extra,
  };
}

async function subagentLaunchSlotConfigData(tab, requestedScope) {
  const scope = requireSubagentLaunchSlotScope(requestedScope);
  const [settings, models, project] = await Promise.all([
    readWebuiSettings(),
    availableSubagentLaunchSlotModels(tab),
    subagentLaunchSlotProjectContext(tab),
  ]);
  return subagentLaunchSlotConfigPayload(settings, scope, project, models);
}

async function saveSubagentLaunchSlotConfigData(tab, body = {}) {
  const scope = requireSubagentLaunchSlotScope(body.scope);
  const revision = typeof body.revision === "string" ? body.revision.trim() : "";
  if (!revision || revision.length > 128) throw makeHttpError(400, "revision is required");
  const inherit = body.inherit === true;
  if (inherit && scope !== "project") throw makeHttpError(400, "inherit is only supported for project scope");

  const [models, project] = await Promise.all([
    availableSubagentLaunchSlotModels(tab),
    subagentLaunchSlotProjectContext(tab),
  ]);
  let roles;
  if (!inherit) {
    try {
      roles = validateSubagentLaunchSlotRoles(body.roles, models);
    } catch (error) {
      throw makeHttpError(400, error instanceof Error ? error.message : String(error));
    }
  }

  let changed = false;
  const settings = await updateWebuiSettings((currentSettings) => {
    const config = normalizeSubagentLaunchSlots(currentSettings.subagentLaunchSlots);
    const currentRevision = subagentLaunchSlotRevision(config, scope, project.projectKey);
    if (currentRevision !== revision) {
      throw makeHttpError(409, "Subagent launch-slot configuration changed; reload it before saving.");
    }

    const nextConfig = normalizeSubagentLaunchSlots(config);
    if (scope === "user") {
      nextConfig.user = { roles };
    } else if (inherit) {
      delete nextConfig.projects[project.projectKey];
    } else {
      nextConfig.projects[project.projectKey] = { roles };
    }
    const before = scope === "user" ? config.user : config.projects[project.projectKey] || null;
    const after = scope === "user" ? nextConfig.user : nextConfig.projects[project.projectKey] || null;
    changed = JSON.stringify(before) !== JSON.stringify(after);
    return changed ? { subagentLaunchSlots: nextConfig } : undefined;
  });

  return subagentLaunchSlotConfigPayload(settings, scope, project, models, {
    saved: true,
    changed,
    reloadRequired: changed,
  });
}

function gitWorkflowModelKey(model) {
  return model?.provider && model?.id ? `${model.provider}/${model.id}` : "";
}

async function availableGitWorkflowModels(tab) {
  const response = await safeRpcResponse(tab, { type: "get_available_models" });
  if (response.success === false) throw makeHttpError(400, response.error || "Failed to load available models");
  return (Array.isArray(response.data?.models) ? response.data.models : [])
    .filter((model) => model?.provider && model?.id)
    .sort((left, right) => gitWorkflowModelKey(left).localeCompare(gitWorkflowModelKey(right)));
}

function gitWorkflowPreferenceOptions() {
  return {
    thinkingLevels: GIT_WORKFLOW_THINKING_LEVELS,
    languages: GIT_WORKFLOW_LANGUAGES,
    defaultVariants: GIT_WORKFLOW_DEFAULT_VARIANTS,
    scopePolicies: GIT_WORKFLOW_SCOPE_POLICIES,
    stagingPolicies: GIT_WORKFLOW_STAGING_POLICIES,
    deliveryModes: GIT_WORKFLOW_DELIVERY_MODES,
    verificationPolicies: GIT_WORKFLOW_VERIFICATION_POLICIES,
  };
}

async function gitWorkflowPreferencesData(tab, { includeModels = true } = {}) {
  const preferencesPromise = readGitWorkflowPreferences();
  if (!includeModels) {
    const preferences = await preferencesPromise;
    return {
      preferences,
      configured: isGitWorkflowSetupComplete(preferences),
      options: gitWorkflowPreferenceOptions(),
      path: webuiSettingsFile(),
    };
  }
  const [preferences, models] = await Promise.all([
    preferencesPromise,
    availableGitWorkflowModels(tab),
  ]);
  return {
    preferences,
    configured: isGitWorkflowSetupComplete(preferences),
    models,
    modelThinkingLevels: Object.fromEntries(models.map((model) => [gitWorkflowModelKey(model), supportedGitWorkflowThinkingLevels(model)])),
    options: gitWorkflowPreferenceOptions(),
    path: webuiSettingsFile(),
  };
}

function requireGitWorkflowChoice(value, key, choices) {
  const text = String(value ?? "").trim();
  if (!choices.includes(text)) throw makeHttpError(400, `${key} must be one of: ${choices.join(", ")}`);
  return text;
}

function requireGitWorkflowBoolean(value, key) {
  if (typeof value !== "boolean") throw makeHttpError(400, `${key} must be a boolean`);
  return value;
}

async function saveGitWorkflowPreferencesData(tab, body = {}) {
  const submitted = body.preferences && typeof body.preferences === "object" ? body.preferences : body;
  if (submitted.generation?.thinkingLevel !== undefined) requireGitWorkflowChoice(submitted.generation.thinkingLevel, "generation.thinkingLevel", GIT_WORKFLOW_THINKING_LEVELS);
  if (submitted.generation?.fallback?.thinkingLevel !== undefined) requireGitWorkflowChoice(submitted.generation.fallback.thinkingLevel, "generation.fallback.thinkingLevel", GIT_WORKFLOW_THINKING_LEVELS);
  if (submitted.commit?.language !== undefined) requireGitWorkflowChoice(submitted.commit.language, "commit.language", GIT_WORKFLOW_LANGUAGES);
  if (submitted.commit?.defaultVariant !== undefined) requireGitWorkflowChoice(submitted.commit.defaultVariant, "commit.defaultVariant", GIT_WORKFLOW_DEFAULT_VARIANTS);
  if (submitted.commit?.scope !== undefined) requireGitWorkflowChoice(submitted.commit.scope, "commit.scope", GIT_WORKFLOW_SCOPE_POLICIES);
  if (submitted.stagingPolicy !== undefined) requireGitWorkflowChoice(submitted.stagingPolicy, "stagingPolicy", GIT_WORKFLOW_STAGING_POLICIES);
  if (submitted.reviewProcessEnabled !== undefined) requireGitWorkflowBoolean(submitted.reviewProcessEnabled, "reviewProcessEnabled");
  if (submitted.deliveryMode !== undefined) requireGitWorkflowChoice(submitted.deliveryMode, "deliveryMode", GIT_WORKFLOW_DELIVERY_MODES);
  if (submitted.verificationPolicy !== undefined) requireGitWorkflowChoice(submitted.verificationPolicy, "verificationPolicy", GIT_WORKFLOW_VERIFICATION_POLICIES);

  const current = await readGitWorkflowPreferences();
  const next = mergeGitWorkflowPreferences(current, submitted);
  const provider = String(next.generation.provider || "").trim();
  const modelId = String(next.generation.modelId || "").trim();
  if (!provider || !modelId) throw makeHttpError(400, "Select a Git-writing model before saving setup");

  const models = await availableGitWorkflowModels(tab);
  const model = models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
  if (!model) throw makeHttpError(400, `Selected model is not currently available: ${provider}/${modelId}`);
  const supportedLevels = supportedGitWorkflowThinkingLevels(model);
  if (!supportedLevels.includes(next.generation.thinkingLevel)) {
    throw makeHttpError(400, `${provider}/${modelId} does not support thinking level ${next.generation.thinkingLevel}`);
  }

  const fallbackProvider = String(next.generation.fallback?.provider || "").trim();
  const fallbackModelId = String(next.generation.fallback?.modelId || "").trim();
  if (!!fallbackProvider !== !!fallbackModelId) throw makeHttpError(400, "Select both a fallback provider and model, or clear both to disable fallback");
  if (fallbackProvider && fallbackModelId) {
    if (fallbackProvider === provider && fallbackModelId === modelId) throw makeHttpError(400, "The fallback model must be different from the primary Git-writing model");
    const fallbackModel = models.find((candidate) => candidate.provider === fallbackProvider && candidate.id === fallbackModelId);
    if (!fallbackModel) throw makeHttpError(400, `Selected fallback model is not currently available: ${fallbackProvider}/${fallbackModelId}`);
    const fallbackSupportedLevels = supportedGitWorkflowThinkingLevels(fallbackModel);
    if (!fallbackSupportedLevels.includes(next.generation.fallback.thinkingLevel)) {
      throw makeHttpError(400, `${fallbackProvider}/${fallbackModelId} does not support fallback thinking level ${next.generation.fallback.thinkingLevel}`);
    }
  }

  await writeGitWorkflowPreferences(next);
  return gitWorkflowPreferencesData(tab);
}

function sessionSummaryModelKey(model) {
  return model?.provider && model?.id ? `${model.provider}/${model.id}` : "";
}

async function availableSessionSummaryModels(tab) {
  const models = await availableGitWorkflowModels(tab);
  return models.map((model) => ({
    provider: model.provider,
    id: model.id,
    ...(model.name ? { name: String(model.name).slice(0, 240) } : {}),
    reasoning: model.reasoning === true,
    ...(model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
  }));
}

function publicSessionSummaryPreferences(value) {
  return {
    version: 1,
    configured: value?.configured === true,
    enabled: value?.enabled === true,
    model: {
      provider: String(value?.model?.provider || ""),
      modelId: String(value?.model?.modelId || ""),
      thinkingLevel: String(value?.model?.thinkingLevel || "off"),
    },
    prompts: {
      title: String(value?.prompts?.title || "").slice(0, SESSION_SUMMARY_PROMPT_MAX_CHARS),
      summary: String(value?.prompts?.summary || "").slice(0, SESSION_SUMMARY_PROMPT_MAX_CHARS),
    },
    input: { scope: "text-and-tool-names" },
    context: { injectLatest: value?.context?.injectLatest === true },
    title: {
      enabled: value?.title?.enabled !== false,
      minSettledTurns: Number.isInteger(value?.title?.minSettledTurns) ? value.title.minSettledTurns : 3,
    },
  };
}

async function sessionSummaryPreferencesData(tab) {
  const [storedPreferences, models] = await Promise.all([
    readSessionSummaryPreferences(),
    availableSessionSummaryModels(tab),
  ]);
  return {
    version: SESSION_SUMMARY_PROTOCOL_VERSION,
    preferences: publicSessionSummaryPreferences(storedPreferences),
    models,
    modelThinkingLevels: Object.fromEntries(models.map((model) => [sessionSummaryModelKey(model), supportedSessionSummaryThinkingLevels(model)])),
    disclosure: {
      scope: "Active-branch user text, final assistant text, and tool names only. Thinking, images, tool arguments/results, credentials, and prior summary messages are excluded.",
      cost: "Automatic generation makes one request to the selected model after each eligible settled refresh. There is no provider fallback or automatic provider retry.",
      persistence: "Preferences and generated output are stored locally. Main-agent context injection is off unless explicitly enabled.",
    },
    summary: publicSessionSummaryState(tab),
  };
}

function requiredSessionSummaryObject(value, label, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw makeHttpError(400, `${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length) throw makeHttpError(400, `${label} contains unsupported field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`);
  return value;
}

function requiredSessionSummaryBoolean(value, label) {
  if (typeof value !== "boolean") throw makeHttpError(400, `${label} must be true or false`);
  return value;
}

function requiredSessionSummaryPrompt(value, label) {
  if (typeof value !== "string") throw makeHttpError(400, `${label} must be a string`);
  const prompt = value.trim();
  if (!prompt) throw makeHttpError(400, `${label} must not be empty`);
  if (prompt.length > SESSION_SUMMARY_PROMPT_MAX_CHARS) throw makeHttpError(400, `${label} must not exceed 8 KiB`);
  return prompt;
}

async function saveSessionSummaryPreferencesData(tab, body = {}) {
  requiredSessionSummaryObject(body, "request", ["confirmed", "preferences", "tab"]);
  if (body.confirmed !== true) throw makeHttpError(409, "Session summary setup requires explicit privacy and cost confirmation (confirmed: true).");
  const submitted = requiredSessionSummaryObject(body.preferences, "preferences", ["enabled", "model", "prompts", "input", "context", "title"]);
  const submittedModel = requiredSessionSummaryObject(submitted.model, "preferences.model", ["provider", "modelId", "thinkingLevel"]);
  const submittedPrompts = requiredSessionSummaryObject(submitted.prompts, "preferences.prompts", ["title", "summary"]);
  const submittedInput = requiredSessionSummaryObject(submitted.input, "preferences.input", ["scope"]);
  const submittedContext = requiredSessionSummaryObject(submitted.context, "preferences.context", ["injectLatest"]);
  const submittedTitle = requiredSessionSummaryObject(submitted.title, "preferences.title", ["enabled", "minSettledTurns"]);
  const provider = String(submittedModel.provider || "").trim();
  const modelId = String(submittedModel.modelId || "").trim();
  const thinkingLevel = String(submittedModel.thinkingLevel || "").trim();
  if (!provider || provider.length > 160 || !modelId || modelId.length > 512) throw makeHttpError(400, "Select an available session summary model");
  const models = await availableSessionSummaryModels(tab);
  const model = models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
  if (!model) throw makeHttpError(400, `Selected session summary model is not currently available: ${provider}/${modelId}`);
  const supportedLevels = supportedSessionSummaryThinkingLevels(model);
  if (!supportedLevels.includes(thinkingLevel)) throw makeHttpError(400, `${provider}/${modelId} does not support thinking level ${thinkingLevel}`);
  if (submittedInput.scope !== "text-and-tool-names") throw makeHttpError(400, "input.scope must be text-and-tool-names");
  const minSettledTurns = Number(submittedTitle.minSettledTurns);
  if (!Number.isInteger(minSettledTurns) || minSettledTurns < 1 || minSettledTurns > 20) throw makeHttpError(400, "title.minSettledTurns must be an integer from 1 to 20");

  const saved = await writeSessionSummaryPreferences({
    configured: true,
    enabled: requiredSessionSummaryBoolean(submitted.enabled, "enabled"),
    model: { provider, modelId, thinkingLevel },
    prompts: {
      title: requiredSessionSummaryPrompt(submittedPrompts.title, "prompts.title"),
      summary: requiredSessionSummaryPrompt(submittedPrompts.summary, "prompts.summary"),
    },
    input: { scope: "text-and-tool-names" },
    context: { injectLatest: requiredSessionSummaryBoolean(submittedContext.injectLatest, "context.injectLatest") },
    title: {
      enabled: requiredSessionSummaryBoolean(submittedTitle.enabled, "title.enabled"),
      minSettledTurns,
    },
  });
  tab.sessionSummary = {
    ...(tab.sessionSummary || {}),
    version: SESSION_SUMMARY_PROTOCOL_VERSION,
    status: tab.sessionSummary?.status || "idle",
    configured: true,
    enabled: saved.enabled === true,
    durable: tab.sessionSummary?.durable === true,
    updatedAt: new Date().toISOString(),
  };
  broadcastSessionSummaryState(tab, "setup");
  return sessionSummaryPreferencesData(tab);
}

async function triggerSessionSummary(tab, { refresh = false } = {}) {
  const preferences = await readSessionSummaryPreferences();
  if (!preferences.configured) throw makeHttpError(409, "Session summary setup must be confirmed before generation.");
  const commands = await safeRpcData(tab, { type: "get_commands" }, STATUS_RPC_TIMEOUT_MS);
  const available = Array.isArray(commands.data?.commands) && commands.data.commands.some((command) => String(command?.name || "").replace(/:\d+$/, "") === "summary");
  if (!commands.ok || !available) throw makeHttpError(409, "The /summary extension command is not loaded in this Pi thread. Reload the thread and retry.");
  tab.sessionSummary = {
    ...(tab.sessionSummary || {}),
    version: SESSION_SUMMARY_PROTOCOL_VERSION,
    status: "generating",
    configured: true,
    message: "",
    updatedAt: new Date().toISOString(),
  };
  broadcastSessionSummaryState(tab, "generating");
  try {
    const response = await tab.rpc.send(
      { type: "prompt", message: refresh ? "/summary refresh" : "/summary" },
      SESSION_SUMMARY_GENERATE_TIMEOUT_MS,
    );
    if (response.success === false) throw makeHttpError(400, response.error || "Session summary generation failed");
    return { requested: true, refresh: refresh === true, summary: publicSessionSummaryState(tab), tab: tabMeta(tab) };
  } catch (error) {
    const message = (sanitizeError(error) || "Session summary generation failed")
      .replace(/[\r\n]+/g, " ")
      .slice(0, SESSION_SUMMARY_FAILURE_MAX_CHARS)
      .trim();
    tab.sessionSummary = {
      ...(tab.sessionSummary || {}),
      version: SESSION_SUMMARY_PROTOCOL_VERSION,
      status: "failure",
      message: message || "Session summary generation failed",
      updatedAt: new Date().toISOString(),
    };
    broadcastSessionSummaryState(tab, "failure");
    throw error;
  }
}

function parseCliScopedModelPatterns() {
  for (let index = 0; index < options.piArgs.length; index++) {
    const arg = options.piArgs[index];
    if (arg === "--models" && options.piArgs[index + 1]) return options.piArgs[index + 1].split(",").map((item) => item.trim()).filter(Boolean);
    if (arg.startsWith("--models=")) return arg.slice("--models=".length).split(",").map((item) => item.trim()).filter(Boolean);
  }
  return undefined;
}

async function readJsonFileIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    console.warn(`failed to read ${filePath}: ${sanitizeError(error)}`);
    return undefined;
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function numericValue(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function booleanValue(value) {
  return typeof value === "boolean" ? value : undefined;
}

function isoTimestamp(value) {
  const number = numericValue(value);
  if (number !== undefined) {
    const milliseconds = number > 1e12 ? number : number * 1000;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  return undefined;
}

function decodeJwtPayload(token) {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) return null;
    const padded = `${payload}${"=".repeat((4 - (payload.length % 4)) % 4)}`;
    return JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function codexAccountIdFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.["https://api.openai.com/auth"];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId ? accountId : null;
}

function normalizeCodexRateLimitWindow(rawWindow) {
  if (!rawWindow || typeof rawWindow !== "object") return null;
  const windowDurationSeconds = firstDefined(
    numericValue(rawWindow.windowDurationSeconds),
    numericValue(rawWindow.limitWindowSeconds),
    numericValue(rawWindow.limit_window_seconds),
    numericValue(rawWindow.windowDurationMins) !== undefined ? numericValue(rawWindow.windowDurationMins) * 60 : undefined,
  );
  const windowDurationMins = firstDefined(
    numericValue(rawWindow.windowDurationMins),
    windowDurationSeconds !== undefined ? windowDurationSeconds / 60 : undefined,
  );
  const normalized = {
    usedPercent: numericValue(firstDefined(rawWindow.usedPercent, rawWindow.used_percent)),
    windowDurationSeconds,
    windowDurationMins,
    resetAfterSeconds: numericValue(firstDefined(rawWindow.resetAfterSeconds, rawWindow.reset_after_seconds)),
    resetsAt: isoTimestamp(firstDefined(rawWindow.resetsAt, rawWindow.resetAt, rawWindow.reset_at)),
  };
  return Object.values(normalized).some((value) => value !== undefined) ? normalized : null;
}

function normalizeCodexCredits(rawCredits) {
  if (!rawCredits || typeof rawCredits !== "object") return null;
  return {
    hasCredits: booleanValue(firstDefined(rawCredits.hasCredits, rawCredits.has_credits)),
    unlimited: booleanValue(rawCredits.unlimited),
    balance: firstDefined(rawCredits.balance),
    approxLocalMessages: firstDefined(rawCredits.approxLocalMessages, rawCredits.approx_local_messages),
    approxCloudMessages: firstDefined(rawCredits.approxCloudMessages, rawCredits.approx_cloud_messages),
  };
}

function normalizeCodexRateLimitDetails(rawDetails) {
  if (!rawDetails || typeof rawDetails !== "object") return { primary: null, secondary: null };
  return {
    allowed: booleanValue(rawDetails.allowed),
    limitReached: booleanValue(firstDefined(rawDetails.limitReached, rawDetails.limit_reached)),
    primary: normalizeCodexRateLimitWindow(firstDefined(rawDetails.primary, rawDetails.primaryWindow, rawDetails.primary_window)),
    secondary: normalizeCodexRateLimitWindow(firstDefined(rawDetails.secondary, rawDetails.secondaryWindow, rawDetails.secondary_window)),
  };
}

function normalizeCodexRateLimitReachedType(rawType) {
  if (typeof rawType === "string" && rawType) return rawType;
  if (rawType && typeof rawType === "object") {
    const value = firstDefined(rawType.type, rawType.kind);
    return typeof value === "string" && value ? value : null;
  }
  return null;
}

function makeCodexUsageSnapshot({ limitId, limitName, rateLimit, credits, planType, rateLimitReachedType }) {
  const details = normalizeCodexRateLimitDetails(rateLimit);
  return {
    limitId: limitId || null,
    limitName: limitName || null,
    primary: details.primary,
    secondary: details.secondary,
    allowed: details.allowed,
    limitReached: details.limitReached,
    credits: normalizeCodexCredits(credits),
    planType: planType || null,
    rateLimitReachedType: rateLimitReachedType || null,
  };
}

function normalizeCodexUsagePayload(rawPayload) {
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const planType = firstDefined(payload.planType, payload.plan_type, null);
  const rateLimitReachedType = normalizeCodexRateLimitReachedType(firstDefined(payload.rateLimitReachedType, payload.rate_limit_reached_type));
  const snapshotsByKey = new Map();
  const addSnapshot = (snapshot) => {
    if (!snapshot) return;
    const key = snapshot.limitId || snapshot.limitName || `snapshot-${snapshotsByKey.size + 1}`;
    if (!snapshotsByKey.has(key)) snapshotsByKey.set(key, snapshot);
  };

  const directRateLimits = firstDefined(payload.rateLimits, payload.rate_limits);
  if (directRateLimits && typeof directRateLimits === "object" && (directRateLimits.primary || directRateLimits.secondary || directRateLimits.primary_window || directRateLimits.secondary_window || directRateLimits.primaryWindow || directRateLimits.secondaryWindow)) {
    addSnapshot(makeCodexUsageSnapshot({
      limitId: firstDefined(directRateLimits.limitId, directRateLimits.limit_id, "codex"),
      limitName: firstDefined(directRateLimits.limitName, directRateLimits.limit_name),
      rateLimit: directRateLimits,
      credits: firstDefined(directRateLimits.credits, payload.credits),
      planType: firstDefined(directRateLimits.planType, directRateLimits.plan_type, planType),
      rateLimitReachedType: firstDefined(directRateLimits.rateLimitReachedType, directRateLimits.rate_limit_reached_type, rateLimitReachedType),
    }));
  } else {
    addSnapshot(makeCodexUsageSnapshot({
      limitId: "codex",
      rateLimit: firstDefined(payload.rateLimit, payload.rate_limit),
      credits: payload.credits,
      planType,
      rateLimitReachedType,
    }));
  }

  const byLimitId = firstDefined(payload.rateLimitsByLimitId, payload.rate_limits_by_limit_id);
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    for (const [limitId, rawSnapshot] of Object.entries(byLimitId)) {
      if (!rawSnapshot || typeof rawSnapshot !== "object") continue;
      addSnapshot(makeCodexUsageSnapshot({
        limitId: firstDefined(rawSnapshot.limitId, rawSnapshot.limit_id, limitId),
        limitName: firstDefined(rawSnapshot.limitName, rawSnapshot.limit_name),
        rateLimit: rawSnapshot,
        credits: rawSnapshot.credits,
        planType: firstDefined(rawSnapshot.planType, rawSnapshot.plan_type, planType),
        rateLimitReachedType: firstDefined(rawSnapshot.rateLimitReachedType, rawSnapshot.rate_limit_reached_type),
      }));
    }
  }

  const additionalRateLimits = firstDefined(payload.additionalRateLimits, payload.additional_rate_limits);
  if (Array.isArray(additionalRateLimits)) {
    for (const item of additionalRateLimits) {
      if (!item || typeof item !== "object") continue;
      addSnapshot(makeCodexUsageSnapshot({
        limitId: firstDefined(item.limitId, item.limit_id, item.meteredFeature, item.metered_feature, item.limitName, item.limit_name),
        limitName: firstDefined(item.limitName, item.limit_name),
        rateLimit: firstDefined(item.rateLimit, item.rate_limit),
        credits: item.credits,
        planType,
      }));
    }
  }

  const snapshots = [...snapshotsByKey.values()];
  const selected = snapshots.find((snapshot) => snapshot.limitId === "codex") || snapshots[0] || null;
  const rateLimitsByLimitId = Object.fromEntries(snapshots.filter((snapshot) => snapshot.limitId).map((snapshot) => [snapshot.limitId, snapshot]));
  return {
    planType: planType || selected?.planType || null,
    rateLimitReachedType: rateLimitReachedType || selected?.rateLimitReachedType || null,
    credits: normalizeCodexCredits(payload.credits) || selected?.credits || null,
    selected,
    snapshots,
    rateLimits: selected,
    rateLimitsByLimitId,
  };
}

async function getOpenAICodexUsageCredentials({ forceRefresh = false } = {}) {
  const { modelRuntime } = await authContext();
  const loginGuidance = codexUsageLoginGuidance(modelRuntime);
  let resolved;
  try {
    resolved = await resolveCodexUsageAuth(modelRuntime, OPENAI_CODEX_PROVIDER_ID, { forceRefresh });
  } catch {
    // Client-facing auth failures must not include provider stack traces,
    // refresh tokens, or raw upstream error details.
    throw makeHttpError(401, `OpenAI Codex OAuth token refresh failed. ${loginGuidance}`);
  }

  if (resolved.unsupportedReason === "chatgpt-direct-token") {
    throw makeHttpError(501, CODEX_USAGE_DIRECT_TOKEN_MESSAGE);
  }
  const accessToken = resolved.accessToken;
  if (!accessToken) {
    if (resolved.providerId === "openai" && resolved.credential?.type === "api_key") {
      throw makeHttpError(401, `Codex subscription usage requires ChatGPT OAuth, not an OpenAI API key. ${loginGuidance}`);
    }
    const status = modelRuntime.getProviderAuthStatus(resolved.providerId);
    if (status.configured) throw makeHttpError(401, `OpenAI Codex OAuth token is expired or unavailable. ${loginGuidance}`);
    throw makeHttpError(401, `OpenAI Codex OAuth is not configured. ${loginGuidance}`);
  }

  const latest = resolved.credential || {};
  const accountId = latest.accountId || codexAccountIdFromAccessToken(accessToken);
  if (!accountId) {
    throw makeHttpError(401, `OpenAI Codex account id is unavailable. ${loginGuidance}`);
  }

  return {
    accessToken,
    accountId,
    refreshed: resolved.refreshed,
    source: latest.type === "oauth" ? "stored-oauth" : "api-key",
    expiresAt: numericValue(latest.expires) ? new Date(numericValue(latest.expires)).toISOString() : undefined,
  };
}

async function fetchOpenAICodexUsagePayload(credentials) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CODEX_USAGE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(OPENAI_CODEX_USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credentials.accessToken}`,
        "chatgpt-account-id": credentials.accountId,
        originator: "pi-webui",
      },
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      const error = makeHttpError(response.status === 401 ? 401 : 502, `OpenAI Codex usage request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})`);
      error.openaiStatus = response.status;
      throw error;
    }
    try {
      return JSON.parse(text || "{}");
    } catch {
      throw makeHttpError(502, "OpenAI Codex usage response was not valid JSON");
    }
  } catch (error) {
    if (error?.name === "AbortError") throw makeHttpError(504, "OpenAI Codex usage request timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getLegacyOpenAICodexUsageStatus({ forceRefresh = false } = {}) {
  let credentials = await getOpenAICodexUsageCredentials({ forceRefresh });
  let rawPayload;
  try {
    rawPayload = await fetchOpenAICodexUsagePayload(credentials);
  } catch (error) {
    if (error?.openaiStatus === 401) {
      credentials = await getOpenAICodexUsageCredentials({ forceRefresh: true });
      rawPayload = await fetchOpenAICodexUsagePayload(credentials);
    } else {
      throw error;
    }
  }

  return {
    available: true,
    providerId: OPENAI_CODEX_PROVIDER_ID,
    source: "chatgpt.com",
    fetchedAt: new Date().toISOString(),
    auth: {
      source: credentials.source,
      expiresAt: credentials.expiresAt,
      refreshed: credentials.refreshed,
    },
    ...normalizeCodexUsagePayload(rawPayload),
  };
}

const getOpenAICodexUsageStatus = createCodexUsageReader({
  readCli: async () => {
    const payload = await readCodexCliUsage();
    return {
      available: true,
      providerId: OPENAI_CODEX_PROVIDER_ID,
      source: "codex-cli",
      fetchedAt: new Date().toISOString(),
      auth: { source: "codex-cli" },
      ...normalizeCodexUsagePayload(payload),
    };
  },
  readLegacy: getLegacyOpenAICodexUsageStatus,
});

const CLAUDE_USAGE_MONTHS = new Map([
  ["jan", 1], ["january", 1], ["feb", 2], ["february", 2],
  ["mar", 3], ["march", 3], ["apr", 4], ["april", 4], ["may", 5],
  ["jun", 6], ["june", 6], ["jul", 7], ["july", 7], ["aug", 8], ["august", 8],
  ["sep", 9], ["sept", 9], ["september", 9], ["oct", 10], ["october", 10],
  ["nov", 11], ["november", 11], ["dec", 12], ["december", 12],
]);
const CLAUDE_USAGE_WEEKDAYS = new Map([
  ["sun", 0], ["sunday", 0], ["mon", 1], ["monday", 1],
  ["tue", 2], ["tues", 2], ["tuesday", 2], ["wed", 3], ["wednesday", 3],
  ["thu", 4], ["thur", 4], ["thurs", 4], ["thursday", 4],
  ["fri", 5], ["friday", 5], ["sat", 6], ["saturday", 6],
]);

function normalizedTimeZone(value) {
  const timeZone = String(value || "").trim();
  if (!timeZone) return "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return "";
  }
}

function datePartsInTimeZone(date, timeZone) {
  const parts = {};
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  if (parts.hour === 24) parts.hour = 0;
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour || 0,
    minute: parts.minute || 0,
    second: parts.second || 0,
  };
}

function zonedDateTimeToUtc(parts, timeZone) {
  const targetWallTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
  let guess = targetWallTime;
  for (let index = 0; index < 4; index++) {
    const actual = datePartsInTimeZone(new Date(guess), timeZone);
    const actualWallTime = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour || 0, actual.minute || 0, actual.second || 0);
    const delta = targetWallTime - actualWallTime;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

function parseClaudeUsageClock(hourValue, minuteValue, meridiemValue) {
  let hour = Number(hourValue);
  const minute = minuteValue === undefined || minuteValue === "" ? 0 : Number(minuteValue);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const meridiem = String(meridiemValue || "").replace(/\./g, "").toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) return null;
  return { hour, minute };
}

function parseClaudeUsageMonthReset(dateText, timeZone, now) {
  const match = String(dateText || "").trim().match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!match) return null;
  const month = CLAUDE_USAGE_MONTHS.get(match[1].toLowerCase());
  const day = Number(match[2]);
  const clock = parseClaudeUsageClock(match[3], match[4], match[5]);
  if (!month || !Number.isInteger(day) || day < 1 || day > 31 || !clock) return null;
  const nowParts = datePartsInTimeZone(now, timeZone);
  let resetDate = zonedDateTimeToUtc({ year: nowParts.year, month, day, ...clock }, timeZone);
  if (resetDate.getTime() < now.getTime() - 60_000) resetDate = zonedDateTimeToUtc({ year: nowParts.year + 1, month, day, ...clock }, timeZone);
  return Number.isFinite(resetDate.getTime()) ? resetDate : null;
}

function parseClaudeUsageWeekdayReset(dateText, timeZone, now) {
  const match = String(dateText || "").trim().match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!match) return null;
  const weekday = CLAUDE_USAGE_WEEKDAYS.get(match[1].toLowerCase());
  const clock = parseClaudeUsageClock(match[2], match[3], match[4]);
  if (weekday === undefined || !clock) return null;
  const nowParts = datePartsInTimeZone(now, timeZone);
  const currentWeekday = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day)).getUTCDay();
  let deltaDays = (weekday - currentWeekday + 7) % 7;
  let date = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + deltaDays));
  let resetDate = zonedDateTimeToUtc({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), ...clock }, timeZone);
  if (resetDate.getTime() < now.getTime() - 60_000) {
    deltaDays += 7;
    date = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + deltaDays));
    resetDate = zonedDateTimeToUtc({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), ...clock }, timeZone);
  }
  return Number.isFinite(resetDate.getTime()) ? resetDate : null;
}

function parseClaudeUsageReset(resetText, now = new Date()) {
  const text = String(resetText || "").trim();
  if (!text) return { resetText: "" };
  const rawTimeZone = text.match(/\(([^)]+)\)\s*$/)?.[1] || "";
  const timeZone = normalizedTimeZone(rawTimeZone) || normalizedTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const dateText = text.replace(/\s*\([^)]+\)\s*$/, "").trim();
  if (!timeZone) return { resetText: text, timeZone: rawTimeZone || null };
  const resetDate = parseClaudeUsageMonthReset(dateText, timeZone, now) || parseClaudeUsageWeekdayReset(dateText, timeZone, now);
  if (!resetDate) return { resetText: text, timeZone };
  return {
    resetText: text,
    timeZone,
    resetsAt: resetDate.toISOString(),
    resetAfterSeconds: Math.max(0, Math.round((resetDate.getTime() - now.getTime()) / 1000)),
  };
}

function parseClaudeUsageWindowLine(line, now) {
  const match = String(line || "").trim().match(/^(.+?):\s+(\d+(?:\.\d+)?)%\s+used\s+[·-]\s+resets\s+(.+)$/i);
  if (!match) return null;
  return {
    label: match[1].trim(),
    usedPercent: Number(match[2]),
    ...parseClaudeUsageReset(match[3], now),
  };
}

function parseClaudeUsageActivityHeader(line) {
  const match = String(line || "").trim().match(/^(.+?)\s+[·-]\s+(\d+)\s+requests?\s+[·-]\s+(\d+)\s+sessions?$/i);
  if (!match) return null;
  return { label: match[1].trim(), requests: Number(match[2]), sessions: Number(match[3]), details: [] };
}

function parseClaudeUsageActivityDetail(line) {
  const text = String(line || "").trim();
  const percentMatch = text.match(/^(\d+(?:\.\d+)?)%\s+(.+)$/);
  if (percentMatch) return { text, percent: Number(percentMatch[1]), description: percentMatch[2] };
  return { text };
}

function parseClaudeUsageText(text, now = new Date()) {
  const summary = [];
  const notes = [];
  const windows = [];
  const activity = [];
  let activityTitle = "";
  let currentActivity = null;
  for (const rawLine of stripAnsi(text).replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const window = parseClaudeUsageWindowLine(line, now);
    if (window) {
      windows.push(window);
      currentActivity = null;
      continue;
    }
    const activityHeader = parseClaudeUsageActivityHeader(line);
    if (activityHeader) {
      activity.push(activityHeader);
      currentActivity = activityHeader;
      continue;
    }
    if (currentActivity && /^\s+/.test(rawLine)) {
      currentActivity.details.push(parseClaudeUsageActivityDetail(line));
      continue;
    }
    if (/^what'?s contributing/i.test(line)) {
      activityTitle = line;
      currentActivity = null;
      continue;
    }
    if (summary.length === 0 && /using your subscription|claude code usage/i.test(line)) summary.push(line);
    else notes.push(line);
  }
  return { summary: summary[0] || "", windows, activityTitle, activity, notes };
}

async function getClaudeCodeUsageStatus() {
  const result = await runCommand(CLAUDE_USAGE_COMMAND, CLAUDE_USAGE_ARGS, {
    cwd: options.cwd,
    timeoutMs: CLAUDE_USAGE_TIMEOUT_MS,
    maxOutputLength: CLAUDE_USAGE_OUTPUT_MAX_CHARS,
  });
  const command = formatCommandForDisplay(CLAUDE_USAGE_COMMAND, CLAUDE_USAGE_ARGS);
  if (result.timedOut) throw makeHttpError(504, `Claude usage command timed out: ${command}`);
  if (result.error && result.exitCode === undefined) throw makeHttpError(502, `Claude usage command failed: ${result.error}`);
  if (result.exitCode !== 0) {
    const detail = truncateLongText(stripAnsi(result.stderr || result.stdout || ""), 2000).trim();
    throw makeHttpError(502, `Claude usage command exited ${result.exitCode}${detail ? `: ${detail}` : ""}`);
  }
  const stdout = stripAnsi(result.stdout || "").trim();
  if (!stdout) throw makeHttpError(502, "Claude usage command returned no output");
  let usageText = stdout;
  let outputFormat = "text";
  let sessionId = null;
  let durationMs = undefined;
  if (stdout.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw makeHttpError(502, "Claude usage command returned invalid JSON");
    }
    outputFormat = "json";
    sessionId = typeof parsed.session_id === "string" ? parsed.session_id : null;
    durationMs = numericValue(parsed.duration_ms);
    if (parsed.is_error) throw makeHttpError(502, parsed.result || "Claude usage command returned an error");
    if (typeof parsed.result === "string") usageText = parsed.result;
  }
  const fetchedAt = new Date();
  return {
    available: true,
    providerId: "claude-code",
    source: "claude-code-cli",
    command,
    outputFormat,
    fetchedAt: fetchedAt.toISOString(),
    durationMs,
    sessionId,
    ...parseClaudeUsageText(usageText, fetchedAt),
  };
}

async function configuredScopedModelPatterns(cwd = options.cwd) {
  const cliPatterns = parseCliScopedModelPatterns();
  if (cliPatterns !== undefined) return { patterns: cliPatterns, source: "cli" };

  const agentDir = process.env.PI_CODING_AGENT_DIR ? path.resolve(expandUserPath(process.env.PI_CODING_AGENT_DIR)) : path.join(homedir(), ".pi", "agent");
  const [globalSettings, projectSettings] = await Promise.all([
    readJsonFileIfExists(path.join(agentDir, "settings.json")),
    readJsonFileIfExists(path.join(cwd, ".pi", "settings.json")),
  ]);

  if (Array.isArray(projectSettings?.enabledModels)) return { patterns: projectSettings.enabledModels, source: "project" };
  if (Array.isArray(globalSettings?.enabledModels)) return { patterns: globalSettings.enabledModels, source: "global" };
  return { patterns: [], source: "none" };
}

async function getScopedModelData(tab) {
  const { patterns, source } = await configuredScopedModelPatterns(tab.cwd);
  if (!patterns.length) return { models: [], patterns, source };
  const response = await safeRpcResponse(tab, { type: "get_available_models" });
  if (response.success === false) throw makeHttpError(400, response.error || "failed to load available models");
  return { models: await resolveScopedModelsFromPatterns(patterns, response.data?.models || []), patterns, source, rpcRunning: response.rpcRunning !== false };
}

function modelKey(model) {
  return model?.provider && model?.id ? `${model.provider}/${model.id}` : "";
}

async function cycleTabModel(tab, direction = "forward") {
  const availableResponse = await tab.rpc.send({ type: "get_available_models" });
  if (availableResponse.success === false) return availableResponse;
  const allModels = Array.isArray(availableResponse.data?.models) ? availableResponse.data.models : [];
  const { patterns, source } = await configuredScopedModelPatterns(tab.cwd);
  const scopedModels = patterns.length ? await resolveScopedModelsFromPatterns(patterns, allModels) : [];
  const candidates = scopedModels.length ? scopedModels : allModels;
  if (!candidates.length) throw makeHttpError(400, "No models are available to cycle.");

  const state = await currentSessionState(tab).catch(() => tab.lastState || {});
  const currentKey = modelKey(state.model);
  const currentIndex = candidates.findIndex((model) => modelKey(model) === currentKey);
  const backwards = direction === "backward" || direction === "previous" || direction === "prev";
  let nextIndex;
  if (backwards) nextIndex = currentIndex > 0 ? currentIndex - 1 : candidates.length - 1;
  else nextIndex = currentIndex >= 0 && currentIndex < candidates.length - 1 ? currentIndex + 1 : 0;
  const nextModel = candidates[nextIndex];
  const response = await tab.rpc.send({ type: "set_model", provider: nextModel.provider, modelId: nextModel.id });
  if (response.success === false) return response;
  return rpcSuccess("cycle_model", {
    model: response.data || nextModel,
    direction: backwards ? "backward" : "forward",
    scoped: scopedModels.length > 0,
    scopeSource: scopedModels.length > 0 ? source : "all",
    index: nextIndex,
    count: candidates.length,
    tab: tabMeta(tab),
  });
}

function pathPickerRoots(activeCwd, viewedCwd) {
  const home = process.env.HOME || process.env.USERPROFILE;
  return uniquePathItems([
    { label: "Tab", cwd: activeCwd, displayCwd: displayPath(activeCwd) },
    { label: "Default", cwd: options.cwd, displayCwd: displayPath(options.cwd) },
    home ? { label: "Home", cwd: home, displayCwd: displayPath(home) } : undefined,
    { label: "Root", cwd: path.parse(viewedCwd || activeCwd || options.cwd).root, displayCwd: path.parse(viewedCwd || activeCwd || options.cwd).root },
  ]);
}

const discoverWindowsDriveRoots = createWindowsDriveRootDiscovery({ runCommand });

function knownWindowsDrivePaths(activeCwd) {
  return [
    activeCwd,
    options.cwd,
    process.env.USERPROFILE,
    process.env.HOME,
    process.env.HOMEDRIVE,
    process.env.SystemDrive,
    process.env.SystemRoot,
  ];
}

function windowsDriveDiscoveryCwd() {
  return process.env.SystemRoot || process.env.WINDIR || path.dirname(process.execPath);
}

async function getWindowsDrivesPickerData(activeCwd) {
  const driveRoots = await discoverWindowsDriveRoots({
    cwd: windowsDriveDiscoveryCwd(),
    knownPaths: knownWindowsDrivePaths(activeCwd),
  });
  return windowsDrivesPickerData(driveRoots, pathPickerRoots(activeCwd, activeCwd));
}

async function getDirectoryPickerData(viewPath, activeCwd) {
  if (platform() === "win32" && viewPath === WINDOWS_DRIVES_PICKER_PATH) {
    return getWindowsDrivesPickerData(activeCwd);
  }

  const cwd = await resolveCwd(viewPath || activeCwd, activeCwd);
  let entries;
  try {
    entries = await readdir(cwd, { withFileTypes: true });
  } catch (error) {
    throw makeHttpError(error?.code === "EACCES" ? 403 : 400, `Cannot read directory ${cwd}: ${sanitizeError(error)}`);
  }

  const directoryEntries = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const directories = directoryEntries.slice(0, 500).map((entry) => {
    const entryPath = path.join(cwd, entry.name);
    return { name: entry.name, cwd: entryPath, displayCwd: displayPath(entryPath), hidden: entry.name.startsWith(".") };
  });
  const parent = path.dirname(cwd);
  const parentPath = platform() === "win32" && isWindowsDriveRoot(cwd)
    ? WINDOWS_DRIVES_PICKER_PATH
    : parent === cwd ? null : parent;

  return {
    cwd,
    displayCwd: displayPath(cwd),
    parent: parentPath,
    roots: pathPickerRoots(activeCwd, cwd),
    directories,
    truncated: directoryEntries.length > directories.length,
  };
}

function cleanDirectoryCreateName(value) {
  const name = String(value || "").trim();
  if (!name) throw makeHttpError(400, "Directory name is required");
  if (name === "." || name === "..") throw makeHttpError(400, "Directory name cannot be . or ..");
  if (name.includes("\u0000")) throw makeHttpError(400, "Directory name cannot contain null bytes");
  if (name.includes("/") || name.includes("\\")) throw makeHttpError(400, "Create one directory at a time; path separators are not allowed");
  if (name.length > 255) throw makeHttpError(400, "Directory name is too long");
  return name;
}

async function createDirectoryPickerDirectory(parentPath, nameValue, activeCwd) {
  const parent = await resolveCwd(parentPath || activeCwd, activeCwd);
  const name = cleanDirectoryCreateName(nameValue);
  const target = path.resolve(parent, name);
  if (path.dirname(target) !== parent) throw makeHttpError(400, "Directory must be created directly under the current path");

  try {
    await mkdir(target);
  } catch (error) {
    if (error?.code === "EEXIST") throw makeHttpError(409, `Directory already exists: ${target}`);
    if (["EACCES", "EPERM"].includes(error?.code)) throw makeHttpError(403, `Cannot create directory ${target}: ${sanitizeError(error)}`);
    throw makeHttpError(400, `Cannot create directory ${target}: ${sanitizeError(error)}`);
  }

  return getDirectoryPickerData(target, activeCwd);
}

function normalizeSuggestionPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function cleanPathSuggestionQuery(value) {
  return normalizeSuggestionPath(value).replace(/\0/g, "").slice(0, PATH_SUGGESTION_QUERY_LIMIT);
}

const BANG_COMMON_COMMANDS_BASE = [
  "ls", "la", "ll", "cd", "pwd", "cat", "less", "bat", "rg", "fd", "find", "grep", "sed", "awk", "jq",
  "git", "gh", "g", "pnpm", "bun", "npm", "node", "python", "python3", "uv", "cargo", "rustc", "make", "just",
  "docker", "docker-compose", "curl", "wget", "ssh", "scp", "rsync", "tmux", "htop", "btop",
];
const BANG_COMMON_COMMANDS_UNIX = ["systemctl", "journalctl"];
const BANG_COMMON_COMMANDS_LINUX = ["pacman", "yay"];

function bangCommonCommands() {
  const commands = [...BANG_COMMON_COMMANDS_BASE];
  const currentPlatform = platform();
  if (currentPlatform !== "win32") commands.push(...BANG_COMMON_COMMANDS_UNIX);
  if (currentPlatform === "linux") commands.push(...BANG_COMMON_COMMANDS_LINUX);
  return commands;
}

function cleanBangSuggestionQuery(value) {
  return String(value || "").replace(/\0/g, "").replace(/^!+/, "").slice(0, BANG_SUGGESTION_QUERY_LIMIT);
}

function parseBangCommandLine(commandLine) {
  const trimmed = String(commandLine || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return { flags: [] };
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let startIndex = 0;
  let executable = tokens[startIndex] || "";
  if (executable === "sudo") {
    startIndex += 1;
    executable = tokens[startIndex] || "";
  }
  executable = executable.replace(/^!+/, "");
  if (!executable) return { flags: [] };
  const flags = tokens.slice(startIndex + 1).filter((token) => token.startsWith("-") && token !== "-");
  return { executable, flags };
}

function bangExecutable(commandLine) {
  return parseBangCommandLine(commandLine).executable;
}

async function readTextFileIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readFishHistoryExecutables() {
  const fishDataHome = process.env.XDG_DATA_HOME?.trim() || path.join(homedir(), ".local", "share");
  const content = await readTextFileIfExists(path.join(fishDataHome, "fish", "fish_history"));
  const commands = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*cmd:\s*(.*)$/);
    const executable = match ? bangExecutable(match[1]) : "";
    if (executable) commands.push(executable);
  }
  return commands;
}

async function readBashHistoryExecutables() {
  const content = await readTextFileIfExists(path.join(homedir(), ".bash_history"));
  return content.split(/\r?\n/).map((line) => bangExecutable(line)).filter(Boolean);
}

async function readZshHistoryExecutables() {
  const content = await readTextFileIfExists(path.join(homedir(), ".zsh_history"));
  return content
    .split(/\r?\n/)
    .map((line) => bangExecutable(line.includes(";") ? line.slice(line.indexOf(";") + 1) : line))
    .filter(Boolean);
}

function bangRuntimeStorePath() {
  const configured = process.env.PI_BANG_AUTOCOMPLETE_RUNTIME_STORE_PATH?.trim();
  return configured ? path.resolve(expandUserPath(configured)) : path.join(agentDir, "state", "bang-command-autocomplete-runtime.json");
}

async function readBangRuntimeData() {
  const empty = { commands: new Set(), flagsByCommand: new Map(), lines: new Set() };
  const parsed = await readJsonFileIfExists(bangRuntimeStorePath());
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const line = String(item || "").trim();
      if (!line) continue;
      const executable = bangExecutable(line);
      if (executable) empty.commands.add(executable);
      empty.lines.add(line.replace(/^!+/, ""));
    }
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  for (const item of Array.isArray(parsed.commands) ? parsed.commands : []) {
    const command = String(item || "").trim();
    if (command) empty.commands.add(command);
  }
  if (parsed.flags && typeof parsed.flags === "object") {
    for (const [command, flags] of Object.entries(parsed.flags)) {
      const normalizedCommand = String(command || "").trim();
      if (!normalizedCommand || !Array.isArray(flags)) continue;
      const normalizedFlags = flags.map((flag) => String(flag || "").trim()).filter(Boolean);
      if (normalizedFlags.length) empty.flagsByCommand.set(normalizedCommand, new Set(normalizedFlags));
    }
  }
  for (const item of Array.isArray(parsed.lines) ? parsed.lines : []) {
    const line = String(item || "").trim().replace(/^!+/, "");
    if (line) empty.lines.add(line);
  }
  return empty;
}

async function buildBangCommandIndex(includeHistory, runtimeData) {
  const merged = new Map();
  for (const command of bangCommonCommands()) merged.set(command, "common");
  if (includeHistory) {
    const historyExecutables = [
      ...await readFishHistoryExecutables(),
      ...await readBashHistoryExecutables(),
      ...await readZshHistoryExecutables(),
    ];
    for (let index = historyExecutables.length - 1; index >= 0; index--) {
      const command = historyExecutables[index];
      if (command && (!merged.has(command) || merged.get(command) === "common")) merged.set(command, "history");
    }
  }
  for (const command of runtimeData.commands) merged.set(command, "runtime");
  return Array.from(merged.entries()).map(([command, source]) => ({ command, source }));
}

function rankBangValues(values, query) {
  const q = String(query || "").toLowerCase();
  const startsWith = [];
  const includes = [];
  for (const value of values) {
    const text = typeof value === "string" ? value : value.command;
    const lower = String(text || "").toLowerCase();
    if (!q || lower.startsWith(q)) startsWith.push(value);
    else if (lower.includes(q)) includes.push(value);
  }
  return [...startsWith, ...includes].slice(0, BANG_SUGGESTION_LIMIT);
}

function bangSuggestion(insertText, label, description, kind = "command") {
  return { insertText, label, description, kind };
}

function bangSourceLabel(source) {
  if (source === "history") return "shell history";
  if (source === "runtime") return "current session";
  return "common command";
}

async function getBangSuggestionData(tab, rawQuery) {
  const query = cleanBangSuggestionQuery(rawQuery);
  const includeHistory = isTruthyEnv(process.env.PI_BANG_AUTOCOMPLETE_INCLUDE_HISTORY);
  const runtimeData = await readBangRuntimeData();
  const commandIndex = await buildBangCommandIndex(includeHistory, runtimeData);
  const suggestions = [];
  const flagMatch = query.match(/^(\S+)\s+(\S*)$/);

  if (flagMatch && (!flagMatch[2] || flagMatch[2].startsWith("-"))) {
    const command = flagMatch[1];
    const partialFlag = flagMatch[2] || "";
    for (const flag of rankBangValues(Array.from(runtimeData.flagsByCommand.get(command) || []), partialFlag)) {
      suggestions.push(bangSuggestion(`${command} ${flag}`, `!${command} ${flag}`, `learned for ${command}`, "flag"));
    }
  }

  if (query.includes(" ")) {
    for (const lineCandidate of rankBangValues(Array.from(runtimeData.lines), query)) {
      suggestions.push(bangSuggestion(lineCandidate, `!${lineCandidate}`, "learned full line", "line"));
    }
  }

  if (!query.includes(" ")) {
    const ranked = rankBangValues(commandIndex, query);
    for (const entry of ranked) {
      suggestions.push(bangSuggestion(entry.command, `!${entry.command}`, bangSourceLabel(entry.source), "command"));
    }
    for (const entry of ranked) {
      for (const flag of Array.from(runtimeData.flagsByCommand.get(entry.command) || []).slice(0, 3)) {
        suggestions.push(bangSuggestion(`${entry.command} ${flag}`, `!${entry.command} ${flag}`, "learned command + flag", "flag"));
      }
    }
    for (const lineCandidate of rankBangValues(Array.from(runtimeData.lines), query)) {
      if (lineCandidate.startsWith(query)) suggestions.push(bangSuggestion(lineCandidate, `!${lineCandidate}`, "learned full line", "line"));
    }
  }

  const seen = new Set();
  return {
    cwd: tab.cwd,
    displayCwd: displayPath(tab.cwd),
    query,
    suggestions: suggestions.filter((item) => {
      const key = item.insertText;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, BANG_SUGGESTION_LIMIT),
  };
}

function splitSuggestionPathQuery(query) {
  const normalized = normalizeSuggestionPath(query);
  if (normalized === "~") return { displayBase: "~", prefix: "" };
  if (!normalized || normalized.endsWith("/")) return { displayBase: normalized, prefix: "" };
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex === -1) return { displayBase: "", prefix: normalized };
  return { displayBase: normalized.slice(0, slashIndex + 1), prefix: normalized.slice(slashIndex + 1) };
}

function resolveSuggestionBase(displayBase, cwd) {
  const base = displayBase || ".";
  if (base === "~" || base.startsWith("~/")) return path.resolve(expandUserPath(base));
  if (base.startsWith("/")) return path.resolve(base);
  return path.resolve(cwd, base);
}

function joinSuggestionDisplayPath(displayBase, name) {
  const base = normalizeSuggestionPath(displayBase);
  if (!base || base === ".") return name;
  if (base === "/") return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

function pathSuggestionLabel(pathText) {
  const normalized = normalizeSuggestionPath(pathText).replace(/\/+$/, "");
  const name = normalized ? path.posix.basename(normalized) : pathText;
  return `${name || pathText}${pathText.endsWith("/") ? "/" : ""}`;
}

function sortPathSuggestions(items) {
  return items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" });
  });
}

async function getDirectPathSuggestions(query, cwd) {
  const { displayBase, prefix } = splitSuggestionPathQuery(query);
  const searchDir = resolveSuggestionBase(displayBase, cwd);
  let entries;
  try {
    entries = await readdir(searchDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const normalizedPrefix = prefix.toLowerCase();
  const suggestions = [];
  for (const entry of entries) {
    if (entry.name === ".git" || (!normalizedPrefix && PATH_SUGGESTION_EXCLUDED_DIRS.has(entry.name))) continue;
    if (normalizedPrefix && !entry.name.toLowerCase().startsWith(normalizedPrefix)) continue;
    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = (await stat(path.join(searchDir, entry.name))).isDirectory();
      } catch {
        isDirectory = false;
      }
    }
    const pathText = normalizeSuggestionPath(`${joinSuggestionDisplayPath(displayBase, entry.name)}${isDirectory ? "/" : ""}`);
    suggestions.push({
      path: pathText,
      label: `${entry.name}${isDirectory ? "/" : ""}`,
      type: isDirectory ? "directory" : "file",
      description: pathText,
    });
  }
  return sortPathSuggestions(suggestions).slice(0, PATH_SUGGESTION_LIMIT);
}

function addSuggestionEntry(entries, pathText, isDirectory) {
  const normalized = normalizeSuggestionPath(pathText).replace(/^\.\//, "");
  if (!normalized || normalized === ".git" || normalized.startsWith(".git/")) return;
  const value = isDirectory && !normalized.endsWith("/") ? `${normalized}/` : normalized;
  if (!entries.has(value)) entries.set(value, { path: value, isDirectory });
}

function addSuggestionPathWithParents(entries, pathText) {
  const normalized = normalizeSuggestionPath(pathText).replace(/^\.\//, "");
  if (!normalized || normalized.startsWith(".git/")) return;
  const parts = normalized.split("/").filter(Boolean);
  let parent = "";
  for (let index = 0; index < parts.length - 1; index++) {
    parent = parent ? `${parent}/${parts[index]}` : parts[index];
    addSuggestionEntry(entries, `${parent}/`, true);
  }
  addSuggestionEntry(entries, normalized, false);
}

async function getGitPathSuggestionEntries(cwd) {
  const result = await runCommand("git", ["-C", cwd, "ls-files", "-co", "--exclude-standard"], {
    timeoutMs: 1200,
    maxOutputLength: PATH_SUGGESTION_MAX_OUTPUT_LENGTH,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  const entries = new Map();
  for (const line of result.stdout.split("\n")) addSuggestionPathWithParents(entries, line.trim());
  return [...entries.values()];
}

async function getFilesystemPathSuggestionEntries(cwd) {
  const entries = new Map();
  async function walk(dir, relativeDir = "", depth = 0) {
    if (entries.size >= PATH_SUGGESTION_SCAN_LIMIT || depth > 6) return;
    let dirEntries;
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirEntries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    for (const entry of dirEntries) {
      if (entries.size >= PATH_SUGGESTION_SCAN_LIMIT) return;
      const relativePath = normalizeSuggestionPath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = (await stat(path.join(dir, entry.name))).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      if (isDirectory) {
        addSuggestionEntry(entries, `${relativePath}/`, true);
        if (!PATH_SUGGESTION_EXCLUDED_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), relativePath, depth + 1);
      } else {
        addSuggestionEntry(entries, relativePath, false);
      }
    }
  }
  await walk(cwd);
  return [...entries.values()];
}

function isSubsequence(needle, haystack) {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index++;
    if (index >= needle.length) return true;
  }
  return needle.length === 0;
}

function scorePathSuggestion(entry, query) {
  const q = normalizeSuggestionPath(query).replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
  if (!q) return entry.isDirectory ? 2 : 1;
  const entryPath = entry.path.replace(/\/+$/, "").toLowerCase();
  const name = path.posix.basename(entryPath);
  let score = 0;
  if (name === q) score = 100;
  else if (name.startsWith(q)) score = 90;
  else if (entryPath.startsWith(q)) score = 80;
  else if (name.includes(q)) score = 70;
  else if (entryPath.includes(q)) score = 55;
  else if (isSubsequence(q, name)) score = 40;
  else if (isSubsequence(q, entryPath)) score = 25;
  if (entry.isDirectory && score > 0) score += 5;
  return score;
}

function formatRankedPathSuggestions(entries, query) {
  return entries
    .map((entry) => ({ ...entry, score: scorePathSuggestion(entry, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, PATH_SUGGESTION_LIMIT)
    .map((entry) => ({
      path: entry.path,
      label: pathSuggestionLabel(entry.path),
      type: entry.isDirectory ? "directory" : "file",
      description: entry.path,
    }));
}

async function getPathSuggestionData(tab, rawQuery) {
  const query = cleanPathSuggestionQuery(rawQuery);
  const shouldUseDirect = !query || query.includes("/") || query.startsWith(".") || query.startsWith("~");
  let suggestions = shouldUseDirect ? await getDirectPathSuggestions(query, tab.cwd) : [];
  if (suggestions.length === 0 && query) {
    const entries = (await getGitPathSuggestionEntries(tab.cwd)) ?? (await getFilesystemPathSuggestionEntries(tab.cwd));
    suggestions = formatRankedPathSuggestions(entries, query);
  }
  return { cwd: tab.cwd, displayCwd: displayPath(tab.cwd), query, suggestions };
}

async function getWorkspaceInfo(cwd, startedAt) {
  return {
    cwd,
    displayCwd: displayPath(cwd),
    uptimeMs: Math.max(0, Date.now() - Date.parse(startedAt)),
  };
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));














































function sendGitWorktreeFailure(res, error) {
  sendJson(res, 200, gitWorktreeErrorPayload(error));
}

// Read-only workflow lookups are safe over GET; everything else mutates the
// repository (or process state, for cancel) and must be POST. Method + access
// guard are enforced at the router before dispatch — never dispatch on path
// alone, or cross-origin GETs (image/script tags) could drive git mutations.
const GIT_WORKFLOW_READONLY_PATHS = new Set([
  "/api/git-workflow/staged-content",
  "/api/git-workflow/message",
  "/api/git-workflow/default-commit-message",
  "/api/git-workflow/branch-name",
  "/api/git-workflow/pr-description",
  "/api/git-workflow/init-files-status",
]);

const GIT_WORKFLOW_MUTATING_PATHS = new Set([
  "/api/git-workflow/init",
  "/api/git-workflow/readme",
  "/api/git-workflow/initial-commit",
  "/api/git-workflow/main-branch",
  "/api/git-workflow/remote",
  "/api/git-workflow/init-push",
  "/api/git-workflow/add",
  "/api/git-workflow/branch",
  "/api/git-workflow/commit",
  "/api/git-workflow/push",
  "/api/git-workflow/publish",
  "/api/git-workflow/create-pr",
  "/api/git-workflow/cancel",
]);

async function handleGitWorkflowRequest(pathname, body = {}, tabOrCwd = options.cwd) {
  const tab = tabOrCwd && typeof tabOrCwd === "object" ? tabOrCwd : null;
  const cwd = tab?.cwd || tabOrCwd || options.cwd;
  try {
    switch (pathname) {
      case "/api/git-workflow/staged-content":
        if (!tab) throw new Error("Staged-content lookup requires a Web UI tab");
        return { ok: true, data: await stagedContentHashForTab(tab) };
      case "/api/git-workflow/message": {
        const generationId = String(body.generationId || "").trim();
        if (generationId && !tab) throw new Error("Fresh commit-message lookup requires a Web UI tab");
        return { ok: true, data: await readGitWorkflowMessages(cwd, { generationId, generation: tab?.gitWorkflowArtifactGeneration || null }) };
      }
      case "/api/git-workflow/default-commit-message":
        return { ok: true, data: await readGitWorkflowDefaultCommitMessage(cwd) };
      case "/api/git-workflow/branch-name": {
        const generationId = String(body.generationId || "").trim();
        return { ok: true, data: await readGitWorkflowBranchName(cwd, { generationId, generation: tab?.gitWorkflowArtifactGeneration || null }) };
      }
      case "/api/git-workflow/pr-description": {
        const generationId = String(body.generationId || "").trim();
        return { ok: true, data: await readGitWorkflowPrDescription(cwd, { generationId, generation: tab?.gitWorkflowArtifactGeneration || null }) };
      }
      case "/api/git-workflow/init":
        return await initializeGitRepository(cwd);
      case "/api/git-workflow/init-files-status":
        return { ok: true, data: await initialRepositoryFilesStatus(cwd) };
      case "/api/git-workflow/readme":
        return prepareInitialRepositoryFiles(cwd, { repoName: body.repoName, stack: body.stack });
      case "/api/git-workflow/initial-commit":
        return await initialGitCommit(cwd);
      case "/api/git-workflow/main-branch":
        return await renameGitMainBranch(cwd);
      case "/api/git-workflow/remote":
        return await addGitOrigin(cwd, body);
      case "/api/git-workflow/init-push":
        return await pushInitialGitMain(cwd);
      case "/api/git-workflow/add":
        return gitAddAllPayload(cwd);
      case "/api/git-workflow/branch": {
        if (!tab) throw new Error("Git workflow branch worktree requires a Web UI tab");
        return { ok: true, data: await createGitWorkflowBranchWorktree(tab, body) };
      }
      case "/api/git-workflow/commit":
        return await commitGitWorkflow(cwd, body);
      case "/api/git-workflow/push":
        return await pushGitWorkflow(cwd, body);
      case "/api/git-workflow/publish":
        return await publishGitRepository(cwd, body);
      case "/api/git-workflow/create-pr":
        return await createGitWorkflowPr(cwd, body);
      case "/api/git-workflow/cancel": {
        const generationCancelled = cancelGitWorkflowGeneration(tab);
        const processCancelled = cancelGitWorkflowProcess();
        const cancelled = processCancelled || generationCancelled;
        return { ok: true, data: { cancelled } };
      }
      default:
        return undefined;
    }
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
}

function themeLabel(name) {
  return String(name || "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

async function directoryExists(dir) {
  try {
    const info = await stat(dir);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function resolveBundledThemesDir() {
  // Pi-managed packages are the user's canonical installation. Prefer them to
  // any duplicate that happens to be visible from the WebUI's npm prefix.
  const candidates = [path.join(configuredAgentNpmRoot(), "node_modules", "@firstpick", "pi-themes-bundle", "themes")];
  try {
    const manifestPath = require.resolve("@firstpick/pi-themes-bundle/package.json");
    const root = path.dirname(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const declaredThemes = Array.isArray(manifest.pi?.themes) ? manifest.pi.themes : ["./themes"];
    for (const entry of declaredThemes) {
      if (typeof entry === "string" && entry.trim()) candidates.push(path.resolve(root, entry));
    }
  } catch {
    // The bundle may live outside this package's Node resolution tree.
  }
  // In repo development the bundle may be a sibling package instead.
  candidates.push(path.resolve(packageRoot, "..", "pi-package-themes-bundle", "themes"));

  for (const candidate of candidates) {
    if (await directoryExists(candidate)) return candidate;
  }
  return null;
}

function themeHttpError(statusCode, code, message, details) {
  const error = makeHttpError(statusCode, message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function catalogTheme(theme, fileName, scope) {
  const validation = validateTheme(theme, { allowWebuiExport: scope === "bundled" });
  if (!validation.ok) throw new ThemeContractError("Theme does not satisfy the installed Pi theme contract", validation.issues);
  const native = canonicalizeTheme(theme, { allowWebuiExport: scope === "bundled" });
  if (scope === "bundled" && theme.export) {
    native.export = { ...(native.export || {}) };
    for (const [key, value] of Object.entries(theme.export)) {
      if (typeof value === "string" && !Object.hasOwn(native.export, key)) native.export[key] = value;
    }
  }
  const entry = {
    name: native.name,
    label: themeLabel(native.name),
    vars: native.vars || {},
    colors: native.colors,
    export: native.export || {},
    scope,
    custom: scope !== "bundled",
  };
  if (scope !== "bundled") entry.fileName = fileName;
  return entry;
}

function themePathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function existingThemeRoot(baseDir, segments) {
  let root;
  try {
    root = await realpath(baseDir);
  } catch {
    return null;
  }
  const confinementRoot = root;
  for (const segment of segments) {
    const candidate = path.join(root, segment);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
    root = await realpath(candidate);
    if (!themePathInside(confinementRoot, root)) return null;
  }
  return root;
}

async function ensureThemeRoot(baseDir, segments) {
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  const baseInfo = await stat(baseDir);
  if (!baseInfo.isDirectory()) throw themeHttpError(409, "THEME_UNSAFE_TARGET", "The server-derived theme base is not a directory.");
  let root = await realpath(baseDir);
  const confinementRoot = root;
  for (const segment of segments) {
    const candidate = path.join(root, segment);
    try {
      await mkdir(candidate, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw themeHttpError(409, "THEME_UNSAFE_TARGET", "The server-derived theme directory contains a symlink or non-directory component.");
    }
    root = await realpath(candidate);
    if (!themePathInside(confinementRoot, root)) {
      throw themeHttpError(409, "THEME_UNSAFE_TARGET", "The server-derived theme directory escapes its allowed root.");
    }
  }
  return root;
}

async function readThemeDirectory(baseDir, segments, scope) {
  const root = await existingThemeRoot(baseDir, segments);
  if (!root) return [];
  const entries = [];
  let files;
  try {
    files = await readdir(root);
  } catch {
    return [];
  }
  for (const fileName of files.filter((name) => name.endsWith(".json")).sort((a, b) => a.localeCompare(b))) {
    try {
      const target = path.join(root, fileName);
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      const resolved = await realpath(target);
      if (!themePathInside(root, resolved)) continue;
      entries.push(catalogTheme(JSON.parse(await readFile(resolved, "utf8")), fileName, scope));
    } catch (error) {
      console.error(`Skipping invalid ${scope} theme ${fileName}: ${sanitizeError(error)}`);
    }
  }
  return entries.sort((a, b) => a.label.localeCompare(b.label) || a.fileName.localeCompare(b.fileName));
}

async function readBundledThemes() {
  const dir = await resolveBundledThemesDir();
  if (!dir) return { source: "@firstpick/pi-themes-bundle", themes: [] };
  const themes = [];
  let backgrounds = {};
  try {
    const metadata = JSON.parse(await readFile(path.join(dir, "..", "webui-backgrounds.json"), "utf8"));
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) backgrounds = metadata;
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(`Skipping invalid bundled theme backgrounds: ${sanitizeError(error)}`);
  }
  for (const fileName of (await readdir(dir)).filter((file) => file.endsWith(".json")).sort((a, b) => a.localeCompare(b))) {
    try {
      const target = path.join(dir, fileName);
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      const entry = catalogTheme(JSON.parse(await readFile(target, "utf8")), fileName, "bundled");
      const background = Object.hasOwn(backgrounds, entry.name) ? backgrounds[entry.name] : null;
      for (const key of WEBUI_THEME_EXPORT_FIELDS) {
        if (background && typeof background[key] === "string") entry.export[key] = background[key];
      }
      themes.push(entry);
    } catch (error) {
      console.error(`Skipping invalid bundled theme ${fileName}: ${sanitizeError(error)}`);
    }
  }
  themes.sort((a, b) => a.label.localeCompare(b.label));
  return { source: "@firstpick/pi-themes-bundle", themes };
}

function customThemeRoots(tab) {
  const projectTrusted = !!tab && projectTrustDecision(tab.cwd, agentDir);
  return {
    global: { baseDir: agentDir, segments: ["themes"] },
    project: { baseDir: tab?.cwd, segments: [".pi", "themes"], trusted: projectTrusted },
  };
}

async function readThemeCatalog(tab) {
  const bundled = await readBundledThemes();
  const roots = customThemeRoots(tab);
  const globalThemes = await readThemeDirectory(roots.global.baseDir, roots.global.segments, "global");
  const projectThemes = roots.project.trusted
    ? await readThemeDirectory(roots.project.baseDir, roots.project.segments, "project")
    : [];
  const themes = [];
  const names = new Map();
  const collisions = [];
  for (const entry of [...bundled.themes, ...globalThemes, ...projectThemes]) {
    const previous = names.get(entry.name);
    if (previous) {
      collisions.push({ name: entry.name, keptScope: previous.scope, skippedScope: entry.scope });
      continue;
    }
    names.set(entry.name, entry);
    themes.push(entry);
  }
  return {
    source: bundled.source,
    themes,
    collisions,
    scopes: {
      global: { available: true },
      project: { available: !!tab, trusted: roots.project.trusted },
    },
  };
}

function requireCustomThemeJsonRequest(req) {
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw themeHttpError(415, "THEME_JSON_REQUIRED", "Custom theme saves require Content-Type: application/json.");
  const fetchSite = String(req.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    throw themeHttpError(403, "THEME_CROSS_SITE_BLOCKED", "Cross-site custom theme saves are blocked.");
  }
}

function validateCustomThemeSaveBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw themeHttpError(400, "THEME_REQUEST_INVALID", "Custom theme save body must be an object.");
  }
  const allowed = new Set(["scope", "fileName", "theme", "overwrite", "expectedMtimeMs"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw themeHttpError(400, "THEME_REQUEST_INVALID", `Unsupported custom theme save field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  if (body.scope !== "global" && body.scope !== "project") throw themeHttpError(400, "THEME_SCOPE_INVALID", "scope must be global or project.");
  let fileName;
  let theme;
  try {
    fileName = normalizeThemeFileName(body.fileName);
    theme = canonicalizeTheme(body.theme, { allowWebuiExport: true });
  } catch (error) {
    if (error instanceof ThemeContractError) throw themeHttpError(400, "THEME_INVALID", error.message, { issues: error.issues || [] });
    throw error;
  }
  if (theme.name !== themeNameFromFileName(fileName)) {
    throw themeHttpError(400, "THEME_NAME_MISMATCH", "Theme name must exactly match fileName without the .json suffix.");
  }
  if (typeof body.overwrite !== "boolean") throw themeHttpError(400, "THEME_REQUEST_INVALID", "overwrite must be a boolean.");
  if (body.expectedMtimeMs !== null && (typeof body.expectedMtimeMs !== "number" || !Number.isFinite(body.expectedMtimeMs) || body.expectedMtimeMs < 0)) {
    throw themeHttpError(400, "THEME_REQUEST_INVALID", "expectedMtimeMs must be a non-negative number or null.");
  }
  if (!body.overwrite && body.expectedMtimeMs !== null) {
    throw themeHttpError(400, "THEME_REQUEST_INVALID", "expectedMtimeMs must be null until overwrite is explicitly confirmed.");
  }
  if (body.overwrite && body.expectedMtimeMs === null) {
    throw themeHttpError(400, "THEME_REQUEST_INVALID", "An overwrite requires the target mtime returned by THEME_EXISTS.");
  }
  return { scope: body.scope, fileName, theme, overwrite: body.overwrite, expectedMtimeMs: body.expectedMtimeMs };
}

async function customThemeCollision(request, tab) {
  const bundled = await readBundledThemes();
  if (bundled.themes.some(({ name }) => name === request.theme.name)) return { scope: "bundled" };
  const roots = customThemeRoots(tab);
  for (const scope of ["global", "project"]) {
    if (scope === "project" && !roots.project.trusted) continue;
    const root = roots[scope];
    const entries = await readThemeDirectory(root.baseDir, root.segments, scope);
    for (const entry of entries) {
      if (entry.name !== request.theme.name) continue;
      if (scope === request.scope && entry.fileName === request.fileName) continue;
      if (scope === request.scope) {
        const directory = await existingThemeRoot(root.baseDir, root.segments);
        if (directory) {
          try {
            const [existingPath, requestedPath] = await Promise.all([
              realpath(path.join(directory, entry.fileName)),
              realpath(path.join(directory, request.fileName)),
            ]);
            if (existingPath === requestedPath) continue;
          } catch {
            // A missing differently-cased path is a real collision on a case-sensitive filesystem.
          }
        }
      }
      return { scope, fileName: entry.fileName };
    }
  }
  return null;
}

let customThemeMutationQueue = Promise.resolve();

function queueCustomThemeMutation(operation) {
  const result = customThemeMutationQueue.catch(() => {}).then(operation);
  customThemeMutationQueue = result.catch(() => {});
  return result;
}

async function saveCustomTheme(tab, request) {
  return queueCustomThemeMutation(async () => {
    const roots = customThemeRoots(tab);
    if (request.scope === "project" && !roots.project.trusted) {
      throw themeHttpError(403, "THEME_PROJECT_UNTRUSTED", "Project theme saves require a saved trusted-project decision in Pi.");
    }
    const collision = await customThemeCollision(request, tab);
    if (collision) {
      throw themeHttpError(409, "THEME_NAME_COLLISION", "A bundled or opposite-scope theme already uses this name.", {
        scope: collision.scope,
        ...(collision.fileName ? { fileName: collision.fileName } : {}),
      });
    }
    const selected = roots[request.scope];
    const root = await ensureThemeRoot(selected.baseDir, selected.segments);
    const target = path.join(root, request.fileName);
    if (!themePathInside(root, target)) throw themeHttpError(409, "THEME_UNSAFE_TARGET", "Theme target escapes its server-derived root.");

    let before = null;
    try {
      before = await lstat(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (before?.isSymbolicLink() || (before && !before.isFile())) {
      throw themeHttpError(409, "THEME_UNSAFE_TARGET", "The theme target is a symlink or non-file entry.");
    }
    if (before && !request.overwrite) {
      throw themeHttpError(409, "THEME_EXISTS", "The custom theme already exists and requires explicit overwrite confirmation.", {
        scope: request.scope,
        fileName: request.fileName,
        mtimeMs: before.mtimeMs,
      });
    }
    if ((!before && request.overwrite) || (before && before.mtimeMs !== request.expectedMtimeMs)) {
      throw themeHttpError(409, "THEME_CHANGED", "The custom theme changed after overwrite confirmation.", {
        scope: request.scope,
        fileName: request.fileName,
        ...(before ? { mtimeMs: before.mtimeMs } : {}),
      });
    }

    const bytes = serializeTheme(request.theme, { allowWebuiExport: false });
    const temp = path.join(root, `.${request.fileName}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;

      const verifiedRoot = await existingThemeRoot(selected.baseDir, selected.segments);
      if (verifiedRoot !== root) throw themeHttpError(409, "THEME_UNSAFE_TARGET", "Theme directory changed during save.");
      let finalState = null;
      try {
        finalState = await lstat(target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (finalState?.isSymbolicLink() || (finalState && !finalState.isFile())) {
        throw themeHttpError(409, "THEME_UNSAFE_TARGET", "The theme target changed to an unsafe entry during save.");
      }
      if ((before && (!finalState || finalState.mtimeMs !== request.expectedMtimeMs)) || (!before && finalState)) {
        throw themeHttpError(409, "THEME_CHANGED", "The custom theme changed during save.", {
          scope: request.scope,
          fileName: request.fileName,
          ...(finalState ? { mtimeMs: finalState.mtimeMs } : {}),
        });
      }
      await rename(temp, target);
    } finally {
      await handle?.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
    }
    const saved = await stat(target);
    return {
      scope: request.scope,
      fileName: request.fileName,
      themeName: request.theme.name,
      created: !before,
      overwritten: !!before,
      mtimeMs: saved.mtimeMs,
      reloadRequired: true,
    };
  });
}

const STATIC_PUBLIC_FILE_EXTENSIONS = new Set([".html", ".css", ".js", ".mjs", ".svg", ".png", ".webp", ".webmanifest"]);

function normalizeStaticPath(urlPath) {
  if (urlPath === "/") return "index.html";
  const name = urlPath.startsWith("/") ? urlPath.slice(1) : urlPath;
  // public/ is the package's explicit browser-asset boundary. Accept any safe,
  // flat asset name from it so a newly imported module cannot outrun a second
  // manually maintained server allowlist during an in-place package update.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined;
  if (!STATIC_PUBLIC_FILE_EXTENSIONS.has(path.extname(name))) return undefined;
  return name;
}

function mermaidStaticPath(urlPath) {
  const prefix = "/vendor/mermaid/";
  if (!String(urlPath || "").startsWith(prefix)) return undefined;
  const relative = urlPath.slice(prefix.length);
  if (relative === "mermaid.esm.min.mjs") return path.join(packageRoot, "node_modules", "mermaid", "dist", relative);
  if (/^chunks\/mermaid\.esm\.min\/[A-Za-z0-9._-]+\.mjs$/.test(relative)) return path.join(packageRoot, "node_modules", "mermaid", "dist", relative);
  return undefined;
}

const compressWithBrotli = promisify(brotliCompress);
const compressWithGzip = promisify(gzip);
const STATIC_COMPRESSIBLE_EXTENSIONS = new Set([".html", ".css", ".js", ".mjs", ".svg", ".json", ".webmanifest"]);
const STATIC_COMPRESSION_MIN_BYTES = 1024;
// filePath -> { mtimeMs, size, etag, raw, br, gz }; invalidated by mtime/size change.
const staticAssetCache = new Map();

async function loadStaticAsset(filePath) {
  const stats = await stat(filePath);
  const cached = staticAssetCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached;
  const raw = await readFile(filePath);
  const entry = {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    etag: `"${createHash("sha1").update(raw).digest("base64url")}"`,
    raw,
    br: null,
    gz: null,
  };
  staticAssetCache.set(filePath, entry);
  return entry;
}

function acceptedStaticEncoding(req) {
  const header = String(req.headers["accept-encoding"] || "");
  if (/\bbr\b/i.test(header)) return "br";
  if (/\bgzip\b/i.test(header)) return "gzip";
  return "";
}

function requestEtagMatches(req, etag) {
  const header = String(req.headers["if-none-match"] || "");
  if (!header) return false;
  return header.split(",").some((candidate) => candidate.trim() === etag);
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET") return false;
  const staticName = normalizeStaticPath(url.pathname);
  const filePath = staticName ? path.join(publicDir, staticName) : mermaidStaticPath(url.pathname);
  if (!filePath) return false;
  const ext = path.extname(filePath);
  const asset = await loadStaticAsset(filePath);
  const headers = {
    "content-type": MIME_TYPES.get(ext) || "application/octet-stream",
    // no-cache (unlike no-store) allows conditional revalidation via ETag/304
    // while still guaranteeing fresh content after deploys.
    "cache-control": "no-cache",
    etag: asset.etag,
    vary: "Accept-Encoding",
    "x-content-type-options": "nosniff",
  };
  if (requestEtagMatches(req, asset.etag)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  let body = asset.raw;
  if (STATIC_COMPRESSIBLE_EXTENSIONS.has(ext) && asset.raw.length >= STATIC_COMPRESSION_MIN_BYTES) {
    const encoding = acceptedStaticEncoding(req);
    if (encoding === "br") {
      asset.br ||= await compressWithBrotli(asset.raw, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: asset.raw.length,
        },
      });
      body = asset.br;
      headers["content-encoding"] = "br";
    } else if (encoding === "gzip") {
      asset.gz ||= await compressWithGzip(asset.raw, { level: 7 });
      body = asset.gz;
      headers["content-encoding"] = "gzip";
    }
  }
  headers["content-length"] = body.length;
  res.writeHead(200, headers);
  res.end(body);
  return true;
}

function requestBodyLimitForPath(pathname) {
  if (pathname === "/api/attachments") return UPLOAD_BODY_LIMIT_BYTES;
  if (pathname === "/api/files/content") return FILE_VIEWER_BODY_LIMIT_BYTES;
  if (["/api/prompt", "/api/steer", "/api/follow-up", "/api/queue/mutate"].includes(pathname)) return PROMPT_BODY_LIMIT_BYTES;
  return BODY_LIMIT_BYTES;
}

function sanitizeUploadFileName(name) {
  const base = path.basename(String(name || "attachment").replace(/\0/g, ""));
  const safe = base.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 180);
  return safe && safe !== "." && safe !== ".." ? safe : "attachment";
}

function normalizeMimeType(value) {
  const mimeType = String(value || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  return mimeType || "application/octet-stream";
}

function stripDataUrlPrefix(data) {
  const text = String(data || "").trim();
  if (!text.toLowerCase().startsWith("data:")) return text;
  const comma = text.indexOf(",");
  return comma === -1 ? text : text.slice(comma + 1);
}

function decodeCanonicalBase64(data, label) {
  const base64 = stripDataUrlPrefix(data).replace(/\s+/g, "");
  if (!base64) throw makeHttpError(400, `${label} data is required`);
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw makeHttpError(400, `${label} data must be canonical base64`);
  }
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0 || buffer.toString("base64") !== base64) {
    throw makeHttpError(400, `${label} data must be canonical base64`);
  }
  return { base64, buffer };
}

function decodeAttachmentData(data) {
  return decodeCanonicalBase64(data, "attachment").buffer;
}

async function saveUploadedAttachments(body) {
  const rawFiles = Array.isArray(body?.files) ? body.files : [];
  if (rawFiles.length === 0) throw new Error("files are required");
  if (rawFiles.length > ATTACHMENT_UPLOAD_MAX_FILES) throw new Error(`attachments are limited to ${ATTACHMENT_UPLOAD_MAX_FILES} files`);

  const decoded = [];
  let totalBytes = 0;
  for (const [index, file] of rawFiles.entries()) {
    const buffer = decodeAttachmentData(file?.data);
    if (buffer.length === 0) throw new Error(`attachment ${index + 1} is empty`);
    if (buffer.length > ATTACHMENT_UPLOAD_MAX_FILE_BYTES) throw new Error(`attachment ${index + 1} exceeds ${formatBytes(ATTACHMENT_UPLOAD_MAX_FILE_BYTES)}`);
    totalBytes += buffer.length;
    if (totalBytes > ATTACHMENT_UPLOAD_MAX_TOTAL_BYTES) throw new Error(`attachments exceed ${formatBytes(ATTACHMENT_UPLOAD_MAX_TOTAL_BYTES)} total`);
    decoded.push({
      id: String(file?.id || `attachment-${index + 1}`).slice(0, 120),
      name: sanitizeUploadFileName(file?.name),
      mimeType: normalizeMimeType(file?.mimeType || file?.type),
      size: buffer.length,
      buffer,
    });
  }

  const uploadDir = path.join(UPLOAD_TEMP_ROOT, randomUUID());
  await mkdir(uploadDir, { recursive: true });
  const saved = [];
  for (const [index, file] of decoded.entries()) {
    const fileName = `${String(index + 1).padStart(2, "0")}-${file.name}`;
    const filePath = path.join(uploadDir, fileName);
    await writeFile(filePath, file.buffer);
    saved.push({ id: file.id, name: file.name, mimeType: file.mimeType, size: file.size, path: filePath });
  }
  return { files: saved, uploadDir };
}

function normalizeRpcImages(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (value.length > ATTACHMENT_UPLOAD_MAX_FILES) throw new Error(`images are limited to ${ATTACHMENT_UPLOAD_MAX_FILES} files`);
  const images = [];
  let totalBytes = 0;
  for (const [index, image] of value.entries()) {
    const mimeType = normalizeMimeType(image?.mimeType);
    if (!RPC_IMAGE_MIME_TYPES.has(mimeType)) throw makeHttpError(400, `image ${index + 1} has unsupported MIME type ${mimeType}`);
    const { base64: data, buffer } = decodeCanonicalBase64(image?.data, `image ${index + 1}`);
    if (buffer.length > INLINE_IMAGE_MAX_BYTES) throw new Error(`image ${index + 1} exceeds ${formatBytes(INLINE_IMAGE_MAX_BYTES)} inline limit`);
    totalBytes += buffer.length;
    if (totalBytes > INLINE_IMAGE_TOTAL_MAX_BYTES) throw new Error(`inline images exceed ${formatBytes(INLINE_IMAGE_TOTAL_MAX_BYTES)} total`);
    images.push({ type: "image", data, mimeType });
  }
  return images.length ? images : undefined;
}

function attachImages(command, body) {
  const images = normalizeRpcImages(body?.images);
  if (images) command.images = images;
  return command;
}

function commandFromPost(pathname, body) {
  switch (pathname) {
    case "/api/prompt": {
      const message = String(body.message || "").trim();
      if (!message) throw new Error("message is required");
      const command = { type: "prompt", message };
      if (body.streamingBehavior === "steer" || body.streamingBehavior === "followUp") {
        command.streamingBehavior = body.streamingBehavior;
      }
      return attachImages(command, body);
    }
    case "/api/steer": {
      const message = String(body.message || "").trim();
      if (!message) throw new Error("message is required");
      return attachImages({ type: "steer", message }, body);
    }
    case "/api/follow-up": {
      const message = String(body.message || "").trim();
      if (!message) throw new Error("message is required");
      return attachImages({ type: "follow_up", message }, body);
    }
    case "/api/abort":
      return { type: "abort" };
    case "/api/bash": {
      const command = String(body.command || "").trim();
      if (!command) throw new Error("command is required");
      return { type: "bash", command, excludeFromContext: body.excludeFromContext === true };
    }
    case "/api/abort-bash":
      return { type: "abort_bash" };
    case "/api/new-session":
      return body.parentSession ? { type: "new_session", parentSession: String(body.parentSession) } : { type: "new_session" };
    case "/api/model": {
      const provider = String(body.provider || "").trim();
      const modelId = String(body.modelId || "").trim();
      if (!provider || !modelId) throw new Error("provider and modelId are required");
      return { type: "set_model", provider, modelId };
    }
    case "/api/thinking": {
      const level = String(body.level || "").trim();
      if (!THINKING_LEVELS.includes(level)) {
        throw new Error("Invalid thinking level");
      }
      return { type: "set_thinking_level", level };
    }
    case "/api/thinking-cycle":
      return { type: "cycle_thinking_level" };
    case "/api/steering-mode": {
      const mode = String(body.mode || "").trim();
      if (!["all", "one-at-a-time"].includes(mode)) throw new Error("Invalid steering mode");
      return { type: "set_steering_mode", mode };
    }
    case "/api/follow-up-mode": {
      const mode = String(body.mode || "").trim();
      if (!["all", "one-at-a-time"].includes(mode)) throw new Error("Invalid follow-up mode");
      return { type: "set_follow_up_mode", mode };
    }
    case "/api/auto-compaction":
      return { type: "set_auto_compaction", enabled: body.enabled === true };
    case "/api/compact":
      return body.customInstructions ? { type: "compact", customInstructions: String(body.customInstructions) } : { type: "compact" };
    default:
      return undefined;
  }
}

/**
 * Delta transcript support (P1-1): /api/messages?since=N serializes only the
 * tail starting at message index N plus { totalCount, since } so clients can
 * merge appended messages instead of re-downloading the whole transcript on
 * every agent event. Without ?since= the legacy full payload is returned.
 */
function applyMessagesSinceParam(response, url) {
  const sinceRaw = url.searchParams.get("since");
  if (sinceRaw === null) return;
  const messages = response?.data?.messages;
  if (!Array.isArray(messages)) return;
  const parsed = Number.parseInt(sinceRaw, 10);
  const total = messages.length;
  const since = Number.isInteger(parsed) ? Math.min(Math.max(parsed, 0), total) : 0;
  response.data = { ...response.data, messages: messages.slice(since), totalCount: total, since };
}

function commandFromGet(pathname) {
  switch (pathname) {
    case "/api/state":
      return { type: "get_state" };
    case "/api/messages":
      return { type: "get_messages" };
    case "/api/models":
      return { type: "get_available_models" };
    case "/api/commands":
      return { type: "get_commands" };
    case "/api/stats":
      return { type: "get_session_stats" };
    case "/api/last-assistant-text":
      return { type: "get_last_assistant_text" };
    default:
      return undefined;
  }
}

const candidateProbeRequested = process.argv.length === 3 && process.argv[2] === "--candidate-probe";
if (candidateProbeRequested) {
  process.stdout.write(`${JSON.stringify({ ok: true, packageName: WEBUI_PACKAGE, version: packageJson.version, piVersion: piPackageJson.version, serverEntry: fileURLToPath(import.meta.url) })}\n`);
  process.exit(0);
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${formatCliError(error)}\n`);
  usage();
  process.exit(2);
}

if (options.help) {
  usage();
  process.exit(0);
}
if (options.version) {
  console.log(packageJson.version);
  process.exit(0);
}

try {
  options.cwd = await validateStartupCwd(options.cwd);
} catch (error) {
  console.error(`Error: ${formatCliError(error)}\n`);
  usage();
  process.exit(2);
}

await initializeWebuiShellRollout({
  additionalEvidencePaths: [
    path.dirname(legacyWebuiSettingsFile()),
    path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "pi-webui"),
    path.join(path.resolve(expandUserPath(agentDir)), "webui"),
    ...[
      process.env.PI_WEBUI_FAST_PICKS_FILE,
      process.env.PI_WEBUI_OPTIONAL_FEATURE_MIGRATION_FILE,
      process.env.PI_WEBUI_RESTORE_FILE,
    ].filter(Boolean).map(filename => path.resolve(expandUserPath(filename))),
  ],
});

const { PiRpcProcess, SupervisorPiRpcProcess } = createRpcTransportTypes({
  assertNativeRpcAdmission, sanitizeError, requestTimeoutMs: REQUEST_TIMEOUT_MS,
  supervisorCommandTimeoutMaxMs: RPC_SUPERVISOR_COMMAND_TIMEOUT_MAX_MS,
});

const {
  clearSseBackpressureTimer,
  evictSlowSseClient,
  scheduleSseBackpressureTimeout,
  flushSseClient,
  writeSseFrame,
  sendSse,
  activateOutputMode,
  sendSseToClient,
} = createSseDelivery();

const {
  parseWebuiHelperResponseEvent,
  resolveWebuiHelperResponse,
  resolveWebuiHelperRpcResponse,
  webuiHelperRequestMap,
  sendWebuiHelperCommand,
} = createHelperRequestService({ makeHttpError, sanitizeError });

const {
  pendingExtensionUiMap,
  isPendingExtensionUiRequest,
  pruneExpiredPendingExtensionUiRequests,
  pendingExtensionUiRequests,
  pendingExtensionUiRequestSummaries,
  trackPendingExtensionUiRequest,
  resolvePendingExtensionUiRequest,
  clearPendingExtensionUiRequests,
  replayPendingExtensionUiRequests,
  cancelPendingExtensionUiRequests,
} = createExtensionUiRequestService({
  truncateStatusText, markTabWorking, sendSseToClient, tabActivitySnapshot, broadcastTabEvent,
});

const {
  naturalConversationStatusState,
  naturalConversationModeSnapshot,
  resetNaturalConversationMode,
  rememberNaturalConversationStatusEvent,
  isNaturalConversationActive,
  naturalConversationCommandBaseName,
  naturalConversationSlashCommandName,
  isNaturalConversationSlashCommand,
  blockNaturalConversationAction,
  ensureNaturalConversationRouteAllowed,
  ensureNaturalConversationPromptSafety,
  enforceNaturalConversationCommandAllowed,
  naturalConversationLoadedCommandNames,
  rememberNaturalConversationCommands,
  naturalConversationPackageStatus,
  naturalConversationFeatureData,
  setNaturalConversationMode,
} = createConversationModeService({
  packageName: OPTIONAL_FEATURE_PACKAGES.get(NATURAL_CONVERSATION_FEATURE_ID),
  optionalFeaturePackageStatus, getCommandData, extensionStatusMap, stripAnsi,
  makeHttpError, sanitizeError, safeRpcData, stateIsBusyForSettings, setThinkingLevelForTab,
  requestTimeoutMs: REQUEST_TIMEOUT_MS, statusRpcTimeoutMs: STATUS_RPC_TIMEOUT_MS,
});

const {
  conversationVoicesData, setConversationVoice, naturalConversationVoiceProviderStatus,
  naturalConversationUnavailableResponse, handleNaturalConversationSttTranscribe,
  handleNaturalConversationTtsSpeech,
} = createConversationVoiceService({
  naturalConversationFeatureData, naturalConversationModeSnapshot, isLocalRequest,
  makeHttpError, formatBytes, truncateStatusText,
});

const {
  codexFastModeCommandBaseName,
  codexFastModeStatusState,
  codexFastModeSnapshot,
  resetCodexFastMode,
  codexFastModePackageStatus,
  codexFastModeCommandState,
  codexFastModeFeatureData,
  waitForCodexFastModeStatus,
  setCodexFastMode,
} = createCodexFastModeService({
  packageName: OPTIONAL_FEATURE_PACKAGES.get("codexFastMode"),
  optionalFeaturePackageStatus, getCommandData, currentSessionState, tabHasActiveOutput,
  extensionStatusMap, stripAnsi, makeHttpError, sanitizeError, sleepMs,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
});

const {
  getGitRoot,
  runGitReadCommandDetailed,
  runGitReadCommand,
  readGitChanges,
  readGitFileDiff,
  readGitPanel,
  readGitCommit,
  readGitUntrackedFile,
  readWorkspaceGitStatusIndex,
  readWorkspaceGitIgnoredPaths,
  withFileTreeGitStatus,
  withFileTreeGitIgnored,
  fileTreeGitStatusPayload,
  resolveGitRelativePath,
  normalizeGitRelativePath,
  isLikelyBinaryBuffer,
  parseGitPorcelainZEntries,
  gitBranchFromPorcelainStatus,
  summarizeGitPorcelainStatus,
  gitUpstreamRef,
} = createGitReadService({
  runCommand, makeHttpError, makeUserFacingError, formatBytes, sanitizeError, formatGitCommand,
});

const gitMutations = createGitMutationService({
  runCommand, makeHttpError, makeUserFacingError, formatBytes, sanitizeError,
  formatCliError, formatCommandSpawnError, getGitRoot, runGitReadCommandDetailed,
  runGitReadCommand, readGitChanges, resolveGitRelativePath, normalizeGitRelativePath,
  isLikelyBinaryBuffer, parseGitPorcelainZEntries, gitBranchFromPorcelainStatus,
  summarizeGitPorcelainStatus, gitUpstreamRef,
});
const {
  addGitignoreEntry,
  switchGitBranch,
  pullGitChanges,
  fetchGitChanges,
  integrateGitUpstream,
  gitOperationStageFile,
  gitOperationAction,
  gitBisectAction,
  saveGitStash,
  applyGitStash,
  dropGitStash,
  stageGitFile,
  unstageGitFile,
  stageAllGitChanges,
  unstageAllGitChanges,
  discardGitFile,
  deleteGitUntrackedFile,
  undoLastGitCommit,
  amendLastGitCommitMessage,
  updateGitSubmodules,
  createGitTag,
  gitAddAllPayload,
  readGitOperationSnapshot,
  readGitStashes,
  readGitStashPreview,
  readGitUndoState,
  readGitReflog,
  readGitSubmodules,
  readGitTags,
  readGitSigningDiagnostics,
  readGitBranches,
  readGitWorkflowBranchName,
  readGitWorkflowMessages,
  readGitWorkflowDefaultCommitMessage,
  readGitWorkflowPrDescription,
  initialRepositoryFilesStatus,
  prepareInitialRepositoryFiles,
  readStagedContentHash,
  stagedContentHashForTab,
  expectedStagedContentHashFromBody,
  assertExpectedStagedContentHash,
  gitWorkflowMessageCwd,
  commitMessagePaths,
  cleanGitBranchName,
  validateGitBranchName,
  requestedRemoteRef,
  verifyRemoteGitBranchIntent,
  runGitWorkflowCommand,
  requireConfirmed,
  initializeGitRepository,
  initialGitCommit,
  renameGitMainBranch,
  addGitOrigin,
  pushInitialGitMain,
  commitGitWorkflow,
  pushGitWorkflow,
  publishGitRepository,
  createGitWorkflowPr,
  cancelGitWorkflowProcess,
} = gitMutations;

const {
  createGitWorkflowBranchWorktree,
  createGitWorktreeTab,
  openExistingGitWorktreeTab,
  removeGitWorktreeForTab,
  openGitConflictResolutionAgentTab,
  pruneGitWorktreesData,
} = createGitWorktreeSessionService({
  noSession: options.noSession,
  getGitRoot, gitMutations, formatGitCommand, makeHttpError, sanitizeError,
  configuredSessionDir, currentSessionState, tabRestorableSessionFile,
  requireAllowedSessionPath, getOpenTabs: () => tabs.values(), createTab, tabMeta,
  listTabs, scheduleSupervisorMetadataUpdate, recordEvent, markTabWorking, markTabIdle,
  promptRequestTimeoutMs: PROMPT_REQUEST_TIMEOUT_MS,
});

const {
  startGitWorkflowGeneration, consumeGitWorkflowGenerationEvent,
  replayGitWorkflowFallbackLifecycle, cancelGitWorkflowGeneration,
  loseGitWorkflowGeneration,
} = createGitGenerationService({
  getGitRoot, gitMutations, makeHttpError, sanitizeError, safeRpcData,
  currentSessionState, availableGitWorkflowModels, stateIsBusyForSettings,
  markTabWorking, markTabIdle, broadcastTabEvent, sendSseToClient,
  statusRpcTimeoutMs: STATUS_RPC_TIMEOUT_MS,
});

const {
  getFileTreeData, getFileSearchData, getFileContentData, getAurReviewReportContentData,
  saveFileContentData, deleteFileSystemEntryData, createFileSystemEntryData,
  moveFileSystemEntryData, openPathInDefaultEditor,
} = createWorkspaceFilesService({
  defaultCwd: options.cwd,
  makeHttpError, displayPath, formatBytes, sanitizeError, runCommand,
  isLikelyBinaryBuffer, getGitRoot, readWorkspaceGitStatusIndex,
  readWorkspaceGitIgnoredPaths, withFileTreeGitStatus, withFileTreeGitIgnored,
  fileTreeGitStatusPayload,
});

const {
  getAppRunnerData,
  getCustomAppRunnerConfigData,
  saveCustomAppRunner,
  saveAppRunnerSearchPaths,
  deleteCustomAppRunner,
  getAppRunnerFileBrowserData,
  startAppRunner,
  sendAppRunnerInput,
  transferAppRunnerContext,
  stopAppRunnerForTab,
  clearAppRunnerForTab,
  publicAppRunnerState,
} = createAppRunnerService({
  defaultCwd: options.cwd,
  runCommand, resolveCwd, normalizeSuggestionPath, readJsonFileIfExists,
  makeHttpError, formatCliError, sanitizeError, displayPath, stripAnsi,
  hasTab: (id) => tabs.has(id),
  broadcastTabEvent, tabActivitySnapshot, recordEvent, sendWebuiHelperCommand,
});

process.env.PI_WEBUI_HOST = options.host;
process.env.PI_WEBUI_PORT = String(options.port);
const agentRunRegistry = new AgentRunRegistry({ agentDir, port: options.port });
const AGENT_RUN_PRUNE_INTERVAL_MS = 5 * 60_000;
const AGENT_RUN_PROJECTION_DISMISSAL_RETENTION_MS = 24 * 60 * 60_000;
const AGENT_RUN_PROJECTION_DISMISSAL_LIMIT = 2_048;
const AGENT_RUN_TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);
const dismissedAgentRunProjectionKeys = new Map();
let lastAgentRunPruneAt = 0;

function agentRunProjectionKey(instance) {
  return `${instance?.parentSessionId || "external"}\0${instance?.instanceId || ""}`;
}

function agentRunProjectionCanBeDismissed(instance) {
  return AGENT_RUN_TERMINAL_STATUSES.has(instance?.status)
    || (instance?.origin === "explicit-attach" && ["stale", "lost"].includes(instance?.status));
}

function pruneDismissedAgentRunProjections(now = Date.now()) {
  for (const [key, dismissedAt] of dismissedAgentRunProjectionKeys) {
    if (!Number.isSafeInteger(dismissedAt) || now - dismissedAt > AGENT_RUN_PROJECTION_DISMISSAL_RETENTION_MS) dismissedAgentRunProjectionKeys.delete(key);
  }
  while (dismissedAgentRunProjectionKeys.size > AGENT_RUN_PROJECTION_DISMISSAL_LIMIT) {
    const oldest = dismissedAgentRunProjectionKeys.keys().next().value;
    if (oldest === undefined) break;
    dismissedAgentRunProjectionKeys.delete(oldest);
  }
}

function dismissAgentRunProjection(instance, now = Date.now()) {
  const key = agentRunProjectionKey(instance);
  dismissedAgentRunProjectionKeys.delete(key);
  dismissedAgentRunProjectionKeys.set(key, now);
  pruneDismissedAgentRunProjections(now);
}

const startupSuppressedAgentRunProjectionKeys = new Set();
try {
  const startupRegistrySnapshot = await agentRunRegistry.readRecords();
  for (const record of startupRegistrySnapshot.records) {
    if (!agentRunIsActive(record.instance)) startupSuppressedAgentRunProjectionKeys.add(agentRunProjectionKey(record.instance));
  }
} catch {
  // Registry startup is best-effort; normal reconciliation reports later availability errors.
}

const recoveryEndpointToken = String(process.env.PI_WEBUI_RECOVERY_TOKEN || "").trim() || `${randomUUID()}${randomUUID()}`;
const recoveryEndpointTokens = new Set([recoveryEndpointToken]);

function recoveryLoopbackUrl(bindHost = options.host) {
  const normalized = String(bindHost || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::" || normalized === "::1") return `http://[::1]:${options.port}${RECOVERY_ENDPOINT_PATH}`;
  if (normalized === "localhost") return `http://localhost:${options.port}${RECOVERY_ENDPOINT_PATH}`;
  if (normalized === "0.0.0.0" || normalized.startsWith("127.")) return `http://127.0.0.1:${options.port}${RECOVERY_ENDPOINT_PATH}`;
  return "";
}

function piRpcEnvironment() {
  const env = { ...process.env };
  const recoveryUrl = recoveryLoopbackUrl();
  if (recoveryUrl) {
    env.PI_WEBUI_RECOVERY_URL = recoveryUrl;
    env.PI_WEBUI_RECOVERY_TOKEN = recoveryEndpointToken;
  }
  return env;
}

await configureDevDependencyResolution();

const startupDelayMs = Number.parseInt(process.env.PI_WEBUI_START_DELAY_MS || "", 10);
delete process.env.PI_WEBUI_START_DELAY_MS;
if (Number.isFinite(startupDelayMs) && startupDelayMs > 0) {
  await delay(Math.min(startupDelayMs, 10_000));
}

const restoreTabs = await readRestoreTabsFromEnv();
const supervisorAttachCursor = readSupervisorCursorFromEnv();

function normalizedRestoreString(value, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : undefined;
}

function normalizeTabPromptDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "kind") || !Object.hasOwn(value, "path")) return null;
  if (value.kind !== "append-system" || typeof value.path !== "string") return null;
  if (!value.path || value.path.length > TAB_PROMPT_PATH_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(value.path) || !path.isAbsolute(value.path)) return null;
  return { kind: "append-system", path: value.path };
}

function appendSystemPromptDescriptor(appendSystemPromptPath) {
  return normalizeTabPromptDescriptor(appendSystemPromptPath ? { kind: "append-system", path: appendSystemPromptPath } : null);
}

function normalizeRestoreTabDescriptor(item, seenIds) {
  if (!item || typeof item !== "object") return null;
  const state = item.state && typeof item.state === "object" ? item.state : {};
  const rawId = normalizedRestoreString(item.id, 128);
  const id = rawId && /^[A-Za-z0-9._:-]+$/.test(rawId) && !seenIds.has(rawId) ? rawId : undefined;
  if (id) seenIds.add(id);

  const descriptor = {
    id,
    title: normalizedRestoreString(item.title, 160),
    titleSource: ["explicit", "auto", "default"].includes(item.titleSource) ? item.titleSource : undefined,
    cwd: normalizedRestoreString(item.cwd || item.workspace?.cwd, 4096),
    workspaceKind: item.workspaceKind ?? undefined,
    noProjectId: item.noProjectId ?? undefined,
    conversationStarted: item.conversationStarted === true,
    sessionFile: normalizedRestoreString(item.sessionFile || state.sessionFile, 4096),
  };

  if (Number.isInteger(item.index) && item.index > 0) descriptor.index = item.index;
  return descriptor;
}

async function readRestoreTabsFromEnv() {
  const restoreFile = process.env.PI_WEBUI_RESTORE_FILE;
  delete process.env.PI_WEBUI_RESTORE_FILE;
  delete process.env.PI_WEBUI_RESTORE_TABS;
  if (!restoreFile) return [];
  try {
    const items = await readRestoreFileOnce(restoreFile, agentDir);
    const seenIds = new Set();
    return items.map((item) => normalizeRestoreTabDescriptor(item, seenIds)).filter(Boolean).slice(0, RESTORE_TAB_LIMIT);
  } catch (error) {
    console.warn(`failed to read private restore descriptor: ${sanitizeError(error)}`);
    return [];
  }
}

function readSupervisorCursorFromEnv() {
  const raw = process.env.PI_WEBUI_RPC_SUPERVISOR_CURSOR;
  delete process.env.PI_WEBUI_RPC_SUPERVISOR_CURSOR;
  if (!raw) return undefined;
  try {
    const cursor = JSON.parse(raw);
    if (typeof cursor?.epoch === "string" && typeof cursor?.seq === "string") return cursor;
  } catch {
    // A malformed inherited cursor must not prevent a clean authenticated attach.
  }
  return undefined;
}

async function packageNameForResourcePath(resourcePath) {
  let canonicalResourcePath = resourcePath;
  try {
    canonicalResourcePath = await realpath(resourcePath);
  } catch {
    // Keep lexical lookup for missing or virtual resources.
  }

  let current = path.dirname(canonicalResourcePath);
  while (current && current !== path.dirname(current)) {
    if (PACKAGE_NAME_CACHE.has(current)) return PACKAGE_NAME_CACHE.get(current) || undefined;
    try {
      const pkg = JSON.parse(await readFile(path.join(current, "package.json"), "utf8"));
      const name = typeof pkg.name === "string" ? pkg.name : "";
      PACKAGE_NAME_CACHE.set(current, name);
      return name || undefined;
    } catch {
      current = path.dirname(current);
    }
  }
  return undefined;
}

async function packageRootRealpath() {
  try {
    return await realpath(packageRoot);
  } catch {
    return packageRoot;
  }
}

async function devWorkspaceRoot() {
  if (!webuiDevServer) return null;
  const envRoot = process.env.PI_NPM_PACKAGES_ROOT ? path.resolve(expandUserPath(process.env.PI_NPM_PACKAGES_ROOT)) : "";
  const candidates = [envRoot, path.dirname(packageRoot), path.dirname(await packageRootRealpath())].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const entries = await readdir(candidate, { withFileTypes: true });
      if (entries.some((entry) => entry.isDirectory() && entry.name === "pi-package-webui")) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function workspacePackageRootForName(packageName) {
  const root = await devWorkspaceRoot();
  if (!root) return null;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    // Workspace package directories use the pi-* convention. Confirm every
    // eligible sibling by its manifest name, never the folder prefix alone.
    if (!entry.isDirectory() || !entry.name.startsWith("pi-")) continue;
    const candidate = path.join(root, entry.name);
    if ((await packageNameForResourcePath(path.join(candidate, "package.json"))) === packageName) return candidate;
  }
  return null;
}

function parseNodeModulesPackageRef(manifestEntry) {
  const normalized = String(manifestEntry || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized.startsWith("node_modules/")) return null;
  const parts = normalized.slice("node_modules/".length).split("/").filter(Boolean);
  if (!parts.length) return null;
  const scoped = parts[0].startsWith("@");
  const packageName = scoped ? `${parts[0]}/${parts[1] || ""}` : parts[0];
  if (!packageName || packageName.endsWith("/")) return null;
  const subpath = parts.slice(scoped ? 2 : 1).join("/");
  return { packageName, subpath };
}

async function resolveStartedWebuiManifestResource(manifestEntry) {
  const nodeModulesRef = parseNodeModulesPackageRef(manifestEntry);
  if (nodeModulesRef && WEBUI_RESOURCE_EXCLUDED_PACKAGES.has(nodeModulesRef.packageName)) {
    const installedCandidate = await resolveInstalledPackageSubpath(nodeModulesRef.packageName, nodeModulesRef.subpath);
    if (installedCandidate) return installedCandidate;
  }

  const candidate = path.resolve(packageRoot, manifestEntry);
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

async function startedWebuiResourcePaths(resourceType) {
  const entries = Array.isArray(packageJson.pi?.[resourceType]) ? packageJson.pi[resourceType] : [];
  const resolved = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const resourcePath = await resolveStartedWebuiManifestResource(entry);
    if (resourcePath) resolved.push(resourcePath);
  }
  return resolved;
}

function piArgsDisableResourceDiscovery(resourceType) {
  const flags = {
    extensions: new Set(["--no-extensions", "-ne"]),
    skills: new Set(["--no-skills", "-ns"]),
    prompts: new Set(["--no-prompt-templates", "-np"]),
    themes: new Set(["--no-themes"]),
  }[resourceType];
  return !!flags && options.piArgs.some((arg) => flags.has(arg));
}

async function resolvedNormalPiResourcesForTab(cwd) {
  try {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    return await packageManager.resolve(async () => "skip");
  } catch (error) {
    console.warn(`failed to resolve configured Pi resources for Web UI tab: ${sanitizeError(error)}`);
    return { extensions: [], skills: [], prompts: [], themes: [] };
  }
}

async function normalPiResourcePathsForTab(resolved, resourceType) {
  if (piArgsDisableResourceDiscovery(resourceType)) return [];
  const resourcePaths = [];
  const auditExcludedPackages = optionalFeatureAuditCoordinator?.excludedPackageNames?.() || new Set();
  const coreOnly = optionalFeatureAuditCoordinator?.current?.().phase === "checking" || optionalFeatureAuditCoordinator?.current?.().phase === "degraded";
  for (const resource of resolved[resourceType] || []) {
    if (!resource.enabled) continue;
    const packageName = await packageNameForResourcePath(resource.path);
    if (packageName && WEBUI_RESOURCE_EXCLUDED_PACKAGES.has(packageName)) continue;
    if (packageName && auditExcludedPackages.has(packageName)) {
      if (coreOnly || resource.metadata?.origin !== "package") continue;
    }
    resourcePaths.push(resource.path);
  }
  return resourcePaths;
}

function appendResourceArgs(args, flag, resourcePaths) {
  for (const resourcePath of resourcePaths) args.push(flag, resourcePath);
}

async function appendCuratedResourceArgs(args, normalResources, resourceType, flag) {
  appendResourceArgs(args, flag, await normalPiResourcePathsForTab(normalResources, resourceType));
  appendResourceArgs(args, flag, await startedWebuiResourcePaths(resourceType));
}

function globalPiAppendSystemPromptPath() {
  return path.join(homedir(), ".pi", "agent", "APPEND_SYSTEM.md");
}

function isGlobalPiAppendSystemPromptPath(value) {
  return value === globalPiAppendSystemPromptPath();
}

async function validatePersistedAppendSystemSelection(settings) {
  if (!settings.appendSystemPromptPath || !settings.appendSystemPromptRootPath) return null;
  if (isGlobalPiAppendSystemPromptPath(settings.appendSystemPromptPath)) return null;
  return validateSavedAppendSystemSelection(
    settings.appendSystemPromptPath,
    settings.appendSystemPromptRootPath,
  );
}

async function selectedAppendSystemPromptPath() {
  let settings;
  try {
    settings = await readWebuiSettings();
  } catch (error) {
    console.warn(`failed to read the saved APPEND_SYSTEM.md selection: ${sanitizeError(error)}`);
    return null;
  }
  if (!settings.appendSystemPromptPath || isGlobalPiAppendSystemPromptPath(settings.appendSystemPromptPath)) return null;
  const validated = await validatePersistedAppendSystemSelection(settings);
  if (validated) return validated.path;
  console.warn(`Skipping unavailable saved APPEND_SYSTEM.md selection: ${settings.appendSystemPromptPath.slice(0, 4_096)}`);
  return null;
}

async function buildPiLaunchForTab(tabIndex, title, tabCwd = options.cwd, workspaceKind) {
  const args = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"];
  if (options.noSession) args.push("--no-session");

  const normalResources = await resolvedNormalPiResourcesForTab(tabCwd);
  await appendCuratedResourceArgs(args, normalResources, "extensions", "--extension");
  await appendCuratedResourceArgs(args, normalResources, "skills", "--skill");
  await appendCuratedResourceArgs(args, normalResources, "prompts", "--prompt-template");
  await appendCuratedResourceArgs(args, normalResources, "themes", "--theme");

  // The package manifest is resolved above, but keep session-summary explicit:
  // curated child discovery intentionally excludes package-owned resources in
  // some installations. Avoid a duplicate when the manifest path was retained.
  if (!args.includes(sessionSummaryExtensionPath)) args.push("--extension", sessionSummaryExtensionPath);

  // Load a browser-safe RPC helper into every Web UI tab. It exposes hidden
  // extension commands for Web UI-native /tools and /skills selectors without
  // depending on TUI-only extension UIs.
  args.push("--extension", webuiHelperExtensionPath);

  const appendSystemPromptPath = await selectedAppendSystemPromptPath();
  if (appendSystemPromptPath) args.push("--append-system-prompt", appendSystemPromptPath);

  // Keep tab naming inside Web UI metadata. Some bundled Pi CLI versions do not
  // support --name, and passing Web UI-generated tab titles through to child
  // RPC processes makes every tab after the first exit immediately.
  args.push(...(workspaceKind === "no-project" ? noProjectPiArgs(options.piArgs) : options.piArgs));
  return { args, prompt: appendSystemPromptDescriptor(appendSystemPromptPath) };
}

function isNodeScriptCommand(command) {
  return [".cjs", ".js", ".mjs"].includes(path.extname(String(command || "")).toLowerCase());
}

async function resolvedPiCliScript() {
  const packagePathParts = PI_CODING_AGENT_PACKAGE.split("/").filter(Boolean);
  const searchRoots = require.resolve.paths(PI_CODING_AGENT_PACKAGE) || [];
  for (const nodeModulesRoot of searchRoots) {
    const cliPath = path.join(nodeModulesRoot, ...packagePathParts, "dist", "cli.js");
    try {
      await access(cliPath);
      return cliPath;
    } catch {
      // Continue through Node's resolution roots; global npm installs can hoist
      // pi-coding-agent beside pi-package-webui instead of nesting it.
    }
  }
  return "";
}

function resolveSelectedPiCommand(piArgs) {
  const invocation = resolvePiCommandInvocation(options.piBin, piArgs);
  return {
    command: invocation.command,
    args: invocation.args,
    displayCommand: formatCommandForDisplay(invocation.command, invocation.args),
  };
}

let canonicalPiRuntimePromise = null;
let canonicalPiRuntimeProbeVersion = null;

async function canonicalPiRuntimeIdentity({ force = false, probeVersion = true } = {}) {
  if (force || canonicalPiRuntimeProbeVersion !== probeVersion) canonicalPiRuntimePromise = null;
  if (!canonicalPiRuntimePromise) {
    canonicalPiRuntimeProbeVersion = probeVersion;
    canonicalPiRuntimePromise = (async () => resolveCanonicalPiRuntime({
      explicitCommand: options.piBinExplicit ? options.piBin : "",
      bundledCli: await resolvedPiCliScript(),
      pathCommand: options.piBin || "pi",
      runCommand,
      timeoutMs: 10_000,
      probeVersion,
    }))().catch((error) => {
      canonicalPiRuntimePromise = null;
      throw error;
    });
  }
  return canonicalPiRuntimePromise;
}

function invalidateCanonicalPiRuntime() {
  canonicalPiRuntimePromise = null;
  canonicalPiRuntimeProbeVersion = null;
}

async function resolvePiCommand(piArgs) {
  const resolution = await canonicalPiRuntimeIdentity({ probeVersion: false });
  const active = resolution.active;
  if (!active) throw new Error(resolution.refusal?.message || "No supported active Pi runtime could be verified.");
  const args = [...(active.invocation?.args || []), ...piArgs];
  return {
    command: active.invocation.command,
    args,
    displayCommand: formatCommandForDisplay(active.invocation.command, args),
  };
}

const tabs = new Map();
const closedRestorableTabs = [];
let nextTabIndex = 1;
let rpcSupervisor = null;
let rpcSupervisorSnapshot = null;
let rpcSupervisorEventUnsubscribe = null;
let rpcSupervisorSequenceState = null;
let workspaceLoadInProgress = false;

function markRpcSupervisorDiscontinuity(reason) {
  if (!rpcSupervisorSnapshot) return;
  const message = String(reason || "unknown discontinuity");
  rpcSupervisorSnapshot.gap = true;
  const state = rpcSupervisorSequenceState;
  const previousSize = state?.discontinuities.size || 0;
  state?.discontinuities.add(message);
  if (state?.startupComplete && state.discontinuities.size > previousSize && !state.recoveryScheduled) {
    state.recoveryScheduled = true;
    queueMicrotask(async () => {
      await Promise.all([...tabs.values()].flatMap((tab) => [
        safeRpcData(tab, { type: "get_state" }).catch(() => {}),
        safeRpcData(tab, { type: "get_messages" }).catch(() => {}),
      ]));
      for (const tab of tabs.values()) {
        broadcastTabEvent(tab, {
          type: "webui_supervisor_replay_gap",
          tabId: tab.id,
          tabTitle: tab.title,
          reason: message,
          ...rpcSupervisorBrowserState(),
        });
      }
      state.recoveryScheduled = false;
    });
  }
}

function validateRpcSupervisorEvent(event) {
  const state = rpcSupervisorSequenceState;
  if (!state) return true;
  const sequenceText = String(event?.seq ?? "");
  if (event?.type !== "event" || event.scopeId !== state.scopeId || event.epoch !== state.epoch || !/^[1-9]\d*$/.test(sequenceText)) {
    markRpcSupervisorDiscontinuity("malformed or mismatched supervisor event envelope");
    return false;
  }
  const sequence = BigInt(sequenceText);
  if (state.lastSequence !== null) {
    if (sequence <= state.lastSequence) {
      markRpcSupervisorDiscontinuity(`duplicate or out-of-order supervisor sequence ${sequenceText}`);
      return false;
    }
    if (sequence !== state.lastSequence + 1n) {
      markRpcSupervisorDiscontinuity(`missing supervisor sequence before ${sequenceText}`);
    }
  }
  state.lastSequence = sequence;
  return true;
}

function dispatchRpcSupervisorEvent(event) {
  if (!validateRpcSupervisorEvent(event)) return;
  const tab = tabs.get(event.tabId);
  if (!tab) {
    markRpcSupervisorDiscontinuity(`supervisor event ${event.seq} targeted an unknown tab`);
    return;
  }
  tab.rpc.receiveSupervisorEvent?.(event);
}

function installRpcSupervisorEventDispatch(snapshot) {
  if (!rpcSupervisor || !snapshot) return;
  const attachSequence = supervisorAttachCursor?.epoch === snapshot.epoch && snapshot.gap !== true
    ? BigInt(supervisorAttachCursor.seq)
    : snapshot.latestSeq === "0" ? 0n : null;
  rpcSupervisorSequenceState = {
    scopeId: snapshot.scopeId,
    epoch: snapshot.epoch,
    lastSequence: attachSequence,
    discontinuities: new Set(snapshot.gap === true ? ["supervisor reported a replay gap"] : []),
    startupComplete: false,
    recoveryScheduled: false,
  };
  rpcSupervisorEventUnsubscribe = rpcSupervisor.onEvent(dispatchRpcSupervisorEvent);
}

function finishRpcSupervisorReplay(snapshot) {
  if (!snapshot || !rpcSupervisorSequenceState) return;
  const latestSequence = BigInt(snapshot.latestSeq);
  const observed = rpcSupervisorSequenceState.lastSequence;
  if (observed === null) {
    if (latestSequence > 0n) markRpcSupervisorDiscontinuity("retained replay did not include the supervisor latest sequence");
  } else if (observed !== latestSequence) {
    markRpcSupervisorDiscontinuity(`retained replay ended at ${observed} instead of ${latestSequence}`);
  }
  // A known replay gap is repaired authoritatively. Resume continuity checks
  // from the attach snapshot boundary before draining attach-window events.
  rpcSupervisorSequenceState.lastSequence = latestSequence;
}

async function finishRpcSupervisorStartup(initialTabs) {
  if (!rpcSupervisor || !rpcSupervisorSnapshot) return;
  finishRpcSupervisorReplay(rpcSupervisorSnapshot);
  rpcSupervisor.drainStartupEvents();
  if (rpcSupervisorSnapshot.tabs?.length) {
    await Promise.all(initialTabs.map((tab) => primeTabRpc(tab).catch(() => {})));
  }
  if (rpcSupervisorSnapshot.gap === true) {
    await Promise.all(initialTabs.flatMap((tab) => [
      safeRpcData(tab, { type: "get_state" }).catch(() => {}),
      safeRpcData(tab, { type: "get_messages" }).catch(() => {}),
    ]));
    recordEvent({
      type: "webui_supervisor_replay_gap",
      tabCount: initialTabs.length,
      reason: [...(rpcSupervisorSequenceState?.discontinuities || [])].join("; "),
    });
  }
  rpcSupervisorSequenceState.startupComplete = true;
}

function rpcSupervisorDisabled() {
  return ["0", "false", "no", "off"].includes(String(process.env.PI_WEBUI_RPC_SUPERVISOR || "").trim().toLowerCase());
}

async function initializeRpcSupervisor() {
  if (rpcSupervisorDisabled()) {
    const paths = await supervisorPaths({ agentDir, port: options.port });
    const state = await readSupervisorState(paths);
    if (state?.tabs?.length) {
      throw new Error("PI_WEBUI_RPC_SUPERVISOR is disabled but this WebUI scope still has managed Pi tabs; use /api/shutdown before starting direct mode.");
    }
    return null;
  }
  return discoverStartAttachRpcSupervisor({
    agentDir,
    port: options.port,
    cursor: supervisorAttachCursor,
    // The detached host inherits only the existing Pi child environment. Keep
    // recovery routing available without persisting it in supervisor metadata.
    environment: piRpcEnvironment(),
  });
}

function supervisedTabMetadata(tab, { cwd = tab.cwd, prompt = tab.prompt, workspaceKind = tab.workspaceKind, noProjectId = tab.noProjectId } = {}) {
  return {
    index: tab.index,
    title: tab.title,
    titleSource: tab.titleSource,
    conversationStarted: tab.conversationStarted === true,
    cwd,
    workspaceKind,
    noProjectId,
    sessionFile: tabRestorableSessionFile(tab),
    gitWorkspace: tab.gitWorkspace || null,
    createdAt: tab.createdAt,
    prompt: normalizeTabPromptDescriptor(prompt),
    featureSystemPromptDetected: featureSystemPromptDetected(tab),
  };
}

function scheduleSupervisorMetadataUpdate(tab) {
  if (!(tab?.rpc instanceof SupervisorPiRpcProcess)) return;
  if (tab.cwdChangeInProgress) return;
  if (tab.supervisorMetadataUpdateQueued) return;
  tab.supervisorMetadataUpdateQueued = true;
  queueMicrotask(() => {
    tab.supervisorMetadataUpdateQueued = false;
    if (!(tab.rpc instanceof SupervisorPiRpcProcess) || !tabs.has(tab.id)) return;
    void tab.rpc.updateMetadata(supervisedTabMetadata(tab)).catch((error) => {
      console.warn(`failed to update managed Pi tab metadata: ${sanitizeError(error)}`);
    });
  });
}

function rpcSupervisorDiagnostics() {
  if (!rpcSupervisor) return { enabled: false, attached: false, managedTabCount: 0 };
  return {
    enabled: true,
    attached: rpcSupervisor.isConnected(),
    managedTabCount: tabs.size,
  };
}

function rpcSupervisorBrowserState() {
  if (!rpcSupervisor || !rpcSupervisorSnapshot) return {};
  return {
    supervisorScopeId: rpcSupervisorSnapshot.scopeId,
    supervisorEpoch: rpcSupervisorSnapshot.epoch,
    supervisorReplayGap: rpcSupervisorSnapshot.gap === true,
  };
}

async function prepareRpcSupervisorHandoff() {
  if (!rpcSupervisor) return undefined;
  const handoff = await rpcSupervisor.prepareHandoff();
  return { epoch: handoff.epoch, seq: handoff.latestSeq };
}

async function detachRpcSupervisor() {
  if (!rpcSupervisor) return;
  try {
    if (rpcSupervisor.isConnected()) await rpcSupervisor.detach();
  } finally {
    rpcSupervisorEventUnsubscribe?.();
    rpcSupervisorEventUnsubscribe = null;
    rpcSupervisor.close();
    rpcSupervisor = null;
  }
}
const TAB_ACTIVITY_IDLE_RECONCILE_GRACE_MS = 1200;
const TAB_ACTIVITY_STATE_RECONCILE_INTERVAL_MS = 2500;
const TAB_ACTIVITY_STATE_RECONCILE_TIMEOUT_MS = 1200;

function sessionFileFromState(state) {
  return state && typeof state === "object" ? normalizedRestoreString(state.sessionFile, 4096) : undefined;
}

function rememberTabState(tab, state) {
  if (!tab || !state || typeof state !== "object") return;
  tab.lastState = state;
  if (!options.noSession && Object.prototype.hasOwnProperty.call(state, "sessionFile")) tab.sessionFile = sessionFileFromState(state);
  scheduleSupervisorMetadataUpdate(tab);
}

function patchTabState(tab, patch) {
  if (!tab || !patch || typeof patch !== "object") return;
  tab.lastState = { ...(tab.lastState || {}), ...patch };
}

function stateWithPendingThinking(tab, state) {
  if (!state || typeof state !== "object") return state;
  const queueLength = tab ? compactionQueueForTab(tab).length : 0;
  if (!tab?.pendingThinkingLevel && queueLength === 0) return state;
  const patch = {};
  if (tab?.pendingThinkingLevel) patch.pendingThinkingLevel = tab.pendingThinkingLevel;
  if (queueLength > 0) patch.pendingMessageCount = Number(state.pendingMessageCount || 0) + queueLength;
  return { ...state, ...patch };
}

function responseWithPendingThinking(tab, response) {
  if (!response || typeof response !== "object" || response.success === false || response.command !== "get_state") return response;
  return { ...response, data: stateWithPendingThinking(tab, response.data) };
}

function eventForTabClients(tab, event) {
  const decorated = event?.type === "queue_update" ? { ...event, source: "pi-runtime" } : event;
  return {
    ...rewriteArtifactsForTab(tab, responseWithPendingThinking(tab, decorated)),
    tabId: tab.id,
    tabTitle: tab.title,
    tabActivity: tabActivitySnapshot(tab),
  };
}

function broadcastPendingThinkingState(tab, state) {
  broadcastTabEvent(tab, {
    ...eventForTabClients(tab, { type: "response", command: "get_state", success: true, data: stateWithPendingThinking(tab, state) }),
    pendingExtensionUiRequestCount: pendingExtensionUiRequests(tab).length,
  });
}

function forgetTabState(tab) {
  if (!tab) return;
  tab.lastState = null;
  tab.sessionFile = undefined;
  tab.pendingThinkingLevel = undefined;
  scheduleSupervisorMetadataUpdate(tab);
}

function tabRestorableSessionFile(tab) {
  if (options.noSession) return undefined;
  return normalizedRestoreString(tab?.sessionFile || tab?.lastState?.sessionFile, 4096);
}

function createTabActivity(now = new Date().toISOString()) {
  return {
    status: "idle",
    isWorking: false,
    runStarted: false,
    // Opaque server-issued identity for the current/recent parent turn. It is
    // deliberately separate from subagent/workflow IDs and contains no prompt,
    // title, cwd, or user-derived data.
    runId: null,
    completionSerial: 0,
    lastChangedAt: now,
    lastStartedAt: null,
    lastCompletedAt: null,
  };
}

function resetTabActivity(tab) {
  tab.activity = createTabActivity();
}

function tabActivitySnapshot(tab) {
  return { ...(tab.activity || createTabActivity(tab.createdAt)) };
}

function extensionStatusMap(tab) {
  if (!tab.extensionStatuses) tab.extensionStatuses = new Map();
  return tab.extensionStatuses;
}

function featureSystemPromptDetected(tab) {
  const statuses = extensionStatusMap(tab);
  return [...REPLAYABLE_CLEARED_EXTENSION_STATUS_KEYS].some((statusKey) => statuses.has(statusKey));
}

function restoreFeatureSystemPromptDetection(tab, detected) {
  if (!detected) return;
  const statuses = extensionStatusMap(tab);
  for (const statusKey of REPLAYABLE_CLEARED_EXTENSION_STATUS_KEYS) statuses.set(statusKey, undefined);
}

function isGuidedGitWorkflowCommandMessage(message) {
  return GUIDED_GIT_COMMAND_MESSAGE.test(String(message || "").trim());
}

function prunePendingGuidedGitLaunch(tab, nowMs = Date.now()) {
  const pending = tab?.guidedGitPendingLaunch;
  if (pending && nowMs - pending.acceptedAt > GUIDED_GIT_LAUNCH_TTL_MS) tab.guidedGitPendingLaunch = null;
  return tab?.guidedGitPendingLaunch || null;
}

function clearPendingGuidedGitLaunch(tab, launchId) {
  if (!tab?.guidedGitPendingLaunch) return;
  if (!launchId || tab.guidedGitPendingLaunch.launchId === launchId) tab.guidedGitPendingLaunch = null;
}

function validGuidedGitStartStatusText(statusText) {
  if (typeof statusText !== "string" || !statusText || Buffer.byteLength(statusText, "utf8") > 1024) return false;
  try {
    const payload = JSON.parse(statusText);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const keys = Object.keys(payload).sort();
    if (keys.length !== 4 || keys.join(",") !== "action,requestId,type,version") return false;
    return payload.type === GUIDED_GIT_START_PAYLOAD_TYPE
      && payload.version === GUIDED_GIT_START_PAYLOAD_VERSION
      && payload.action === "start"
      && GUIDED_GIT_UUID_V4.test(String(payload.requestId || ""));
  } catch {
    return false;
  }
}

function scopedGuidedGitLaunchEvent(tab, event, nowMs = Date.now()) {
  if (event?.type !== "extension_ui_request" || event.method !== "setStatus" || event.statusKey !== GUIDED_GIT_START_STATUS_KEY) return event;
  if (!event.statusText) {
    clearPendingGuidedGitLaunch(tab);
    return event;
  }
  if (!validGuidedGitStartStatusText(event.statusText)) return event;
  const pending = prunePendingGuidedGitLaunch(tab, nowMs);
  if (!pending) return event;
  tab.guidedGitPendingLaunch = null;
  return { ...event, guidedGitLaunchId: pending.launchId };
}

async function authoritativeGuidedGitLaunchAdmission(tab, { launchId = "", reserve = false } = {}) {
  const pending = prunePendingGuidedGitLaunch(tab);
  if (pending) throw makeHttpError(409, "A Guided Git activation is already pending for this tab.");
  if (reserve && !GUIDED_GIT_UUID_V4.test(String(launchId || ""))) throw makeHttpError(400, "guidedGitLaunchId must be a UUID v4");
  const state = await currentSessionState(tab);
  if (state.isStreaming) throw makeHttpError(409, "Wait for the current agent run to finish before starting Guided Git.");
  if (state.isCompacting) throw makeHttpError(409, "Wait for compaction to finish before starting Guided Git.");
  if (Number(state.pendingMessageCount || 0) > 0 || compactionQueueForTab(tab).length > 0) {
    throw makeHttpError(409, "Wait for pending messages to finish before starting Guided Git.");
  }
  if (prunePendingGuidedGitLaunch(tab)) throw makeHttpError(409, "A Guided Git activation is already pending for this tab.");
  if (reserve) tab.guidedGitPendingLaunch = { launchId, acceptedAt: Date.now() };
  return { admitted: true };
}

function extensionWidgetMap(tab) {
  if (!tab.extensionWidgets) tab.extensionWidgets = new Map();
  return tab.extensionWidgets;
}

function rememberExtensionStatusEvent(tab, event) {
  if (event?.type !== "extension_ui_request" || event.method !== "setStatus" || !event.statusKey) return;
  const statuses = extensionStatusMap(tab);
  const statusKey = String(event.statusKey);
  const featureWasDetected = featureSystemPromptDetected(tab);
  if (event.statusText) statuses.set(statusKey, String(event.statusText));
  else if (REPLAYABLE_CLEARED_EXTENSION_STATUS_KEYS.has(statusKey)) statuses.set(statusKey, undefined);
  else statuses.delete(statusKey);
  if (!featureWasDetected && featureSystemPromptDetected(tab)) scheduleSupervisorMetadataUpdate(tab);
}

function rememberExtensionWidgetEvent(tab, event) {
  if (event?.type !== "extension_ui_request" || event.method !== "setWidget") return;
  const widgetKey = event.widgetKey || event.id;
  if (!widgetKey) return;
  const widgets = extensionWidgetMap(tab);
  if (Array.isArray(event.widgetLines)) widgets.set(String(widgetKey), { ...event, widgetKey: String(widgetKey), widgetLines: event.widgetLines.map((line) => String(line)) });
  else widgets.delete(String(widgetKey));
}

function clearExtensionStatuses(tab) {
  tab?.extensionStatuses?.clear();
}

function clearExtensionWidgets(tab) {
  tab?.extensionWidgets?.clear();
}

function normalizedSessionSummaryTitle(value) {
  if (typeof value !== "string" || value.length > SESSION_SUMMARY_TITLE_MAX_CHARS) return "";
  const title = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return title.length <= SESSION_SUMMARY_TITLE_MAX_CHARS ? title : "";
}

function normalizedSessionSummaryRpcDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== SESSION_SUMMARY_PROTOCOL_VERSION) return null;
  const kind = String(value.kind || "");
  if (!SESSION_SUMMARY_KINDS.has(kind)) return null;
  const details = { version: SESSION_SUMMARY_PROTOCOL_VERSION, kind };
  if (value.sessionId !== undefined) {
    if (typeof value.sessionId !== "string" || value.sessionId.length > 128) return null;
    details.sessionId = value.sessionId;
  }
  if (value.title !== undefined) {
    const title = normalizedSessionSummaryTitle(value.title);
    if (!title) return null;
    details.title = title;
  }
  if (value.summaryMarkdown !== undefined) {
    if (typeof value.summaryMarkdown !== "string" || !value.summaryMarkdown.trim() || value.summaryMarkdown.length > SESSION_SUMMARY_MARKDOWN_MAX_CHARS) return null;
    details.summaryMarkdown = value.summaryMarkdown.trim();
  }
  if (value.message !== undefined) {
    if (typeof value.message !== "string" || value.message.length > SESSION_SUMMARY_FAILURE_MAX_CHARS) return null;
    details.message = value.message.replace(/[\r\n]+/g, " ").trim();
  }
  for (const key of ["configured", "enabled", "durable"]) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") return null;
      details[key] = value[key];
    }
  }
  if ((kind === "success" && !details.summaryMarkdown) || (kind === "failure" && !details.message) || (kind === "title" && !details.title)) return null;
  return details;
}

function publicSessionSummaryState(tab) {
  const value = tab?.sessionSummary;
  if (!value) return null;
  return {
    version: SESSION_SUMMARY_PROTOCOL_VERSION,
    status: value.status || "idle",
    configured: value.configured === true,
    enabled: value.enabled === true,
    durable: value.durable === true,
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    ...(value.title ? { title: value.title } : {}),
    ...(value.summaryMarkdown ? { summaryMarkdown: value.summaryMarkdown } : {}),
    ...(value.message ? { message: value.message } : {}),
    updatedAt: value.updatedAt || new Date(0).toISOString(),
  };
}

function broadcastSessionSummaryState(tab, kind) {
  broadcastTabEvent(tab, {
    type: "webui_session_summary",
    kind,
    tabId: tab.id,
    tabTitle: tab.title,
    summary: publicSessionSummaryState(tab),
  });
}

function applySessionSummaryRpcDetails(tab, details) {
  const previous = tab.sessionSummary?.sessionId && details.sessionId && tab.sessionSummary.sessionId !== details.sessionId
    ? null
    : tab.sessionSummary;
  const next = {
    version: SESSION_SUMMARY_PROTOCOL_VERSION,
    status: previous?.status || "idle",
    configured: previous?.configured === true,
    enabled: previous?.enabled === true,
    durable: previous?.durable === true,
    sessionId: details.sessionId || previous?.sessionId || "",
    title: previous?.title || "",
    summaryMarkdown: previous?.summaryMarkdown || "",
    message: "",
    updatedAt: new Date().toISOString(),
  };
  if (details.configured !== undefined) next.configured = details.configured;
  if (details.enabled !== undefined) next.enabled = details.enabled;
  if (details.durable !== undefined) next.durable = details.durable;
  if (details.kind === "state") {
    next.status = details.summaryMarkdown ? "success" : "idle";
    next.title = details.title || "";
    next.summaryMarkdown = details.summaryMarkdown || "";
  } else if (details.kind === "setup") {
    next.status = "idle";
  } else if (details.kind === "generating") {
    next.status = "generating";
  } else if (details.kind === "success") {
    next.status = "success";
    next.title = details.title || next.title;
    next.summaryMarkdown = details.summaryMarkdown;
  } else if (details.kind === "failure") {
    next.status = "failure";
    next.message = details.message;
  } else if (details.kind === "title") {
    next.title = details.title;
    if (tab.titleSource === "default" || tab.titleSource === "auto") {
      renameTab(tab, details.title, { source: "auto", maxLength: SESSION_SUMMARY_TITLE_MAX_CHARS });
    }
  }
  tab.sessionSummary = next;
  broadcastSessionSummaryState(tab, details.kind);
}

function consumeSessionSummaryRpcEvent(tab, event) {
  const message = event?.message;
  if ((event?.type !== "message_start" && event?.type !== "message_end") || message?.role !== "custom") return false;
  if (message.customType === SESSION_SUMMARY_DISPLAY_TYPE) return true;
  if (message.customType !== SESSION_SUMMARY_RPC_TYPE) return false;
  if (event.type === "message_end") {
    const details = normalizedSessionSummaryRpcDetails(message.details);
    if (details) applySessionSummaryRpcDetails(tab, details);
  }
  return true;
}

function filterSessionSummaryTranscriptMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter((message) => !(
    message?.role === "custom" && (message.customType === SESSION_SUMMARY_RPC_TYPE || message.customType === SESSION_SUMMARY_DISPLAY_TYPE)
  ));
}

function clearWebuiSubagents(tab) {
  if (!tab) return;
  tab.webuiSubagents = null;
  tab.webuiAgentRuns = null;
}

function normalizeWebuiSubagentText(value, maxLength = 240) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : "";
}

function normalizeWebuiSubagentSource(value) {
  return ["foreground", "workflow", "recovered"].includes(value) ? value : "async";
}

function normalizeWebuiSubagentFleet(value) {
  if (!value || typeof value !== "object" || value.version !== 1) return null;
  const totalActive = Number.isSafeInteger(value.totalActive) && value.totalActive >= 0 ? value.totalActive : -1;
  const omitted = Number.isSafeInteger(value.omitted) && value.omitted >= 0 ? value.omitted : -1;
  if (totalActive < 0 || omitted < 0 || omitted > totalActive) return null;
  return { version: 1, totalActive, omitted };
}

function agentRunIsActive(value) {
  return ["queued", "running"].includes(value?.status);
}

function normalizeWebuiSubagentPayload(value) {
  if (!value || typeof value !== "object" || value.version !== 1) return null;
  const runs = [];
  for (const rawRun of Array.isArray(value.runs) ? value.runs.slice(0, WEBUI_SUBAGENT_RUN_LIMIT) : []) {
    if (!rawRun || typeof rawRun !== "object") continue;
    const id = normalizeWebuiSubagentText(rawRun.id, 160);
    if (!id) continue;
    const status = ["running", "done", "failed", "cancelled"].includes(rawRun.status) ? rawRun.status : "running";
    const agents = [];
    for (const rawAgent of Array.isArray(rawRun.agents) ? rawRun.agents.slice(0, WEBUI_SUBAGENT_AGENT_LIMIT) : []) {
      const name = normalizeWebuiSubagentText(rawAgent?.name, 160);
      const agentStatus = ["running", "done", "failed", "cancelled"].includes(rawAgent?.status)
        ? rawAgent.status
        : status === "cancelled" ? "cancelled" : status === "running" ? "running" : "done";
      if (!name || (status === "running" && agentStatus !== "running")) continue;
      agents.push({
        id: normalizeWebuiSubagentText(rawAgent.id || `${id}:${agents.length}`, 240),
        name,
        status: agentStatus,
        index: Number.isInteger(rawAgent.index) ? rawAgent.index : agents.length,
        currentTool: normalizeWebuiSubagentText(rawAgent.currentTool, 120) || undefined,
        activityState: normalizeWebuiSubagentText(rawAgent.activityState, 80) || undefined,
        model: normalizeWebuiSubagentText(rawAgent.model, 240) || undefined,
        thinking: normalizeWebuiSubagentText(rawAgent.thinking, 40) || undefined,
        nested: rawAgent.nested === true,
      });
    }
    if (status === "running" && !agents.length) continue;
    const source = normalizeWebuiSubagentSource(rawRun.source);
    const provisional = source === "recovered" || rawRun.provisional === true;
    const controllable = source !== "recovered" && !provisional && rawRun.controllable !== false;
    runs.push({
      id,
      source,
      ...(provisional ? { provisional: true } : {}),
      ...(!controllable ? { controllable: false } : {}),
      mode: ["single", "parallel", "chain"].includes(rawRun.mode) ? rawRun.mode : "single",
      status,
      startedAt: Number.isFinite(rawRun.startedAt) ? rawRun.startedAt : Date.now(),
      endedAt: status === "running" ? undefined : Number.isFinite(rawRun.endedAt) ? rawRun.endedAt : undefined,
      cancelReason: status === "cancelled" ? normalizeWebuiSubagentText(rawRun.cancelReason, 120) || undefined : undefined,
      cancelNote: status === "cancelled" ? normalizeWebuiSubagentText(rawRun.cancelNote, 2000) || undefined : undefined,
      cancelledBy: status === "cancelled" && rawRun.cancelledBy === "user" ? "user" : undefined,
      agents: agents.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name)),
    });
  }
  const gates = [];
  for (const rawGate of Array.isArray(value.gates) ? value.gates.slice(-WEBUI_SUBAGENT_GATE_LIMIT) : []) {
    if (!rawGate || typeof rawGate !== "object") continue;
    const id = normalizeWebuiSubagentText(rawGate.id, 160);
    if (!id) continue;
    const attempts = [];
    for (const rawAttempt of Array.isArray(rawGate.attempts) ? rawGate.attempts.slice(-WEBUI_SUBAGENT_GATE_ATTEMPT_LIMIT) : []) {
      if (!rawAttempt || typeof rawAttempt !== "object") continue;
      const attemptId = normalizeWebuiSubagentText(rawAttempt.id || `${id}:${attempts.length}`, 240);
      const agent = normalizeWebuiSubagentText(rawAttempt.agent, 160) || "subagent";
      attempts.push({
        id: attemptId,
        taskIndex: Number.isInteger(rawAttempt.taskIndex) ? rawAttempt.taskIndex : attempts.length,
        attempt: Number.isInteger(rawAttempt.attempt) ? Math.max(1, rawAttempt.attempt) : 1,
        maxAttempts: Number.isInteger(rawAttempt.maxAttempts) ? Math.max(1, rawAttempt.maxAttempts) : 1,
        agent,
        label: normalizeWebuiSubagentText(rawAttempt.label, 200) || undefined,
        phase: normalizeWebuiSubagentText(rawAttempt.phase, 120) || undefined,
        retrySafety: rawAttempt.retrySafety === "read-only" ? "read-only" : "may-write",
        runId: normalizeWebuiSubagentText(rawAttempt.runId, 160) || undefined,
        retryOf: normalizeWebuiSubagentText(rawAttempt.retryOf, 160) || undefined,
        model: normalizeWebuiSubagentText(rawAttempt.model, 240) || undefined,
        provider: normalizeWebuiSubagentText(rawAttempt.provider, 80) || undefined,
        status: ["launching", "running", "succeeded", "failed", "not-qualifying", "cancelled"].includes(rawAttempt.status) ? rawAttempt.status : "failed",
        failureKind: normalizeWebuiSubagentText(rawAttempt.failureKind, 80) || undefined,
        error: normalizeWebuiSubagentText(rawAttempt.error, 1000) || undefined,
        startedAt: Number.isFinite(rawAttempt.startedAt) ? rawAttempt.startedAt : undefined,
        endedAt: Number.isFinite(rawAttempt.endedAt) ? rawAttempt.endedAt : undefined,
      });
    }
    gates.push({
      version: 1,
      id,
      status: ["running", "satisfied", "failed", "cancelled"].includes(rawGate.status) ? rawGate.status : "failed",
      requiredSuccesses: Number.isInteger(rawGate.requiredSuccesses) ? Math.max(1, rawGate.requiredSuccesses) : 1,
      qualifyingSuccesses: Number.isInteger(rawGate.qualifyingSuccesses) ? Math.max(0, rawGate.qualifyingSuccesses) : 0,
      requireDistinctProviders: rawGate.requireDistinctProviders === true,
      startedAt: Number.isFinite(rawGate.startedAt) ? rawGate.startedAt : Date.now(),
      updatedAt: Number.isFinite(rawGate.updatedAt) ? rawGate.updatedAt : Date.now(),
      endedAt: Number.isFinite(rawGate.endedAt) ? rawGate.endedAt : undefined,
      attempts,
    });
  }
  return {
    version: 1,
    available: value.available === true,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    receivedAt: Date.now(),
    fleet: normalizeWebuiSubagentFleet(value.fleet),
    runs: runs.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)),
    gates: gates.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)),
  };
}

function normalizeWebuiAgentRunPayload(value) {
  if (!value || typeof value !== "object" || value.version !== 2) return null;
  const instances = [];
  const diagnostics = [];
  for (const raw of Array.isArray(value.instances) ? value.instances.slice(0, WEBUI_AGENT_RUN_LIMIT) : []) {
    try { instances.push(normalizeAgentInstance(raw)); }
    catch { diagnostics.push({ code: "invalid-helper-instance" }); }
  }
  for (const raw of Array.isArray(value.diagnostics) ? value.diagnostics.slice(-WEBUI_AGENT_RUN_DIAGNOSTIC_LIMIT) : []) {
    const code = normalizeWebuiSubagentText(raw?.code, 80);
    const producerId = normalizeWebuiSubagentText(raw?.producerId, 80);
    if (code) diagnostics.push({ code, ...(producerId ? { producerId } : {}) });
  }
  return {
    version: 2,
    available: value.available === true,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    receivedAt: Date.now(),
    instances,
    gateReferences: (Array.isArray(value.gateReferences) ? value.gateReferences : []).slice(0, 128).map((reference) => ({
      gateId: normalizeWebuiSubagentText(reference?.gateId, 160),
      attemptId: normalizeWebuiSubagentText(reference?.attemptId, 240),
      runId: normalizeWebuiSubagentText(reference?.runId, 160),
      instanceIds: (Array.isArray(reference?.instanceIds) ? reference.instanceIds : []).slice(0, 32).map((id) => normalizeWebuiSubagentText(id, 160)).filter(Boolean),
      resolved: reference?.resolved === true,
    })).filter((reference) => reference.gateId && reference.attemptId && reference.runId),
    diagnostics: diagnostics.slice(-WEBUI_AGENT_RUN_DIAGNOSTIC_LIMIT),
  };
}

function filterStartupInactiveRows(tab, payload, { rowsKey, stateKey }) {
  if (!payload) return payload;
  const rows = Array.isArray(payload[rowsKey]) ? payload[rowsKey] : [];
  const seenKey = `${stateKey}Seen`;
  const suppressedKey = `${stateKey}Suppressed`;
  const suppressed = tab[suppressedKey] instanceof Set ? tab[suppressedKey] : new Set();
  if (tab[seenKey] !== true) {
    for (const row of rows) if (!agentRunIsActive(row)) suppressed.add(row.instanceId || row.id);
    tab[seenKey] = true;
    tab[suppressedKey] = suppressed;
  }
  const visibleRows = rows.filter((row) => {
    const id = row.instanceId || row.id;
    if (!suppressed.has(id)) return true;
    if (!agentRunIsActive(row)) return false;
    suppressed.delete(id);
    return true;
  });
  return { ...payload, [rowsKey]: visibleRows };
}

function rememberWebuiSubagentsStatusEvent(tab, event) {
  if (event?.type !== "extension_ui_request" || event.method !== "setStatus") return false;
  const statusText = String(event.statusText || "");
  if (event.statusKey === WEBUI_SUBAGENTS_V2_STATUS_KEY) {
    if (!statusText) { tab.webuiAgentRuns = null; return true; }
    if (!statusText.startsWith(WEBUI_SUBAGENTS_V2_PAYLOAD_PREFIX)) return true;
    try {
      const payload = normalizeWebuiAgentRunPayload(JSON.parse(statusText.slice(WEBUI_SUBAGENTS_V2_PAYLOAD_PREFIX.length)));
      tab.webuiAgentRuns = filterStartupInactiveRows(tab, payload, { rowsKey: "instances", stateKey: "webuiAgentRunStartup" });
    } catch { tab.webuiAgentRuns = null; }
    return true;
  }
  if (event.statusKey !== WEBUI_SUBAGENTS_STATUS_KEY) return false;
  if (!statusText) { tab.webuiSubagents = null; return true; }
  if (!statusText.startsWith(WEBUI_SUBAGENTS_PAYLOAD_PREFIX)) return true;
  try {
    const payload = normalizeWebuiSubagentPayload(JSON.parse(statusText.slice(WEBUI_SUBAGENTS_PAYLOAD_PREFIX.length)));
    tab.webuiSubagents = filterStartupInactiveRows(tab, payload, { rowsKey: "runs", stateKey: "webuiSubagentStartup" });
  } catch { tab.webuiSubagents = null; }
  return true;
}

function replayExtensionStatuses(tab, client) {
  for (const [statusKey, statusText] of extensionStatusMap(tab)) {
    sendSseToClient(client, {
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setStatus",
      statusKey,
      statusText,
      tabId: tab.id,
      tabTitle: tab.title,
      replayed: true,
      tabActivity: tabActivitySnapshot(tab),
      pendingExtensionUiRequestCount: pendingExtensionUiRequests(tab).length,
    });
  }
}

function replayExtensionWidgets(tab, client) {
  const pendingExtensionUiRequestCount = pendingExtensionUiRequests(tab).length;
  for (const [widgetKey, request] of extensionWidgetMap(tab)) {
    sendSseToClient(client, {
      ...request,
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey,
      tabId: tab.id,
      tabTitle: tab.title,
      replayed: true,
      tabActivity: tabActivitySnapshot(tab),
      pendingExtensionUiRequestCount,
    });
  }
}

function bashQueueForTab(tab) {
  if (!tab.bashQueue) tab.bashQueue = [];
  return tab.bashQueue;
}

function compactionQueueForTab(tab) {
  if (!tab.compactionQueue) tab.compactionQueue = [];
  return tab.compactionQueue;
}

function compactionQueueRevision(tab) {
  if (!Number.isSafeInteger(tab.compactionQueueRevision) || tab.compactionQueueRevision < 0) tab.compactionQueueRevision = 0;
  return tab.compactionQueueRevision;
}

function advanceCompactionQueueRevision(tab) {
  tab.compactionQueueRevision = compactionQueueRevision(tab) + 1;
  return tab.compactionQueueRevision;
}

function queueMutationText(value, label, { allowBlank = false, normalize = true } = {}) {
  if (typeof value !== "string") throw makeHttpError(400, `${label} must be a string`);
  if (Buffer.byteLength(value, "utf8") > PROMPT_BODY_LIMIT_BYTES) throw makeHttpError(413, `${label} is too large`);
  if (!allowBlank && !value.trim()) throw makeHttpError(400, `${label} is required`);
  if (value.includes("\0")) throw makeHttpError(400, `${label} contains a NUL byte`);
  return normalize ? value.trim() : value;
}

function queueMutationExpected(body) {
  const expected = body?.expected;
  if (!expected || typeof expected !== "object" || !Array.isArray(expected.steering) || !Array.isArray(expected.followUp)) {
    throw makeHttpError(400, "Queue mutation requires complete expected steering and followUp arrays");
  }
  if (expected.steering.length > QUEUE_MUTATION_MAX_ITEMS || expected.followUp.length > QUEUE_MUTATION_MAX_ITEMS) {
    throw makeHttpError(400, `Queue mutation expected arrays may contain at most ${QUEUE_MUTATION_MAX_ITEMS} items`);
  }
  return {
    steering: expected.steering.map((item, index) => queueMutationText(item, `expected.steering[${index}]`, { normalize: false })),
    followUp: expected.followUp.map((item, index) => queueMutationText(item, `expected.followUp[${index}]`, { normalize: false })),
  };
}

function queueMutationIndex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw makeHttpError(400, `${label} must be a non-negative integer`);
  return value;
}

function queueMutationRequest(body) {
  if (!body || typeof body !== "object") throw makeHttpError(400, "Queue mutation body must be an object");
  const source = String(body.source || "");
  if (source !== "pi-runtime" && source !== "webui-compaction") throw makeHttpError(400, "Queue mutation source must be pi-runtime or webui-compaction");
  if (body.kind !== "followUp") throw makeHttpError(400, "Queue mutation kind must be followUp");
  const operation = body.operation;
  if (!operation || typeof operation !== "object") throw makeHttpError(400, "Queue mutation operation is required");
  const expectedText = queueMutationText(operation.expectedText, "operation.expectedText", { normalize: false });
  const request = {
    source,
    kind: "followUp",
    expected: queueMutationExpected(body),
    operation: { type: String(operation.type || ""), expectedText },
  };
  if (request.operation.type === "edit") {
    request.operation.index = queueMutationIndex(operation.index, "operation.index");
    request.operation.text = queueMutationText(operation.text, "operation.text");
  } else if (request.operation.type === "move") {
    request.operation.from = queueMutationIndex(operation.from, "operation.from");
    request.operation.to = queueMutationIndex(operation.to, "operation.to");
  } else if (request.operation.type === "delete") {
    request.operation.index = queueMutationIndex(operation.index, "operation.index");
  } else {
    throw makeHttpError(400, "Queue mutation operation type must be edit, move, or delete");
  }
  if (source === "webui-compaction") {
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw makeHttpError(400, "Compaction queue mutation requires a non-negative revision");
    request.revision = body.revision;
  } else if (Object.hasOwn(body, "revision")) {
    throw makeHttpError(400, "Pi runtime queue mutation must not include a revision");
  }
  return request;
}

function queueableCompactionCommand(command) {
  return ["prompt", "steer", "follow_up"].includes(command?.type) && !!String(command.message || "").trim();
}

function compactionQueueMode(command) {
  if (command?.type === "follow_up" || command?.streamingBehavior === "followUp") return "followUp";
  return "steer";
}

function compactQueuedCommand(command) {
  const queued = {
    type: command.type,
    message: String(command.message || ""),
    mode: compactionQueueMode(command),
  };
  if (Array.isArray(command.images) && command.images.length) queued.images = command.images;
  return queued;
}

function compactionQueueSnapshot(tab) {
  const queue = compactionQueueForTab(tab);
  const steering = [];
  const followUp = [];
  for (const item of queue) {
    const message = String(item?.command?.message || "").trim();
    if (!message) continue;
    if (item.command.mode === "followUp") followUp.push(message);
    else steering.push(message);
  }
  return {
    source: "webui-compaction",
    revision: compactionQueueRevision(tab),
    steering,
    followUp,
    draining: tab.compactionQueueDraining === true,
  };
}

function compactionQueueEvent(tab, extra = {}) {
  const queue = compactionQueueForTab(tab);
  return {
    type: "webui_compaction_queue_update",
    tabId: tab.id,
    tabTitle: tab.title,
    queueLength: queue.length,
    pendingMessageCount: queue.length,
    ...compactionQueueSnapshot(tab),
    tabActivity: tabActivitySnapshot(tab),
    ...extra,
  };
}

function sameQueueSnapshot(expected, current) {
  return expected.steering.length === current.steering.length
    && expected.followUp.length === current.followUp.length
    && expected.steering.every((item, index) => item === current.steering[index])
    && expected.followUp.every((item, index) => item === current.followUp[index]);
}

function compactionFollowUpSlots(queue) {
  return queue.flatMap((item, index) => item?.command?.mode === "followUp" && String(item.command.message || "").trim() ? [index] : []);
}

function mutateCompactionFollowUpQueue(tab, request) {
  const queue = compactionQueueForTab(tab);
  const current = compactionQueueSnapshot(tab);
  const failed = (reason) => ({ mutated: false, reason, source: "webui-compaction", queue: compactionQueueSnapshot(tab) });
  if (current.draining) return failed("queue-draining");
  if (request.revision !== current.revision || !sameQueueSnapshot(request.expected, current)) return failed("queue-changed");

  const slots = compactionFollowUpSlots(queue);
  const operation = request.operation;
  if (operation.type === "edit") {
    if (operation.index >= slots.length || current.followUp[operation.index] !== operation.expectedText) return failed("invalid-request");
    queue[slots[operation.index]].command.message = operation.text;
  } else if (operation.type === "move") {
    if (operation.from >= slots.length || operation.to >= slots.length || operation.from === operation.to
      || current.followUp[operation.from] !== operation.expectedText) return failed("invalid-request");
    const followUps = slots.map((index) => queue[index]);
    const [moved] = followUps.splice(operation.from, 1);
    followUps.splice(operation.to, 0, moved);
    slots.forEach((slot, index) => { queue[slot] = followUps[index]; });
  } else if (operation.type === "delete") {
    if (operation.index >= slots.length || current.followUp[operation.index] !== operation.expectedText) return failed("invalid-request");
    queue.splice(slots[operation.index], 1);
  } else {
    return failed("invalid-request");
  }

  advanceCompactionQueueRevision(tab);
  const result = { mutated: true, source: "webui-compaction", queue: compactionQueueSnapshot(tab) };
  broadcastTabEvent(tab, compactionQueueEvent(tab));
  return result;
}

function enqueueCommandUntilCompactionEnds(tab, command) {
  const queue = compactionQueueForTab(tab);
  const item = {
    id: randomUUID(),
    command: compactQueuedCommand(command),
    enqueuedAt: new Date().toISOString(),
  };
  queue.push(item);
  advanceCompactionQueueRevision(tab);
  broadcastTabEvent(tab, compactionQueueEvent(tab, { queuedId: item.id }));
  return rpcSuccess(command.type, {
    queued: true,
    queuedFor: "compaction",
    queueLength: queue.length,
    message: "Prompt queued; Pi will resume automatically after compaction finishes.",
  });
}

function maybeQueueCommandDuringCompaction(tab, command) {
  if (!queueableCompactionCommand(command)) return null;
  if (!tab?.lastState?.isCompacting) return null;
  return enqueueCommandUntilCompactionEnds(tab, command);
}

function queuedPromptCommand(item) {
  const command = { type: "prompt", message: item.command.message };
  if (Array.isArray(item.command.images) && item.command.images.length) command.images = item.command.images;
  return command;
}

function queuedStreamingCommand(item) {
  const command = {
    type: item.command.mode === "followUp" ? "follow_up" : "steer",
    message: item.command.message,
  };
  if (Array.isArray(item.command.images) && item.command.images.length) command.images = item.command.images;
  return command;
}

function queuedRetryCommand(item) {
  const message = String(item.command.message || "").trim();
  if (item.command.type === "prompt" && message.startsWith("/")) {
    const command = queuedPromptCommand(item);
    command.streamingBehavior = item.command.mode === "followUp" ? "followUp" : "steer";
    return command;
  }
  return queuedStreamingCommand(item);
}

function requeueCompactionItems(tab, items) {
  if (!items?.length) return;
  const queue = compactionQueueForTab(tab);
  queue.unshift(...items);
  advanceCompactionQueueRevision(tab);
  broadcastTabEvent(tab, compactionQueueEvent(tab));
}

async function compactionFlushShouldJoinActiveRun(tab, event = {}) {
  if (event.willRetry === true) return true;
  await delay(80);
  const state = await safeRpcData(tab, { type: "get_state" }, STATUS_RPC_TIMEOUT_MS).catch(() => ({ ok: false }));
  if (state.ok) return !!state.data?.isStreaming;
  return !!tab.lastState?.isStreaming;
}

async function flushCompactionQueue(tab, event = {}) {
  const queue = compactionQueueForTab(tab);
  if (!queue.length || tab.compactionQueueDraining) return;
  const items = queue.splice(0);
  tab.compactionQueueDraining = true;
  advanceCompactionQueueRevision(tab);
  broadcastTabEvent(tab, compactionQueueEvent(tab));
  const remaining = [...items];
  try {
    const joinActiveRun = await compactionFlushShouldJoinActiveRun(tab, event);
    if (joinActiveRun) {
      while (remaining.length) {
        const item = remaining[0];
        const response = await tab.rpc.send(queuedRetryCommand(item));
        if (response.success === false) throw new Error(response.error || "failed to queue prompt after compaction");
        remaining.shift();
      }
    } else {
      let startedPrompt = false;
      while (remaining.length) {
        const item = remaining[0];
        const command = startedPrompt ? queuedRetryCommand(item) : queuedPromptCommand(item);
        if (!startedPrompt) {
          const pendingThinkingResponse = await applyPendingThinkingBeforePrompt(tab);
          if (pendingThinkingResponse?.success === false) throw new Error(pendingThinkingResponse.error || "failed to apply queued thinking level");
          maybeNameTabForConversation(tab, command);
          markTabWorking(tab);
        }
        const response = await tab.rpc.send(command, command.type === "prompt" ? PROMPT_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
        if (response.success === false) throw new Error(response.error || "failed to resume after compaction");
        remaining.shift();
        if (command.type === "prompt") startedPrompt = true;
      }
    }
    broadcastTabEvent(tab, compactionQueueEvent(tab, { drained: true }));
  } catch (error) {
    requeueCompactionItems(tab, remaining);
    broadcastTabEvent(tab, compactionQueueEvent(tab, { error: sanitizeError(error) }));
  } finally {
    tab.compactionQueueDraining = false;
    broadcastTabEvent(tab, compactionQueueEvent(tab));
  }
}

function settleBashQueueItem(item, kind, value) {
  if (!item || item.settled) return;
  item.settled = true;
  if (kind === "resolve") item.resolve(value);
  else item.reject(value);
}

function bashQueueEvent(tab) {
  const queue = bashQueueForTab(tab);
  const activeItem = tab.bashQueueDraining ? queue[0] : null;
  return {
    type: "webui_bash_queue_update",
    tabId: tab.id,
    tabTitle: tab.title,
    activeCommand: activeItem?.command?.command,
    queueLength: Math.max(0, queue.length - (activeItem ? 1 : 0)),
    tabActivity: tabActivitySnapshot(tab),
  };
}

function broadcastBashQueueUpdate(tab) {
  if (tab?.sseClients) broadcastTabEvent(tab, bashQueueEvent(tab));
}

function rejectTabBashQueue(tab, error) {
  const queue = tab?.bashQueue;
  if (!queue?.length) return;
  for (const item of queue.splice(0)) settleBashQueueItem(item, "reject", error);
  tab.bashQueueDraining = false;
  broadcastBashQueueUpdate(tab);
}

async function drainTabBashQueue(tab) {
  if (tab.bashQueueDraining) return;
  const queue = bashQueueForTab(tab);
  tab.bashQueueDraining = true;
  try {
    while (queue.length > 0) {
      const item = queue[0];
      broadcastBashQueueUpdate(tab);
      try {
        const response = await tab.rpc.send(item.command);
        settleBashQueueItem(item, "resolve", response);
      } catch (error) {
        settleBashQueueItem(item, "reject", error);
      } finally {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        broadcastBashQueueUpdate(tab);
      }
    }
  } finally {
    tab.bashQueueDraining = false;
    broadcastBashQueueUpdate(tab);
  }
}

function sendQueuedBashCommand(tab, command) {
  return new Promise((resolve, reject) => {
    const queue = bashQueueForTab(tab);
    queue.push({ id: randomUUID(), command, resolve, reject, settled: false, queuedAt: new Date().toISOString() });
    broadcastBashQueueUpdate(tab);
    void drainTabBashQueue(tab);
  });
}

function markTabWorking(tab, timestamp = new Date().toISOString(), { runStarted = false } = {}) {
  const activity = tab.activity || createTabActivity(timestamp);
  if (!activity.isWorking || !activity.runId) activity.runId = randomUUID();
  activity.status = "working";
  activity.isWorking = true;
  activity.runStarted = activity.runStarted === true || runStarted === true;
  activity.lastStartedAt = timestamp;
  activity.lastChangedAt = timestamp;
  tab.activity = activity;
}

function markTabDone(tab, timestamp = new Date().toISOString()) {
  const activity = tab.activity || createTabActivity(timestamp);
  activity.status = "done";
  activity.isWorking = false;
  activity.runStarted = false;
  activity.completionSerial = (Number(activity.completionSerial) || 0) + 1;
  activity.lastCompletedAt = timestamp;
  activity.lastChangedAt = timestamp;
  tab.activity = activity;
}

function markTabFailed(tab, timestamp = new Date().toISOString()) {
  const activity = tab.activity || createTabActivity(timestamp);
  activity.status = "failed";
  activity.isWorking = false;
  activity.runStarted = false;
  activity.completionSerial = (Number(activity.completionSerial) || 0) + 1;
  activity.lastCompletedAt = timestamp;
  activity.lastChangedAt = timestamp;
  tab.activity = activity;
}

function markTabIdle(tab, timestamp = new Date().toISOString()) {
  const activity = tab.activity || createTabActivity(timestamp);
  activity.status = "idle";
  activity.isWorking = false;
  // An idle pre-start operation never became a parent turn. Completed turns
  // retain their opaque ID so a later Activity view can resolve recent work.
  if (!activity.runStarted) activity.runId = null;
  activity.runStarted = false;
  activity.lastChangedAt = timestamp;
  tab.activity = activity;
}

function commandStartsVisibleWork(command) {
  return command?.type === "compact" || (command?.type === "prompt" && !command.streamingBehavior);
}

function commandStartsConversation(command) {
  return command?.type === "prompt" && !command.streamingBehavior;
}

function stateHasVisibleWork(state) {
  return !!state?.isStreaming || !!state?.isCompacting || Number(state?.pendingMessageCount || 0) > 0;
}

function activityRecentlyStarted(activity, nowMs = Date.now()) {
  const startedMs = Date.parse(activity?.lastStartedAt || activity?.lastChangedAt || "");
  return Number.isFinite(startedMs) && nowMs - startedMs < TAB_ACTIVITY_IDLE_RECONCILE_GRACE_MS;
}

function reconcileTabActivityFromState(tab, state, timestamp = new Date().toISOString()) {
  if (!tab) return createTabActivity(timestamp);
  if (!state || typeof state !== "object") return tabActivitySnapshot(tab);
  if (pendingExtensionUiRequests(tab).length > 0) {
    if (!tab.activity?.isWorking) markTabWorking(tab, timestamp);
    return tabActivitySnapshot(tab);
  }
  if (stateHasVisibleWork(state)) {
    if (!tab.activity?.isWorking || (state.isStreaming && !tab.activity?.runStarted)) {
      markTabWorking(tab, timestamp, { runStarted: state.isStreaming === true });
    }
    return tabActivitySnapshot(tab);
  }
  if (tab.activity?.isWorking && !activityRecentlyStarted(tab.activity)) {
    if (tab.activity.runStarted) markTabDone(tab, timestamp);
    else markTabIdle(tab, timestamp);
  }
  return tabActivitySnapshot(tab);
}

async function reconcileWorkingTabActivity(tab) {
  if (!tab?.activity?.isWorking) return;
  if (activityRecentlyStarted(tab.activity)) return;
  const now = Date.now();
  if (now - (tab.activityStateReconcileAt || 0) < TAB_ACTIVITY_STATE_RECONCILE_INTERVAL_MS) return;
  tab.activityStateReconcileAt = now;
  try {
    const response = await tab.rpc.send({ type: "get_state" }, TAB_ACTIVITY_STATE_RECONCILE_TIMEOUT_MS);
    if (response?.success !== false) {
      rememberTabState(tab, response.data);
      reconcileTabActivityFromState(tab, response.data);
    }
  } catch {
    // Ignore reconciliation failures; normal RPC events will still update activity.
  }
}

async function listTabsWithReconciledActivity() {
  await Promise.all([...tabs.values()].map(reconcileWorkingTabActivity));
  return listTabs();
}

function updateTabActivityFromEvent(tab, event) {
  const timestamp = new Date().toISOString();
  switch (event?.type) {
    case "agent_start":
      patchTabState(tab, { isStreaming: true });
      tab.pendingTurnFailure = false;
      markTabWorking(tab, timestamp, { runStarted: true });
      break;
    case "compaction_start":
      patchTabState(tab, { isCompacting: true });
      markTabWorking(tab, timestamp);
      break;
    case "agent_end": {
      // A low-level run ended, but Pi may still retry, compact, or process a follow-up.
      const assistant = Array.isArray(event.messages) ? event.messages.findLast((item) => item?.role === "assistant") : null;
      if (event.willRetry === true) tab.pendingTurnFailure = false;
      else if (assistant?.stopReason === "error") tab.pendingTurnFailure = true;
      break;
    }
    case "message_end":
      if (event.message?.role === "assistant" && event.message.stopReason === "error") tab.pendingTurnFailure = true;
      break;
    case "agent_settled":
      patchTabState(tab, { isStreaming: false });
      if (tab.activity?.runStarted) {
        if (tab.pendingTurnFailure) markTabFailed(tab, timestamp);
        else markTabDone(tab, timestamp);
      } else if (tab.activity?.isWorking) markTabIdle(tab, timestamp);
      tab.pendingTurnFailure = false;
      break;
    case "compaction_end":
      patchTabState(tab, { isCompacting: false });
      if (!tab.lastState?.isStreaming && !tab.activity?.runStarted) markTabIdle(tab, timestamp);
      break;
    case "queue_update":
      patchTabState(tab, { pendingMessageCount: (event.steering?.length || 0) + (event.followUp?.length || 0) });
      break;
    case "pi_process_exit":
      if (tab.activity?.runStarted && (Number(event.code) !== 0 || event.signal)) markTabFailed(tab, timestamp);
      else markTabIdle(tab, timestamp);
      tab.pendingTurnFailure = false;
      break;
    case "pi_process_error":
      if (tab.activity?.runStarted) markTabFailed(tab, timestamp);
      else markTabIdle(tab, timestamp);
      tab.pendingTurnFailure = false;
      break;
    case "response":
      if (event.command === "get_state" && event.success !== false) {
        rememberTabState(tab, event.data);
        reconcileTabActivityFromState(tab, event.data, timestamp);
      } else if (!tab.activity) tab.activity = createTabActivity(timestamp);
      break;
    default:
      if (!tab.activity) tab.activity = createTabActivity(timestamp);
      break;
  }
  return tabActivitySnapshot(tab);
}

function defaultTabTitle(tabIndex) {
  if (options.name) return tabIndex === 1 ? options.name : `${options.name} ${tabIndex}`;
  return `Thread ${tabIndex}`;
}

async function primeTabRpc(tab, { strict = false } = {}) {
  try {
    const response = await tab.rpc.send({ type: "get_state" }, strict ? 15_000 : 1500);
    if (strict && response.success === false) throw new Error(response.error || "Pi state is unavailable");
    if (response.success !== false) {
      rememberTabState(tab, response.data);
      reconcileTabActivityFromState(tab, response.data);
    }
  } catch (error) {
    if (strict || !/Timed out waiting for RPC response/i.test(sanitizeError(error))) throw error;
  }
}

function attachRpcToTab(tab, rpc) {
  tab.rpcUnsubscribe?.();
  tab.rpc = rpc;
  tab.rpcUnsubscribe = rpc.onEvent((rawEvent) => {
    const event = tab.thinkingStreamRecovery.ingest(rawEvent);
    if (resolveWebuiHelperResponse(tab, event) || resolveWebuiHelperRpcResponse(tab, event) || rememberWebuiSubagentsStatusEvent(tab, event) || consumeSessionSummaryRpcEvent(tab, event)) return;
    const gitWorkflowFinalError = event?.type === "agent_settled" && tab.pendingTurnFailure === true;
    updateTabActivityFromEvent(tab, event);
    let scopedEvent = scopedGuidedGitLaunchEvent(tab, eventForTabClients(tab, event));
    if (event?.type === "pi_process_exit" || event?.type === "pi_process_error") {
      loseGitWorkflowGeneration(tab);
      clearPendingExtensionUiRequests(tab);
      clearExtensionStatuses(tab);
      scheduleSupervisorMetadataUpdate(tab);
      clearExtensionWidgets(tab);
      clearPendingGuidedGitLaunch(tab);
      clearWebuiSubagents(tab);
      resetNaturalConversationMode(tab);
      resetCodexFastMode(tab);
    } else {
      rememberExtensionStatusEvent(tab, scopedEvent);
      rememberNaturalConversationStatusEvent(tab, scopedEvent);
      rememberExtensionWidgetEvent(tab, scopedEvent);
      trackPendingExtensionUiRequest(tab, scopedEvent);
    }
    scopedEvent = { ...scopedEvent, tabActivity: tabActivitySnapshot(tab), pendingExtensionUiRequestCount: pendingExtensionUiRequests(tab).length };
    recordEvent(scopedEvent);
    for (const client of tab.sseClients) sendSseToClient(client, scopedEvent);
    if (event?.type === "compaction_end") void flushCompactionQueue(tab, event);
    consumeGitWorkflowGenerationEvent(tab, event, { finalError: gitWorkflowFinalError });
  });
}

function createTabRecord({ id, index, title, titleSource, conversationStarted, cwd, workspaceKind, noProjectId, createdAt = new Date().toISOString(), sessionFile, gitWorkspace, prompt, rpc }) {
  const tab = {
    id,
    index,
    title,
    titleSource,
    conversationStarted: conversationStarted === true,
    cwd,
    workspaceKind,
    noProjectId,
    createdAt,
    sessionFile: options.noSession ? undefined : normalizedRestoreString(sessionFile, 4096),
    gitWorkspace: gitWorkspace || null,
    prompt: normalizeTabPromptDescriptor(prompt),
    lastState: null,
    pendingThinkingLevel: undefined,
    thinkingStreamRecovery: new ThinkingStreamRecovery(),
    gitWorkflowGeneration: null,
    gitWorkflowMessageGeneration: null,
    gitWorkflowArtifactGeneration: null,
    gitWorkflowFallbackLifecycle: null,
    activity: createTabActivity(createdAt),
    pendingExtensionUiRequests: new Map(),
    extensionStatuses: new Map(),
    extensionWidgets: new Map(),
    sessionSummary: null,
    webuiSubagents: null,
    webuiAgentRuns: null,
    subagentDisplayTitle: undefined,
    subagentDisplayTitlePromise: undefined,
    webuiHelperRequests: new Map(),
    webuiHelperResponseIds: new Set(),
    bashQueue: [],
    bashQueueDraining: false,
    compactionQueue: [],
    compactionQueueRevision: 0,
    compactionQueueDraining: false,
    cwdChangeInProgress: false,
    noProjectResetInProgress: false,
    rpc,
    rpcUnsubscribe: undefined,
    sseClients: new Set(),
    browserPromptRequests: new Map(),
    guidedGitPendingLaunch: null,
  };
  resetNaturalConversationMode(tab);
  resetCodexFastMode(tab);
  return tab;
}

async function createTab({ id: requestedId, index, title, titleSource, conversationStarted, cwd, sessionFile, gitWorkspace, workspaceKind, noProjectId, freshNoProject = false } = {}) {
  const releaseAdmittedWork = nativeAdmittedWork.begin();
  try {
  if (!nativeAdmissionState) throw new Error("Update admission is not initialized.");
  await assertEffectAdmission(nativeAdmissionState.root, nativeAdmissionState.participant.canonicalRoots);
  const tabIndex = Number.isInteger(index) && index > 0 ? index : nextTabIndex;
  nextTabIndex = Math.max(nextTabIndex, tabIndex + 1);
  const explicitTitle = String(title || "").trim();
  const tabTitle = explicitTitle || defaultTabTitle(tabIndex);
  const titleIsExplicit = Boolean(explicitTitle || (options.name && tabIndex === 1));
  const resolvedTitleSource = ["explicit", "auto", "default"].includes(titleSource) ? titleSource : titleIsExplicit ? "explicit" : "default";
  const allocation = freshNoProject ? await allocateNoProjectWorkspace(agentDir) : null;
  const requestedCwd = allocation?.cwd || cwd || options.cwd;
  const identity = allocation || await resolveNoProjectWorkspace(agentDir, { cwd: requestedCwd, workspaceKind, noProjectId });
  const tabCwd = identity.workspaceKind === "no-project" ? requestedCwd : cwd ? await resolveCwd(cwd, options.cwd) : options.cwd;
  const id = requestedId && !tabs.has(requestedId) ? requestedId : randomUUID();
  const launch = await buildPiLaunchForTab(tabIndex, tabTitle, tabCwd, identity.workspaceKind);
  const piArgs = launch.args;
  if (sessionFile && !options.noSession) piArgs.push("--session", sessionFile);
  const piCommand = await resolvePiCommand(piArgs);
  const createdAt = new Date().toISOString();
  const rpc = rpcSupervisor
    ? new SupervisorPiRpcProcess({ supervisor: rpcSupervisor, tabId: id, displayCommand: piCommand.displayCommand, cwd: tabCwd, snapshot: { startedAt: createdAt, running: false } })
    : new PiRpcProcess({ ...piCommand, cwd: tabCwd, env: piRpcEnvironment() });
  const tab = createTabRecord({
    id,
    index: tabIndex,
    title: tabTitle,
    titleSource: resolvedTitleSource,
    conversationStarted,
    cwd: tabCwd,
    workspaceKind: identity.workspaceKind,
    noProjectId: identity.noProjectId,
    createdAt,
    sessionFile,
    gitWorkspace,
    rpc,
  });

  attachRpcToTab(tab, rpc);
  tabs.set(id, tab);
  workspaceFilesLiveWatcher.subscribe(tab.id, tab.cwd);
  try {
    await assertEffectAdmission(nativeAdmissionState.root, nativeAdmissionState.participant.canonicalRoots);
    if (rpc instanceof SupervisorPiRpcProcess) {
      const snapshot = await rpcSupervisor.createTab({
        tabId: id,
        metadata: supervisedTabMetadata(tab, { prompt: launch.prompt }),
        child: { command: piCommand.command, args: piCommand.args, cwd: tabCwd },
      });
      rpc.applySnapshot(snapshot);
    } else {
      await rpc.start();
    }
    tab.prompt = launch.prompt;
    await primeTabRpc(tab, { strict: identity.workspaceKind === "no-project" });
  } catch (error) {
    if (identity.workspaceKind === "no-project") {
      await discardTab(tab).catch((cleanupError) => console.warn(`failed to stop rejected No Project tab: ${sanitizeError(cleanupError)}`));
      throw new Error(`Pi RPC process failed while starting ${tabTitle}: ${sanitizeError(error)}`);
    }
    if (!tab.rpc.isRunning()) {
      tab.rpcUnsubscribe?.();
      rpc.dispose?.();
      gitLiveWatcher.unsubscribe(id);
      workspaceFilesLiveWatcher.unsubscribe(id);
      tabs.delete(id);
      throw new Error(`Pi RPC process failed while starting ${tabTitle}: ${sanitizeError(error)}`);
    }
  }
  if (sessionFile && !options.noSession) {
    recordEvent({ type: "webui_tab_restored", tabId: tab.id, tabTitle: tab.title, cwd: tab.cwd });
  }
  return tab;
  } finally { releaseAdmittedWork(); }
}

async function hydrateManagedTabs(snapshot) {
  const managedTabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  if (!managedTabs.length) return [];
  const hydrated = [];
  try {
    for (const managed of managedTabs) {
      const metadata = managed?.metadata;
      const descriptor = normalizeRestoreTabDescriptor({ id: managed?.id, ...metadata }, new Set());
      if (!descriptor?.id || !descriptor.cwd || tabs.has(descriptor.id)) {
        throw new Error("RPC supervisor returned invalid or duplicate managed tab metadata");
      }
      const identity = await resolveNoProjectWorkspace(agentDir, descriptor);
      const tabIndex = Number.isInteger(descriptor.index) && descriptor.index > 0 ? descriptor.index : nextTabIndex;
      nextTabIndex = Math.max(nextTabIndex, tabIndex + 1);
      const tabTitle = descriptor.title || defaultTabTitle(tabIndex);
      const resolvedTitleSource = ["explicit", "auto", "default"].includes(descriptor.titleSource) ? descriptor.titleSource : "default";
      const rpc = new SupervisorPiRpcProcess({
        supervisor: rpcSupervisor,
        tabId: descriptor.id,
        cwd: descriptor.cwd,
        snapshot: managed,
      });
      const tab = createTabRecord({
        id: descriptor.id,
        index: tabIndex,
        title: tabTitle,
        titleSource: resolvedTitleSource,
        conversationStarted: descriptor.conversationStarted,
        cwd: descriptor.cwd,
        ...identity,
        createdAt: normalizedRestoreString(metadata?.createdAt, 128) || managed.startedAt || new Date().toISOString(),
        sessionFile: descriptor.sessionFile,
        gitWorkspace: metadata?.gitWorkspace || null,
        prompt: normalizeTabPromptDescriptor(metadata?.prompt),
        rpc,
      });
      restoreFeatureSystemPromptDetection(tab, metadata?.featureSystemPromptDetected === true);
      attachRpcToTab(tab, rpc);
      tabs.set(tab.id, tab);
      workspaceFilesLiveWatcher.subscribe(tab.id, tab.cwd);
      hydrated.push(tab);
    }
  } catch (error) {
    for (const tab of hydrated) {
      tab.rpcUnsubscribe?.();
      tab.rpc.dispose?.();
      workspaceFilesLiveWatcher.unsubscribe(tab.id);
      tabs.delete(tab.id);
    }
    throw error;
  }

  for (const event of snapshot.replay || []) dispatchRpcSupervisorEvent(event);
  return hydrated;
}

function firstTab() {
  return tabs.values().next().value;
}

function tabMeta(tab) {
  return {
    id: tab.id,
    index: tab.index,
    title: tab.title,
    titleSource: tab.titleSource || "default",
    conversationStarted: !!tab.conversationStarted,
    cwd: tab.cwd,
    workspaceKind: tab.workspaceKind,
    noProjectId: tab.noProjectId,
    sessionFile: tabRestorableSessionFile(tab),
    gitWorkspace: tab.gitWorkspace || null,
    prompt: normalizeTabPromptDescriptor(tab.prompt),
    pendingThinkingLevel: tab.pendingThinkingLevel || null,
    createdAt: tab.createdAt,
    startedAt: tab.rpc.startedAt,
    pid: tab.rpc.child?.pid,
    running: tab.rpc.isRunning(),
    command: tab.rpc.displayCommand,
    clientCount: tab.sseClients.size,
    pendingExtensionUiRequestCount: pendingExtensionUiRequests(tab).length,
    activity: tabActivitySnapshot(tab),
    appRunner: publicAppRunnerState(tab.appRunner),
    conversationMode: naturalConversationModeSnapshot(tab),
    sessionSummary: publicSessionSummaryState(tab),
  };
}

function listTabs() {
  return [...tabs.values()].map(tabMeta);
}

async function resolveSubagentDisplayTitle(tab) {
  const fallback = tab?.title || "";
  if (!tab || tab.titleSource !== "auto") return fallback;
  if (tab.subagentDisplayTitle) return tab.subagentDisplayTitle;
  if (!tab.subagentDisplayTitlePromise) {
    tab.subagentDisplayTitlePromise = safeRpcResponse(tab, { type: "get_messages" }, TAB_ACTIVITY_STATE_RECONCILE_TIMEOUT_MS)
      .then((response) => {
        const firstUserMessage = (Array.isArray(response.data?.messages) ? response.data.messages : []).find((message) => message?.role === "user");
        const title = generatedTabTitleFromPrompt(extractSessionTextContent(firstUserMessage?.content)) || fallback;
        tab.subagentDisplayTitle = title;
        return title;
      })
      .catch(() => {
        tab.subagentDisplayTitle = fallback;
        return fallback;
      });
  }
  return tab.subagentDisplayTitlePromise;
}

function tabParentSessionId(tab) {
  const raw = tab?.lastState?.sessionId;
  return raw ? canonicalAgentRunId(raw, "session") : null;
}

function legacyRunInstances(tab, run) {
  const parentSessionId = tabParentSessionId(tab) || `legacy-tab:${tab.id}`;
  const startedAt = Number.isSafeInteger(run.startedAt) ? run.startedAt : Date.now();
  return run.agents.map((agent) => {
    const status = ["running", "done", "failed", "cancelled"].includes(agent.status) ? agent.status : run.status;
    const endedAt = status === "running" ? null : Math.max(startedAt, Number.isSafeInteger(run.endedAt) ? run.endedAt : Date.now());
    return normalizeAgentInstance({
      version: 1,
      instanceId: canonicalAgentRunId(agent.id, "agent"),
      runId: canonicalAgentRunId(run.id, "run"),
      parentSessionId,
      launcher: run.source === "workflow" ? "workflow" : "pi-subagents",
      provider: run.source === "workflow" ? "workflow-run" : "webui-helper",
      origin: run.source,
      name: agent.name,
      status,
      startedAt,
      updatedAt: endedAt ?? Date.now(),
      endedAt,
      model: agent.model,
      thinking: agent.thinking,
      activityState: agent.activityState,
      currentTool: agent.currentTool,
      capabilities: {
        open: webuiSubagentRunSupportsInteraction(run),
        refresh: webuiSubagentRunSupportsInteraction(run),
        cancel: status === "running" && webuiSubagentRunSupportsInteraction(run),
        steer: false,
      },
      outputRef: { kind: "none" },
    });
  });
}

function groupedCanonicalRuns(instances) {
  const byRun = new Map();
  for (const instance of instances) {
    const current = byRun.get(instance.runId) || [];
    current.push(instance);
    byRun.set(instance.runId, current);
  }
  return [...byRun.entries()].map(([runId, agents]) => {
    agents.sort((a, b) => a.startedAt - b.startedAt || a.instanceId.localeCompare(b.instanceId));
    const status = agents.some((agent) => agent.status === "running") ? "running"
      : agents.some((agent) => agent.status === "stale") ? "stale"
        : agents.some((agent) => agent.status === "lost") ? "lost"
          : agents.some((agent) => agent.status === "failed") ? "failed"
            : agents.some((agent) => agent.status === "cancelled") ? "cancelled" : "done";
    return {
      id: runId,
      source: agents[0].origin || agents[0].launcher,
      launcher: agents[0].launcher,
      provider: agents[0].provider,
      status,
      startedAt: Math.min(...agents.map((agent) => agent.startedAt)),
      endedAt: agents.every((agent) => Number.isSafeInteger(agent.endedAt)) ? Math.max(...agents.map((agent) => agent.endedAt)) : undefined,
      capabilities: {
        open: agents.some((agent) => agent.capabilities.open),
        refresh: agents.some((agent) => agent.capabilities.refresh),
        cancel: agents.some((agent) => agent.capabilities.cancel),
        steer: agents.some((agent) => agent.capabilities.steer),
      },
      agents: agents.map((agent) => ({
        id: agent.instanceId,
        instanceId: agent.instanceId,
        name: agent.name || "Agent",
        status: agent.status,
        launcher: agent.launcher,
        provider: agent.provider,
        origin: agent.origin,
        model: agent.model,
        thinking: agent.thinking,
        activityState: agent.activityState,
        currentTool: agent.currentTool,
        capabilities: agent.capabilities,
        outputRef: agent.outputRef,
      })),
    };
  }).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

async function webuiSubagentsData({ includeSelections = false } = {}) {
  const sortedTabs = [...tabs.values()].sort((a, b) => a.index - b.index || a.title.localeCompare(b.title));
  const tabSummaries = await Promise.all(sortedTabs.map(async (tab) => {
    const status = tab.webuiSubagents || { version: 1, available: false, updatedAt: null, receivedAt: null, runs: [], gates: [] };
    const runs = Array.isArray(status.runs) ? status.runs : [];
    const gates = Array.isArray(status.gates) ? status.gates : [];
    const tabTitle = runs.length || gates.length || tab.webuiAgentRuns?.instances?.length ? await resolveSubagentDisplayTitle(tab) : tab.title;
    return {
      tabId: tab.id, tabIndex: tab.index, tabTitle, cwd: tab.cwd,
      sessionName: normalizeWebuiSubagentText(tab.lastState?.sessionName || tab.title, 160),
      sessionFile: tabRestorableSessionFile(tab) || null,
      running: tab.rpc.isRunning(), available: status.available === true || tab.webuiAgentRuns?.available === true,
      updatedAt: status.updatedAt || tab.webuiAgentRuns?.updatedAt || null,
      receivedAt: status.receivedAt || tab.webuiAgentRuns?.receivedAt || null,
      fleet: status.fleet || null, runs, gates,
      agentCount: runs.reduce((count, run) => count + run.agents.length, 0),
      runningRuns: runs.filter((run) => run.status === "running").length,
      runningAgents: runs.reduce((count, run) => count + run.agents.filter((agent) => agent.status === "running").length, 0),
      gateCount: gates.length,
    };
  }));
  const index = new AgentRunIndex();
  const selections = new Map();
  const diagnostics = [];
  for (const tab of sortedTabs) {
    const canonical = tab.webuiAgentRuns?.instances;
    if (Array.isArray(canonical)) {
      for (const instance of canonical) {
        index.upsert(instance, { producerId: instance.provider, lifecycleOwner: true, capabilityOwner: true });
        selections.set(`${instance.parentSessionId || "external"}\0${instance.instanceId}`, { kind: "helper", tab, instance });
      }
      diagnostics.push(...(tab.webuiAgentRuns.diagnostics || []));
    } else {
      for (const run of tab.webuiSubagents?.runs || []) for (const instance of legacyRunInstances(tab, run)) {
        index.upsert(instance, { producerId: instance.provider, lifecycleOwner: true, capabilityOwner: true });
        selections.set(`${instance.parentSessionId}\0${instance.instanceId}`, { kind: "legacy-helper", tab, instance, run, agent: run.agents.find((candidate) => canonicalAgentRunId(candidate.id, "agent") === instance.instanceId) });
      }
    }
  }
  let registrySnapshot = { records: [], diagnostics: [], omitted: 0, artifacts: new Map() };
  const reconcileNow = Date.now();
  pruneDismissedAgentRunProjections(reconcileNow);
  try {
    if (reconcileNow - lastAgentRunPruneAt >= AGENT_RUN_PRUNE_INTERVAL_MS) {
      lastAgentRunPruneAt = reconcileNow;
      try { await agentRunRegistry.prune({ now: reconcileNow }); }
      catch { diagnostics.push({ code: "registry-prune-unavailable" }); }
    }
    registrySnapshot = await agentRunRegistry.readRecords({ now: reconcileNow });
  } catch { diagnostics.push({ code: "registry-unavailable" }); }
  const visibleRegistryRecords = [];
  for (const record of registrySnapshot.records) {
    const key = agentRunProjectionKey(record.instance);
    if (startupSuppressedAgentRunProjectionKeys.has(key)) {
      if (!agentRunIsActive(record.instance)) continue;
      startupSuppressedAgentRunProjectionKeys.delete(key);
    }
    if (dismissedAgentRunProjectionKeys.has(key)) {
      if (agentRunProjectionCanBeDismissed(record.instance)) continue;
      dismissedAgentRunProjectionKeys.delete(key);
    }
    visibleRegistryRecords.push(record);
    index.upsert(record.instance, { producerId: record.producerId });
    if (!selections.has(key) || record.instance.outputRef.kind === "session-jsonl") selections.set(key, { kind: "registry", instance: record.instance, record });
  }
  diagnostics.push(...registrySnapshot.diagnostics, ...(registrySnapshot.omitted ? [{ code: "registry-records-omitted", count: registrySnapshot.omitted }] : []));

  const byParent = new Map();
  for (const instance of index.values()) {
    const key = instance.parentSessionId || "external";
    const rows = byParent.get(key) || [];
    rows.push(instance);
    byParent.set(key, rows);
  }
  const groups = [];
  const claimedParents = new Set();
  for (const tabSummary of tabSummaries) {
    const tab = tabs.get(tabSummary.tabId);
    const parentId = tabParentSessionId(tab) || `legacy-tab:${tabSummary.tabId}`;
    claimedParents.add(parentId);
    groups.push({
      id: `tab:${tabSummary.tabId}`, kind: "tab", tabId: tabSummary.tabId, tabIndex: tabSummary.tabIndex,
      title: tabSummary.tabTitle, cwdLabel: path.basename(tabSummary.cwd) || tabSummary.cwd,
      runs: groupedCanonicalRuns(byParent.get(parentId) || []), gates: tabSummary.gates,
    });
  }
  const externalInstances = [...byParent.entries()].filter(([parent]) => !claimedParents.has(parent)).flatMap(([, rows]) => rows);
  if (externalInstances.length) groups.push({ id: "external", kind: "external", title: "External agents", runs: groupedCanonicalRuns(externalInstances), gates: [] });
  const instances = index.values();
  const counts = {
    totalRuns: groups.reduce((count, group) => count + group.runs.length, 0),
    totalAgents: instances.length,
    runningAgents: instances.filter((instance) => instance.status === "running").length,
    staleAgents: instances.filter((instance) => instance.status === "stale").length,
    byLauncher: Object.fromEntries([...new Set(instances.map((instance) => instance.launcher))].sort().map((launcher) => [launcher, instances.filter((instance) => instance.launcher === launcher).length])),
  };
  const fleet = tabSummaries.reduce((summary, tab) => ({ version: 1, totalActive: Math.min(Number.MAX_SAFE_INTEGER, summary.totalActive + Number(tab.fleet?.totalActive || 0)), omitted: Math.min(Number.MAX_SAFE_INTEGER, summary.omitted + Number(tab.fleet?.omitted || 0)) }), { version: 1, totalActive: 0, omitted: 0 });
  const overview = {
    version: 2, updatedAt: Date.now(), available: tabSummaries.some((tab) => tab.available) || visibleRegistryRecords.length > 0,
    groups, counts, diagnostics: diagnostics.slice(-WEBUI_AGENT_RUN_DIAGNOSTIC_LIMIT), fleet,
    totalRuns: counts.totalRuns, totalAgents: counts.totalAgents,
    runningRuns: groups.reduce((count, group) => count + group.runs.filter((run) => run.status === "running").length, 0),
    runningAgents: counts.runningAgents, totalGates: tabSummaries.reduce((count, tab) => count + tab.gateCount, 0), tabs: tabSummaries,
  };
  return includeSelections ? { overview, selections, registrySnapshot } : overview;
}

function normalizeWebuiSubagentTranscriptValue(value, maxLength = WEBUI_SUBAGENT_OUTPUT_LINE_LENGTH) {
  return String(value ?? "").replace(/\r/g, "").slice(0, maxLength);
}

function normalizeWebuiSubagentTranscriptLines(value) {
  return String(value ?? "").replace(/\r/g, "").split("\n").map((line) => line.slice(0, WEBUI_SUBAGENT_OUTPUT_LINE_LENGTH));
}

function normalizeWebuiSubagentTranscript(value) {
  const messages = [];
  let remainingParts = WEBUI_SUBAGENT_OUTPUT_LINE_LIMIT;
  const rawMessages = Array.isArray(value) ? value : [];
  for (let messageIndex = rawMessages.length - 1; messageIndex >= 0 && remainingParts > 0; messageIndex -= 1) {
    const rawMessage = rawMessages[messageIndex];
    const role = rawMessage?.role;
    if (role !== "assistant" && role !== "toolResult") continue;
    const rawContent = Array.isArray(rawMessage.content) ? rawMessage.content : [{ type: "text", text: rawMessage.content }];
    const content = [];
    for (let partIndex = rawContent.length - 1; partIndex >= 0 && remainingParts > 0; partIndex -= 1) {
      const rawPart = rawContent[partIndex];
      if (role === "assistant" && rawPart?.type === "toolCall") {
        const name = normalizeWebuiSubagentText(rawPart.name || rawPart.toolName || rawPart.toolCall?.name, 120) || "tool";
        let argumentsText = "{}";
        try {
          const argumentsValue = rawPart.arguments ?? rawPart.args ?? rawPart.input ?? rawPart.toolCall?.arguments ?? {};
          argumentsText = normalizeWebuiSubagentTranscriptValue(typeof argumentsValue === "string" ? argumentsValue.replace(/\n/g, "\\n") : JSON.stringify(argumentsValue));
        } catch {
          // Keep the bounded placeholder when the helper received a cyclic value.
        }
        content.unshift({
          type: "toolCall",
          name,
          arguments: argumentsText,
          ...(normalizeWebuiSubagentText(rawPart.id || rawPart.toolCallId || rawPart.tool_call_id, 240) ? { id: normalizeWebuiSubagentText(rawPart.id || rawPart.toolCallId || rawPart.tool_call_id, 240) } : {}),
        });
        remainingParts -= 1;
        continue;
      }
      const type = role === "assistant" && rawPart?.type === "thinking" ? "thinking" : "text";
      if (rawPart?.type !== "text" && typeof rawPart !== "string" && type !== "thinking") continue;
      const rawText = typeof rawPart === "string"
        ? rawPart
        : type === "thinking" ? rawPart.thinking ?? rawPart.text ?? rawPart.content : rawPart.text ?? rawPart.content;
      if (typeof rawText !== "string") continue;
      const property = type === "thinking" ? "thinking" : "text";
      const lines = normalizeWebuiSubagentTranscriptLines(rawText);
      for (let lineIndex = lines.length - 1; lineIndex >= 0 && remainingParts > 0; lineIndex -= 1) {
        const line = lines[lineIndex];
        if (line.trim().toLowerCase() === "(no output)") continue;
        const previous = content[0];
        if (previous?.type === type) previous[property] = `${line}\n${previous[property]}`;
        else content.unshift({ type, [property]: line });
        remainingParts -= 1;
      }
    }
    if (!content.length) continue;
    const timestamp = Number.isFinite(rawMessage.timestamp)
      ? rawMessage.timestamp
      : normalizeWebuiSubagentText(rawMessage.timestamp, 128) || undefined;
    messages.unshift({
      role,
      ...(timestamp ? { timestamp } : {}),
      ...(role === "toolResult" ? {
        ...(normalizeWebuiSubagentText(rawMessage.toolCallId || rawMessage.tool_call_id, 240) ? { toolCallId: normalizeWebuiSubagentText(rawMessage.toolCallId || rawMessage.tool_call_id, 240) } : {}),
        ...(normalizeWebuiSubagentText(rawMessage.toolName || rawMessage.name, 120) ? { toolName: normalizeWebuiSubagentText(rawMessage.toolName || rawMessage.name, 120) } : {}),
        ...(rawMessage.isError === true ? { isError: true } : {}),
      } : {}),
      content,
    });
  }
  return messages;
}

function normalizeWebuiSubagentTelemetry(value, fallback = {}) {
  const telemetry = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const number = (candidate, limit = WEBUI_SUBAGENT_TELEMETRY_TOKEN_LIMIT) => (
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 && candidate <= limit ? candidate : null
  );
  const model = normalizeWebuiSubagentText(telemetry?.model, 240)
    || normalizeWebuiSubagentText(fallback.model, 240)
    || null;
  const effort = normalizeWebuiSubagentText(telemetry?.effort, 40)
    || normalizeWebuiSubagentText(fallback.effort, 40)
    || null;
  return {
    promptInjectionTokens: number(telemetry?.promptInjectionTokens),
    inputTokens: number(telemetry?.inputTokens),
    outputTokens: number(telemetry?.outputTokens),
    tokenSpeed: number(telemetry?.tokenSpeed, WEBUI_SUBAGENT_TELEMETRY_SPEED_LIMIT),
    contextTokens: number(telemetry?.contextTokens),
    contextWindow: number(telemetry?.contextWindow, WEBUI_SUBAGENT_TELEMETRY_CONTEXT_WINDOW_LIMIT),
    model,
    effort,
  };
}

function normalizeWebuiSubagentOutput(value, selection) {
  if (!value || typeof value !== "object" || value.version !== 1) throw makeHttpError(502, "Invalid subagent output response from Web UI helper");
  const rawAgent = value.agent && typeof value.agent === "object" ? value.agent : {};
  const recentOutput = (Array.isArray(rawAgent.recentOutput) ? rawAgent.recentOutput : [])
    .slice(-WEBUI_SUBAGENT_OUTPUT_LINE_LIMIT)
    .map((line) => String(line ?? "").replace(/\r/g, "").slice(0, WEBUI_SUBAGENT_OUTPUT_LINE_LENGTH));
  const recentTools = (Array.isArray(rawAgent.recentTools) ? rawAgent.recentTools : []).slice(-20).map((entry) => ({
    tool: normalizeWebuiSubagentText(entry?.tool, 120),
    args: normalizeWebuiSubagentText(entry?.args, 500),
    endMs: Number.isFinite(entry?.endMs) ? entry.endMs : undefined,
  })).filter((entry) => entry.tool);
  const transcript = normalizeWebuiSubagentTranscript(rawAgent.transcript);
  return {
    version: 1,
    runId: normalizeWebuiSubagentText(value.runId, 160) || selection.run.id,
    source: normalizeWebuiSubagentSource(selection.run?.source || value.source),
    mode: ["single", "parallel", "chain"].includes(value.mode) ? value.mode : selection.run.mode,
    startedAt: Number.isFinite(value.startedAt) ? value.startedAt : selection.run.startedAt,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    agent: {
      id: selection.agent.id,
      name: normalizeWebuiSubagentText(rawAgent.name, 160) || selection.agent.name,
      index: Number.isInteger(rawAgent.index) ? rawAgent.index : selection.agent.index,
      nested: rawAgent.nested === true,
      status: normalizeWebuiSubagentText(rawAgent.status, 40) || "running",
      activityState: normalizeWebuiSubagentText(rawAgent.activityState, 80) || undefined,
      currentTool: normalizeWebuiSubagentText(rawAgent.currentTool, 120) || undefined,
      currentToolArgs: normalizeWebuiSubagentText(rawAgent.currentToolArgs, 500) || undefined,
      currentPath: normalizeWebuiSubagentText(rawAgent.currentPath, 1000) || undefined,
      turnCount: Number.isFinite(rawAgent.turnCount) ? rawAgent.turnCount : undefined,
      toolCount: Number.isFinite(rawAgent.toolCount) ? rawAgent.toolCount : undefined,
      tokens: Number.isFinite(rawAgent.tokens) ? rawAgent.tokens : undefined,
      model: normalizeWebuiSubagentText(rawAgent.model, 240) || selection.agent.model || undefined,
      thinking: normalizeWebuiSubagentText(rawAgent.thinking, 40) || selection.agent.thinking || undefined,
      telemetry: normalizeWebuiSubagentTelemetry(rawAgent.telemetry, {
        model: normalizeWebuiSubagentText(rawAgent.model, 240) || selection.agent.model,
        effort: normalizeWebuiSubagentText(rawAgent.thinking, 40) || selection.agent.thinking,
      }),
      recentTools,
      recentOutput,
      transcript,
      unavailable: rawAgent.unavailable === true || undefined,
      unavailableReason: rawAgent.unavailable === true ? normalizeWebuiSubagentText(rawAgent.unavailableReason, 1000) || "Live output is unavailable for this agent." : undefined,
      error: normalizeWebuiSubagentText(rawAgent.error, 1000) || undefined,
    },
  };
}

function webuiSubagentRunSupportsInteraction(run) {
  return run?.source !== "recovered" && run?.provisional !== true && run?.controllable !== false;
}

function requireInteractiveWebuiSubagentRun(tab, runId) {
  const normalizedRunId = normalizeWebuiSubagentText(runId, 160);
  const runs = Array.isArray(tab.webuiSubagents?.runs) ? tab.webuiSubagents.runs : [];
  const run = runs.find((candidate) => candidate.id === normalizedRunId);
  if (!run) throw makeHttpError(404, `Subagent run not found: ${normalizedRunId}`);
  if (!webuiSubagentRunSupportsInteraction(run)) throw makeHttpError(409, "Recovered provisional subagents are status-only");
  return run;
}

function rejectUnsupportedWebuiSubagentRun(tab, runId) {
  const normalizedRunId = normalizeWebuiSubagentText(runId, 160);
  const runs = Array.isArray(tab.webuiSubagents?.runs) ? tab.webuiSubagents.runs : [];
  const run = runs.find((candidate) => candidate.id === normalizedRunId);
  if (run && !webuiSubagentRunSupportsInteraction(run)) throw makeHttpError(409, "Recovered provisional subagents are status-only");
  return normalizedRunId;
}

async function webuiSubagentOutputData(tab, runId, agentId) {
  const run = requireInteractiveWebuiSubagentRun(tab, runId);
  const agent = (Array.isArray(run.agents) ? run.agents : []).find((candidate) => candidate.id === agentId);
  if (!agent) throw makeHttpError(404, `Subagent not found: ${agentId}`);
  const data = await sendWebuiHelperCommand(tab, "subagent-output", { runId, agentId });
  return normalizeWebuiSubagentOutput(data, { run, agent });
}

function canonicalOutputSelection(groupId, runId, instanceId, state) {
  const group = state.overview.groups.find((candidate) => candidate.id === groupId);
  const run = group?.runs.find((candidate) => candidate.id === runId);
  const agent = run?.agents.find((candidate) => candidate.instanceId === instanceId);
  if (!group || !run || !agent) throw makeHttpError(404, "Agent run output is no longer tracked");
  for (const selection of state.selections.values()) {
    if (selection.instance.runId !== runId || selection.instance.instanceId !== instanceId) continue;
    if (group.kind === "tab") {
      const tab = tabs.get(group.tabId);
      if (selection.tab?.id === group.tabId || selection.instance.parentSessionId === tabParentSessionId(tab)) return { group, run, agent, selection };
    } else if (!selection.instance.parentSessionId || ![...tabs.values()].some((tab) => tabParentSessionId(tab) === selection.instance.parentSessionId)) {
      return { group, run, agent, selection };
    }
  }
  throw makeHttpError(404, "Agent run output is no longer tracked");
}

async function boundedSessionMessages(sessionFile, maximum = 256 * 1024) {
  const handle = await open(sessionFile, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, maximum);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, info.size - length));
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    if (info.size > length) lines.shift();
    const messages = [];
    for (const line of lines) {
      if (!line || Buffer.byteLength(line) > 64 * 1024) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type === "message" && entry.message) messages.push(entry.message);
        else if (["assistant", "toolResult"].includes(entry?.role)) messages.push(entry);
      } catch {}
    }
    return messages;
  } finally { await handle.close(); }
}

function registryOutputData(instance, events = [], transcript = []) {
  const outputLines = events.filter((event) => typeof event?.message === "string").slice(-WEBUI_SUBAGENT_OUTPUT_LINE_LIMIT).map((event) => event.message.slice(0, WEBUI_SUBAGENT_OUTPUT_LINE_LENGTH));
  const recentTools = events.filter((event) => typeof event?.tool === "string").slice(-20).map((event) => ({ tool: event.tool.slice(0, 120), args: "", endMs: Number.isFinite(event.at) ? event.at : undefined }));
  return {
    version: 1, runId: instance.runId, source: instance.launcher, mode: "single", startedAt: instance.startedAt, updatedAt: instance.updatedAt,
    agent: {
      id: instance.instanceId, name: instance.name || "Agent", index: 0, nested: false, status: instance.status,
      activityState: instance.activityState, currentTool: instance.currentTool, model: instance.model, thinking: instance.thinking,
      telemetry: normalizeWebuiSubagentTelemetry(null, { model: instance.model, effort: instance.thinking }),
      recentTools, recentOutput: outputLines, transcript: normalizeWebuiSubagentTranscript(transcript),
      ...(!outputLines.length && !transcript.length ? { unavailable: true, unavailableReason: "No bounded output has been registered for this agent." } : {}),
    },
  };
}

async function canonicalWebuiSubagentOutputData(groupId, runId, instanceId) {
  const state = await webuiSubagentsData({ includeSelections: true });
  const { selection } = canonicalOutputSelection(groupId, runId, instanceId, state);
  const instance = selection.instance;
  if (!instance.capabilities.open) throw makeHttpError(409, "This agent provider does not support opening output");
  if (selection.kind === "legacy-helper") return webuiSubagentOutputData(selection.tab, selection.run.id, selection.agent.id);
  if (selection.kind === "helper") {
    if (instance.outputRef.kind !== "helper") return registryOutputData(instance);
    const data = await sendWebuiHelperCommand(selection.tab, "subagent-output", { outputId: instance.outputRef.id });
    const run = { id: instance.runId, source: instance.origin || "async", mode: "single", startedAt: instance.startedAt };
    const agent = { id: instance.instanceId, name: instance.name || "Agent", index: 0, model: instance.model, thinking: instance.thinking };
    return normalizeWebuiSubagentOutput(data, { run, agent });
  }
  if (instance.outputRef.kind === "session-jsonl") {
    const locator = await agentRunRegistry.resolveSessionLocator(instance.outputRef.id, { allowedRoots: allowedSessionDirs() });
    if (!locator) throw makeHttpError(404, "Registered session output is unavailable");
    return registryOutputData(instance, [], await boundedSessionMessages(locator.sessionFile));
  }
  if (["rpc-events", "json-events", "plain-log", "registry-artifact"].includes(instance.outputRef.kind)) {
    const artifact = await agentRunRegistry.readArtifact(instance.outputRef.id);
    return registryOutputData(instance, artifact?.events || []);
  }
  return registryOutputData(instance);
}

async function canonicalWebuiSubagentAction(action, body) {
  const groupId = normalizeWebuiSubagentText(body.group, 240);
  const runId = normalizeWebuiSubagentText(body.runId || body.run, 160);
  const requestedAgentId = normalizeWebuiSubagentText(body.agentId || body.agent, 160);
  if (!groupId || !runId) throw makeHttpError(400, "group and runId are required");
  const state = await webuiSubagentsData({ includeSelections: true });
  const group = state.overview.groups.find((candidate) => candidate.id === groupId);
  const run = group?.runs.find((candidate) => candidate.id === runId);
  const agent = requestedAgentId ? run?.agents.find((candidate) => candidate.instanceId === requestedAgentId) : run?.agents[0];
  if (!group || !run || !agent) throw makeHttpError(404, "Agent run is no longer tracked");
  const { selection } = canonicalOutputSelection(groupId, runId, agent.instanceId, state);
  if (action === "cancel") {
    if (selection.kind !== "helper" && selection.kind !== "legacy-helper") throw makeHttpError(409, "This agent provider does not support cancellation");
    if (!agent.capabilities?.cancel) throw makeHttpError(409, "This agent provider does not support cancellation");
    return sendWebuiHelperCommand(selection.tab, "subagent-cancel", { runId: selection.kind === "legacy-helper" ? selection.run.id : selection.instance.runId, reason: body.reason, note: body.note });
  }
  if (!agentRunProjectionCanBeDismissed(selection.instance)) {
    throw makeHttpError(409, "Only terminal retained runs or stale attached-session projections can be dismissed");
  }
  if (selection.kind === "registry") {
    const registrySelections = run.agents.map((candidate) => canonicalOutputSelection(groupId, runId, candidate.instanceId, state).selection);
    if (registrySelections.some((candidate) => candidate.kind !== "registry" || !agentRunProjectionCanBeDismissed(candidate.instance))) {
      throw makeHttpError(409, "Only terminal registry-owned runs or stale attached-session projections can be dismissed as one projection");
    }
    for (const candidate of registrySelections) dismissAgentRunProjection(candidate.instance);
    return { runId: selection.instance.runId, dismissed: true };
  }
  if (selection.kind !== "helper" && selection.kind !== "legacy-helper") throw makeHttpError(409, `This agent provider does not support ${action}`);
  return sendWebuiHelperCommand(selection.tab, "subagent-dismiss", { runId: selection.kind === "legacy-helper" ? selection.run.id : selection.instance.runId });
}

function restorableTabDescriptor(tab, state = null) {
  return normalizeRestoreTabDescriptor({
    id: tab.id,
    index: tab.index,
    title: tab.title,
    titleSource: tab.titleSource,
    conversationStarted: tab.conversationStarted,
    cwd: tab.cwd,
    workspaceKind: tab.workspaceKind,
    noProjectId: tab.noProjectId,
    sessionFile: sessionFileFromState(state) || tabRestorableSessionFile(tab),
  }, new Set());
}

function restorableTabKey(tab) {
  if (tab.id) return `id:${tab.id}`;
  if (tab.sessionFile) return `session:${tab.sessionFile}`;
  return `tab:${tab.index || "?"}:${tab.title || ""}:${tab.cwd || ""}`;
}

function restorableTabSortIndex(tab) {
  return Number.isInteger(tab.index) && tab.index > 0 ? tab.index : Number.MAX_SAFE_INTEGER;
}

function mergeRestorableTabDescriptors(...sources) {
  const merged = [];
  const seen = new Set();
  for (const source of sources) {
    for (const item of Array.isArray(source) ? source : []) {
      const descriptor = normalizeRestoreTabDescriptor(item, new Set());
      if (!descriptor) continue;
      const key = restorableTabKey(descriptor);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(descriptor);
    }
  }
  return merged
    .sort((a, b) => restorableTabSortIndex(a) - restorableTabSortIndex(b) || String(a.title || "").localeCompare(String(b.title || "")))
    .slice(0, RESTORE_TAB_LIMIT);
}

async function restorableTabsForRestart() {
  const liveDescriptors = await Promise.all([...tabs.values()].map(async (tab) => {
    const state = await currentSessionState(tab).catch(() => tab.lastState || null);
    return restorableTabDescriptor(tab, state);
  }));
  return mergeRestorableTabDescriptors(liveDescriptors);
}

function workspaceLoadWarning(savedTabId, code, message) {
  return { savedTabId, code, message };
}

async function workspaceLoadDescriptor(descriptor, warnings) {
  const next = { ...descriptor };
  const identity = await resolveNoProjectWorkspace(agentDir, next);
  if (identity.workspaceKind === "no-project") {
    Object.assign(next, identity);
    if (next.sessionFile && !(await stat(next.sessionFile).catch(() => null))?.isFile()) {
      throw makeHttpError(400, "No Project saved session file is unavailable");
    }
    return next;
  }
  if (next.sessionFile) {
    const sessionInfo = await stat(next.sessionFile).catch(() => null);
    if (!sessionInfo?.isFile()) {
      delete next.sessionFile;
      warnings.push(workspaceLoadWarning(descriptor.id, "missing_session_file", "The saved session file is unavailable; opened a fresh session instead."));
    }
  }
  try {
    next.cwd = await resolveCwd(next.cwd, options.cwd);
  } catch {
    next.cwd = options.cwd;
    warnings.push(workspaceLoadWarning(descriptor.id, "missing_cwd", "The saved working directory is unavailable; opened in the default directory instead."));
  }
  return next;
}

function workspaceReplacementIntent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.replaceOpenTabs !== true) {
    throw makeHttpError(400, "Replacing open tabs requires replaceOpenTabs: true and one save or discard decision");
  }
  const hasDiscard = Object.hasOwn(body, "discardCurrent");
  const hasSave = Object.hasOwn(body, "saveCurrent");
  if (hasDiscard === hasSave) {
    throw makeHttpError(400, "Choose exactly one of discardCurrent or saveCurrent when replacing open tabs");
  }
  if (hasDiscard) {
    if (body.discardCurrent !== true) throw makeHttpError(400, "discardCurrent must be true when replacing open tabs");
    return { discardCurrent: true };
  }
  if (!body.saveCurrent || typeof body.saveCurrent !== "object" || Array.isArray(body.saveCurrent)) {
    throw makeHttpError(400, "saveCurrent must be an object when replacing open tabs");
  }
  return { saveCurrent: body.saveCurrent };
}

function openTabsUnchanged(tabIds) {
  return tabs.size === tabIds.length && tabIds.every((id) => tabs.has(id));
}

async function saveCurrentWorkspaceForReplacement(saveCurrent, tabIds) {
  const descriptors = await restorableTabsForRestart();
  const descriptorIds = new Set(descriptors.map((descriptor) => descriptor.id));
  if (descriptors.length !== tabIds.length || tabIds.some((id) => !descriptorIds.has(id))) {
    throw makeHttpError(400, `Only ${RESTORE_TAB_LIMIT} open threads can be saved; close some threads or choose Load without saving`);
  }
  try {
    return await saveWebuiWorkspace({
      name: saveCurrent.name,
      groups: saveCurrent.groups,
      activeTabId: saveCurrent.activeTabId,
      overwrite: saveCurrent.overwrite === true,
      tabs: descriptors,
    });
  } catch (error) {
    if (error?.code === "WORKSPACE_NAME_CONFLICT") throw makeHttpError(409, error.message);
    throw error;
  }
}

async function loadWebuiWorkspace(id, body = {}) {
  if (workspaceLoadInProgress) throw makeHttpError(409, "A workspace load is already in progress");
  workspaceLoadInProgress = true;
  try {
    const workspace = await getWebuiWorkspace(id);
    if (!workspace) throw makeHttpError(404, "Workspace not found");

    const openTabIds = [...tabs.keys()];
    let closedIds = [];
    let savedCurrent;
    if (openTabIds.length) {
      const intent = workspaceReplacementIntent(body);
      if (intent.saveCurrent) {
        savedCurrent = await saveCurrentWorkspaceForReplacement(intent.saveCurrent, openTabIds);
        broadcastServerEvent({
          type: "webui_workspace_saved",
          workspaceId: savedCurrent.workspace.id,
          workspaceName: savedCurrent.workspace.name,
          tabCount: savedCurrent.workspace.tabCount,
          evictedIds: savedCurrent.evicted.map((workspace) => workspace.id),
        });
      }
      if (!openTabsUnchanged(openTabIds)) {
        const savedNote = savedCurrent ? "The current workspace was saved, but " : "";
        throw makeHttpError(409, `${savedNote}open threads changed before the workspace could be replaced`);
      }
      closedIds = (await closeTabs(openTabIds, { allowEmpty: true })).map((tab) => tab.id);
    }

    const warnings = [];
    const idMap = {};
    for (const descriptor of workspace.tabs) {
      try {
        const preflighted = await workspaceLoadDescriptor(descriptor, warnings);
        const tab = await createTab(preflighted);
        idMap[descriptor.id] = tab.id;
      } catch (error) {
        warnings.push(workspaceLoadWarning(descriptor.id, "tab_create_failed", `Could not restore this thread: ${sanitizeError(error)}`));
      }
    }
    const groups = workspace.groups.map((group) => ({
      title: group.title,
      tabIds: group.tabIds.map((tabId) => idMap[tabId]).filter(Boolean),
    })).filter((group) => group.tabIds.length);
    const activeTabId = workspace.activeTabId ? idMap[workspace.activeTabId] || null : null;
    const data = {
      tabs: listTabs(),
      idMap,
      groups,
      activeTabId,
      warnings,
      closedIds,
      ...(savedCurrent ? { savedCurrent } : {}),
    };
    broadcastServerEvent({
      type: "webui_workspace_loaded",
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      tabCount: data.tabs.length,
      warningCount: warnings.length,
      closedIds,
      ...(savedCurrent ? { savedCurrentId: savedCurrent.workspace.id } : {}),
    });
    return data;
  } finally {
    workspaceLoadInProgress = false;
  }
}

async function spawnRestartServer(restorableTabs, supervisorCursor, updateRestart = null) {
  const restore = await createRestoreFile(agentDir, restorableTabs || []);
  const env = {
    ...process.env,
    PI_WEBUI_RESTORE_FILE: restore.file,
    PI_WEBUI_START_DELAY_MS: "1200",
  };
  if (supervisorCursor) env.PI_WEBUI_RPC_SUPERVISOR_CURSOR = JSON.stringify(supervisorCursor);
  else delete env.PI_WEBUI_RPC_SUPERVISOR_CURSOR;
  if (updateRestart) {
    env.PI_WEBUI_NATIVE_RESTART_TRANSACTION = updateRestart.transactionId;
    env.PI_WEBUI_NATIVE_RESTART_TOKEN = updateRestart.lockToken;
  } else {
    delete env.PI_WEBUI_NATIVE_RESTART_TRANSACTION;
    delete env.PI_WEBUI_NATIVE_RESTART_TOKEN;
  }
  if (webuiDevServer) env.PI_WEBUI_DEV = "1";
  else delete env.PI_WEBUI_DEV;
  const launcher = path.join(packageRoot, "bin", "pi-webui-launcher.mjs");
  const child = spawn(process.execPath, [launcher, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}

let updateStatusCache = null;
let updateStatusCacheAt = 0;
const componentUpdateState = new ComponentUpdateState();
const packageUpdates = createPackageUpdates({ agentDir, cwd: options.cwd });

async function canonicalUpdateIdentities({ forcePi = false } = {}) {
  const pi = await canonicalPiRuntimeIdentity({ force: forcePi });
  const webui = resolveWebuiRuntimeIdentity({
    packageRoot,
    packageName: WEBUI_PACKAGE,
    version: packageJson.version,
    owner: { manager: webuiDevServer ? "source" : "managed-bootstrap" },
  });
  return { pi, webui };
}

async function nativeUpdateContext() {
  const stateRoot = await sharedUpdateRoot();
  try {
    await lstat(updateStatePaths(agentDir).installLock);
    throw makeHttpError(409, "A legacy update lock is present; inspect that job and stop it safely before native updates.");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const pathPi = await resolveUpdatePathPi({ runVersion: runCommand });
  const npmInvocation = resolveNpmCommandInvocation([]);
  let npm = null;
  // A configured JavaScript file is not evidence of npm: first prove that
  // the CLI belongs to an npm package, then probe its actual global effects.
  if (["node-cli", "configured-cli"].includes(npmInvocation.source) && path.isAbsolute(npmInvocation.command) && path.isAbsolute(npmInvocation.args[0] || "")) {
    const cli = await realpath(npmInvocation.args[0]).catch(() => "");
    const npmPackageRoot = path.resolve(path.dirname(cli), "..");
    let npmManifest = null;
    try { npmManifest = JSON.parse(await readFile(path.join(npmPackageRoot, "package.json"), "utf8")); }
    catch { /* An unproven npm executable remains manual-only. */ }
    if (cli === path.join(npmPackageRoot, "bin", "npm-cli.js") && npmManifest?.name === "npm" &&
        String(npmManifest.bin?.npm || "").replace(/^\.\//, "") === "bin/npm-cli.js" &&
        await realpath(npmPackageRoot) === npmPackageRoot) {
      const probe = async (args) => runCommand(npmInvocation.command, [...npmInvocation.args, ...args], { cwd: stateRoot, timeoutMs: 10_000, maxOutputLength: 4_000 });
      const [root, prefix] = await Promise.all([probe(["root", "-g"]), probe(["prefix", "-g"])]);
      if (root.exitCode === 0 && prefix.exitCode === 0 && !root.timedOut && !prefix.timedOut && !root.error && !prefix.error) {
        const [userconfig, globalconfig] = await Promise.all([probe(["config", "get", "userconfig"]), probe(["config", "get", "globalconfig"])]);
        const configPath = (result) => result.exitCode === 0 && !result.error && !result.timedOut &&
          path.isAbsolute(result.stdout.trim()) && !/[\r\n]/.test(result.stdout.trim()) ? path.resolve(result.stdout.trim()) : "";
        const configFiles = [configPath(userconfig), configPath(globalconfig)];
        if (configFiles.every(Boolean)) npm = { invocation: { command: await realpath(npmInvocation.command), args: [cli] },
          root: root.stdout.trim(), prefix: prefix.stdout.trim(), configFiles };
      }
    }
  }
  let globalSettings = {};
  const settingsFile = path.join(agentDir, "settings.json");
  try { globalSettings = JSON.parse(await readFile(settingsFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw makeHttpError(409, "Pi user settings cannot be inspected safely."); }
  return { stateRoot, pathPi, npm, globalSettings, settingsFile };
}

async function createNativeServerPlan(targets, { persist = true } = {}) {
  const requested = targets[0];
  const context = await nativeUpdateContext();
  const accepted = [];
  const refusals = [];
  const include = async (item) => {
    if (!item.eligible) { refusals.push(item.guidance); return; }
    item.driver = item.command.args[0];
    accepted.push(item);
  };
  if (requested === "pi") {
    if (!context.npm || !context.pathPi.eligible || path.resolve(context.pathPi.prefix) !== path.resolve(context.npm.prefix) || context.globalSettings.npmCommand) {
      refusals.push("PATH Pi's npm-global owner or configured npmCommand cannot be proven; update Pi manually.");
    } else await include(selfUpdateCommand(context.pathPi));
  } else {
    if (context.npm) await include(await npmGlobalWebuiTarget({ nodeModulesRoot: context.npm.root, prefix: context.npm.prefix, npmInvocation: context.npm.invocation }));
    else refusals.push("The configured global npm executable and prefix are unproven; npm-global Web UI needs a manual update.");
    await include(await piUserWebuiTarget({ agentDir, settings: context.globalSettings, pathPi: context.pathPi }));
    if (context.globalSettings.npmCommand || !context.npm) {
      const index = accepted.findIndex((target) => target.id === "webui:pi-user");
      if (index >= 0) accepted.splice(index, 1);
      refusals.push("Pi's npm command or custom npmCommand cannot be proven to preserve the confirmed user-only effects; update that installation manually.");
    }
  }
  if (accepted.length === 2 && accepted[0].installed.root === accepted[1].installed.root) {
    refusals.push("Pi and npm resolve to the same Web UI package root; updating it once through npm-global only.");
    accepted.pop();
  }
  if (!accepted.length) throw makeHttpError(409, refusals.join(" ") || "No proven native update target is installed.");
  const shell = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/bin/bash";
  let shellPath;
  try { shellPath = await realpath(shell); }
  catch { throw makeHttpError(409, "Required background PowerShell/Bash is unavailable; update manually."); }
  const canonicalAgentDir = await realpath(agentDir);
  const frozenEnv = frozenUpdateEnvironment(process.env, canonicalAgentDir);
  const npmConfigFiles = [...new Set([
    path.join(context.stateRoot, ".npmrc"),
    ...(context.npm?.configFiles || []),
    path.join(canonicalAgentDir, "npm", "etc", "npmrc"),
  ])];
  const bindings = await readUpdateContext({ env: frozenEnv, settingsPath: context.settingsFile, npmConfigFiles });
  const fileDigest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
  const activePiIdentity = (await canonicalPiRuntimeIdentity({ force: true })).active;
  const activePiCli = activePiIdentity?.cliPath || "";
  const activePiManifest = activePiIdentity?.packageRoot ? path.join(activePiIdentity.packageRoot, "package.json") : "";
  const plan = await createNativeUpdatePlan({ requested, targets: accepted, refusals,
    pathPi: { eligible: context.pathPi.eligible === true, version: context.pathPi.version || "",
      packageRoot: context.pathPi.packageRoot || "", executable: context.pathPi.executable || "",
      cli: context.pathPi.cli || "", guidance: context.pathPi.guidance || "" },
    context: { cwd: context.stateRoot, agentDir: canonicalAgentDir, npmPrefix: context.npm?.prefix, shell: shellPath,
      shellDigest: await fileDigest(shellPath), nodeDigest: await fileDigest(process.execPath),
      npmDriver: context.npm?.invocation.args[0] || "", npmDriverDigest: context.npm ? await fileDigest(context.npm.invocation.args[0]) : "",
      settingsPath: context.settingsFile, npmConfigFiles, ...bindings,
      ownerPackageRoot: realpathSync(packageRoot), ownerBootIdentity: bootIdentity },
    active: { pi: activePiIdentity?.version || "unknown", piRoot: activePiIdentity?.packageRoot || "",
      piCli: activePiCli, piCliDigest: activePiCli ? await fileDigest(activePiCli) : "",
      piManifestDigest: activePiManifest ? await fileDigest(activePiManifest) : "",
      webui: packageJson.version, webuiRoot: packageRoot },
  });
  if (persist) await persistSharedJob(context.stateRoot, { transactionId: plan.transactionId, phase: "planned", plan });
  return plan;
}

async function applyNativeServerPlan(transactionId, digest) {
  const stateRoot = await sharedUpdateRoot();
  const job = await inspectNativeJob(stateRoot, transactionId);
  if (!job) throw makeHttpError(404, "Update job not found.");
  if (job.phase !== "planned") throw makeHttpError(409, "This update job has already been launched or is recovering.");
  validateNativePlan(job.plan, digest);
  const context = await nativeUpdateContext();
  if (job.plan.context.agentDir !== await realpath(agentDir) || job.plan.context.npmPrefix !== (context.npm?.prefix || "")) {
    throw makeHttpError(409, "Confirmed update context has changed; request another preview.");
  }
  if (optionalFeatureAuditCoordinator?.mutation) throw makeHttpError(409, "Another package mutation is in progress.");
  for (const tab of tabs.values()) {
    const state = await tab.rpc.send({ type: "get_state" }, 3_000).catch(() => null);
    if (!state || state.success === false || state.data?.isStreaming || state.data?.isCompacting || tab.activity?.isWorking ||
        (tab.bashQueue?.length || 0) > 0 || (tab.compactionQueue?.length || 0) > 0 || pendingExtensionUiRequests(tab).length) {
      throw makeHttpError(409, "Known Pi tab work is busy or could not prove idle; update was not launched.");
    }
  }
  const plannedIds = job.plan.targets.map((target) => target.id).join(",");
  const current = await createNativeServerPlan([job.plan.requested], { persist: false });
  if (JSON.stringify(current.context) !== JSON.stringify(job.plan.context) ||
      JSON.stringify(current.active) !== JSON.stringify(job.plan.active) ||
      JSON.stringify(current.pathPi) !== JSON.stringify(job.plan.pathPi) ||
      current.targets.map((target) => target.id).join(",") !== plannedIds || current.targets.some((target, i) =>
    target.driverDigest !== job.plan.targets[i].driverDigest || target.beforeVersion !== job.plan.targets[i].beforeVersion ||
    target.effectRoot !== job.plan.targets[i].effectRoot || JSON.stringify(target.command) !== JSON.stringify(job.plan.targets[i].command))) {
    throw makeHttpError(409, "Confirmed commands or installed roots changed; request another preview.");
  }
  if (rpcSupervisor && !rpcSupervisor.isCurrentVersion()) {
    throw makeHttpError(409, "The retained RPC supervisor does not support update admission; fully stop and restart Web UI first.");
  }
  const requiredParticipants = [{ kind: "server", token: nativeAdmissionState?.participant.token }];
  if (rpcSupervisor) requiredParticipants.push({ kind: "rpc-supervisor", pid: rpcSupervisor.state.pid });
  return launchNativeUpdate(job.plan, digest, { stateRoot, env: frozenUpdateEnvironment(process.env, job.plan.context.agentDir),
    requiredParticipants });
}

async function nativeRestartIdle(job, stateRoot) {
  if (!nativeAdmittedWork.idle) return false;
  const participants = await affectedParticipants(stateRoot, job.lock);
  if (!participants.length || participants.some((participant) => participant.ack?.lockToken !== job.lock.token ||
      participant.ack.idle !== true || Date.now() - Date.parse(participant.ack.at) > 2_000)) return false;
  for (const tab of tabs.values()) {
    const state = await tab.rpc.send({ type: "get_state" }, 3_000).catch(() => null);
    if (!state || state.success === false || state.data?.isStreaming || state.data?.isCompacting ||
        tab.activity?.isWorking || tab.rpc?.pending?.size || tab.bashQueue?.length || tab.compactionQueue?.length ||
        pendingExtensionUiRequests(tab).length || tab.browserPromptRequests?.size) return false;
  }
  return true;
}

async function continueNativeRestart(job, stateRoot) {
  const transactionId = job.transactionId;
  if (job.plan.context.ownerBootIdentity !== bootIdentity) {
    return { ...job, phase: "unknown", error: "The update owner exited before a verified restart; manual recovery is required." };
  }
  const verifiedTargets = job.verifiedTargets;
  const active = await canonicalPiRuntimeIdentity({ force: true });
  const activePi = verifiedTargets.find((target) => target.status === "healthy" &&
    (target.id === "pi" && target.installedRoot === job.plan.active.piRoot || target.piChanged === true) &&
    job.plan.active.piRoot === active.active?.packageRoot);
  const activeWebui = verifiedTargets.find((target) => target.id !== "pi" && target.status === "healthy" &&
    target.installedRoot === job.plan.active.webuiRoot && target.installedRoot === realpathSync(packageRoot));
  if ((activePi && tabs.size) || activeWebui) {
    if (!await nativeRestartIdle(job, stateRoot)) return inspectNativeJob(stateRoot, transactionId);
    if (activePi && [...tabs.values()].some((tab) => !(tab.rpc instanceof SupervisorPiRpcProcess)) ||
        activeWebui && !rpcSupervisor && tabs.size) {
      await persistSharedJob(stateRoot, { ...job, phase: "unknown", error: "Direct Pi tabs cannot be preserved across a fenced native restart." });
      return inspectNativeJob(stateRoot, transactionId);
    }
  }
  const action = path.join(job.jobDir, "restart-action.claim");
  let handle;
  try {
    handle = await open(action, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, bootIdentity, startedAt: new Date().toISOString() })}\n`);
    await handle.sync();
  } catch (error) { if (error?.code === "EEXIST") return inspectNativeJob(stateRoot, transactionId); throw error; }
  finally { await handle?.close(); }
  try {
    if (activePi && tabs.size) {
      for (const tab of tabs.values()) {
        await restartTabRpc(tab, "native-update", { transactionId, lockToken: job.lock.token,
          effectRoot: activePi.effectRoot, nonce: randomUUID() });
      }
    }
    if (activeWebui) {
      const restored = await restorableTabsForRestart();
      const child = await spawnRestartServer(restored, await prepareRpcSupervisorHandoff(), {
        transactionId, lockToken: job.lock.token,
      });
      await persistSharedJob(stateRoot, { ...job, phase: "restart-pending", successorPid: child.pid });
      setTimeout(() => { void shutdown("verified native Web UI update", { preserveSessions: true }); }, 20).unref();
      return inspectNativeJob(stateRoot, transactionId);
    }
    await releaseEffectLocks(job.lock, { completionVerified: true });
    await persistSharedJob(stateRoot, { ...job, phase: job.outcome });
    return inspectNativeJob(stateRoot, transactionId);
  } catch (error) {
    await persistSharedJob(stateRoot, { ...job, phase: "unknown", error: sanitizeComponentUpdateError(error) });
    return inspectNativeJob(stateRoot, transactionId);
  }
}

async function finalizeNativeJob(transactionId) {
  const stateRoot = await sharedUpdateRoot();
  const observed = await inspectNativeJob(stateRoot, transactionId);
  if (!observed || !["command-complete", "restart-authorized", "launch-failed"].includes(observed.phase)) return observed;
  const owner = observed.plan.context;
  if (owner.agentDir !== await realpath(agentDir) || owner.ownerPackageRoot !== realpathSync(packageRoot)) {
    return { ...observed, phase: "unknown", error: "Only the original agent directory and runtime may recover this job." };
  }
  if (owner.ownerBootIdentity !== bootIdentity) {
    return { ...observed, phase: "unknown", error: "Original job owner is not this server; recovery requires manual verification." };
  }
  if (observed.phase === "restart-authorized") return continueNativeRestart(observed, stateRoot);
  const claim = path.join(observed.jobDir, "finalize.claim");
  let handle;
  try {
    handle = await open(claim, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, bootIdentity, startedAt: new Date().toISOString() })}\n`);
    await handle.sync();
  } catch (error) { if (error?.code === "EEXIST") return inspectNativeJob(stateRoot, transactionId); throw error; }
  finally { await handle?.close(); }
  const job = await readSharedJob(stateRoot, transactionId);
  try {
    if (observed.phase === "launch-failed") {
      await releaseEffectLocks(job.lock, { completionVerified: true });
      await persistSharedJob(stateRoot, { ...job, phase: "failed", outcome: "failed",
        error: "PowerShell could not start; no native command ran." });
      return inspectNativeJob(stateRoot, transactionId);
    }
    if (observed.receipts.length !== job.plan.targets.length || observed.receipts.some((receipt, index) =>
      receipt.id !== job.plan.targets[index].id || !["changed", "unchanged", "failed"].includes(receipt.status))) {
      throw new Error("A native command completion receipt is missing, mismatched or uncertain.");
    }
    const verifiedTargets = [];
    for (let index = 0; index < job.plan.targets.length; index++) {
      const target = job.plan.targets[index];
      const receipt = observed.receipts[index];
      if (receipt.status !== "changed") {
        verifiedTargets.push({ id: target.id, effectRoot: target.effectRoot, status: receipt.status });
        continue;
      }
      try {
      const manifest = JSON.parse(await readFile(target.manifestPath, "utf8"));
      const comparison = comparePackageVersions(receipt.afterVersion, target.beforeVersion);
      if (manifest.name !== target.packageName || manifest.version !== receipt.afterVersion ||
          comparison === undefined || comparison <= 0) {
        throw new Error(`Installed identity/version for ${target.id} is not an independently verified upgrade.`);
      }
      if (target.id === "pi") {
        const result = await runCommand(target.command.command, [target.driver, "--version"], { cwd: job.plan.context.cwd, timeoutMs: 10_000 });
        if (result.exitCode !== 0 || result.timedOut || parseRuntimeVersion(result.stdout) !== receipt.afterVersion) {
          throw new Error("Updated Pi CLI did not pass its independent version check.");
        }
      } else {
        const candidate = await probeStartupRestore(path.join(target.installedRoot, "bin", "pi-webui.mjs"), { expectedVersion: receipt.afterVersion });
        if (!candidate.ok) throw new Error(`Updated Web UI did not pass isolated startup and restoration: ${candidate.error || "unknown failure"}`);
      }
      verifiedTargets.push({ id: target.id, effectRoot: target.effectRoot, status: "healthy", version: receipt.afterVersion,
        installedRoot: target.installedRoot });
      } catch (error) {
        verifiedTargets.push({ id: target.id, effectRoot: target.effectRoot, status: "unverified",
          error: sanitizeComponentUpdateError(error) });
      }
    }
    // A targeted WebUI command can replace its bundled or hoisted Pi even if
    // the WebUI manifest itself remains at the same version. Verify that
    // changed active dependency independently before authorizing its reload.
    const plannedPi = job.plan.active;
    const piEffect = affectedActivePiDependency(job.plan, verifiedTargets);
    if (piEffect && plannedPi.piCli && plannedPi.piManifestDigest) {
      try {
        const currentManifestDigest = createHash("sha256").update(await readFile(path.join(plannedPi.piRoot, "package.json"))).digest("hex");
        const currentCliDigest = createHash("sha256").update(await readFile(plannedPi.piCli)).digest("hex");
        if (currentManifestDigest !== plannedPi.piManifestDigest || currentCliDigest !== plannedPi.piCliDigest) {
          const currentPi = (await canonicalPiRuntimeIdentity({ force: true })).active;
          const currentManifest = JSON.parse(await readFile(path.join(plannedPi.piRoot, "package.json"), "utf8"));
          if (currentPi?.packageRoot !== plannedPi.piRoot || currentPi.cliPath !== plannedPi.piCli ||
              currentManifest.name !== "@earendil-works/pi-coding-agent" || currentManifest.version !== currentPi.version) {
            throw new Error("Changed active Pi dependency identity or version could not be verified.");
          }
          const webuiManifest = JSON.parse(await readFile(path.join(job.plan.targets.find((target) => target.id === piEffect.id).installedRoot, "package.json"), "utf8"));
          const healthy = await probeStartupRestore(path.join(job.plan.targets.find((target) => target.id === piEffect.id).installedRoot, "bin", "pi-webui.mjs"),
            { expectedVersion: webuiManifest.version });
          if (!healthy.ok) throw new Error("Changed active Pi dependency did not pass WebUI startup/restoration.");
          piEffect.status = "healthy";
          piEffect.piChanged = true;
          piEffect.version = webuiManifest.version;
        }
      } catch (error) {
        piEffect.status = "unverified";
        piEffect.error = sanitizeComponentUpdateError(error);
      }
    }
    const outcome = nativeUpdateOutcome(verifiedTargets);
    const authorized = { ...job, phase: "restart-authorized", outcome, verifiedTargets };
    await persistSharedJob(stateRoot, authorized);
    return continueNativeRestart(authorized, stateRoot);
  } catch (error) {
    await persistSharedJob(stateRoot, { ...job, phase: "unknown", error: sanitizeComponentUpdateError(error) });
    return inspectNativeJob(stateRoot, transactionId);
  }
}

function webuiComponentUpdateUnavailableReason() {
  if (webuiDevServer || !String(packageRoot).split(path.sep).includes("node_modules")) {
    return "Automatic Web UI update is unavailable from a source or development checkout.";
  }
  return "";
}

async function privilegedUpdateInProgress() {
  if (componentUpdateState.hasRunning()) return true;
  if (!nativeAdmissionState) return true;
  try { await assertEffectAdmission(nativeAdmissionState.root, nativeAdmissionState.participant.canonicalRoots); return false; }
  catch { return true; }
}

async function componentUpdatesForRequest(req, updateInProgress) {
  const webuiUnavailableReason = webuiComponentUpdateUnavailableReason();
  return componentUpdateState.publicStates({
    localRequest: isLocalRequest(req),
    updateInProgress,
    webuiAvailable: !webuiUnavailableReason,
    webuiUnavailableReason,
  });
}

function updateChecksSkippedReason() {
  if (process.env.PI_OFFLINE) return "PI_OFFLINE is set";
  if (process.env.PI_SKIP_VERSION_CHECK) return "PI_SKIP_VERSION_CHECK is set";
  return "";
}

function basePackageUpdateStatus(packageName, currentVersion) {
  return {
    packageName,
    currentVersion: String(currentVersion || ""),
    latestVersion: null,
    updateAvailable: false,
    checked: false,
    skipped: false,
    skippedReason: "",
    error: "",
  };
}

async function checkLatestPiReleaseStatus() {
  const currentVersion = String(piPackageJson.version || "");
  const status = basePackageUpdateStatus(PI_CODING_AGENT_PACKAGE, currentVersion);
  status.activeRuntimeVersion = "unknown";
  status.pathInstallationVersion = "unknown";
  status.pathGuidance = "";
  const skippedReason = updateChecksSkippedReason();
  if (skippedReason) {
    status.skipped = true;
    status.skippedReason = skippedReason;
    return status;
  }
  try {
    const data = await fetchJsonWithTimeout(PI_LATEST_VERSION_URL, {
      headers: {
        "User-Agent": `pi-webui/${packageJson.version} pi/${currentVersion || "unknown"}`,
        accept: "application/json",
      },
    });
    const latestVersion = typeof data.version === "string" ? data.version.trim() : "";
    if (!latestVersion) throw new Error("latest-version response did not include a version");
    status.latestVersion = latestVersion;
    status.packageName = typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : PI_CODING_AGENT_PACKAGE;
    status.note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : "";
    status.updateAvailable = status.currentVersion ? isNewerPackageVersion(latestVersion, status.currentVersion) : false;
    status.checked = true;
  } catch (error) {
    status.error = sanitizeError(error);
  }
  return status;
}

function npmLatestPackageUrl(packageName) {
  return `${NPM_REGISTRY_URL}/${encodeURIComponent(packageName)}/latest`;
}

async function checkLatestNpmPackageStatus(packageName, currentVersion) {
  const status = basePackageUpdateStatus(packageName, currentVersion);
  const skippedReason = updateChecksSkippedReason();
  if (skippedReason) {
    status.skipped = true;
    status.skippedReason = skippedReason;
    return status;
  }
  try {
    const data = await fetchJsonWithTimeout(npmLatestPackageUrl(packageName), {
      headers: {
        "User-Agent": `pi-webui/${packageJson.version}`,
        accept: "application/json",
      },
    });
    const latestVersion = typeof data.version === "string" ? data.version.trim() : "";
    if (!latestVersion) throw new Error(`${packageName} latest metadata did not include a version`);
    status.latestVersion = latestVersion;
    status.updateAvailable = status.currentVersion ? isNewerPackageVersion(latestVersion, status.currentVersion) : false;
    status.checked = true;
  } catch (error) {
    status.error = sanitizeError(error);
  }
  return status;
}

async function updateStatusForRequest(status, req) {
  const localRequest = isLocalRequest(req);
  const nativeJobs = packageUpdates.getJobs();
  const updateInProgress = packageUpdates.running;
  return {
    ...status,
    canRunUpdate: localRequest && !updateInProgress,
    updateInProgress,
    restartRequired: Object.values(nativeJobs).some((job) => job?.restartRequired),
    componentUpdates: componentUpdateState.publicStates({ localRequest, updateInProgress, webuiAvailable: true, webuiUnavailableReason: "" }),
    ...(localRequest ? { nativeJobs, nativeJobDiscoveryError: "" } : {}),
  };
}

async function getUpdateStatus({ force = false } = {}) {
  const now = Date.now();
  if (!force && updateStatusCache && now - updateStatusCacheAt < UPDATE_STATUS_CACHE_MS) return updateStatusCache;
  const [piStatus, webuiStatus] = await Promise.all([
    checkLatestPiReleaseStatus(),
    checkLatestNpmPackageStatus(WEBUI_PACKAGE, packageJson.version),
  ]);
  const updateAvailable = !!(piStatus.updateAvailable || webuiStatus.updateAvailable);
  updateStatusCache = {
    checkedAt: new Date(now).toISOString(),
    updateAvailable,
    restartRequired: false,
    planEndpoint: "/api/update/plan",
    applyEndpoint: "/api/update/apply",
    webuiDev: webuiDevServer,
    pi: piStatus,
    webui: webuiStatus,
    packages: {
      checked: false,
      note: "Updates use PATH Pi and detected npm-global or Pi-managed Web UI installations. Restart Web UI manually after updating."
    },
  };
  updateStatusCacheAt = now;
  return updateStatusCache;
}

function exactUpdatePathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function rememberClosedRestorableTab(tab, state = null) {
  const descriptor = restorableTabDescriptor(tab, state);
  if (!descriptor) return;
  const key = restorableTabKey(descriptor);
  const existingIndex = closedRestorableTabs.findIndex((item) => restorableTabKey(item) === key);
  if (existingIndex !== -1) closedRestorableTabs.splice(existingIndex, 1);
  closedRestorableTabs.push(descriptor);
  while (closedRestorableTabs.length > RESTORE_TAB_LIMIT) closedRestorableTabs.shift();
}

function broadcastTabEvent(tab, event) {
  recordEvent(event);
  for (const client of tab.sseClients) sendSseToClient(client, event);
}

function broadcastServerEvent(event) {
  recordEvent(event);
  const clients = new Set();
  for (const tab of tabs.values()) {
    for (const client of tab.sseClients) clients.add(client);
  }
  for (const client of clients) sendSseToClient(client, event);
}

const gitLiveWatcher = createGitLiveWatcher({
  onChange: ({ root, changedAt }) => {
    broadcastServerEvent({ type: "webui_git_changed", root, changedAt });
  },
  onError: ({ root, error }) => {
    const message = sanitizeError(error);
    recordEvent({ type: "webui_git_watch_error", root, error: message });
    console.warn(`Git live watcher disabled for ${root}: ${message}`);
  },
});

const workspaceFilesLiveWatcher = createWorkspaceFilesLiveWatcher({
  onChange: ({ root, tabIds, changedAt }) => {
    for (const tabId of tabIds) {
      const tab = tabs.get(tabId);
      if (!tab || workspaceFilesLiveWatcher.subscribedRootForTab(tab.id) !== root) continue;
      broadcastTabEvent(tab, { type: "webui_workspace_files_changed", tabId: tab.id, root, changedAt });
    }
  },
  onError: ({ root, error }) => {
    const message = sanitizeError(error);
    recordEvent({ type: "webui_workspace_files_watch_error", root, error: message });
    console.warn(`Workspace files live watcher disabled for ${root}: ${message}`);
  },
});

function trackGitRepositoryForTab(tab, root) {
  if (tab?.id && root) gitLiveWatcher.subscribe(tab.id, root);
  return root;
}

function renameTab(tab, title, { source = "explicit", maxLength, unique = source === "auto" } = {}) {
  if (!tab) return false;
  const rawTitle = maxLength ? truncateTabTitle(title, maxLength) : String(title || "").replace(/\s+/g, " ").trim();
  const nextTitle = unique ? uniqueTabTitle(rawTitle, tab, maxLength || AUTO_TAB_TITLE_MAX_LENGTH) : rawTitle;
  if (!nextTitle) return false;

  const previousTitle = tab.title;
  tab.title = nextTitle;
  tab.titleSource = source;
  tab.subagentDisplayTitle = source === "auto" ? truncateTabTitle(title, AUTO_TAB_TITLE_DISPLAY_MAX_LENGTH) : undefined;
  tab.subagentDisplayTitlePromise = undefined;
  if (previousTitle === nextTitle) return false;
  scheduleSupervisorMetadataUpdate(tab);

  broadcastTabEvent(tab, {
    type: "webui_tab_renamed",
    tabId: tab.id,
    tabTitle: tab.title,
    previousTabTitle: previousTitle,
    titleSource: source,
    tab: tabMeta(tab),
    tabActivity: tabActivitySnapshot(tab),
  });
  return true;
}

function maybeNameTabForConversation(tab, command) {
  if (!tab || !commandStartsConversation(command)) return false;
  const shouldRename = !tab.conversationStarted && tab.titleSource !== "explicit";
  tab.conversationStarted = true;
  scheduleSupervisorMetadataUpdate(tab);
  if (!shouldRename) return false;
  const title = generatedTabTitleFromPrompt(command.message) || `Conversation ${tab.index}`;
  return renameTab(tab, title, { source: "auto", maxLength: AUTO_TAB_TITLE_MAX_LENGTH });
}

function resetAutomaticTabTitleForNewSession(tab) {
  if (!tab || tab.titleSource === "explicit") return false;
  return renameTab(tab, defaultTabTitle(tab.index), { source: "default", unique: false });
}

async function createNoProjectResetTab(source) {
  if (source.noProjectResetInProgress || source.cwdChangeInProgress) throw makeHttpError(409, "A No Project session change is already in progress");
  source.noProjectResetInProgress = true;
  try {
    enforceNaturalConversationCommandAllowed(source, { type: "new_session" });
    await requireIdleForSessionAction(source, "starting a new No Project conversation");
    if (source.compactionQueueDraining || compactionQueueForTab(source).length) throw makeHttpError(409, "Wait for queued compaction work before starting a new conversation");
    await resolveNoProjectWorkspace(agentDir, source);
    const next = await createTab({ freshNoProject: true });
    return { nextTabId: next.id, tab: tabMeta(next), tabs: listTabs(), sourceTab: tabMeta(source) };
  } finally {
    source.noProjectResetInProgress = false;
  }
}

function responseWithTab(response, tab) {
  if (!response || typeof response !== "object") return response;
  return { ...response, tab: tabMeta(tab) };
}

async function updateTabCwd(id, cwd) {
  const tab = tabs.get(id);
  if (!tab) throw makeHttpError(404, `Unknown Pi tab: ${id}`);
  if (tab.noProjectResetInProgress) throw makeHttpError(409, "A new No Project conversation is already starting");
  if (tab.cwdChangeInProgress) throw makeHttpError(409, `${tab.title} is already changing its working folder`);

  tab.cwdChangeInProgress = true;
  try {
    return await performTabCwdUpdate(tab, cwd);
  } finally {
    tab.cwdChangeInProgress = false;
    scheduleSupervisorMetadataUpdate(tab);
  }
}

async function performTabCwdUpdate(tab, cwd) {
  const nextCwd = await resolveCwd(cwd, tab.cwd);
  const identity = await resolveNoProjectWorkspace(agentDir, { cwd: nextCwd });
  if (nextCwd === tab.cwd) return { tab, changed: false };
  if (tab.rpc instanceof SupervisorPiRpcProcess && !tab.rpc.supervisor.isCurrentVersion()) {
    throw makeHttpError(503, "The detached Pi supervisor is from an older WebUI build. Fully shut down Pi WebUI (not Restart), then start it again before changing working folders.");
  }

  // Capture the live session before stopping the old RPC so the conversation
  // survives the cwd restart, mirroring restartTabRpc. Best-effort: a dead RPC
  // falls back to the last remembered session file.
  if (tab.rpc?.isRunning()) await safeRpcData(tab, { type: "get_state" }, STATUS_RPC_TIMEOUT_MS);
  const sessionFile = tabRestorableSessionFile(tab);

  const launch = await buildPiLaunchForTab(tab.index, tab.title, nextCwd, identity.workspaceKind);
  const piArgs = launch.args;
  if (sessionFile && !options.noSession) piArgs.push("--session", sessionFile);
  const piCommand = await resolvePiCommand(piArgs);
  const restartingEvent = { type: "webui_tab_restarting", tabId: tab.id, tabTitle: tab.title, cwd: nextCwd, sessionFile };
  broadcastTabEvent(tab, restartingEvent);

  const oldRpc = tab.rpc;
  rejectTabBashQueue(tab, new Error("Pi tab is restarting; queued bash commands were cancelled"));
  stopAppRunnerForTab(tab, "cwd changed", { force: true });
  clearPendingExtensionUiRequests(tab);
  clearExtensionStatuses(tab);
  clearExtensionWidgets(tab);
  clearWebuiSubagents(tab);
  resetNaturalConversationMode(tab);
  resetCodexFastMode(tab);

  let rpc;
  let startDirectRpc = false;
  try {
    if (oldRpc instanceof SupervisorPiRpcProcess) {
      const snapshot = await oldRpc.replace({
        child: { command: piCommand.command, args: piCommand.args, cwd: nextCwd },
        metadata: supervisedTabMetadata(tab, { cwd: nextCwd, prompt: launch.prompt, workspaceKind: identity.workspaceKind || null, noProjectId: identity.noProjectId || null }),
        displayCommand: piCommand.displayCommand,
      });
      oldRpc.dispose();
      rpc = new SupervisorPiRpcProcess({ supervisor: rpcSupervisor, tabId: tab.id, displayCommand: piCommand.displayCommand, cwd: nextCwd, snapshot });
    } else {
      oldRpc.stop();
      rpc = new PiRpcProcess({ ...piCommand, cwd: nextCwd, env: piRpcEnvironment() });
      startDirectRpc = true;
    }
  } catch (error) {
    const detail = sanitizeError(error);
    broadcastTabEvent(tab, { type: "webui_cwd_change_failed", tabId: tab.id, tabTitle: tab.title, cwd: nextCwd, error: detail });
    throw makeHttpError(502, `Could not restart ${tab.title} in ${displayPath(nextCwd)}: ${detail}`);
  }

  tab.rpcUnsubscribe?.();
  tab.rpcUnsubscribe = undefined;
  attachRpcToTab(tab, rpc);
  if (startDirectRpc) {
    try {
      await rpc.start();
    } catch (error) {
      const detail = sanitizeError(error);
      broadcastTabEvent(tab, { type: "webui_cwd_change_failed", tabId: tab.id, tabTitle: tab.title, cwd: nextCwd, error: detail });
      throw makeHttpError(502, `Could not restart ${tab.title} in ${displayPath(nextCwd)}: ${detail}`);
    }
  }
  tab.cwd = nextCwd;
  tab.workspaceKind = identity.workspaceKind;
  tab.noProjectId = identity.noProjectId;
  resetTabActivity(tab);
  tab.prompt = launch.prompt;
  gitLiveWatcher.unsubscribe(tab.id);
  workspaceFilesLiveWatcher.unsubscribe(tab.id);
  workspaceFilesLiveWatcher.subscribe(tab.id, tab.cwd);
  // Non-fatal: a failed start surfaces through pi_process_error/exit events.
  await primeTabRpc(tab).catch(() => {});

  const changedEvent = { type: "webui_cwd_changed", tabId: tab.id, tabTitle: tab.title, cwd: tab.cwd, pid: tab.rpc.child?.pid, sessionFile, tabActivity: tabActivitySnapshot(tab) };
  broadcastTabEvent(tab, changedEvent);
  return { tab, changed: true };
}

async function writeNativeRestartMarker(restart, tabId, metadata, child) {
  // The original owner has already claimed restart-action; inspection reports
  // restart-in-progress while the durable authorization remains unchanged.
  const job = await readSharedJob(await sharedUpdateRoot(), restart.transactionId);
  if (!job || job.phase !== "restart-authorized" || job.lock?.token !== restart.lockToken ||
      job.plan.context.ownerBootIdentity !== bootIdentity) {
    throw makeHttpError(409, "No durable verified native update can restart this tab.");
  }
  const directory = path.join(job.jobDir, "restarts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const marker = { tabId, transactionId: restart.transactionId, lockToken: restart.lockToken, effectRoot: restart.effectRoot,
    requestDigest: createHash("sha256").update(JSON.stringify({ tabId, metadata, child })).digest("hex") };
  const handle = await open(path.join(directory, `${restart.nonce}.json`), "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(marker)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

async function restartTabRpc(tab, reason = "reload", restart = null) {
  const state = await tab.rpc.send({ type: "get_state" });
  if (state.success === false) throw makeHttpError(400, state.error || "Unable to read Pi state before reload");
  rememberTabState(tab, state.data);
  if (state.data?.isStreaming) throw makeHttpError(409, "Wait for the current response to finish before reloading.");
  if (state.data?.isCompacting) throw makeHttpError(409, "Wait for compaction to finish before reloading.");

  await resolveNoProjectWorkspace(agentDir, tab);
  const launch = await buildPiLaunchForTab(tab.index, tab.title, tab.cwd, tab.workspaceKind);
  const piArgs = launch.args;
  if (state.data?.sessionFile && !options.noSession) piArgs.push("--session", state.data.sessionFile);
  const piCommand = await resolvePiCommand(piArgs);
  const reloadingEvent = { type: "webui_tab_reloading", tabId: tab.id, tabTitle: tab.title, cwd: tab.cwd, reason, sessionFile: state.data?.sessionFile };
  broadcastTabEvent(tab, reloadingEvent);

  const expectedSessionFile = state.data?.sessionFile || "";
  const oldRpc = tab.rpc;
  tab.rpcUnsubscribe?.();
  tab.rpcUnsubscribe = undefined;
  rejectTabBashQueue(tab, new Error("Pi tab is reloading; queued bash commands were cancelled"));

  resetTabActivity(tab);
  clearPendingExtensionUiRequests(tab);
  clearExtensionStatuses(tab);
  clearExtensionWidgets(tab);
  clearWebuiSubagents(tab);
  resetNaturalConversationMode(tab);
  resetCodexFastMode(tab);
  let rpc;
  if (oldRpc instanceof SupervisorPiRpcProcess) {
    const child = { command: piCommand.command, args: piCommand.args, cwd: tab.cwd };
    const metadata = supervisedTabMetadata(tab, { prompt: launch.prompt });
    if (restart) await writeNativeRestartMarker(restart, tab.id, metadata, child);
    const snapshot = await oldRpc.replace({
      child, metadata, restart,
      displayCommand: piCommand.displayCommand,
    });
    oldRpc.dispose();
    rpc = new SupervisorPiRpcProcess({ supervisor: rpcSupervisor, tabId: tab.id, displayCommand: piCommand.displayCommand, cwd: tab.cwd, snapshot });
    attachRpcToTab(tab, rpc);
    if (restart) {
      const restored = await rpc.send({ type: "get_state" }, 5_000);
      assertRestoredPiState(restored, expectedSessionFile);
      if (!rpc.isRunning()) throw new Error("Restored Pi child exited before session verification.");
      rememberTabState(tab, restored.data);
    }
  } else {
    if (restart) throw makeHttpError(409, "A direct Pi tab cannot be restarted while the update fence is held; supervised handoff is required.");
    oldRpc.stop();
    rpc = new PiRpcProcess({ ...piCommand, cwd: tab.cwd, env: piRpcEnvironment() });
    attachRpcToTab(tab, rpc);
    await rpc.start();
  }
  tab.prompt = launch.prompt;

  const reloadedEvent = { type: "webui_tab_reloaded", tabId: tab.id, tabTitle: tab.title, cwd: tab.cwd, pid: tab.rpc.child?.pid, reason, sessionFile: state.data?.sessionFile, tabActivity: tabActivitySnapshot(tab) };
  broadcastTabEvent(tab, reloadedEvent);
  return tab;
}

function rpcUnavailableMessage(tab) {
  return `Pi RPC process for ${tab?.title || "thread"} is not running`;
}

function fallbackRpcResponse(tab, command, error) {
  const message = sanitizeError(error) || rpcUnavailableMessage(tab);
  const base = { type: "response", command: command.type, success: true, rpcRunning: false, error: message };
  switch (command.type) {
    case "get_state":
      return {
        ...base,
        data: {
          model: null,
          thinkingLevel: "off",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          sessionFile: tab?.sessionFile,
          sessionId: tab?.id,
          sessionName: tab?.title,
          autoCompactionEnabled: false,
          messageCount: 0,
          pendingMessageCount: 0,
          rpcRunning: false,
          rpcError: message,
        },
      };
    case "get_messages":
      return { ...base, data: { messages: [] } };
    case "get_available_models":
      return { ...base, data: { models: [] } };
    case "get_session_stats":
      return { ...base, data: null };
    case "get_last_assistant_text":
      return { ...base, data: { text: "" } };
    default:
      return { ...base, success: false, error: message };
  }
}

async function safeRpcResponse(tab, command, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    const response = rewriteArtifactsForTab(tab, responseWithPendingThinking(tab, await tab.rpc.send(command, timeoutMs)));
    if (command?.type === "get_messages" && Array.isArray(response?.data?.messages)) {
      response.data = {
        ...response.data,
        messages: filterSessionSummaryTranscriptMessages(filterIntercomTranscriptMessages(response.data.messages)),
      };
    }
    return response;
  } catch (error) {
    const message = sanitizeError(error);
    if (/Pi RPC process is not running/i.test(message)) return responseWithPendingThinking(tab, fallbackRpcResponse(tab, command, error));
    throw error;
  }
}

function requireResourceScope(value) {
  const scope = String(value || "session").trim().toLowerCase();
  if (scope !== "session" && scope !== "global" && scope !== "model") throw makeHttpError(400, "Resource scope must be session, global, or model");
  return scope;
}

function requireResourceModelIdentity(source, models) {
  const provider = String(source?.provider || "").trim();
  const modelId = String(source?.modelId || "").trim();
  if (!provider || !modelId) throw makeHttpError(400, "Model resource scope requires an exact provider and modelId");
  if (!(models || []).some((model) => model?.provider === provider && model?.id === modelId)) {
    throw makeHttpError(400, `Unknown authenticated model for resource profile: ${provider}/${modelId}`);
  }
  return { provider, modelId };
}

function selectedResourceNames(body, enabledKey, disabledKey, resources, label) {
  const allNames = new Set((resources || []).map((resource) => String(resource.name || "").trim()).filter(Boolean));
  if (Array.isArray(body?.[enabledKey])) {
    return [...new Set(body[enabledKey].map((name) => String(name || "").trim()).filter((name) => allNames.has(name)))];
  }
  if (Array.isArray(body?.[disabledKey])) {
    const disabled = new Set(body[disabledKey].map((name) => String(name || "").trim()));
    return [...allNames].filter((name) => !disabled.has(name));
  }
  throw makeHttpError(400, `${label} update requires ${enabledKey} or ${disabledKey}`);
}

function globalResourcePayload(key, resources, configuredNames) {
  const configured = Array.isArray(configuredNames);
  const enabled = new Set(configured ? configuredNames : resources.filter((resource) => resource.enabled !== false).map((resource) => resource.name));
  return {
    scope: "global",
    configured,
    [key]: resources.map((resource) => ({ ...resource, enabled: enabled.has(resource.name) })),
  };
}

async function modelResourcePayload(tab, key, resources, identity, models) {
  const selectionKey = key === "tools" ? "enabledTools" : "enabledSkills";
  const defaults = (await readWebuiSettings()).resourceDefaults;
  const profile = exactModelProfile(defaults, identity.provider, identity.modelId);
  const configuredNames = profile?.[key]?.[selectionKey];
  const configured = Array.isArray(configuredNames);
  const resolved = resolveResourceSelection(defaults, key, identity.provider, identity.modelId, null);
  const enabledNames = configured
    ? configuredNames
    : resolved.names !== null
      ? resolved.names
      : resources.filter((resource) => resource.enabled !== false).map((resource) => resource.name);
  const enabled = new Set(enabledNames);
  return {
    scope: "model",
    provider: identity.provider,
    modelId: identity.modelId,
    configured,
    source: configured ? "model" : resolved.source,
    models: (models || []).map((model) => ({ provider: model.provider, id: model.id, name: model.name || model.id })),
    [key]: resources.map((resource) => ({ ...resource, enabled: enabled.has(resource.name) })),
  };
}

async function recomputeResourceRuntime(tab) {
  return sendWebuiHelperCommand(tab, "resources-recompute");
}

async function setModelResourceProfile(tab, key, resources, body) {
  const selectionKey = key === "tools" ? "enabledTools" : "enabledSkills";
  const label = key === "tools" ? "Tool" : "Skill";
  const enabledKey = `enabled${label}s`;
  const disabledKey = `disabled${label}s`;
  const models = await availableGitWorkflowModels(tab);
  const identity = requireResourceModelIdentity(body, models);
  if (body?.inherit === true) {
    await updateWebuiSettings((current) => ({
      resourceDefaults: {
        modelProfiles: setExactModelProfile(current.resourceDefaults, identity.provider, identity.modelId, key, null),
      },
    }));
    const refreshed = await recomputeResourceRuntime(tab);
    return modelResourcePayload(tab, key, refreshed?.[key]?.[key] || resources, identity, models);
  }
  const selectedNames = selectedResourceNames(body, enabledKey, disabledKey, resources, label);
  await updateWebuiSettings((current) => {
    const previousNames = exactModelProfile(current.resourceDefaults, identity.provider, identity.modelId)?.[key]?.[selectionKey];
    const enabledNames = preserveUnavailableResourceNames(previousNames, resources.map((resource) => resource.name), selectedNames);
    return {
      resourceDefaults: {
        modelProfiles: setExactModelProfile(current.resourceDefaults, identity.provider, identity.modelId, key, enabledNames),
      },
    };
  });
  const refreshed = await recomputeResourceRuntime(tab);
  return modelResourcePayload(tab, key, refreshed?.[key]?.[key] || resources, identity, models);
}

async function getToolConfigData(tab, requestedScope = "session", searchParams) {
  const scope = requireResourceScope(requestedScope);
  const runtime = await sendWebuiHelperCommand(tab, "tools-state");
  if (scope === "session") return { ...runtime, scope };
  if (scope === "model") {
    const models = await availableGitWorkflowModels(tab);
    const identity = requireResourceModelIdentity({ provider: searchParams?.get("provider"), modelId: searchParams?.get("modelId") }, models);
    return modelResourcePayload(tab, "tools", runtime.tools || [], identity, models);
  }
  const defaults = (await readWebuiSettings()).resourceDefaults.tools.enabledTools;
  return globalResourcePayload("tools", runtime.tools || [], defaults);
}

let packageManagerModulePromise;
async function loadPackageManagerModule() {
  if (!packageManagerModulePromise) {
    const packageMain = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const codingAgentRoot = path.dirname(path.dirname(packageMain));
    packageManagerModulePromise = import(pathToFileURL(path.join(codingAgentRoot, "dist", "core", "package-manager.js")).href);
  }
  return packageManagerModulePromise;
}

function parseSkillFrontmatter(text, filePath) {
  const frontmatter = String(text || "").match(/^---\s*\n([\s\S]*?)\n---/);
  const fields = {};
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match) fields[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
  const parent = path.basename(path.dirname(filePath));
  const base = path.basename(filePath, path.extname(filePath));
  return {
    name: fields.name || (path.basename(filePath) === "SKILL.md" ? parent : base),
    description: fields.description || "",
  };
}

function sourceInfoFromResolvedResource(resource) {
  const metadata = resource?.metadata || {};
  return {
    path: resource?.path,
    source: metadata.source,
    scope: metadata.scope,
    origin: metadata.origin,
    baseDir: metadata.baseDir,
  };
}

async function resolveSkillResources(tab) {
  const { DefaultPackageManager } = await loadPackageManagerModule();
  const settingsManager = SettingsManager.create(tab?.cwd || options.cwd, agentDir);
  const packageManager = new DefaultPackageManager({ cwd: tab?.cwd || options.cwd, agentDir, settingsManager });
  const resolved = await packageManager.resolve();
  const skills = [];
  for (const resource of resolved.skills || []) {
    try {
      const metadata = parseSkillFrontmatter(await readFile(resource.path, "utf8"), resource.path);
      skills.push({
        ...metadata,
        filePath: resource.path,
        enabled: resource.enabled === true,
        configEnabled: resource.enabled === true,
        configManaged: true,
        sourceInfo: sourceInfoFromResolvedResource(resource),
      });
    } catch {
      // Ignore unreadable skill candidates; Pi will also skip invalid resources.
    }
  }
  return { skills, settingsManager };
}

function skillResourceKey(skill) {
  return skill.filePath || skill.name;
}

function mergeRuntimeAndResolvedSkills(runtimeSkills, resolvedSkills) {
  const byName = new Map();
  for (const skill of resolvedSkills) byName.set(skill.name, { ...skill });
  for (const skill of runtimeSkills || []) {
    const existing = byName.get(skill.name);
    byName.set(skill.name, existing ? { ...existing, ...skill, configManaged: existing.configManaged, configEnabled: existing.configEnabled, filePath: existing.filePath || skill.filePath, sourceInfo: existing.sourceInfo || skill.sourceInfo } : { ...skill, configManaged: false, configEnabled: true });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function getMergedSkillConfigData(tab) {
  const [runtime, resolved] = await Promise.all([
    getSkillConfigDataFromRuntime(tab).catch(() => ({ skills: [] })),
    resolveSkillResources(tab).catch((error) => {
      console.warn(`failed to resolve configured skills: ${sanitizeError(error)}`);
      return { skills: [] };
    }),
  ]);
  return { skills: mergeRuntimeAndResolvedSkills(runtime.skills || [], resolved.skills || []) };
}

function normalizeSkillRequestName(value) {
  return String(value || "").trim().replace(/^skill:/i, "").toLowerCase();
}

function skillFileRequestParts(source = {}) {
  return {
    name: normalizeSkillRequestName(source.name || source.skillName),
    filePath: String(source.path || source.filePath || "").trim(),
  };
}

function sameResolvedPath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function skillFilePathInside(root, target) {
  if (!root || !target) return false;
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function skillNameFromSkillFilePath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const match = normalized.match(/\/skills\/([^/]+)\/SKILL\.md$/i);
  return normalizeSkillRequestName(match?.[1] || "");
}

async function resolveExplicitSkillFilePath(tab, filePath, requestedName = "") {
  const resolvedPath = path.resolve(filePath || "");
  const pathSkillName = skillNameFromSkillFilePath(resolvedPath);
  if (!pathSkillName) throw makeHttpError(400, "Skill path must point to /skills/<name>/SKILL.md");
  if (requestedName && requestedName !== pathSkillName) throw makeHttpError(400, "Skill name does not match the requested SKILL.md path");
  const allowedRoots = [agentDir, path.join(tab?.cwd || options.cwd, ".pi")];
  if (!allowedRoots.some((root) => skillFilePathInside(root, resolvedPath))) {
    throw makeHttpError(403, "Skill path is outside allowed Pi skill locations");
  }
  const info = await stat(resolvedPath).catch(() => null);
  if (!info?.isFile()) throw makeHttpError(404, `Skill file not found: ${resolvedPath}`);
  return {
    name: pathSkillName,
    description: "",
    filePath: resolvedPath,
    enabled: true,
    fileStats: info,
  };
}

async function resolveEditableSkillFile(tab, request = {}) {
  const { name, filePath } = skillFileRequestParts(request);
  if (!name && !filePath) throw makeHttpError(400, "Skill name or path is required");
  const { skills } = await resolveSkillResources(tab);
  const skill = skills.find((item) => (
    filePath ? sameResolvedPath(item.filePath, filePath) : name && normalizeSkillRequestName(item.name) === name
  ));
  if (skill?.filePath) {
    if (path.basename(skill.filePath) !== "SKILL.md") throw makeHttpError(400, "Only SKILL.md files can be edited from skill tags");
    const info = await stat(skill.filePath).catch(() => null);
    if (!info?.isFile()) throw makeHttpError(404, `Skill file not found: ${skill.filePath}`);
    return { ...skill, filePath: path.resolve(skill.filePath), fileStats: info };
  }
  if (filePath) return resolveExplicitSkillFilePath(tab, filePath, name);
  throw makeHttpError(404, "Skill is not configured in this Pi tab");
}

async function getSkillFileData(tab, request = {}) {
  const skill = await resolveEditableSkillFile(tab, request);
  const content = await readFile(skill.filePath, "utf8");
  return {
    name: parseSkillFrontmatter(content, skill.filePath).name || skill.name,
    description: skill.description || "",
    path: skill.filePath,
    content,
    mtimeMs: skill.fileStats.mtimeMs,
    size: skill.fileStats.size,
    enabled: skill.enabled === true,
  };
}

async function saveSkillFileData(tab, body = {}) {
  if (typeof body.content !== "string") throw makeHttpError(400, "Skill content must be a string");
  if (body.content.includes("\0")) throw makeHttpError(400, "Skill content cannot contain null bytes");
  if (Buffer.byteLength(body.content, "utf8") > SKILL_FILE_BODY_LIMIT_BYTES) throw makeHttpError(413, `Skill file is too large (limit ${formatBytes(SKILL_FILE_BODY_LIMIT_BYTES)})`);
  const skill = await resolveEditableSkillFile(tab, body);
  const expectedMtimeMs = Number(body.mtimeMs);
  if (Number.isFinite(expectedMtimeMs) && Math.abs(skill.fileStats.mtimeMs - expectedMtimeMs) > 5) {
    throw makeHttpError(409, "Skill file changed on disk after it was opened. Reopen it before saving.");
  }
  const tmpFile = `${skill.filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpFile, body.content, { encoding: "utf8", mode: skill.fileStats.mode & 0o777 });
  await rename(tmpFile, skill.filePath);
  const nextStats = await stat(skill.filePath);
  const metadata = parseSkillFrontmatter(body.content, skill.filePath);
  return {
    name: metadata.name || skill.name,
    description: metadata.description || skill.description || "",
    path: skill.filePath,
    mtimeMs: nextStats.mtimeMs,
    size: nextStats.size,
    enabled: skill.enabled === true,
  };
}

async function setToolConfigData(tab, body) {
  const scope = requireResourceScope(body?.scope);
  if (scope === "session") {
    return {
      ...(await sendWebuiHelperCommand(tab, "tools-set", body?.inherit === true
        ? { mode: "inherit" }
        : {
            enabledTools: Array.isArray(body.enabledTools) ? body.enabledTools : undefined,
            disabledTools: Array.isArray(body.disabledTools) ? body.disabledTools : undefined,
          })),
      scope,
    };
  }

  const runtime = await sendWebuiHelperCommand(tab, "tools-state");
  if (scope === "model") return setModelResourceProfile(tab, "tools", runtime.tools || [], body);
  if (body?.inherit === true) {
    await updateWebuiSettings(() => ({ resourceDefaults: { tools: { enabledTools: null } } }));
    const refreshed = await recomputeResourceRuntime(tab);
    return globalResourcePayload("tools", refreshed?.tools?.tools || runtime.tools || [], null);
  }
  const selectedTools = selectedResourceNames(body, "enabledTools", "disabledTools", runtime.tools, "Tool");
  const settings = await updateWebuiSettings((current) => ({
    resourceDefaults: {
      tools: {
        enabledTools: preserveUnavailableResourceNames(current.resourceDefaults?.tools?.enabledTools, (runtime.tools || []).map((tool) => tool.name), selectedTools),
      },
    },
  }));
  const refreshed = await recomputeResourceRuntime(tab);
  return globalResourcePayload("tools", refreshed?.tools?.tools || runtime.tools || [], settings.resourceDefaults.tools.enabledTools);
}

async function getSkillConfigData(tab, requestedScope = "session", searchParams) {
  const scope = requireResourceScope(requestedScope);
  const runtime = await getSkillConfigDataFromRuntime(tab);
  if (scope === "session") return { ...runtime, scope };
  if (scope === "model") {
    const models = await availableGitWorkflowModels(tab);
    const identity = requireResourceModelIdentity({ provider: searchParams?.get("provider"), modelId: searchParams?.get("modelId") }, models);
    return modelResourcePayload(tab, "skills", runtime.skills || [], identity, models);
  }
  const defaults = (await readWebuiSettings()).resourceDefaults.skills.enabledSkills;
  return globalResourcePayload("skills", runtime.skills || [], defaults);
}

async function getSkillConfigDataFromRuntime(tab) {
  return sendWebuiHelperCommand(tab, "skills-state");
}

async function setSkillConfigData(tab, body) {
  const scope = requireResourceScope(body?.scope);
  if (scope === "session") {
    return {
      ...(await sendWebuiHelperCommand(tab, "skills-set", body?.inherit === true
        ? { mode: "inherit" }
        : {
            enabledSkills: Array.isArray(body.enabledSkills) ? body.enabledSkills : undefined,
            disabledSkills: Array.isArray(body.disabledSkills) ? body.disabledSkills : undefined,
          })),
      scope,
    };
  }

  const runtime = await getSkillConfigDataFromRuntime(tab);
  if (scope === "model") return setModelResourceProfile(tab, "skills", runtime.skills || [], body);
  if (body?.inherit === true) {
    await updateWebuiSettings(() => ({ resourceDefaults: { skills: { enabledSkills: null } } }));
    const refreshed = await recomputeResourceRuntime(tab);
    return globalResourcePayload("skills", refreshed?.skills?.skills || runtime.skills || [], null);
  }
  const selectedSkills = selectedResourceNames(body, "enabledSkills", "disabledSkills", runtime.skills, "Skill");
  const settings = await updateWebuiSettings((current) => ({
    resourceDefaults: {
      skills: {
        enabledSkills: preserveUnavailableResourceNames(current.resourceDefaults?.skills?.enabledSkills, (runtime.skills || []).map((skill) => skill.name), selectedSkills),
      },
    },
  }));
  const refreshed = await recomputeResourceRuntime(tab);
  return globalResourcePayload("skills", refreshed?.skills?.skills || runtime.skills || [], settings.resourceDefaults.skills.enabledSkills);
}

function settingsManagerForTab(tab) {
  return SettingsManager.create(tab?.cwd || options.cwd, agentDir);
}

function nativeSettingsPayload(settingsManager = settingsManagerForTab()) {
  const settings = {
    transport: settingsManager.getTransport(),
    httpIdleTimeoutMs: settingsManager.getHttpIdleTimeoutMs(),
    autoResizeImages: settingsManager.getImageAutoResize(),
    blockImages: settingsManager.getBlockImages(),
    enableSkillCommands: settingsManager.getEnableSkillCommands(),
    hideThinkingBlock: settingsManager.getHideThinkingBlock(),
    showImages: settingsManager.getShowImages(),
    imageWidthCells: settingsManager.getImageWidthCells(),
    collapseChangelog: settingsManager.getCollapseChangelog(),
    quietStartup: settingsManager.getQuietStartup(),
    enableInstallTelemetry: settingsManager.getEnableInstallTelemetry(),
    doubleEscapeAction: settingsManager.getDoubleEscapeAction(),
    treeFilterMode: settingsManager.getTreeFilterMode(),
    showHardwareCursor: settingsManager.getShowHardwareCursor(),
    editorPaddingX: settingsManager.getEditorPaddingX(),
    autocompleteMaxVisible: settingsManager.getAutocompleteMaxVisible(),
    clearOnShrink: settingsManager.getClearOnShrink(),
    showTerminalProgress: settingsManager.getShowTerminalProgress(),
    warnings: settingsManager.getWarnings(),
  };
  return {
    settings,
    options: {
      thinkingLevels: THINKING_LEVELS,
      transports: SETTINGS_TRANSPORT_CHOICES,
      httpIdleTimeouts: SETTINGS_HTTP_IDLE_TIMEOUT_CHOICES,
      doubleEscapeActions: SETTINGS_DOUBLE_ESCAPE_ACTIONS,
      treeFilterModes: SETTINGS_TREE_FILTER_MODES,
      imageWidthCells: SETTINGS_IMAGE_WIDTH_CELLS,
      editorPaddingX: SETTINGS_EDITOR_PADDING_X,
      autocompleteMaxVisible: SETTINGS_AUTOCOMPLETE_MAX_VISIBLE,
    },
    scope: "global",
    paths: {
      global: settingsManager.storage?.globalSettingsPath || path.join(agentDir, "settings.json"),
      project: settingsManager.storage?.projectSettingsPath || path.join(options.cwd, ".pi", "settings.json"),
    },
  };
}

function hasOwnSetting(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key);
}

function requireBooleanSetting(value, key) {
  if (typeof value !== "boolean") throw makeHttpError(400, `${key} must be a boolean`);
  return value;
}

function requireStringChoiceSetting(value, key, choices) {
  const text = String(value ?? "").trim();
  if (!choices.includes(text)) throw makeHttpError(400, `${key} must be one of: ${choices.join(", ")}`);
  return text;
}

function requireNumberChoiceSetting(value, key, choices) {
  const number = Number(value);
  if (!Number.isFinite(number) || !choices.includes(number)) throw makeHttpError(400, `${key} must be one of: ${choices.join(", ")}`);
  return number;
}

function rememberSettingChange(changed, reloadRecommended, key, before, after) {
  if (before === after) return;
  changed.push(key);
  if (SETTINGS_RELOAD_RECOMMENDED_KEYS.has(key)) reloadRecommended.push(SETTINGS_RELOAD_LABELS.get(key) || key);
}

function applyBooleanSetting(body, key, settingsManager, getter, setter, changed, reloadRecommended) {
  if (!hasOwnSetting(body, key)) return;
  const next = requireBooleanSetting(body[key], key);
  const before = getter.call(settingsManager);
  if (before !== next) setter.call(settingsManager, next);
  rememberSettingChange(changed, reloadRecommended, key, before, next);
}

function applyStringChoiceSetting(body, key, choices, settingsManager, getter, setter, changed, reloadRecommended) {
  if (!hasOwnSetting(body, key)) return;
  const next = requireStringChoiceSetting(body[key], key, choices);
  const before = getter.call(settingsManager);
  if (before !== next) setter.call(settingsManager, next);
  rememberSettingChange(changed, reloadRecommended, key, before, next);
}

function applyNumberChoiceSetting(body, key, choices, settingsManager, getter, setter, changed, reloadRecommended) {
  if (!hasOwnSetting(body, key)) return;
  const next = requireNumberChoiceSetting(body[key], key, choices);
  const before = getter.call(settingsManager);
  if (before !== next) setter.call(settingsManager, next);
  rememberSettingChange(changed, reloadRecommended, key, before, next);
}

function applyHttpIdleTimeoutSetting(body, settingsManager, changed, reloadRecommended) {
  const key = "httpIdleTimeoutMs";
  if (!hasOwnSetting(body, key)) return;
  const next = Number(body[key]);
  if (!Number.isFinite(next) || next < 0) throw makeHttpError(400, `${key} must be a non-negative number`);
  const normalized = Math.floor(next);
  const before = settingsManager.getHttpIdleTimeoutMs();
  if (before !== normalized) settingsManager.setHttpIdleTimeoutMs(normalized);
  rememberSettingChange(changed, reloadRecommended, key, before, normalized);
}

async function setNativeSettingsData(tab, body) {
  const submitted = body?.settings && typeof body.settings === "object" ? body.settings : {};
  const settingsManager = settingsManagerForTab(tab);
  const changed = [];
  const reloadRecommended = [];

  applyStringChoiceSetting(submitted, "transport", SETTINGS_TRANSPORT_CHOICES, settingsManager, settingsManager.getTransport, settingsManager.setTransport, changed, reloadRecommended);
  applyHttpIdleTimeoutSetting(submitted, settingsManager, changed, reloadRecommended);
  applyBooleanSetting(submitted, "autoResizeImages", settingsManager, settingsManager.getImageAutoResize, settingsManager.setImageAutoResize, changed, reloadRecommended);
  applyBooleanSetting(submitted, "blockImages", settingsManager, settingsManager.getBlockImages, settingsManager.setBlockImages, changed, reloadRecommended);
  applyBooleanSetting(submitted, "enableSkillCommands", settingsManager, settingsManager.getEnableSkillCommands, settingsManager.setEnableSkillCommands, changed, reloadRecommended);
  applyBooleanSetting(submitted, "hideThinkingBlock", settingsManager, settingsManager.getHideThinkingBlock, settingsManager.setHideThinkingBlock, changed, reloadRecommended);
  applyBooleanSetting(submitted, "showImages", settingsManager, settingsManager.getShowImages, settingsManager.setShowImages, changed, reloadRecommended);
  applyNumberChoiceSetting(submitted, "imageWidthCells", SETTINGS_IMAGE_WIDTH_CELLS, settingsManager, settingsManager.getImageWidthCells, settingsManager.setImageWidthCells, changed, reloadRecommended);
  applyBooleanSetting(submitted, "collapseChangelog", settingsManager, settingsManager.getCollapseChangelog, settingsManager.setCollapseChangelog, changed, reloadRecommended);
  applyBooleanSetting(submitted, "quietStartup", settingsManager, settingsManager.getQuietStartup, settingsManager.setQuietStartup, changed, reloadRecommended);
  applyBooleanSetting(submitted, "enableInstallTelemetry", settingsManager, settingsManager.getEnableInstallTelemetry, settingsManager.setEnableInstallTelemetry, changed, reloadRecommended);
  applyStringChoiceSetting(submitted, "doubleEscapeAction", SETTINGS_DOUBLE_ESCAPE_ACTIONS, settingsManager, settingsManager.getDoubleEscapeAction, settingsManager.setDoubleEscapeAction, changed, reloadRecommended);
  applyStringChoiceSetting(submitted, "treeFilterMode", SETTINGS_TREE_FILTER_MODES, settingsManager, settingsManager.getTreeFilterMode, settingsManager.setTreeFilterMode, changed, reloadRecommended);
  applyBooleanSetting(submitted, "showHardwareCursor", settingsManager, settingsManager.getShowHardwareCursor, settingsManager.setShowHardwareCursor, changed, reloadRecommended);
  applyNumberChoiceSetting(submitted, "editorPaddingX", SETTINGS_EDITOR_PADDING_X, settingsManager, settingsManager.getEditorPaddingX, settingsManager.setEditorPaddingX, changed, reloadRecommended);
  applyNumberChoiceSetting(submitted, "autocompleteMaxVisible", SETTINGS_AUTOCOMPLETE_MAX_VISIBLE, settingsManager, settingsManager.getAutocompleteMaxVisible, settingsManager.setAutocompleteMaxVisible, changed, reloadRecommended);
  applyBooleanSetting(submitted, "clearOnShrink", settingsManager, settingsManager.getClearOnShrink, settingsManager.setClearOnShrink, changed, reloadRecommended);
  applyBooleanSetting(submitted, "showTerminalProgress", settingsManager, settingsManager.getShowTerminalProgress, settingsManager.setShowTerminalProgress, changed, reloadRecommended);

  if (submitted.warnings && typeof submitted.warnings === "object" && hasOwnSetting(submitted.warnings, "anthropicExtraUsage")) {
    const warnings = settingsManager.getWarnings();
    const before = warnings.anthropicExtraUsage ?? true;
    const next = requireBooleanSetting(submitted.warnings.anthropicExtraUsage, "warnings.anthropicExtraUsage");
    if (before !== next) {
      settingsManager.setWarnings({ ...warnings, anthropicExtraUsage: next });
      rememberSettingChange(changed, reloadRecommended, "warnings.anthropicExtraUsage", before, next);
    }
  }

  await settingsManager.flush();
  let activeTab = tab;
  let reloaded = false;
  const shouldReload = body?.reload === true && reloadRecommended.length > 0;
  if (shouldReload) {
    activeTab = await restartTabRpc(tab, "settings");
    reloaded = true;
  }

  return {
    ...nativeSettingsPayload(settingsManagerForTab(activeTab)),
    changed,
    reloadRecommended: [...new Set(reloadRecommended)],
    reloaded,
    tab: tabMeta(activeTab),
  };
}

async function annotateSkillCommandState(tab, commands) {
  let disabledSkills = new Set();
  try {
    const state = await getMergedSkillConfigData(tab);
    disabledSkills = new Set((state.skills || []).filter((skill) => skill.enabled === false).map((skill) => skill.name));
  } catch {
    // Commands should remain available even if an older tab has not loaded the helper yet.
  }

  return commands
    .filter((command) => command?.name !== WEBUI_HELPER_COMMAND)
    .map((command) => {
      const skillName = command?.source === "skill" && String(command.name || "").startsWith("skill:") ? String(command.name).slice("skill:".length) : "";
      return skillName ? { ...command, enabled: !disabledSkills.has(skillName) } : command;
    });
}

async function getCommandData(tab, { annotateSkills = true } = {}) {
  try {
    const response = await tab.rpc.send({ type: "get_commands" });
    if (response.success === false) throw makeHttpError(400, response.error || "failed to load commands");
    const rawCommands = (response.data?.commands || []).filter((command) => command?.name !== WEBUI_HELPER_COMMAND);
    const rpcCommands = annotateSkills ? await annotateSkillCommandState(tab, rawCommands) : rawCommands;
    rememberNaturalConversationCommands(tab, rpcCommands);
    return { commands: [...NATIVE_SLASH_COMMANDS, ...rpcCommands], rpcRunning: true };
  } catch (error) {
    const message = sanitizeError(error);
    if (!/Pi RPC process is not running/i.test(message)) throw error;
    rememberNaturalConversationCommands(tab, []);
    return { commands: [...NATIVE_SLASH_COMMANDS], rpcRunning: false, error: message };
  }
}

function resolveCliPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return path.isAbsolute(text) ? text : path.resolve(options.cwd, text);
}

function resolveTabPath(tab, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return path.isAbsolute(text) ? text : path.resolve(tab?.cwd || options.cwd, text);
}

function configuredSessionDir() {
  for (let index = 0; index < options.piArgs.length; index++) {
    const arg = options.piArgs[index];
    if (arg === "--session-dir" && options.piArgs[index + 1]) return resolveCliPath(options.piArgs[index + 1]);
    if (arg.startsWith("--session-dir=")) return resolveCliPath(arg.slice("--session-dir=".length));
  }
  return undefined;
}

/** Roots that session switch/rename/delete paths must stay inside. */
function allowedSessionDirs() {
  const configured = configuredSessionDir();
  return configured ? [configured] : [path.join(agentDir, "sessions")];
}

function requireAllowedSessionPath(targetPath) {
  if (!isSessionPathAllowed(targetPath, allowedSessionDirs())) {
    throw makeHttpError(403, "sessionPath must stay inside the Pi session directory");
  }
}

function requirePersistentSessions() {
  if (options.noSession) throw makeHttpError(400, "Session selectors are unavailable when Web UI was started with --no-session.");
}

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value || 0);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeSessionInfo(info, currentSessionFile) {
  const sessionPath = String(info.path || "");
  return {
    path: sessionPath,
    id: String(info.id || ""),
    name: info.name || undefined,
    cwd: String(info.cwd || ""),
    created: isoDate(info.created),
    modified: isoDate(info.modified),
    messageCount: Number.isFinite(info.messageCount) ? info.messageCount : 0,
    firstMessage: truncateStatusText(info.firstMessage || "(no messages)", 220),
    parentSessionPath: info.parentSessionPath || undefined,
    current: !!currentSessionFile && path.resolve(sessionPath) === path.resolve(currentSessionFile),
  };
}

async function currentSessionState(tab) {
  const response = await safeRpcResponse(tab, { type: "get_state" }, STATUS_RPC_TIMEOUT_MS);
  if (response.success === false) throw makeHttpError(400, response.error || "failed to load current session state");
  rememberTabState(tab, response.data);
  return response.data || {};
}

async function getSessionSelectorData(tab, scope = "current") {
  requirePersistentSessions();
  const state = await currentSessionState(tab).catch(() => tab.lastState || {});
  const sessionDir = configuredSessionDir();
  const listAll = String(scope || "current").toLowerCase() === "all";
  const sessions = listAll ? await SessionManager.listAll(sessionDir) : await SessionManager.list(tab.cwd, sessionDir);
  return {
    scope: listAll ? "all" : "current",
    sessionDir: sessionDir || undefined,
    currentSessionFile: state.sessionFile || tabRestorableSessionFile(tab),
    sessions: sessions.slice(0, SESSION_SELECTOR_LIMIT).map((info) => normalizeSessionInfo(info, state.sessionFile || tabRestorableSessionFile(tab))),
    limited: sessions.length > SESSION_SELECTOR_LIMIT,
  };
}

function requestedIntercomConversationId(url) {
  const value = String(url.searchParams.get("conversation") || "").trim();
  if (!value) return "";
  if (!/^conv_[A-Za-z0-9_-]{24}$/.test(value)) throw makeHttpError(400, "conversation must be an opaque Intercom conversation ID");
  return value;
}

async function getIntercomConversationsData(tab, conversationId = "") {
  const state = await currentSessionState(tab).catch(() => tab.lastState || {});
  const sessionFile = sessionFileFromState(state) || tabRestorableSessionFile(tab);
  const projectionOptions = {
    conversationId,
    localSessionId: normalizedRestoreString(state.sessionId, 240) || "local",
    localName: normalizedRestoreString(state.sessionName, 160) || tab.title || "Local agent",
  };
  if (options.noSession || !sessionFile) {
    const empty = projectIntercomConversations([], projectionOptions);
    if (conversationId) throw makeHttpError(404, "Intercom conversation not found");
    return empty;
  }

  requireAllowedSessionPath(sessionFile);
  const sessionInfo = await stat(sessionFile).catch(() => null);
  if (!sessionInfo?.isFile()) {
    // Fresh/empty session: its file is only created on first persist, so there
    // cannot be any persisted conversations yet. Return an empty projection
    // instead of erroring out every intercom poll for the tab.
    const empty = projectIntercomConversations([], projectionOptions);
    if (conversationId) throw makeHttpError(404, "Intercom conversation not found");
    return empty;
  }

  let manager;
  try {
    manager = SessionManager.open(sessionFile, configuredSessionDir(), tab.cwd);
  } catch {
    throw makeHttpError(400, "Persisted session could not be read");
  }
  const data = projectIntercomConversations(manager.getBranch(), {
    ...projectionOptions,
    localSessionId: normalizedRestoreString(manager.getSessionId(), 240) || projectionOptions.localSessionId,
  });
  if (conversationId && !data.conversation) throw makeHttpError(404, "Intercom conversation not found");
  return data;
}

function extractSessionTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (part?.type === "toolCall") return `[tool call: ${part.toolName || part.name || "tool"}]`;
      if (part?.type === "thinking") return "[thinking]";
      if (part?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function generatedSessionEntryId(usedIds) {
  let id = "";
  do {
    id = randomUUID().replace(/-/g, "").slice(0, 8);
  } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

async function writeForkedSessionFromEntries({ entries, targetLeafId, cwd, parentSession }) {
  const manager = SessionManager.create(cwd, configuredSessionDir(), { parentSession });
  const header = manager.getHeader();
  const sessionFile = manager.getSessionFile();
  if (!header || !sessionFile) throw new Error("Failed to create forked session metadata");

  const outputEntries = [header];
  if (targetLeafId) {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const pathEntries = [];
    let current = byId.get(targetLeafId);
    while (current) {
      pathEntries.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    pathEntries.reverse();
    if (!pathEntries.length) throw makeHttpError(400, `Fork target entry not found in the active session: ${targetLeafId}`);

    const pathWithoutLabels = [];
    let pathParentId = null;
    for (const entry of pathEntries) {
      if (entry.type === "label") continue;
      pathWithoutLabels.push({ ...entry, parentId: pathParentId });
      pathParentId = entry.id;
    }
    outputEntries.push(...pathWithoutLabels);

    const pathEntryIds = new Set(pathWithoutLabels.map((entry) => entry.id));
    const labelsByTarget = new Map();
    const labelTimestampsByTarget = new Map();
    for (const entry of entries) {
      if (entry?.type !== "label" || !pathEntryIds.has(entry.targetId)) continue;
      if (entry.label) {
        labelsByTarget.set(entry.targetId, entry.label);
        labelTimestampsByTarget.set(entry.targetId, entry.timestamp);
      } else {
        labelsByTarget.delete(entry.targetId);
        labelTimestampsByTarget.delete(entry.targetId);
      }
    }

    let labelParentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
    const usedIds = new Set([...pathEntryIds, header.id]);
    for (const [targetId, label] of labelsByTarget) {
      const labelEntry = {
        type: "label",
        id: generatedSessionEntryId(usedIds),
        parentId: labelParentId,
        timestamp: labelTimestampsByTarget.get(targetId) || new Date().toISOString(),
        targetId,
        label,
      };
      outputEntries.push(labelEntry);
      labelParentId = labelEntry.id;
    }
  }

  await writeFile(sessionFile, `${outputEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
  return sessionFile;
}

async function createForkedSessionFile(tab, entryId) {
  requirePersistentSessions();
  const targetEntryId = String(entryId || "").trim();
  if (!targetEntryId) throw makeHttpError(400, "entryId is required");

  const state = await currentSessionState(tab).catch(() => tab.lastState || {});
  if (state.isCompacting) throw makeHttpError(409, "Wait for compaction to finish before forking the session.");
  const parentSession = state.sessionFile || tabRestorableSessionFile(tab);

  const entriesResponse = await safeRpcResponse(tab, { type: "get_entries" }, REQUEST_TIMEOUT_MS);
  if (entriesResponse.success === false) throw makeHttpError(400, entriesResponse.error || "failed to load session entries");
  const entries = Array.isArray(entriesResponse.data?.entries) ? entriesResponse.data.entries : [];
  const selectedEntry = entries.find((entry) => entry?.id === targetEntryId);
  if (!selectedEntry) throw makeHttpError(400, `Fork target entry not found in the active session: ${targetEntryId}`);
  if (selectedEntry.type !== "message" || selectedEntry.message?.role !== "user") {
    throw makeHttpError(400, "Fork point must be a user message");
  }

  const text = extractSessionTextContent(selectedEntry.message.content).trim();
  const sessionFile = await writeForkedSessionFromEntries({
    entries,
    targetLeafId: selectedEntry.parentId || null,
    cwd: tab.cwd,
    parentSession,
  });
  return { sessionFile, text, parentSession, targetEntryId };
}

function sessionTreeEntryLabel(entry) {
  if (!entry || typeof entry !== "object") return "entry";
  if (entry.type === "message") return entry.message?.role || "message";
  if (entry.type === "branch_summary") return "branch summary";
  if (entry.type === "compaction") return "compaction";
  if (entry.type === "model_change") return "model";
  if (entry.type === "thinking_level_change") return "thinking";
  if (entry.type === "custom_message") return entry.customType || "custom";
  return entry.type || "entry";
}

function sessionTreeEntryText(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (entry.type === "message") return extractSessionTextContent(entry.message?.content);
  if (entry.type === "custom_message" && entry.customType === "intercom_message") return "Intercom message";
  if (entry.type === "custom_message") return extractSessionTextContent(entry.content);
  if (entry.type === "branch_summary") return entry.summary || "branch summary";
  if (entry.type === "compaction") return entry.summary || "compaction summary";
  if (entry.type === "model_change") return [entry.provider, entry.modelId].filter(Boolean).join("/");
  if (entry.type === "thinking_level_change") return entry.thinkingLevel || "";
  return "";
}

function flattenSessionTree(nodes, { depth = 0, leafId, result = [] } = {}) {
  for (const node of nodes || []) {
    const entry = node.entry || {};
    result.push({
      id: entry.id,
      parentId: entry.parentId ?? null,
      depth,
      type: entry.type || "entry",
      role: entry.message?.role || undefined,
      label: node.label || undefined,
      timestamp: entry.timestamp || undefined,
      title: sessionTreeEntryLabel(entry),
      text: truncateStatusText(sessionTreeEntryText(entry), TREE_SELECTOR_TEXT_LIMIT),
      childCount: Array.isArray(node.children) ? node.children.length : 0,
      currentLeaf: !!leafId && entry.id === leafId,
    });
    flattenSessionTree(node.children || [], { depth: depth + 1, leafId, result });
  }
  return result;
}

async function getSessionTreeData(tab) {
  requirePersistentSessions();
  const state = await currentSessionState(tab).catch(() => tab.lastState || {});
  const sessionFile = state.sessionFile || tabRestorableSessionFile(tab);
  if (!sessionFile) throw makeHttpError(400, "No persisted session file is available for /tree.");
  const manager = SessionManager.open(sessionFile, configuredSessionDir(), tab.cwd);
  const leafId = manager.getLeafId();
  return {
    sessionFile: manager.getSessionFile(),
    sessionId: manager.getSessionId(),
    cwd: manager.getCwd(),
    leafId,
    nodes: flattenSessionTree(manager.getTree(), { leafId }),
    eventTargets: sessionTreeEventTargets(manager.getEntries()),
  };
}

async function getForkMessagesData(tab) {
  const response = await safeRpcResponse(tab, { type: "get_fork_messages" });
  if (response.success === false) throw makeHttpError(400, response.error || "failed to load fork points");
  return { messages: Array.isArray(response.data?.messages) ? response.data.messages : [] };
}

async function requireIdleForSessionAction(tab, actionLabel) {
  const state = await currentSessionState(tab);
  if (state.isStreaming || state.isCompacting) throw makeHttpError(409, `Wait for the current agent run or compaction to finish before ${actionLabel}.`);
}

async function runForkCommand(tab, entryId) {
  const fork = await createForkedSessionFile(tab, entryId);
  const title = uniqueTabTitle(generatedTabTitleFromPrompt(fork.text) || `${tab.title || "Session"} fork`, null);
  const forkTab = await createTab({
    title,
    titleSource: title ? "auto" : undefined,
    conversationStarted: true,
    cwd: tab.cwd,
    workspaceKind: tab.workspaceKind,
    noProjectId: tab.noProjectId,
    sessionFile: fork.sessionFile,
    gitWorkspace: tab.gitWorkspace,
  });
  const forkTabMeta = tabMeta(forkTab);
  return rpcSuccess("fork", {
    message: "Forked the current session in a new thread.",
    text: fork.text || "",
    result: { cancelled: false, text: fork.text || "", sessionFile: fork.sessionFile, targetEntryId: fork.targetEntryId },
    sessionFile: fork.sessionFile,
    parentSession: fork.parentSession,
    tab: forkTabMeta,
    tabs: listTabs(),
    sourceTab: tabMeta(tab),
  });
}

async function runCloneCommand(tab) {
  await requireIdleForSessionAction(tab, "cloning the session");
  const response = await tab.rpc.send({ type: "clone" });
  if (response.success === false) return response;
  const state = await safeRpcData(tab, { type: "get_state" }, STATUS_RPC_TIMEOUT_MS);
  if (state.ok) rememberTabState(tab, state.data);
  return rpcSuccess("clone", {
    message: response.data?.cancelled ? "Clone cancelled." : "Cloned the current session.",
    result: response.data,
    tab: tabMeta(tab),
  });
}

async function resumeSessionInNewTab(sourceTab, sessionPath) {
  requirePersistentSessions();
  const targetPath = resolveTabPath(sourceTab, sessionPath);
  if (!targetPath) throw makeHttpError(400, "sessionPath is required");
  if (!targetPath.endsWith(".jsonl")) throw makeHttpError(400, "sessionPath must point to a .jsonl session file");
  requireAllowedSessionPath(targetPath);
  const targetStats = await stat(targetPath).catch(() => null);
  if (!targetStats?.isFile()) throw makeHttpError(404, `Session file not found: ${targetPath}`);
  const manager = SessionManager.open(targetPath, configuredSessionDir());
  const sessionName = manager.getSessionName();
  const resumedTab = await createTab({
    title: sessionName ? uniqueTabTitle(sessionName, null) : undefined,
    titleSource: sessionName ? "explicit" : undefined,
    conversationStarted: true,
    cwd: manager.getCwd(),
    sessionFile: manager.getSessionFile(),
  });
  return rpcSuccess("switch_session", {
    message: "Resumed selected session in a new thread.",
    result: { cancelled: false, sessionFile: manager.getSessionFile() },
    tab: tabMeta(resumedTab),
    tabs: listTabs(),
    sourceTab: tabMeta(sourceTab),
  });
}

let authContextCache;

function authContext() {
  if (!authContextCache) {
    authContextCache = createAuthContext().catch((error) => {
      authContextCache = undefined;
      throw error;
    });
  }
  return authContextCache;
}

async function renameSessionData(tab, body) {
  requirePersistentSessions();
  const sessionPath = resolveTabPath(tab, body.sessionPath || body.path);
  const result = await renameSessionMetadata(sessionPath, body.name, configuredSessionDir(), { allowedDirs: allowedSessionDirs() });
  return {
    message: `Renamed session metadata to: ${result.name}`,
    ...result,
  };
}

async function deleteSessionData(tab, body) {
  requirePersistentSessions();
  const state = await currentSessionState(tab).catch(() => tab.lastState || {});
  const validation = validateSessionDelete(resolveTabPath(tab, body.sessionPath || body.path), {
    openSessionFiles: collectOpenSessionFiles([...tabs.values()]),
    currentSessionFile: state.sessionFile || tabRestorableSessionFile(tab),
    confirmed: body.confirmed === true,
    allowedDirs: allowedSessionDirs(),
  });
  if (!validation.allowed) {
    throw makeHttpError(validation.reason === "confirmation_required" ? 409 : validation.reason === "outside_session_dir" ? 403 : 400, validation.message);
  }
  const deleted = await deleteSessionFile(validation.sessionPath, { allowedDirs: allowedSessionDirs() });
  return {
    message: deleted.method === "trash" ? "Session moved to trash." : "Session deleted.",
    ...deleted,
  };
}

async function getAuthProvidersData() {
  return authProvidersPayload((await authContext()).modelRuntime);
}

async function logoutAuthProviderData(body) {
  if (body.confirmed !== true) throw makeHttpError(409, "Logout requires explicit confirmation (confirmed: true).");
  return logoutStoredProvider((await authContext()).modelRuntime, body.provider || body.providerId);
}

async function navigateSessionTree(tab, body) {
  requirePersistentSessions();
  await requireIdleForSessionAction(tab, "navigating the session tree");
  const entryId = String(body.entryId || body.targetId || "").trim();
  if (!entryId) throw makeHttpError(400, "entryId is required");
  const payload = {
    entryId,
    summarize: body.summarize === true,
    customInstructions: typeof body.customInstructions === "string" ? body.customInstructions : undefined,
    replaceInstructions: body.replaceInstructions === true,
    label: typeof body.label === "string" ? body.label : undefined,
  };
  const response = await tab.rpc.send({ type: "prompt", message: `/webui-tree-navigate ${JSON.stringify(payload)}` });
  if (response.success === false) return response;
  const state = await safeRpcData(tab, { type: "get_state" }, STATUS_RPC_TIMEOUT_MS);
  if (state.ok) rememberTabState(tab, state.data);
  return rpcSuccess("tree", {
    message: "Navigated the session tree.",
    result: response.data,
    tab: tabMeta(tab),
  });
}

function formatSessionOutput(tab, state, stats) {
  return [
    `Session: ${state.sessionName || state.sessionId || "unknown"}`,
    `Tab: ${tab.title}`,
    `CWD: ${tab.cwd}`,
    `Model: ${state.model ? `${state.model.provider}/${state.model.id}` : "none"}`,
    `Thinking: ${state.thinkingLevel || "unknown"}`,
    `Status: ${state.isStreaming ? "running" : state.isCompacting ? "compacting" : "idle"}`,
    `Messages: ${state.messageCount ?? "?"}`,
    `Queue: ${state.pendingMessageCount ?? 0}`,
    `Session file: ${state.sessionFile || "none"}`,
    stats ? `Tokens: input ${stats.tokens?.input ?? 0}, output ${stats.tokens?.output ?? 0}, cache read ${stats.tokens?.cacheRead ?? 0}` : undefined,
    stats?.cost !== undefined ? `Cost: ${stats.cost}` : undefined,
  ].filter(Boolean).join("\n");
}

function nativeExportBaseName(tab, state = {}) {
  const source = state.sessionName || tab?.title || state.sessionId || "pi-session";
  const date = new Date().toISOString().replace(/[:.]/g, "-");
  return safeDownloadFileName(`${source}-${date}`, "pi-session").replace(/\s+/g, "-");
}

async function nativeExportTempPath(tab, state = {}, ext = ".html") {
  await mkdir(NATIVE_EXPORT_TEMP_ROOT, { recursive: true });
  return path.join(NATIVE_EXPORT_TEMP_ROOT, `${nativeExportBaseName(tab, state)}-${randomUUID()}${ext}`);
}

function exportTargetExtension(targetPath) {
  return path.extname(targetPath).toLowerCase();
}

async function exportTargetExists(targetPath) {
  const targetStats = await stat(targetPath).catch(() => null);
  return !!targetStats;
}

async function handleNativeExportCommand(tab, args, req) {
  const explicitTarget = String(args || "").trim();
  const state = await currentSessionState(tab).catch(() => tab.lastState || {});

  if (!explicitTarget) {
    const outputPath = await nativeExportTempPath(tab, state, ".html");
    const response = await tab.rpc.send({ type: "export_html", outputPath });
    if (response.success === false) return response;
    const exportedPath = response.data?.path || outputPath;
    const download = registerNativeDownload(exportedPath, {
      command: "export",
      fileName: `${nativeExportBaseName(tab, state)}.html`,
      contentType: MIME_TYPES.get(".html"),
    });
    return respondNative("export", nativeExportDownloadPayload({
      localRequest: isLocalRequest(req),
      exportedPath,
      download,
      responseData: response.data,
    }));
  }

  if (!isLocalRequest(req)) {
    return respondNative("export", {
      status: "blocked",
      level: "error",
      reason: "Server-side export paths are only allowed from localhost.",
      safetyRestriction: "Explicit /export paths write files on the server and are blocked for non-local browser clients.",
      message: "Explicit /export paths are only allowed from localhost. Run /export without a path for a browser download, or retry from the local machine.",
      refresh: [],
    });
  }

  const targetPath = resolveTabPath(tab, explicitTarget);
  const ext = exportTargetExtension(targetPath);
  if (![".html", ".jsonl"].includes(ext)) throw makeHttpError(400, "Usage: /export [path.html|path.jsonl]");
  if (await exportTargetExists(targetPath)) {
    return respondNative("export", {
      status: "confirmation_required",
      level: "warn",
      reason: `Export target already exists: ${targetPath}`,
      safetyRestriction: "Overwrites require an explicit confirmation flow, which is not available from plain slash-command text yet.",
      message: `Export target already exists and was not overwritten:\n${targetPath}\n\nUse /export without a path for a browser download, or delete/rename the existing file first.`,
      refresh: [],
    });
  }

  await mkdir(path.dirname(targetPath), { recursive: true });

  if (ext === ".html") {
    const response = await tab.rpc.send({ type: "export_html", outputPath: targetPath });
    if (response.success === false) return response;
    return respondNative("export", {
      status: "succeeded",
      level: "info",
      message: `Exported current session HTML to server path:\n${response.data?.path || targetPath}`,
      serverPath: response.data?.path || targetPath,
      result: response.data,
      refresh: ["state"],
    });
  }

  requirePersistentSessions();
  const sessionFile = state.sessionFile || tabRestorableSessionFile(tab);
  if (!sessionFile) throw makeHttpError(400, "No persisted session file is available for JSONL export.");
  const sourceStats = await stat(sessionFile).catch(() => null);
  if (!sourceStats?.isFile()) throw makeHttpError(404, `Current session file not found: ${sessionFile}`);
  await copyFile(sessionFile, targetPath);
  return respondNative("export", {
    status: "succeeded",
    level: "info",
    message: `Copied current session JSONL to server path:\n${targetPath}`,
    serverPath: targetPath,
    result: { path: targetPath, sourcePath: sessionFile },
    refresh: ["state"],
  });
}

function webuiHotkeysOutput() {
  return [
    "Web UI hotkeys:",
    "Enter: send on desktop; newline on mobile",
    "Ctrl/Cmd+Enter: send from textarea",
    "Tab: accept slash-command or @path suggestion",
    "Arrow up/down: move through slash-command or @path suggestions",
    "Escape: close actions, tabs, model picker, or mobile drawer",
    "Mobile: Send button submits; Return inserts a newline",
  ].join("\n");
}

async function handleNativeSlashCommand(tab, body, req) {
  const parsed = parseSlashCommand(body.message);
  if (!parsed) return undefined;

  // Dispatch guards come straight from the parity matrix guards array (not the
  // sensitive flag), so localhost/trusted-context entries cannot drift out of
  // enforcement; confirmation guards stay handler/browser-specific by design.
  const evaluation = evaluateDispatchTrustGuards(guardsForNativeCommand(parsed.name, nativeParityMatrix), {
    isLocal: isLocalRequest(req),
    confirmed: body.confirmed === true,
    networkOpen: networkStatus().open,
  });
  if (!evaluation.allowed) {
    return nativeCommandBlocked(parsed.name, req, nativeParityMatrix, {
      confirmed: body.confirmed === true,
      networkOpen: networkStatus().open,
    });
  }

  switch (parsed.name) {
    case "reload": {
      const reloaded = await restartTabRpc(tab, "slash-command");
      return respondNative("reload", {
        status: "succeeded",
        message: "Reloaded keybindings, extensions, skills, prompts, and themes.",
        tab: tabMeta(reloaded),
        refresh: ["tabs", "state", "commands"],
      });
    }
    case "new": {
      if (tab.workspaceKind === "no-project") {
        if (parsed.args) throw makeHttpError(400, "Use /new without arguments to start a No Project conversation");
        const created = await createNoProjectResetTab(tab);
        return respondNative("new", {
          status: "succeeded",
          message: "Started a new No Project conversation in a new thread.",
          ...created,
          refresh: ["tabs", "state"],
        });
      }
      const response = await tab.rpc.send({ type: "new_session" });
      if (response.success === false) return response;
      tab.conversationStarted = false;
      resetAutomaticTabTitleForNewSession(tab);
      forgetTabState(tab);
      rememberTabState(tab, response.data);
      clearPendingExtensionUiRequests(tab);
      clearExtensionStatuses(tab);
      clearExtensionWidgets(tab);
      clearWebuiSubagents(tab);
      resetNaturalConversationMode(tab);
      resetCodexFastMode(tab);
      return respondNative("new", {
        status: "succeeded",
        message: "Started a new session.",
        tab: tabMeta(tab),
        result: response.data,
        refresh: ["tabs", "state"],
      });
    }
    case "compact": {
      const response = await tab.rpc.send(parsed.args ? { type: "compact", customInstructions: parsed.args } : { type: "compact" });
      if (response.success === false) return response;
      return respondNative("compact", {
        status: "succeeded",
        message: "Compaction finished.",
        result: response.data,
        refresh: ["state"],
      });
    }
    case "name": {
      if (!parsed.args) throw makeHttpError(400, "Usage: /name <session name>");
      const response = await tab.rpc.send({ type: "set_session_name", name: parsed.args });
      if (response.success === false) return response;
      renameTab(tab, parsed.args, { source: "explicit" });
      return respondNative("name", {
        status: "succeeded",
        message: `Session and thread name set to: ${tab.title}`,
        tab: tabMeta(tab),
        refresh: ["tabs"],
      });
    }
    case "session": {
      const [state, stats] = await Promise.all([
        tab.rpc.send({ type: "get_state" }),
        tab.rpc.send({ type: "get_session_stats" }).catch((error) => ({ success: false, error: sanitizeError(error) })),
      ]);
      if (state.success === false) return state;
      return respondNative("session", {
        status: "succeeded",
        message: formatSessionOutput(tab, state.data || {}, stats.success === false ? null : stats.data),
        refresh: ["state"],
      });
    }
    case "export": {
      return handleNativeExportCommand(tab, parsed.args, req);
    }
    case "copy": {
      const response = await tab.rpc.send({ type: "get_last_assistant_text" });
      if (response.success === false) return response;
      const text = String(response.data?.text || "");
      if (!text.trim()) throw makeHttpError(400, "No assistant message to copy.");
      return respondNative("copy", {
        status: "succeeded",
        message: "Copied the last assistant message.",
        copyText: text,
        refresh: [],
      });
    }
    case "hotkeys": {
      return respondNative("hotkeys", {
        status: "degraded",
        message: webuiHotkeysOutput(),
        refresh: [],
      });
    }
    case "clone": {
      const response = await runCloneCommand(tab);
      if (response.success === false) return response;
      return respondNative("clone", {
        status: "succeeded",
        message: response.data?.message || "Cloned the current session.",
        result: response.data?.result,
        refresh: ["tabs", "state"],
      });
    }
    default:
      return unavailableNative(parsed.name);
  }
}

async function closeTab(id, { allowLast = false } = {}) {
  const tab = tabs.get(id);
  if (!tab) throw makeHttpError(404, `Unknown Pi tab: ${id}`);
  if (!allowLast && tabs.size <= 1) throw makeHttpError(400, "Cannot close the last Pi thread");

  let restorableState = null;
  if (!options.noSession) {
    const stateResult = await safeRpcData(tab, { type: "get_state" }, STATUS_RPC_TIMEOUT_MS);
    if (stateResult.ok) restorableState = stateResult.data;
  }
  rememberClosedRestorableTab(tab, restorableState);
  gitLiveWatcher.unsubscribe(tab.id);
  workspaceFilesLiveWatcher.unsubscribe(tab.id);

  const closingEvent = { type: "webui_tab_closing", tabId: tab.id, tabTitle: tab.title };
  recordEvent(closingEvent);
  for (const client of tab.sseClients) {
    sendSseToClient(client, closingEvent);
    client.res.end();
  }
  tab.sseClients.clear();
  tab.rpcUnsubscribe?.();
  rejectTabBashQueue(tab, new Error("Pi tab closed; queued bash commands were cancelled"));
  stopAppRunnerForTab(tab, "tab closed", { force: true });
  await tab.rpc.stop();
  tab.rpc.dispose?.();
  tabs.delete(id);
  return tab;
}

async function discardTab(tab) {
  if (!tab || !tabs.has(tab.id)) return;
  gitLiveWatcher.unsubscribe(tab.id);
  workspaceFilesLiveWatcher.unsubscribe(tab.id);
  tab.rpcUnsubscribe?.();
  rejectTabBashQueue(tab, new Error("Pi recovery tab initialization failed"));
  stopAppRunnerForTab(tab, "recovery initialization failed", { force: true });
  try {
    await tab.rpc.stop();
  } finally {
    tab.rpc.dispose?.();
    tabs.delete(tab.id);
  }
}

function recoveryText(value, field, maxChars) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw makeHttpError(400, `${field} is required`);
  if (text.length > maxChars) throw makeHttpError(413, `${field} is too large`);
  if (/\0/u.test(text)) throw makeHttpError(400, `${field} contains invalid characters`);
  return text;
}

function requireRecoveryEndpointAuthorization(req) {
  requireLocalhostRoute(req, RECOVERY_ENDPOINT_PATH);
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/iu);
  const credential = match?.[1]?.trim();
  if (!credential || ![...recoveryEndpointTokens].some((expected) => safeTimingEqual(credential, expected))) {
    throw makeHttpError(401, "Invalid recovery endpoint credential");
  }
}

async function openPlanRecovery(body = {}) {
  if (body.mode !== "plan-only") throw makeHttpError(400, "Recovery mode must be plan-only");
  if (!body.model || typeof body.model !== "object" || Array.isArray(body.model)) throw makeHttpError(400, "model is required");
  const prompt = recoveryText(body.prompt, "prompt", RECOVERY_PROMPT_MAX_CHARS);
  const cwd = recoveryText(body.cwd, "cwd", 4096);
  const provider = recoveryText(body.model.provider, "model.provider", 160);
  const modelId = recoveryText(body.model.id, "model.id", 320);
  const tab = await createTab({
    title: RECOVERY_TITLE,
    titleSource: "explicit",
    conversationStarted: true,
    cwd,
  });

  try {
    const modelResponse = await tab.rpc.send({ type: "set_model", provider, modelId });
    if (modelResponse.success === false) throw makeHttpError(409, modelResponse.error || `Recovery model is unavailable: ${provider}/${modelId}`);
    markTabWorking(tab);
    const promptResponse = await tab.rpc.send({ type: "prompt", message: prompt }, PROMPT_REQUEST_TIMEOUT_MS);
    if (promptResponse.success === false) throw makeHttpError(409, promptResponse.error || "Recovery prompt was rejected");
    const event = {
      type: "webui_recovery_opened",
      requestId: tab.id,
      recoveryTabId: tab.id,
      recoveryTabTitle: tab.title,
      cwd: tab.cwd,
      model: { provider, id: modelId },
    };
    broadcastServerEvent(event);
    return { requestId: tab.id, tab: tabMeta(tab), tabs: listTabs() };
  } catch (error) {
    markTabIdle(tab);
    await discardTab(tab);
    throw error;
  }
}

async function closeTabs(ids, { allowEmpty = false } = {}) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean))];
  const targetTabs = uniqueIds.map((id) => tabs.get(id)).filter(Boolean);
  if (!targetTabs.length) return [];

  if (!allowEmpty && targetTabs.length >= tabs.size) {
    await createTab({ cwd: targetTabs[0]?.cwd || options.cwd });
  }

  const closed = [];
  for (const tab of targetTabs) {
    if (!tabs.has(tab.id)) continue;
    closed.push(await closeTab(tab.id, { allowLast: allowEmpty }));
  }
  return closed;
}

function requestedTabId(req, url, body) {
  const header = req.headers["x-pi-webui-tab"];
  const headerValue = Array.isArray(header) ? header[0] : header;
  return String(url.searchParams.get("tab") || url.searchParams.get("tabId") || body?.tabId || body?.tab || headerValue || "").trim();
}

function getRequestedTab(req, url, body = {}) {
  const id = requestedTabId(req, url, body);
  if (!id) {
    const tab = firstTab();
    if (!tab) throw makeHttpError(503, "No Pi tabs are available");
    return tab;
  }
  const tab = tabs.get(id);
  if (!tab) throw makeHttpError(404, `Unknown Pi tab: ${id}`);
  return tab;
}

function optionalRequestedTab(req, url, body = {}) {
  if (!requestedTabId(req, url, body) && tabs.size === 0) return null;
  return getRequestedTab(req, url, body);
}

function directoryPickerActiveCwd(req, url, body = {}) {
  const id = requestedTabId(req, url, body);
  if (id) return getRequestedTab(req, url, body).cwd;
  return firstTab()?.cwd || options.cwd;
}

function appendDiscoveryDiagnostic(discovery, kind, diagnosticPath = "") {
  if (discovery.diagnostics.some((item) => item.kind === kind && item.path === diagnosticPath)) return;
  if (discovery.diagnostics.length >= APPEND_SYSTEM_DISCOVERY_LIMITS.maxDiagnostics) {
    discovery.diagnostics.length = APPEND_SYSTEM_DISCOVERY_LIMITS.maxDiagnostics - 1;
    discovery.limits.truncated.diagnostics = true;
  }
  discovery.diagnostics.push({
    kind,
    path: diagnosticPath,
    message: APPEND_SYSTEM_DIAGNOSTIC_MESSAGES[kind],
  });
}

async function appendSystemFilesData(tab, savedSettings) {
  const settings = savedSettings || await readWebuiSettings();
  const savedUsesPiDefault = isGlobalPiAppendSystemPromptPath(settings.appendSystemPromptPath);
  const discovery = await discoverAppendSystemFiles({
    piRoot: path.join(homedir(), ".pi"),
    cwd: tab.cwd,
    savedPath: savedUsesPiDefault ? null : settings.appendSystemPromptPath,
    excludedPaths: [globalPiAppendSystemPromptPath()],
  });
  if (!settings.appendSystemPromptPath || savedUsesPiDefault) return discovery;

  const validated = await validatePersistedAppendSystemSelection(settings);
  if (!validated) {
    appendDiscoveryDiagnostic(discovery, "saved-selection-invalid", settings.appendSystemPromptPath);
    return discovery;
  }

  discovery.diagnostics = discovery.diagnostics.filter((item) => item.kind !== "saved-selection-invalid" || item.path !== validated.path);
  if (!discovery.candidates.some((candidate) => candidate.path === validated.path)) {
    if (discovery.candidates.length >= APPEND_SYSTEM_DISCOVERY_LIMITS.maxCandidates) {
      discovery.candidates.pop();
      discovery.limits.truncated.candidates = true;
      appendDiscoveryDiagnostic(discovery, "candidate-limit");
    }
    discovery.candidates.push({ path: validated.path, rootLabel: "Saved selection" });
    discovery.candidates.sort((left, right) => left.path.localeCompare(right.path, "en"));
  }
  return discovery;
}

function requireAppendSystemRequest(req, { json = false } = {}) {
  if (!isLoopbackHostAuthority(req.headers.host)) {
    throw makeHttpError(403, "APPEND_SYSTEM.md requests require a loopback Host authority.");
  }
  const fetchSite = String(req.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw makeHttpError(403, "Cross-origin APPEND_SYSTEM.md requests are blocked.");
  }
  if (!json) return;
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw makeHttpError(415, "APPEND_SYSTEM.md selection saves require Content-Type: application/json.");
  }
}

function validateAppendSystemSelectionBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw makeHttpError(400, "APPEND_SYSTEM.md selection body must be an object with only tabId and path.");
  }
  const allowedFields = new Set(["tabId", "path"]);
  const unknownFields = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unknownFields.length) {
    throw makeHttpError(400, `APPEND_SYSTEM.md selection body contains unsupported field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}.`);
  }
  if (!Object.hasOwn(body, "tabId") || !Object.hasOwn(body, "path")) {
    throw makeHttpError(400, "APPEND_SYSTEM.md selection body requires tabId and path.");
  }
  if (typeof body.tabId !== "string" || !body.tabId.trim()) {
    throw makeHttpError(400, "tabId must be a non-empty string");
  }
  if (body.path !== null && typeof body.path !== "string") {
    throw makeHttpError(400, "path must be an APPEND_SYSTEM.md candidate path or null");
  }
  return body;
}

async function saveAppendSystemSelection(tab, body) {
  const requestedPath = isGlobalPiAppendSystemPromptPath(body.path) ? null : body.path;
  const freshSelection = requestedPath === null
    ? null
    : await validateAppendSystemSelection(requestedPath, {
        piRoot: path.join(homedir(), ".pi"),
        cwd: tab.cwd,
      });
  let changed = false;
  const settings = await updateWebuiSettings(async (current) => {
    let selected = freshSelection;
    if (requestedPath !== null && !selected && current.appendSystemPromptPath === requestedPath) {
      selected = await validatePersistedAppendSystemSelection(current);
    }
    if (requestedPath !== null && !selected) {
      throw makeHttpError(400, "path must name an APPEND_SYSTEM.md candidate from a fresh discovery scan");
    }

    const appendSystemPromptPath = selected?.path || null;
    const appendSystemPromptRootPath = selected?.rootPath || null;
    changed = current.appendSystemPromptPath !== appendSystemPromptPath
      || current.appendSystemPromptRootPath !== appendSystemPromptRootPath;
    return changed ? { appendSystemPromptPath, appendSystemPromptRootPath } : undefined;
  });
  const discovery = await appendSystemFilesData(tab, settings);
  return { ...discovery, changed, restartRequired: changed };
}

async function createInitialTabs() {
  const managedTabs = await hydrateManagedTabs(rpcSupervisorSnapshot);
  if (rpcSupervisorSnapshot?.tabs?.length) return managedTabs;
  // A successor cannot create new affected work while its predecessor's
  // verified update fence is still held. Ordinary tab creation resumes after
  // the successor has proved startup and released that fence.
  if (process.env.PI_WEBUI_NATIVE_RESTART_TRANSACTION) return [];
  if (!restoreTabs.length) return options.cwdExplicit ? [await createTab()] : [];

  const created = [];
  for (const descriptor of restoreTabs) {
    try {
      created.push(await createTab(descriptor));
    } catch (error) {
      console.warn(`failed to restore Web UI tab ${descriptor.title || descriptor.id || "unknown"}: ${sanitizeError(error)}`);
    }
  }

  return created.length || restoreTabs.some((tab) => tab.workspaceKind === "no-project") ? created : options.cwdExplicit ? [await createTab()] : [];
}

const serverStartedAt = new Date().toISOString();
const persistedStartupSettings = await readWebuiSettings(undefined, { reportInvalidOutputMode: true });
let persistedRemoteAuthEnabled = persistedStartupSettings.remoteAuthEnabled === true;
let persistedOutputModeDefault = persistedStartupSettings.outputModeDefault;
optionalFeatureMigrationStore = new OptionalFeatureMigrationStore({
  filePath: process.env.PI_WEBUI_OPTIONAL_FEATURE_MIGRATION_FILE || path.join(agentDir, "webui", "optional-feature-migration.json"),
});
optionalFeatureAuditCoordinator = new OptionalFeatureAuditCoordinator({
  catalog: OPTIONAL_FEATURE_CATALOG,
  collectStatuses: async () => (await optionalFeaturePackageStatuses(options.cwd)).features,
  store: optionalFeatureMigrationStore,
  webuiVersion: packageJson.version,
  onEvent: (event) => broadcastServerEvent(event),
});
let currentHost = options.host;
let networkRebindInProgress = false;
let networkRebindTargetHost = null;

function resolvedOutputModeDefault() {
  return resolveOutputModeDefault({
    cliMode: options.outputMode,
    envMode: options.envOutputMode,
    persistedMode: persistedOutputModeDefault,
  });
}

function outputModeMetadata() {
  const resolved = resolvedOutputModeDefault();
  return {
    persistedDefault: normalizeOutputMode(persistedOutputModeDefault),
    effectiveDefault: resolved.mode,
    source: resolved.source,
    overridden: resolved.source === "cli" || resolved.source === "env",
  };
}

function tabHasActiveOutput(tab) {
  return tab?.activity?.isWorking === true || tab?.lastState?.isStreaming === true || tab?.lastState?.isCompacting === true;
}

function refreshAutoOutputModes() {
  const resolved = resolvedOutputModeDefault();
  for (const tab of tabs.values()) {
    for (const client of tab.sseClients) {
      if (client.requestedMode !== "auto") continue;
      client.defaultSource = resolved.source;
      if (client.activeMode === resolved.mode) {
        client.pendingMode = undefined;
      } else if (tabHasActiveOutput(tab)) {
        client.pendingMode = resolved.mode;
      } else {
        activateOutputMode(client, resolved.mode);
      }
    }
  }
}

const BROWSER_PROMPT_REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const BROWSER_PROMPT_REQUEST_TTL_MS = 10 * 60 * 1000;
const BROWSER_PROMPT_REQUEST_LIMIT = 256;

function browserPromptRequestId(value) {
  if (value === undefined) return null;
  const id = String(value || "");
  if (!BROWSER_PROMPT_REQUEST_ID.test(id)) throw makeHttpError(400, "requestId must be an opaque 16-128 character identifier");
  return id;
}

function browserPromptFingerprint(body) {
  return createHash("sha256").update(JSON.stringify({
    message: String(body?.message || ""),
    streamingBehavior: body?.streamingBehavior === "steer" || body?.streamingBehavior === "followUp" ? body.streamingBehavior : "",
    images: Array.isArray(body?.images) ? body.images : [],
  })).digest("base64url");
}

function pruneBrowserPromptRequests(tab, now = Date.now()) {
  const requests = tab?.browserPromptRequests;
  if (!requests) return;
  for (const [id, entry] of requests) {
    if (entry.settledAt && entry.settledAt + BROWSER_PROMPT_REQUEST_TTL_MS <= now) requests.delete(id);
  }
}

async function deduplicateBrowserPromptRequest(tab, body, dispatch) {
  const requestId = browserPromptRequestId(body?.requestId);
  if (!requestId) return dispatch();
  const requests = tab.browserPromptRequests || (tab.browserPromptRequests = new Map());
  const fingerprint = browserPromptFingerprint(body);
  pruneBrowserPromptRequests(tab);
  const known = requests.get(requestId);
  if (known) {
    if (known.fingerprint !== fingerprint) throw makeHttpError(409, "requestId was already used for a different prompt");
    return known.promise;
  }
  while (requests.size >= BROWSER_PROMPT_REQUEST_LIMIT) {
    const settled = [...requests.entries()].find(([, entry]) => entry.settledAt);
    if (!settled) throw makeHttpError(429, "too many in-flight prompt requests for this tab");
    requests.delete(settled[0]);
  }
  const entry = { fingerprint, settledAt: 0, promise: null };
  entry.promise = Promise.resolve().then(dispatch).finally(() => {
    entry.settledAt = Date.now();
    pruneBrowserPromptRequests(tab, entry.settledAt);
  });
  requests.set(requestId, entry);
  return entry.promise;
}

async function saveOutputModeDefault(value) {
  let mode;
  try {
    mode = requiredOutputMode(value, "outputModeDefault");
  } catch (error) {
    throw makeHttpError(400, formatCliError(error));
  }
  const settings = await writeWebuiSettings({ outputModeDefault: mode });
  persistedOutputModeDefault = settings.outputModeDefault;
  refreshAutoOutputModes();
  return outputModeMetadata();
}

function interfacePreferencesResponse(settings) {
  return {
    shellRolloutCohort: validatedShellRolloutCohort(settings.shellRollout),
    preferences: settings.interfacePreferences,
    layout: settings.uiLayout,
    layoutRevision: uiLayoutRevision(settings.uiLayout),
  };
}

function interfacePreferencesRequestError(error, operation) {
  if (error?.statusCode) return error;
  if (error?.code === "UI_LAYOUT_INVALID" || error instanceof TypeError) return makeHttpError(400, formatCliError(error));
  if (error?.code === "UI_LAYOUT_STALE_REVISION") return makeHttpError(409, "The interface layout changed after it was read; refresh and retry.");
  const message = error?.code === "WEBUI_SETTINGS_LOCK_TIMEOUT"
    ? "Interface preferences are busy; retry shortly."
    : `Could not ${operation} interface preferences.`;
  const wrapped = makeHttpError(error?.code === "WEBUI_SETTINGS_LOCK_TIMEOUT" ? 503 : 500, message);
  wrapped.userMessage = message;
  return wrapped;
}

function requireInterfacePreferencesJsonRequest(req) {
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw makeHttpError(415, "Interface preference saves require Content-Type: application/json.");
}

function validateInterfacePreferencesBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw makeHttpError(400, "Interface preference save body must be an object.");
  const allowed = new Set(["sidePanelWidth", "layout", "expectedLayoutRevision"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw makeHttpError(400, `Interface preference save contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  const hasWidth = Object.hasOwn(body, "sidePanelWidth");
  const hasLayout = Object.hasOwn(body, "layout");
  if (!hasWidth && !hasLayout) throw makeHttpError(400, "Interface preference save must include sidePanelWidth or layout.");
  if (hasWidth) {
    if (typeof body.sidePanelWidth !== "number" || !Number.isFinite(body.sidePanelWidth) || body.sidePanelWidth < WEBUI_SIDE_PANEL_WIDTH_MIN_PX || body.sidePanelWidth > WEBUI_SIDE_PANEL_WIDTH_MAX_PX) {
      throw makeHttpError(400, `sidePanelWidth must be between ${WEBUI_SIDE_PANEL_WIDTH_MIN_PX} and ${WEBUI_SIDE_PANEL_WIDTH_MAX_PX} pixels`);
    }
  }
  if (hasLayout) {
    if (!Object.hasOwn(body, "expectedLayoutRevision") || typeof body.expectedLayoutRevision !== "string" || !/^[a-f0-9]{64}$/u.test(body.expectedLayoutRevision)) {
      throw makeHttpError(400, "layout saves require the latest layoutRevision as expectedLayoutRevision.");
    }
    validateUiLayoutPatch(body.layout);
  } else if (Object.hasOwn(body, "expectedLayoutRevision")) {
    throw makeHttpError(400, "expectedLayoutRevision is only valid with a layout save.");
  }
  return { hasWidth, hasLayout };
}

async function interfacePreferencesData() {
  return interfacePreferencesResponse(await readWebuiSettings());
}

async function saveInterfacePreferences(body = {}) {
  const { hasWidth, hasLayout } = validateInterfacePreferencesBody(body);
  const settings = await updateWebuiSettings((current) => {
    if (hasLayout && body.expectedLayoutRevision !== uiLayoutRevision(current.uiLayout)) {
      const error = new Error("stale interface layout revision");
      error.code = "UI_LAYOUT_STALE_REVISION";
      throw error;
    }
    const patch = {};
    if (hasWidth) patch.interfacePreferences = { sidePanelWidth: Math.round(body.sidePanelWidth) };
    if (hasLayout) patch.uiLayout = mergeUiLayout(current.uiLayout, body.layout);
    return patch;
  });
  return interfacePreferencesResponse(settings);
}

const remoteAuth = {
  pin: undefined,
  token: undefined,
  tokenExpiresAt: 0,
};

function localNetworkAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)].sort();
}

function remoteAuthRequired() {
  return !isLocalHost(currentHost) && !!remoteAuth.pin;
}

function generateRemotePin() {
  return String(randomInt(0, 10_000)).padStart(4, "0");
}

function enableRemoteAuth(reason = "network exposure") {
  remoteAuth.pin = generateRemotePin();
  remoteAuth.token = createHash("sha256").update(`${randomUUID()}:${remoteAuth.pin}:${Date.now()}`).digest("base64url");
  remoteAuth.tokenExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  console.warn(`Pi Web UI remote PIN for ${reason}: ${remoteAuth.pin}`);
  return remoteAuth.pin;
}

function resetRemoteAuth() {
  remoteAuth.pin = undefined;
  remoteAuth.token = undefined;
  remoteAuth.tokenExpiresAt = 0;
}

function remoteAuthPreferenceEnabled() {
  return persistedRemoteAuthEnabled === true;
}

function remoteAuthStartupEnabled() {
  return options.remoteAuthExplicit ? options.remoteAuth === true : remoteAuthPreferenceEnabled();
}

function remoteAuthStartupReason() {
  if (options.remoteAuthExplicit) return "startup option";
  return "saved setting";
}

function remoteAuthStatus({ includePin = false } = {}) {
  const enabled = !!remoteAuth.pin;
  const status = {
    enabled,
    required: enabled && !isLocalHost(currentHost),
  };
  if (includePin && enabled) status.pin = remoteAuth.pin;
  return status;
}

function networkStatus({ includeAuthPin = false } = {}) {
  const open = !isLocalHost(currentHost);
  const targetHost = networkRebindTargetHost || currentHost;
  const opening = networkRebindInProgress && !isLocalHost(targetHost);
  const closing = networkRebindInProgress && isLocalHost(targetHost);
  const networkUrls = open ? localNetworkAddresses().map((address) => `http://${address}:${options.port}/`) : [];
  return {
    open,
    opening,
    closing,
    host: currentHost,
    port: options.port,
    localUrl: `http://127.0.0.1:${options.port}/`,
    networkUrls,
    auth: remoteAuthStatus({ includePin: includeAuthPin }),
  };
}

async function loadRemoteQrCore() {
  if (!remoteQrCorePromise) {
    remoteQrCorePromise = (async () => {
      const candidates = [];
      try {
        candidates.push(require.resolve("@firstpick/pi-package-remote-webui/lib/remote-core.mjs", { paths: [packageRoot] }));
      } catch {
        // Optional companion package is not installed; try the monorepo sibling below.
      }
      candidates.push(path.resolve(packageRoot, "..", "pi-package-remote-webui", "lib", "remote-core.mjs"));
      let lastError;
      for (const candidate of candidates) {
        try {
          await access(candidate);
          return await import(pathToFileURL(candidate).href);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("Remote WebUI QR support is unavailable");
    })();
  }
  return remoteQrCorePromise;
}

function networkQrDisplayUrl(network) {
  const urls = Array.isArray(network?.networkUrls) ? network.networkUrls : [];
  return urls.find((candidate) => typeof candidate === "string" && /^https?:\/\//i.test(candidate)) || network?.localUrl || `http://127.0.0.1:${options.port}/`;
}

async function remoteNetworkQrPayload() {
  const network = networkStatus({ includeAuthPin: true });
  const { generateQrLines, remoteAuthQrUrl } = await loadRemoteQrCore();
  const displayUrl = networkQrDisplayUrl(network);
  const qrUrl = remoteAuthQrUrl(displayUrl, network);
  const qrLines = await generateQrLines(qrUrl);
  return { url: displayUrl, qrUrl, qrLines, network };
}

function closeSseClientsForRebind(nextHost) {
  for (const tab of tabs.values()) {
    const rebindEvent = {
      type: "webui_network_rebinding",
      tabId: tab.id,
      tabTitle: tab.title,
      host: nextHost,
      port: options.port,
      opening: !isLocalHost(nextHost),
      closing: isLocalHost(nextHost),
    };
    recordEvent(rebindEvent);
    for (const client of tab.sseClients) {
      sendSseToClient(client, rebindEvent);
      client.res.end();
    }
    tab.sseClients.clear();
  }
}

function closeSseClientsForRemoteAuthChange() {
  for (const tab of tabs.values()) {
    const authEvent = {
      type: "webui_remote_auth_changed",
      tabId: tab.id,
      tabTitle: tab.title,
      auth: remoteAuthStatus(),
    };
    recordEvent(authEvent);
    for (const client of tab.sseClients) {
      sendSseToClient(client, authEvent);
      client.res.end();
    }
    tab.sseClients.clear();
  }
}

function closeServerListener() {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const forceCloseTimer = setTimeout(() => {
      // Rebinding is intentionally disruptive. Long-poll/SSE/keep-alive clients can
      // otherwise keep server.close() pending and leave currentHost stuck on 0.0.0.0.
      server.closeAllConnections?.();
    }, NETWORK_REBIND_FORCE_CLOSE_MS);
    forceCloseTimer.unref?.();
    server.close((error) => {
      clearTimeout(forceCloseTimer);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}

function listenOn(host) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, host);
  });
}

async function openToLocalNetwork() {
  const nextHost = "0.0.0.0";
  if (!isLocalHost(currentHost) || networkRebindInProgress) return networkStatus({ includeAuthPin: true });

  networkRebindInProgress = true;
  networkRebindTargetHost = nextHost;
  closeSseClientsForRebind(nextHost);
  const previousHost = currentHost;
  try {
    await closeServerListener();
    await listenOn(nextHost);
    currentHost = nextHost;
    console.warn(`WARNING: Web UI is now reachable from the local network${remoteAuth.pin ? " and requires the remote PIN for non-local clients" : " without remote PIN authentication"}.`);
    return networkStatus({ includeAuthPin: true });
  } catch (error) {
    console.error("Failed to open Web UI to local network:", sanitizeError(error));
    if (!server.listening) {
      try {
        await listenOn(previousHost);
      } catch (restoreError) {
        console.error("Failed to restore Web UI listener:", sanitizeError(restoreError));
      }
    }
    throw error;
  } finally {
    networkRebindInProgress = false;
    networkRebindTargetHost = null;
  }
}

async function closeNetworkAccess() {
  const nextHost = "127.0.0.1";
  if (isLocalHost(currentHost) || networkRebindInProgress) return networkStatus();

  networkRebindInProgress = true;
  networkRebindTargetHost = nextHost;
  closeSseClientsForRebind(nextHost);
  const previousHost = currentHost;
  try {
    await closeServerListener();
    await listenOn(nextHost);
    currentHost = nextHost;
    if (!remoteAuthPreferenceEnabled()) resetRemoteAuth();
    console.warn("Web UI network access closed; listening on localhost only.");
    return networkStatus({ includeAuthPin: true });
  } catch (error) {
    console.error("Failed to close Web UI network access:", sanitizeError(error));
    if (!server.listening) {
      try {
        await listenOn(previousHost);
      } catch (restoreError) {
        console.error("Failed to restore Web UI listener:", sanitizeError(restoreError));
      }
    }
    throw error;
  } finally {
    networkRebindInProgress = false;
    networkRebindTargetHost = null;
  }
}

if (remoteAuthStartupEnabled()) enableRemoteAuth(remoteAuthStartupReason());

async function safeRpcData(tab, command, timeoutMs = STATUS_RPC_TIMEOUT_MS) {
  try {
    const response = await tab.rpc.send(command, timeoutMs);
    if (response?.success === false) return { ok: false, error: response.error || `${command.type} failed` };
    if (command?.type === "get_state") rememberTabState(tab, response?.data);
    return { ok: true, data: command?.type === "get_state" ? stateWithPendingThinking(tab, response?.data) : response?.data ?? null };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
}

function stateIsBusyForSettings(state) {
  return !!(state?.isStreaming || state?.isCompacting);
}

async function setThinkingLevelForTab(tab, level, { allowPending = true } = {}) {
  if (!THINKING_LEVELS.includes(level)) throw makeHttpError(400, "Invalid thinking level");
  const stateResult = allowPending ? await safeRpcData(tab, { type: "get_state" }, STATUS_RPC_TIMEOUT_MS) : { ok: false };
  if (allowPending && stateResult.ok && stateIsBusyForSettings(stateResult.data)) {
    tab.pendingThinkingLevel = level;
    broadcastPendingThinkingState(tab, stateResult.data);
    return rpcSuccess("set_thinking_level", { level, pending: true, message: `Thinking level ${level} will apply to the next prompt.` });
  }
  const response = await tab.rpc.send({ type: "set_thinking_level", level });
  if (response.success !== false) {
    tab.pendingThinkingLevel = undefined;
    const updatedState = await safeRpcData(tab, { type: "get_state" }, STATUS_RPC_TIMEOUT_MS);
    const effectiveLevel = updatedState.ok ? updatedState.data?.thinkingLevel : level;
    return { ...response, data: { ...(response.data && typeof response.data === "object" ? response.data : {}), level: effectiveLevel || level, requestedLevel: level } };
  }
  return response;
}

async function applyPendingThinkingBeforePrompt(tab) {
  if (isNaturalConversationActive(tab)) {
    tab.pendingThinkingLevel = undefined;
    return null;
  }
  const level = tab?.pendingThinkingLevel;
  if (!level) return null;
  const stateResult = await safeRpcData(tab, { type: "get_state" }, STATUS_RPC_TIMEOUT_MS);
  if (stateResult.ok && stateIsBusyForSettings(stateResult.data)) return null;
  const response = await setThinkingLevelForTab(tab, level, { allowPending: false });
  if (response.success === false) return response;
  return { ...response, pendingApplied: true };
}

function providerList(models) {
  const providers = new Set();
  for (const model of Array.isArray(models) ? models : []) {
    if (model?.provider) providers.add(String(model.provider));
  }
  return [...providers].sort();
}

async function tabStatusDetails(tab) {
  const [stateResult, modelsResult, statsResult, workspaceResult] = await Promise.all([
    safeRpcData(tab, { type: "get_state" }),
    safeRpcData(tab, { type: "get_available_models" }),
    safeRpcData(tab, { type: "get_session_stats" }),
    getWorkspaceInfo(tab.cwd, tab.rpc.startedAt).then((data) => ({ ok: true, data })).catch((error) => ({ ok: false, error: sanitizeError(error) })),
  ]);
  const models = modelsResult.ok ? modelsResult.data?.models || [] : [];
  const stateData = stateResult.ok ? stateResult.data : tab.lastState || null;
  return {
    ...tabMeta(tab),
    state: stateData,
    stateError: stateResult.ok ? undefined : stateResult.error,
    stats: statsResult.ok ? statsResult.data : null,
    statsError: statsResult.ok ? undefined : statsResult.error,
    workspace: workspaceResult.ok ? workspaceResult.data : null,
    workspaceError: workspaceResult.ok ? undefined : workspaceResult.error,
    pendingExtensionUiRequests: pendingExtensionUiRequestSummaries(tab),
    models: {
      count: models.length,
      providers: providerList(models),
      error: modelsResult.ok ? undefined : modelsResult.error,
    },
  };
}

async function webuiStatus({ detailed = false, eventLimit = 40, includeAuthPin = false } = {}) {
  const tab = firstTab();
  const network = networkStatus({ includeAuthPin });
  const statusTabs = listTabs();
  const data = {
    online: true,
    webuiVersion: packageJson.version,
    piVersion: String(piPackageJson.version || ""),
    webuiDev: webuiDevServer,
    webuiMode: webuiDevServer ? "dev" : "production",
    webuiPid: process.pid,
    startedAt: serverStartedAt,
    cwd: options.cwd,
    boundHost: currentHost,
    port: options.port,
    pageUrl: network.localUrl,
    boundUrl: `http://${formatUrlHost(currentHost)}:${options.port}/`,
    network,
    rpcSupervisor: rpcSupervisorDiagnostics(),
    piPid: tab?.rpc.child?.pid,
    piRunning: !!tab?.rpc.child && tab.rpc.child.exitCode === null,
    outputMode: outputModeMetadata(),
    tabs: statusTabs,
    restorableTabs: mergeRestorableTabDescriptors(statusTabs),
  };

  if (detailed) {
    const detailedTabs = await Promise.all([...tabs.values()].map((item) => tabStatusDetails(item)));
    data.tabs = detailedTabs;
    data.restorableTabs = mergeRestorableTabDescriptors(detailedTabs);
    data.closedTabs = closedRestorableTabs.slice();
    data.events = latestEvents(eventLimit);
  }

  return data;
}

async function handlePromptRequest(tab, body, req) {
  if (isNaturalConversationActive(tab) && naturalConversationSlashCommandName(body.message) && !isNaturalConversationSlashCommand(body.message)) {
    blockNaturalConversationAction("slash commands are blocked from the Web UI shell");
  }
  const guidedGitLaunch = isGuidedGitWorkflowCommandMessage(body.message);
  const guidedGitLaunchId = guidedGitLaunch ? String(body.guidedGitLaunchId || "") : "";
  if (guidedGitLaunch) await authoritativeGuidedGitLaunchAdmission(tab, { launchId: guidedGitLaunchId, reserve: true });
  const releaseGuidedGitLaunch = () => clearPendingGuidedGitLaunch(tab, guidedGitLaunchId);
  try {
    const nativeResponse = await handleNativeSlashCommand(tab, body, req);
    if (nativeResponse) {
      if (nativeResponse.success === false) releaseGuidedGitLaunch();
      return { status: nativeResponse.success === false ? 400 : 200, payload: responseWithTab(nativeResponse, tab) };
    }
    const command = commandFromPost("/api/prompt", body);
    enforceNaturalConversationCommandAllowed(tab, command);
    const queuedForCompaction = guidedGitLaunch ? null : maybeQueueCommandDuringCompaction(tab, command);
    if (queuedForCompaction) return { status: 202, payload: responseWithTab(queuedForCompaction, tab) };
    const naturalConversationSafetyResponse = await ensureNaturalConversationPromptSafety(tab, command);
    if (naturalConversationSafetyResponse?.success === false) {
      releaseGuidedGitLaunch();
      return { status: 400, payload: responseWithTab(naturalConversationSafetyResponse, tab) };
    }
    const pendingThinkingResponse = await applyPendingThinkingBeforePrompt(tab);
    if (pendingThinkingResponse?.success === false) {
      releaseGuidedGitLaunch();
      return { status: 400, payload: responseWithTab(pendingThinkingResponse, tab) };
    }
    const startsVisibleWork = commandStartsVisibleWork(command);
    if (startsVisibleWork) {
      maybeNameTabForConversation(tab, command);
      markTabWorking(tab);
    }
    const response = await tab.rpc.send(command, PROMPT_REQUEST_TIMEOUT_MS);
    if (response.success === false) {
      releaseGuidedGitLaunch();
      if (startsVisibleWork) markTabIdle(tab);
    }
    return { status: response.success === false ? 400 : 200, payload: responseWithTab(response, tab) };
  } catch (error) {
    releaseGuidedGitLaunch();
    throw error;
  }
}

const server = createServer(async (req, res) => {
  try {
    res.piAcceptedEncoding = acceptedStaticEncoding(req);
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/remote-auth" && req.method === "GET") {
      sendRemoteAuthPage(res, url.searchParams.get("return") || "/");
      return;
    }

    if (url.pathname === "/api/remote-auth" && req.method === "GET") {
      sendJson(res, 200, { ok: true, data: { auth: remoteAuthStatus({ includePin: isLocalRequest(req) }), local: isLocalRequest(req) } });
      return;
    }

    if (url.pathname === "/api/remote-auth" && req.method === "POST") {
      const body = await readJsonBody(req);
      const pin = String(body.pin || "").trim();
      if (!remoteAuth.pin) throw makeHttpError(400, "Remote PIN authentication is not enabled");
      if (!/^\d{4}$/.test(pin) || !safeTimingEqual(pin, remoteAuth.pin)) throw makeHttpError(403, "Incorrect remote PIN");
      sendJson(res, 200, { ok: true, data: { auth: remoteAuthStatus() } }, { "set-cookie": remoteAuthCookie() });
      return;
    }

    if (url.pathname === RECOVERY_ENDPOINT_PATH && req.method === "POST") {
      requireRecoveryEndpointAuthorization(req);
      const result = await openPlanRecovery(await readJsonBody(req, { limitBytes: RECOVERY_BODY_LIMIT_BYTES }));
      sendJson(res, 201, { ok: true, requestId: result.requestId, data: result });
      return;
    }

    if (shouldChallengeRemoteAuth(req, url)) {
      sendRemoteAuthRequired(req, res, url);
      return;
    }

    if (url.pathname === "/api/session-summary/preferences" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await sessionSummaryPreferencesData(tab) }, { "cache-control": "private, no-store" });
      return;
    }

    if (url.pathname === "/api/session-summary/preferences" && req.method === "PUT") {
      requireSessionSummaryJsonRequest(req);
      const body = await readJsonBody(req, { limitBytes: SESSION_SUMMARY_REQUEST_MAX_BYTES });
      const tab = getRequestedTab(req, url, body);
      sendJson(res, 200, { ok: true, data: await saveSessionSummaryPreferencesData(tab, body) }, { "cache-control": "private, no-store" });
      return;
    }

    if (url.pathname === "/api/session-summary/generate" && req.method === "POST") {
      requireSessionSummaryJsonRequest(req);
      const body = await readJsonBody(req, { limitBytes: SESSION_SUMMARY_REQUEST_MAX_BYTES });
      requiredSessionSummaryObject(body, "request", ["refresh", "tab"]);
      if (body.refresh !== undefined && typeof body.refresh !== "boolean") throw makeHttpError(400, "refresh must be true or false");
      const tab = getRequestedTab(req, url, body);
      sendJson(res, 200, { ok: true, data: await triggerSessionSummary(tab, { refresh: body.refresh === true }) }, { "cache-control": "private, no-store" });
      return;
    }

    if (url.pathname === "/api/workflow-policy" && req.method === "GET") {
      requireLocalhost(req, "Workflow policy setup is only allowed from localhost.");
      try {
        const policyModule = await workflowPolicyModule();
        const state = await policyModule.readWorkflowPolicyState({ agentDir });
        // Suggestions are advisory helpers only and are never part of the persisted v1 policy.
        sendJson(res, 200, { ok: true, data: { ...state, suggestions: policyModule.WORKFLOW_POLICY_SUGGESTIONS } });
      } catch (error) {
        throw workflowPolicyRequestError(error);
      }
      return;
    }

    if (url.pathname === "/api/workflow-policy" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      requireWorkflowPolicyJsonRequest(req);
      const body = workflowPolicySaveBody(await readJsonBody(req));
      ensureWorkflowPolicyMutationAllowed();
      try {
        const policyModule = await workflowPolicyModule();
        sendJson(res, 200, { ok: true, data: await policyModule.writeWorkflowPolicyState({
          agentDir,
          policy: body.policy,
          expectedRevision: body.expectedRevision,
        }) });
      } catch (error) {
        throw workflowPolicyRequestError(error);
      }
      return;
    }

    if (url.pathname === "/api/remote-auth/settings" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req);
      if (body.enabled === true) {
        enableRemoteAuth("side panel toggle");
        await saveRemoteAuthPreference(true);
      } else if (body.enabled === false) {
        resetRemoteAuth();
        await saveRemoteAuthPreference(false);
      } else throw makeHttpError(400, "enabled must be true or false");
      closeSseClientsForRemoteAuthChange();
      const headers = body.enabled === false ? { "set-cookie": clearRemoteAuthCookie() } : {};
      sendJson(res, 200, { ok: true, data: { auth: remoteAuthStatus({ includePin: true }), network: networkStatus({ includeAuthPin: true }) } }, headers);
      return;
    }

    if (url.pathname === "/api/webui-output-mode" && req.method === "GET") {
      sendJson(res, 200, { ok: true, data: outputModeMetadata() });
      return;
    }

    if (url.pathname === "/api/webui-output-mode" && req.method === "PUT") {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, data: await saveOutputModeDefault(body.outputModeDefault) });
      return;
    }

    if (url.pathname === "/api/interface-preferences" && req.method === "GET") {
      try {
        sendJson(res, 200, { ok: true, data: await interfacePreferencesData() });
      } catch (error) {
        throw interfacePreferencesRequestError(error, "read");
      }
      return;
    }

    if (url.pathname === "/api/interface-preferences" && req.method === "PUT") {
      requireInterfacePreferencesJsonRequest(req);
      try {
        let body;
        try {
          body = await readJsonBody(req, { limitBytes: UI_LAYOUT_REQUEST_MAX_BYTES });
        } catch (error) {
          if (error instanceof SyntaxError) throw makeHttpError(400, "Interface preference save body must be valid JSON.");
          throw error;
        }
        sendJson(res, 200, { ok: true, data: await saveInterfacePreferences(body) });
      } catch (error) {
        throw interfacePreferencesRequestError(error, "save");
      }
      return;
    }

    if (url.pathname === "/api/tabs" && req.method === "GET") {
      sendJson(res, 200, { ok: true, data: { tabs: await listTabsWithReconciledActivity() } });
      return;
    }

    if (url.pathname === "/api/append-system-files" && req.method === "GET") {
      requireLocalhost(req, "APPEND_SYSTEM.md discovery is only allowed from localhost");
      requireAppendSystemRequest(req);
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await appendSystemFilesData(tab) }, { "cache-control": "private, no-store" });
      return;
    }

    if (url.pathname === "/api/append-system-selection" && req.method === "POST") {
      requireLocalhost(req, "Saving an APPEND_SYSTEM.md selection is only allowed from localhost");
      requireAppendSystemRequest(req, { json: true });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        if (error instanceof SyntaxError) throw makeHttpError(400, "APPEND_SYSTEM.md selection body must be valid JSON.");
        throw error;
      }
      validateAppendSystemSelectionBody(body);
      const tab = getRequestedTab(req, url, body);
      sendJson(res, 200, { ok: true, data: await saveAppendSystemSelection(tab, body) }, { "cache-control": "private, no-store" });
      return;
    }

    const samplingParametersRoute = /^\/api\/tabs\/([^/]+)\/sampling-parameters$/.exec(url.pathname);
    if (samplingParametersRoute && (req.method === "GET" || req.method === "PUT")) {
      const tabId = decodeURIComponent(samplingParametersRoute[1]);
      const tab = tabs.get(tabId);
      if (!tab) throw makeHttpError(404, `Unknown Pi tab: ${tabId}`);
      if (req.method === "GET") {
        sendJson(res, 200, { ok: true, data: await sendWebuiHelperCommand(tab, "sampling-state") }, { "cache-control": "private, no-store" });
        return;
      }
      let samplingParams;
      try {
        samplingParams = await readJsonBody(req, {
          limitBytes: SAMPLING_PARAMS_HTTP_MAX_BYTES,
          emptyError: "Sampling parameters body must be a JSON object.",
        });
      } catch (error) {
        if (error instanceof SyntaxError) throw makeHttpError(400, "Sampling parameters body must be valid JSON.");
        throw error;
      }
      const action = samplingParams && typeof samplingParams === "object" && !Array.isArray(samplingParams) && Object.keys(samplingParams).length === 0
        ? "sampling-reset"
        : "sampling-set";
      const payload = action === "sampling-set" ? { samplingParams } : {};
      sendJson(res, 200, { ok: true, data: await sendWebuiHelperCommand(tab, action, payload) }, { "cache-control": "private, no-store" });
      return;
    }

    if (url.pathname === "/api/workspaces" && req.method === "GET") {
      sendJson(res, 200, { ok: true, data: { workspaces: await listWebuiWorkspaces() } });
      return;
    }

    if (url.pathname === "/api/workspaces" && req.method === "POST") {
      if (!tabs.size) throw makeHttpError(400, "A workspace requires at least one open thread");
      const body = await readJsonBody(req);
      const descriptors = await restorableTabsForRestart();
      if (!descriptors.length) throw makeHttpError(400, "A workspace requires at least one open thread");
      let data;
      try {
        data = await saveWebuiWorkspace({
          name: body.name,
          groups: body.groups,
          activeTabId: body.activeTabId,
          overwrite: body.overwrite === true,
          tabs: descriptors,
        });
      } catch (error) {
        if (error?.code === "WORKSPACE_NAME_CONFLICT") throw makeHttpError(409, error.message);
        throw error;
      }
      broadcastServerEvent({
        type: "webui_workspace_saved",
        workspaceId: data.workspace.id,
        workspaceName: data.workspace.name,
        tabCount: data.workspace.tabCount,
        evictedIds: data.evicted.map((workspace) => workspace.id),
      });
      sendJson(res, 201, { ok: true, data });
      return;
    }

    const workspaceLoadRoute = /^\/api\/workspaces\/([^/]+)\/load$/.exec(url.pathname);
    if (workspaceLoadRoute && req.method === "POST") {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, data: await loadWebuiWorkspace(decodeURIComponent(workspaceLoadRoute[1]), body) });
      return;
    }

    if (url.pathname.startsWith("/api/workspaces/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice("/api/workspaces/".length));
      if (!id || id.includes("/")) throw makeHttpError(404, "Workspace not found");
      const data = await deleteWebuiWorkspace(id);
      if (!data) throw makeHttpError(404, "Workspace not found");
      broadcastServerEvent({ type: "webui_workspace_deleted", workspaceId: data.deletedId });
      sendJson(res, 200, { ok: true, data });
      return;
    }

    if (url.pathname === "/api/subagents" && req.method === "GET") {
      sendJson(res, 200, { ok: true, data: await webuiSubagentsData() });
      return;
    }

    if (url.pathname === "/api/subagents/output" && req.method === "GET") {
      const runId = normalizeWebuiSubagentText(url.searchParams.get("run"), 160);
      const agentId = normalizeWebuiSubagentText(url.searchParams.get("agent"), 240);
      if (!runId || !agentId) throw makeHttpError(400, "run and agent query parameters are required");
      const groupId = normalizeWebuiSubagentText(url.searchParams.get("group"), 240);
      const data = groupId
        ? await canonicalWebuiSubagentOutputData(groupId, runId, agentId)
        : await webuiSubagentOutputData(getRequestedTab(req, url), runId, agentId);
      sendJson(res, 200, { ok: true, data });
      return;
    }

    if (url.pathname === "/api/subagents/config" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await subagentLaunchSlotConfigData(tab, url.searchParams.get("scope")) });
      return;
    }

    if (url.pathname === "/api/subagents/config" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      sendJson(res, 200, { ok: true, data: await saveSubagentLaunchSlotConfigData(tab, body) });
      return;
    }

    if (url.pathname === "/api/subagents/cancel" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req);
      if (body.group) {
        sendJson(res, 200, { ok: true, data: await canonicalWebuiSubagentAction("cancel", body) });
        return;
      }
      const tab = getRequestedTab(req, url, body);
      const runId = rejectUnsupportedWebuiSubagentRun(tab, body.runId);
      sendJson(res, 200, { ok: true, data: await sendWebuiHelperCommand(tab, "subagent-cancel", { runId, reason: body.reason, note: body.note }) });
      return;
    }

    if (url.pathname === "/api/subagents/dismiss" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req);
      if (body.group) {
        sendJson(res, 200, { ok: true, data: await canonicalWebuiSubagentAction("dismiss", body) });
        return;
      }
      const tab = getRequestedTab(req, url, body);
      const runId = rejectUnsupportedWebuiSubagentRun(tab, body.runId);
      sendJson(res, 200, { ok: true, data: await sendWebuiHelperCommand(tab, "subagent-dismiss", { runId }) });
      return;
    }

    if (url.pathname === "/api/tabs" && req.method === "POST") {
      if (!optionalFeatureStartupReady) throw makeHttpError(503, "Optional feature startup audit is still checking; retry after /api/health is ready");
      const body = await readJsonBody(req);
      const freshNoProject = validateNoProjectCreateIntent(body);
      if (!freshNoProject && body.cwd) {
        const cwd = await resolveCwd(body.cwd, options.cwd);
        if ((await resolveNoProjectWorkspace(agentDir, { cwd })).workspaceKind === "no-project") {
          throw makeHttpError(400, "Use workspaceKind: no-project to create a fresh owned conversation; resume existing conversations through session selection");
        }
      }
      const tab = await createTab({ title: body.title, cwd: body.cwd, freshNoProject });
      sendJson(res, 201, { ok: true, data: { tab: tabMeta(tab), tabs: listTabs() } });
      return;
    }

    if (url.pathname === "/api/tabs/close" && req.method === "POST") {
      const body = await readJsonBody(req);
      const closed = await closeTabs(body.ids || body.tabIds || [], { allowEmpty: body.allowEmpty === true });
      sendJson(res, 200, { ok: true, data: { closedIds: closed.map((tab) => tab.id), tabs: listTabs(), activeTabId: firstTab()?.id || null } });
      return;
    }

    // Reopen a recently closed tab (same cwd, title, and persisted session) — the server-side
    // record is used so clients cannot point Pi at arbitrary session files.
    if (url.pathname === "/api/tabs/reopen" && req.method === "POST") {
      const body = await readJsonBody(req);
      const wanted = String(body.id || "").trim();
      const index = closedRestorableTabs.findIndex((item) => item.id === wanted);
      if (!wanted || index === -1) throw makeHttpError(404, "That closed thread can no longer be reopened");
      const descriptor = closedRestorableTabs[index];
      const tab = await createTab({
        title: descriptor.titleSource === "explicit" || descriptor.titleSource === "auto" ? descriptor.title : undefined,
        titleSource: descriptor.titleSource,
        conversationStarted: descriptor.conversationStarted,
        cwd: descriptor.cwd,
        workspaceKind: descriptor.workspaceKind,
        noProjectId: descriptor.noProjectId,
        sessionFile: descriptor.sessionFile,
      });
      closedRestorableTabs.splice(index, 1);
      sendJson(res, 201, { ok: true, data: { tab: tabMeta(tab), tabs: listTabs() } });
      return;
    }

    if (url.pathname.startsWith("/api/tabs/") && req.method === "PATCH") {
      const id = decodeURIComponent(url.pathname.slice("/api/tabs/".length));
      const body = await readJsonBody(req);
      const { tab, changed } = await updateTabCwd(id, body.cwd);
      sendJson(res, 200, { ok: true, data: { tab: tabMeta(tab), tabs: listTabs(), changed } });
      return;
    }

    if (url.pathname.startsWith("/api/tabs/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice("/api/tabs/".length));
      await closeTab(id);
      sendJson(res, 200, { ok: true, data: { tabs: listTabs(), activeTabId: firstTab()?.id || null } });
      return;
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      const resolvedDefault = resolvedOutputModeDefault();
      const negotiated = negotiateOutputMode({
        requestedMode: url.searchParams.get("outputMode"),
        protocolVersion: url.searchParams.get("outputModeProtocol"),
        serverDefault: resolvedDefault.mode,
      });
      const client = {
        res,
        tab,
        requestedMode: negotiated.requestedMode,
        protocolVersion: negotiated.protocolVersion,
        activeMode: negotiated.activeMode,
        pendingMode: undefined,
        defaultSource: resolvedDefault.source,
      };
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
      });
      res.write(": connected\n\n");
      tab.sseClients.add(client);
      sendSseToClient(client, {
        type: "webui_connected",
        version: packageJson.version,
        piVersion: String(piPackageJson.version || ""),
        webuiDev: webuiDevServer,
        webuiMode: webuiDevServer ? "dev" : "production",
        outputMode: {
          protocolVersion: negotiated.protocolVersion,
          requestedMode: negotiated.requestedMode,
          activeMode: negotiated.activeMode,
          serverDefault: resolvedDefault.mode,
          serverDefaultSource: resolvedDefault.source,
        },
        tabId: tab.id,
        tabTitle: tab.title,
        pid: tab.rpc.child?.pid,
        cwd: tab.cwd,
        startedAt: tab.rpc.startedAt,
        tabActivity: tabActivitySnapshot(tab),
        pendingExtensionUiRequestCount: pendingExtensionUiRequests(tab).length,
        activeRun: publicAppRunnerState(tab.appRunner),
        ...rpcSupervisorBrowserState(),
      });
      if (rpcSupervisor) {
        sendSseToClient(client, {
          type: "webui_supervisor_reconnected",
          tabId: tab.id,
          tabTitle: tab.title,
          ...rpcSupervisorBrowserState(),
        });
        if (rpcSupervisorSnapshot?.gap === true) {
          sendSseToClient(client, {
            type: "webui_supervisor_replay_gap",
            tabId: tab.id,
            tabTitle: tab.title,
            ...rpcSupervisorBrowserState(),
          });
        }
      }
      replayExtensionStatuses(tab, client);
      replayExtensionWidgets(tab, client);
      replayGitWorkflowFallbackLifecycle(tab, client);
      if (tab.sessionSummary) {
        sendSseToClient(client, {
          type: "webui_session_summary",
          kind: "replay",
          tabId: tab.id,
          tabTitle: tab.title,
          summary: publicSessionSummaryState(tab),
          replayed: true,
        });
      }
      replayPendingExtensionUiRequests(tab, client);
      const keepAlive = setInterval(() => writeSseFrame(client, ": keepalive\n\n"), 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        evictSlowSseClient(client);
      });
      return;
    }

    if (url.pathname === "/api/health" && req.method === "GET") {
      const status = await webuiStatus({ includeAuthPin: isLocalRequest(req) });
      sendJson(res, optionalFeatureStartupReady ? 200 : 503, {
        ok: optionalFeatureStartupReady,
        bootIdentity,
        startupPhase: optionalFeatureAuditCoordinator.current().phase,
        webuiVersion: status.webuiVersion,
        piVersion: status.piVersion,
        webuiDev: status.webuiDev,
        webuiMode: status.webuiMode,
        webuiPid: status.webuiPid,
        piPid: status.piPid,
        piRunning: status.piRunning,
        cwd: status.cwd,
        outputMode: status.outputMode,
        network: status.network,
        rpcSupervisor: status.rpcSupervisor,
        tabs: status.tabs,
        restorableTabs: status.restorableTabs,
      });
      return;
    }

    if (url.pathname === "/api/pi-release-notes" && req.method === "GET") {
      sendJson(res, 200, { ok: true, data: await piReleaseNotes() }, { "cache-control": "private, no-store" });
      return;
    }

    if (url.pathname === "/api/webui-status" && req.method === "GET") {
      const detailed = ["1", "true", "yes", "detailed"].includes(String(url.searchParams.get("detailed") || "").toLowerCase());
      const parsedEventLimit = Number.parseInt(url.searchParams.get("events") || "40", 10);
      const eventLimit = Number.isFinite(parsedEventLimit) ? parsedEventLimit : 40;
      sendJson(res, 200, { ok: true, data: await webuiStatus({ detailed, eventLimit, includeAuthPin: isLocalRequest(req) }) });
      return;
    }

    if (url.pathname === "/api/update-status" && req.method === "GET") {
      const force = ["1", "true", "yes", "refresh"].includes(String(url.searchParams.get("refresh") || "").toLowerCase());
      const status = await getUpdateStatus({ force });
      sendJson(res, 200, { ok: true, data: await updateStatusForRequest(status, req) });
      return;
    }

    if (url.pathname === "/api/native-parity" && req.method === "GET") {
      sendJson(res, 200, { ok: true, data: nativeParityMatrix });
      return;
    }

    const artifactRoute = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/(manifest|download|page\/(\d+))$/);
    if (artifactRoute && req.method === "GET") {
      const token = decodeURIComponent(artifactRoute[1]), record = documentArtifactRecord(req, url, token), tabQuery = `tab=${encodeURIComponent(record.tabId)}`;
      if (artifactRoute[2] === "manifest") {
        sendJson(res, 200, { ok: true, data: { artifact: publicDocumentArtifact(record), ...record.manifest, pages: record.pages.map(({ path: _path, ...page }) => ({ ...page, imageUrl: `/api/artifacts/${encodeURIComponent(token)}/page/${page.pageNum}?${tabQuery}` })) } }, { "cache-control": "private, no-store" });
        return;
      }
      if (artifactRoute[2] === "download") {
        if (!record.downloadPath) throw makeHttpError(404, "Artifact download is unavailable");
        await sendDocumentArtifactFile(req, res, record.downloadPath, { contentType: record.mimeType, fileName: record.title });
        return;
      }
      const pageNum = Number(artifactRoute[3]), page = record.pages.find((item) => item.pageNum === pageNum);
      if (!page) throw makeHttpError(404, "Artifact page is unavailable");
      await sendDocumentArtifactFile(req, res, page.path, { contentType: "image/png", fileName: `page-${pageNum}.png`, inline: true });
      return;
    }

    if (url.pathname.startsWith("/api/native-download/") && req.method === "GET") {
      await sendNativeDownload(res, decodeURIComponent(url.pathname.slice("/api/native-download/".length)), {
        inline: url.searchParams.get("disposition") === "inline",
      });
      return;
    }

    if (url.pathname === "/api/themes" && req.method === "GET") {
      const tab = tabs.size ? getRequestedTab(req, url) : null;
      sendJson(res, 200, { ok: true, data: await readThemeCatalog(tab) });
      return;
    }

    if (url.pathname === "/api/themes/custom" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      requireCustomThemeJsonRequest(req);
      let body;
      try {
        body = await readJsonBody(req, { limitBytes: CUSTOM_THEME_BODY_LIMIT_BYTES });
      } catch (error) {
        if (error instanceof SyntaxError) throw themeHttpError(400, "THEME_JSON_INVALID", "Custom theme save body contains malformed JSON.");
        throw error;
      }
      const tab = getRequestedTab(req, url);
      const request = validateCustomThemeSaveBody(body);
      const data = await saveCustomTheme(tab, request);
      sendJson(res, data.created ? 201 : 200, { ok: true, data });
      return;
    }

    if (url.pathname === "/api/codex-usage" && req.method === "GET") {
      try {
        const forceRefresh = ["1", "true", "yes"].includes(String(url.searchParams.get("refresh") || "").toLowerCase());
        sendJson(res, 200, { ok: true, data: await getOpenAICodexUsageStatus({ forceRefresh }) });
      } catch (error) {
        sendJson(res, error?.statusCode || 500, { ok: false, error: error?.message || "Failed to read OpenAI Codex usage" });
      }
      return;
    }

    if (url.pathname === "/api/claude-usage" && req.method === "GET") {
      try {
        sendJson(res, 200, { ok: true, data: await getClaudeCodeUsageStatus() });
      } catch (error) {
        sendJson(res, error?.statusCode || 500, { ok: false, error: error?.message || "Failed to read Claude usage" });
      }
      return;
    }

    if (url.pathname === "/api/network" && req.method === "GET") {
      sendJson(res, 200, { ok: true, data: networkStatus({ includeAuthPin: isLocalRequest(req) }) });
      return;
    }

    if (url.pathname === "/api/network/qr" && req.method === "GET") {
      requireLocalhost(req, "Remote QR generation is only allowed from localhost");
      sendJson(res, 200, { ok: true, data: await remoteNetworkQrPayload() });
      return;
    }

    if (url.pathname === "/api/network/open" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const before = networkStatus({ includeAuthPin: true });
      const shouldOpen = !before.open && !networkRebindInProgress;
      sendJson(res, 202, { ok: true, data: { ...before, opening: shouldOpen || before.opening, closing: before.closing } }, { connection: "close" });
      if (shouldOpen) {
        setTimeout(() => openToLocalNetwork().catch((error) => console.error("network open failed:", sanitizeError(error))), NETWORK_REBIND_DELAY_MS).unref();
      }
      return;
    }

    if (url.pathname === "/api/network/close" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const before = networkStatus({ includeAuthPin: true });
      const shouldClose = before.open && !networkRebindInProgress;
      sendJson(res, 202, { ok: true, data: { ...before, opening: before.opening, closing: shouldClose || before.closing } }, { connection: "close" });
      if (shouldClose) {
        setTimeout(() => closeNetworkAccess().catch((error) => console.error("network close failed:", sanitizeError(error))), NETWORK_REBIND_DELAY_MS).unref();
      }
      return;
    }

    if (url.pathname === "/api/restart" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const releaseAdmittedWork = nativeAdmittedWork.begin();
      try {
        await assertNativeMutationAdmission();
        const restorableTabs = await restorableTabsForRestart();
        const supervisorCursor = await prepareRpcSupervisorHandoff();
        await assertNativeMutationAdmission();
        const child = await spawnRestartServer(restorableTabs, supervisorCursor);
        sendJson(res, 200, { ok: true, message: "Pi Web UI restarting", webuiPid: process.pid, nextWebuiPid: child.pid, restorableTabCount: restorableTabs.length });
        setTimeout(() => { void shutdown("api restart", { preserveSessions: true }); }, 20).unref();
        return;
      } finally { releaseAdmittedWork(); }
    }

    if (url.pathname === "/api/update/startup-probe" && req.method === "GET" && process.env.PI_WEBUI_STARTUP_PROBE === "1") {
      requireLocalhostRoute(req, url.pathname);
      if (!startupProbeReady) throw makeHttpError(503, "Startup and tab restoration have not completed.");
      sendJson(res, 200, { ok: true, data: { schemaVersion: 1, packageName: WEBUI_PACKAGE, version: packageJson.version,
        bootIdentity, restoredTabCount: restoreTabs.length, runningTabCount: tabs.size,
        restoredProbeTabHealthy: tabs.get("probe-tab")?.rpc.isRunning() === true && Boolean(tabs.get("probe-tab")?.lastState) } });
      return;
    }

    if (url.pathname === "/api/update/plan" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      if (process.env.PI_WEBUI_STARTUP_PROBE === "1") throw makeHttpError(409, "Isolated startup probes cannot plan updates.");
      const validation = validateUpdatePlanRequest(await readJsonBody(req));
      if (!validation.ok) throw makeHttpError(400, validation.error);
      const plan = await packageUpdates.plan(validation.targets[0]);
      sendJson(res, 201, { ok: true, data: { plan } });
      return;
    }

    if (url.pathname === "/api/update/apply" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      if (process.env.PI_WEBUI_STARTUP_PROBE === "1") throw makeHttpError(409, "Isolated startup probes cannot apply updates.");
      const validation = validateUpdateApplyRequest(await readJsonBody(req));
      if (!validation.ok) throw makeHttpError(400, validation.error);
      const data = packageUpdates.apply(validation.transactionId, validation.planDigest);
      sendJson(res, 202, { ok: true, data });
      return;
    }

    const updateTransactionRoute = url.pathname.match(/^\/api\/update\/transactions\/([A-Za-z0-9._-]{1,128})$/);
    if (updateTransactionRoute && req.method === "GET") {
      requireLocalhost(req, "Viewing update transactions is only allowed from localhost");
      const simpleJob = packageUpdates.getJob(updateTransactionRoute[1]);
      const job = simpleJob || await finalizeNativeJob(updateTransactionRoute[1]);
      if (!job) throw makeHttpError(404, "Update job was not found.");
      sendJson(res, 200, { ok: true, data: simpleJob || publicNativeJob(job) });
      return;
    }

    if (url.pathname === "/api/update/rollback" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      throw makeHttpError(410, "Native package-manager updates cannot be rolled back by switching a managed runtime pointer.");
    }

    if ((url.pathname === "/api/component-update" || url.pathname === "/api/update") && req.method === "POST") {
      throw makeHttpError(410, "Legacy update mutation is disabled. Create an exact server-owned plan and apply its transactionId plus planDigest.");
    }

    if (url.pathname === "/api/shutdown" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      sendJson(res, 200, { ok: true, message: "Pi Web UI shutting down", webuiPid: process.pid });
      setTimeout(() => { void shutdown("api shutdown", { preserveSessions: false }); }, 20).unref();
      return;
    }

    if (url.pathname === "/api/workspace" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, {
        ok: true,
        data: await getWorkspaceInfo(tab.cwd, tab.rpc.startedAt),
      });
      return;
    }

    if (url.pathname === "/api/app-runners" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getAppRunnerData(tab) });
      return;
    }

    if (url.pathname === "/api/app-runner" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "app runner actions are blocked");
      sendJson(res, 200, { ok: true, data: await startAppRunner(tab, String(body.runnerId || body.id || "")) });
      return;
    }

    if (url.pathname === "/api/app-runner/input" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "app runner actions are blocked");
      const text = Object.prototype.hasOwnProperty.call(body, "text") ? body.text : body.input;
      sendJson(res, 200, { ok: true, data: sendAppRunnerInput(tab, text, { appendNewline: body.newline !== false, closeStdin: body.closeStdin === true || body.close === true }) });
      return;
    }

    if (url.pathname === "/api/app-runner/context" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "app runner actions are blocked");
      sendJson(res, 200, { ok: true, data: await transferAppRunnerContext(tab, body) });
      return;
    }

    if (url.pathname === "/api/app-runner/stop" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "app runner actions are blocked");
      stopAppRunnerForTab(tab, "stop requested from Web UI");
      sendJson(res, 200, { ok: true, data: await getAppRunnerData(tab) });
      return;
    }

    if (url.pathname === "/api/app-runner/clear" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "app runner actions are blocked");
      clearAppRunnerForTab(tab);
      sendJson(res, 200, { ok: true, data: await getAppRunnerData(tab) });
      return;
    }

    if (url.pathname === "/api/app-runner-config" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getCustomAppRunnerConfigData(tab) });
      return;
    }

    if (url.pathname === "/api/app-runner-config" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "app runner configuration changes are blocked");
      if (Object.prototype.hasOwnProperty.call(body, "searchPaths")) {
        if (body.runner !== undefined) throw makeHttpError(400, "Choose either a custom runner or searchPaths for this mutation");
        sendJson(res, 200, { ok: true, data: await saveAppRunnerSearchPaths(tab, body.searchPaths) });
      } else {
        sendJson(res, 200, { ok: true, data: await saveCustomAppRunner(tab, body.runner || body) });
      }
      return;
    }

    if (url.pathname === "/api/app-runner-config" && req.method === "DELETE") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "app runner configuration changes are blocked");
      sendJson(res, 200, { ok: true, data: await deleteCustomAppRunner(tab, body.id || body.runnerId) });
      return;
    }

    if (url.pathname === "/api/app-runner-files" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getAppRunnerFileBrowserData(tab, url.searchParams.get("path")) });
      return;
    }

    if (url.pathname === "/api/directories" && req.method === "GET") {
      const activeCwd = directoryPickerActiveCwd(req, url);
      sendJson(res, 200, {
        ok: true,
        data: await getDirectoryPickerData(url.searchParams.get("path"), activeCwd),
      });
      return;
    }

    if (url.pathname === "/api/directories" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = optionalRequestedTab(req, url, body);
      if (tab) ensureNaturalConversationRouteAllowed(tab, "directory creation is blocked");
      const activeCwd = directoryPickerActiveCwd(req, url, body);
      sendJson(res, 201, {
        ok: true,
        data: await createDirectoryPickerDirectory(body.parent ?? body.cwd ?? body.path, body.name, activeCwd),
      });
      return;
    }

    if (url.pathname === "/api/path-suggestions" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getPathSuggestionData(tab, url.searchParams.get("query")) });
      return;
    }

    if (url.pathname === "/api/bang-suggestions" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getBangSuggestionData(tab, url.searchParams.get("query")) });
      return;
    }

    if (url.pathname === "/api/path-fast-picks" && req.method === "GET") {
      sendJson(res, 200, { ok: true, data: { picks: await readPathFastPicks() } });
      return;
    }

    if (url.pathname === "/api/path-fast-picks" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = optionalRequestedTab(req, url, body);
      if (tab) ensureNaturalConversationRouteAllowed(tab, "path fast-pick changes are blocked");
      const picks = await writePathFastPicks(body.picks ?? body);
      sendJson(res, 200, { ok: true, data: { picks } });
      return;
    }

    if (url.pathname === "/api/files" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getFileTreeData(tab, url.searchParams.get("path") || "") });
      return;
    }

    if (url.pathname === "/api/files" && req.method === "DELETE") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "file deletion is blocked");
      sendJson(res, 200, { ok: true, data: await deleteFileSystemEntryData(tab, body) });
      return;
    }

    if (url.pathname === "/api/files/create" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "file creation is blocked");
      sendJson(res, 201, { ok: true, data: await createFileSystemEntryData(tab, body) });
      return;
    }

    if (url.pathname === "/api/files/move" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "file moves are blocked");
      sendJson(res, 200, { ok: true, data: await moveFileSystemEntryData(tab, body) });
      return;
    }

    if (url.pathname === "/api/files/search" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getFileSearchData(tab, url.searchParams.get("q") || url.searchParams.get("query") || "") });
      return;
    }

    if (url.pathname === "/api/aur-review/report-content" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, {
        ok: true,
        data: await getAurReviewReportContentData(tab, {
          path: url.searchParams.get("path") || "",
          repoRoot: url.searchParams.get("repoRoot") || "",
        }),
      });
      return;
    }

    if (url.pathname === "/api/files/content" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getFileContentData(tab, url.searchParams.get("path") || "") });
      return;
    }

    if (url.pathname === "/api/files/content" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req, { limitBytes: requestBodyLimitForPath(url.pathname) });
      const tab = getRequestedTab(req, url, body);
      if (isNaturalConversationActive(tab)) throw makeHttpError(409, "file edits are blocked");
      sendJson(res, 200, { ok: true, data: await saveFileContentData(tab, body) });
      return;
    }

    if (url.pathname === "/api/files/open-default" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      sendJson(res, 200, { ok: true, data: await openPathInDefaultEditor(tab, body.path || body.filePath || "") });
      return;
    }

    if (url.pathname === "/api/attachments" && req.method === "POST") {
      const body = await readJsonBody(req, { limitBytes: requestBodyLimitForPath(url.pathname) });
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "attachment uploads are blocked");
      sendJson(res, 201, { ok: true, data: await saveUploadedAttachments(body) });
      return;
    }

    if (url.pathname === "/api/scoped-models" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getScopedModelData(tab) });
      return;
    }

    if (url.pathname === "/api/model-cycle" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "model changes are blocked");
      const response = await cycleTabModel(tab, body.direction || body.mode);
      sendJson(res, response.success === false ? 400 : 200, responseWithTab(response, tab));
      return;
    }

    if (url.pathname === "/api/fork-messages" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getForkMessagesData(tab) });
      return;
    }

    if (url.pathname === "/api/intercom/conversations" && req.method === "GET") {
      if (!requestedTabId(req, url)) throw makeHttpError(400, "tab is required");
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getIntercomConversationsData(tab, requestedIntercomConversationId(url)) }, { "cache-control": "private, no-store" });
      return;
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getSessionSelectorData(tab, url.searchParams.get("scope") || "current") });
      return;
    }

    if (url.pathname === "/api/session-tree" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getSessionTreeData(tab) });
      return;
    }

    if (url.pathname === "/api/fork" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "session fork actions are blocked");
      const response = await runForkCommand(tab, body.entryId);
      sendJson(res, response.success === false ? 400 : 200, response);
      return;
    }

    if (url.pathname === "/api/clone" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "session clone actions are blocked");
      const response = await runCloneCommand(tab);
      sendJson(res, response.success === false ? 400 : 200, responseWithTab(response, tab));
      return;
    }

    if (url.pathname === "/api/switch-session" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "session switching is blocked");
      const response = await resumeSessionInNewTab(tab, body.sessionPath || body.path);
      sendJson(res, response.success === false ? 400 : 200, response);
      return;
    }

    if (url.pathname === "/api/session-rename" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "session renaming is blocked");
      sendJson(res, 200, { ok: true, data: await renameSessionData(tab, body), tab: tabMeta(tab) });
      return;
    }

    if (url.pathname === "/api/session-delete" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "session deletion is blocked");
      sendJson(res, 200, { ok: true, data: await deleteSessionData(tab, body), tab: tabMeta(tab) });
      return;
    }

    if (url.pathname === "/api/auth-providers" && req.method === "GET") {
      sendJson(res, 200, { ok: true, data: await getAuthProvidersData() });
      return;
    }

    if (url.pathname === "/api/auth-logout" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, data: await logoutAuthProviderData(body) });
      return;
    }

    if (url.pathname === "/api/tree-navigate" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "session tree navigation is blocked");
      const response = await navigateSessionTree(tab, body);
      sendJson(res, response.success === false ? 400 : 200, responseWithTab(response, tab));
      return;
    }

    if (url.pathname === "/api/features/natural-conversation" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await naturalConversationFeatureData(tab) });
      return;
    }

    if (url.pathname === "/api/conversation-mode" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await naturalConversationFeatureData(tab) });
      return;
    }

    if (url.pathname === "/api/conversation-mode" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      sendJson(res, 200, { ok: true, data: await setNaturalConversationMode(tab, body), tab: tabMeta(tab) });
      return;
    }

    if (url.pathname === "/api/codex-fast-mode" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await codexFastModeFeatureData(tab), tab: tabMeta(tab) });
      return;
    }

    if (url.pathname === "/api/codex-fast-mode" && req.method === "PUT") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      sendJson(res, 200, { ok: true, data: await setCodexFastMode(tab, body), tab: tabMeta(tab) });
      return;
    }

    if (url.pathname === "/api/conversation-voices" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await conversationVoicesData(), tab: tabMeta(tab) });
      return;
    }

    if (url.pathname === "/api/conversation-voice" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      sendJson(res, 200, { ok: true, data: await setConversationVoice(tab, body), tab: tabMeta(tab) });
      return;
    }

    if (url.pathname === "/api/stt/transcribe" && req.method === "POST") {
      const body = await readJsonBody(req, { limitBytes: VOICE_AUDIO_JSON_BODY_LIMIT_BYTES });
      const tab = getRequestedTab(req, url, body);
      try {
        sendJson(res, 200, { ok: true, data: await handleNaturalConversationSttTranscribe(req, tab, body) });
      } catch (error) {
        const statusCode = error?.statusCode || 500;
        sendJson(res, statusCode, { ok: false, feature_unavailable: statusCode === 501, data: naturalConversationUnavailableResponse(tab, "stt"), voice: error?.voice || naturalConversationVoiceProviderStatus("stt"), error: statusCode >= 500 ? sanitizeError(error) : formatCliError(error) });
      }
      return;
    }

    if (url.pathname === "/api/tts/speech" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      try {
        sendJson(res, 200, { ok: true, data: await handleNaturalConversationTtsSpeech(req, tab, body) });
      } catch (error) {
        const statusCode = error?.statusCode || 500;
        sendJson(res, statusCode, { ok: false, feature_unavailable: statusCode === 501, data: naturalConversationUnavailableResponse(tab, "tts"), voice: error?.voice || naturalConversationVoiceProviderStatus("tts"), error: statusCode >= 500 ? sanitizeError(error) : formatCliError(error) });
      }
      return;
    }

    if (url.pathname === "/api/optional-features" && req.method === "GET") {
      sendJson(res, 200, { ok: true, data: optionalFeatureAuditCoordinator.current() });
      return;
    }

    if (url.pathname === "/api/optional-feature-install" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "optional feature installs are blocked");
      await assertNativeMutationAdmission();
      const revision = optionalFeatureAuditCoordinator.current().revision;
      const data = await optionalFeatureAuditCoordinator.runMutation(revision, async () => {
        try {
          return await installOptionalFeaturePackage(String(body.featureId || ""), tab.cwd);
        } finally {
          await optionalFeatureAuditCoordinator.recheck({ reason: "post-install" });
        }
      });
      sendJson(res, 200, { ok: true, data });
      return;
    }

    if (url.pathname === "/api/optional-feature-install-batch" && req.method === "POST") {
      requireLocalhost(req, "Installing optional Web UI features is only allowed from localhost");
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "optional feature installs are blocked");
      await assertNativeMutationAdmission();
      const data = await runOptionalFeatureBatchMutation({
        revision: body.revision,
        featureIds: body.featureIds,
        cwd: tab.cwd,
        migration: body.migration === true,
        tab,
        install: () => installOptionalFeaturePackages(body.featureIds, tab.cwd),
      });
      sendJson(res, 200, { ok: true, data });
      return;
    }

    if (url.pathname === "/api/optional-feature-migration/recheck" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      await readJsonBody(req);
      optionalFeatureAuditCoordinator.assertIdle();
      const data = await optionalFeatureAuditCoordinator.recheck({ reason: "manual" });
      sendJson(res, 200, { ok: true, data });
      return;
    }

    if (url.pathname === "/api/optional-feature-migration/dismiss" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req);
      const data = await optionalFeatureAuditCoordinator.dismiss(body.revision);
      sendJson(res, 200, { ok: true, data });
      return;
    }

    if (url.pathname === "/api/tools" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getToolConfigData(tab, url.searchParams.get("scope"), url.searchParams) });
      return;
    }

    if (url.pathname === "/api/tools" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      if (isNaturalConversationActive(tab)) blockNaturalConversationAction("tool configuration changes are blocked");
      sendJson(res, 200, { ok: true, data: await setToolConfigData(tab, body) });
      return;
    }

    if (url.pathname === "/api/skills" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getSkillConfigData(tab, url.searchParams.get("scope"), url.searchParams) });
      return;
    }

    if (url.pathname === "/api/skills" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "skill configuration changes are blocked");
      sendJson(res, 200, { ok: true, data: await setSkillConfigData(tab, body) });
      return;
    }

    if (url.pathname === "/api/skill-file" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await getSkillFileData(tab, { name: url.searchParams.get("name"), path: url.searchParams.get("path") }) });
      return;
    }

    if (url.pathname === "/api/skill-file" && req.method === "POST") {
      requireLocalhostRoute(req, url.pathname);
      const body = await readJsonBody(req, { limitBytes: SKILL_FILE_BODY_LIMIT_BYTES });
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "skill file edits are blocked");
      sendJson(res, 200, { ok: true, data: await saveSkillFileData(tab, body) });
      return;
    }

    if (url.pathname === "/api/safety-guard/config" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: await safetyGuardConfigData(tab) });
      return;
    }

    if (url.pathname === "/api/safety-guard/config" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "safety guard setup changes are blocked");
      sendJson(res, 200, { ok: true, data: await saveSafetyGuardConfigData(tab, body) });
      return;
    }

    if (url.pathname === "/api/git-workflow/preferences" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      const includeModels = url.searchParams.get("includeModels") !== "false";
      sendJson(res, 200, { ok: true, data: await gitWorkflowPreferencesData(tab, { includeModels }) });
      return;
    }

    if (url.pathname === "/api/git-workflow/launch-admission" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      sendJson(res, 200, { ok: true, data: await authoritativeGuidedGitLaunchAdmission(tab) });
      return;
    }

    if (url.pathname === "/api/git-workflow/preferences" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "guided Git setup changes are blocked");
      sendJson(res, 200, { ok: true, data: await saveGitWorkflowPreferencesData(tab, body) });
      return;
    }

    if (url.pathname === "/api/git-workflow/generate" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "guided Git generation is blocked");
      sendJson(res, 200, { ok: true, data: await startGitWorkflowGeneration(tab, body) });
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { ok: true, data: nativeSettingsPayload(settingsManagerForTab(tab)) });
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "settings changes are blocked");
      sendJson(res, 200, { ok: true, data: await setNativeSettingsData(tab, body) });
      return;
    }

    if (url.pathname === "/api/commands" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      sendJson(res, 200, { type: "response", command: "get_commands", success: true, data: await getCommandData(tab) });
      return;
    }

    if (url.pathname === "/api/action-feedback" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "feedback-learning prompts are blocked");
      const response = await handleActionFeedback(tab, body);
      sendJson(res, response.success === false ? 400 : 200, response);
      return;
    }

    if (url.pathname === "/api/queue/remove" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      const data = await sendWebuiHelperCommand(tab, "queue-remove", {
        kind: body.kind || "followUp",
        index: body.index,
        message: body.message,
      });
      sendJson(res, 200, { ok: true, data });
      return;
    }

    if (url.pathname === "/api/queue/mutate" && req.method === "POST") {
      const body = await readJsonBody(req, { limitBytes: requestBodyLimitForPath(url.pathname) });
      const tab = getRequestedTab(req, url, body);
      const request = queueMutationRequest(body);
      const data = request.source === "webui-compaction"
        ? mutateCompactionFollowUpQueue(tab, request)
        : await sendWebuiHelperCommand(tab, "queue-mutate", request);
      const conflict = data?.mutated === false && ["queue-changed", "queue-desynchronized", "queue-draining"].includes(data.reason);
      const status = data?.mutated === true ? 200 : conflict ? 409 : 400;
      sendJson(res, status, { ok: data?.mutated === true, data });
      return;
    }

    if (url.pathname === "/api/prompt" && req.method === "POST") {
      const body = await readJsonBody(req, { limitBytes: requestBodyLimitForPath(url.pathname) });
      const tab = getRequestedTab(req, url, body);
      const result = await deduplicateBrowserPromptRequest(tab, body, () => handlePromptRequest(tab, body, req));
      sendJson(res, result.status, result.payload);
      return;
    }

    if (url.pathname === "/api/git-changes" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      try {
        sendJson(res, 200, { ok: true, data: await readGitChanges(tab.cwd) });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: sanitizeError(error) });
      }
      return;
    }

    if (url.pathname === "/api/git-file-diff" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      try {
        const data = await readGitFileDiff(tab.cwd, url.searchParams.get("path") || "", url.searchParams.get("category") || "");
        trackGitRepositoryForTab(tab, data.root);
        sendJson(res, 200, { ok: true, data });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: sanitizeError(error) });
      }
      return;
    }

    if (url.pathname === "/api/git-root" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      try {
        const root = trackGitRepositoryForTab(tab, await getGitRoot(tab.cwd));
        sendJson(res, 200, { ok: true, data: { cwd: tab.cwd, root } });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: sanitizeError(error) });
      }
      return;
    }

    if (url.pathname === "/api/git-panel" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      try {
        const data = await readGitPanel(tab.cwd);
        trackGitRepositoryForTab(tab, data.root);
        sendJson(res, 200, { ok: true, data });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: sanitizeError(error) });
      }
      return;
    }

    if (url.pathname === "/api/git-commit" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      try {
        sendJson(res, 200, { ok: true, data: await readGitCommit(tab.cwd, url.searchParams.get("hash") || "") });
      } catch (error) {
        const statusCode = Number(error?.statusCode || error?.status || 200) || 200;
        sendJson(res, statusCode, { ok: false, error: sanitizeError(error) });
      }
      return;
    }

    if (url.pathname === "/api/git-changes/untracked-file" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      try {
        sendJson(res, 200, { ok: true, data: await readGitUntrackedFile(tab.cwd, url.searchParams.get("path") || "") });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: sanitizeError(error) });
      }
      return;
    }

    if (url.pathname === "/api/git-changes/pull" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "git pull is blocked");
      try {
        sendJson(res, 200, await pullGitChanges(tab.cwd, { remote: body?.remote }));
      } catch (error) {
        sendJson(res, 200, { ok: false, error: sanitizeError(error) });
      }
      return;
    }

    if (url.pathname === "/api/git-worktrees" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      try {
        sendJson(res, 200, { ok: true, data: await listGitWorktrees(tab.cwd) });
      } catch (error) {
        sendGitWorktreeFailure(res, error);
      }
      return;
    }

    if (url.pathname === "/api/git-worktrees" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "git worktree changes are blocked");
      try {
        sendJson(res, 200, { ok: true, data: await createGitWorktreeTab(tab, body) });
      } catch (error) {
        sendGitWorktreeFailure(res, error);
      }
      return;
    }

    if (url.pathname === "/api/git-worktrees/open" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "git worktree changes are blocked");
      try {
        sendJson(res, 200, { ok: true, data: await openExistingGitWorktreeTab(tab, body) });
      } catch (error) {
        sendGitWorktreeFailure(res, error);
      }
      return;
    }

    if (url.pathname === "/api/git-worktrees" && req.method === "DELETE") {
      requireLocalhost(req, "Removing Git worktrees is only allowed from localhost");
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "git worktree removal is blocked");
      try {
        sendJson(res, 200, { ok: true, data: await removeGitWorktreeForTab(tab, body) });
      } catch (error) {
        sendGitWorktreeFailure(res, error);
      }
      return;
    }

    if (url.pathname === "/api/git-branches" && req.method === "GET") {
      const tab = getRequestedTab(req, url);
      try {
        sendJson(res, 200, { ok: true, data: await readGitBranches(tab.cwd) });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: sanitizeError(error) });
      }
      return;
    }

    if (url.pathname === "/api/git-branch" && req.method === "POST") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      ensureNaturalConversationRouteAllowed(tab, "git branch changes are blocked");
      try {
        const remoteRef = requestedRemoteRef(body);
        sendJson(res, 200, await switchGitBranch(tab.cwd, body.branch, { create: body.create === true, remoteRef }));
      } catch (error) {
        sendJson(res, 200, { ok: false, error: sanitizeError(error) });
      }
      return;
    }

    {
      const gitActionError = (error) => {
        sendJson(res, error?.statusCode || 200, { ok: false, ...(error?.code ? { code: error.code } : {}), error: sanitizeError(error) });
      };
      const GIT_READ_ROUTES = {
        "/api/git-operation": (cwd) => readGitOperationSnapshot(cwd),
        "/api/git-stash": (cwd) => readGitStashes(cwd),
        "/api/git-stash/show": (cwd) => readGitStashPreview(cwd, url.searchParams.get("ref") || ""),
        "/api/git-undo": (cwd) => readGitUndoState(cwd),
        "/api/git-reflog": (cwd) => readGitReflog(cwd),
        "/api/git-submodules": (cwd) => readGitSubmodules(cwd),
        "/api/git-tags": (cwd) => readGitTags(cwd),
        "/api/git-signing": (cwd) => readGitSigningDiagnostics(cwd),
        "/api/git-worktrees/prune": (cwd) => pruneGitWorktreesData(cwd),
      };
      if (req.method === "GET" && GIT_READ_ROUTES[url.pathname]) {
        const tab = getRequestedTab(req, url);
        try {
          sendJson(res, 200, { ok: true, data: await GIT_READ_ROUTES[url.pathname](tab.cwd) });
        } catch (error) {
          gitActionError(error);
        }
        return;
      }

      const GIT_MUTATION_ROUTES = {
        "/api/git-fetch": (cwd) => fetchGitChanges(cwd),
        "/api/git-changes/integrate": (cwd, body) => integrateGitUpstream(cwd, body),
        "/api/git-changes/stage-file": (cwd, body) => stageGitFile(cwd, body),
        "/api/git-changes/unstage-file": (cwd, body) => unstageGitFile(cwd, body),
        "/api/git-changes/stage-all": (cwd) => stageAllGitChanges(cwd),
        "/api/git-changes/unstage-all": (cwd) => unstageAllGitChanges(cwd),
        "/api/git-changes/discard-file": (cwd, body) => discardGitFile(cwd, body),
        "/api/git-changes/delete-untracked": (cwd, body) => deleteGitUntrackedFile(cwd, body),
        "/api/git-changes/add-to-gitignore": (cwd, body) => addGitignoreEntry(cwd, body),
        "/api/git-operation/continue": (cwd, body) => gitOperationAction(cwd, "continue", body),
        "/api/git-operation/skip": (cwd, body) => gitOperationAction(cwd, "skip", body),
        "/api/git-operation/abort": (cwd, body) => gitOperationAction(cwd, "abort", body),
        "/api/git-operation/stage-file": (cwd, body) => gitOperationStageFile(cwd, body),
        "/api/git-operation/bisect": (cwd, body) => gitBisectAction(cwd, body),
        "/api/git-operation/resolve-with-agent": (_cwd, _body, tab) => openGitConflictResolutionAgentTab(tab),
        "/api/git-stash/save": (cwd, body) => saveGitStash(cwd, body),
        "/api/git-stash/apply": (cwd, body) => applyGitStash(cwd, body),
        "/api/git-stash/pop": (cwd, body) => applyGitStash(cwd, body, { pop: true }),
        "/api/git-stash/drop": (cwd, body) => dropGitStash(cwd, body),
        "/api/git-undo/last-commit": (cwd, body) => undoLastGitCommit(cwd, body),
        "/api/git-undo/amend-message": (cwd, body) => amendLastGitCommitMessage(cwd, body),
        "/api/git-submodules/update": (cwd, body) => updateGitSubmodules(cwd, body),
        "/api/git-tags/create": (cwd, body) => createGitTag(cwd, body),
        "/api/git-worktrees/prune": (cwd, body) => pruneGitWorktreesData(cwd, body, { dryRun: false }),
      };
      if (req.method === "POST" && GIT_MUTATION_ROUTES[url.pathname]) {
        const body = await readJsonBody(req);
        const tab = getRequestedTab(req, url, body);
        ensureNaturalConversationRouteAllowed(tab, "git actions are blocked");
        try {
          const payload = await GIT_MUTATION_ROUTES[url.pathname](tab.cwd, body, tab);
          sendJson(res, 200, payload && typeof payload === "object" && "ok" in payload ? payload : { ok: true, data: payload });
        } catch (error) {
          gitActionError(error);
        }
        return;
      }
    }

    if (url.pathname.startsWith("/api/git-workflow/")) {
      const readOnlyWorkflow = GIT_WORKFLOW_READONLY_PATHS.has(url.pathname);
      const mutatingWorkflow = GIT_WORKFLOW_MUTATING_PATHS.has(url.pathname);
      if (readOnlyWorkflow || mutatingWorkflow) {
        const requiredMethod = mutatingWorkflow ? "POST" : "GET";
        if (req.method !== requiredMethod) {
          res.setHeader("Allow", requiredMethod);
          sendJson(res, 405, { ok: false, error: `${url.pathname} requires ${requiredMethod}` });
          return;
        }
        const body = mutatingWorkflow ? await readJsonBody(req) : { generationId: url.searchParams.get("generationId") || "" };
        const tab = getRequestedTab(req, url, body);
        if (mutatingWorkflow) ensureNaturalConversationRouteAllowed(tab, "git workflow actions are blocked");
        const response = await handleGitWorkflowRequest(url.pathname, body, tab);
        if (response) {
          sendJson(res, 200, response);
          return;
        }
      }
    }

    const getCommand = req.method === "GET" ? commandFromGet(url.pathname) : undefined;
    if (getCommand) {
      const tab = getRequestedTab(req, url);
      const response = await safeRpcResponse(tab, getCommand);
      if (url.pathname === "/api/messages") applyMessagesSinceParam(response, url);
      sendJson(res, response.success === false ? 400 : 200, response);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/extension-ui-response") {
      const body = await readJsonBody(req);
      const tab = getRequestedTab(req, url, body);
      const { tabId, tab: _tab, ...payload } = body;
      if (payload.type !== "extension_ui_response") payload.type = "extension_ui_response";
      if (!payload.id) throw new Error("id is required");
      await tab.rpc.writeRaw(payload);
      const resolved = resolvePendingExtensionUiRequest(tab, payload.id);
      if (resolved) {
        broadcastTabEvent(tab, {
          type: "webui_extension_ui_resolved",
          tabId: tab.id,
          tabTitle: tab.title,
          id: String(payload.id),
          pendingExtensionUiRequestCount: pendingExtensionUiRequests(tab).length,
          tabActivity: tabActivitySnapshot(tab),
        });
      }
      sendJson(res, 200, { ok: true, tab: tabMeta(tab) });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req, { limitBytes: requestBodyLimitForPath(url.pathname) });
      const command = commandFromPost(url.pathname, body);
      if (command) {
        const tab = getRequestedTab(req, url, body);
        enforceNaturalConversationCommandAllowed(tab, command);
        if (command.type === "new_session" && tab.workspaceKind === "no-project") {
          const created = await createNoProjectResetTab(tab);
          sendJson(res, 200, responseWithTab(rpcSuccess("new_session", created), tab));
          return;
        }
        if (command.type === "abort") await cancelPendingExtensionUiRequests(tab);
        const queuedForCompaction = maybeQueueCommandDuringCompaction(tab, command);
        if (queuedForCompaction) {
          sendJson(res, 202, responseWithTab(queuedForCompaction, tab));
          return;
        }
        const naturalConversationSafetyResponse = await ensureNaturalConversationPromptSafety(tab, command);
        if (naturalConversationSafetyResponse?.success === false) {
          sendJson(res, 400, responseWithTab(naturalConversationSafetyResponse, tab));
          return;
        }
        const startsVisibleWork = commandStartsVisibleWork(command);
        if (startsVisibleWork) {
          maybeNameTabForConversation(tab, command);
          markTabWorking(tab);
        }
        let response = command.type === "set_thinking_level"
          ? await setThinkingLevelForTab(tab, command.level)
          : command.type === "bash"
            ? await sendQueuedBashCommand(tab, command)
            : await tab.rpc.send(command);
        if (command.type === "bash" && response.success !== false) {
          const trustWarning = remoteShellTrustWarning(req, networkStatus().open);
          if (trustWarning) response = { ...response, warnings: [trustWarning] };
        }
        if (response.success === false && startsVisibleWork) markTabIdle(tab);
        if (response.success !== false && command.type === "new_session") {
          tab.conversationStarted = false;
          resetAutomaticTabTitleForNewSession(tab);
          forgetTabState(tab);
          rememberTabState(tab, response.data);
          clearPendingExtensionUiRequests(tab);
          clearExtensionStatuses(tab);
          clearExtensionWidgets(tab);
          clearWebuiSubagents(tab);
          resetNaturalConversationMode(tab);
          resetCodexFastMode(tab);
        }
        sendJson(res, response.success === false ? 400 : 200, responseWithTab(response, tab));
        return;
      }
    }

    if (await serveStatic(req, res, url)) return;

    sendError(res, 404, "Not found");
  } catch (error) {
    sendError(res, error?.statusCode || 500, error);
  }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE" && !server.listening) return;
  if (networkRebindInProgress) {
    console.error("Web UI network rebind failed:", sanitizeError(error));
    return;
  }
  console.error("Web UI server failed:", sanitizeError(error));
  void shutdown("server error", { preserveSessions: true, exitCode: 1 });
});

function sweepWebuiTempArtifacts() {
  sweepStaleTempEntries(UPLOAD_TEMP_ROOT, { ttlMs: UPLOAD_TEMP_TTL_MS }).catch(() => {});
  sweepStaleTempEntries(NATIVE_EXPORT_TEMP_ROOT, { ttlMs: NATIVE_EXPORT_TEMP_TTL_MS }).catch(() => {});
}

sweepWebuiTempArtifacts();
setInterval(sweepWebuiTempArtifacts, TEMP_ARTIFACT_SWEEP_INTERVAL_MS).unref();

await listenWithRetry(server, { port: options.port, host: currentHost, attempts: 40, initialDelayMs: 250 });

const urlHost = formatUrlHost(currentHost);
console.log(`Pi Web UI: http://${urlHost}:${options.port}/`);
console.log(`Working directory: ${options.cwd}`);
if (!isLocalHost(currentHost)) {
  console.warn(`WARNING: Web UI is exposed to the network. Remote PIN auth is ${remoteAuth.pin ? "enabled" : "OFF"}; only expose it on trusted networks.`);
}

async function initializeNativeAdmission() {
  const root = await sharedUpdateRoot();
  const candidates = [packageRoot, configuredAgentNpmRoot()];
  const activePiRoot = (await canonicalPiRuntimeIdentity({ force: true }).catch(() => null))?.active?.packageRoot;
  if (activePiRoot) candidates.push(activePiRoot);
  const nativeContext = await nativeUpdateContext().catch(() => null);
  if (nativeContext?.pathPi?.eligible) candidates.push(nativeContext.pathPi.prefix);
  if (nativeContext?.npm?.prefix) candidates.push(nativeContext.npm.prefix);
  if (!webuiDevServer) candidates.push(packageOwnerRoot(packageRoot));
  const roots = [...new Set((await Promise.all(candidates.map((candidate) => realpath(candidate).catch(() => null)))).filter(Boolean))];
  const participant = await registerUpdateParticipant(root, { kind: "server", roots });
  process.env.PI_WEBUI_UPDATE_EFFECT_ROOTS = JSON.stringify(participant.canonicalRoots);
  nativeAdmissionState = { root, participant };
  setInterval(async () => {
    try {
      for (const effect of participant.canonicalRoots) {
        const lock = await effectLockForRoot(root, effect);
        if (!lock) continue;
        const idle = nativeAdmittedWork.idle && !optionalFeatureAuditCoordinator?.mutation && [...tabs.values()].every((tab) => !tab.activity?.isWorking && !tab.lastState?.isStreaming && !tab.lastState?.isCompacting &&
          !(tab.rpc?.pending?.size > 0) && !(tab.bashQueue?.length > 0) && !(tab.compactionQueue?.length > 0) &&
          pendingExtensionUiRequests(tab).length === 0 && (tab.browserPromptRequests?.size || 0) === 0);
        await acknowledgeUpdateFence(participant, { token: lock.token, effects: [effect] }, idle);
      }
    } catch (error) { console.warn(`update admission check failed: ${sanitizeError(error)}`); }
  }, 250).unref();
}
await sweepRestoreFiles(agentDir).catch(() => {});
// Startup package migrations need the same shared admission as interactive ones.
await initializeNativeAdmission();
const startupAudit = await optionalFeatureAuditCoordinator.recheck({ reason: "startup" });
if (options.migrationDryRun) {
  console.log(`Optional feature migration dry run:\n${JSON.stringify(startupAudit, null, 2)}`);
} else if (options.migrateOptionalFeatures) {
  const featureIds = startupAudit.features.filter(({ state }) => state === "legacy-migratable").map(({ featureId }) => featureId);
  if (featureIds.length) {
    const result = await runOptionalFeatureBatchMutation({ revision: startupAudit.revision, featureIds, cwd: options.cwd, migration: true });
    console.log(`Optional feature migration: ${result.succeeded} succeeded, ${result.failed} failed.`);
  }
}

// The detached supervisor inherits registered roots before its first Pi child.
rpcSupervisor = await initializeRpcSupervisor();
if (rpcSupervisor?.state?.token) recoveryEndpointTokens.add(deriveSupervisorRecoveryToken(rpcSupervisor.state.token));
rpcSupervisorSnapshot = rpcSupervisor?.snapshot || null;
installRpcSupervisorEventDispatch(rpcSupervisorSnapshot);
const initialTabs = await createInitialTabs();
await finishRpcSupervisorStartup(initialTabs);
const restartTransaction = process.env.PI_WEBUI_NATIVE_RESTART_TRANSACTION;
const restartToken = process.env.PI_WEBUI_NATIVE_RESTART_TOKEN;
delete process.env.PI_WEBUI_NATIVE_RESTART_TRANSACTION;
delete process.env.PI_WEBUI_NATIVE_RESTART_TOKEN;
if (restartTransaction || restartToken) {
  const stateRoot = await sharedUpdateRoot();
  const job = restartTransaction ? await readSharedJob(stateRoot, restartTransaction) : null;
  const matches = job?.phase === "restart-pending" && job.lock?.token === restartToken &&
    job.verifiedTargets?.some((target) => target.status === "healthy" && target.installedRoot === realpathSync(packageRoot) &&
      target.version === packageJson.version);
  if (!matches || (!rpcSupervisor && restoreTabs.length > 0) ||
      restoreTabs.length !== initialTabs.length ||
      restoreTabs.some((descriptor) => !initialTabs.some((tab) => tab.id === descriptor.id))) {
    throw new Error("Native Web UI restart did not prove the expected runtime and restored sessions; update fence remains held.");
  }
  for (const descriptor of restoreTabs) {
    const tab = initialTabs.find((item) => item.id === descriptor.id);
    const response = await tab.rpc.send({ type: "get_state" }, 5_000);
    assertRestoredPiState(response, descriptor.sessionFile);
    if (!tab.rpc.isRunning()) throw new Error("Restored Pi child exited before session verification.");
    rememberTabState(tab, response.data);
  }
  await releaseEffectLocks(job.lock, { completionVerified: true });
  await persistSharedJob(stateRoot, { ...job, phase: job.outcome || "success", successorBootIdentity: bootIdentity });
  if (!initialTabs.length && options.cwdExplicit) await createTab();
}
startupProbeReady = true;
setInterval(async () => {
  try {
    const jobsDir = path.join((await sharedUpdateRoot()), "jobs");
    for (const entry of (await readdir(jobsDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error))).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
      await finalizeNativeJob(entry.slice(0, -5));
    }
  } catch (error) { console.warn(`Native update recovery needs attention: ${sanitizeError(error)}`); }
}, 1_000).unref();
const initialTab = initialTabs[0] || null;
optionalFeatureStartupReady = true;
if (initialTab) console.log(`Pi RPC: ${initialTab.rpc.displayCommand}`);
else console.log("Pi RPC: waiting for CWD selection in the Web UI");
if (restoreTabs.length) console.log(`Restored Web UI tabs: ${initialTabs.length}`);

let shutdownInProgress = false;

async function shutdown(signal, { preserveSessions = false, exitCode = 0 } = {}) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`\n${signal}: shutting down Pi Web UI...`);
  gitLiveWatcher.closeAll();
  workspaceFilesLiveWatcher.closeAll();
  for (const tab of tabs.values()) stopAppRunnerForTab(tab, "server shutdown", { force: true });

  const forceExit = setTimeout(() => process.exit(exitCode), 4000);
  forceExit.unref?.();
  try {
    if (rpcSupervisor) {
      if (preserveSessions) await detachRpcSupervisor();
      else {
        try {
          if (rpcSupervisor.isConnected()) await rpcSupervisor.shutdown();
        } finally {
          rpcSupervisor.close();
          rpcSupervisor = null;
        }
      }
    } else {
      await Promise.all([...tabs.values()].map((tab) => Promise.resolve(tab.rpc.stop()).catch(() => {})));
    }
  } catch (error) {
    console.error("Web UI RPC shutdown failed:", sanitizeError(error));
  }

  const forceCloseTimer = setTimeout(() => {
    server.closeAllConnections?.();
  }, NETWORK_REBIND_FORCE_CLOSE_MS);
  forceCloseTimer.unref?.();
  await new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
  clearTimeout(forceCloseTimer);
  if (nativeAdmissionState) await unregisterUpdateParticipant(nativeAdmissionState.participant).catch(() => {});
  clearTimeout(forceExit);
  process.exit(exitCode);
}

process.on("SIGINT", () => { void shutdown("SIGINT", { preserveSessions: false }); });
process.on("SIGTERM", () => { void shutdown("SIGTERM", { preserveSessions: true }); });
