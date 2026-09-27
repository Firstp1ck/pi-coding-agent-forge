// Versioned JSON-lines protocol between the Quickshell QML client and the Node backend.
//
// Every frame is one JSON object terminated by "\n". Requests flow from QML to the backend,
// responses answer exactly one request by id, and events are unsolicited backend records.
// All numeric budgets used by both processes live here so tests can exercise each limit.

export const PROTOCOL_VERSION = 1;

export const LIMITS = Object.freeze({
  // Framing
  maxInboundFrameBytes: 256 * 1024,
  maxOutboundFrameBytes: 1024 * 1024,
  maxPiFrameBytes: 4 * 1024 * 1024,
  // Outbound event queue while the QML consumer is slow
  maxQueuedRecords: 2000,
  maxQueuedBytes: 4 * 1024 * 1024,
  maxTransportBytes: 8 * 1024 * 1024,
  maxTransportRecords: 4096,
  transportControlBytes: 64 * 1024,
  transportDrainMs: 3_000,
  maxControlRequests: 8,
  maxAdmittedResponseBytes: 64 * 1024 * 1024,
  // Request handling
  maxPendingRequests: 64,
  maxRequestIdCharacters: 96,
  requestTimeoutMs: Object.freeze({
    hello: 5_000,
    prompt: 30_000,
    abort: 10_000,
    state: 10_000,
    restart: 20_000,
    extension_response: 5_000,
    settings_get: 5_000,
    settings_set: 5_000,
    themes_list: 15_000,
    theme_select: 15_000,
    open_link: 5_000,
    notify: 5_000,
    shutdown: 5_000,
    debug_crash: 5_000,
    models_list: 10_000,
    model_set: 10_000,
    model_cycle: 10_000,
    thinking_levels: 5_000,
    thinking_set: 5_000,
    thinking_cycle: 5_000,
    compact: 120_000,
    draft_get: 5_000,
    draft_set: 5_000,
    sequences_list: 5_000,
    sequence_save: 5_000,
    sequence_delete: 5_000,
    sequence_move: 5_000,
    sequence_run: 30_000,
    commands_list: 10_000,
    attachment_add: 10_000,
    attachments_list: 5_000,
    attachment_update: 5_000,
    attachment_read: 5_000,
    attachment_remove: 5_000,
    path_complete: 10_000,
    tabs_list: 5_000,
    tab_open: 20_000,
    tab_close: 20_000,
    tab_select: 10_000,
    tab_rename: 10_000,
    tab_move: 5_000,
    sessions_list: 20_000,
    session_settled: 5_000,
    session_switch: 30_000,
    session_new: 30_000,
    directory_list: 10_000,
    directory_create: 10_000,
    directory_pin: 5_000,
    worktrees_list: 15_000,
    worktree_plan: 15_000,
    worktree_create: 90_000,
    open_path: 5_000,
    session_stats: 10_000,
    recent_action: 5_000,
    diagnostics: 5_000,
    resources_state: 15_000,
    tools_set: 15_000,
    skills_set: 15_000,
    sampling_set: 15_000,
  }),
  // Pi lifecycle
  piStartupReadinessMs: 15_000,
  promptReconciliationMs: 150,
  shutdownGraceMs: 3_000,
  processGroupSweepMs: 1_000,
  processGroupPollMs: 20,
  maxProcessSweepEntries: 65_536,
  // Transcript content
  maxTranscriptRows: 80,
  maxMessageCharacters: 8192,
  maxThinkingCharacters: 8192,
  maxErrorCharacters: 512,
  maxRuntimeInfoCharacters: 160,
  maxPartsPerMessage: 64,
  maxToolSummaryCharacters: 256,
  maxToolOutputCharacters: 4096,
  maxToolNameCharacters: 64,
  renderCadenceMs: 80,
  // Markdown
  maxMarkdownInputCharacters: 8192,
  maxMarkdownBlocks: 200,
  maxMarkdownDepth: 4,
  maxTableRows: 50,
  maxTableColumns: 12,
  maxListItems: 200,
  // Extension dialogs
  maxPendingDialogs: 16,
  maxDialogOptions: 64,
  maxDialogOptionCharacters: 256,
  maxDialogTitleCharacters: 256,
  maxDialogMessageCharacters: 4096,
  maxDialogValueCharacters: 16 * 1024,
  // Notifications and links
  maxNotificationCharacters: 256,
  maxLinkUrlCharacters: 2048,
  // Settings and themes
  maxSettingsFileBytes: 64 * 1024,
  storeLockWaitMs: 100,
  storeLockCommandMs: 500,
  maxThemeNameCharacters: 64,
  // Extension status chips (structured footer payloads)
  maxStatusChips: 18,
  maxStatusChipCharacters: 64,
  // Notices and queues
  maxNoticeCharacters: 512,
  maxQueueEntries: 32,
  maxQueueEntryCharacters: 256,
  // Models, thinking levels, and manual compaction
  maxModels: 256,
  maxProviderCharacters: 64,
  maxModelIdCharacters: 128,
  maxModelNameCharacters: 96,
  maxThinkingLevels: 8,
  maxCompactionInstructionCharacters: 1024,
  maxCompactionSummaryCharacters: 512,
  // Syntax highlighting of fenced code blocks
  maxHighlightCharacters: 8192,
  maxHighlightTokens: 4000,
  // Drafts and other window state (XDG state directory)
  maxDraftCharacters: 8192,
  maxDrafts: 64,
  maxStateKeyCharacters: 4096,
  maxStateFileBytes: 512 * 1024,
  maxRecentEntries: 20,
  // Saved prompt sequences (XDG config directory)
  maxSequences: 32,
  maxSequenceEntries: 16,
  maxSequenceNameCharacters: 64,
  maxSequenceIdCharacters: 64,
  maxSequencesFileBytes: 1024 * 1024,
  // Slash commands reported by Pi
  maxCommands: 512,
  maxCommandNameCharacters: 64,
  maxCommandDescriptionCharacters: 256,
  // Composer attachments
  maxAttachments: 8,
  maxImageAttachmentBytes: 5 * 1024 * 1024,
  maxTextAttachmentBytes: 256 * 1024,
  maxAttachmentReadCharacters: 32 * 1024,
  maxAttachmentLegacyListBytes: 256 * 1024,
  maxAttachmentNameCharacters: 128,
  maxAttachmentIdCharacters: 64,
  maxPromptErrorCodeCharacters: 64,
  // Workspace paths and completion
  maxPathCharacters: 4096,
  maxWorkspaceEntries: 20_000,
  maxWorkspaceDepth: 16,
  maxPathSuggestions: 50,
  maxCompletionQueryCharacters: 256,
  workspaceIndexTtlMs: 5_000,
  workspaceCommandTimeoutMs: 5_000,
  maxWorkspaceCommandOutputBytes: 8 * 1024 * 1024,
  // Tabs, sessions, directories, and worktrees
  maxTabs: 8,
  maxTabIdCharacters: 32,
  maxTabNameCharacters: 64,
  maxSessionListEntries: 200,
  maxCatalogCandidates: 4096,
  maxCatalogCandidateBytes: 8 * 1024 * 1024,
  maxCatalogRows: 2000,
  maxCatalogBytes: 8 * 1024 * 1024,
  maxCatalogReadBytes: 16 * 1024 * 1024,
  maxCatalogPageBytes: 512 * 1024,
  maxCatalogScans: 4,
  maxCatalogCursors: 512,
  maxCatalogCacheEntries: 512,
  maxCatalogCacheBytes: 4 * 1024 * 1024,
  catalogScanMs: 3_000,
  catalogCursorMs: 30_000,
  maxSettledSessions: 2048,
  maxAutomaticSettledSessions: 2048,
  maxSessionRestoreGraceEntries: 2048,
  maxSessionScanBytes: 1024 * 1024,
  maxSnapshotInputBytes: 8 * 1024 * 1024,
  maxSnapshotOutputBytes: 8 * 1024 * 1024,
  maxConcurrentSnapshotLoads: 2,
  maxQueuedSnapshotLoads: 8,
  snapshotWorkerHeapMiB: 128,
  snapshotLoadMs: 5_000,
  maxSessionSyncWarnings: 128,
  maxSessionRebindAttempts: 3,
  maxSessionPreviewCharacters: 160,
  maxDirectoryEntries: 500,
  maxBranchNameCharacters: 128,
  maxWorktrees: 64,
  gitCommandTimeoutMs: 10_000,
  gitMutationTimeoutMs: 60_000,
  maxGitOutputBytes: 4 * 1024 * 1024,
  // Palette recents and the events view
  maxActionKeyCharacters: 128,
  maxEventHistory: 200,
  // Tool, skill, and sampling profiles and the Pi-side helper
  maxResourceNames: 512,
  maxModelProfiles: 64,
  maxResourcesFileBytes: 256 * 1024,
  helperTimeoutMs: 10_000,
  maxHelperResponseBytes: 512 * 1024,
});

