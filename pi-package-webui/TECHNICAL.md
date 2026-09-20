# Technical reference: Pi Web UI

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Requirements

- Node.js 22.19 or newer
- Pi installed and configured
- A modern browser

## Install

```bash
pi install npm:@firstpick/pi-package-webui
```

Restart Pi after installation.

## Start from Pi

```text
/webui-start
```

The usual address is <http://127.0.0.1:31415/>.

Common options:

```text
/webui-start 31500
/webui-start --no-open
/webui-start --name browser
/webui-start --remote-auth --host 0.0.0.0
```

- `--host <host>` changes the listening address.
- `--port <port>` changes the port.
- `--no-open` prevents automatic browser opening.
- `--no-session` starts without loading a saved Pi session.
- `--name <name>` names the first tab.
- `--remote-auth` enables PIN protection for non-local browsers.
- Arguments after `--` are passed to Pi.

Check a running Web UI with `/webui-status`. Add `detailed` to include tabs, sessions, models, and recent events.

## Standalone launcher

```bash
npm install -g @firstpick/pi-package-webui
pi-webui
```

Useful options:

- `--cwd <path>` chooses the first project folder.
- `--pi <command>` chooses the Pi executable.
- `--host` and `--port` change the listening address.
- `--output-mode normal|compact-v1` chooses the default output style.
- `--remote-auth` enables PIN protection for non-local browsers.
- `--migration-dry-run` previews optional-feature migration without changing packages.

If `--cwd` is omitted, the browser asks which project to open first.

## Settings and storage

User settings are stored in `~/.pi/webui/settings.json` by default. An older `~/.config/pi-webui/settings.json` is imported once when the new file does not yet exist.

Common overrides:

- `PI_WEBUI_HOST` and `PI_WEBUI_PORT` set the default address.
- `PI_WEBUI_PI_BIN` selects the Pi executable.
- `PI_WEBUI_REMOTE_AUTH=1` starts with PIN protection enabled.
- `PI_WEBUI_OUTPUT_MODE=normal|compact-v1` sets the default output style.
- `PI_WEBUI_SETTINGS_FILE` chooses another settings file.
- `PI_SESSION_SUMMARY_CONFIG_FILE` chooses another session-summary profile.
- `PI_WEBUI_FAST_PICKS_FILE` chooses another saved-folder list.

Private runtime and recovery files should not be edited or removed while Web UI tabs are active.

## Updates and rollback

The Pi and Web UI update controls show a plan before making changes. The confirmed plan is rejected if it becomes stale or no longer matches the running installation.

Web UI updates keep the previous working version available. If the replacement does not become healthy, the launcher restores the previous version automatically. Installations that cannot be identified safely are left unchanged and receive manual guidance instead.

A short interruption is possible during restart; zero downtime is not promised.

## Session continuity

The working-directory picker accepts a direct path for first, new, and split terminals and for cwd changes. On Windows, enter a rooted drive path such as `C:/` or `D:/project` to switch drives. From a drive root, **Parent** opens a **This PC** view listing ready filesystem drives; choose a drive to browse its root. **This PC** is navigation-only, so search and direct path entry remain available while selecting, creating, or pinning that virtual location is disabled. Web UI loads and validates a directory before it can be selected; an invalid or unavailable path remains in the field so you can correct it.

When tabs span multiple working directories, a directory with one tab stays a normal, non-dropdown tab. Hover over it—or focus controls within it—to reveal **+ Tab** directly below, matching the placement used by grouped terminal menus without repeating the current tab. Directories with multiple tabs continue to use the grouped terminal menu.

Restarting only the Web UI normally keeps managed Pi tabs, working folders, saved sessions, and active work connected to the replacement server. Choosing a saved session from `/resume` opens it in a separate terminal tab and leaves the current terminal unchanged.

Continuity requires the same Pi configuration location and Web UI port. It does not preserve browser drafts, app-runner processes, or an active model request across a machine restart, power loss, explicit shutdown, or supervisor failure. Saved transcript history can still be reopened afterward.

Use **Stop** when you intend to terminate managed tabs. Do not manually delete runtime state while tabs are active.

## Session titles and summaries

Tabs use automatic naming from the first prompt unless you provide an explicit name. Run `/summary-setup` to choose the summary model, automatic generation, title behavior, prompts, and optional latest-summary context.

Summary generation is opt-in. It uses the active user message, final assistant response, and tool names; it excludes thinking, images, tool arguments and results, credentials, and hidden provider data. Failed refreshes keep the previous successful summary.

Use `/summary`, `/summary refresh`, or `/summary workspace` to view, refresh, or compare available summaries. Turn off automatic generation to stop recurring model calls without deleting saved prompts or previous summaries.

## File viewer

The Files panel opens UTF-8 text in Source mode, renders Markdown in Preview mode, and displays supported raster images as read-only previews. Image support covers PNG, JPEG, GIF, WebP, and AVIF. SVG, PDF, video, audio, and other binary formats are not rendered in the viewer; use **Open in Default Editor** from the file row instead.

