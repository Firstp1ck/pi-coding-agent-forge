import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, html, css, technical] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "TECHNICAL.md"), "utf8"),
]);

function sourceBetween(startMarker, endMarker) {
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `expected ${startMarker} before ${endMarker}`);
  return app.slice(start, end);
}

assert.match(html, /id="optionalFeatureMigrationSurface"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="false"/, "startup/migration feedback should have a polite non-atomic persistent status mount");
assert.match(html, /id="optionalFeatureMigrationDialog"[\s\S]*aria-labelledby="optionalFeatureMigrationDialogTitle"[\s\S]*id="optionalFeatureMigrationChooseDetails"[\s\S]*id="optionalFeatureMigrationConfirmButton"/, "migration should use one accessible combined confirmation with an optional Choose view");
assert.match(html, /id="optionalFeatureMigrationDialogError"[^>]*role="alert"/, "terminal dialog errors should be alerts");

const refreshSource = sourceBetween("async function refreshOptionalFeaturePackageStatuses", "function clearGitFooterPayloadState");
assert.match(refreshSource, /api\("\/api\/optional-features", \{ scoped: false \}\)/, "browser refresh should consume the cached server snapshot");
assert.doesNotMatch(refreshSource, /showDirectoryPicker|FileSystem|local-resource|node_modules|\.pi\/agent/, "browser refresh must not scan the host");