export const IMAGE_ATTACHMENT_TYPES = Object.freeze({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" });

// Every thinking level Pi can report; a model exposes a subset through get_available_thinking_levels.
export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const ALLOWED_LINK_SCHEMES = Object.freeze(["http:", "https:", "mailto:"]);

export const REQUEST_TYPES = Object.freeze(Object.keys(LIMITS.requestTimeoutMs));

export const SETTINGS_SCHEMA = Object.freeze({
  compactTranscript: { type: "boolean", default: false },
  showThinking: { type: "boolean", default: true },
  desktopNotifications: { type: "boolean", default: true },
  syntaxHighlighting: { type: "boolean", default: true },
  appearanceMode: { type: "string", values: Object.freeze(["automatic", "light", "dark"]), default: "automatic" },
  selectedThemeName: { type: "themeName", default: "" },
  reducedMotion: { type: "boolean", default: false },
  sessionSettleDays: { type: "boundedInteger", minimum: 1, maximum: 3650, default: 30 },
  modelOrder: { type: "modelIdentityList", default: Object.freeze([]) },
});

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function validateModelOrder(value) {
  if (!Array.isArray(value)) throw new ProtocolError("invalid_request", "setting modelOrder must be an array");
  if (value.length > LIMITS.maxModels) {
    throw new ProtocolError("limit_exceeded", `setting modelOrder cannot have more than ${LIMITS.maxModels} entries`);
  }
  const result = [];
  const seen = new Set();
  for (const identity of value) {
    if (typeof identity !== "string" || identity.length === 0) {
      throw new ProtocolError("invalid_request", "setting modelOrder entries must be non-empty strings");
    }
    const separator = identity.indexOf("/");
    if (separator <= 0 || separator === identity.length - 1) {
      throw new ProtocolError("invalid_request", "setting modelOrder entries must be provider/model-id identities");
    }
    const provider = identity.slice(0, separator);
    const modelId = identity.slice(separator + 1);
    if (provider.trim().length === 0 || modelId.trim().length === 0) {
      throw new ProtocolError("invalid_request", "setting modelOrder entries must contain a non-empty provider and model id");
    }
    if (provider.length > LIMITS.maxProviderCharacters) {
      throw new ProtocolError("limit_exceeded", `modelOrder provider exceeds ${LIMITS.maxProviderCharacters} characters`);
    }
    if (modelId.length > LIMITS.maxModelIdCharacters) {
      throw new ProtocolError("limit_exceeded", `modelOrder model id exceeds ${LIMITS.maxModelIdCharacters} characters`);
    }
    if (!seen.has(identity)) {
      seen.add(identity);
      result.push(identity);
    }
  }
  return result;
}

export function validateThemeIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError("invalid_request", "theme selection must be an object");
  if (value.kind !== "builtin" && value.kind !== "external") throw new ProtocolError("invalid_request", "theme selection kind must be builtin or external");
  if (typeof value.name !== "string" || value.name.length === 0 || value.name.length > LIMITS.maxThemeNameCharacters
      || value.name !== value.name.trim() || value.name.includes("/") || /[\u0000-\u001f\u007f]/.test(value.name)) {
    throw new ProtocolError("invalid_request", `theme selection name must be 1-${LIMITS.maxThemeNameCharacters} characters with no slash or control character`);
  }
  if (value.kind === "builtin" && !["automatic", "light", "dark"].includes(value.name)) throw new ProtocolError("invalid_request", "unknown built-in theme");
  return { kind: value.kind, name: value.name };
}

export function validateSettingValue(key, value) {
  const schema = SETTINGS_SCHEMA[key];
  if (!schema) throw new ProtocolError("invalid_request", `unknown setting ${key}`);
  if (schema.type === "modelIdentityList") return validateModelOrder(value);
  if (schema.type === "themeName") {
    if (value === "") return value;
    return validateThemeIdentity({ kind: "external", name: value }).name;
  }
  if (schema.type === "boundedInteger") {
    if (!Number.isInteger(value)) throw new ProtocolError("invalid_request", `setting ${key} must be a whole number`);
    if (value < schema.minimum || value > schema.maximum) {
      throw new ProtocolError("invalid_request", `setting ${key} must be between ${schema.minimum} and ${schema.maximum}`);
    }
    return value;
  }
  if (typeof value !== schema.type) throw new ProtocolError("invalid_request", `setting ${key} must be ${schema.type}`);
  if (schema.values && !schema.values.includes(value)) {
    throw new ProtocolError("invalid_request", `setting ${key} must be one of ${schema.values.join(", ")}`);
  }
  return value;
}

export function boundedString(value, limit, fallback = "") {
  const text = typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

// Terminal escape sequences (colors, cursor moves, OSC titles) never reach the QML side as text.
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\[\d{1,3}(?:;\d{1,3}){1,5}m/g;

export function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

export function boundedError(value) {
  return boundedString(value, LIMITS.maxErrorCharacters, "Unknown error");
}

function validateRequestId(id) {
  if (typeof id !== "string" || id.length === 0) throw new ProtocolError("invalid_request", "request id must be a non-empty string");
  if (id.length > LIMITS.maxRequestIdCharacters) throw new ProtocolError("invalid_request", "request id is too long");
  return id;
}

function requireString(request, field, limit) {
  const value = request[field];
  if (typeof value !== "string") throw new ProtocolError("invalid_request", `${request.type} requires a string ${field}`);
  if (value.length > limit) throw new ProtocolError("limit_exceeded", `${field} exceeds ${limit} characters`);
  return value;
}

function requireScope(frame) {
  if (!["session", "global", "model"].includes(frame.scope)) throw new ProtocolError("invalid_request", "scope must be session, global, or model");
  return frame.scope;
}

function requireIdList(request, field, maxItems, maxCharacters) {
  const value = request[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ProtocolError("invalid_request", `${field} must be an array`);
  if (value.length > maxItems) throw new ProtocolError("limit_exceeded", `${field} cannot have more than ${maxItems} entries`);
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > maxCharacters) throw new ProtocolError("invalid_request", `${field} entries must be non-empty strings of at most ${maxCharacters} characters`);
    return entry;
  });
}

// Validates one decoded inbound frame and returns a normalized request. Throws ProtocolError.
export function validateRequest(frame) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    throw new ProtocolError("invalid_request", "request must be a JSON object");
  }
  if (frame.v !== PROTOCOL_VERSION) {
    throw new ProtocolError("unsupported_version", `unsupported protocol version ${String(frame.v)}`);
  }
  const id = validateRequestId(frame.id);
  const type = frame.type;
  if (typeof type !== "string" || !REQUEST_TYPES.includes(type)) {
    throw new ProtocolError("unknown_request", `unknown request type ${String(type)}`);
  }
  const request = { id, type };
  // Session-scoped requests may name a tab; without it the active tab is used.
  if (frame.tab !== undefined) {
    if (typeof frame.tab !== "string" || frame.tab.length === 0 || frame.tab.length > LIMITS.maxTabIdCharacters) throw new ProtocolError("invalid_request", "tab must be a non-empty string");
    request.tab = frame.tab;
  }
  switch (type) {
    case "prompt": {
      request.message = requireString(frame, "message", LIMITS.maxMessageCharacters);
      if (request.message.trim().length === 0) throw new ProtocolError("invalid_request", "prompt message is empty");
      const mode = frame.mode ?? "send";
      if (!["send", "steer", "followUp"].includes(mode)) throw new ProtocolError("invalid_request", "prompt mode must be send, steer, or followUp");
      request.mode = mode;
      request.attachments = requireIdList(frame, "attachments", LIMITS.maxAttachments, LIMITS.maxAttachmentIdCharacters);
      if (new Set(request.attachments).size !== request.attachments.length) throw new ProtocolError("invalid_request", "prompt attachment ids must be unique");
      break;
    }
    case "draft_get": {
      request.key = requireString(frame, "key", LIMITS.maxStateKeyCharacters);
      if (request.key.length === 0) throw new ProtocolError("invalid_request", "draft_get requires a key");
      break;
    }
    case "draft_set": {
      request.key = requireString(frame, "key", LIMITS.maxStateKeyCharacters);
      if (request.key.length === 0) throw new ProtocolError("invalid_request", "draft_set requires a key");
      request.text = requireString(frame, "text", LIMITS.maxDraftCharacters);
      if (frame.expectedText !== undefined) request.expectedText = requireString(frame, "expectedText", LIMITS.maxDraftCharacters);
      break;
    }
    case "sequence_save": {
      request.sequenceId = frame.sequenceId === undefined ? "" : requireString(frame, "sequenceId", LIMITS.maxSequenceIdCharacters);
      request.name = requireString(frame, "name", LIMITS.maxSequenceNameCharacters);
      if (request.name.trim().length === 0) throw new ProtocolError("invalid_request", "sequence_save requires a name");
      if (!Array.isArray(frame.entries)) throw new ProtocolError("invalid_request", "sequence_save requires an entries array");
      if (frame.entries.length === 0) throw new ProtocolError("invalid_request", "a sequence needs at least one entry");
      if (frame.entries.length > LIMITS.maxSequenceEntries) throw new ProtocolError("limit_exceeded", `a sequence cannot have more than ${LIMITS.maxSequenceEntries} entries`);
      request.entries = frame.entries.map((entry, index) => {
        if (typeof entry !== "string" || entry.trim().length === 0) throw new ProtocolError("invalid_request", `sequence entry ${index + 1} must be a non-empty string`);
        if (entry.length > LIMITS.maxMessageCharacters) throw new ProtocolError("limit_exceeded", `sequence entry ${index + 1} exceeds ${LIMITS.maxMessageCharacters} characters`);
        return entry;
      });
      break;
    }
    case "sequence_delete":
    case "sequence_move":
    case "sequence_run": {
      request.sequenceId = requireString(frame, "sequenceId", LIMITS.maxSequenceIdCharacters);
      if (request.sequenceId.length === 0) throw new ProtocolError("invalid_request", `${type} requires a sequenceId`);
      if (type === "sequence_move") {
        if (frame.delta !== 1 && frame.delta !== -1) throw new ProtocolError("invalid_request", "sequence_move delta must be 1 or -1");
        request.delta = frame.delta;
      }
      break;
    }
    case "attachment_add": {
      request.path = requireString(frame, "path", LIMITS.maxPathCharacters);
      if (!request.path.startsWith("/")) throw new ProtocolError("invalid_request", "attachment path must be absolute");
      if (frame.granted !== undefined && typeof frame.granted !== "boolean") throw new ProtocolError("invalid_request", "granted must be boolean");
      request.granted = frame.granted === true;
      break;
    }
    case "attachment_read": {
      request.attachmentId = requireString(frame, "attachmentId", LIMITS.maxAttachmentIdCharacters);
      request.offset = frame.offset ?? 0;
      if (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > LIMITS.maxTextAttachmentBytes) throw new ProtocolError("invalid_request", "Invalid attachment read offset");
      if (frame.revision !== undefined) {
        if (!Number.isSafeInteger(frame.revision) || frame.revision < 0) throw new ProtocolError("invalid_request", "Invalid attachment revision");
        request.revision = frame.revision;
      }
      break;
    }
    case "hello": {
      if (frame.attachmentMetadata !== undefined && typeof frame.attachmentMetadata !== "boolean") throw new ProtocolError("invalid_request", "attachmentMetadata must be boolean");
      if (frame.attachmentMetadata !== undefined) request.attachmentMetadata = frame.attachmentMetadata;
      break;
    }
    case "attachment_update": {
      request.attachmentId = requireString(frame, "attachmentId", LIMITS.maxAttachmentIdCharacters);
      request.text = requireString(frame, "text", LIMITS.maxTextAttachmentBytes);
      if (Buffer.byteLength(request.text, "utf8") > LIMITS.maxTextAttachmentBytes) throw new ProtocolError("limit_exceeded", "Text attachment exceeds its UTF-8 byte limit");
      break;
    }
    case "attachment_remove": {
      request.attachmentId = requireString(frame, "attachmentId", LIMITS.maxAttachmentIdCharacters);
      break;
    }
    case "path_complete": {
      request.query = frame.query === undefined ? "" : requireString(frame, "query", LIMITS.maxCompletionQueryCharacters);
      break;
    }
    case "tab_open": {
      request.cwd = frame.cwd === undefined ? "" : requireString(frame, "cwd", LIMITS.maxPathCharacters);
      request.sessionPath = frame.sessionPath === undefined ? "" : requireString(frame, "sessionPath", LIMITS.maxPathCharacters);
      request.name = frame.name === undefined ? "" : requireString(frame, "name", LIMITS.maxTabNameCharacters);
      if (request.cwd.length > 0 && !request.cwd.startsWith("/") && !request.cwd.startsWith("~")) throw new ProtocolError("invalid_request", "cwd must be an absolute path");
      if (request.sessionPath.length > 0 && !request.sessionPath.startsWith("/")) throw new ProtocolError("invalid_request", "sessionPath must be an absolute path");
      break;
    }
    case "tab_close": {
      if (frame.force !== undefined && typeof frame.force !== "boolean") throw new ProtocolError("invalid_request", "force must be boolean");
      request.force = frame.force === true;
      break;
    }
    case "tab_rename": {
      request.name = requireString(frame, "name", LIMITS.maxTabNameCharacters);
      break;
    }
    case "tab_move": {
      if (frame.delta !== 1 && frame.delta !== -1) throw new ProtocolError("invalid_request", "tab_move delta must be 1 or -1");
      request.delta = frame.delta;
      break;
    }
    case "sessions_list": {
      if (frame.cursor !== undefined) request.cursor = requireString(frame, "cursor", 64);
      request.scope = frame.scope === undefined ? "workspace" : frame.scope;
      if (request.scope !== "workspace" && request.scope !== "all") throw new ProtocolError("invalid_request", "sessions_list scope must be workspace or all");
      request.offset = frame.offset === undefined ? 0 : frame.offset;
      if (!Number.isSafeInteger(request.offset) || request.offset < 0) throw new ProtocolError("invalid_request", "sessions_list offset must be a non-negative safe integer");
      break;
    }
    case "session_settled":
    case "session_switch": {
      request.sessionPath = requireString(frame, "sessionPath", LIMITS.maxPathCharacters);
      if (!request.sessionPath.startsWith("/") || !request.sessionPath.endsWith(".jsonl")) throw new ProtocolError("invalid_request", "sessionPath must be an absolute .jsonl path");
      if (type === "session_settled") {
        if (typeof frame.settled !== "boolean") throw new ProtocolError("invalid_request", "session_settled requires a boolean settled value");
        request.settled = frame.settled;
      }
      break;
    }
    case "directory_list": {
      request.path = frame.path === undefined ? "" : requireString(frame, "path", LIMITS.maxPathCharacters);
      if (frame.showHidden !== undefined && typeof frame.showHidden !== "boolean") throw new ProtocolError("invalid_request", "showHidden must be boolean");
      request.showHidden = frame.showHidden === true;
      break;
    }
    case "directory_create": {
      request.path = requireString(frame, "path", LIMITS.maxPathCharacters);
      request.name = requireString(frame, "name", 255);
      break;
    }
    case "directory_pin": {
      request.path = requireString(frame, "path", LIMITS.maxPathCharacters);
      if (!request.path.startsWith("/")) throw new ProtocolError("invalid_request", "path must be absolute");
      break;
    }
    case "open_path": {
      request.path = requireString(frame, "path", LIMITS.maxPathCharacters);
      if (!request.path.startsWith("/")) throw new ProtocolError("invalid_request", "path must be absolute");
      break;
    }
    case "recent_action": {
      request.action = requireString(frame, "action", LIMITS.maxActionKeyCharacters);
      if (!/^[a-z0-9][a-z0-9:_\/.-]*$/i.test(request.action)) throw new ProtocolError("invalid_request", "action keys are plain identifiers");
      break;
    }
    case "tools_set":
    case "skills_set": {
      request.scope = requireScope(frame);
      const field = type === "tools_set" ? "enabledTools" : "enabledSkills";
      if (frame[field] === null) request.names = null;
      else if (Array.isArray(frame[field])) {
        if (frame[field].length > LIMITS.maxResourceNames) throw new ProtocolError("limit_exceeded", `${field} cannot have more than ${LIMITS.maxResourceNames} entries`);
        const seen = new Set();
        request.names = frame[field].map((entry) => {
          if (typeof entry !== "string" || entry.length === 0 || entry.length > 128) throw new ProtocolError("invalid_request", `${field} entries must be non-empty strings`);
          if (seen.has(entry)) throw new ProtocolError("invalid_request", `${field} entries must be unique`);
          seen.add(entry);
          return entry;
        });
      } else throw new ProtocolError("invalid_request", `${type} requires ${field} as a list or null (inherit)`);
      break;
    }
    case "sampling_set": {
      request.scope = requireScope(frame);
      if (frame.params === null) request.params = null;
      else if (frame.params && typeof frame.params === "object" && !Array.isArray(frame.params)) {
        if (Object.keys(frame.params).length > 16) throw new ProtocolError("limit_exceeded", "too many sampling parameters");
        request.params = frame.params;
      } else throw new ProtocolError("invalid_request", "sampling_set requires params as an object or null (clear)");
      break;
    }
    case "worktree_plan":
    case "worktree_create": {
      request.branch = requireString(frame, "branch", LIMITS.maxBranchNameCharacters);
      request.base = frame.base === undefined ? "" : requireString(frame, "base", LIMITS.maxBranchNameCharacters);
      request.path = frame.path === undefined ? "" : requireString(frame, "path", LIMITS.maxPathCharacters);
      if (type === "worktree_plan") break;
      if (frame.confirmed !== true) throw new ProtocolError("invalid_request", "worktree_create requires confirmed: true after the user reviewed the branch and path");
      request.confirmed = true;
      if (frame.openTab !== undefined && typeof frame.openTab !== "boolean") throw new ProtocolError("invalid_request", "openTab must be boolean");
      request.openTab = frame.openTab !== false;
      break;
    }
    case "extension_response": {
      request.requestId = requireString(frame, "requestId", LIMITS.maxRequestIdCharacters);
      const answered = ["value", "confirmed", "cancelled"].filter((key) => frame[key] !== undefined);
      if (answered.length !== 1) throw new ProtocolError("invalid_request", "extension response needs exactly one of value, confirmed, cancelled");
      if (frame.value !== undefined) request.value = requireString(frame, "value", LIMITS.maxDialogValueCharacters);
      if (frame.confirmed !== undefined) {
        if (typeof frame.confirmed !== "boolean") throw new ProtocolError("invalid_request", "confirmed must be boolean");
        request.confirmed = frame.confirmed;
      }
      if (frame.cancelled !== undefined) {
        if (frame.cancelled !== true) throw new ProtocolError("invalid_request", "cancelled must be true when present");
        request.cancelled = true;
      }
      break;
    }
    case "theme_select": {
      request.selection = validateThemeIdentity(frame.selection);
      break;
    }
    case "settings_set": {
      if (!frame.values || typeof frame.values !== "object" || Array.isArray(frame.values)) {
        throw new ProtocolError("invalid_request", "settings_set requires a values object");
      }
      request.values = {};
      for (const [key, value] of Object.entries(frame.values)) request.values[key] = validateSettingValue(key, value);
      break;
    }
    case "open_link": {
      request.url = requireString(frame, "url", LIMITS.maxLinkUrlCharacters);
      break;
    }
    case "notify": {
      request.title = requireString(frame, "title", LIMITS.maxNotificationCharacters);
      request.body = frame.body === undefined ? "" : requireString(frame, "body", LIMITS.maxNotificationCharacters);
      break;
    }
    case "model_set": {
      request.provider = requireString(frame, "provider", LIMITS.maxProviderCharacters);
      request.modelId = requireString(frame, "modelId", LIMITS.maxModelIdCharacters);
      if (request.provider.trim().length === 0 || request.modelId.trim().length === 0) {
        throw new ProtocolError("invalid_request", "model_set requires a provider and a modelId");
      }
      break;
    }
    case "thinking_set": {
      const level = frame.level;
      if (typeof level !== "string" || !THINKING_LEVELS.includes(level)) {
        throw new ProtocolError("invalid_request", `thinking level must be one of ${THINKING_LEVELS.join(", ")}`);
      }
      request.level = level;
      break;
    }
    case "compact": {
      request.instructions = frame.instructions === undefined ? "" : requireString(frame, "instructions", LIMITS.maxCompactionInstructionCharacters);
      break;
    }
    default:
      break;
  }
  return request;
}

