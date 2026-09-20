# Development guide: Pi Web UI

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Tool and skill command ownership

WebUI does not register TUI `/tools` or `/skills` commands. The standalone `@firstpick/pi-extension-tools` and `@firstpick/pi-extension-setup-skills` packages own those commands and their Session, Global, and Model selector flow. Shared profile resolution, locking, and TUI selector components live in `@firstpick/pi-utils`. Browser-native tool and skill controls continue through `webui-rpc-helper.mjs` and the WebUI HTTP routes against the same saved state.

Focused contributor validation:

```bash
node tests/resource-tui-extension.test.mjs
```

## Append-system prompt picker contract

The browser exposes one global `APPEND_SYSTEM.md` override through the native selector flow in `public/app.js`:

- `openNativeAppendSystemSelector` opens the shared native command dialog, fetches `GET /api/append-system-files?tab=<id>` via `nativeCommandApi`, and renders the returned candidates through the shared `renderNativeSelectorItems` implementation (filter input and keyboard navigation included). Candidate labels are visible alias paths and warn that followed targets can be outside the displayed root. It marks the saved candidate `current`, marks `Use Pi default discovery` current when no valid override is saved, and shows an invalid saved `appendSystemPromptPath` as a disabled row with a diagnostic. Scan `diagnostics` render as a bounded note (first 20 entries, kind/path/message only); prompt file contents are never fetched.
- Selecting an item posts `POST /api/append-system-selection` with `{ tabId, path }` (`path: null` for Pi default discovery). The save itself never reloads a tab. Only a response with `changed: true` and `restartRequired: true` proceeds to `confirmAppendSystemRestart`, which asks through the shared `appConfirmText` confirmation and, on approval, reuses the standard active-tab reload path (`sendPrompt("prompt", "/reload", { targetTabId, throwOnError: true })`); reload errors are surfaced in the events log. Cancellation keeps the saved choice for the next manual reload or new tab.
- The command palette lists the action as `/append-system` so the flow stays reachable from the browser-native settings surface.

Endpoint data contract (server side owned by the discovery/persistence workstream): `GET /api/append-system-files?tab=<id>` returns `appendSystemPromptPath` (saved override or `null`), `roots` (`{ path, label }`), bounded `candidates` (`{ path, rootLabel }`), bounded `diagnostics` (`{ kind, path, message }`), and `limits`. Discovery follows symlinked roots, directory entries, and exact-visible-name file links, including external targets, while candidate identity remains the visible absolute alias. Canonical directory identities are internal cycle/deduplication keys only. A provenance-valid global choice outside the active tab's roots is included as one deduplicated `Saved selection` candidate. `POST /api/append-system-selection` accepts `{ tabId, path }` and returns the same scan payload plus `changed` and `restartRequired`; it never returns file contents. Changed selections must be candidates of a fresh active-tab scan, while the exact provenance-valid saved path may be submitted unchanged from another project.

The exact lexical global Pi default `path.join(homedir(), ".pi", "agent", "APPEND_SYSTEM.md")` is excluded during discovery before candidate-limit accounting. Existing and submitted selections equal to it are normalized to `null` default discovery, so they do not produce an invalid saved row or `--append-system-prompt` override. No other global, nested, or project-local candidate is excluded.

Private settings persist both `appendSystemPromptPath` and its lexical `appendSystemPromptRootPath`. Child launch revalidates lexical containment, the exact visible name, the depth-10 bound, and the final followed target's regular-file status. The followed target may be outside the saved root, while the visible saved alias is passed unchanged to Pi. Broken, inaccessible, and non-regular targets fail closed. This intentionally allows a link to scan or load a prompt outside the two visible roots; canonical target identity is not persisted, and the accepted retargeting/validation-to-open race remains.

Each successful WebUI-managed Pi launch captures its validated selected path as tab-local runtime metadata. `tabMeta.prompt` and detached-supervisor metadata use only `null` or `{ "kind": "append-system", "path": "<absolute visible path>" }`. The path is capped at 4096 characters and cannot contain C0 control characters (`U+0000`–`U+001F`) or DEL (`U+007F`); restored values must also have exactly those two fields, the known kind, and an absolute path, or normalization returns `null`. Discovery omits candidates with those controls, and fresh or restored selections containing them fail closed. Tabs created by older builds therefore restore without a custom-prompt claim. Supervisor hydration retains valid descriptors, while supervised replacement stays atomic and direct create, working-folder replacement, and full reload update the live tab only after the child emits its successful spawn event.

Direct-mode `pi_process_start` is emitted from that child `spawn` event. A failed spawn emits `pi_process_error` without a preceding start. A failed direct working-folder replacement retains the prior live cwd and prompt descriptor and leaves cwd-dependent watcher subscriptions on that prior cwd; cwd, activity, prompt, and watcher publication move together only after the replacement spawn succeeds.

This descriptor comes directly from the validated saved selection used while constructing that process launch. It is never reconstructed from current global settings or by scanning final child arguments, so later selection changes do not rewrite existing tabs and arbitrary launcher `--append-system-prompt` values remain outside this contract. Prompt file contents, inline launcher text, and unrelated arguments are not copied into the descriptor.

Focused contributor validation:

```bash
node tests/append-system-selection.test.mjs
node tests/append-system-http.test.mjs
node tests/append-system-selector-static.test.mjs
```

## Web UI settings write lock

`updateWebuiSettings` serializes same-process updates and uses per-writer records under `<settings-file>.lock` for cross-process writes. A process can exit after creating its record but before writing valid JSON, leaving an empty file. Lock acquisition removes incomplete records immediately when their PID is dead. It gives a live writer a one-second grace period, then removes records that are still empty or malformed so one interrupted write cannot block every later settings save.

Focused contributor validation:

```bash
node tests/webui-settings-locking.test.mjs
```

## File viewer image contract

`GET /api/files/content` keeps workspace-path confinement and the shared 2 MiB `FILE_VIEWER_MAX_BYTES` cap before reading either text or images. Text responses use `kind: "text"` with UTF-8 `content` and `language`. The explicit extension allowlist maps `.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`, and `.avif` to fixed MIME types; those responses use `kind: "image"`, `mimeType`, and base64 `data` without decoding the bytes as UTF-8. SVG and all unlisted binary formats continue to return `415` through the text/binary guard.

The browser accepts the same fixed MIME allowlist, creates an in-memory data URL, and renders it only in the dedicated `fileViewerImage` surface. Image viewer state is read-only with Source, Save, text search, and text-selection sending unavailable. Git opens may retain Changes mode and switch back to the image preview. Reset and non-image rendering remove the image element's `src` and alternative text so stale payloads are not retained in the DOM.

Focused contributor validation:

```bash
node --check public/app.js
node --check bin/pi-webui.mjs
node tests/file-viewer-image-static.test.mjs
node tests/git-panel-file-preview-static.test.mjs
node tests/file-viewer-search-static.test.mjs
node tests/http-endpoints-harness.test.mjs
```

## Main output loading feedback

Every `refreshMessages(tabContext)` call acquires its own object token in `mainOutputLoadingRequests` before requesting a transcript snapshot or delta and releases that exact token in `finally`. Visibility is derived only from tokens whose copied tab context still matches the active tab generation. This prevents an old tab response or one of several overlapping refreshes from hiding the current request’s status.

The transcript receives `aria-busy` immediately. The inline `#mainOutputLoading` status waits 120 ms before becoming visible, avoiding flashes on fast local responses while preserving polite assistive-technology state. It shares `.footer-status-host` with `#statusBar` and is positioned absolutely above the footer, so showing it does not resize the transcript. The newest active request supplies the visible label and updates it as the request checks for a delta, falls back to a complete transcript, and renders the result.

The status remains non-modal and pointer-transparent. Cached transcript content and controls remain interactive while the overlay is visible. The global reduced-motion policy reduces its spinner to one effectively static iteration. Dedicated subagent output hides this main-transcript status.

Focused contributor validation:

```bash
node --check public/app.js
node tests/main-output-loading-static.test.mjs
```

The focused test protects DOM/ARIA semantics, plain-language stage labels, tab-generation and overlap ownership, `try`/`finally` cleanup, non-modal styling, reduced motion, placement above the footer in standard and Sidebar layouts, dedicated-subagent hiding, documentation, and browser/PWA cache revisions.

## Fenced code syntax highlighting

`public/syntax-highlight.mjs` is a dependency-free leaf module with no imports and no DOM access. It exports `MAX_SYNTAX_HIGHLIGHT_CHARACTERS` (50,000), `MAX_SYNTAX_HIGHLIGHT_LINES` (2,000), `SYNTAX_LANGUAGE_ALIASES`, `SUPPORTED_SYNTAX_LANGUAGES`, `normalizeSyntaxLanguage(language)`, and `tokenizeCode(code, language)`.

`tokenizeCode` returns an array of `{ type, text }` objects using a closed vocabulary: `plain`, `comment`, `keyword`, `function`, `variable`, `string`, `number`, `type`, `operator`, and `punctuation`. Twenty-three canonical profiles are driven by declarative data (keyword/type sets, comment prefixes, quote and section rules) plus dedicated bounded scanners for diff and markup. Alias lookup uses `Object.prototype.hasOwnProperty` so inherited names such as `constructor` or `__proto__` cannot resolve to a profile.

### Invariants

- **Source fidelity.** Concatenating every emitted token's `text` reproduces the normalized source string exactly. Adjacent same-type tokens are coalesced and empty tokens are never emitted. This keeps copy, transcript search, and text selection byte-identical to the previous plain rendering.
- **DOM safety.** `appendMarkdownCodeTokens` in `public/app.js` renders `plain` tokens as `document.createTextNode(...)` and every other token as `make("span", ...)`, which assigns `textContent`. No source string reaches `innerHTML`, `insertAdjacentHTML`, or `transcriptRenderer.replaceHtml`, so HTML-looking code such as `<img onerror=...>` stays inert text.
- **Bounded cost.** Tokenization is a single linear scan with no backtracking-prone regular expressions. Input above either cap returns one exact `plain` token, which bounds repeated re-tokenization of an open fence during streaming reconciliation.
- **Graceful fallback.** An unknown or missing language returns one exact `plain` token, so unrecognized fences render exactly as before.

### Integration points

`appendMarkdownCodeBlock` is the only call site; the Mermaid branch runs first and is unchanged. `applyTheme` maps the nine Pi theme syntax tokens (`syntaxComment` … `syntaxPunctuation`) to `--syntax-*` CSS custom properties, and `public/styles.css` colors `.markdown-code .syntax-*` from those variables with `var(--ctp-*)` fallbacks for the pre-theme paint. Because the module is imported eagerly by `public/app.js`, `/syntax-highlight.mjs` must stay in the service-worker `APP_SHELL`; `tests/syntax-highlighting-static.test.mjs` enforces that closure for every eagerly imported `./*.mjs` specifier.

### Testing

```bash
node tests/syntax-highlight.test.mjs
node tests/syntax-highlighting-static.test.mjs
```

`tests/syntax-highlight.test.mjs` covers all 23 profiles and 58 aliases with exact round-trip assertions, representative token classes, prototype-pollution-style alias names, malicious-looking markup source, non-string input, and exact/over-limit character and line boundaries. `tests/syntax-highlighting-static.test.mjs` covers renderer wiring, the absence of HTML sinks, theme-token mapping against `THEME_TOKEN_GROUPS`, CSS fallbacks, app-shell closure, asset/cache revision coherence, and documentation coverage. When changing browser assets, advance `styles.css?v=`, `app.js?v=`, and `CACHE_NAME` together; several static tests assert those exact values.

## RPC delta and final-message contracts

`createToolCallStreamTracker` in `public/stream-output-controller.mjs` tracks tool identities and argument previews by message-local `contentIndex`. It accepts current `toolcall_start` IDs/names and legacy indexed partial snapshots, and retains identity across bare argument deltas. Unidentified calls stay hidden until metadata arrives, normally in `toolcall_end` on Pi 0.84. Intercom calls remain hidden and their argument text is not retained. Each message holds at most 128 calls with at most 262,144 UTF-16 code units per argument preview; excess live data waits for the completed transcript. Message boundaries and browser stream resets clear this state independently of transient card removal.

`lib/thinking-stream-recovery.mjs` only fills missing `thinking_end` content from active deltas. Explicit block snapshots, including empty and shortened text, replace the draft. `message_end.message` passes through unchanged, and fetched history bypasses streaming recovery. The server retains no completed-thinking cache. Normal and compact browser renderers clear an existing thinking surface on an explicit empty block correction.

Focused checks are `node --test tests/tool-call-stream.test.mjs tests/thinking-stream-recovery.test.mjs tests/fast-output-live.test.mjs` and the Chromium Intercom conversation-viewer test. The latter emits metadata only on the tool start, then bare argument deltas, and checks that no Intercom content flashes in the main transcript.

## Streaming performance diagnostics and workloads

The bounded frame queue in `public/stream-output-controller.mjs` emits timing fields only when an `onDiagnostic` hook is installed. Receipt timestamps survive adjacent-delta merges, and each `batch` record includes the oldest source event's `maxAgeMs` plus synchronous sink/follow work as `drainMs`. The controller accepts injectable frame, pressure-task, and clock hooks for deterministic tests; when diagnostics are disabled, it performs no clock reads. Supported message-update envelopes are measured by a JSON-equivalent UTF-16 walker, and adjacent delta merges add only escaped payload bytes while adopting the latest envelope. Unknown structured values retain a conservative one-time serialization fallback.

Primary queue entry/byte limits are unchanged. First non-coalescible pressure may occupy one explicit urgent entry (at most one primary byte-limit event) and schedules a zero-delay pressure task rather than rendering inside the EventSource callback. A second same-task pressure event synchronously drains primary then urgent entries in source order. Semantic barriers, cancellation, owner checks, and oversize direct application retain synchronous lossless behavior. `pendingCount()`, `pendingBytes()`, and `limits()` include the urgent slot explicitly.

`public/stream-render-scheduler.mjs` owns the independently tested normal text/thinking formatting cadence. The first eligible output renders immediately; sustained requests are latest-wins at a measured 40 ms interval. `text_end`, `thinking_end`, tool/lifecycle boundaries, output-mode transitions, reconnect/disconnect, user cancellation, and visibility transitions synchronously flush pending formatting. Compact mode keeps its independent 100 ms scheduler. Follow-scroll is requested only after the corresponding normal formatter has committed its DOM update.