Text and image reads remain scoped to the active tab's working directory and its existing path-confinement checks. The viewer limits each file to 2 MiB. Image previews cannot be edited, searched as text, or sent as text selections. Git-originated image opens still begin in Changes mode when a bounded Git snapshot is available, with Preview available alongside it.

## Optional features

Every server start performs a bounded, read-only startup audit of optional companion packages. Missing, unregistered, or older companions appear in the Optional features panel without blocking the core Web UI. The Guided Git entry installs `@firstpick/pi-extension-git-guided-workflow`, which registers the launcher and native commit-message, branch-name, and pull-request generation commands as one Pi package.

Prompt-impact indicators distinguish initial system-prompt text (`+`), conditional text that can appear while a session is running (`+...`), and packages with no measured system-prompt text (`-`). Bundled skill declarations count toward the package indicator. Tool schemas and ordinary user or tool messages are not counted.

- **Migrate…** reviews and installs selected legacy companions.
- **Later** dismisses the startup reminder while leaving migration available in settings.
- **Retry failed** retries only failed package installs.
- **Copy commands** provides manual Pi install commands.
- **Recheck** repeats the read-only package check.
- **Install all** selects every missing or unregistered companion. A section's **Install missing** selects only missing or unregistered companions in that section. Both use one confirmation, install sequentially, and continue after individual failures.
- Configurable loaded companions show separate **Enable/Disable** and **Setup** actions. The loaded **TUI Skills command** and **TUI Tools command** rows open the browser-native Skills Setup and Tools Setup dialogs. Native questionnaires use the real active-session `questionnaire` tool state and expose only direct **Enable/Disable** access controls.

Installs run one at a time and never invent percentage progress. Busy tabs are not restarted without a visible follow-up action. For unattended migration, use `--migrate-optional-features`; use `--migration-dry-run` to print the planned audit-selected migration without changing packages.

You can also install a companion directly with Pi, for example:

```bash
pi install npm:@firstpick/pi-extension-stats
```

Re-running the same `pi install npm:<package>` command is the supported update path.

## Normal and compact output

Normal output shows the full live tool and response stream. Compact output keeps the current tool status and final answer while omitting most intermediate details from the live display.

Completed responses replace streamed drafts, including shortened or removed thinking. Refreshing history does not restore text removed by the provider. On older Pi releases, tool arguments stay hidden until Pi identifies the tool, which may happen only when argument generation completes. This keeps Intercom transport content out of the main transcript.

Choose the mode under **Controls → Output processing** or **Settings → Browser workflow**, then select **Compact**. The stable setting and command-line identifier is `compact-v1`. The setting affects display only; it does not change Pi prompts, tools, models, saved transcript meaning, or inference.

## Code block syntax highlighting

Fenced code blocks in agent output, release notes, session summaries, and the Markdown file preview are colored automatically from the language written after the opening fence, for example ` ```python `.

Recognized languages and their aliases:

| Language | Accepted after the opening fence |
| --- | --- |
| Python | `python`, `py` |
| JavaScript | `javascript`, `js`, `jsx`, `mjs`, `cjs`, `node` |
| TypeScript | `typescript`, `ts`, `tsx` |
| Shell | `bash`, `sh`, `shell`, `zsh` |
| PowerShell | `powershell`, `pwsh`, `ps1` |
| Windows command scripts | `cmd`, `bat`, `batch`, `dos` |
| JSON | `json`, `jsonc` |
| INI and properties | `ini`, `cfg`, `conf`, `properties` |
| TOML | `toml` |
| YAML | `yaml`, `yml` |
| Diffs and patches | `diff`, `patch` |
| SQL | `sql` |
| Stylesheets | `css` |
| Markup | `html`, `htm`, `xml`, `svg` |
| Container files | `dockerfile`, `docker` |
| C and C++ | `c`, `h`, `cpp`, `c++`, `cc`, `cxx`, `hpp`, `hxx` |
| Java | `java` |
| Go | `go`, `golang` |
| Rust | `rust`, `rs` |
| C# | `csharp`, `cs`, `c#`, `dotnet` |

Behavior and limits:

- Colors come from the active theme's **Syntax Highlighting** token group, so highlighting follows your chosen light or dark theme. Editing those tokens under **Controls → Interface → Theme → Customize…** changes code colors immediately.
- A block without a language, with an unrecognized language, or larger than 50,000 characters or 2,000 lines is shown as ordinary unhighlighted text.
- Highlighting is display only. Copying a code block, selecting text, and searching the transcript still return the exact original source, and nothing is sent anywhere for analysis.
- Coloring is intentionally approximate rather than a full language parser. Unusual constructs such as nested string interpolation, shell heredocs, PowerShell here-strings, or embedded scripts inside markup may be colored imprecisely; the code text itself is never altered.
- Fenced `mermaid` and `mmd` blocks keep rendering as diagrams instead of highlighted source.

## Codex subscription Fast mode

The optional `@firstpick/pi-extension-codex-fast-mode` companion adds a **Normal / Fast** selector under **Codex Usage**. Fast mode is off by default and applies only to the active Pi session branch. Eligible subscription-backed models may respond about 1.5× faster while using 2× Standard credits for GPT-5.4 or 2.5× for GPT-5.5/5.6. Account and model eligibility remain controlled by the provider.