export function encodeFrame(record) {
  return `${JSON.stringify(record)}\n`;
}

export function validateConsumedAttachmentIds(ids) {
  if (!Array.isArray(ids)) throw new ProtocolError("invalid_request", "consumedAttachmentIds must be an array");
  if (ids.length > LIMITS.maxAttachments) throw new ProtocolError("limit_exceeded", "Too many consumed attachment ids");
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== "string" || !id.length || id.length > LIMITS.maxAttachmentIdCharacters || seen.has(id)) {
      throw new ProtocolError("invalid_request", "Invalid or duplicate consumed attachment id");
    }
    seen.add(id);
  }
  return ids;
}

export function validatePromptSettlement({ requestId, tab, ok, errorCode = "", consumedAttachmentIds }) {
  validateRequestId(requestId);
  if (typeof tab !== "string" || !tab.length || tab.length > LIMITS.maxTabIdCharacters) throw new ProtocolError("invalid_request", "prompt settlement requires a bounded tab id");
  if (typeof ok !== "boolean" || (ok && errorCode) || (!ok && (typeof errorCode !== "string" || !errorCode || errorCode.length > LIMITS.maxPromptErrorCodeCharacters))) {
    throw new ProtocolError("invalid_request", "prompt settlement needs an outcome and bounded error code");
  }
  return { requestId, tab, ok, ...(ok ? {} : { errorCode }), consumedAttachmentIds: validateConsumedAttachmentIds(consumedAttachmentIds) };
}