The browser's existing local-only stream isolation ledger is enabled with `?streamIsolationDebug=1` or `globalThis.__PI_STREAM_ISOLATION_DEBUG__ = true` before app startup. Ledger version 2 keeps bounded records and adds high-water counters for batch latency/drain duration, receipt-to-next-paint opportunity, transcript/current-message DOM nodes, derived-text scan bytes/time, syntax-tokenization bytes/time, Markdown commit duration, mutable-tail bytes/kind, long tasks, long animation frames, focus loss near stream batches, detached-mode scroll movement, render scheduler flush/defer counts, and pressure-deferred/synchronous-fallback counts. Unsupported Performance Observer entry types fail closed and leave their counters at zero. No records leave the browser.

`public/stream-derived-output.mjs` owns the pure incremental todo/thinking/final-output state. Normal text deltas scan only their appended suffix. Snapshots, output-mode changes, reconnect/disconnect, settlement, todo-capability changes, and any derived-prefix divergence rebuild from the full authoritative parser. Debug mode shadows each incremental result against that parser; `derive-fallback` and `derive-shadow-mismatch` ledger records expose recovery, while `derive.bytes` reports the code units actually scanned rather than the accumulated message size. `tests/stream-derived-output.test.mjs` checks authoritative equivalence at every code-unit split across todo, fence, CRLF, nested/consecutive thinking, channel-tag, partial-delimiter, and Unicode cases.

`public/stream-markdown-tail.mjs` advances blank-line and fenced-block boundaries from only the appended suffix. `transcript-renderer.mjs` retains that opaque scanner state per surface and remains the sole mutation/selection owner. Incomplete fences use one mounted plain-code subtree and never invoke syntax tokenization or Mermaid rendering; closing the fence or completing text/thinking performs the authoritative Markdown render once. Ambiguous non-code tails above 16 KiB use one append-only plain live node until a safe boundary or completion restores full Markdown semantics. Divergence resets the scanner and renderer authoritatively. `markdown-commit` diagnostics expose `boundaryScannedChars`, `reusedTail`, and `authoritative` for count-based checks.

Deterministic generators in `tests/fixtures/streaming-workloads.mjs` cover small text deltas, long unbroken paragraphs, open fences below and above syntax-highlight bounds, thinking streams, mixed semantic barriers, non-coalescible overflow bursts, hidden-tab/foreground reconciliation, and 1,000 retained messages alongside an active stream. `tests/stream-output-workloads.test.mjs` verifies exact output, order, source accounting, queue bounds, latency fields, oldest-receipt preservation, oversize-event behavior, retained-transcript immutability, authoritative hidden-output catch-up, and zero diagnostic-clock reads when instrumentation is disabled.

Focused contributor validation:

```bash
node --check public/app.js
node --check public/stream-derived-output.mjs
node --check public/stream-markdown-tail.mjs
node --check public/stream-output-controller.mjs
node --check public/stream-render-scheduler.mjs
node tests/stream-derived-output.test.mjs
node tests/stream-markdown-tail.test.mjs
node tests/transcript-markdown-tail.test.mjs
node tests/stream-render-scheduler.test.mjs
node tests/stream-output-controller.test.mjs
node tests/stream-output-workloads.test.mjs
node tests/stream-output-isolation-static.test.mjs
node tests/streaming-ui-coupling.test.mjs
```

For a reproducible Chromium sample with the opt-in ledger enabled, close unrelated CPU-intensive work and run:

```bash
npx playwright test --project=chromium tests/browser/stream-output-isolation.spec.mjs --grep "Chromium streaming baseline"
```

The focused baseline tests exercise hidden-tab authoritative recovery and a 1,000-message transcript with a 1,000-delta active fenced-code stream. The runner preserves the `WS0_STREAMING_BASELINE` record and also prints `WS2_STREAMING_CANDIDATE` with boundary-scan characters, authoritative/reused-tail commits, and total Markdown/tokenization durations. The deterministic WS2 gates require one authoritative tokenizer call for the closed fence and no committed-prefix boundary rescan; event order, output hash, focus, and detached scroll remain strict.

The separate `WS3 paced cadence and slow-renderer queue pressure remain bounded` Chromium case emits 1,000 indexed text deltas in paced chunks, then an alternating non-coalescible burst while injecting an 8 ms frame delay. It prints `WS3_STREAMING_CANDIDATE` with transport/batch/render counts, receipt-to-paint samples, pressure fallback counts, queue high-water, exact output hash, and continuity counters. Deterministic gates require cadence deferral, fewer formatting flushes than source applications, one bounded urgent entry, both deferred and repeated-pressure fallback paths, exact index/hash continuity, and zero focus or detached-scroll regressions. Preserve these JSON records with command exit codes in the workstream handoff. Durations are local measurements rather than CI gates and may vary with host load.

`tests/stream-markdown-tail.test.mjs` reference semantics are the authoritative specification of the streaming boundary behavior going forward, anchored by the browser exact-output hash gate.

## Intercom conversation projection and viewer

`GET /api/intercom/conversations?tab=<tab-id>` projects bounded summaries from `SessionManager.getBranch()` for the selected server-owned session. Adding `conversation=<opaque-id>` returns one sanitized detail. Browser values never select a session path. The pure projector in `lib/intercom-conversations.mjs` accepts only structured generic Intercom records and matched native supervisor request/reply records, deduplicates protocol identities, excludes synthetic relays and attachments, and applies conversation/message/text/response bounds before serialization.

`lib/intercom-transcript-filter.mjs` is the separate normal-transcript boundary. Before HTTP delta slicing, it removes structured `intercom_message` records, generic `intercom` tool-call parts, and results paired by explicit call ID or tool name. It copies only changed mixed assistant records and preserves unrelated meaningful content without mutating the RPC response. Live stream and execution guards in `public/app.js` prevent an Intercom card or event-log line from flashing before the filtered authoritative refresh; unrelated supervisor and tool activity keeps the existing path. The conversation endpoint still reads raw active-branch records independently.

`public/app.js` keeps only in-memory per-tab summaries. `refreshIntercomConversationSummaries` uses tab-generation and request-serial guards; `refreshIntercomConversationDetail` adds a separate serial plus a five-second open-dialog refresh. Switching tabs or closing the native dialog invalidates pending detail responses and cancels its timer. The renderer rebuilds message bubbles only from normalized `direction`, participant name/ID, text, and timestamp fields, assigning text with safe DOM APIs. It never renders server records wholesale. The footer tag group uses a reversed inline strip capped at 50 percent of the desktop prompt row, so the newest conversation starts at the right edge and older tags extend toward the middle. Direct tags are capped at 13rem. A `ResizeObserver` measures complete tag widths and reserves space for `+X`; tags that do not fit move into a bounded popup above the composer. Narrow layouts give the strip the full row and keep 44-pixel targets in the popup. Escape, outside clicks, and focus changes close the popup. Each reused direct or popup button stores a compact label/count signature, so unchanged tags retain their children instead of retriggering the polite live region.

### Tagged local-model thinking

Some OpenAI-compatible local models stream reasoning inside an outer `<think>…</think>` text region instead of emitting native thinking events. The browser parser treats balanced inner `<think>…</think>` examples as nested delimiters, so a literal tag pair in the reasoning cannot prematurely terminate the outer block and leak the remainder into final output. While the outer close has not arrived, streaming remains in the incomplete-thinking state.

`tests/thinking-format-parser.test.mjs` executes the browser helpers against completed, streaming, nested-literal, consecutive-block, and channel-style fixtures.

Focused contributor validation:

```bash
node tests/thinking-format-parser.test.mjs
node tests/intercom-transcript-filter.test.mjs
node tests/intercom-main-transcript-suppression-static.test.mjs
node tests/intercom-tag-layout-static.test.mjs
node tests/intercom-conversations.test.mjs
node tests/intercom-conversations-http.test.mjs
node tests/intercom-conversation-viewer-static.test.mjs
node --check public/app.js
npx playwright test --project=chromium tests/browser/intercom-conversation-viewer.spec.mjs
```

The static viewer test covers singleton DOM/ARIA wiring, one-tag-per-ID rendering, endpoint scoping, summary/detail stale-response guards, open-dialog polling cleanup, safe text assignment, responsive reachability, asset revisions, and user/developer documentation. The Chromium flow exercises dialog focus restoration, safe peer/local bubbles, open-dialog refresh, Escape, and narrow composer-disclosure reachability against a persisted fixture session.

## Reviewer launch-slot admission

`webui-rpc-helper.mjs` owns the runtime boundary around the pure policy in `lib/subagent-launch-policy.mjs`. On `session_start` and session-tree replacement it reads one effective project-scope launch-slot snapshot, computes `subagentLaunchSlotRevision(...)` from the same settings value, increments a helper generation, and clears prior permits. Read failure clears the roles, revision, guidance, and permits instead of retaining stale authorization. Saves do not mutate the loaded snapshot.

The helper registers `approve_subagent_model_deviation` with a closed TypeBox object: literal role `reviewer`, one-based occurrence 1–8, requested model up to 280 characters, and reason up to 500 characters. The execute path trims the requested model and reason, rejects blanks, and requires an exact `true` result from interactive `ctx.ui.confirm`; missing UI or rejection fails closed. Its process-local permit record also contains a random ID, snapshot revision, helper generation, creation time, and two-minute expiry. At most eight unused permits are retained; reasons are not appended to session custom state or returned in permit details.

The `tool_call` hook prunes expired or stale-generation permits before every `subagent` and `subagent_gate` preflight, then supplies only bounded descriptors to `applySubagentLaunchSlotDefaults`. After snapshot-read failure, reviewer-bearing structured launches and every opaque `workflowScript` fail closed until a later session reload succeeds; non-reviewer direct launches retain their prior behavior. A non-empty `report.blocked` returns `{ block: true, reason }` before execution and leaves every directly matched permit intact, so a partially permitted multi-child request cannot consume authorization when another child blocks the whole request. When the entire direct request is admitted, only `consumedDeviationIds` are removed. Direct admission spends those permits even if downstream execution fails.

If the pure policy creates a workflow wrapper, every active descriptor, including its bounded `expiresAt`, is embedded and leased by removal from helper memory immediately. Leasing spends the permit even if the workflow never consumes it or later fails. The generated adapter rechecks expiry at use time, enforces occurrence/model matching and one-use consumption, and isolates supplied workflow source in a separately constructed async function whose only wrapper-provided value is the guarded `runs` adapter. Wrapper ownership is tracked outside model-controlled source rather than by trusting a marker comment. Cloned occurrence and permit state commits only after the original `runs.run` or `runs.all` returns without a synchronous validation error; later asynchronous/downstream failure does not restore it.

This layer does not rewrite explicit reviewer mismatches. Omitted defaults and explicit non-reviewer behavior continue through the pure policy. `runs.all` receives transactional preflight in the generated adapter, while separate sequential `runs.run` calls cannot roll back a child that started before a later mismatch.

Focused contributor validation:

```bash
node tests/subagents-helper.test.mjs
node --check webui-rpc-helper.mjs
git diff --check -- README.md TECHNICAL.md DEVELOPMENT.md
```

## Unified subagent observability

The server emits browser overview version 2 with `groups[]` (`tab` or `external`), each containing logical `runs[]` and canonical `agents[]`. Agent rows carry stable instance/run identity, launcher, provider, lifecycle status, capabilities, and an opaque output reference. Compatibility fields (`tabs`, `totalRuns`, `totalAgents`, `runningRuns`, `runningAgents`, and `totalGates`) remain during the v1 skew window. The browser prefers v2 groups and normalizes v1 tabs as a fallback.

Canonical lifecycle values are `queued`, `running`, `stale`, `lost`, `done`, `failed`, and `cancelled`. Launchers are `sdk`, `pi-rpc`, `pi-json`, `pi-print`, `interactive`, `tmux`, `pi-subagents`, `schedule`, `gate`, `workflow`, and `custom`. Counts use parent-scoped canonical instance IDs; groups, runs, workflow containers, and gate references are count-neutral. The browser recognizes the model-less `pi-subagents` `workflow` controller as a container projection, renders it with native `details`/`summary` disclosure semantics, and derives displayed counts from its child agents. Exact parent session identity maps an observation to a WebUI tab; all other valid instances are grouped as `external`.

Before accepting requests, the HTTP server snapshots inactive registry identities and filters the first canonical and v1 helper snapshots for each restored tab. Rows already stale, lost, or terminal in those startup snapshots stay suppressed; a later active transition releases that identity, and newly observed terminal rows remain available for same-generation inspection. This prevents restart replay from rematerializing old terminal views without deleting producer registry records or changing normal inspection and dismissal behavior.

The browser opens both overlay and view-only terminal modes through `GET /api/subagents/output?group=<group-id>&run=<run-id>&agent=<instance-id>`. Helper, session JSONL, structured event, plain-log, and metadata-only output dispatch stays server-owned. Mutations use the canonical group/run/agent selection and are checked against owner capabilities; no browser value is interpreted as a host path. Provider snapshots use the process-local `firstpick:webui-agent-runs:v1` event. SDK extensions may use `trackPiAgentSessionEventBus`, which owns only observation (not the session), emits complete canonical snapshots, heartbeats while running, and exposes bounded observation errors. In v1, a producer removal ID is producer-wide: it removes that instance ID across every parent scope owned by that producer. Cross-process records live in the scope-bound private registry. See `lib/agent-run-protocol.mjs`, `lib/agent-run-registry.mjs`, `lib/agent-run-adapters.mjs`, `webui-rpc-helper.mjs`, and the subagent aggregation/output handlers in `bin/pi-webui.mjs`.

Focused contributor validation:

```bash
node --check public/app.js
node tests/subagent-workflow-section-static.test.mjs
node tests/subagent-observability-static.test.mjs
node tests/mobile-static.test.mjs
node tests/agent-run-protocol.test.mjs
node tests/agent-run-registry.test.mjs
node tests/agent-run-adapters.test.mjs
node tests/agent-run-launcher.test.mjs
node tests/subagents-helper.test.mjs
node tests/subagent-reliability-integration.test.mjs
node tests/http-endpoints-harness.test.mjs
npx playwright test --project=chromium tests/browser/subagent-observability.spec.mjs
```

## Git footer advanced model picker

The footer picker keeps presentation state browser-local under `pi-webui-footer-scoped-model-layout-v1`; only normalized `flat` and `advanced` values are accepted. Storage events adopt the value across same-origin tabs without a settings write. The context-menu checkbox names the destination layout: **Toggle advanced** in flat mode and **Toggle Simple** in advanced mode. Advanced rendering groups `orderedFooterScopedModels()` by provider, sorts only the provider groups, and retains the existing order inside every group. Provider containers are labelled ARIA groups, and option buttons carry stable provider/model indices for clamped directional focus movement.

