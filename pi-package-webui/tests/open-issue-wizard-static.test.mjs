import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, html, css, stateModule, botClient, server, serviceWorker, packageJson] = await Promise.all([
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../public/issue-wizard-state.mjs", import.meta.url), "utf8"),
  readFile(new URL("../public/issue-bot-client.mjs", import.meta.url), "utf8"),
  readFile(new URL("../bin/pi-webui.mjs", import.meta.url), "utf8"),
  readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
]);

assert.match(app, /from "\.\/issue-wizard-state\.mjs"/, "the browser controller must import the approved pure wizard module");
assert.match(app, /from "\.\/issue-bot-client\.mjs"/, "network behavior must live in a separate issue-bot client module");
assert.match(app, /createIssueWizardCatalog\(OPTIONAL_FEATURES\.map\(\(feature\) => feature\.label\)\)/, "optional feature labels must come from the existing catalog");
assert.match(app, /page\.hidden = step !== issueWizardState\.step/, "the controller must expose exactly one wizard page at a time");
assert.match(app, /action === "select-template"[\s\S]*item\.fields\.map\(\(field\) => field\.label\)/, "template choices must preview structured fields");
assert.match(app, /function focusIssueWizardChoice\([\s\S]*target\?\.focus/, "rerendered selections must preserve keyboard focus");
assert.match(app, /button\.setAttribute\("aria-pressed", selected \? "true" : "false"\)/, "selection buttons must keep toggle semantics");
assert.doesNotMatch(app, /setAttribute\("role", "radio(?:group)?"\)/, "the wizard must not advertise unimplemented radio keyboard semantics");
assert.match(app, /structuredIssueWizardState\(\)[\s\S]*?categoryId:[\s\S]*?fields:/, "the adapter must submit structured wizard state");
assert.match(app, /buildIssuePayload\(issueWizardState, issueWizardCatalog\)[\s\S]*?never send title\/body to the gateway/, "the canonical builder remains the review authority without becoming a network payload");
assert.doesNotMatch(app.match(/function structuredIssueWizardState\(\)[\s\S]*?\n}/)?.[0] || "", /\btitle\b|\bbody\b/, "structured submission must not add editable title/body fields");
assert.match(app, /new AbortController\(\)/, "submission and refresh calls must support cancellation");
assert.match(app, /issueWizardDialog\.addEventListener\("close", \(\) => clearIssueBotSubmission\(\{ abort: true \}\)\)/, "closing the dialog must abort the active request");
assert.match(app, /issueBotRequestActive/, "the wizard must prevent duplicate in-flight submissions");
assert.match(app, /issueBotSubmissionHandle\.refresh/, "bounded polling must retain an in-memory manual refresh path");
assert.match(app, /reasonCode === "sensitive_content"/, "sensitive outcomes must route to private guidance without reading submitted prose");
assert.doesNotMatch(app, /submitIssueToGithubBot/, "the old unavailable state-module seam must not handle browser network submission");
assert.match(stateModule, /export async function submitIssueToGithubBot[\s\S]*?status: "unavailable"/, "the pure state-module fallback remains offline by default");
assert.match(stateModule, /description: "[^"]+"[\s\S]*?fields:/, "template definitions must retain preview descriptions");
assert.match(app, /issueClipboardText\(payload\)/, "copy must include the complete title and body payload");
assert.doesNotMatch(stateModule.match(/export async function submitIssueToGithubBot[\s\S]*?\n}/)?.[0] || "", /\bfetch\s*\(/, "the pure fallback must perform no network I/O");

