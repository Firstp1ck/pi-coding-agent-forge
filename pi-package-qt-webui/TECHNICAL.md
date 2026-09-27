# Qt WebUI technical reference

Advanced user guidance for requirements, commands, runtime behavior, settings, security, and troubleshooting.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Requirements and compatibility

- Linux on a Wayland desktop session
- Quickshell 0.3 or newer available as `quickshell`
- Node.js 22.19 or newer
- Working Pi credentials and provider configuration in your existing Pi agent directory
- Optional: `notify-send` for desktop notifications and `xdg-open` for opening links

Other operating systems, X11-only sessions, and Quickshell releases older than 0.3 are not supported. Qt WebUI runs one Pi session per tab, up to eight tabs per window; file browsing and Git status views are not available yet.

Qt WebUI reads the XDG desktop portal's color-scheme preference at startup and follows later portal changes. If the portal has no valid preference, it follows Qt's current preference. Automatic mode is the default; the command palette can save a Light or Dark override and can reduce motion. Returning to Automatic immediately uses the current portal or Qt preference. The built-in themes pair violet-charcoal dark surfaces with a coherent softly violet light counterpart, periwinkle structural emphasis, opaque flat surfaces, monospace UI text, and thin higher-contrast frames. Active work appears in periwinkle while working. Green appears only for successful or ready status. A validated Hyprland radius may soften corners; without one, controls and panels stay square.

### Pi JSON themes

Open **More options** and choose **Theme** to refresh the available themes. Automatic, Light, and Dark always appear first. Qt WebUI then lists valid Pi JSON themes from your global Pi theme paths, enabled installed packages, and trusted project theme paths. Package themes such as `@firstpick/pi-themes-bundle` need to be installed and enabled through Pi before they appear. Qt WebUI never installs or repairs a missing package, and discovery does not execute package extensions.

Qt WebUI follows Pi's saved project-trust decision. With no saved decision, `defaultProjectTrust: "always"` permits project themes; `ask` and `never` skip them because Qt WebUI cannot show Pi's interactive trust prompt. Global themes remain available. Session-only trust granted inside another Pi process is not shared with this independent window.

The selected name is stored only in Qt WebUI's XDG settings. It does not read or write Pi's `theme` setting. If the selected file is missing, malformed, unreadable, or no longer enabled, Qt WebUI keeps the requested name, uses the saved Automatic, Light, or Dark fallback as one complete palette, and retries after a file change, picker refresh, or restart. Restoring a valid theme reapplies it. Theme files can use Pi's six-digit RGB colors, 256-color indexes, variables, and terminal-default empty values. Qt WebUI derives desktop-only roles and repairs unreadable color pairs to meet its contrast rules, so a few displayed colors may differ from the authored values.

Discovery reads at most 128 theme files, each no larger than 128 KiB, from at most 256 resolved resource entries. Names are limited to 64 characters. Diagnostics are bounded and omit source paths. HTML export CSS, gradients, background images, and other arbitrary styling are ignored; only JSON colors are applied.

The launcher defaults `QT_NO_XDG_DESKTOP_PORTAL=1` for Quickshell because this app does not use Qt's desktop-services portal bridge. This prevents Qt's host-registry startup warning without hiding other `qt.qpa.services` warnings. The launcher still reads the portal's color scheme before Quickshell starts. A custom QML build that needs Qt's portal bridge can opt back in with `QT_NO_XDG_DESKTOP_PORTAL=0 qt-webui`.

## Install and commands

Install the Pi package to make the start command available inside Pi:

```bash
pi install npm:@firstpick/pi-package-qt-webui
```

Alternatively, install the standalone terminal command:

```bash
npm install -g @firstpick/pi-package-qt-webui
```

| Command | Result |
|---|---|
| `/qt-webui-start` | Inside Pi, starts Qt WebUI for Pi's current working directory and returns immediately. |
| `qt-webui` | Opens Qt WebUI for the current directory after a global npm installation. |
| `qt-webui dev` | Opens the packaged QML source and lets Quickshell reload it when files change. |

The Pi package registers `/qt-webui-start` directly, so its npm-managed `.bin` directory does not need to be on `PATH`. Start a new Pi process after installation, change to the intended project before starting Pi, and enter `/qt-webui-start`. Each invocation starts another window. A launch failure, such as a missing `quickshell` executable, appears as a Pi notification.

The terminal launcher and the Pi command accept no options. Spaces in directory names are supported.

Development mode does not add a separate file watcher or restart loop. Quickshell watches the selected source configuration and performs its native reload when QML changes.

## The window