## Footer scoped-model layouts

Right-click the Git footer **Model** box, or focus it and press the Context Menu key or `Shift+F10`, then choose **Toggle advanced**. Flat mode keeps the existing drag and `Alt+Up` / `Alt+Down` reorder controls. Advanced mode displays providers in alphabetic columns and preserves the configured scoped-model cycling order inside each provider. On desktop, the picker grows with the provider count and overlays side panels when it needs their screen space. It stops at the viewport gutter and scrolls the provider row internally when more columns remain. On narrow screens, provider groups stack vertically so the picker stays within the page. While advanced mode is active, the same context-menu action is labelled **Toggle Simple**.

In advanced mode, `Left` and `Right` move between providers while retaining the current row when possible. `Up`, `Down`, `Home`, and `End` move within a provider. `Enter` or `Space` applies the focused model; `Escape` closes the picker and returns focus to the Model box. Arrow navigation alone never changes the active model.

The flat-or-advanced choice is a browser-local display preference. It persists across reloads and synchronizes between same-origin Web UI tabs, but it does not change Pi settings, scoped-model order, server state, or another browser's choice.

## Tool and skill scopes

The browser-native tool and skill selectors offer **Session only**, **Global default**, and **Model default** scopes. The extension-owned TUI `/tools` and `/skills` commands use the same scopes and saved state. Tools and skills resolve independently: a session choice wins over an exact case-sensitive provider/model profile, which wins over the global default and then Pi's runtime default. WebUI does not register either TUI command; they belong to `@firstpick/pi-extension-tools` and `@firstpick/pi-extension-setup-skills`.

After Pi successfully selects a model, its exact tool and skill profiles apply immediately for resource types that are not pinned by the current session; no reload or selector reopening is needed. A model with no profile falls back through the global and runtime defaults. Choosing a model inside a profile editor selects the profile to edit—it does not switch the active Pi model.

Use **Use inherited defaults** to remove the selected session, global, or model override. Session choices are stored on the active branch and remain effective when that branch is resumed. Global and exact-model saves do not rewrite an explicit session choice. Empty selections intentionally enable no resources; inherited selections are distinct from empty selections. Profiles can reference only tools and skills already discovered by Pi, and unavailable saved names are retained for later sessions.

Tracked skill files appear as selectable tags above the composer. The strip keeps as many tags visible as fit; **+X** opens a bounded list above the strip containing only the hidden tags. Select an item to open the same skill editor. The list closes after selection, outside interaction, `Escape`, tab/session rerendering, or when resizing makes every tag visible.

When the browser page is hidden, the Web UI closes that page's live event stream so the browser cannot accumulate serialized output frames for later parsing and DOM rendering. Merely moving focus to another visible window does not pause streaming. On return, it first fetches authoritative tabs, state, and transcript snapshots, reconnects live events, and refreshes nonessential panels during browser idle time. Pending extension prompts are replayed by the server after reconnection, and completed output remains available from the authoritative transcript.

## Append-system prompt selection

The command palette action **/append-system** opens a picker for one global WebUI append-system prompt override. The scan starts from exactly two visible roots: the active Pi tab's working directory and your `~/.pi` folder. It checks at most 2,048 directories to a maximum visible-path depth of 10, returns at most 256 candidates and 64 diagnostics, and matches only the exact case-sensitive visible filename `APPEND_SYSTEM.md`. Root, folder, and file symbolic links are followed, including links whose targets are outside both visible roots. Candidate rows keep the visible linked path. Broken links and links to unsupported file types are skipped with bounded diagnostics, and the scan never reads or displays prompt contents.

**Trust warning:** a followed link can make the picker scan directories or load a prompt anywhere the Web UI process can read. Check both the link and its current target before selecting it. Link cycles and repeated targets remain bounded, but a link may be retargeted later.

The saved choice is a global WebUI setting, discovered through the active tab's working directory but applied to every new or reloaded WebUI Pi tab. It persists in private WebUI settings and its visible path is passed to newly launched Pi processes as a `--append-system-prompt` argument; a running session keeps its current instructions until restart. The exact global default path `~/.pi/agent/APPEND_SYSTEM.md` is not shown as a separate candidate because **Use Pi default discovery** already represents it. Submitting or previously saving that exact path is also treated as default discovery, without a redundant launcher override. Project-local defaults and nested alternatives such as `~/.pi/agent/minimal/APPEND_SYSTEM.md` remain selectable.

After a changed save the picker asks once whether to restart the active Pi tab. Cancel keeps the saved choice ready for the next manual reload or new tab. A saved visible path remains valid if its followed target changes to another regular file. If the link breaks, resolves to an unsupported type, or the visible path otherwise stops being valid, it stays visible in the picker marked as invalid with a diagnostic, and launching falls back to Pi's normal `APPEND_SYSTEM.md` discovery until you pick a valid file or choose **Use Pi default discovery**.