Advanced options use a roving tab stop. Arrow, `Home`, and `End` keys move focus only; `Enter` and `Space` call the existing model-selection path, while `Escape` closes and restores the footer trigger. Pointer drag and `Alt+ArrowUp` / `Alt+ArrowDown` listeners remain in the flat branch only. The desktop picker uses intrinsic provider-column width, temporarily escapes the chat-panel clip, and raises the workspace stacking context above side panels. Keyboard help uses inline-size containment so it wraps to the picker width without its full sentence widening the popup. Its width is capped to a viewport gutter and the provider row becomes internally scrollable at that cap. Narrow-screen groups stack vertically, so neither layout creates page-level horizontal overflow.

Focused validation:

```bash
node tests/git-footer-context-menu-static.test.mjs
node --check public/app.js
npx playwright test tests/browser/footer-model-advanced-layout.spec.mjs --project=chromium
```

The static contract covers Model-only menu visibility, normalized persistence and storage adoption, grouping, semantics, keyboard behavior, flat reorder isolation, bounded side-panel overlay stacking, and responsive CSS hooks. The Chromium fixtures cover toggle synchronization/reload, group and model order, directional focus, model application, `Escape` focus restoration, flat `Alt+Arrow` and pointer selection, narrow-viewport overflow, intrinsic sizing with one, three, and six providers, and a ten-provider case that verifies viewport capping, side-panel overlap, paint order, and horizontal scrolling.

## Control Deck side-panel architecture

The durable interface envelope is schema version 3 and the private Web UI settings envelope is version 8. `layout.sidePanel` contains `placement`, atomic `sectionLayout` (`order` plus `leftSectionIds`), `collapsedSectionIds`, `hiddenSectionIds`, side-specific `collapsedPanels`, and side-specific `panelWidths`. Validation rejects unknown patch fields, duplicate section IDs, left IDs absent from the global order, invalid placements, and widths outside 320–4096 pixels. Version-1 reads migrate to right placement, no left assignments, right-only legacy collapse/width, and preserve every unrelated layout field; stale version-1 writes are rejected. Version-2 reads migrate to version 3 by adding the default `controlVisibility` field (`hiddenIds: null`) while preserving every existing layout field.

`public/index.html` owns one left shell, one central workspace wrapper, and one right shell. Each `[data-side-panel-section]` remains a singleton. `reconcileControlDeckHosts()` is the only desktop/combined owner: it derives Right/Left/Both/overlay presentation, moves canonical sections without cloning, rehosts singleton version/Edit/Open Issue chrome, and leaves latent side assignments unchanged. Sidebar tab placement remains orthogonal: Right puts the terminal rail before the chat and the Control Deck after it, Left reverses those sides, and Both retains both Control Deck shells with the terminal rail after the chat. The central `.workspace-column` independently composes chat, split terminal, and file viewer. Mobile Experience v2 may temporarily project canonical section content only while the combined Control Deck is closed; opening the canonical overlay unmounts that projection first.

The browser structural cache is `pi-webui-control-deck-layout-v2`. Updates are read-modify-write by named subfield. Storage events and server snapshots adopt only clean siblings; active section drag fences `sectionLayout`, active panel resize fences `panelWidths`, and dirty siblings remain local. New pending records use the v4 prefix and immutable record version 4. Startup also reads old v3 records and translates `sectionOrder`, `collapsedSectionIds`, `hiddenSectionIds`, and `collapsed`; the old key remains until the translated mutation is acknowledged. Revision-guarded PUTs retry one conflict. A right-width patch includes both v2 `panelWidths.right` and legacy `sidePanelWidth` in the same locked request; left width never writes the legacy mirror.

Control-visibility setup has no second registry or persistence path. Its five fieldsets and 24 native checkboxes are generated from `CONTROL_VISIBILITY_GROUP_LABELS` and `CONTROL_VISIBILITY_CATALOG`; Send remains absent from that catalog. Checkbox changes call `setControlVisibilityHidden` immediately. Setup quick actions call the existing show-all (`hiddenIds: []`) and reset (`hiddenIds: null`) paths, and every `applyControlVisibility` refreshes an open dialog so local writes, acknowledgements, snapshots, and storage events stay synchronized. Visibility application changes only `.webui-user-hidden`, leaving capability-owned `hidden` state authoritative. Dialog close restores a surviving opener or falls back to the prompt when the opener was hidden.

### Control Deck validation map

- `tests/control-deck-side-panels-static.test.mjs`: singleton DOM/ARIA, host reconciler, workspace/rail geometry, journal and field-aware cache contracts.
- `tests/side-panel-section-reorder-static.test.mjs`, `tests/side-panel-resize-static.test.mjs`, and `tests/persistent-ui-layout-static.test.mjs`: movement, workspace-facing resize handles, independent left/right width and collapse, pending, and reconciliation behavior.
- `tests/browser/control-deck-side-panels.spec.mjs`: placement matrix, right/left/both Control Deck resizing, Sidebar rail swapping and resizing, cross-side keyboard movement, independent collapse/width persistence, overlay, singleton ARIA, and reload.
- `tests/browser/persistent-ui-layout.spec.mjs`: schema-v3 server ownership, stale reads, failed writes, conflicts, cache clearing, and restart.
- `tests/control-visibility-static.test.mjs` and `tests/browser/control-visibility.spec.mjs`: stable visibility catalog, generated setup markup and grouping, both **Open setup** paths, immediate checkbox persistence and reload, dialog synchronization, Send exclusion, capability-gating composition, quick-action `[]`/`null` semantics, focus fallback, narrow-viewport scrolling, grouped/direct context menus, keyboard recovery, tag categories, and composer reflow.

Run focused validation with `node --check public/app.js`, the static tests above, and `npx playwright test --project=chromium tests/browser/control-deck-side-panels.spec.mjs tests/browser/persistent-ui-layout.spec.mjs tests/browser/control-visibility.spec.mjs`. Run `npm run check` and `npm test` before integration acceptance.