const surfaceSource = sourceBetween("function renderOptionalFeatureMigrationSurface", "function applyOptionalFeatureMigrationSnapshot");
assert.match(surfaceSource, /Checking optional features…[\s\S]*elapsed[\s\S]*Core ready/, "surface should expose checking elapsed time and a truthful ready summary");
assert.match(surfaceSource, /Previous optional features need migration[\s\S]*Migrate…[\s\S]*Later/, "action-required migration should expose Migrate and persisted Later actions");
assert.match(surfaceSource, /safely excluded[\s\S]*Copy recommended fix[\s\S]*Recheck/, "conflicts should explain safe exclusion using a recommended path-free fix and recheck");
assert.match(surfaceSource, /started safely without optional companions[\s\S]*Recheck/, "degraded startup should remain core-safe and recheckable");
assert.match(surfaceSource, /noticeDismissKey[\s\S]*optionalFeatureMigrationDismissedNoticeKey === noticeDismissKey[\s\S]*surface\.hidden = true/, "a dismissed degraded snapshot should stay hidden for the current page lifetime");
assert.match(surfaceSource, /optional-feature-migration-dismiss[\s\S]*aria-label", "Close optional feature startup notice"/, "degraded startup should expose an accessible dismiss button");
assert.match(app, /function dismissOptionalFeatureMigrationNotice\(\)[\s\S]*optionalFeatureMigrationDismissedNoticeKey = key[\s\S]*renderOptionalFeatureMigrationSurface\(\)/, "the degraded dismiss action should hide the current snapshot through the existing renderer");
assert.match(surfaceSource, /Migrating optional features[\s\S]*Retry failed[\s\S]*Copy commands[\s\S]*Restart thread/, "progress and recovery should expose the required sequential/retry/copy/deferred-restart actions");
assert.match(surfaceSource, /if \(optionalFeatureRestartNotice\.restartDeferred\)[\s\S]*Restart thread[\s\S]*else[\s\S]*Dismiss/, "a deferred restart action must remain persistent until restart succeeds");
assert.match(surfaceSource, /optionalFeatureMigrationCompletionIsDismissed\(snapshot\)[\s\S]*surface\.hidden = true[\s\S]*phase === "complete"[\s\S]*dismissOptionalFeatureMigrationCompletion/, "dismissing a completed migration should hide the complete surface, not only its restart notice");
assert.match(surfaceSource, /setAttribute\("role", "alert"\)/, "only conflict/partial terminal feedback should add alert semantics");
assert.match(surfaceSource, /optional-feature-migration-completion-summary[\s\S]*card\.focus/, "completion summary should receive focus once");
assert.doesNotMatch(surfaceSource, /percent|% complete/i, "package-manager progress must not fabricate percentages");

const dialogSource = sourceBetween("function renderOptionalFeatureMigrationDialog", "async function copyFailedOptionalFeatureCommands");
assert.match(dialogSource, /selectedByDefault === true[\s\S]*isOptionalFeatureDisabled/, "server defaults should be preselected while browser-disabled features stay unselected");
assert.match(dialogSource, /Previously enabled[\s\S]*Previously disabled[\s\S]*source:/, "expandable details should explain previous state and sanitized source kind");
assert.match(dialogSource, /This is the only confirmation before retry|only confirmation before Pi installs/i, "dialog copy should make the single confirmation boundary explicit");

const batchSource = sourceBetween("async function installOptionalFeatureBatch", "function runPublishWorkflow");
assert.match(batchSource, /body: \{ tab: activeTabId, featureIds, revision: optionalFeatureMigrationSnapshot\.revision, migration \}/, "every batch apply should send tab, cached revision, and migration intent");
assert.match(batchSource, /staleRevision[\s\S]*refreshOptionalFeaturePackageStatuses[\s\S]*refreshedSignature !== candidateSignature[\s\S]*optionalFeatureRevisionChurn/, "stale revisions should refetch, re-show on material candidate changes, retry silently once, and recover repeated churn without false failures");
assert.match(batchSource, /error\.optionalFeatureCandidatesChanged \|\| error\.optionalFeatureRevisionChurn[\s\S]*restoreOptionalFeatureInstallStates[\s\S]*reopen/, "candidate changes and repeated stale revisions should restore untouched rows and reopen the plan");
assert.match(batchSource, /for \(const feature of candidates\)[\s\S]*result\?\.ok === true[\s\S]*optionalFeatureInstallFailureFromBatchResult/, "partial batches should preserve and settle every per-feature terminal result");
assert.match(batchSource, /output\.slice\(-4000\)|slice\(-4000\)/, "localhost response output should remain bounded before entering activity/row feedback");
assert.match(batchSource, /restart\.autoRestarted \|\| restart\.restartDeferred[\s\S]*optionalFeatureRestartNotice/, "batch response restart fields should drive visible restart feedback");
assert.doesNotMatch(batchSource, /const reloadMessage|await appConfirmText\([^)]*Reload the active Pi (?:tab|thread)/, "successful migration must not add a separate restart confirmation");

const eventSource = sourceBetween("function handleEvent(event)", "function connectEvents");
assert.match(eventSource, /webui_optional_feature_migration[\s\S]*applyOptionalFeatureMigrationSnapshot\(event\.snapshot\)/, "SSE migration snapshots should update reconnect-safe state");
assert.match(eventSource, /webui_optional_feature_restart_completed[\s\S]*webui_optional_feature_restart_deferred/, "SSE restart events should be consumed");
const progressRecoverySource = sourceBetween("function applyOptionalFeatureProgressStates", "function refreshOptionalFeatureMigrationElapsedText");
assert.match(progressRecoverySource, /progress\.restartDeferred === true[\s\S]*optionalFeatureRestartNotice/, "cached progress must rehydrate the deferred Restart action after a full browser reload");
assert.match(progressRecoverySource, /progress\.autoRestarted === true && !optionalFeatureMigrationCompletionIsDismissed\(snapshot\)[\s\S]*optionalFeatureRestartNotice/, "cached progress should rehydrate an undismissed completed restart notice");
assert.match(progressRecoverySource, /optionalFeatureMigrationCompletionIsDismissed\(snapshot\)[\s\S]*optionalFeatureRestartNotice = null/, "cached progress must not resurrect a dismissed completion notice");
assert.match(app, /OPTIONAL_FEATURE_MIGRATION_DISMISS_STORAGE_KEY[\s\S]*storedDismissedOptionalFeatureMigrationKey[\s\S]*localStorage\.setItem\(OPTIONAL_FEATURE_MIGRATION_DISMISS_STORAGE_KEY, key\)/, "completion dismissal should survive reloads in browser storage");
assert.match(app, /function handleSessionStreamOpen[\s\S]*refreshOptionalFeaturePackageStatuses\(\)/, "event-stream reconnect should recover the current cached server snapshot");
const elapsedTimerSource = sourceBetween("function refreshOptionalFeatureMigrationElapsedText", "function clearOptionalFeatureReadyDismissTimer");
const dismissalTimerSource = sourceBetween("function clearOptionalFeatureReadyDismissTimer", "function optionalFeatureMigrationAction");
assert.doesNotMatch(elapsedTimerSource, /renderOptionalFeatureMigrationSurface\(\)/, "elapsed ticks must not replace and re-announce the entire live region");
assert.match(elapsedTimerSource, /querySelector\("\.optional-feature-migration-detail"\)/, "elapsed ticks should update only the detail node");
assert.match(app, /const OPTIONAL_FEATURE_READY_AUTO_DISMISS_MS = 5_000;/, "a successful startup audit should remain readable briefly before dismissal");
assert.match(dismissalTimerSource, /scheduleOptionalFeatureReadyDismiss[\s\S]*setTimeout[\s\S]*optionalFeatureReadyDismissKey\(\) !== key \|\| optionalFeatureRestartNotice[\s\S]*surface\.hidden = true/, "ready feedback should auto-dismiss only while the same ready snapshot remains non-actionable");
assert.match(surfaceSource, /readyCanAutoDismiss[\s\S]*scheduleOptionalFeatureReadyDismiss\(readyCanAutoDismiss \? readyDismissKey : ""\)/, "rendering should schedule dismissal only for non-actionable ready feedback");

assert.match(css, /\.optional-feature-migration-surface[\s\S]*\.optional-feature-migration-dialog[\s\S]*@media \(max-width: 34rem\)/, "migration surfaces should have desktop and responsive styling");
assert.match(css, /\.optional-feature-migration-card:focus-visible/, "focused completion summary should have a visible focus treatment");
assert.match(css, /\.optional-feature-migration-card\.phase-degraded[\s\S]*padding-right:[^;]+;[\s\S]*\.optional-feature-migration-dismiss \{[\s\S]*position: absolute;[\s\S]*top:[^;]+;[\s\S]*right:[^;]+;/, "the degraded popup should reserve space for a top-right dismiss button");

assert.match(technical, /read-only startup audit/i, "technical reference should document startup auditing");
assert.match(technical, /--migrate-optional-features[\s\S]*--migration-dry-run/, "technical reference should document explicit unattended migration and dry-run flags");
assert.match(technical, /Retry failed[\s\S]*Copy commands[\s\S]*Recheck/i, "technical reference should document migration troubleshooting actions");

console.log("optional feature migration frontend static tests passed");