Hover a terminal tab to see `Append-system prompt: <path>` when that tab's Pi process started with an effective WebUI-selected non-default prompt. A grouped item reports its own prompt, while a collapsed group reports its active represented tab. Tabs using default discovery omit the line. Changing the saved choice does not rewrite existing tabs; their launch-time information changes only after a full Pi-process restart or tab recreation. The tooltip displays only the validated visible path and never reads or shows prompt contents.

Discovery and saving are localhost-only; a request rejected from a non-local browser shows a clear error in the picker and changes nothing. User-supplied Pi launcher arguments are still appended after the saved override. Pi appends repeatable `--append-system-prompt` inputs in argument order, so both the saved prompt and any later launcher prompts contribute in that order.

## Events and session-tree navigation

Visible non-Intercom tool start, finish, and failure rows in **Events** show the tool name, lifecycle status, a shortened call ID, completion duration when a matching start was observed, and a bounded path only for a small set of file-oriented tools. The panel never displays unrestricted arguments, raw results, or tool output. Select any event row to keep the existing jump-to-chat behavior.

Use the **Show** selector above the log to choose **All events**, **Errors / failures**, **Warnings**, **Tool activity**, or **Tree available**. The active filter hides nonmatching rows without discarding them, changing the 120-row browser history bound, or altering warning/error notices and unread counts. The choice is stored in browser-local storage, applies to new rows immediately, and synchronizes across same-origin Web UI tabs. A count reports matching and total rows; an empty message appears when the current history has no matches.

Successful subagent Auto-Clear activity uses one page-local event row. Each cleanup adds its cleared-run count to that row, refreshes the timestamp, and moves the row to the top. Manual cleanup and Auto-Clear failures remain separate events. Switching the active terminal clears this counter with the rest of the browser-held Events history.

Right-click any event row, press the Context Menu key, or press `Shift+F10` to choose **Detailed** or **Compact** display. Detailed is the default. Compact hides the secondary target, status, duration, and call-ID line, reduces row spacing, and keeps the timestamp and summary visible. Tool rows retain a colored left accent so starts, finishes, and failures remain distinct. The choice is stored in browser-local storage and applies across Web UI sessions in that browser.

A tool lifecycle row with a stable call ID also offers **Tree…**. Choose it to resolve the row against the current persisted session tree. Start rows select the tool-call boundary. Finish and failure rows select the result boundary when available, otherwise the call boundary. General Web UI status events do not offer Tree navigation.

Before navigation, Web UI confirms that the current session branch will change, later entries will remain in the tree, no automatic branch summary will be generated, and `/tree` can navigate back. Cancelling sends no navigation request. Accepting navigates with summarization disabled, refreshes the active tab, and shows normal `/tree` feedback.

An unpersisted, removed, or stale boundary produces visible feedback and leaves the session unchanged. The same is true when no persistent session is available or the server rejects navigation while Pi is busy. Retry after the tool boundary has persisted or the active run has settled; use the full `/tree` selector when you need another branch or optional abandoned-branch summarization.

## Global control visibility

Right-click a supported workspace, Control Deck, composer, workflow, attachment, or input-frame tag control. Its direct menu offers **Hide**, **Open setup**, **Show all**, and **Reset defaults**. Right-click empty space in a marked toolbar, Control Deck header/footer, or composer region for the complete grouped menu, which also offers **Open setup**. The menus support the Context Menu key and `Shift+F10`, arrow keys, `Home`, `End`, `Escape`, and normal outside-click dismissal.

**Open setup** displays all 24 optional controls in five groups. Each native checkbox represents your visibility preference: clear it to hide that control or tag type, or select it to allow the control to appear. Changes apply and save immediately; there is no Save or Cancel step. **Escape** and **Close** dismiss the dialog and normally return focus to the invoking control. If that control was hidden while setup was open, focus returns to the prompt instead. On narrow screens the catalog scrolls inside the dialog while the quick actions and Close remain available.

**Show all** records an explicit state in which every supported item may appear. **Reset defaults** removes the explicit choice and follows package defaults; all supported items are visible by default. Both actions update an open setup dialog immediately and can restore controls even when every optional button in a region is hidden. **Send** is not configurable and never appears in setup. Right-clicking Send keeps the native browser menu, but focusing **Send** and pressing `Shift+F10` or the Context Menu key opens the complete grouped visibility list, so keyboard users always have a recovery path even after every optional control is hidden.

Visibility is user-global in the private Web UI settings file and is mirrored to browser storage for immediate and offline startup. Other open same-origin tabs adopt browser-cache changes immediately; other browser clients adopt the durable setting when they reconcile or reload. A checked setup entry is a preference, not an availability guarantee: showing an item does not install an optional package or override session state, permissions, device layout, or capability gating, so an unavailable control can remain absent.

## Control Deck placement and persistence

Choose **Right**, **Left**, or **Both** under **Controls → Interface → Control Deck placement**. Right is the default. Both keeps separate collapse state and width for each side; drag a section header or focus it and use `Alt+ArrowUp` / `Alt+ArrowDown` to reorder within its assigned side, and `Alt+ArrowLeft` / `Alt+ArrowRight` to move it between sides.