1. `POST /api/update/plan` resolves moving release metadata once, records exact target versions, active runtime identities, proven owners, exact argument-array commands, refusals, and a SHA-256 plan digest in the private update journal.
2. The confirmation names that exact plan digest. `POST /api/update/apply` accepts only its `transactionId` and `planDigest`; it never accepts paths, commands, registries, versions, or `latest` from the browser.
3. Apply acquires the cross-process install lock, revalidates active identities, executes with whole-process-tree timeouts, re-reads every changed target, and records ordered receipts with `success`, `partial`, `failed`, or `rolled-back` outcomes.
The authenticated `GET /api/interface-preferences` response includes normalized `preferences`, versioned `layout`, and an opaque `layoutRevision`. `PUT /api/interface-preferences` remains compatible with width-only `{ "sidePanelWidth": 612 }` writes. Layout patches require the latest revision in `expectedLayoutRevision`, merge only named fields, and are limited to 32 KiB; stale revisions return `409`, unsupported media types `415`, oversized bodies `413`, and invalid or unknown fields `400`. Schema v3 adds `controlVisibility.hiddenIds`: `null` means package defaults, `[]` means explicit show-all, and a bounded sorted string list stores hidden stable catalog IDs while retaining unknown future IDs. The browser applies those IDs through a preference-only CSS class and never mutates capability-owned `hidden` state. The `terminalTabs` layout record owns tab placement, custom groups, and the bounded desktop `sidebarWidth`; the client journals those subfields independently so resizing cannot overwrite concurrent group or placement changes. Browser local storage remains a non-destructive compatibility cache. Semantic file moves, prompt attachments, and follow-up queue mutations are not stored in the interface-layout envelope.
Pi Web UI normally runs Pi RPC tabs under a narrow detached supervisor. Restarting only the HTTP Web UI—through `/webui-start` on the same URL, **Restart**, a successful **Update & restart**, `POST /api/restart`, or a restart-safe service-manager `SIGTERM`—preserves each managed Pi PID, tab identity, cwd, session file, running state, and active model turn. Output produced while the HTTP server is absent is replayed in supervisor order. The browser rejects duplicate or older replay records; if the bounded live buffer has a gap, it refreshes tabs, state, and the durable transcript from Pi and warns that buffered live output may be incomplete.
- Use `/webui-status detailed`, `GET /api/health`, or `GET /api/webui-status?detailed=1` for diagnostics. Public supervisor diagnostics are limited to enabled/attached state and managed-tab count; private credentials and paths are intentionally omitted. A browser warning about incomplete buffered output means authoritative tabs/state/messages were requested, not that missing live deltas were reconstructed.
- Use the side-panel **Stop** action or localhost-only `POST /api/shutdown` for an explicit full stop. Explicit tab close terminates only that managed Pi child; explicit shutdown and `SIGINT` terminate the scope's managed Pi children. Do not use restart/update when the intent is to terminate active work.
- Normal authenticated shutdown removes the private scope state. Do not manually delete runtime files, sockets, pipes, journals, or PID records while managed tabs may be live. For cleanup, explicitly shut down first, verify the Web UI/scope has no managed tabs, and let normal startup clean stale empty state; removing private state for a live supervisor destroys the safe attachment path and can risk duplicate processes.
- To opt out or roll back, first perform explicit shutdown and verify no managed tabs remain. Then set `PI_WEBUI_RPC_SUPERVISOR=0` and restart, or install the previous Web UI package before restarting. Never disable, downgrade, change the continuity port, or remove private runtime state while a supervisor still owns live tabs. Re-enable by removing the opt-out and starting normally; continuity begins for newly supervised Pi tabs.
Compact mode keeps live output lightweight, coalesces sustained live DOM/scroll flushes to at most once every 100 ms, preserves Markdown formatting for live and reconciled thinking, and displays only the current transient tool status as a compact labeled row with a state pill; each new tool or assistant delta replaces that status instead of retaining a tool-call history. Final reconciliation keeps visible thinking formatted and renders the final assistant response as Markdown while omitting intermediate tool calls, results, diffs, images, and raw details. The existing final `/api/messages` transcript remains authoritative. Compact mode does not change Pi generation, prompts, tools, models, providers, inference, stored transcript semantics, or the normal renderer.
- `PI_VOICE_STT_URL` enables a local STT endpoint for `POST /api/stt/transcribe`; Web UI forwards audio as multipart form data.
- `PI_VOICE_TTS_URL` enables a local TTS endpoint for `POST /api/tts/speech`; Web UI forwards `{ text, voice, format }` JSON.
- `PI_VOICE_STT_PROVIDER=groq|openai` selects hosted STT when no request provider is supplied; set `GROQ_API_KEY` or `OPENAI_API_KEY` server-side.
- `PI_VOICE_TTS_PROVIDER=openai` selects hosted OpenAI TTS when no request provider is supplied; set `OPENAI_API_KEY` server-side.
- `PI_VOICE_GROQ_STT_MODEL`, `PI_VOICE_OPENAI_STT_MODEL`, `PI_VOICE_OPENAI_TTS_MODEL`, `PI_VOICE_OPENAI_TTS_VOICE`, `PI_VOICE_OPENAI_TTS_FORMAT`, `PI_VOICE_TTS_VOICE`, and `PI_VOICE_TTS_FORMAT` tune fallback models/voices/formats.
- `PI_VOICE_PROVIDER_TIMEOUT_MS` controls outbound fallback-provider timeout. API keys are never sent from the browser; remote/LAN raw-audio STT uploads must include explicit per-request microphone-streaming consent.
- Pathless `pi-webui` startup: the server opens first, then the browser prompts for the first terminal CWD.
- Multi-tab Pi sessions with isolated processes, working directories, prompt drafts, activity state, per-tab settings, and a workspace dashboard for common actions.
- The Subagents side panel includes a separate **Agent models** editor above the live monitor. It stores WebUI-owned launch slots for the eight builtin roles (`context-builder`, `delegate`, `oracle`, `planner`, `researcher`, `reviewer`, `scout`, and `worker`): every role keeps a non-removable base slot, while added same-role slots copy a model/thinking draft but retain independent stable IDs. Choose **User default** or **This project**; projects inherit user defaults until saved, and **Use user defaults** removes a project override. Select `Default / inherit` to inherit both values, or an active-tab provider-qualified model and its supported thinking levels. Saves are revision-checked and localhost-only; the helper loads one immutable assignment snapshot after **Reload active tab**, never changes running children, and uses a `tool_call` hook to fill omitted model fields on `subagent` and `subagent_gate` launches. Explicit non-reviewer models remain unchanged; explicit reviewer mismatches block unless a matching bounded deviation permit is admitted. `workflowScript` receives an idempotent local `runs` adapter that applies role defaults and reviewer admission to `runs.run` and `runs.all` child params at execution time without parsing call sites. The configuration form has independent load/draft/error state, so its controls are not reset by live subagent monitoring.
- Tracked subagent output can open in the existing non-blocking overlay/widget or in a dedicated **Subagent** terminal tab, selected from the Subagents side-panel section and saved in the browser. The side-panel monitor keeps each status dot, agent type, provider/model, thinking effort, and run action on one compact line; a model-less `pi-subagents` workflow controller becomes a collapsible run header with its child-agent rows nested beneath it and excluded from agent counts. Run IDs, source/mode, elapsed state, and current-tool details live in the selected output view instead of being duplicated inline. Subagent tabs are view-only, reuse the bounded live transcript at the normal full terminal width, show the pulsing **Agent is running:** card with current child activity, and close without stopping or interrupting the child run; use the parent terminal for interaction. Dedicated **Subagent** terminal tabs show exactly six telemetry cards: PI, measured token speed, context, model, effort, and input/output tokens from a bounded recent session scan; unavailable or legacy evidence remains `—` or `unknown` rather than an estimate. The package also registers a generic `subagent_gate` tool that launches task slots through pi-subagents RPC v1, enforces a required success quorum, and performs bounded reason-aware retries only when declared safe; the side panel retains gate quorum, attempt, provider, and failure-class history after children finish.
- Subagent payload v1 normalization preserves only the public recovery contract: `source: "recovered"`, boolean `provisional`/`controllable`, and fleet `version`/`totalActive`/`omitted` aggregates. Raw fleet entries, prompts, and paths are not copied to the HTTP overview. Canonical v2 gives a recovered provisional row an opaque helper-owned, read-only output handle so the browser can open its bounded metadata view; the response explicitly marks detailed output unavailable until a run locator is observed. Cancel, dismiss, clear-finished selection, and retained terminal materialization remain blocked. Legacy v1 fallback rows remain status-only. Browser overview refreshes use one shared in-flight promise plus a queued bit; any refresh request received during a request guarantees a trailing fetch before the promise settles, including timer, visibility-resume, cancel, and dismiss callers. `tests/subagents-helper.test.mjs` and `tests/subagent-reliability-integration.test.mjs` cover recovery privacy, read-only openability, interaction gating, static rendering contracts, and overlapping-refresh state.
- Unified command palette (`Ctrl/Cmd+K`) for commands, tabs, models, sessions, settings, app controls, and frequent Web UI actions.
- Automatic tab naming from the first prompt, with `--name <name>` still available for an explicit initial tab name.
- Opt-in branch-aware session titles and Markdown summaries through `/summary` and `/summary-setup`, with a dedicated background model, private persistent setup, silent post-settlement updates, explicit-name protection, optional latest-only context injection, and a non-blocking Web UI overlay.
- Streaming chat transcript with Markdown, syntax-highlighted fenced code blocks, copy buttons for fenced code blocks, rendered Mermaid diagrams from fenced `mermaid`/`mmd` code blocks, thinking output, tool/bash cards, queue and compaction events, edit-and-retry from user prompts, transcript search, copy buttons, and guarded abort controls that require holding Esc or the Abort button for 3 seconds. An accepted RPC prompt releases browser routing ownership immediately; canonical Pi streaming state then owns the running indicator. This lets background extension commands such as `/release-npm` settle without a stale agent card, and a successful abort releases the same routing ownership before state reconciliation.
- Prompt composer with bounded automatic height growth and native vertical overflow scrolling, uploads, drag/drop/paste, inline image support, generated text attachments for long input or clipboard text, editable text attachments, slash-command autocomplete, and `@` file/path references with live suggestions.
- Leading `!` and `!!` user-bash commands from the composer, serialized per tab; `!` keeps output in the next model context and `!!` excludes it. When the optional `@firstpick/pi-extension-bang-command-autocomplete` companion is loaded, the browser composer also suggests `!`/`!!` shell commands through `GET /api/bang-suggestions?tab=<tabId>&query=<command>`. When the optional `@firstpick/pi-extension-fish-user-bash` companion is loaded, Web UI user-bash execution emits the Pi `user_bash` event so the companion can provide the selected shell backend.
- Optional Natural Conversation Mode shell for the standalone `@firstpick/pi-package-natural-conversation` package: when `/talk` (or `/voice`/`/conversation`) is loaded in the active Pi tab, Web UI shows per-tab Start/End controls, a read-only voice-mode chip, and backend guards that keep thinking `off` while blocking unsafe Web UI actions.
- Browser voice loop for Natural Conversation Mode (`public/voice-conversation.mjs`): while the mode is active in a tab, the browser's Web Speech APIs listen for speech, send final transcripts as normal prompts, and speak Pi's final answers. The microphone pauses while answers are spoken (echo prevention), speech during final-output streaming becomes a steering interruption, speech during tool execution is queued until the tool phase ends, and silence after a spoken question sends a single structured silence event. Remote (non-localhost) sessions keep the microphone off until the per-tab `Allow remote microphone streaming` consent is granted; only text transcripts ever reach the Pi host on the browser-default path. Opt-in server-side fallback routes are available for local/Groq/OpenAI STT and local/OpenAI TTS when configured with server-side env vars; remote/LAN raw-audio STT fallback uploads require explicit per-request consent.
- Browser-native Pi dialogs for `/model`, `/settings`, `/summary-setup`, `/safety-guard-setup`, `/git-workflow-setup`, `/theme`, `/fork`, `/clone`, `/name`, `/resume`, `/tree`, `/login`, `/logout`, `/scoped-models`, `/tools`, and `/skills`, plus an on-demand `/summary` Markdown overlay and native-command adapter output for `/copy`, `/session`, `/new`, `/compact`, `/reload`, and `/export`. Safety Guard Setup includes the opt-in auto-review toggle and active-tab authenticated model/supported-thinking selectors; auto-review remains off by default, and enabled saves reject unavailable selections.
- Browser-native tool and skill selectors backed by the hidden Web UI RPC helper, with explicit **Session only**, **Global default**, and exact **Model default** scopes. Session choices persist on the current branch and take precedence; global defaults are inherited by future sessions without rewriting existing branches. Disabled skills are removed from the system prompt, and tracked `SKILL.md` files can be opened/edited from skill tags. Responsive fitting keeps visible and hidden tag sets disjoint; the `+X` disclosure renders the hidden set in an upward, bounded popup and preserves selection, outside-dismissal, `Escape`, and focus-return behavior.
- Session resume into a newly created terminal tab, metadata rename, and localhost-only safe delete with active/open-tab/session-directory guards.
- Model, thinking, session, workspace, theme, optional-feature, Codex usage, optional Remote WebUI, update/restart/stop, event, notification, thinking-visibility, terminal-tab-layout, and custom-background controls in collapsible side-panel sections.
- A side-panel **Git** section mirrors the repositories represented by every open terminal tab/group. Repository cards are shown directly—without session-name parent disclosures—and always use the Git-root or cwd basename as their title. One repository can be expanded at a time. First/stale expansion refreshes local status after a five-minute cache window, while live filesystem updates use a debounced server watcher and SSE invalidation to refresh visible repositories without periodic Git polling or an automatic network `git fetch`. Its compact Changes tree groups conflicted, staged, modified, and untracked paths with additions/deletions; right-click a repository, folder, or file (or press Shift+F10/the Context Menu key) for View Diff, refresh, stage/unstage, and confirmed discard/delete actions. History lists the latest 30 commits and opens bounded read-only commit diffs.
- Persistent context-window meter with manual compact and auto-compaction controls near the composer; side-panel thinking changes made while a tab is busy are queued for the next prompt.
- Side-panel theme picker backed by optional `@firstpick/pi-themes-bundle` themes plus Pi-native project/global custom themes. **Customize…** provides all 51 required color tokens, variables, optional `thinkingMax`/export colors, synchronized advanced JSON, valid-only live preview, scope badges, and explicit target-bound overwrite confirmation.
- Per-tab cwd changes, a clickable footer cwd picker, direct path entry including rooted Windows drive paths, directory creation/search in the picker, saved path fast picks, server-persisted fast picks, and restart-safe restoration of open tabs. On Windows, Parent from a drive root returns a server-owned virtual **This PC** response with an empty cwd and `selectable: false`; the browser keeps drive navigation, filtering, and direct entry available while gating selection, creation, and pinning. When the optional stats and git-footer companions are loaded, clicking the footer **PI** token metric dispatches `/calibrate` in the background and refreshes the metric after the isolated calibration sample is recorded.
- Detected app runner dropdown for the active tab cwd, including Cargo, Bun, npm/npx/pnpm, Python/uv, Go/Golang, Zig, C/C++, Docker Compose, root/dev/scripts shell scripts, and other common project runners with live output pinned at the top of the terminal. Stream chunks pass through a terminal-line reducer: LF/CRLF commit scrollback, bare CR replaces the current live line, backspace edits that line, and ANSI sequences remain intact for the browser's safe SGR renderer. This is line-oriented terminal behavior rather than a full VT100 cursor grid. Running app runners expose line-oriented stdin in the widget for interactive scripts. Projects can add browseable custom runners in `.pi-webui-runners.json` with a command (default `./`) plus a relative path to the file to run. The same dialog also configures project discovery paths: project-relative directories that are scanned one level deep (no subdirectories) for `.sh`, `.bash`, `.zsh`, `.fish`, and `.py` files plus extensionless files with a bash/sh, zsh, fish, or Python shebang. Python candidates use `uv run` and/or the available `python3`/`python` interpreter. Discovered scripts extend the built-in root, `dev/`, `scripts/`, and `dev/scripts/` detection and run from the resolved project root.
- Extension-launched Guided Git workflow for existing repos and new repos with persistent model/reasoning preferences, review-first staging, an optional manual staged repository-review gate from `aur-review`, generated or typed commit messages, explicit push/PR confirmation, and optional PR worktrees. `/git-guided-workflow` emits a transient tab-scoped activation request that the browser validates and consumes before generic status rendering; the browser requires the extension-owned native generation commands and has no prompt-only launch fallback. The HTTP server authoritatively rejects the exact command admission while the tab is streaming, compacting, has pending messages, or already has a pending Guided Git launch, bypassing generic compaction queueing. A browser-generated UUID is stored in one short-lived server record and added only to the trusted live event envelope; the canonical four-field extension payload remains unchanged, and only the browser holding the matching one-shot permit can consume the event. When the review extension is loaded/enabled, both `git add .` and accepting the current staged set send `/aur-review start --scope staged --origin guided-git` to the same tab. Only its matching approval advances to message generation. The browser and server recheck the approved domain-separated staged-content hash before message generation, commit, and PR-worktree transfer; drift, missing hashes, or hash-check errors return to Stage and require a new review. A decline returns to staging and rejects an unchanged declined staged hash until corrected content is restaged. Guided Git never stages, commits, or pushes remediation automatically. The extension remains the decision authority; direct API callers are not granted an approval by this browser workflow.
- Browser support for Pi extension UI prompts, widgets, status updates, `/btw` side-question output widgets with optional context transfer/live steering, browser notifications when a tab needs an extension UI response, and an optional side-panel toggle for agent-done notifications.
- Localhost-only exact Pi/Web UI update plans with digest-bound confirmation, fail-closed owner refusals, cross-process locking, durable receipts, side-by-side managed Web UI candidates, stable pointer-aware launch, changed-boot-identity reconnect, and automatic health-gated rollback. Combined plans also include update-available Pi-registered optional packages and retain per-package partial receipts. A separate verified Pi executable delegates to that exact executable's self-updater and fails verification if it does not reach the confirmed version; managed targets remain strictly pinned. The former broad package-root scan and `pi update --all`/fallback mutation path is disabled.
- Feedback reactions (`👍`, `👎`, `?`) on final assistant output plus tool/bash action cards, which can ask Pi to create or update a LEARNING.
- Mobile-friendly layout, PWA install support where the browser allows it, backend-offline recovery, and a dedicated server-restart overlay while confirmed restart/update actions run.
Web UI keeps a packaged parity matrix at `lib/WEBUI_TUI_NATIVE_PARITY.json` and exposes it at `GET /api/native-parity`.
Discovery-path rules: at most 24 paths and direct children only (no recursive walk). Shell discovery supports `.sh`, `.bash`, `.zsh`, `.fish`, and matching extensionless shebang files. Python discovery supports `.py` and extensionless Python-shebang files, exposing `uv run` and/or the available `python3`/`python` interpreter. Required interpreters must be installed locally; duplicates and built-in overlaps do not duplicate menu entries. Absolute, drive/UNC, `..`, null-byte, missing, non-directory, or symlinked-outside-the-project paths are rejected. Stale or invalid stored paths surface diagnostics in the dialog instead of being scanned. `POST /api/app-runner-config` accepts either `{ "runner": { ... } }` or `{ "searchPaths": [...] }` (not both in one request) and preserves the other field.

### Events session-tree target contract

`GET /api/session-tree` includes `data.eventTargets`, a minimal projection of persisted tool boundaries. Each record has exactly `toolCallId`, `toolName`, `startEntryId`, and `finishEntryId`. Assistant tool calls supply the start entry; matching tool-result messages supply the finish entry. Missing boundaries remain `null`, the first persisted duplicate wins, and no message text, arguments, results, or output enters this projection.

The browser keeps only the live call ID and lifecycle phase on an eligible event row, then resolves `eventTargets` again when **Tree…** is selected. Start selects `startEntryId`; finish/failure selects `finishEntryId || startEntryId`. The resolved ID must still occur in the current `data.nodes` list before confirmation. Accepted navigation sends `{ entryId, summarize: false }` to the tab-scoped `POST /api/tree-navigate`, applies returned tab metadata, emits `/tree` feedback, and performs the normal active-tab refresh. Intercom transport calls and general Web UI events never enter this action path. Event detail rendering reads only allowlisted string `path` fields for `read`, `write`, `edit`, `grep`, `find`, and `ls`; it does not stringify arguments or inspect result/output fields.

The same context menu exposes radio-style `Detailed` and `Compact` display choices for every event row. The browser stores the normalized value under `pi-webui-event-display-mode-v1`, defaults unknown values to `detailed`, and mirrors it to `#eventLog[data-display-mode]`. Compact CSS hides `.event-details`, tightens row spacing, and uses `data-event-tool-phase` for lifecycle accents. This preference does not change event payloads, the 120-row bound, click-to-jump behavior, or Tree eligibility.

The visible Events filter stores one normalized value under `pi-webui-event-filter-v1`: `all`, `errors`, `warnings`, `tools`, or `tree`. Each row retains only its normalized level plus the existing lifecycle phase and a derived Tree-availability boolean. Filtering toggles the row's `hidden` state in place, so the log's newest-first order, 120-row bound, jump target, notice/unread behavior, and session-tree contract remain unchanged. Storage events apply changes from other same-origin tabs without writing them back.

`addEvent` supports opt-in page-local aggregation through an event key, numeric increment, and singular/plural labels. A matching row contributes its stored count, is removed, and is recreated at the top with the latest timestamp. Subagent Auto-Clear uses the `subagent-auto-clear` key and increments by the number of runs dismissed. Manual clears and failure rows do not use that key. The aggregate row still participates normally in filtering and the 120-row bound.

Focused checks are `node tests/session-tree-event-targets.test.mjs`, `node tests/events-tree-context-menu-static.test.mjs`, `node tests/streaming-ui-coupling.test.mjs`, `node tests/intercom-main-transcript-suppression-static.test.mjs`, `npx playwright test tests/browser/events-tree-context-menu.spec.mjs --project=chromium`, and `node --check public/app.js`.

