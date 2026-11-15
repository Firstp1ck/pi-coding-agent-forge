import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fileService = await readFile(new URL("../lib/server/workspace-files.mjs", import.meta.url), "utf8");
const fileOwner = await readFile(new URL("../public/project-file-viewer-controller.mjs", import.meta.url), "utf8");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, css, pkg, server, payloadParser, optionalFeatureCatalog] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "public", "aur-review-payload.mjs"), "utf8"),
  readFile(join(root, "lib", "optional-feature-catalog.mjs"), "utf8"),
]);

assert.match(app, /const AUR_REVIEW_RPC_WIDGET_KEY = "aur-review:rpc"[\s\S]*AUR_REVIEW_RPC_PAYLOAD_PREFIX = "AUR_REVIEW_RPC_PAYLOAD "[\s\S]*AUR_REVIEW_RPC_PAYLOAD_TYPE = "firstpick\.pi-extension-aur-review\.review"[\s\S]*AUR_REVIEW_RPC_PAYLOAD_VERSION = 3/, "WebUI should identify the versioned AUR review payload");
assert.match(app, /parseValidatedAurReviewPayload[\s\S]*function parseAurReviewPayload\(lines\)[\s\S]*prefix: AUR_REVIEW_RPC_PAYLOAD_PREFIX/, "AUR review rendering should delegate parsing to the fail-closed payload module");
assert.match(payloadParser, /validTimestamp[\s\S]*Date\.parse\(payload\.createdAt\) > Date\.parse\(payload\.updatedAt\)/, "payload parsing should enforce ordered canonical timestamps");
assert.match(payloadParser, /stats\[key\] <= total[\s\S]*stats\.files !== total/, "payload parsing should enforce stats totals and bounds");
assert.match(payloadParser, /decision\.reviewedFingerprint !== payload\.fingerprint/, "payload parsing should bind terminal decisions to the snapshot fingerprint");
assert.match(payloadParser, /stagedPayload \? decision\.reviewedStagedContentHash !== payload\.stagedContentHash/, "payload parsing should bind staged terminal decisions to the staged-content hash");
assert.match(payloadParser, /payload\.changedFiles\.length >= payload\.changedFileTotal/, "payload parsing should reject equality at the truncated-file boundary");
assert.match(app, /function renderAurReviewWidget\(\)[\s\S]*Review changes[\s\S]*Refresh[\s\S]*Approve[\s\S]*Decline[\s\S]*Close[\s\S]*openAurReviewReportInViewer\(reportPath, payload\.repoRoot\)/, "renderer should open reports against the payload's repo root rather than the tab cwd");
assert.match(app, /payload\.origin === "guided-git" && payload\.scope === "staged" && payload\.decision\.state === "approved"[\s\S]*return null/, "an approved Guided Git staged review should close its manual review card");
assert.match(fileOwner, /async function openReport\(path = "", repoRoot = ""\)[\s\S]*\/api\/aur-review\/report-content[\s\S]*readOnly: true/s, "report viewing must use the narrow read-only canonical-root endpoint");
assert.match(app, /viewer\.readOnly === true \|\| !viewer\.dirty[\s\S]*viewer\.readOnly === true \|\| !viewerPath/s, "repo-root report views must not enable generic save or default-editor actions");
assert.match(app, /function aurReviewActionButton\(label, action, className = ""\)[\s\S]*action === "review"[\s\S]*openGitChangesDialog\(\)[\s\S]*`\/aur-review \$\{action\}`/, "Review changes should reuse the current Git diff dialog and other controls should call canonical extension commands");
assert.match(app, /aurReviewActionButton\("Approve", "approve", "primary"\)/, "Approve should delegate to the extension slash command, which owns native confirmation");
assert.match(app, /id: "aurReview"[\s\S]*packageName: "@firstpick\/pi-extension-aur-review"[\s\S]*capabilityLabel: "\/aur-review or aur-review:rpc widget event"/, "optional feature discovery should identify the companion by command or payload");
assert.match(app, /optionalFeatureAvailability\.aurReview = hasAvailableCommand\("aur-review"\)[\s\S]*widgets\.has\(AUR_REVIEW_RPC_WIDGET_KEY\)/, "feature availability should detect commands and replayed widget state");
assert.match(app, /if \(key === AUR_REVIEW_RPC_WIDGET_KEY\) return "aurReview"[\s\S]*key === AUR_REVIEW_RPC_WIDGET_KEY/, "generic widget fallback should be preserved while the AUR review payload gets a specialized renderer");
assert.match(css, /\.aur-review-widget \{[\s\S]*\.aur-review-actions[\s\S]*\.aur-review-file-list[\s\S]*@media \(max-width: 720px\)[\s\S]*\.aur-review-action,[\s\S]*\.aur-review-report/, "AUR review card should be styled responsively for desktop and mobile");
assert.equal(JSON.parse(pkg).optionalDependencies?.["@firstpick/pi-extension-aur-review"], undefined, "WebUI must not reference the unpublished review extension from clean npm installs");
assert.equal(JSON.parse(pkg).pi?.extensions?.some((entry) => String(entry).includes("pi-extension-aur-review")), false, "WebUI must not bundle an unpublished nested review extension path");
assert.match(optionalFeatureCatalog, /\["aurReview", "@firstpick\/pi-extension-aur-review", "\^0\.1\.1"\]/, "optional-feature catalog should retain the future/local review companion mapping without bundling it");
assert.match(server, /STATIC_PUBLIC_FILE_EXTENSIONS[\s\S]*"\.mjs"/, "server must serve typed browser modules from the public asset boundary");
assert.match(server, /STAGED_CONTENT_HASH_DOMAIN = "firstpick\/aur-review\/staged-content\/v1\\0"[\s\S]*git diff --cached[\s\S]*\/api\/git-workflow\/staged-content/, "server must expose the bounded read-only staged-content hash helper");
assert.match(fileService, /async function getAurReviewReportContentData\(tab, \{ path: requestedPath = "", repoRoot = "" \} = \{\}\)[\s\S]*repoRoot !== root[\s\S]*lstat\(targetPath\)[\s\S]*isSymbolicLink\(\)[\s\S]*readBoundedAurReviewReport/s, "server must bind report reads to the canonical Git root and reject symlinked paths in the Files owner");
assert.match(server, /url\.pathname === "\/api\/aur-review\/report-content" && req\.method === "GET"[\s\S]*getRequestedTab\(req, url\)[\s\S]*data: await getAurReviewReportContentData\(tab,/, "the read-only report route should call the Files owner with its requested tab");
assert.match(server, /entry\.name\.startsWith\("pi-"\)[\s\S]*packageNameForResourcePath\(path\.join\(candidate, "package\.json"\)\)/, "workspace optional-package discovery must recognize the pi-extension-aur-review sibling by manifest name");
assert.match(app, /const normalized = aurReviewSafePath\(path\);[\s\S]*projectFiles.openReport\(normalized, String\(repoRoot\)\)/);
console.log("aur review widget static tests passed");