With **Tab placement** set to **Sidebar**, the placement control stays active but **Both** is unavailable. **Right** presents the terminal/tabs rail on the left and the Control Deck on the right; **Left** swaps them. If **Both** was selected before switching to Sidebar, Web UI changes the Control Deck placement to **Right** and saves that valid placement.

When the viewport or active split terminal/file viewer cannot fit the selected desktop columns, Web UI uses one combined Control Deck overlay. This does not change side assignments, desktop collapse state, or saved widths. Close the overlay with its backdrop or `Escape`. Mobile **Edit** / **Done** continues to allow vertical section ordering only.

Control Deck placement, side assignment/order, section open/closed state (any number of sections may be open at once), visibility, side collapse, side widths, terminal placement, terminal-rail width, and the other durable interface preferences are stored in the private Web UI settings file and mirrored to browser storage for offline startup. The right Control Deck width also maintains the older single-panel compatibility value; the left width never replaces it. Concurrent tabs reconcile named fields so one tab's clean placement change does not erase another tab's pending section move or terminal-rail resize.

## Desktop panel sizing

Every visible desktop side panel has a separator on the edge facing the workspace. This includes the right Control Deck, the Control Deck after choosing **Left**, both independently sized Control Decks after choosing **Both**, and the terminal/tabs rail on either side after choosing **Sidebar**. Drag a separator to resize its panel. Focus it and use the arrow keys for 24-pixel steps, hold `Shift` for 80-pixel steps, or use `Home` and `End` for the allowed minimum and maximum. Arrow direction follows the panel edge: move toward the outside to widen the panel.

Panel widths are limited by the available desktop workspace so the main transcript retains usable space. Left and right Control Deck widths and the terminal-rail width are cached and saved independently in the user-scoped interface layout, then restored after reloads. Resize handles are hidden for collapsed panels and in mobile, tablet, overlay, and embedded layouts.

### Backup, restore, and downgrade rollback

Before downgrading, stop the Web UI and copy `~/.pi/webui/settings.json` to a safe local backup. The prior package treats the newer two-sided layout as unknown and may replace it with defaults on its next layout write. Retained browser compatibility values provide a usable right-only fallback but do not protect server-side left/right assignments.

To restore: stop the Web UI, re-upgrade to a version that supports the two-sided Control Deck, replace `~/.pi/webui/settings.json` with the backup using the same owner and private permissions, then start the Web UI. Do not restore or edit the file while tabs are active.

## Subagent observability

The **Subagents** panel accepts managed `pi-subagents` and workflow runs plus cooperating SDK, Pi RPC, JSON, print, interactive/tmux, schedule, gate, and custom launchers. It groups exact parent-session matches with their WebUI terminal and places unmatched registered runs under **External agents**. A model-less `pi-subagents` workflow controller renders as a collapsible run header; its model-powered children remain normal rows inside that section. The workflow controller is count-neutral, so totals report agents rather than orchestration processes. Counts include retained instances that became terminal during the current server run; the status line separately reports running and stale instances. Gate history refers to its child and does not add another count.

At server start or restart, only queued or running agents reconnect from prior state. Pre-existing stale, lost, done, failed, and cancelled rows are not loaded into terminal groups or **External agents**. A run that becomes stale, lost, or terminal after the current server starts remains visible for inspection and normal clearing.

The **Agent models** editor stores ordered model and thinking defaults for the eight built-in roles. User defaults apply unless the active project has its own saved values. The active Pi tab loads one immutable snapshot on startup or reload. Saving changes does not affect that tab until you select **Reload active tab**.

For `subagent` and `subagent_gate` calls, WebUI fills an omitted model from the matching role slot. Role occurrence counts are independent, so the first reviewer uses reviewer slot 1 even if a worker appears earlier in the same task list. Counted tasks with different same-role slots are not collapsed into one model; use separate task entries. For `workflowScript`, WebUI wraps the supplied script with a local `runs` adapter that applies the same defaults to `runs.run` and `runs.all` children without editing individual call sites.

An explicit reviewer model and terminal thinking suffix must exactly match that occurrence's configured slot. A mismatch is blocked before the structured tool executes and reports the occurrence, expected model, requested model, and correction. WebUI does not silently replace it. Retry with the reported model, or omit the model to use the slot default. Explicit models for non-reviewer roles retain their existing behavior.

Only after you explicitly authorize the exact reviewer occurrence and requested model may Pi call `approve_subagent_model_deviation`. The tool opens an interactive confirmation naming that occurrence and model; rejection or unavailable UI creates no permit. Its reason is trimmed and kept in the local helper state. A permit expires after two minutes, admits one matching mismatch, and is then removed. The active tab retains at most eight unused permits. Permits are tied to the tab's immutable launch-slot snapshot and helper generation, so a reload, session replacement, changed snapshot, or snapshot-read failure invalidates them. Until a failed snapshot load succeeds on reload, WebUI blocks reviewer-bearing structured launches and opaque workflow scripts while continuing to allow non-reviewer direct launches.

A permit embedded into a workflow wrapper is leased to that one workflow and removed from helper memory immediately. Leasing spends the permit even if the workflow never uses it or later fails. Direct admission likewise spends a matching permit before downstream execution; a downstream failure does not restore it. In either case, you must explicitly authorize a replacement permit when needed.