- `GET /api/health` and `GET /api/webui-status?detailed=1` for server health, network exposure, tabs, sessions, models/providers, update state, and recent events.
- `GET /api/tabs`, `POST /api/tabs`, `PATCH /api/tabs/<tabId>`, and tab close/delete routes for multi-tab lifecycle management.
- `GET /api/messages?tab=<tabId>&since=<index>` for transcript snapshots or delta refreshes.
- `POST /api/prompt`, `POST /api/follow-up`, `POST /api/steer`, `POST /api/bash`, `POST /api/abort`, and `POST /api/abort-bash` for tab-scoped Pi interaction.
- `POST /api/attachments` for uploaded/generated prompt attachments and inline images.
- `GET /api/path-suggestions?tab=<tabId>&query=<path>` for `@` file/path references with live suggestions.
- `GET /api/bang-suggestions?tab=<tabId>&query=<command>` for optional `@firstpick/pi-extension-bang-command-autocomplete` `!`/`!!` command suggestions.
- `GET /api/path-fast-picks` and `POST /api/path-fast-picks` for server-persisted cwd fast picks.
- `GET /api/native-parity` for the packaged native TUI/Web UI parity matrix.
- `GET /api/settings`, `POST /api/settings`, `GET /api/tools`, `POST /api/tools`, `GET /api/skills`, and `POST /api/skills` for browser-native Pi settings/tool/skill selectors.
- `GET /api/safety-guard/config` and `POST /api/safety-guard/config` for browser-native persisted Safety Guard Setup. The tab-scoped `GET` includes authenticated models plus a per-model supported-thinking map; `POST` validates the effective enabled auto-review selection before writing.
- `GET /api/skill-file` and localhost-only `POST /api/skill-file` for guarded `SKILL.md` editing from tracked skill tags.
- `GET /api/sessions`, `GET /api/session-tree`, `POST /api/switch-session`, `POST /api/session-rename`, and localhost-only `POST /api/session-delete` for resume/tree/session metadata flows. The compatibility-named switch endpoint starts the selected session in a new terminal and returns both the new and source tab metadata.
- `GET /api/auth-providers` and localhost-only `POST /api/auth-logout` for provider-auth status and stored-credential removal.
- `GET /api/app-runners`, `POST /api/app-runner`, `POST /api/app-runner/input`, `POST /api/app-runner/stop`, `GET/POST/DELETE /api/app-runner-config`, and `GET /api/app-runner-files` for detected and custom project runners. `POST /api/app-runner-config` replaces project discovery paths with `{ "searchPaths": [...] }` or saves a custom runner with `{ "runner": { ... } }`; invalid path submissions fail atomically and leave the stored configuration unchanged.
- `GET /api/git-root`, `GET /api/git-panel`, and `GET /api/git-commit?hash=<full-hash>` for compact per-terminal-group repository discovery, local status/history snapshots, and bounded read-only commit diffs. `POST /api/git-changes/stage-all` and `POST /api/git-changes/unstage-all` complement the guarded path-level staging routes.
- Authenticated `GET`/`PUT /api/session-summary/preferences` for the allowlisted persistent profile projection and confirmed saves, plus authenticated `POST /api/session-summary/generate` for active-tab `/summary` dispatch. Mutations require same-origin JSON and bounded bodies; authenticated remote clients are allowed by the approved summary policy.
- `GET /api/git-changes`, `POST /api/git-changes/pull`, `GET /api/git-branches`, `POST /api/git-branch`, and `/api/git-workflow/*` for browser Git status, diff, branch, init, commit, push, and PR helpers.
- `POST /api/action-feedback?tab=<tabId>` for feedback on final assistant output and action cards.
- `GET /api/optional-features` for the cached revisioned startup-audit snapshot, including phase, sanitized source/state, summary, reconnect-safe progress, and restart disposition.
- Localhost-only `POST /api/optional-feature-install` for installing or updating one known optional companion through Pi.
- Localhost-only `POST /api/optional-feature-install-batch` for a bounded allowlisted `featureIds` batch. It requires the current audit `revision`, installs sequentially, reports ordered per-feature and aggregate results, and accepts `migration: true` for the combined restore flow.
- Localhost-only `POST /api/optional-feature-migration/recheck` for a bounded read-only audit and `POST /api/optional-feature-migration/dismiss` for persisted **Later** state.
- `GET /api/git-workflow/staged-content?tab=<tabId>` for the read-only bounded staged-content hash used by Guided Git approval binding.
- `GET /api/update-status`, localhost-only `POST /api/update/plan`, `POST /api/update/apply`, `GET /api/update/transactions/<transactionId>`, and `POST /api/update/rollback` for exact planning, digest-bound apply, durable receipts/status, and confirmation-bound rollback. Legacy `POST /api/update` and `POST /api/component-update` mutation return `410 Gone`.
- `GET /api/network`, localhost-only `POST /api/network/open`, localhost-only `POST /api/network/close`, `GET /api/remote-auth`, `POST /api/remote-auth`, and localhost-only `POST /api/remote-auth/settings` for trusted-LAN exposure and optional 4-digit PIN authentication when serving non-local browser clients.
On hosts with WebKit's system libraries installed, provision it and include its project explicitly with `npx playwright install webkit && PI_WEBUI_TEST_WEBKIT=1 npm run test:browser`. The browser suite is intentionally separate from `npm test`; it covers browser-only geometry, flag/rollback, and scoped axe checks without making ordinary Node/static tests download browser engines.
When enabled, each click obtains a fresh Turnstile token and UUID-v4, then posts only `{ schemaVersion, idempotencyKey, turnstileToken, issue }` to `POST /v1/submissions`. `issue` is the selected structured wizard state (`categoryId`, `componentId`, `templateId`, `summary`, and declared fields); editable canonical title/body, repository, labels, verdicts, callback URLs, and credentials are never sent. The returned status capability remains only in an opaque in-memory refresh handle for the open dialog. Nothing in this flow uses `localStorage`, `sessionStorage`, cookies, or draft persistence.

## Preserved detailed implementation reference