export function makeResponse(id, data = null, consumedAttachmentIds) {
  return { v: PROTOCOL_VERSION, kind: "response", id, ok: true, data,
    ...(consumedAttachmentIds === undefined ? {} : { consumedAttachmentIds: validateConsumedAttachmentIds(consumedAttachmentIds) }) };
}

export function makeErrorResponse(id, code, message, consumedAttachmentIds) {
  return { v: PROTOCOL_VERSION, kind: "response", id, ok: false, error: { code, message: boundedError(message) },
    ...(consumedAttachmentIds === undefined ? {} : { consumedAttachmentIds: validateConsumedAttachmentIds(consumedAttachmentIds) }) };
}

const RESERVED_FRAME_KEYS = ["v", "kind", "type", "id"];

export function makeEvent(type, payload = {}) {
  for (const key of RESERVED_FRAME_KEYS) {
    if (key in payload) throw new Error(`event payload for ${type} must not use the reserved frame key ${key}`);
  }
  return { v: PROTOCOL_VERSION, kind: "event", type, ...payload };
}

// Parses an external link and returns the normalized URL, or null when the scheme or shape is disallowed.
export function safeExternalLink(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > LIMITS.maxLinkUrlCharacters) return null;
  if (/[\u0000-\u0020\u007f]/.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!ALLOWED_LINK_SCHEMES.includes(parsed.protocol)) return null;
  if (parsed.protocol !== "mailto:" && parsed.hostname.length === 0) return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  return parsed.href;
}