This admission check is WebUI-local. Launch paths that bypass the helper are not covered. A `runs.all` mismatch is rejected before any child in that call starts, but a later mismatch in sequential workflow code cannot undo an earlier `runs.run` child. Exact configured model strings are used rather than fuzzy upstream model resolution. Native provider fallback can still change the final runtime model after an admitted launch later fails.

Use the WebUI wrapper when launching Pi subprocesses that should be visible:

```bash
pi-webui agent run --launcher rpc -- pi --mode rpc --no-session
pi-webui agent run --launcher json -- pi --mode json -p --no-session "Review this change"
pi-webui agent run --launcher print -- pi -p --no-session "Review this change"
```

The command prints its resolved registration port and scope. If WebUI uses a non-default port, pass the same value with `--port <webui-port>` or set `PI_WEBUI_PORT`; the CLI does not discover running WebUI processes or scopes automatically.

Attach a persisted independent session read-only with:

```bash
pi-webui agent attach --session <session-id-or-session-file> --name "Independent review"
```

Unwrapped SDK sessions and independently started Pi/tmux processes are intentionally invisible: Pi has no safe universal parent-child discovery, and WebUI does not scan processes or tmux panes. Use the supplied tracking adapter, wrapper, reporter integration, or explicit attach. An attached session without live heartbeat evidence is shown as stale rather than assumed running.

Output quality depends on the source. Session and structured-event sources can provide a transcript; print mode provides only bounded plain output; metadata-only registrations truthfully report that output is unavailable. Controls are owner-declared: unsupported cancel, refresh, copy, and dismissal actions are hidden.

Tracked subagent output can open in the normal non-blocking overlay or in a dedicated **Subagent** terminal tab. Both views are read-only. Closing a projected terminal tab only closes that view; it does not stop or interrupt the child run.

Each tracked row can show exactly six telemetry cards: PI, measured token speed, context, model, effort, and input/output tokens from a bounded recent session scan. Unavailable or legacy evidence remains `—` or `unknown` rather than being estimated.

**Clear finished** and **Auto-Clear** can hide terminal external-agent projections from WebUI. Stale or lost sessions added with `pi-webui agent attach` remain visible for inspection and provide a row-level **Detach persisted session from WebUI** action. Clearing or detaching does not delete or modify the producer-owned registry record, output artifact, process, or session; those remain subject to their normal private retention policy.

Registry state uses the WebUI state directory (`$XDG_STATE_HOME/pi-webui/`, or `~/.local/state/pi-webui/`) and is private to the local user and WebUI scope. Do not expose WebUI directly to an untrusted network or manually edit registry files while runs are active. Browser requests use opaque output identifiers and cannot select host paths.

Troubleshooting:

- Keep the same WebUI port and Pi agent configuration directory across a restart so active registered runs reconnect to the same scope. For a non-default port, pass `--port` to every `pi-webui agent` command or set `PI_WEBUI_PORT`.
- A **stale** row has missed heartbeat evidence; **lost** means the longer loss threshold elapsed without an explicit terminal event. Neither means success.
- If an expected independent run is absent, confirm it used a wrapper/tracking adapter or attach it explicitly; process discovery is intentionally unavailable.
- If output says unavailable, the producer registered metadata but no bounded output source. Restarting the browser cannot reconstruct evidence the producer never registered.

## Agent conversation viewer

Direct `pi-intercom` messages and native subagent-supervisor coordination appear as conversation tags beneath the composer for the active tab. Each tag represents one direct two-agent conversation. On desktop, the strip starts at the right edge and extends toward the middle, using up to half of the prompt row. Each direct tag is width-bounded. WebUI measures complete tags and replaces those that do not fit with a `+X` disclosure. The disclosure opens a bounded, keyboard-accessible list above the composer. Narrow layouts give the strip the full row and keep 44-pixel touch targets. Long names visually truncate only when one name exceeds its available space, while complete conversation names remain exposed through accessible labels and tooltips. Select a conversation to open a large, read-only chat dialog; keyboard focus remains inside the dialog until it closes and then returns to the originating tag or disclosure.

Generic `intercom` tool calls, paired results, and incoming `intercom_message` records are omitted from the normal main-output transcript. Mixed assistant records keep their unrelated text and tool activity. The viewer reads the original persisted records through its separate sanitized endpoint, so removing transport cards from the main output does not remove messages from the conversation dialog.

The viewer reconstructs conversations from the active branch of the persisted Pi session, so supported history returns after a browser or WebUI restart. Compacted or bounded-away history may be marked unavailable. While the dialog is open, WebUI periodically checks for new persisted messages; tab changes and rapid selections discard stale responses.

Only participant names or IDs, message text, ordering time, and truncation notices are displayed. Attachments, tool calls and results, thinking, stdout/stderr, filesystem paths, raw session records, and automated subagent control/result relays are excluded. The initial view is limited to 32 conversations, 200 displayed messages per conversation, and bounded message/response sizes.

If an expected tag is absent, confirm that the agents used direct Intercom or native supervisor coordination in the active session branch. Generic child output and independent process logs do not become conversations.