Local browser UI for [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

Pi Web UI gives you a local browser companion for Pi: multi-tab chat, streaming output, model controls, uploads, slash-command helpers, workspace navigation, and optional extension widgets.

> **Security:** Pi Web UI can control the spawned Pi session and run anything that session is allowed to run. It binds to `127.0.0.1` by default. Trusted-LAN opening/closing and Remote PIN auth controls are owned by the optional `@firstpick/pi-package-remote-webui` companion; when enabled, Remote PIN auth persists for later Web UI starts.

## Requirements

- Node.js `>=22.19.0`
- Pi installed and configured
- A modern browser with Server-Sent Events support

## Install

Install the package into Pi:

```bash
pi install npm:@firstpick/pi-package-webui
```

Restart Pi after installation so the Web UI commands are loaded.

## Start from Pi

Run this inside Pi:

```text
/webui-start
```

Open the printed URL, usually <http://127.0.0.1:31415/>. The command opens your browser automatically unless you pass `--no-open`.

Check a running Web UI with:

```text
/webui-status
/webui-status detailed
```

### `/webui-start` options

```text
/webui-start [port] [options] [-- <pi args...>]
```

```text
  [port]             Port shortcut
  --host <host>      HTTP bind host (default: 127.0.0.1)
  --port <port>      HTTP port (default: 31415)
  --no-open          Do not open the browser automatically
  --no-session       Start Pi RPC with --no-session
  --name <name>      Initial Web UI tab name
  --remote-auth      Enable startup PIN authentication for non-local clients
  --no-remote-auth   Disable startup PIN authentication
  -- <pi args...>    Extra arguments forwarded to Pi RPC
```

Examples:

```text
/webui-start
/webui-start 31500
/webui-start --port 31500 --no-open
/webui-start --remote-auth --host 0.0.0.0
/webui-start --name browser -- --model anthropic/claude-sonnet-4-5:high
```

Running `/webui-start` again on the same URL restarts the HTTP server. By default, supervised Pi tabs—including an active model turn—continue in their original Pi processes and reconnect to the replacement server; session-file restoration remains the fallback when no managed tabs exist.

The extension launches its JavaScript bootstrap with the current Node executable when Pi itself runs under Node. For standalone Pi binaries, where `process.execPath` points to Pi rather than Node, it resolves `node` from `PATH`; otherwise Pi would parse the Web UI server flags as its own CLI options.

### `/webui-status` options

```text
/webui-status [detailed] [port] [--port N] [--host HOST]
```

`/webui-status` reports the URL, online state, network exposure, and Remote PIN auth state. `detailed` adds tabs, sessions, models/providers, and recent backend events.

### Transactional Pi and Web UI updates

The **Pi** and **Web UI** version tags still show `available`, `running`, `succeeded`, or `failed`, but every mutation now uses one server-owned transaction path:

Ownership is fail-closed. Source, linked, pnpm, Yarn, opaque, nested, and unknown installations produce bounded manual guidance and are not mutated. The removed legacy updater no longer scans agent, project, npm-global, or Bun-global roots. Only localhost may create, apply, or roll back a transaction.

The installed package is a stable bootstrap. A Web UI candidate installs side-by-side under `<PI_CODING_AGENT_DIR>/webui/runtimes`, runs a side-effect-free candidate probe, and is selected through private atomic `current.json`/`previous.json` pointers. A separate activation helper switches the pointer, restarts through the stable launcher, waits at least 90 seconds for the expected version and a changed per-boot identity, and automatically restores the previous pointer when health fails. The live RPC supervisor remains separate; an incompatible supervisor with healthy managed work still fails closed.

Restart descriptors use a private owner-readable random file, are read and deleted once, and support up to 256 descriptors. Startup retries transient `EADDRINUSE` with bounded backoff. Retention preserves current, previous, locked, journal-referenced, and recent healthy runtimes; zero downtime is not promised, but automatic rollback restores the previous reachable runtime after a bounded interruption.

## Standalone CLI

Use the CLI when you want to start the Web UI without first opening terminal Pi:

```bash
npm install -g @firstpick/pi-package-webui
pi-webui
```

```text
pi-webui [options] [-- <pi args...>]
```

```text
  --host <host>       HTTP bind host (default: 127.0.0.1)
  --port <port>       HTTP port (default: 31415)
  --cwd <path>        Start the first Pi terminal in this working directory
  --pi <command>      Pi executable to spawn (default: bundled dependency, then "pi")
  --no-session        Start Pi RPC with --no-session
  --name <name>       Initial Web UI tab name
  --remote-auth       Enable startup PIN authentication for non-local clients
  --no-remote-auth    Disable startup PIN authentication
  --output-mode <mode>  Web UI output default: normal or compact-v1
  --migrate-optional-features  Migrate audit-selected legacy optional features
  --migration-dry-run  Print the startup migration plan without package mutation
  -h, --help          Show help
  -v, --version       Print version
```

If `--cwd` is omitted, the server starts first and the browser asks for the first terminal CWD.

Examples:

```bash
pi-webui
pi-webui --cwd ~/src/my-project
pi-webui --host 0.0.0.0 --remote-auth --cwd ~/src/my-project
pi-webui --port 3000 -- --model anthropic/claude-sonnet-4-5:high
pi-webui --output-mode compact-v1
PI_WEBUI_PI_BIN=/path/to/pi pi-webui --no-session
```

Environment variables:

- `PI_WEBUI_HOST` and `PI_WEBUI_PORT` set the default bind address.
- `PI_WEBUI_PI_BIN=/path/to/pi` selects the Pi executable when `--pi` is not passed.
- `PI_WEBUI_REMOTE_AUTH=1` starts with Remote PIN authentication enabled.
- `PI_WEBUI_OUTPUT_MODE=normal|compact-v1` sets the server default for newly auto-negotiated browser connections.
- `PI_WEBUI_RPC_SUPERVISOR=0` opts out to the legacy server-owned Pi transport only when the current scope has no live managed tabs. Use explicit shutdown before disabling or downgrading; fallback startup refuses to create duplicate direct children for a live managed scope.
- Pi Web UI automatically injects a loopback `PI_WEBUI_RECOVERY_URL` and a bearer `PI_WEBUI_RECOVERY_TOKEN` into spawned Pi RPC processes. Managed RPC children receive a lower-privilege credential derived from the private supervisor token, so retained tabs stay authorized across server-only restarts without persisting another secret. The authenticated endpoint can only create a separate plan-only recovery tab; keep any manually supplied token private.
- `PI_WEBUI_SETTINGS_FILE=/path/to/settings.json` authoritatively overrides the private Web UI settings file (normally `~/.pi/webui/settings.json`) and disables automatic import from the old XDG location.
- `PI_SESSION_SUMMARY_CONFIG_FILE=/path/to/session-summary.json` overrides the private session-summary profile (normally `~/.pi/agent/session-summary.json`), primarily for isolated tests or managed deployments.
- `PI_WEBUI_FAST_PICKS_FILE=/path/to/paths.json` overrides saved cwd fast-pick storage.
- Optional feature install/update actions use the selected Pi executable (`--pi` or `PI_WEBUI_PI_BIN`) so registration and package storage stay owned by Pi.
- `--migrate-optional-features` is the explicit unattended opt-in for migrating every audit-selected legacy companion sequentially. Migration never starts implicitly from an environment variable.
- `--migration-dry-run` prints the sanitized startup audit/migration snapshot and performs no optional package or settings mutation. If both migration flags are supplied, dry-run wins.
- `PI_BANG_AUTOCOMPLETE_INCLUDE_HISTORY=1` lets optional bang-command autocomplete include local fish/bash/zsh history executables.
- `PI_BANG_AUTOCOMPLETE_RUNTIME_STORE_PATH=/path/to/runtime.json` overrides the runtime store shared with `@firstpick/pi-extension-bang-command-autocomplete`.

### Persistent session titles and summaries

The package registers `/summary` and `/summary-setup` in native Pi and explicitly loads the same extension in each Web UI tab. The feature is opt-in: loading the package makes no summary-model request until setup is reviewed and confirmed. Setup defaults to `openai-codex/gpt-5.6-luna` with `low` reasoning when that authenticated model is available; it never silently falls back to another provider or model.

`/summary-setup` selects the dedicated model/reasoning level, automatic generation, generated-title behavior, editable title and Markdown-summary prompts, and optional latest-summary context injection. Preferences are stored privately in `~/.pi/agent/session-summary.json`. The immutable code-owned system instruction is not editable. The browser exposes the same profile through **Common Pi options → Session Summary Setup**; the first Summary-button click opens setup, and confirmed setup immediately generates the first result.

After each true settled agent turn, enabled automatic generation runs as a bounded background request without starting another agent turn or delaying Pi's settled state. It sends active-branch user text, final assistant text, and tool names only. Thinking, images, tool arguments/results, credentials, hidden metadata, and previous summary control/display entries are excluded. One validated JSON response supplies both a title candidate and Markdown summary. Requests have a 90-second limit, no automatic retry, and a five-minute automatic-failure cooldown; manual **Refresh** may retry after the underlying problem is corrected.

Successful summaries are append-only, branch-aware Pi session state. Native `/summary` shows basic Markdown output. Web UI automatic updates remain silent; its header/composer Summary action opens a non-blocking sanitized Markdown overlay with copy and refresh controls. The last successful result survives provider, timeout, parse, and stale-branch failures. Generated names never overwrite explicit `/name`, `--name`, or browser tab names. The first eligible generated title applies immediately; later changed candidates require the configured cadence (three settled user turns by default) and the title prompt tells the model to retain the name unless the primary goal or scope changed substantially.

Main-agent context injection is off by default. When explicitly enabled, exactly one latest active-branch summary is added ephemerally as reference-only data; historical, display, and RPC summary messages are filtered out. Authenticated remote Web UI clients may configure and trigger summaries after the same privacy/cost confirmation. No credentials, raw transcript, or provider payload is returned through the summary HTTP APIs. To pause recurring calls without deleting prompts or prior results, turn off **Generate automatically** in setup. To roll back operationally, keep it off and use `/summary` only when needed.

#### Workspace Session Summaries and Peer Coordination

The extension exposes `/summary workspace` and the agent-facing `workspace_session_summaries` tool to discover summaries from other Pi sessions in the same canonical working directory.

- **Live Transport & Availability:** When the optional `pi-intercom` extension bus is present, connected same-CWD peers exchange summaries over namespace `firstpick/session-summary/v1` without transcript pollution or model turns. When pi-intercom is absent or disconnected, the feature falls back to read-only persisted session discovery and explicitly reports that live peer status is unavailable.
- **Privacy & Safety:** The shared projection never includes raw transcript entries, thinking, images, tool arguments/results, provider payloads, or session-file metadata. Before live publication and display, bounded generated-summary prose is redacted for recognized credential families, labelled secret/token values, private-key blocks, and Unix/Windows session paths. Because generated prose is free text, detection cannot prove that every semantically sensitive string is a credential; treat connected same-user, same-CWD peers as the local trust boundary and avoid placing secrets in prompts or summaries.
- **Coordination Semantics:** Tool output and guidelines instruct agents to compare semantic overlap across goals, files/symbols, decisions, and next steps, and to coordinate via `intercom` before performing writes when material overlap exists or ownership is unclear. Summaries never send automatic messages, apply locks, or assign ownership automatically.

Troubleshooting:

- If the configured model or authentication is unavailable, run `/login` or choose another explicitly available model in `/summary-setup`; the previous successful result is retained.
- A malformed or unsupported future config fails closed and is never overwritten automatically. Correct or move the private config, then rerun setup.
- In `--no-session` mode, generation can work in memory but is reported as non-durable.
- `/summary refresh` or the overlay **Refresh** action forces a bounded manual update without provider fallback.
- `/summary workspace` displays same-canonical-CWD workspace summaries from active live peers and persisted session files.

### Optional-feature startup audit and migration

Every Web UI server start performs one bounded, read-only startup audit of optional features before the first normal Pi RPC tab starts. HTTP diagnostics and the browser are available immediately: the persistent status surface shows **Checking optional features…** and elapsed time while the browser reads the server-owned cached snapshot. The browser never scans package directories or Pi settings itself. A successful audit reports a truthful **Core ready · N optional features ready** summary and automatically dismisses that non-actionable confirmation after five seconds; actionable, degraded, and failed states remain visible until resolved. Fresh minimal installs and upgrades whose companions are already registered or enabled as top-level resources require no confirmation.

When an older bundled Web UI feature needs restoration, the banner offers **Migrate…** and **Later**. **Migrate…** opens the single combined confirmation—there is no separate review screen. Previously enabled features are preselected, previously disabled features and features disabled in this browser are not, and the expandable **Choose features** area can adjust the batch. **Later** persists the dismissal so the migration banner does not return on every server start; a non-blocking **Migrate…** action remains in the Optional features panel.

Confirmed installs run one at a time through the selected Pi CLI. Progress is server-owned and reconnect-safe: the UI reports `Installing N of M: <name>`, elapsed time, ordered per-package results, and bounded localhost installer-output tails without inventing percentages. A browser refresh or SSE reconnect fetches the current cached snapshot rather than restarting the operation. Partial failure preserves successful rows and provides **Retry failed** plus **Copy commands**. On full success, an idle affected tab restarts automatically with a visible notice. If it is busy, work is not interrupted and a deferred **Restart tab** action appears.

Duplicate package/top-level ownership is never loaded twice. The audit safely excludes the top-level copy, and the conflict alert names only source kinds (`Pi package` and `top-level resource`), never raw host paths. **Copy recommended fix** copies the safe ownership recommendation: keep the registered package canonical, disable/remove the duplicate top-level extension/skill/prompt/theme alias, then **Recheck**. The current backend intentionally exposes no browser mutation route for alias removal.

Troubleshooting:

- **Recheck** reruns the bounded read-only audit after a timeout, malformed settings fix, or manual ownership repair. Degraded mode keeps the minimal core usable while optional companions stay excluded.
- **Retry failed** reruns only failed migration packages; successful registrations remain intact. **Copy commands** copies exact allowlisted `pi install npm:<package>` commands for manual host-side diagnostics.
- `pi-not-found`, permission, network, timeout, and post-install verification failures remain per-package terminal states with an actionable hint and bounded output tail.
- A stale confirmation is rejected with `409`; the browser silently refetches and retries when the candidate set is unchanged, or reopens the same combined confirmation when choices materially changed.
- Remote authenticated browsers may view sanitized audit status but cannot start installs, migration, dismissal, or recheck mutations; perform those actions from localhost.

### Persistent interface settings

Pi Web UI stores user-scoped settings in `~/.pi/webui/settings.json` by default. When that file is absent, a valid prior `$XDG_CONFIG_HOME/pi-webui/settings.json` (or `~/.config/pi-webui/settings.json`) is imported once without modifying or deleting the old file. An existing new file always wins, including when it is malformed, and `PI_WEBUI_SETTINGS_FILE` remains isolated from this migration. Writes use a private same-directory temporary file, atomic replacement, and a bounded same-host process lock; newly created settings files and directories use private permissions on supported platforms.

### Durable Pi session continuity

Continuity is scoped to the resolved private Pi agent/config root and Web UI port. A replacement server must use the same root and port; changing ports creates a different scope and does not migrate active tabs. The supervisor communicates only over per-user local IPC (an owner-private Unix-domain socket on POSIX or a local named pipe on Windows) with a private random credential and incarnation fencing. Runtime state and metadata are private (`0700` directory and `0600` files on POSIX), bounded, and secret-key sanitized. Supervisor credentials, IPC paths, and raw private state are not exposed to browser APIs, server diagnostics, logs, or Pi child environments.

Updates preserve already-running supervised Pi processes, so an active tab continues with the Pi/runtime code it already loaded. Newly created or explicitly reloaded tabs use the newly installed versions. Additive supervisor protocol-minor changes are compatible; a protocol-major mismatch with live children fails closed instead of replacing the supervisor or spawning duplicates. Roll forward to a compatible Web UI rather than killing a healthy supervisor that owns active work.

Continuity deliberately excludes app runners: restart and update stop their process trees, and they must be started again after reconnection. It also does not preserve browser drafts, SSE connections, arbitrary extension memory, or an active request across supervisor failure, OS reboot, power loss, or machine restart. Session files can still restore durable transcript history after those failures, but they cannot resume the same in-flight model request.

### Compact live output mode

Normal output is the default. In the sidebar, open **Controls → Output processing**, select **Compact**, and click **Apply**. The same persisted server default is also available under **Settings → Browser workflow → Output processing**. Alternatively, set `--output-mode compact-v1`, `PI_WEBUI_OUTPUT_MODE=compact-v1`, or `outputModeDefault` directly. Precedence is explicit CLI flag, then environment variable, then the persisted setting, then `normal`.

The browser negotiates `compact-v1` per EventSource connection (`outputMode=auto&outputModeProtocol=1`), so normal and compact clients can share one Pi tab. A browser only enables compact handling after the protocol-1 acknowledgement; an older server gets one normal-mode reconnect instead. The server default applies only to `auto` clients, and active auto streams change representation at a semantic boundary.

The included compact-mode metric measures deterministic post-parse serialized JSON byte-work only (`R + 2×S`) and semantic parity; it does not claim wall-clock improvement, lower DOM CPU, reduced network latency, or higher model token/s.

### Codex subscription Fast mode

The optional `@firstpick/pi-extension-codex-fast-mode` companion adds `/fast-mode` and a **Normal / Fast** selector under **Codex Usage**. Fast mode is off by default and scoped to the active Pi session branch. The browser asks the extension to change mode and renders the extension-published `codex-fast-mode` status; it does not inspect ChatGPT credentials or rewrite provider requests itself.

When enabled, the extension marks only subscription-backed `openai-codex` requests using `openai-codex-responses` with `service_tier: "priority"`. Supported models may respond about 1.5× faster while spending 2× Standard credits for GPT-5.4 or 2.5× for GPT-5.5/5.6. Upstream account and model eligibility remains authoritative. Mode changes are blocked while the active tab is busy, and disabling the optional feature turns Fast mode off before hiding its integration.

## Main features

### Custom themes

Open **Controls → Interface → Theme → Customize…** to start from the current browser theme. The responsive dialog exposes visual controls for Pi’s exact 51 required theme tokens and optional `thinkingMax`, variables, export colors, and advanced JSON. Valid edits stay synchronized and preview immediately; malformed JSON, invalid values, missing variables, and cycles remain editable but do not replace the last valid preview and cannot be saved.

Preview is temporary: it does not write local storage, a theme file, Pi settings, or the browser’s Light/Dark slots. **Cancel** (including Escape) restores the opening WebUI theme, scheme presentation, meta color, and that theme’s custom background. **Reset draft** returns to the initial editor draft without changing saved settings. Light, Dark, and Auto continue to behave exactly as the normal theme picker defines them; only an explicit normal picker choice uses the existing persistent selection path.

Save destinations are server-derived:

- **This project** writes `<active trusted cwd>/.pi/themes/<name>.json` and is disabled unless Pi has a saved trusted-project decision for that active tab.
- **Global themes** writes `<PI_CODING_AGENT_DIR>/themes/<name>.json` (normally `~/.pi/agent/themes/<name>.json`).

An existing same-scope target requires a second confirmation naming the exact scope and file. Changing the draft, name, or destination invalidates that confirmation; a changed-on-disk file is not overwritten from stale confirmation. Bundled and opposite-scope name collisions are rejected. Saving refreshes the WebUI catalog and adds a **Project** or **Global** badge, but deliberately does not select the theme or mutate Pi/browser settings. To use the file in Pi TUI, run `/reload` or restart Pi, then choose the custom theme with `/theme`; no disruptive reload is triggered automatically.

## Native Pi command coverage

| Status | Commands and behavior |
| --- | --- |
| Implemented | `/model`, `/settings`, `/summary`, `/summary-setup`, `/safety-guard-setup`, `/git-workflow-setup`, `/tools`, `/skills`, `/copy`, `/name`, `/session`, `/clone`, `/logout`, `/new`, `/compact`, and `/reload` use browser-native dialogs, the summary overlay, or structured native-command cards. |
| Degraded / browser-specific | `/theme` changes the browser Web UI theme only; `/scoped-models` points to the footer scoped-model picker; `/export` supports no-path HTML downloads plus explicit new `.html`/`.jsonl` server paths; `/hotkeys` lists Web UI shortcuts; `/fork`, `/tree`, `/login`, and `/resume` have browser flows with documented gaps. |
| Unsupported in Web UI | `/import`, `/share`, `/changelog`, and `/quit` return structured unavailable output instead of raw HTTP errors. |

Sensitive native flows use shared trust-boundary guards: localhost-only APIs, trusted-context checks for LAN clients, confirmation-oriented dialogs, and session-directory confinement for session file operations.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+K` | Open the command palette. |
| `Ctrl/Cmd+L` | Open the model selector. |
| `Ctrl/Cmd+P` / `Shift+Ctrl/Cmd+P` | Cycle scoped or available models forward/backward. |
| `Shift+Tab` | Cycle thinking effort. |
| `Ctrl/Cmd+T` | Toggle thinking-output visibility. |
| `Ctrl/Cmd+O` | Toggle global expansion for tool and bash output cards. |
| `Alt+Enter` | Queue the composer as a follow-up. |
| `Alt+Up` | Restore the latest observed steering/follow-up queue snapshot into the composer. |
| hold `Esc` | Abort active user bash first, then active agent work. |
| `Ctrl/Cmd+C` in an empty, focused composer | Clear the prompt. |
| `Ctrl/Cmd+F` | Search the transcript. |

## Interface reference

Product screenshots are maintained in the [user-facing README](README.md#feature-gallery). The notes below preserve detailed behavior for contributor reference. Unless noted otherwise, actions apply to the active tab and its current working directory.

### Main window

- **What it is:** The primary Web UI workspace for Pi, with terminal tabs, chat transcript, live assistant output, footer metrics, prompt composer, attachments, and side-panel controls in one browser view.
- **What you can do:** Run multiple Pi sessions, send prompts or follow-ups, monitor tokens/cache/cost/context/git/model state, attach files, launch quick actions, and control the active session without returning to the terminal.

### Workspace dashboard

- **What it is:** The project home base for an active Web UI tab, combining cwd, model, context, git, queue, session, and activity status.
- **What you can do:** Start or resume work, verify the tab is pointed at the right project, jump into common session/workspace actions, and spot queued or active work before prompting.

### Control panel

- **What it is:** The side rail for Web UI state and settings, including model, thinking effort, session/workspace controls, theme, optional companions, Remote WebUI, updates, notifications, and usage widgets.
- **What you can do:** Change model or effort, compact/manage sessions, toggle notifications, check or install optional packages, run confirmed updates/restarts, and manage remote/PIN controls when the remote companion is loaded.

### Working-directory picker

- **What it is:** A browser-native cwd chooser used at first launch and for per-tab working-directory changes.
- **What you can do:** Search and browse project paths, choose recent or saved directories, create a new directory, and start or move a Pi tab into the selected workspace.

### App runners

- **What it is:** A project runner detector for common stacks plus browseable custom runners and project discovery paths from `.pi-webui-runners.json`.
- **What you can do:** Launch dev servers, tests, builds, scripts, and custom commands from the active cwd, pass arguments, watch pinned live output, and send line-oriented stdin to interactive runners. Windows runners use ConPTY through the optional `node-pty` dependency so Bash/Node scripts receive a real TTY; set `PI_WEBUI_APP_RUNNER_PTY=off` to force the pipe fallback.
- **Project discovery paths:** The app-runner dialog stays reachable even when nothing is detected, so you can add extra directories to scan for shell and Python scripts. Paths are project-local and relative to the resolved project root (`.` means the project root itself), are browseable from the dialog, and are saved beside custom runners.

`.pi-webui-runners.json` uses a backward-compatible version 2 shape; a missing `searchPaths` array simply means no extra directories are scanned:

```json
{
  "version": 2,
  "searchPaths": ["tools", "ops/scripts"],
  "runners": [
    { "id": "start-dev", "label": "Start dev", "command": "./", "path": "dev/scripts/start.sh", "args": [] }
  ]
}
```

### Queue manager

- **What it is:** The queue surface for follow-up prompts, steering messages, user bash work, and loaded prompt lists while a tab is busy or ready.
- **What you can do:** Create or load prompt lists, run batches when supported, see pending queued messages, and decide whether prompts sent during an active run should steer the current agent or wait as follow-ups.

### Thinking effort picker

- **What it is:** A browser picker for Pi's model thinking/reasoning effort setting.
- **What you can do:** Switch between `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, confirm the effective effort in the footer, and tune speed/cost/quality before sending a prompt.

### Scoped models

- **What it is:** A Web UI editor for `/scoped-models`, project/global model scope rules, and model cycling order.
- **What you can do:** Search available models, enable or disable scoped entries, inspect the effective model source, and save model choices so future prompts and tabs use the intended provider/model.

### Tools setup

- **What it is:** A browser selector for active and available Pi tools. The standalone tools extension owns the TUI `/tools` command.
- **What you can do:** Search or toggle tools, pin the current session branch, save a global default, configure an exact provider/model profile, or return a scope to inherited behavior. A successful model change immediately recomputes unpinned tools.

### Skills setup

- **What it is:** A browser selector for skills discovered in the active Pi session. The standalone skills extension owns the TUI `/skills` command.
- **What you can do:** Find skills by name or description, pin the current session branch, save a global default, configure an exact provider/model profile, or return a scope to inherited behavior. A successful model change immediately recomputes unpinned skills while preserving `disableModelInvocation` filtering and explicit disabled-skill blocking.

Session-specific tool and skill choices are independent and always win when their branch is resumed or selected in `/tree`. Exact model profiles are keyed by case-sensitive provider/model ID pairs and are stored as an array under settings-envelope version 8. Each profile contains nullable tool and skill selections: `null` inherits, while an empty array explicitly enables none. Legacy branch entries remain explicit pins; version-2 branch entries add `explicit` and `inherit` modes. Global and exact-model defaults are stored in the private Pi Web UI settings file (normally `~/.pi/webui/settings.json`) and do not mutate an explicit current session.

`webui-rpc-helper.mjs` owns the browser session's resource lifecycle in RPC mode. It captures or resolves an immutable runtime fallback, recomputes on session/tree/model events, and fences asynchronous model changes before applying them. HTTP model-profile writes validate the exact authenticated model and update the latest locked settings snapshot so concurrent writers and temporarily unavailable names are preserved.

`@firstpick/pi-package-qt-webui` consumes this package as the canonical tool/skill state owner. Its backend imports `webuiSettingsFile()`, `readWebuiSettings()`, `updateWebuiSettings()`, and the resource-selection helpers rather than copying the settings schema or lock protocol. Qt global and exact-model writes therefore merge into the same `resourceDefaults`, and its Pi helper uses the same `webui-tools-config` and `webui-skills-config` version-2 branch entries for session explicit/inherit state. Qt-only sampling remains outside this contract. Each Qt resource-state request reads the latest shared settings; there is no direct process-to-process synchronization.

### Optional features

- **What it is:** A Pi package manager for Web UI-aware extensions, prompts, themes, and optional dashboards. Optional companions are separate from the Web UI core install.
- **What you can do:** See whether each companion is enabled, disabled, registered, local, migratable, missing, conflicting, or updateable; use separate **Enable/Disable** and **Setup** actions for configurable loaded companions; open browser-native Skills Setup and Tools Setup from the loaded TUI command companion rows; keep per-row Install/Update actions; restore previous companions through one combined confirmation; use panel-level **Install all** or section-level **Install missing** for missing/unregistered packages only; and recover partial failures with **Retry failed** or **Copy commands**. Native questionnaires read and update the active session's real `questionnaire` tool state through direct **Enable/Disable** controls and do not expose a separate setup action. Batches run sequentially through Pi, continue after individual failures, and auto-restart an idle affected tab while deferring **Restart tab** when it is busy.
- **Prompt-impact metadata:** The checked baseline is `reports/pi-default-system-prompt-evaluation.md` at the repository root. `OPTIONAL_FEATURES[].promptImpact` stores the browser indicator class. Package-level bundled skill declarations count as initial prompt text; tool schemas and ordinary user or tool messages stay outside this indicator.

### `/btw` side questions

- **What it is:** A Web UI widget for the optional `/btw` side-question extension, keeping quick questions separate from the main agent flow.
- **What you can do:** Ask short side questions without derailing the main chat, inspect live output, steer or stop the side thread, and transfer useful context back into the main prompt when needed.

### Guided Git workflow

- **What it is:** A guided browser workflow for staging changes, generating commit messages with an optional one-shot fallback model, committing, pushing, and optionally creating a pull request.
- **What you can do:** Configure separate primary and fallback reasoning efforts, run the stage/message/commit/push steps, choose generated short or long commit messages, type a manual message, create or confirm PR branch names, review generated PR text, and push only after confirmation.

### Git branch picker

- **What it is:** A footer branch picker backed by the active tab's current Git repository.
- **What you can do:** View the current branch/repo, switch local branches, create and switch to a new branch, and get warnings when a branch change could affect active agent work.

### Git diff viewer

- **What it is:** A browser diff dialog for current Git changes in the active workspace.
- **What you can do:** Review staged, unstaged, untracked, and incoming changes; jump between files; see additions/deletions with line numbers; and inspect text previews before asking Pi to edit, commit, or create a PR.

### Codex usage

- **What it is:** A side-panel usage widget for Codex-family subscription-backed models.
- **What you can do:** Refresh usage, monitor short-window and weekly limits, see reset timing, and decide whether to switch models or delay large prompts.

### Pi stats dashboard

- **What it is:** The browser overlay from the optional stats companion, summarizing token, cost, cache, prompt/context, model, session, and command usage.
- **What you can do:** Filter by time range, refresh analytics, review daily/model/session breakdowns, inspect cost and cache behavior, and calibrate prompt estimates for more accurate local usage visibility.

Useful browser endpoints exposed by the local server include:

For local development, run the checkout helper directly, for example:

```bash
./dev/scripts/start-webui.sh --dev --cwd /path/to/project
```

The `--dev` helper checks this checkout's local npm dependencies before launch, applies available local updates, and force-refreshes `@earendil-works/pi-coding-agent` to the latest npm version so stale bundled Pi runtime packages do not break extension loading. Set `PI_WEBUI_DEV_SKIP_UPDATE=1` to skip this preflight for offline or intentionally pinned local testing.

### Browser checks

The package-owned Playwright/axe harness starts the real `pi-webui` server with the hermetic fake-Pi fixture. Provision the pinned engines once, then run the suite:

```bash
npx playwright install chromium
npm run test:browser
```

When developing a companion package from this workspace, register that package with Pi from its absolute local path (for example, `pi install /path/to/pi-extension-stats`) and reload the affected native Pi/Web UI tabs. Optional companions are resolved from Pi settings rather than the Web UI manifest.

## Optional companion packages

Installing `npm:@firstpick/pi-package-webui` installs the Web UI core only; optional companions are independently registered Pi packages. Web UI tabs load enabled resources resolved from normal Pi settings, while excluding the Web UI package itself from re-loading. Startup checks loaded Pi capabilities directly through RPC-visible commands, tools, themes, and live widget events. The side panel separately reports physical installation and Pi registration, plus enabled top-level resources. A companion already enabled through `~/.pi/agent/extensions`, `skills`, `prompts`, or `themes` is treated as locally available and is excluded from install batches; attempting to register its npm package is blocked because both paths would load the same resource twice. Legacy/hoisted package files without either a Pi settings entry or an enabled top-level resource remain installable so Pi can register them canonically.

Use a per-row **Install** or **Update** action for one package. **Install all** selects every missing/unregistered feature, while each section's **Install missing** selects only missing/unregistered features in that group; neither bulk action installs updates. A batch has one confirmation, runs sequentially, continues after failures, and keeps bounded diagnostics in each row and the activity log. The server automatically restarts an idle affected tab after full success; a busy tab is never interrupted and instead exposes one deferred **Restart tab** action. All browser install and migration actions are localhost-only and limited to the server allowlist.

You can install any published companion separately from a terminal with its exact unpinned Pi source, then reload Pi/Web UI tabs:

```bash
pi install npm:@firstpick/pi-extension-stats
```

Replace the package name with the companion listed below. Re-running the same `pi install npm:<package>` command is the supported update path. `@firstpick/pi-extension-aur-review` is not published yet; from this workspace, use `pi install /home/firstpick/pi-coding-agent-forge/pi-extension-aur-review` until its npm source becomes available.

Optional companions:

- `@firstpick/pi-package-natural-conversation` — standalone `/talk` Natural Conversation Mode package. Web UI does not import or load it directly; it detects the package through RPC-visible `/talk`, `/voice`, or `/conversation` commands and renders the optional shell only for tabs where those commands are available.
- `@firstpick/pi-extension-bang-command-autocomplete` — `!`/`!!` shell-command autocomplete. Native Pi TUI autocomplete still uses the companion provider; Web UI uses its own browser endpoint because RPC autocomplete providers do not reach the browser composer.
- `@firstpick/pi-extension-fish-user-bash` — fish/user-shell backend for `!`/`!!` user bash. Web UI emits Pi `user_bash` from the RPC helper so the companion can supply shell operations before default bash execution.
- `@firstpick/pi-extension-btw` — ephemeral `/btw` side-question command with a TUI overlay, Web UI live output widget, and Transfer Context action.
- `@firstpick/pi-extension-git-guided-workflow` — cross-surface `/git-guided-workflow` launcher plus native `/git-staged-msg`, `/git-branch-name`, and `/pr` generation; WebUI consumes its transient start request and keeps the browser renderer/server workflow local.
- `@firstpick/pi-extension-release-npm` — NPM publish menu and release widgets.
- `@firstpick/pi-extension-release-aur` — AUR publish menu and release widgets.
- `@firstpick/pi-extension-aur-review` — Deterministic manual repository/Git review with working-tree standalone snapshots, staged Guided Git snapshots, and a specialized browser card. Install from `/home/firstpick/pi-coding-agent-forge/pi-extension-aur-review` locally for now; npm installation is valid only after publication.
- `@firstpick/pi-extension-workflows` — `/workflow` runtime with non-blocking Web UI subprocess-output widgets.
- `@firstpick/pi-extension-feature-system-prompt` — feature-request classification and routing, with lightweight/complex decisions shown in the Web UI composer.
- `@firstpick/pi-extension-safety-guard` — configurable guardrails for dangerous bash commands and protected file edits, with native `/safety-guard-setup` controls.
- `@firstpick/pi-extension-setup-skills` — sole owner of the TUI `/skills` setup command; WebUI keeps separate browser-native skill controls.
- `@firstpick/pi-extension-todo-progress` — todo-progress rendering.
- `@firstpick/pi-extension-tools` — sole owner of the TUI `/tools` active-tool manager; WebUI keeps separate browser-native tool controls.
- `@firstpick/pi-package-remote-webui` — `/remote` trusted-LAN QR helper plus the optional browser controls for opening/closing LAN access and Remote PIN auth.
- `@firstpick/pi-extension-git-footer-status` — richer extension-owned git/footer status, including the structured Web UI footer payload. The Claude Usage panel consumes its live Anthropic response-header snapshot when available and keeps the standalone Claude CLI endpoint as an explicit/fallback refresh path.
- `@firstpick/pi-extension-stats` — stats commands and status data.
- `@firstpick/pi-themes-bundle` — Web UI and Pi theme resources.

## Guided Git workflow

The preferred WebUI entry points resolve `/git-guided-workflow` from the originating tab's RPC command catalog and send that exact extension command through the normal prompt route with an explicit message. Explicit dispatch leaves the browser composer draft and attachments untouched. Admission checks the captured tab state and queue first: streaming, compaction, pending messages, and unavailable state are refused rather than routed through generic follow-up behavior. A bounded browser-local per-tab permit is granted before dispatch, so only the client that sent the command may consume the next live activation; other browser clients attached to the same Pi tab ignore the broadcast. The extension then emits the activation contract described below; WebUI starts its existing local renderer/server workflow for the trusted envelope tab. The Git workflow button ultimately runs local Git commands in that Pi tab's working directory and covers both empty/new projects and existing repositories.

The browser does not use a prompt-only launch or generation fallback. The full flow requires tab-local extension provenance for `/git-staged-msg`, `/git-branch-name`, and `/pr`; each action rechecks its exact command before dispatch. Server-side generation preflight independently reads the RPC command catalog, selects only `source: "extension"`, and dispatches the resolved duplicate-suffixed name when needed. A same-named prompt command is rejected rather than expanded.

Configured workflow startup reads saved preferences through `GET /api/git-workflow/preferences?includeModels=false`. This path deliberately avoids `get_available_models` on Pi's shared RPC control channel; startup does not need the model catalog. The setup dialog keeps using the full endpoint because it must display authenticated models and their supported reasoning levels.

Before first use, run `/git-workflow-setup` in Pi or choose **Common Pi Options → Guided Git Setup** in the browser. Select an exact authenticated primary `provider/modelId`, a supported reasoning effort, and the workflow defaults described below. You may also select a different authenticated fallback model and its separately supported effort, or keep **No fallback**. The browser preselects the active tab model when possible and preserves a valid configured fallback when setup is reopened, but saving is always explicit. Preferences are stored globally in the Pi Web UI settings file (normally `~/.pi/webui/settings.json`), not in browser storage.

For a new project, the browser flow can:

1. Run `git init` when the active cwd is not yet a repository.
2. Check for `README.md` and `.gitignore`.
3. Create and stage starter `README.md`/`.gitignore` files without overwriting existing files.
4. Create an initial commit.
5. Rename the branch to `main`.
6. Add a GitHub remote from a confirmed `owner/repo`.
7. Push the initialized branch when you confirm the remote target.

For an existing repository, the workflow can:

1. Show staged, unstaged, untracked, and fetched incoming changes.
2. Fast-forward pull fetched incoming commits when the repository is safely behind.
3. Review/select files, preserve a non-empty staged set, or explicitly opt into `git add .`.
4. Generate `/git-staged-msg` with the configured model, supported reasoning effort, language, and scope policy without changing the tab's active model or effort. Each request is correlated to its originating tab and a before-generation snapshot of both message files; the browser advances only when both non-empty files are fresh and stable for that exact generation.
5. Use the preferred generated short/long message, a generated single-file default such as `updated file.txt`, or a manual **Commit input** message.
6. Show an optional pre-commit verification reminder, then require explicit confirmation before push and PR delivery actions.

A push with no configured remote returns the validated Git root directory name to the browser. Publication asks only for `public` or `private` visibility and a final confirmation. The server ignores client-supplied repository names, derives the name again from the Git root, and runs `gh repo create <directory-name> --public|--private --source=. --remote=origin --push` from that root. The child process inherits the Web UI server's Git and GitHub CLI environment and configuration. Existing remotes still block this recovery path.

The saved setup includes:

- one required primary generation profile reused for commit messages, branch names, and PR descriptions, plus an optional different fallback profile with its own effort;
- English or German output, short or long default commit choice, and automatic/never/required Conventional Commit scope;
- review/select (recommended), preserve-staged, or explicit stage-all behavior;
- ask/current-branch/PR-worktree delivery highlighting; and
- optional pre-commit verification reminders.

If a configured model or effort is unavailable, setup saving fails closed. During generation, the server encodes the configured profile in a private base64url extension-command argument and invokes the native extension command. The extension validates and resolves that profile, then calls its provider independently without changing the parent tab's active model or reasoning effort. The accepted RPC response confirms only that Pi handled the command. The server treats a correlated `extension_error` event as the native command's terminal failure and checks for a fresh correlated artifact only when the command did not report one. If the artifact check fails immediately after the accepted response, the server allows a bounded 500 ms grace period for a separately delivered correlated `extension_error` before reporting the artifact failure. Only the native command's internal direct model/provider-generation failure classification may start the explicitly configured fallback profile once. Invalid generated output, a missing or stale artifact after a command with no reported error, and all non-provider failures remain terminal. It never chooses an unconfigured model. Request validation, staged-content checks, cancellation, Git failures, and Pi process exit/error do not trigger fallback; a dead Pi process cannot run another attempt. Footer and Guided Git pushes send the active tab's current `HEAD` to the same-named branch on the preferred remote and set that branch as the upstream instead of retaining a potentially mismatched upstream. Guided Git never force-pushes automatically. Git hooks and signing configuration continue to run normally.

After the message is generated, **Create PR** invokes the native branch command to generate `dev/COMMIT/staged-branch-name.txt`, lets you confirm or edit the `type/feature-name` branch, then switches with `git switch -c` before committing. In PR mode, choose **Commit short**, **Commit long**, or type a message and use **Commit input**, then **Push and Create PR** pushes the branch, invokes `/pr`, shows the generated `dev/PR/<encodeURIComponent(current-branch)>.md` description for editing/confirmation, and creates the pull request with `gh pr create`. Use **Manual branch** to skip model branch-name generation and type the branch directly.

Use the workflow process buttons to jump directly to **Initialize**, **Stage**, **Message**, **Commit**, **Push**, or PR steps when earlier work was already completed manually. Selecting **Message** lets you either run `/git-staged-msg` or type a commit message and use **Commit input** directly. Selecting **Commit** loads the current generated files from `dev/COMMIT/` before enabling the commit choices. Manual preview remains available for existing files, while an active generation uses bounded single-flight polling and the exact server generation ID so duplicate timers and reconnects cannot surface a stale artifact. A yellow dot means that process was selected or is available but its action has not completed in this workflow; green means the process action completed.

All three generation commands come from `@firstpick/pi-extension-git-guided-workflow`. Direct invocations call the active Pi model; WebUI invocations call the configured Guided Git model independently. Creating the PR also requires an authenticated GitHub CLI (`gh`). Review the generated commit message, branch name, remote URL, and PR description before committing, pushing, or creating a PR.

### Extension activation contract

`@firstpick/pi-extension-git-guided-workflow` owns the canonical V1 constants:

```text
status key: git-guided-workflow:webui-start
payload type: firstpick.pi-extension-git-guided-workflow.start
payload version: 1
action: start
```

The JSON payload is closed and contains exactly `type`, `version`, `action`, and a UUID-v4 `requestId`. It deliberately contains no tab ID, cwd, repository path, Git data, preferences, model data, or success claim. The `extension_ui_request.tabId` envelope supplied by the server is the only routing authority.

The extension sets the non-empty status and immediately clears it. `handleGuidedGitActivationRequest` intercepts the exact key before generic `statusEntries` storage in both active- and inactive-tab event paths. It ignores clears and every `replayed: true` request. `parseGuidedGitStartPayload` rejects text over 1 KiB, invalid JSON, arrays, extra fields, unknown type/version/action, and malformed request IDs. `createGuidedGitLaunchPermitController` bounds origin-client permits by tab count and a short lifetime; valid live activation consumes exactly one permit before request-ID admission. `createGuidedGitActivationController` keeps bounded per-tab request-ID history and folds distinct rapid requests through one per-tab in-flight start promise. Setup keeps that promise unresolved through Save or Cancel, routes model/preferences calls to the trusted envelope tab, and passes the same owner guard into the Save continuation. Reset, cwd/session restart, and tab close invalidate the owner and permit before stale asynchronous setup work can mutate browser workflow state.

This is intentionally at-most-once. A disconnected browser may miss the live request rather than receive a stale restart after reconnection. The extension has no acknowledgement channel and can report only that activation was requested. Neither side retries uncertain delivery automatically.

Visible browser entry points call `launchGuidedGitWorkflow`: the composer/mobile-proxied button, command palette, and in-panel Start another/Restart actions. The launcher resolves duplicate-suffixed RPC command names from `commandCatalogForTab(tabId)` and calls `sendPrompt` with an explicit command string, preserving draft and attachment state. The event consumer and successful setup callback call the local `startGitWorkflow` directly to avoid an activation loop.

Focused validation:

```bash
node tests/guided-git-activation.test.mjs
node tests/guided-git-activation-static.test.mjs
node tests/guided-git-activation-http.test.mjs
npx playwright test --project=chromium tests/browser/guided-git-extension-command.spec.mjs
```

### Fallback browser/runtime contract

The persisted `generation.fallback` object always contains `provider`, `modelId`, and `thinkingLevel`; an empty provider/model pair disables fallback. The Guided Git setup client sends the nested fallback object on every save, filters the selected primary out of fallback choices, and sends empty provider/model fields when **No fallback** is selected. Server-side validation remains authoritative for availability, profile equality, and supported effort.

`POST /api/git-workflow/generate` keeps `generation` as the effective profile and allocates one server generation ID for commit, branch, or PR text. The server resolves an RPC command with `source: "extension"`, selects the configured profile, encodes it with the public generation arguments in a private base64url command argument, sends the exact native slash command, and waits for that synchronous command response. The server does not send `set_model` or `set_thinking_level` RPC requests. The attempt succeeds only when the command also produces a fresh artifact relative to the captured baseline. If artifact verification fails, a bounded grace period gives the native `extension_error` event precedence when RPC stdout delivers it after the accepted command response. Only the native extension's stable internal direct model/provider-failure classification may start the configured fallback and return `fallbackUsed: true` with `primaryGeneration`; a successful RPC response without either a fresh artifact or correlated native error is terminal. Terminal dispatch errors include bounded correlation metadata.

Fallback lifecycle events start with `webui_git_workflow_generation_fallback_started` and carry the effective `generation`, `primaryGeneration`, `kind`, `tabId`, and `generationId`, plus a curated bounded `reason` or `error`; full provider diagnostics remain server-side. The server retains at most the start and terminal fallback events per tab and replays them on EventSource reconnect. One correlation ID and pre-primary artifact baseline remain authoritative across both attempts. Commit, branch, and PR reads require successful terminal artifact verification, so failed-primary output cannot become ready while fallback runs. The server owns reservation, cancellation state, and the two-attempt ceiling; the browser observes lifecycle state and never sends a retry. Primary and fallback requests leave the parent session's active model and effort unchanged. Validation failures, user aborts, Git command failures, and Pi process exit/error remain ordinary failures and never enter fallback dispatch.

## Open Issue bot

The **Open Issue** Control Deck action always keeps **Copy complete issue** available. Automated submission is intentionally disabled by default and sends no request unless a deployment supplies the public configuration below before `app.js` loads. These are public routing values only—never put a Cloudflare secret, OpenAI key, GitHub App credential, status capability, or repository-write token in this object.

```html
<script>
  window.__PI_WEBUI_ISSUE_BOT_CONFIG__ = Object.freeze({
    enabled: true,
    gatewayBaseUrl: "https://issue-intake.example.com",
    turnstileSiteKey: "public-turnstile-site-key",
    privateSecurityReportUrl: "https://github.com/OWNER/REPOSITORY/security/advisories/new"
  });
</script>
```

Replace the disabled object in the deployed `public/index.html`, or inject the same object in the hosting HTML before the package's default configuration block. The client accepts only an HTTPS gateway/base URL without credentials, query, or fragment; a syntactically invalid or incomplete configuration fails closed and leaves the button disabled. `turnstileSiteKey` and the private-report URL are public values. The configured intake must allow the exact WebUI `Origin`; do not use a wildcard CORS policy. If a Content Security Policy is present, permit `https://challenges.cloudflare.com` for the Turnstile script/frame requests as documented by Turnstile.

The dialog shows queued/checking/created/rejected/review/unavailable/unknown status in a persistent live region. It polls the capability endpoint with bounded exponential delays (initial server delay, capped at 10 seconds) for at most two minutes, then offers **Refresh status** rather than continuing in the background. Closing the dialog aborts Turnstile, admission, or polling. A created result must be a validated `https://github.com/<owner>/<repo>/issues/<number>` link and opens with `noopener noreferrer`. Sensitive-content outcomes show only the configured private-report destination; the wizard never echoes the submitted security text. Rejection, review, unavailable, unknown, and polling-timeout paths retain the copy fallback.

Keep this browser configuration disabled until the gateway's exact-origin CORS policy, Turnstile hostname/action checks, private reporting URL, staging canary, quotas, and both gateway kill-switch decisions have passed review. Browser enablement does not bypass `ISSUE_BOT_ADMISSION_ENABLED` or `ISSUE_BOT_CREATE_ENABLED`; production creation remains a separate operator approval.

## Mobile and PWA notes

- The mobile composer starts as a compact `Ask Pi…` input and grows as you type.
- The flagged phone experience is opt-in with `?mobileShell=v2`; use `?mobileShell=legacy` for the immediate rollback. It provides labelled **Chat**, **Sessions**, **Activity**, and **Project** destinations, plus a full-height **More** surface. Sessions preserve the existing tab switch/draft/SSE behavior; Activity and Project reuse the existing blocker, workflow, file, Git, queue, and settings actions rather than creating mobile copies.
- **Essential** and **Detailed** in More only change phone presentation and progressive disclosures. They never truncate final answers, remove safety/scope/remote warnings, enable `compact-v1`, or change stored transcript/model output. The phone action sheet keeps attachments, queue, session actions, voice entry, and a tap-confirm Abort path available without nested menus.
- Continuity is browser-scoped: text drafts, the selected destination, and bounded attachment metadata survive reloads. Attachment bytes are never persisted; restored chips say **Reselect required**. A send that the server did not confirm is never replayed automatically and exposes only manual **Retry** (with the original request identity) or **Discard**.
- **Add Context** unifies Camera, Photos, Files, and Paste text over the existing attachment path. Camera/photo permissions remain browser-controlled and are requested only after the user chooses that source; Files and Paste text remain fallbacks.
- Browser notifications cover blockers, completion, and failure only while a Web UI client/service worker is active. They carry versioned opaque tab/run/blocker targets and reconcile server state before navigation. This is not Web Push after every client closes; Activity is the in-app fallback.
- Tablet adaptation is independently opt-in at 721–1050 CSS px with `?tabletShell=v2`; use `?tabletShell=legacy` to roll it back without changing the phone flag. It uses a destination rail, a bounded right inspector, pointer-aware targets, and full-screen files by default.
- Installable PWA support, blocked-tab browser notifications, and optional agent-done notifications require browser service-worker/notification support and usually require `localhost` or HTTPS. Install education is contextual and dismissible; browser/PWA use is never blocked.
- Plain `http://<LAN-IP>` can show the app, but some browsers disable PWA install and notifications there. None of these features changes the existing remote-access/authentication model.

## Network safety

- Default bind is localhost-only: `127.0.0.1:31415`.
- When `@firstpick/pi-package-remote-webui` is loaded and enabled, the side-panel **Remote WebUI** controls dispatch through `/remote`: opening rebinds the server to `0.0.0.0`, shows LAN URLs when available, and toggles to "Close for network".
- The optional **Remote PIN auth** toggle is off by default on first use. When enabled through `/remote auth on` or the Remote WebUI controls, the server saves that preference, generates a fresh random 4-digit PIN for each server start, shows it in the Remote WebUI controls and `/webui-status`, and requires it from non-local browser clients.
- Localhost clients stay frictionless and can toggle Remote PIN auth through the remote companion; changing the toggle persists the preference and disconnects existing event streams so remote clients must re-authenticate after enablement.
- `--host 0.0.0.0` also exposes the Web UI to the local network; pass `--remote-auth` to start with PIN auth already enabled.
- Any connected browser client with access (and the PIN, if enabled) can control Pi and run Web UI bash actions as the Web UI process user.
- Remote PIN auth is a simple trusted-LAN HTTP gate, not hardened multi-user authentication; do not expose it to untrusted networks.
- The Web UI update endpoint is restricted to localhost, because it runs package update commands and restarts the server.
- Treat Pi Web UI as a local companion, not a hardened multi-user web service.

## Troubleshooting

- **`/webui-start` is missing:** restart Pi after installing the package.
- **Wrong port or existing server:** use `/webui-status detailed`, or start on another port with `/webui-start --port 31500`.
- **Optional feature is disabled, missing, or unregistered:** check the side panel, use its Pi install action (or manually run the displayed `pi install npm:<package>` command), then run `/reload` in the active Pi tab.
- **Pi install/update fails:** copy the bounded row diagnostics and displayed Pi command. Run that command on the Web UI host to inspect full Pi/npm output and verify that the selected Pi executable can update user package settings.
- **Remote browser asks for a PIN:** read it from the optional **Remote WebUI** side-panel controls, `/webui-status`, `/remote status`, or the local Web UI server log. Disable the toggle from localhost to remove the PIN gate.
- **PWA install or notifications are unavailable:** use `localhost` or HTTPS; browser support varies on LAN HTTP URLs.

## Update safety

Pi and Web UI updates are planned before they run. The confirmation identifies the exact planned versions, and the update is rejected if that plan becomes stale. Web UI updates keep the previous working version available and restore it automatically when the new version does not become healthy.

## Session continuity

Restarting only the Web UI normally keeps managed Pi tabs, working directories, session files, and active work connected. A machine restart, power loss, supervisor failure, or explicit shutdown cannot preserve an in-progress model request; the saved transcript can still be reopened afterward.

## Settings and private data

Web UI settings are stored under `~/.pi/webui/` by default. Private runtime state, update records, authentication data, and supervisor details are not exposed to browsers. Do not delete private runtime files while managed tabs are still active.