A persistent left rail holds Qt WebUI identity, Pi status, the global **Working** and **Settled** session lists, folder actions, and secondary utilities. Resize it by dragging its right edge, or focus the edge with `Tab` and use `Shift+Left` / `Shift+Right`. The rail keeps enough room for its navigation controls, while resizing reserves enough width for the prompt's essential run controls. Press `Ctrl+Alt+B` to collapse or restore the rail with the keyboard. It also hides automatically if the window cannot fit both the rail and the prompt workspace; the shortcut remains available when the window is wide enough again. Both session lists scroll within the available height at twice the normal mouse-wheel and touchpad speed. Their scrollbars use the theme's accent color, stay visible while idle when scrolling is needed, and change color on hover or press. **Settled** starts expanded and can be collapsed. **Search workspaces** filters the loaded **Working** and **Settled** rows by title, session identifier, or folder without changing their organization. Matching is case-insensitive; `Escape` or **×** clears the query. This field is separate from `Ctrl+F`, which searches the transcript. The compact main header shows the session name, active workspace directory, and transcript search. A wrapping control strip below the prompt editor shows a three-line **More options** menu, the active provider and model ID followed by the thinking effort, context compaction, transcript density, and an on-demand **Status** control. The menu contains Resources, automatic settlement with its current delay in days, thinking-section visibility, syntax highlighting, desktop notifications, appearance, reduced motion, Events, and Diagnostics. The model and thinking controls open bounded lists above the strip; see [Models, thinking effort, and compaction](#models-thinking-effort-and-compaction).

When session discovery reaches a scan or retention limit, a warning icon appears at the top left of the workspace list, beside **Search workspaces**. Hover over the icon or focus it with `Tab` to read the warning. It stays with the displayed catalog during refreshes and disappears after a complete refresh. Switching sessions does not post this warning as a session notice. The icon does not change discovery limits or remove saved sessions.

The conversation and prompt editor share a centered maximum width instead of stretching across the full window. Assistant messages use the quiet conversation surface, while your messages and thinking sections remain visually distinct. A display-sized empty state and prompt landmark lead directly to the framed editor, while tracked uppercase text stays limited to short section, role, and status labels. The prompt editor remains in normal page flow as a flat, opaque surface with a stable one-pixel border whose color marks keyboard focus, so suggestions, attachments, queues, notices, and status remain usable at the minimum window size.

Readable titles, explanations, paths, status details, and list metadata support mouse and keyboard selection with normal copy shortcuts. Selecting text in an option, completion, tab, or dialog does not choose it, submit an answer, or open a link; normal clicks and keyboard commands still perform their documented actions. Long selectable fields clip within their existing bounds rather than showing an ellipsis. Focus one and press `Ctrl+A`, then `Ctrl+C`, to copy its complete original text.

Status values do not occupy a permanent footer. When the active session has status data, **Status** shows the entry count and opens a bounded panel above the prompt controls. The panel keeps separate **Usage**, **Session**, **Git**, and **Extensions** groups as available. It shows every label, value, icon, and description directly, wraps long text instead of shortening it, and scrolls when the full set is taller than the available space. `Escape`, **Close**, or a click outside dismisses it and returns keyboard focus to **Status**. Structured footer metrics can come from extensions such as `@firstpick/pi-extension-git-footer-status`; other extension statuses remain labelled by their publisher. The `cwd` status from `pi-extension-cd` is not repeated because the main header already shows the workspace. Terminal color codes are removed, metrics that repeat the header are not shown twice, and status data is cleared when Pi restarts or exits.

The transcript shows your prompts, Pi's answers, thinking sections, and tool cards in the order they arrive. Answers render Markdown headings, paragraphs, bold, italic, strikethrough, inline code, lists, task lists, quotes, tables, horizontal rules, and fenced code blocks with a language label and a **Copy** button. Code in common languages (JavaScript, TypeScript, Python, shell, JSON, YAML, TOML, CSS, HTML, SQL, Rust, Go, C-family, diffs, and more) is syntax highlighted; **Select text** switches a block to a plain selectable view and back, and **Copy** always copies the original code. Blocks longer than 8,192 characters and unknown languages stay plain. Thinking sections appear in a distinct color and can be hidden with **Hide thinking** or `Ctrl+T`. Tool calls start as single-line rows showing the name, a muted argument preview, running/done/failed state, duration, disclosure arrow, and copy icon. The preview sits immediately after the name and uses the remaining width, updating as the row resizes. It stays on one line and ends with three dots (`...`) when the details overflow. Status and controls remain visible. The preview disappears when no summary is available or there is too little space for the dots. Line breaks become spaces in the preview; expanded details keep the original summary. **▸** expands the argument summary, error details, and available output; **▾** collapses them. **⧉** copies the current plain-text output without changing expansion and is disabled when no output is available. Copying uses the same bounded output shown in the row, up to 4,096 characters. The arrow is disabled when there are no details to reveal. Both controls support keyboard focus and activation, with descriptive tooltips. Failed status remains visible while collapsed.

The transcript always uses compact spacing; this does not ask Pi for a shorter answer. There is no density toggle or `Ctrl+Shift+M` shortcut. Tool rows start collapsed, and expanding reveals the argument summary. **Search** (`Ctrl+F`) matches the original text of messages and tool output, highlights the current match, and moves with **Next**, **Previous**, `Enter`, and `Shift+Enter`. **Copy** on a message copies its original text, not the styled rendering.

Mouse-wheel and touchpad scrolling in the transcript use twice the normal scroll distance. Middle-click the transcript, including selectable text, to activate browser-style autoscroll. A marker stays at the starting point. Move above it to scroll up or below it to scroll down; distance controls speed, and scrolling continues while the pointer stays still. Returning near the marker pauses movement without leaving autoscroll mode. Any mouse click or `Escape` stops it. Holding the middle button while moving also works and stops on release. Autoscroll also stops when you use the wheel or **Latest**, leave the transcript, switch sessions, or move focus away. Left-button and scrollbar dragging remain unchanged. The transcript follows new output until you scroll up to read history, even by a small amount. New output does not pull you back down. Scroll all the way to the bottom or choose the floating **Latest** button to resume following.

## Tabs, sessions, and worktrees

Each tab is one Pi session in one folder. The left rail combines open tabs with every saved Pi session found under the active Pi agent home. Open rows and tabs use the same four activity labels. `blocked` has priority when an active run needs extension input, `working` covers other active runs, `done` marks a background run that finished before you viewed it, and `idle` covers the remaining open tabs. Selecting a `done` tab acknowledges its output and returns the label to `idle`; starting another run also clears stale completion. Startup and process errors stay visible as separate status details. A fresh tab without a saved session file still appears there so you can select or close it. The current row is highlighted. Workspace filtering is local to the current window, trims surrounding query whitespace, and is neither sent to the backend nor saved across restarts. **New tab** (`Ctrl+N`) opens another tab in the same folder with a fresh session; **Open folder** (`Ctrl+O`) opens the folder picker. `Ctrl+Tab` and `Ctrl+Shift+Tab` cycle through open tabs and `Ctrl+1` to `Ctrl+8` jump to a tab. Rename the active tab with `F2`; the name is also stored as the Pi session name.

Selecting a saved session that already has an open tab selects that tab. Selecting any other saved session opens a new tab in the session's recorded folder and preserves the current tab. The eight-tab limit still applies. If the limit is reached, close a tab before opening another saved session.

**Settle** moves an idle saved session from **Working** to **Settled**. A session with an active run cannot be newly settled; wait for the run to finish or abort it first. **Restore** always moves a session back to **Working**, including while its open tab is active. Settling is only Qt WebUI organization: it does not stop, compact, move, delete, or rewrite Pi's session file. Closing a tab never settles it, and settling never closes its tab. Settled rows show the session title, its compact last-activity label, and **Restore**; select the title to open or switch to that session. Activity labels use minutes or hours below one elapsed day, whole days from `1d` through `30d`, and the local calendar date in `dd.mm.yyyy` format once the session is older than 30 elapsed days. The first catalog load uses newest-first activity order. Later activity does not move an existing row until that session has been inactive for five minutes. More activity restarts the five-minute delay. The rule applies to both **Working** and **Settled** and resets when you restart Qt WebUI.

Automatic settlement uses the saved session's last activity time and an elapsed 24-hour-day delay. The default is 30 days, and reaching the threshold qualifies. Every open tab is excluded, whether Pi is idle or working; only closed inactive sessions can move automatically. The check runs when the global catalog refreshes, including immediately after you save a new delay. Lowering the delay may therefore move older closed sessions to **Settled** at once. Manual **Restore** starts a fresh grace period using the delay currently configured, so the restored session does not immediately settle again.

Choose **Automatic settlement** in **More options** or the command palette to see the current delay. Enter a whole number from 1 through 3,650 and choose **Save**. Empty text, fractions, other text, zero, and larger values are refused in the dialog. Cancel leaves the existing value unchanged; a backend rejection appears as a notice and also keeps the confirmed value. There is no zero-value disable mode.

The folder picker lists subfolders of the current path with a **git** mark for repositories, accepts a typed path, offers **Back**, **Up**, **Home**, hidden folders, **Pin**, and **New folder**, and shows pinned and recent folders as shortcuts. **Open this folder** starts a new tab there; nothing changes until you choose. A tab never changes its folder: to work elsewhere, open another tab.

Switching tabs shows that tab's transcript (the last 80 entries), status, model, queues, pending extension questions, and attachments as they are; the unsent prompt is kept per tab. Runs keep going in tabs you are not looking at, and a notice tells you when a background tab finishes, fails, or needs input. Closing a tab (`Ctrl+W` or its **×**) stops that tab's Pi process; if the tab is still working, a confirmation explains that the run is aborted first. Closing the active tab leaves no session selected. Qt WebUI does not select another open tab or create a replacement. Choose a row in **Working**, **New tab**, or **Open folder** when you want to continue.

Your open tabs, their folders, session files, names, and current selection are saved for the next start. If you leave the workspace with no session selected, restored tabs resume in the background but the main workspace stays empty until you choose one. A fresh installation or older state without that empty-selection marker still selects the folder you launched from and adds a tab for it when needed. Folders that no longer exist are skipped with a notice.

The global rail refreshes after session and run changes and when another Pi process changes the saved-session tree; use its refresh button to retry immediately after an error. For each open saved session, Qt WebUI also checks the file about every two seconds. An idle tab adopts only a stable, complete persisted conversation; an active local run keeps its live view until it settles. Equal snapshots cause no visible reset, while a different snapshot refreshes the active transcript or increments an inactive tab's unread count. Before the next prompt, sequence, rename, compaction, model/thinking change, or resource apply, Qt WebUI reloads that session through Pi's normal switch flow. If an extension cancels the reload or it fails, the requested change is refused instead of writing from stale state.

This synchronization follows complete persisted entries, not another process's token stream, tool progress, or running status. It does not prevent two clients from writing the same session concurrently. Full projection costs grow with the saved session size, and at most the eight open tab paths are polled. Titles use the Pi session name when present, otherwise the first user prompt, otherwise the session id. Large session collections load in bounded batches, so the rail may briefly show **Loading saved sessions…** while it completes. Files that are corrupt, unreadable, incomplete, unstable during a read, or removed during a refresh are skipped without hiding other valid sessions or clearing the last valid open transcript.

When the catalog contains more than 100 unsettled saved sessions, a floating **Settle All** button appears at the lower-right of the session list. It disappears at 100 or fewer, even while a bulk action continues. The action processes eligible sessions one at a time, skips active runs, keeps the existing per-session validation and 2,048 manual-settlement limit, and reports skipped or failed sessions in a notice. Temporary unsaved tabs do not count toward the threshold.

The existing **Sessions** action (`Ctrl+Shift+O`, or **Resume a session** in a tab with no messages) remains a folder-only picker for intentionally replacing the idle tab's current session. It lists up to 200 sessions for that tab's folder, newest first, with the name or first prompt and message count. Choosing one loads its history into the current tab; when the last exchange looks unfinished (an unanswered prompt or an aborted answer), a notice says so instead of presenting it as complete. `Ctrl+Shift+N` starts a new session in the current tab, or opens one when no session is selected. The previous session stays saved. Both in-place actions wait until the tab is idle.

**Worktree** (`Ctrl+Shift+B`) creates a new branch and checks it out in a separate folder, then opens that folder in a new tab. Choose a suggested branch type or enter your own, then enter the name; Qt WebUI combines them as `<type>/<name>`. A confirmation shows the exact branch, the base it starts from, and the folder that will be created (next to the repository, named `<repository>-<branch>`). Nothing is created until you confirm. Existing branches, existing folders, and repositories without commits are refused before anything runs, and a failed creation removes what it started so the repository is left unchanged; anything it could not remove is named in the error.

## Command palette, usage, events, and diagnostics

**Palette** (`Ctrl+K`) lists every action with its shortcut, the open tabs, the configured models, the ten most recent saved sessions for the folder, Pi's commands, and the skill files Pi reports. Type to filter (the group name matches too), use the arrow keys, and press `Enter`. Actions you used recently move to the top in a **Recent** group. Choosing a Pi command inserts `/name ` into the prompt so you can add arguments; nothing is sent until you press `Enter` in the prompt. Choosing a skill file asks for confirmation and then opens it with your default application. Models, sessions, and commands are reloaded each time the palette opens, so the list follows Pi's current configuration.

The **Status** panel adds a **Usage** group once Pi reports statistics for the tab: context-window fill in percent (amber from 75%, red from 90%; a dash right after compaction until the next answer), token totals with the input, output, cache-read, and cache-write breakdown shown underneath, and Pi's calculated cost with message and tool-call counts. It refreshes after every run and whenever a tab is shown.

**Events** (`Ctrl+Shift+L`) lists the last 200 notices from every tab, including background tabs, with the time and the tab they came from. Filter by severity (**All**, **Info**, **Warning**, **Error**) or by text; repeated identical events collapse into one row with a count. **Copy** puts the listed events on the clipboard as plain text and **Clear** empties the history.

**Diagnostics** (`Ctrl+Shift+D`) shows a plain-text report: backend process ID, uptime, and memory; the launch and active folders; Pi's state, model, and session file; request and event counters for the client and the backend; the settings, state, and sequence file paths; every tab with its Pi process ID; and the last ten errors. **Copy** puts the report on the clipboard for a bug report.

## Prompts, steering, and follow-ups

`Enter` sends the prompt while Pi is idle; `Shift+Enter` inserts a new line. The mode control defaults to **Steer mode** and stays visible while the session is ready. While Pi is working, `Enter` and the adjacent action use the selected mode: **Steer** delivers the message after the current tool calls finish, while **Queue** adds a follow-up for after the run ends. Click the mode control to switch between **Steer mode** and **Follow-up mode**. `Alt+Enter` always queues a follow-up. An animated indicator under the last transcript entry shows the current activity while a run is active. **Abort** (or `Ctrl+Shift+X`) stops the active run; an abort sent before Pi acknowledges the prompt is applied as soon as the run starts. Queued messages are listed above the editor.

Prompts are limited to 8,192 characters; the editor shows a counter near the limit and refuses longer text.

## Completion, attachments, drafts, and sequences

Typing `/` at the start of the prompt lists the commands Pi reports: extension commands, prompt templates, and skills (`/skill:name`). Typing `@` anywhere lists workspace paths that match the word after it; inside a Git repository ignored files are left out, and at most 50 suggestions are shown. `Up` and `Down` move through the suggestions, `Tab` or `Enter` completes the word without sending, and `Escape` closes the list. Changing the query clears old suggestions immediately. While replacements load, `Tab` and `Enter` wait without inserting an old result or sending your prompt. A completed directory ends with `/` so you can keep typing into it. Commands are read from Pi once per session and again after a restart.

**Attach** (or `Ctrl+Shift+A`) opens a file picker. Files chosen there can come from anywhere; paths typed elsewhere must stay inside the workspace. Text files must be valid UTF-8 up to 256 KiB and are sent below your prompt as a labelled code block; PNG, JPEG, GIF, and WebP images up to 5 MiB are sent to the model as images when it accepts them. Up to eight files can be attached at once. Each attachment appears as a chip with its name and size; **Edit** changes the text of a text attachment before sending and **Remove** drops it. Attachments are sent with the next prompt, steering message, or follow-up, are shown on that message in the transcript, and are consumed once: a file edited after attaching is sent as it was when attached.

Your prompt stays in the editor and saved draft until Pi accepts it. Rejection preserves it. A timeout means the outcome is unknown, not that Pi rejected it; the app does not resend automatically. Late acceptance never clears newer edits. Session replacement saves the outgoing draft before loading the next one, even if you changed text just before switching. A new session gaining its first saved filename keeps its current draft.

Text attachment sizes count UTF-8 bytes. Editing also has a 256 KiB transfer budget, so a file that fits the storage limit can still produce an edit that is too large to transfer. Quotes, backslashes, and control characters need extra transfer space. A rejected edit stays open without changing the stored attachment. After a timeout, use **Check outcome** before saving again. It checks stored content without discarding your edit.

Extension answers are limited to 16,384 characters. Definite rejection keeps the dialog actionable. A timed-out answer stays visible with an unknown outcome until a late answer or cancellation settles it. Backend acceptance means the answer was written for Pi, not proof that Pi processed it.

**Sequences** in **More options** (or `Ctrl+Shift+S`) keeps named lists of prompts. **New** and **Edit** take a name and one prompt per paragraph (up to 16 prompts); **Run** sends the first prompt and queues the rest as follow-ups so Pi works through them in order; **Load into prompt** copies the prompts into the editor instead; **Move up** and **Move down** reorder; **Delete** asks for a second press to confirm and never runs anything. Up to 32 sequences are saved. In the list, `Enter` runs the highlighted sequence.

## Discovery and shared-state limits

One Qt WebUI backend permits only one current or reserved owner of a saved session, including symlink aliases. Opening an already-owned session selects its tab; switching another tab to it is refused. This does not coordinate ownership across separate Qt WebUI windows or external Pi processes.

A catalog refresh visits at most 4,096 directory entries, retains up to 2,000 readable sessions and 8 MiB of metadata, reads at most 16 MiB of history for discovery, and has a three-second deadline. A limit notice means the list is incomplete. The previous complete list stays visible until a replacement refresh succeeds. Refresh again after an error; page expiry causes at most one automatic fresh attempt.

Automatic transcript refresh accepts saved histories up to 8 MiB, with two concurrent loads and eight queued loads. A load has five seconds including queue time. Oversized, malformed, changing, or slow files leave the last complete transcript in place and never truncate the source history. A new valid saved revision can retry immediately.

Qt-owned settings, drafts, layouts, sequences, and sampling use shared document locks. A contending write waits at most 100 ms before reporting that another window is updating the document. Let that operation finish and retry. The util-linux `flock` command must be available. Empty owner-only `.lock` files alongside these documents are normal; do not delete them while a window is running. Process exit releases ownership automatically, including after a crash. Full replacements of the same setting or layout still follow the last successful writer's intent.

If the UI stops reading output, Pi output pauses and ordinary requests are refused. Output retention is capped at 8 MiB and 4,096 records, with a separate 64 KiB control allowance. If draining does not resume within three seconds, or a hard ceiling is reached, the backend stops its Pi processes and exits with code 75. Accepted work may then have an unknown outcome. Abort, shutdown, and fatal process cleanup remain available. Restart the backend after addressing the stalled UI rather than automatically repeating a mutation.

## Models, thinking effort, and compaction

The model control beneath the prompt editor (or `Ctrl+M`) opens a list above the strip. It mirrors the models Pi exposes for the current session through `/scoped-models`, with provider, ID, display name, and capabilities such as thinking, images, and context size. When Pi has no explicit model scope, its documented behavior is that every available model is usable, so the list falls back to the available catalogue. Type to filter, use the arrow keys, and press `Enter` or `Space` to switch; `Escape` closes the list and returns focus to the model control. `Ctrl+Shift+P` cycles to Pi's next model without opening the list.

When Pi reports an explicit scope with at least two available entries, each row has a **≡** handle. Drag the handle, or highlight a row and press `Ctrl+Shift+Up` or `Ctrl+Shift+Down`, to move it without selecting the model or closing the list. The current selection and keyboard focus stay in place. Reordering is disabled while the filter contains text; clear the filter to restore the handles and keyboard commands.

The preference uses exact `provider/model-id` identities. Saved entries that still exist appear first in the saved order; newly available entries follow in Pi's relative order. Entries temporarily absent from one scope are retained when possible, so reordering one tab does not erase preferences for another scope. Pi remains authoritative for membership, and available-catalogue fallback lists cannot be reordered. At most 256 identities are kept; identities in the scope you just reordered take priority if that bound is reached.

The thinking control (or `Ctrl+E`) opens another list above the strip with the effort levels the current model supports, from `off` to `max`; `Ctrl+Shift+E` cycles through them. When a model does not support thinking, the list contains only `off` and cycling reports that there is nothing to cycle. This control sets reasoning effort. Showing or hiding rendered thinking sections remains a separate display setting available through `Ctrl+T` and the command palette.

Changing the model can change the thinking effort, because Pi applies the new model's supported levels; the prompt control strip always shows the values Pi confirmed. Both controls are disabled while Pi is working, and a change that Pi rejects is shown as a notice with Pi's reason. Choosing the entry that is already active does nothing. Up to 256 scoped or available models are listed; the list reports how many more were omitted.

**Resources** in the **More options** menu (`Ctrl+Shift+R`) opens profiles for enabled tools, enabled skills, and sampling values. First choose the scope:

- **Session** overrides only the current Pi session. It stays with a persisted session; for an ephemeral session the dialog warns that the override applies only until the session ends.
- **This model** applies to the exact active provider/model pair when its sessions inherit.
- **Global** applies when neither the session nor exact model supplies a value.

Session values win over exact-model values, which win over global values, which finally leave Pi's own defaults in place. The dialog always shows the effective value and its source. For tools and skills, **Inherit** means “use the next scope”; **None** is an intentional empty enabled list and prevents any item in that category from being used. Select individual names and choose **Save tools** or **Save skills** to apply them. Session changes take effect immediately in the idle tab. Exact-model and global changes are applied to every affected idle tab before they are saved; the change is refused if any affected tab is working. No Pi reload is required.

Qt WebUI and Pi Web UI use the same global, exact-model, and saved-session tool and skill selections. Opening the dialog reads the latest shared file before it shows a draft, and **Refresh** reads it again. If the other interface changes a selection while this dialog is already open, refresh before saving; there is no background process-to-process link. A configured name that is temporarily unavailable stays saved but is not sent to Pi until that tool or skill is loaded again.

The **Sampling** section offers temperature, top-p, frequency and presence penalties, seed, top-k, and min-p. A blank field inherits. Only values declared by the active provider interface can be edited or sent; every unavailable field is disabled with the provider's reason. A value saved for another model or before a capability change stays visible and stored, but is not sent while unsupported. Resource controls are disabled while Pi is working, while a model/resource change is pending, or when the helper cannot report complete current capabilities. **Refresh** retries capability discovery. Model, thinking, and tab changes refresh the shown profiles and support state. Sampling is not shared with Pi Web UI.

**Compact context** appears in the prompt control strip once the transcript has content. It asks Pi to summarize older conversation so the context stays within the model's window, shows **Compacting…** until Pi answers, and then reports the token counts before and after. Prompts and model changes are refused while compaction runs. If compaction fails, Pi's error appears in the error panel and the session stays usable. Pi's automatic compaction and retries continue to appear as notices.

## Extension dialogs

When a Pi extension asks a question, a modal dialog opens with the question's title and text:

- **Select** lists the options; use the arrow keys and `Enter`, or click an option.
- **Confirm** offers **Yes** and **No**.
- **Input** offers a single-line field; `Enter` submits.
- **Editor** offers a multi-line field; `Ctrl+Enter` saves.

`Escape` or **Cancel** declines the request. Each request is answered exactly once, and pending requests are cancelled automatically when Pi exits or the window closes. Extension notifications appear as short notices at the bottom of the window.

## Notifications and links

When the window is not focused, Qt WebUI sends a desktop notification through `notify-send` when a run finishes or fails and when an extension needs your input. The notification body starts with the relevant session name, followed by any available result or request detail. Unnamed sessions use their tab's workspace label. A **Settled** session stays silent even if later background activity finishes or requests input; restore it to **Working** to resume desktop notifications. In-window event notices remain available. Notifications are skipped when `notify-send` is not installed.

Links in answers never open automatically. Activating a link shows the full address and opens it with `xdg-open` only after you choose **Open link**. Only `http`, `https`, and `mailto` addresses are accepted; other schemes stay plain text. Images referenced in answers are shown as text placeholders and are never downloaded.

## Settings and storage

Display choices are saved in `$XDG_CONFIG_HOME/qt-webui/settings.json` (usually `~/.config/qt-webui/settings.json`) with owner-only permissions:

| Setting | Default | Meaning |
|---|---|---|
| `compactTranscript` | `false` | Legacy setting, ignored by the interface. Transcript rows always use compact spacing. |
| `showThinking` | `true` | Show thinking sections. |
| `desktopNotifications` | `true` | Send desktop notifications while the window is unfocused. |
| `syntaxHighlighting` | `true` | Highlight fenced code blocks. |
| `appearanceMode` | `automatic` | Built-in fallback: `automatic`, `light`, or `dark`. |
| `selectedThemeName` | `""` | Requested external Pi JSON theme; empty uses the built-in fallback. |
| `reducedMotion` | `false` | Stop decorative animation and make state transitions immediate. |
| `sessionSettleDays` | `30` | Settle closed inactive sessions after this many elapsed days; accepts whole numbers from 1 through 3,650. |
| `modelOrder` | `[]` | Preferred order of up to 256 exact `provider/model-id` identities for explicit scoped-model lists. |

The file is rewritten atomically. An unreadable or invalid file is ignored with a notice and the defaults apply. Saved prompt sequences live next to it in `sequences.json`. Qt-only sampling defaults live in `resources.json`. Global and exact-model tool and skill defaults use Pi Web UI's private settings file at `~/.pi/webui/settings.json`; managed installations can override that location with `PI_WEBUI_SETTINGS_FILE`. Writes use Pi Web UI's owner-only directory, lock, latest-file merge, and atomic replacement, so unrelated Pi Web UI settings are preserved.

On the first resource read after this update, Qt WebUI copies any older Qt-only tool and skill defaults into empty shared scopes without overwriting a shared choice. It keeps the old values in `resources.json` for downgrade recovery and records that the one-time copy completed. After that point, a shared **Inherit** value remains authoritative and cannot revive an older Qt value. Before downgrading Qt WebUI, back up both `~/.pi/webui/settings.json` and `$XDG_CONFIG_HOME/qt-webui/resources.json`; an older release can show retained pre-migration choices instead of newer shared edits. Re-upgrade to restore shared behavior.

Unsent drafts, open tabs, pinned and recent folders, and Working/Settled organization live in `$XDG_STATE_HOME/qt-webui/state.json` (usually `~/.local/state/qt-webui/state.json`), all with owner-only permissions. Manual and automatic settlement use separate lists of at most 2,048 hashed identities each, while restore grace keeps at most 2,048 hashed timestamps. This organization metadata contains neither session paths nor conversation text and does not modify Pi's own files. Session tool and skill profiles use the same entries in Pi's saved session history that Pi Web UI reads; session sampling stays in Qt WebUI's existing session entry. If Pi reports that a session is ephemeral, the profile remains in memory only and the dialog shows that it is not durably saved. The global rail reads sessions from every project directory under Pi's session home (`~/.pi/agent/sessions/`, or `$PI_CODING_AGENT_DIR/sessions/`); the legacy picker narrows that source to the active folder. Attachments stay in memory until they are sent, and Pi keeps its own session files in your Pi agent directory.

## Runtime and security behavior

Qt WebUI starts one local backend process for the window, and that backend starts one Pi process with the Pi version installed with this package. It does not search for or run a global `pi` command. Closing the window ends the backend, Pi, and any tool processes Pi started, waiting up to three seconds before forcing termination. If the backend stops unexpectedly the window shows the exit code and **Restart** starts it again.

The app does not open a network listener. Prompts remain data passed to the local Pi process, which then contacts the provider configured in Pi. Qt WebUI does not collect or store provider credentials. Pi still has the project and tool access granted by your existing configuration, so inspect tool cards before allowing consequential work.

Everything Pi and its extensions produce is treated as untrusted text. Raw HTML in answers is shown literally, only a fixed set of inline styles is rendered, and dialog titles, options, tool output, and notices are displayed as plain text. Long content is shortened at fixed limits: 80 transcript rows, 8,192 characters per message part, 4,096 characters of tool output, and 512 characters per error.

`SIGINT` and `SIGTERM` sent to the launcher are forwarded to Quickshell. The command exits with Quickshell's exit result, which makes failures visible to scripts and terminals.

## Keyboard reference

| Keys | Action |
|---|---|
| `Enter` | Send the prompt, or use the selected Steer/Follow-up mode during an active run |
| `Shift+Enter` | Insert a new line in the prompt |
| `Alt+Enter` | Queue a follow-up while Pi is working |
| `Ctrl+Shift+X` | Abort the active run |
| `Ctrl+F` | Open transcript search; `Enter` next, `Shift+Enter` previous, `Escape` close |
| `Ctrl+T` | Show or hide thinking sections |
| `Ctrl+L` | Focus the prompt editor |
| `Ctrl+M` | Choose a model; in an unfiltered explicit scope, `Ctrl+Shift+Up` / `Ctrl+Shift+Down` moves the highlighted model; `Ctrl+Shift+P` cycles to the next model |
| `Ctrl+E` | Choose the thinking effort; `Ctrl+Shift+E` cycles through the levels |
| `Ctrl+Shift+R` | Open tool, skill, and sampling resource profiles |
| `Ctrl+Shift+A` | Attach files |
| `Ctrl+Shift+S` | Open saved prompt sequences |
| `Ctrl+N` / `Ctrl+O` | New tab in the same folder / open another folder in a new tab |
| `Ctrl+W` | Close the tab (asks first while Pi is working) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` / `Ctrl+1`–`Ctrl+8` | Switch tabs |
| `Ctrl+Shift+O` / `Ctrl+Shift+N` | Resume a saved session / start a new session in the tab |
| `Ctrl+Shift+B` | Create a Git worktree for a new branch in a new tab |
| `F2` | Rename the tab and its Pi session |
| `Ctrl+K` | Open the command palette |
| `Ctrl+Shift+L` / `Ctrl+Shift+D` | Open the event history / the diagnostics report |
| `/`, `@` | Suggest commands or workspace paths; `Tab` or `Enter` completes without sending, `Escape` closes |
| `Tab` / `Shift+Tab` | Move between controls; dialogs keep focus until closed |
| `Escape` | Cancel the open dialog |

## Troubleshooting

### Quickshell cannot be started

Confirm that version 0.3 or newer is installed and visible on your `PATH`:

```bash
quickshell --version
```

Run the command inside a Wayland desktop session. A missing executable produces a launcher error explaining this requirement.

### The Pi entry cannot be resolved

Reinstall `@firstpick/pi-package-qt-webui` so its npm dependencies are restored. The launcher intentionally does not fall back to an unrelated global Pi installation.

### The window says the backend exited

Choose **Start backend**. If it happens again, start `qt-webui` from a terminal: backend messages are shown as notices in the window and Quickshell's terminal output includes the QML log.

### Pi does not become ready

Pi has fifteen seconds to answer the first state request. If it does not, the window shows **Pi did not report readiness in time** and **Restart Pi** tries again. Restarting shows **Restarting…** on the button and a notice until Pi reports ready again. Check that Pi starts in the same directory from a terminal and that your provider configuration is valid.

### Pi cannot access the intended project

Close the app, change to the project directory, and start `qt-webui` again. The working directory is captured at startup.

### A model or thinking level cannot be selected

The prompt control strip's model and thinking controls are disabled while Pi is working or while another change is still being confirmed. If Pi rejects a change, the notice shows Pi's reason, for example a thinking level that the selected model does not support or a model that is no longer configured. The models offered come from Pi's own configuration; add or remove models in Pi, then reopen the list.

### Resource profiles are unavailable or a sampling field is disabled

Resource changes require idle affected Pi sessions and complete capability information from the bundled helper. Wait for current runs or model changes to finish, then open **Resources** and choose **Refresh**. A disabled sampling field shows the provider-interface reason; its stored value is preserved and will become active again only on a model that declares support. Unknown provider interfaces fail closed and receive no optional sampling values. If the dialog says a session profile is not durable, the override is active only for that ephemeral session; use a persisted Pi session if it must survive restart. If the entire profile stays unavailable after refresh, restart Pi in that tab; core prompts and model changes remain usable without resource editing.

When many attachments are shown, their chips scroll separately above the prompt controls, leaving Abort visible. Keyboard focus on an attachment's Edit or Remove button scrolls that chip into view. Attachments added while a prompt is waiting for Pi remain attached for your next prompt. Only files actually consumed by the submitted prompt disappear; attachments in other tabs are unaffected. You can add more files while waiting, but cannot edit, remove, or send a pending prompt's files again until its outcome is known. If a prompt times out, the app checks which files remain; it does not assume they were sent or automatically resend the prompt.

Unsent drafts are kept separately for each tab, even when two new tabs share a folder. Closing a tab removes its unsaved-session draft; saved-session drafts remain available when you reopen that conversation.

### Saved tabs did not come back

Tabs are restored from `state.json` when the backend starts. A tab whose folder was deleted is skipped with a notice. If a saved session file is missing, its tab keeps the missing path and warns you to restore the file and restart the tab, or use **Sessions** to resume another saved conversation or **New session** to start fresh. Sending prompts and changing models or resources stay unavailable until you choose a conversation. At most eight tabs are restored.

If Pi exits unexpectedly, restarting its tab tries to resume the last saved conversation before you continue working.

### A saved session is missing or will not move to Settled

Choose the refresh button beside **Working** and wait for **Loading saved sessions…** to finish. The catalog skips unreadable, corrupt, and concurrently removed files. If **Settle** is disabled, that session has an active run; wait for it to finish or abort it. Automatic settlement also excludes every open tab; close the tab if you want an inactive session to become eligible on a later refresh. A backend rejection appears as a notice and leaves the row in its confirmed section. **Restore** remains available for settled sessions and delays automatic settlement for a fresh configured period.

If many closed sessions move after changing **Automatic settlement**, check the shown day value: lowering it applies on the refresh that follows a successful save. Increase the value and restore any session you still want in **Working**. Invalid or cancelled edits do not replace the last confirmed setting.

### Another Pi window changed a session but the transcript did not refresh

Wait about two seconds and make sure the Qt WebUI tab is idle. A local run deliberately delays the persisted refresh until it settles. Qt WebUI retains the last valid transcript when the file is missing, unreadable, malformed, has an incomplete final line, or changes during the read; correct the writer or let it finish, then save again. A bounded **Session synchronization** notice reports the first failure class. If the saved-session rail remains stale after a watcher failure, use its refresh button; open transcripts still have the periodic file check.

If the transcript refreshed but a later prompt, rename, model change, compaction, or resource change is refused because Pi could not switch sessions, resolve the extension cancellation or Pi error and retry. Qt WebUI will not bypass the same-session reload. Concurrent writes from two active clients remain unsupported; stop one writer before continuing when branches conflict.

### A worktree cannot be created

The tab's folder must be inside a Git repository with at least one commit, the branch name must be valid for Git, and the target folder must not exist. The confirmation shows the exact folder; choose a different branch name if it is taken. If Git fails while creating the worktree, Qt WebUI removes the folder it created and deletes the new branch; the error names anything it could not clean up.

### A file cannot be attached

Only regular files are accepted: text must be valid UTF-8 without NUL bytes and at most 256 KiB, and images must be real PNG, JPEG, GIF, or WebP files of at most 5 MiB. A file outside the workspace is refused unless it was chosen through the picker. Choose **Remove** on a chip to free one of the eight attachment slots.

### Notifications or links do not work

Install `libnotify` (for `notify-send`) and `xdg-utils` (for `xdg-open`). Notifications are only sent while the window is unfocused and while the `desktopNotifications` setting is enabled.

### An installed theme is missing or fell back

Open **Theme** again to refresh the catalog. Confirm the package or theme path is enabled in Pi and that the JSON file has every required Pi color. Project-local themes also require a saved trusted decision or `defaultProjectTrust: "always"`; unresolved `ask` is treated as untrusted in this noninteractive window. Qt WebUI keeps a missing selection and shows the built-in fallback until the theme becomes valid again. It will not download, reinstall, or repair a package.

### The color scheme does not match the desktop

Choose **Appearance** in the command palette until it shows **Automatic**. Qt WebUI then prefers the color scheme reported by the XDG desktop portal and falls back to Qt. Confirm the portal result with `busctl --user call org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop org.freedesktop.portal.Settings Read ss org.freedesktop.appearance color-scheme`. The final number is `1` for dark, `2` for light, and `0` for no preference. If the portal cannot be read, confirm that other Qt applications see the expected theme and that your session exports the intended Qt platform theme.

### Development changes do not reload

Use `qt-webui dev` for the globally installed package. Edit the QML files selected by that command and check Quickshell's terminal output for load errors. Native reload cannot recover from every syntax error until the file is corrected.

## Contributor information

Implementation architecture, environment contracts, and validation commands are in [DEVELOPMENT.md](DEVELOPMENT.md).