assert.match(botClient, /ISSUE_BOT_DEFAULT_RUNTIME_CONFIG[\s\S]*?enabled: false/, "public runtime configuration must be disabled by default");
assert.match(botClient, /schemaVersion: 1, idempotencyKey, turnstileToken, issue/, "admission must use the exact versioned structured envelope");
assert.match(botClient, /credentials: "omit"/, "browser requests must not send ambient credentials");
assert.match(botClient, /authorization: `Bearer \$\{statusToken\}`/, "only the status capability may authorize polling");
assert.match(botClient, /maxPollDurationMs = DEFAULT_MAX_POLL_DURATION_MS/, "polling must have a documented bounded duration");
assert.match(botClient, /Math\.min\(MAX_POLL_AFTER_MS, Math\.max\(delayMs \* 2/, "polling must apply bounded exponential backoff");
assert.match(botClient, /STATUS_TOKEN/, "the capability token must be shape-validated before use");
assert.doesNotMatch(botClient, /localStorage|sessionStorage|document\.cookie/, "the client must not persist drafts or capability tokens");
assert.doesNotMatch(botClient, /OPENAI_API_KEY|GITHUB_APP_|PRIVATE_KEY/, "the browser client must not contain service credentials");

assert.match(html, /__PI_WEBUI_ISSUE_BOT_CONFIG__[\s\S]*?enabled: false/, "the page must expose only disabled-by-default public runtime configuration");
assert.match(html, /id="openIssueButton"[\s\S]*?aria-controls="issueWizardDialog"/, "the persistent Control Deck action must target the dialog");
assert.match(html, /<footer class="side-panel-footer" data-control-deck-shared-footer data-visibility-region="control-deck">[\s\S]*?id="openIssueButton"/, "the singleton action must stay outside scrolling Control Deck content while rehosting with the active shell");
assert.match(html, /<dialog id="issueWizardDialog"[\s\S]*?aria-labelledby="issueWizardTitle"[\s\S]*?aria-describedby="issueWizardDescription"/, "the dialog must have an accessible name and description");
for (const step of [1, 2, 3, 4, 5]) assert.match(html, new RegExp(`data-issue-wizard-page="${step}"`), `step ${step} markup must exist`);
assert.match(html, /id="issueWizardStatus"[^>]*role="status"[^>]*aria-live="polite"/, "wizard progress must retain its accessible live region");
assert.doesNotMatch(html, /id="issueWizardProgress"[^>]*aria-live/, "the progress label must not duplicate live announcements");
assert.match(html, /id="issueWizardSubmissionStatus"[^>]*role="status"[^>]*aria-live="polite"/, "submission state needs a persistent dialog live region");
assert.match(html, /id="issueWizardSubmissionLink"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/, "confirmed issue links must prevent opener access");
assert.match(html, /id="issueWizardSecurityLink"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/, "private security guidance links must be safe");
assert.match(html, /id="issueWizardBotButton"[^>]*disabled[^>]*>Send</, "the bot control must be disabled until safe runtime configuration enables it");
assert.match(html, /id="issueWizardCopyButton"[^>]*>Copy complete issue</, "copy fallback must remain available");

assert.match(css, /\.side-panel-footer\s*\{[\s\S]*justify-content:\s*flex-end/, "the Control Deck action must anchor at the footer's right edge");
assert.match(css, /\.issue-wizard-dialog\s*\{[\s\S]*max-height:/, "the dialog must bound its height");
assert.match(css, /\.issue-wizard-pages\s*\{[\s\S]*overflow:\s*auto/, "wizard page content must remain scrollable");
assert.match(css, /\.issue-wizard-choice-description,[\s\S]*\.issue-wizard-choice-preview/, "template descriptions and field previews need dedicated styling");
assert.match(css, /\.issue-wizard-submission-status\s*\{/, "persistent bot status needs dedicated styling");
assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.issue-wizard-choice-grid/, "wizard choices must adapt for mobile");

assert.match(server, /STATIC_PUBLIC_FILE_EXTENSIONS[\s\S]*"\.mjs"/, "the server must serve typed wizard modules from the public asset boundary");
assert.match(serviceWorker, /"\/issue-wizard-state\.mjs"/, "the PWA shell must keep caching the pure wizard module");
assert.match(serviceWorker, /"\/issue-bot-client\.mjs"/, "the PWA shell must cache the browser client module");
// Intent preserved: changing the public startup graph advances the PWA cache identity.
assert.match(serviceWorker, /pi-webui-pwa-v155/, "the PWA cache name must change with browser wiring updates");
assert.match(packageJson, /node --check public\/issue-wizard-state\.mjs/, "the package check must keep syntax-checking the pure wizard module");
assert.match(packageJson, /node --check public\/issue-bot-client\.mjs/, "the package check must syntax-check the browser client module");

console.log("open-issue-wizard-static.test.mjs passed");
