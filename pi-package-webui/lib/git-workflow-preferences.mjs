import { readWebuiSettings, webuiSettingsFile, writeWebuiSettings } from "./server/settings-store.mjs";

export {
  GIT_WORKFLOW_SETUP_VERSION,
  GIT_WORKFLOW_THINKING_LEVELS,
  GIT_WORKFLOW_LANGUAGES,
  GIT_WORKFLOW_DEFAULT_VARIANTS,
  GIT_WORKFLOW_SCOPE_POLICIES,
  GIT_WORKFLOW_STAGING_POLICIES,
  GIT_WORKFLOW_DELIVERY_MODES,
  GIT_WORKFLOW_VERIFICATION_POLICIES,
  GIT_WORKFLOW_UNAVAILABLE_POLICIES,
  supportedGitWorkflowThinkingLevels,
  defaultGitWorkflowPreferences,
  normalizeGitWorkflowPreferences,
  mergeGitWorkflowPreferences,
  isGitWorkflowSetupComplete,
  gitWorkflowPreferencesSummary,
} from "./git-workflow-preference-values.mjs";
export {
  WEBUI_SIDE_PANEL_WIDTH_MIN_PX,
  WEBUI_SIDE_PANEL_WIDTH_MAX_PX,
  webuiSettingsFile,
  legacyWebuiSettingsFile,
  normalizeResourceDefaults,
  normalizeInterfacePreferences,
  normalizeWebuiSettings,
  withWebuiSettingsLock,
  migrateLegacyWebuiSettings,
  readWebuiSettings,
  updateWebuiSettings,
  writeWebuiSettings,
} from "./server/settings-store.mjs";

export async function readGitWorkflowPreferences(storageFile = webuiSettingsFile()) {
  return (await readWebuiSettings(storageFile)).gitWorkflow;
}

export async function writeGitWorkflowPreferences(patch, storageFile = webuiSettingsFile()) {
  return (await writeWebuiSettings({ gitWorkflow: patch }, storageFile)).gitWorkflow;
}