## Guided Git launcher

Install `@firstpick/pi-extension-git-guided-workflow` to make `/git-guided-workflow` the preferred launcher in both Pi's terminal interface and WebUI. In WebUI, typing the command or selecting the Guided Git action requests the browser workflow for the originating tab. Only the browser client that sent the command consumes the live activation. The request is one-shot: a disconnected browser can miss it, but WebUI will not replay it later and unexpectedly restart Git work.

Browser generation accepts only RPC-capable extension provenance for `/git-staged-msg`, `/git-branch-name`, and `/pr`. A separately installed same-named prompt template is not a fallback for the native path.

Publishing a repository with no remote requires GitHub CLI (`gh`) to be installed and authenticated. Guided Git derives the GitHub repository name from the local Git root directory, asks you to choose **Public** or **Private** from a dropdown, then shows a final confirmation before it creates the repository, adds `origin`, and pushes. No visibility is preselected. The command uses your system Git and GitHub CLI configuration.

The launcher refuses immediately while the originating tab is running, compacting context, or has pending messages; it does not queue Guided Git for later. If the command does not open the workflow, confirm that the tab is idle, has no queued messages, and lists `/git-guided-workflow`, `/git-staged-msg`, `/git-branch-name`, and `/pr` as extension commands. Restart or reload the Pi tab after installing or updating the extension. Retrying after an uncertain activation is a manual decision; WebUI does not retry it automatically.

## Guided Git generation profiles

Open **Common Pi Options → Guided Git Setup** or run `/git-workflow-setup` before using generated commit messages, branch names, or pull-request text. Choose the required primary model and its reasoning effort. You may also choose a different fallback model and a separate supported effort, or leave **No fallback** selected. The effort lists follow the capabilities reported for each selected model. Before enabling fallback, account for its privacy and cost impact: large commit diffs use multiple model requests, and a fallback attempt sends the complete staged evidence again to the configured fallback provider.

A configured fallback is a strict one-retry policy: Guided Git lets the primary model finish its own retry lifecycle, then makes at most one fallback attempt after a final primary model-generation failure. The workflow output identifies the primary and configured fallback at startup and reports when generation continues with the fallback. For a commit diff at the extension’s 16 MiB ceiling, one attempt can use up to 35 requests; chunk-summary formatting does not trigger retries. Fallback can repeat the full attempt, for up to 70 requests across both providers. If safe commit text lacks a summary and typed change list, the native extension can use its final-request allowance for one presentation rewrite with the same model. A failed optional rewrite keeps the original safe text for editing and does not trigger provider fallback. Fallback status is restored when you return to the tab or its live event connection reconnects. Generated commit, branch, or PR text is treated as ready only after the correlated attempt finishes successfully. Primary and fallback requests run independently of the parent Pi session, whose active model and reasoning effort remain unchanged throughout.

Fallback applies only to model generation. Request validation failures, staged-content checks, busy-state rejection, user cancellation, Git command failures, and a stopped or failed Pi process do not trigger it. A dead Pi process cannot run the fallback; restart or reload the tab and start a new generation request after addressing the failure.

## Mobile layout

On a phone, tap the current terminal name to open full-screen terminal navigation. Grouped terminals use their title as a dropdown for choosing one terminal or subagent view. Tap **More** to open secondary controls in a full-screen overlay. Git footer **Details** opens full-screen with refresh inside and a top `−` button. Hover-only tooltips stay hidden on touch controls. To reorder the **Control Deck**, tap **Edit**, move sections, then tap **Done**.

At the phone/coarse-pointer breakpoint, the legacy mobile shell collapses terminal navigation and secondary composer controls by default:

- Both legacy mobile and Mobile Experience v2 use a balanced compact scale for text, cards, padding, gaps, and navigation. Interactive controls use the user-selected 40-pixel minimum; safe-area offsets remain intact. Tablet and desktop sizing are unchanged.
- Tap the current terminal summary to open full-screen terminal navigation containing terminal tabs, new-tab choices, workspace actions, and **Close all Tabs**.
- On mobile, a regular or subagent terminal-group title is a dropdown button. Open it to reveal the group list, then choose an individual terminal or subagent view. Desktop group-title clicks keep switching directly to the active group member.
- Close full-screen terminal navigation with the summary button, `Escape`, or by choosing a terminal.
- Git footer **Details** opens as a full-screen legacy-mobile overlay. Refresh is available only inside the expanded overlay; use the top `−` button or `Escape` to minimize it. The overlay packs content at the top in two labelled grids: session metrics, then workspace, Git, and runtime metadata. Odd or long cards span both columns. Desktop refresh behavior is unchanged.
- The compact composer keeps the prompt, attachment, Send, and applicable Abort, Follow-up, and Steer controls immediately available.
- Todo progress uses one overflow-safe summary line while collapsed. Tap the line to expand the goal, progress bar, checklist, and footer; native keyboard and screen-reader disclosure behavior remains available.
- Tap **More** to open grouped session, workspace, command, workflow, context, and mode controls in a full-screen legacy-mobile overlay. Use the accessible top-right `−` control or `Escape` to minimize it and return focus to **More**.
- Control Deck section reordering is always enabled on desktop: drag a section header or use `Alt+ArrowUp` / `Alt+ArrowDown`. Mobile keeps the transient **Edit** / **Done** mode so normal touch scrolling and section toggling stay protected; the resulting order continues to use the existing durable layout preference.
- Opening the software keyboard hides secondary disclosure chrome while retaining prompt entry and applicable primary run controls.
- Touch pointers do not schedule hover-only tooltips or reveal latched CSS hover hints. Fine-pointer hover and keyboard-focus help remain available where supported.
- Tablet layout, desktop tab placement, stored composer ordering, and command behavior are unchanged.

The optional Mobile Experience v2 shell remains separately controlled by its existing preview setting and is not changed by this legacy mobile layout. Tablet adaptation is independently opt-in at medium widths with `?tabletShell=v2`; use `?tabletShell=legacy` for immediate rollback without changing the phone preview flag.

## Git panel

The side-panel **Git** section groups repositories represented by open terminal tabs. Expanding a repository refreshes stale status after a five-minute cache window; live filesystem updates use server-sent events (SSE) to invalidate visible results without periodic Git polling. The context menu provides refresh, stage/unstage, and confirmed discard/delete actions. History shows the latest 30 commits and opens bounded read-only commit diffs.

## Themes

Use **Controls → Interface → Theme** to choose a theme.

### Custom themes

**Customize…** opens a visual editor for Pi's exact 51 required theme tokens, optional colors, variables, and advanced JSON. Valid changes preview immediately. Invalid or incomplete edits remain editable but cannot replace the last valid preview or be saved.

Choose **This project** to save under `.pi/themes/` in a trusted project, or **Global themes** to save under `~/.pi/agent/themes/`. Previewing or saving does not select the theme or mutate Pi/browser settings, and overwriting an existing theme requires confirmation. To activate a newly saved theme in Pi TUI, run `/reload` or restart Pi, then choose it with `/theme`.

## App runners

The runner menu detects common project commands and scripts. Projects may add `.pi-webui-runners.json` for custom runners and extra script-search folders.

Search folders must stay inside the project, cannot use `..`, and are scanned only one level deep. Invalid or missing folders are shown as diagnostics instead of being scanned.

## Remote access

Web UI listens on localhost by default. Do not expose it directly to an untrusted network.

Use `@firstpick/pi-package-remote-webui` for trusted-LAN access, QR connection details, and PIN protection. When LAN access is open, the same control toggles to "Close for network". Close LAN access when finished. PIN protection is a trusted-network convenience, not hardened multi-user authentication.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+K` | Open the command palette |
| `Ctrl/Cmd+L` | Open the model selector |
| `Ctrl/Cmd+P` | Cycle models |
| `Shift+Tab` | Cycle thinking effort |
| `Ctrl/Cmd+T` | Toggle thinking visibility |
| `Ctrl/Cmd+O` | Expand or collapse tool output |
| `Alt+Enter` | Queue a follow-up |
| `Alt+Up` | Restore the latest queued prompt |
| Hold `Esc` | Abort active work |
| `Ctrl/Cmd+F` | Search the active file, transcript, or subagent output stream; all matches are highlighted |
| `Alt+ArrowUp` / `Alt+ArrowDown` on a Control Deck section | Reorder among visible sections assigned to the same side |
| `Alt+ArrowLeft` / `Alt+ArrowRight` on a Control Deck section | Move the section between sides when desktop **Both** is active |

## Troubleshooting

- Use `/webui-status detailed` when the browser cannot reconnect or a tab looks stale.
- Keep the same port and Pi configuration location when restarting for session continuity.
- Explicitly stop managed tabs before disabling continuity or removing private runtime files.
- Use **Recheck** after fixing an optional-package or settings problem.
- If a summary model is unavailable, sign in or choose another model in `/summary-setup`.
- If compact mode is confusing, return to Normal under Output processing.
- OpenAI-compatible local providers such as LM Studio may return reasoning as literal `<think>…</think>` text. Web UI separates the outer tagged region into the Thinking card and preserves balanced literal tag examples inside it. If raw tags still appear, verify that the response starts with an opening `<think>` tag and includes its matching outer close.
- If the Subagents section labels a child **recovered active**, Pi has authoritative evidence that the child is active but cannot yet map it to a controllable run. You can click the row to open a read-only metadata view; it explains that detailed live output remains unavailable until Pi observes the run locator. Cancel, dismiss, and automatic restored-terminal materialization remain unavailable for that provisional row. An “active children omitted upstream” count means the upstream bounded snapshot knows about more active children than it can describe individually.

## Compatibility and limitations

- Subagent recovery snapshots are bounded. Omitted children are reported as an aggregate and appear individually only after a later snapshot includes enough public metadata; private child prompts and paths are never exposed by the overview.
- App runners stop during Web UI restart and must be started again.
- An operating-system restart cannot resume the same in-progress model request.
- Some native Pi commands have browser-specific behavior or remain terminal-only.
- Remote clients have fewer package-management and local-file actions than localhost clients.
