# Pi Web UI current implementation specification

This document describes the behavior implemented by `@firstpick/pi-package-webui` version `0.10.3`. It is a current-state specification, not a roadmap.

[User guide](README.md) · [Advanced user reference](TECHNICAL.md) · [Contributor guide](DEVELOPMENT.md)

## 1. Scope

Pi Web UI runs Pi coding-agent sessions in a local browser. It provides a standalone CLI, Pi extension commands, a local HTTP server, per-tab Pi RPC processes, a browser client, and a small set of Pi-side helper extensions.

The package covers:

- multi-tab Pi sessions and saved workspace layouts;
- streamed transcripts, thinking, tool activity, queues, and extension UI;
- model, thinking, sampling, tool, skill, and settings controls;
- project files, Git operations, app runners, and prompt attachments;
- session summaries, agent observation, and direct agent-conversation views;
- optional companion discovery, installation, migration, and setup;
- update planning, restart continuity, rollback, and diagnostics;
- desktop, phone, tablet-preview, and installable PWA presentations.

The package is a single-user local development tool. It is not a hosted multi-user service, an authorization boundary between users, or a replacement for operating-system permissions.

## 2. Package identity and requirements

| Item | Implemented value |
| --- | --- |
| npm package | `@firstpick/pi-package-webui` |
| package version | `0.10.3` |
| license | MIT |
| Node.js | `>=22.19.0` |
| Pi dependency | `@earendil-works/pi-coding-agent ^0.84.0` |
| browser requirement | A modern browser with JavaScript, Fetch, and Server-Sent Events |
| default address | `http://127.0.0.1:31415/` |
| optional terminal dependency | `node-pty`, used for Windows ConPTY app runners when available |

The package registers these Pi extensions:

- `index.ts`, which owns Web UI startup, status, Guided Git setup, internal tree navigation, and the generic `subagent_gate` integration;
- `session-summary.ts`, which owns session summary commands and the `workspace_session_summaries` tool.

The installed executable is `pi-webui`. A stable launcher selects the active managed Web UI runtime, then starts the server entry point.

## 3. Installation and startup

### 3.1 Pi package installation

```bash
pi install npm:@firstpick/pi-package-webui
```

Pi must restart after installation so it loads the package commands.

### 3.2 Start from Pi

```text
/webui-start [port] [options] [-- <pi args...>]
```

Implemented options:

| Option | Behavior |
| --- | --- |
| `[port]` | Port shortcut for the Pi command only |
| `--host <host>` | Selects the bind host |
| `--port <port>` | Selects a TCP port from 1 through 65535 |
| `--no-open` | Does not open the default browser |
| `--no-session` | Starts Pi RPC without restoring a session |
| `--name <name>` | Gives the first tab an explicit title |
| `--remote-auth` | Enables remote-client PIN authentication for this start |
| `--no-remote-auth` | Disables remote-client PIN authentication for this start |
| `--output-mode normal\|compact-v1` | Selects the default browser output mode |
| `-- <pi args...>` | Appends arguments to each initial Pi RPC launch |

Running `/webui-start` against an existing server at the same address captures its open tabs, stops the HTTP server, starts the replacement, and restores or reconnects those tabs. Managed Pi processes normally remain alive through this server-only restart.

### 3.3 Runtime status from Pi

```text
/webui-status [detailed] [port] [--port N] [--host HOST]
```

The normal view reports reachability, URL, network exposure, PIN state, and tab count. `detailed` adds tab processes, working directories, session files, models, activity, provider availability, statistics, and recent server events.

### 3.4 Standalone server

```bash
pi-webui [options] [-- <pi args...>]
```

Implemented standalone options:

- `--host <host>`
- `--port <port>`
- `--cwd <path>`
- `--pi <command>`
- `--no-session`
- `--name <name>`
- `--remote-auth`
- `--no-remote-auth`
- `--output-mode normal|compact-v1`
- `--migrate-optional-features`
- `--migration-dry-run`
- `-h`, `--help`
- `-v`, `--version`

Arguments after `--` pass to Pi. If `--cwd` is absent, the server starts without an initial Pi tab and asks the browser user to choose the first working directory.

The server validates that an explicit working directory exists, is accessible, and is a directory before listening.

### 3.5 Agent registration CLI

The launcher also provides an agent observation command:

```bash
pi-webui agent run --launcher <rpc|json|print> [options] -- <command> [args...]
pi-webui agent attach --session <id-or-file> [options]
```

Common options are `--name`, `--parent-session`, `--port`, and `--producer`. `attach` also accepts `--session-dir`. The `run` command starts and registers a subprocess. The `attach` command adds a persisted Pi session as a stale, read-only observation until live evidence says otherwise. Session files must resolve to regular files inside a configured Pi session root.

## 4. Process and transport design

### 4.1 Runtime parts

The implementation has six main parts:

1. The Pi extension exposes `/webui-start` and `/webui-status`.
2. The stable `pi-webui` launcher selects the current managed runtime.
3. The HTTP server serves browser files, implements local APIs, owns project operations, and forwards Pi RPC commands.
4. The detached RPC supervisor owns managed Pi child processes and buffers ordered events across HTTP-server restarts.
5. `webui-rpc-helper.mjs` runs inside Web UI-managed Pi tabs and bridges resource selection, sampling parameters, queue mutation, subagent state, app-runner context, and reviewer launch policy.
6. The browser app renders the interface and maintains browser-local presentation state.

### 4.2 Tab isolation

Each normal terminal tab has its own:

- Pi RPC process;
- working directory;
- session branch and session file;
- active model and thinking effort;
- prompt draft and attachments;
- queues and activity state;
- helper extension state;
- event stream subscription.

Dedicated subagent tabs are different. They are read-only projections and do not own another Pi RPC process.

### 4.3 Server-Sent Events

The browser receives live tab events through SSE. Each connection negotiates normal or compact output protocol version 1. The server has a bounded per-client queue and evicts clients that cannot keep up rather than allowing unbounded memory growth.

When the page becomes hidden, the browser closes its live event connection. On return it fetches authoritative tabs, state, and transcript data before reconnecting. It then refreshes secondary panels during idle time.

If supervisor replay reports a gap, the server requests current Pi state and the durable transcript. The browser warns that live buffered output may be incomplete. It does not claim that missing deltas were reconstructed.

### 4.4 Durable supervisor continuity

The supervisor scope is bound to the Pi configuration root and Web UI port. A replacement server must use both values to reconnect.

A normal server restart preserves:

- managed Pi process IDs;
- tab IDs and titles;
- working directories;
- session files;
- current running or idle state;
- an active model turn when the supervisor remains healthy;
- ordered output produced while the HTTP server is absent.

Continuity does not preserve:

- app-runner processes;
- browser-only drafts after browser storage loss;
- arbitrary extension process memory;
- an active request after supervisor failure;
- an active request across operating-system restart, power loss, or machine restart.

Explicit shutdown terminates managed Pi children. Closing one tab terminates that tab's managed child. Server restart and update are not substitutes for shutdown.

## 5. Browser shell and layout

### 5.1 Main workspace

The main workspace contains:

- terminal navigation;
- an optional workspace dashboard;
- the transcript and live output;
- a pinned app-runner or extension widget area;
- a run indicator;
- action feedback;
- status and context meters;
- Guided Git workflow output;
- the composer and attachment tray;
- an optional split terminal;
- an optional file viewer;
- one or two Control Deck panels.

The frontend has explicit offline, restarting, update-available, optional-feature migration, and startup-failure surfaces. Startup failure diagnostics probe the backend, entry module, imported modules, stylesheet, and web manifest, then produce a bounded copyable report with secrets and query strings removed.

### 5.2 Terminal navigation

Terminal tabs can appear in a top bar or desktop sidebar. The implementation supports:

- starting a tab in the current directory;
- choosing a directory first;
- opening a Git worktree in a new tab;
- closing one tab or all tabs;
- reordering tabs;
- grouping tabs by working directory;
- user-defined custom tab groups;
- grouped subagent views;
- a directly available `+ Tab` affordance for single-tab directory groups;
- a resizable desktop terminal rail in Sidebar mode.

A tab tooltip includes its effective non-default Web UI-selected `APPEND_SYSTEM.md` path. It never includes prompt contents.

### 5.3 Control Deck

Desktop placement choices are Right, Left, and Both. Sidebar tab placement allows Right or Left and disables Both. When the viewport cannot fit the selected columns, the interface uses one overlay without changing saved desktop assignments.

Control Deck sections are:

1. Controls
2. Files
3. Git
4. Optional features
5. Codex Usage
6. Claude Usage
7. Session
8. Sampling parameters
9. Subagents
10. Queue
11. Commands
12. Events

Users can collapse, hide, reorder, and move sections between sides. Both panels retain independent width and collapse state. Resize handles support pointer dragging, 24-pixel keyboard steps, 80-pixel steps with Shift, and Home or End for bounds.

Durable width bounds are:

- Control Deck: 320 through 4096 pixels;
- file viewer: 384 through 4096 pixels;
- terminal sidebar: 208 through 4096 pixels.

### 5.4 Control visibility

The context menu and setup dialog manage 24 optional controls in these groups:

- workspace toolbar;
- Control Deck;
- composer actions;
- input-frame controls;
- input-frame tags.

Changes save immediately. `Show all` stores an explicit empty hidden list. `Reset defaults` removes the explicit choice. Capability checks remain authoritative, so making an unavailable feature visible does not install or enable it. Send is never hideable. Keyboard users can recover the full visibility menu from Send with the Context Menu key or `Shift+F10`.

### 5.5 Composer action layout

Desktop users can reorder composer actions and place them in a sparse saved grid. The saved grid supports up to 24 columns and 4096 slots. Hiding an action repacks visible actions without deleting its saved position.

### 5.6 Workspace dashboard

The dashboard summarizes the active project, model, context use, Git state, queue, session, and activity. It offers common session and workspace actions. The user can hide or show it from the toolbar or command palette.

### 5.7 Split terminal

A second terminal can open in an iframe beside the active terminal. It has its own title and metadata. Closing the split removes only the split view.

## 6. Mobile, tablet, and PWA behavior

### 6.1 Legacy responsive shell

The default phone interface provides:

- full-screen terminal navigation;
- a compact composer with primary run actions;
- a full-screen More panel for secondary actions;
- full-screen Git footer details;
- touch-safe tooltips and controls;
- an Edit and Done mode for Control Deck section ordering;
- safe-area offsets;
- a collapsed todo summary with an expandable checklist.

The software keyboard hides secondary disclosure controls while keeping prompt entry and applicable primary actions.

### 6.2 Mobile Experience v2 preview

The optional phone shell is off by default. Enable or roll it back with:

- `?mobileShell=v2`
- `?mobileShell=legacy`

Its destinations are Chat, Sessions, Activity, and Project. Project contains Files, Git, Queue, and Workflows. More contains Session, Sampling parameters, Usage, Extensions, Settings, Commands, Diagnostics, and Subagents.

The v2 shell reuses canonical desktop controls instead of maintaining separate copies. Its continuity record preserves up to 24 browser sessions, text drafts, route choice, and bounded attachment metadata. It never persists attachment bytes. Restored attachment chips require reselection.

An unconfirmed send is never replayed automatically. The recovery surface offers manual Retry or Discard for ten minutes.

### 6.3 Tablet preview

Tablet adaptation is independently off by default for widths from 721 through 1050 CSS pixels. Use `?tabletShell=v2` or `?tabletShell=legacy`. The preview uses a destination rail, a bounded inspector, and full-screen files by default.

### 6.4 PWA

The package includes a web manifest, icons, a service worker, and standalone display metadata. The service worker:

- precaches the app shell;
- uses network-first loading for navigations and app assets;
- aborts a stalled network attempt after eight seconds;
- falls back to cache only for same-origin non-API assets;
- never caches `/api/` traffic;
- routes supported notification clicks to opaque tab, run, or blocker targets.

PWA installation and notifications normally require localhost or HTTPS. Browser support varies. This package does not implement Web Push after every browser client closes.

### 6.5 Browser notifications

The browser can notify for blocked extension dialogs, completed work, and failed work. Blocker notifications are automatic after the user grants browser permission. Agent-done notifications are an explicit browser-local setting.

A notification carries a versioned opaque target for a tab, agent run, or blocker. Clicking it focuses an existing Web UI window or opens one, then reconciles current server state before navigating to Chat, Sessions, Activity, or Project. The target does not contain a prompt, path, model response, or provider credential.

Notifications use the active service worker when available and fall back to the browser Notification API. Activity remains the in-app record when permission is unavailable or denied. The feature works only while an active Web UI client or service worker can receive the event.

## 7. Sessions, tabs, and workspaces

### 7.1 Session lifecycle

The browser supports:

- new sessions in the current tab;
- resume into a separate tab;
- session metadata rename without renaming the JSONL file;
- safe localhost-only deletion with active-session and open-tab guards;
- clone at the current position;
- fork from a selected user message;
- edit and retry from a user message;
- partial session-tree navigation;
- manual compaction with optional instructions;
- automatic compaction toggle;
- full tab reload while retaining the session when possible.

Resume lists at most 200 sessions. Session paths are confined to configured Pi session directories. Deletion prefers the operating-system trash and uses unlink only as a fallback.

### 7.2 Tab naming

An explicit name from `--name`, `/name`, or browser naming remains authoritative. Otherwise the first prompt produces an automatic title bounded to 44 characters and eight significant words. Display metadata can retain up to 160 characters.

Session Summary can also provide generated titles. It never replaces an explicit name.

### 7.3 Saved workspaces

The workspace feature saves a named constellation of:

- open tab IDs and order;
- working directories;
- session files;
- tab titles and title sources;
- conversation-started state;
- the active tab;
- custom groups.

A saved workspace can replace current tabs. The confirmation offers Cancel, Load without saving, or Save and load. Replacement terminates the current Pi processes.

Storage accepts at most 20 workspaces and 30 tabs per workspace. Saving a duplicate name requires explicit overwrite. The oldest workspace is evicted when the limit is exceeded.

## 8. Prompt composer and queueing

### 8.1 Prompt entry

The prompt textarea grows to a bounded height, then scrolls vertically. It supports:

- normal prompts;
- steering messages;
- queued follow-ups;
- `Alt+Enter` follow-up submission;
- a saved busy-prompt choice between Follow-up and Steer;
- slash-command completion;
- `@` path completion;
- optional `!` and `!!` shell completion;
- prompt history navigation;
- per-tab drafts;
- edit and retry;
- drag, drop, paste, and file-picker attachments.

A highlighted completion uses Enter to accept. Once the token is complete, Enter sends.

### 8.2 User bash

A leading `!` executes a shell command and includes its output in the next model context. A leading `!!` executes it with `excludeFromContext: true`. Commands serialize per tab. Active user bash can be aborted before agent work.

The optional fish user-bash package can provide the shell backend. The optional bang autocomplete package supplies browser suggestions through its Web UI endpoint.

A non-local browser receives a warning that shell commands execute on the server as the Web UI process user.

### 8.3 Follow-up queue

The queue surface shows steering messages, follow-ups, user bash, and loaded prompt-list work. Users can remove, edit, and reorder supported queue entries. Queue mutation is capped at 512 items.

`Alt+Up` restores the latest observed steering and follow-up text into the composer. Upstream RPC does not yet provide complete queue clearing and attachment restoration, so this shortcut is partial parity.

### 8.4 Prompt lists

Users can create, save, load, delete, and run prompt lists. A list contains one starting prompt followed by any number of queued follow-ups. The side panel shows the loaded list and run state.

### 8.5 Abort behavior

Holding Escape or the Abort button for 1.2 seconds aborts active work. A quick Escape continues to close the topmost dialog or popup. User bash has abort priority over the agent turn. Successful abort also cancels pending extension UI requests for that tab.

## 9. Attachments and images

The composer accepts files through picker, drag and drop, and clipboard paste. Long clipboard or prompt text can become editable text attachments. The browser can send supported images inline through Pi RPC.

Implemented limits:

| Limit | Value |
| --- | ---: |
| files per upload | 12 |
| one uploaded file | 64 MiB |
| all uploaded files | 64 MiB |
| attachment request body | 96 MiB |
| one inline image | 8 MiB |
| all inline images | 16 MiB |
| one Pi RPC JSONL line | 32 MiB |

Inline RPC image types are PNG, JPEG, WebP, and GIF. Uploads use generated private temporary directories and sanitized filenames. Upload artifacts expire after 24 hours and are swept hourly.

## 10. Transcript and live output

### 10.1 Rendered content

The normal transcript renders:

- user and assistant messages;
- Markdown;
- fenced code with copy controls;
- Mermaid diagrams;
- thinking output;
- tool calls and results;
- bash output;
- images;
- queue and compaction events;
- extension notices, statuses, and widgets;
- final action feedback.

Consecutive thinking records are grouped. Outer `<think>...</think>` output from compatible local models is separated into a Thinking card. Balanced literal inner tag examples remain inside the reasoning rather than ending it early.

### 10.2 Syntax highlighting

The dependency-free highlighter supports Python, JavaScript, TypeScript, shell, PowerShell, Windows command scripts, JSON, INI, TOML, YAML, diff, SQL, CSS, HTML and XML, Dockerfile, C and C++, Java, Go, Rust, and C# aliases.

Highlighting is skipped for unknown languages and for blocks over 50,000 characters or 2,000 lines. Source text is preserved exactly and is inserted with text-safe DOM APIs. Mermaid fences render as diagrams before syntax highlighting is considered.

### 10.3 Streaming scheduler

The normal renderer applies the first eligible update immediately and coalesces sustained formatting on a 40 millisecond latest-wins cadence. Semantic boundaries, cancellation, output-mode changes, disconnect, and visibility changes flush pending work.

Incremental parsing scans appended suffixes for todo state, thinking, final output, and Markdown fence boundaries. Ambiguous non-code tails over 16 KiB use a plain append-only live node until a safe boundary or completion restores full Markdown rendering.

### 10.4 Transcript loading

Each transcript refresh owns a request token. Old-tab or overlapping responses cannot hide a newer tab's loading state. The transcript receives `aria-busy` immediately. A non-modal loading status appears after 120 milliseconds and leaves existing content interactive.

`GET /api/messages?since=N` supports append-only delta refresh. The complete Pi transcript remains authoritative.

### 10.5 Search and scroll

`Ctrl/Cmd+F` searches the active transcript, file, or subagent output. Every match is highlighted, with previous and next navigation. Transcript follow-scroll respects user scroll intent and offers a Latest button when detached.

Middle-button drag scrolling is supported on eligible scroll surfaces.

### 10.6 Compact output

`compact-v1` reduces live browser work. It keeps the current tool status, visible thinking, and final Markdown answer while omitting most intermediate tool details. The mode changes display only. It does not change prompts, tools, models, providers, inference, or stored transcript meaning.

Precedence for the default mode is:

1. CLI `--output-mode`
2. `PI_WEBUI_OUTPUT_MODE`
3. persisted Web UI setting
4. `normal`

Normal and compact browser clients can observe the same Pi tab at the same time.

### 10.7 Document artifacts

A tool result can register a `pi.artifact/v1` document envelope. The server rewrites approved private artifact metadata into tab-bound opaque URLs. The browser then shows a document card with Open viewer and Download actions.

The viewer provides:

- rendered page thumbnails and a large page image;
- previous and next page controls;
- zoom and rotation;
- download of the produced document when present;
- semantic structure, revisions, warnings, and diff metadata;
- a Send page to composer action that inserts an artifact and page reference.

The server accepts artifact files only from the private default artifact root or an operator-configured artifact root. It checks manifest identity, bounds manifests to 2 MiB and 10,000 pages, removes private host paths from browser payloads, and binds every token to one tab and session identity. Manifest, page, and download responses use private no-store caching. File responses support one byte range.

A stale, expired, wrong-tab, or wrong-session token returns unavailable state instead of revealing whether a host path exists. The normal file viewer still does not render arbitrary DOCX or PDF files directly.

## 11. Events, notices, and feedback

### 11.1 Events log

The Events section keeps 120 browser-held rows. The server keeps up to 200 recent events for diagnostics. Filters are:

- All events
- Errors and failures
- Warnings
- Tool activity
- Tree available

Detailed and Compact display modes persist in browser storage and synchronize across same-origin tabs. Tool rows show status, bounded duration, shortened call ID, and only allowlisted file paths. They do not expose arbitrary arguments, results, or output.

Eligible tool rows can open Tree navigation. Start rows select the persisted tool-call boundary. Finish and failure rows prefer the result boundary. The browser revalidates the boundary against the active session tree and asks for confirmation before navigation.

Repeated successful subagent Auto-Clear events aggregate into one row. Warning and error notices also appear as short-lived bottom-of-window toasts and increment the Events unread badge.

### 11.2 Action feedback

Final assistant messages and tool or bash cards can receive positive, negative, or question feedback. The feedback tray can send the selected reactions back to Pi and ask it to create or update a LEARNING.

### 11.3 Undo

Supported destructive browser actions can expose a ten-second Undo toast. The action description and remaining time remain visible while undo is available.

## 12. Models, thinking, and sampling

### 12.1 Model control

Users can search all available models, apply one to the active tab, open `/model`, or select a model from the command palette. `Ctrl/Cmd+L` opens model selection. `Ctrl/Cmd+P` and `Shift+Ctrl/Cmd+P` cycle forward and backward.

### 12.2 Scoped models

The footer model picker uses Pi's scoped-model patterns. Flat mode supports pointer drag and `Alt+Up` or `Alt+Down` reordering. Advanced mode groups models into alphabetized provider columns while retaining model order inside each provider.

Advanced keyboard behavior:

- Left and Right change provider;
- Up, Down, Home, and End move inside a provider;
- Enter or Space selects;
- Escape closes and restores focus.

The flat or advanced choice is browser-local and synchronizes across same-origin tabs. It does not modify Pi settings.

### 12.3 Thinking effort

Supported UI levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The effective list is reduced by model capability. Busy-tab changes queue for the next prompt. `Shift+Tab` cycles effort while the composer has focus.

Thinking visibility is a separate browser choice. `Ctrl/Cmd+T` toggles it without changing model reasoning.

### 12.4 Sampling parameters

The Sampling parameters section edits branch-persistent session overrides. Each parameter has an enable checkbox. Disabled values inherit model defaults and are not serialized.

Implemented controls:

| Parameter | Accepted range | Type |
| --- | --- | --- |
| `temperature` | 0 through 2 | number |
| `top_p` | greater than 0 through 1 | number |
| `frequency_penalty` | -2 through 2 | number |
| `presence_penalty` | -2 through 2 | number |
| `seed` | -1 or greater | integer |
| `top_k` | -1 or greater | integer |
| `min_p` | 0 through 1 | number |

The helper reports support per parameter for the active provider API and model. Unsupported values can remain stored but are not applied. Unknown JSON-compatible sampling keys are preserved outside the visual editor. A session sampling record accepts at most 128 keys and 16 KiB. The HTTP write body is capped at 20 KiB.

## 13. Tools, skills, and Pi settings

### 13.1 Tool and skill scopes

Browser-native Tools Setup and Skills Setup support:

- Session only
- Global default
- exact Model default

Resolution order is session branch, exact case-sensitive provider and model profile, global default, then Pi runtime default. A session choice may explicitly inherit or explicitly enable no resources. Unavailable saved names are retained for later sessions.

A successful model change immediately reapplies tool and skill profiles that are not pinned by the current session.

The separate `@firstpick/pi-extension-tools` and `@firstpick/pi-extension-setup-skills` packages own the Pi TUI `/tools` and `/skills` commands. Web UI does not register competing TUI commands.

Disabled skills are removed from the model-invocation system prompt and explicit disabled skill commands are blocked. Tracked `SKILL.md` files appear as bounded tags above the composer. A `+X` disclosure exposes hidden tags. Localhost users can open and edit a guarded skill file from the tag.

### 13.2 Browser-native Pi settings

The `/settings` browser dialog reads and writes these Pi settings:

- transport: `sse`, `websocket`, `websocket-cached`, or `auto`;
- HTTP idle timeout;
- automatic image resizing;
- image blocking and display;
- skill commands;
- thinking-block hiding;
- image width: 60, 80, or 120 cells;
- changelog collapse;
- quiet startup;
- install telemetry;
- double-Escape action: tree, fork, or none;
- tree filtering;
- hardware cursor;
- editor horizontal padding from 0 through 3;
- autocomplete visible count: 3, 5, 7, 10, 15, or 20;
- clear on shrink;
- terminal progress;
- Anthropic extra-usage warning.

Transport, HTTP timeout, image resize, image blocking, and skill-command changes are marked as reload-recommended. The user can save first and choose whether to reload the active tab.

### 13.3 Append-system prompt selection

`/append-system` opens a global Web UI selector for one visible `APPEND_SYSTEM.md` path. Discovery starts from the active working directory and `~/.pi`.

Bounds are:

- 2,048 directories;
- visible-path depth 10;
- 256 candidates;
- 64 diagnostics;
- exact case-sensitive filename `APPEND_SYSTEM.md`.

The scan follows root, folder, and file symlinks, including links outside the two starting roots. Candidate identity remains the visible alias path. This is intentional and potentially powerful. Users must verify a link and its target before selecting it.

The exact default `~/.pi/agent/APPEND_SYSTEM.md` maps to Use Pi default discovery. A changed selection is saved globally, then the user may restart the active tab. Existing tabs retain launch-time instructions until a full Pi process restart.

The picker never reads or displays prompt contents. Launch revalidates the path, depth, filename, lexical root containment, and regular-file target. An invalid saved path falls back to Pi's normal discovery.

## 14. Files and project navigation

### 14.1 Working-directory picker

The picker supports:

- direct absolute path entry;
- browsing parents and children;
- local directory search;
- creating a directory;
- pinning up to 30 fast picks;
- changing the active tab's directory;
- selecting the first or a new tab's directory.

On Windows, rooted drive paths such as `C:/` are accepted. Parent from a drive root opens a virtual This PC list of ready filesystem drives. This PC cannot itself be selected, created in, or pinned.

### 14.2 File tree

The Files section lists up to 1,200 entries. It shows Git-ignored files and folders in a muted state rather than hiding them. Search scans up to 12,000 entries, depth 8, and returns up to 200 results. `.git` and `node_modules` are excluded from search traversal.

File-row actions are:

- Open in Default Editor
- Open in WebUI
- New file
- New folder
- Move or Rename
- Delete

Mutations are confined to the active workspace. Delete, move, save, and default-editor actions are localhost-only.

### 14.3 File viewer

The viewer supports:

- editable UTF-8 Source mode;
- rendered Markdown Preview;
- read-only Git Changes mode;
- read-only PNG, JPEG, GIF, WebP, and AVIF preview;
- search with highlighted matches;
- selectable source or Markdown text;
- sending a selection, surrounding context, and one-line comment to Pi;
- opening the file in the operating-system default editor.

Each file read is capped at 2 MiB. SVG, PDF, video, audio, and unlisted binary formats are not rendered. Image preview cannot be edited, searched as text, or sent as a text selection.

Workspace file changes and Git changes use live server watchers. The browser invalidates visible state through SSE instead of polling the filesystem continuously.

## 15. Git features

### 15.1 Repository panel

The Git section groups repositories represented by open tabs. One repository card can be expanded at a time. Status cache entries expire after five minutes. Live filesystem events invalidate visible repositories without an automatic network fetch.

The panel shows:

- conflicted, staged, modified, and untracked paths;
- additions and deletions;
- ignored-path state;
- the latest 30 commits;
- bounded read-only commit diffs.

### 15.2 Changes and branch flows

Implemented actions include:

- read repository root and status;
- view file and repository diffs;
- fetch;
- pull and integrate upstream changes;
- choose merge or rebase after divergent-history pull failure;
- stage or unstage one path;
- stage or unstage all paths;
- discard a tracked-file change after confirmation;
- delete an untracked file after confirmation;
- add a path to `.gitignore`;
- switch a local branch;
- create a branch;
- create a branch from a remote ref;
- inspect and open worktrees.

The footer branch picker warns when branch changes may affect active work.

### 15.3 Advanced Git operations

The server also implements:

- in-progress merge, rebase, cherry-pick, revert, and bisect inspection;
- continue, skip, and abort operations;
- stage a conflict-resolution file;
- start or mark bisect steps;
- open a dedicated Pi tab to resolve conflicts;
- list, preview, save, apply, pop, and drop stashes;
- inspect reflog and undo state;
- undo the last commit;
- amend the last commit message;
- inspect and update submodules;
- inspect and create tags;
- inspect signing configuration;
- dry-run and confirmed worktree pruning.

Git mutations serialize per repository where required. Command output is bounded. Windows-reserved device names receive a specific error and recovery hint.

### 15.4 Worktrees

Users can list worktrees, open an existing worktree in a tab, create a branch worktree, remove one, and prune stale records. Removal is localhost-only. New worktrees can start from `origin/main` or the current `HEAD`. Uncommitted files are not part of the branch base.

Worktree creation does not copy ignored dependencies such as `node_modules` or `.venv`.

### 15.5 Guided Git workflow

The browser workflow requires `@firstpick/pi-extension-git-guided-workflow`. The extension owns `/git-guided-workflow`, `/git-staged-msg`, `/git-branch-name`, and `/pr`. Browser generation accepts extension-owned RPC commands only. A same-named prompt template is not a fallback.

The workflow supports:

- initializing a new repository;
- checking and creating starter `README.md` and `.gitignore` files without overwriting existing files;
- initial commit and `main` branch setup;
- review-first staging or explicit stage-all;
- optional AUR-review approval bound to a staged-content hash;
- generated short and long commit messages;
- manual commit messages;
- generated or manual PR branch names;
- current-branch or PR-worktree delivery;
- push confirmation;
- GitHub repository publication with explicit Public or Private choice;
- generated and editable pull-request text;
- `gh pr create` after final confirmation;
- cancellation at workflow steps.

The launcher refuses while the tab is streaming, compacting, has pending messages, or already has a pending Guided Git launch. It does not queue the workflow for later.

Guided Git generation uses a separately configured primary model and effort. It does not change the parent tab model. A configured fallback gets one attempt only after the extension classifies a final primary provider-generation failure. Validation, cancellation, stale artifacts, Git errors, and a dead Pi process do not trigger fallback.

A staged diff at the extension's 16 MiB ceiling can use up to 35 model requests per attempt. A fallback can repeat the full evidence and bring the maximum to 70 requests across both providers.

Publication without a remote requires an installed and authenticated GitHub CLI. The server derives the repository name from the Git root directory and ignores a client-supplied name for this recovery path. Guided Git does not force-push automatically.

## 16. App runners

The runner menu detects common project commands for:

- npm, pnpm, Bun, and npx projects;
- Cargo and Rust;
- Python and uv;
- Go;
- Zig;
- C and C++;
- Docker Compose;
- shell scripts in the project root, `dev`, `scripts`, and `dev/scripts`;
- project-defined runners.

Runner output is pinned above the transcript. ANSI SGR color is rendered safely. LF and CRLF commit lines, a bare carriage return replaces the current progress line, and backspace edits that line. This is line-oriented terminal behavior, not a complete VT100 screen.

Running commands accept line-oriented stdin. Stop terminates the process tree after a 2.5-second grace period.

Windows uses ConPTY through `node-pty` when available. `PI_WEBUI_APP_RUNNER_PTY=off` forces pipe mode.

Projects can define `.pi-webui-runners.json` version 2 with up to 48 custom runners and 24 extra search paths. A runner can have up to 32 arguments. Search paths must be project-relative, cannot contain `..`, cannot escape through symlinks, and are scanned one level deep. Invalid stored paths produce diagnostics instead of being scanned.

Runner output retains up to 1,000 lines and 240,000 characters. One stdin submission is limited to 16,000 characters.

## 17. Session summaries and coordination

### 17.1 Summary commands

The package registers:

```text
/summary
/summary refresh
/summary workspace
/summary-setup
```

Summary generation is opt-in. Setup selects:

- an exact authenticated model;
- thinking effort;
- automatic generation;
- generated-title behavior and cadence;
- title and Markdown-summary prompts;
- optional latest-summary context injection.

The configured summary model runs independently of the parent tab model. There is no silent provider fallback. One request has a 90-second model limit, no automatic retry, and a five-minute cooldown after automatic failure.

### 17.2 Summary privacy contract

Summary input contains active-branch user text, final assistant text, and tool names. It excludes thinking, images, tool arguments, tool results, credentials, hidden provider data, and prior summary control records.

The latest successful result remains available after provider, timeout, parse, or stale-branch failure. Main-agent context injection is off by default and, when enabled, adds only the latest active-branch summary as reference data.

Implemented bounds include:

- title: 44 characters;
- summary Markdown: 16 KiB;
- each editable prompt: 8 KiB;
- summary HTTP body: 32 KiB.

### 17.3 Workspace summaries

The `workspace_session_summaries` tool and `/summary workspace` discover bounded summaries from the same canonical working directory. Live peers use the optional Intercom bus. Persisted session discovery remains available when the bus is absent.

The shared projection excludes raw transcripts, thinking, images, tool arguments and results, provider payloads, and session-file metadata. Generated prose is redacted for recognized credential patterns, private-key blocks, and common session paths. This redaction is best effort and cannot prove that arbitrary prose contains no sensitive information.

The feature advises agents to compare goals, files, symbols, decisions, and next steps. It does not send messages, lock files, or assign ownership automatically.

## 18. Subagents and independent agent runs

### 18.1 Observed launchers

The Subagents section accepts managed or registered runs from:

- SDK sessions;
- Pi RPC;
- Pi JSON mode;
- Pi print mode;
- interactive processes;
- tmux;
- `pi-subagents`;
- schedules;
- gates;
- workflows;
- custom producers.

Exact parent-session matches stay under their Web UI terminal. Others appear under External agents. A model-less `pi-subagents` workflow controller renders as a collapsible Workflow header and does not add to agent counts.

Canonical lifecycle states are queued, running, stale, lost, done, failed, and cancelled.

### 18.2 Output and controls

A run can open in a non-blocking overlay or a dedicated read-only Subagent tab. The browser saves that choice. Closing a projected tab closes only the view.

Available actions depend on producer-declared capabilities. Unsupported cancel, refresh, copy, detach, and dismiss controls stay hidden. Session-backed output can show a transcript. Print mode shows bounded plain output. Metadata-only records state that output is unavailable.

A dedicated tab shows six telemetry cards:

- PI prompt tokens;
- measured output speed;
- context use;
- model;
- effort;
- input and output tokens.

Missing evidence remains unknown or `not reported`; the browser does not estimate it.

`Clear finished` and Auto-Clear hide eligible projections without deleting producer records, session files, output files, or processes. Explicitly attached stale or lost sessions provide Detach.

### 18.3 Startup recovery

At Web UI startup, only queued or running prior agents reconnect. Rows already stale, lost, done, failed, or cancelled before startup remain suppressed. A row that becomes terminal during the current server run remains available for inspection.

Recovered active children can appear as provisional, read-only rows until the helper observes a controllable locator. Bounded snapshots report omitted children as an aggregate. They never expose private prompts or paths.

### 18.4 Agent model slots

The Agent models editor configures ordered slots for:

- context-builder;
- delegate;
- oracle;
- planner;
- researcher;
- reviewer;
- scout;
- worker.

Every role has a non-removable base slot. Additional same-role slots have stable IDs. Scope is User default or This project. Projects inherit user defaults until explicitly saved. Each slot can inherit or select an active-tab provider-qualified model and supported effort.

The helper loads one immutable snapshot when the tab starts or reloads. Saving does not change a running tab until Reload active tab. Omitted models in `subagent`, `subagent_gate`, `runs.run`, and `runs.all` receive the matching role-slot default.

### 18.5 Reviewer mismatch policy

An explicit reviewer model and terminal thinking suffix must match the configured reviewer slot for that occurrence. A mismatch is blocked before the structured launch. The helper never silently substitutes another explicit reviewer model.

`approve_subagent_model_deviation` is available only for an exact user-authorized exception. It requires interactive confirmation, creates one local permit, expires after two minutes, and is consumed once. A tab retains at most eight unused permits. Reload, session replacement, slot revision change, or helper-generation change invalidates them.

Direct preflight is transactional across one structured call. A `runs.all` mismatch blocks all children in that call. Sequential workflow calls cannot undo a child that started before a later mismatch. This check is Web UI-local and does not cover launch paths that bypass the helper.

### 18.6 Generic subagent gate

The package registers `subagent_gate`. It launches task slots through pi-subagents RPC version 1, requires a success quorum, and performs bounded reason-aware retries only when the caller marks them safe. The side panel retains quorum, attempt, provider, and failure-class history.

## 19. Direct agent conversations

Direct Intercom and native subagent-supervisor messages appear as conversation tags below the active composer. Tags use at most half the desktop prompt row. Complete tags that do not fit move into a `+X` popup.

The read-only conversation dialog shows:

- the two participant names or IDs;
- sanitized text messages;
- direction and time;
- truncation or unavailable notices.

It excludes attachments, thinking, tool calls, tool results, stdout, stderr, raw session records, filesystem paths, and automated control relays.

Generic Intercom transport calls and paired results are removed from the main transcript while unrelated assistant content remains. The viewer reads the active persisted branch independently, so supported conversation history returns after browser or server restart.

Initial bounds are 32 conversations and 200 displayed messages per conversation. An open dialog checks for new persisted messages every five seconds.

## 20. Issue reporting and extension UI

### 20.1 Open Issue wizard

The persistent Open Issue action opens a five-step GitHub issue wizard:

1. Category
2. Component
3. Template
4. Details
5. Review

Categories are Feature, Bug, UX, Documentation, Performance, Compatibility, and Other. The chosen category limits compatible templates. Component choices come from Web UI and the current optional-feature catalog instead of a second hard-coded package list.

The wizard validates required fields, normalizes control characters, produces a complete Markdown issue, and always offers Copy complete issue. It does not collect credentials. Security guidance tells the user to remove secrets and use private vulnerability reporting for sensitive reports.

Automated submission is disabled by default. It sends no network request unless a deployment supplies an enabled public HTTPS gateway URL and a Cloudflare Turnstile site key before `app.js` loads. A deployment can also supply a public private-security-report URL. Invalid gateway or Turnstile configuration fails closed.

When enabled by an operator, the browser obtains a Turnstile result, requests admission, and polls bounded status for at most two minutes. It reports queued, checking, created, rejected, review, unavailable, or unknown state in a persistent live region. A created result must be a validated GitHub issue URL. Closing the dialog aborts admission and polling. Every failure path keeps the copy fallback.

Browser enablement does not bypass server-side gateway admission or creation kill switches. The package does not contain a GitHub repository-write credential.

### 20.2 Extension UI methods

Implemented extension UI methods include:

- non-blocking notifications;
- status lines;
- line-based widgets;
- specialized todo, workflow, `/btw`, feature-decision, Git footer, AUR review, release, and stats rendering;
- document title updates;
- composer text replacement;
- blocking select, confirm, input, and editor dialogs.

Blocking requests queue in the browser and block only the originating tab. The server retains pending blocker state so reconnect can replay it. Browser notifications can report a blocker while an active client or service worker exists.

Not implemented through Pi RPC:

- extension autocomplete providers;
- arbitrary TUI header or footer components;
- arbitrary extension-supplied browser components or JavaScript.

Web UI favors known semantic payloads over rendering untrusted component code.

## 21. Optional companions

Every server start performs one bounded read-only audit. Core startup does not wait for optional package installation. The browser shows loaded, disabled, unregistered, missing, conflicting, migratable, and updateable states.

Recognized companion packages are:

| Package | Web UI integration |
| --- | --- |
| `@firstpick/pi-extension-bang-command-autocomplete` | `!` and `!!` suggestions |
| `@firstpick/pi-extension-fish-user-bash` | selected user-bash shell backend |
| `@firstpick/pi-extension-btw` | side-question widget and context transfer |
| `@firstpick/pi-extension-git-guided-workflow` | Guided Git launcher and text generation |
| `@firstpick/pi-extension-release-npm` | npm release menu and widgets |
| `@firstpick/pi-extension-release-aur` | AUR release menu and widgets |
| `@firstpick/pi-extension-aur-review` | repository review and Guided Git approval |
| `@firstpick/pi-extension-workflows` | workflow mode and subprocess widgets |
| `@firstpick/pi-extension-feature-system-prompt` | feature classification output |
| `@firstpick/pi-extension-safety-guard` | guarded command and file policy setup |
| `@firstpick/pi-extension-setup-skills` | Pi TUI `/skills` owner |
| `@firstpick/pi-extension-todo-progress` | todo progress widget |
| `@firstpick/pi-extension-tools` | Pi TUI `/tools` owner |
| `@firstpick/pi-package-remote-webui` | trusted-LAN open, close, QR, and PIN controls |
| `@firstpick/pi-package-questionnaire` | native questionnaire tool control |
| `@firstpick/pi-package-natural-conversation` | conversation mode and voice shell |
| `@firstpick/pi-extension-git-footer-status` | richer footer and Claude usage evidence |
| `@firstpick/pi-extension-stats` | browser usage dashboard |
| `@firstpick/pi-extension-codex-fast-mode` | Normal, Fast, and GPT-6 Astra Ultrafast subscription modes |
| `@firstpick/pi-themes-bundle` | additional Pi and Web UI themes |

The audit also reports prompt impact. `+` means initial system-prompt text, `+...` means conditional text can appear during a session, and `-` means no measured system-prompt text. Bundled skills count. Tool schemas and normal tool messages do not.

Localhost users can install or update one package, Install all missing packages, or Install missing within a section. Batches run sequentially, continue after a failed item, and never invent percentage progress. A stale audit revision is rejected.

Migration restores selected legacy companions through one confirmation. Retry failed repeats only failed items. Copy commands supplies allowlisted manual `pi install npm:<package>` commands. A busy Pi tab is never restarted automatically after installation.

Duplicate top-level and package ownership is blocked to avoid loading one resource twice. The browser does not remove conflicting top-level aliases.

## 22. Voice and Natural Conversation Mode

The optional Natural Conversation package is detected through `/talk`, `/voice`, or `/conversation`. When active, Web UI:

- keeps thinking off;
- shows Start, End, status, and voice controls;
- blocks unsafe model, session, workspace, and Git actions;
- listens with browser Web Speech APIs when available;
- sends final speech transcripts as normal prompts;
- pauses the microphone while speaking answers;
- treats speech during final-output streaming as steering;
- queues speech during tool execution;
- sends one structured silence event after a spoken question.

The browser-default path sends text transcripts to the Pi host. Optional server STT and TTS fallbacks can send raw audio or text to a configured provider.

Server provider options are:

- local STT through `PI_VOICE_STT_URL`;
- local TTS through `PI_VOICE_TTS_URL`;
- Groq STT with `GROQ_API_KEY`;
- OpenAI STT with `OPENAI_API_KEY`;
- OpenAI TTS with `OPENAI_API_KEY`.

Provider keys remain server-side. A remote or LAN browser must grant per-request microphone-streaming consent before raw audio can leave the browser for server-side STT. Audio requests are capped at 24 MiB. TTS text is capped at 12,000 characters. Provider timeout defaults to 120 seconds.

## 23. Usage and statistics

### 23.1 Codex Usage

For supported `openai-codex` authentication, the core server reads subscription usage windows and reset times without exposing credentials to the browser.

The optional Fast mode package adds a per-session Normal or Fast selector. Fast asks eligible subscription-backed requests for roughly 1.5 times faster responses and consumes 2 times Standard credits for GPT-5.4 or 2.5 times for GPT-5.5 and GPT-5.6. Provider eligibility remains authoritative.

### 23.2 Claude Usage

The Claude Usage section can consume recent Anthropic usage evidence published by the Git footer companion. It also has an explicit refresh path through the local `claude` executable using safe mode, no session persistence, print mode, and JSON output.

### 23.3 Pi stats

The optional stats package opens a browser dashboard with 14-day, 30-day, 90-day, custom, and all-time ranges. It can show token, cost, cache, model, session, command, and daily breakdowns. Clicking the footer PI metric can trigger optional calibration when the supporting companions are loaded.

## 24. Themes and visual customization

The browser supports Light, Dark, and Auto scheme modes plus installed Pi themes. Theme choice is browser-local. The customizer edits Pi's exact 51 required tokens, optional `thinkingMax`, variables, export colors, and advanced JSON.

Valid drafts preview immediately. Invalid or incomplete drafts remain editable but do not replace the last valid preview and cannot be saved.

Save destinations are:

- trusted project: `<cwd>/.pi/themes/<name>.json`;
- global: `~/.pi/agent/themes/<name>.json`.

Overwrite requires target-specific confirmation. Saving does not select the theme or reload Pi. Pi TUI discovers it after `/reload` or restart.

Custom browser backgrounds accept PNG, JPEG, WebP, and GIF up to 24 MiB. Background blobs use IndexedDB. The active choice and metadata use browser storage. Removing a background returns to the theme default.

## 25. Native command coverage

The packaged parity matrix is available at `/api/native-parity`.

### 25.1 Implemented browser-native commands

- `/settings`
- `/safety-guard-setup`
- `/git-workflow-setup`
- `/workflow-setup`
- `/summary`
- `/summary-setup`
- `/model`
- `/tools`
- `/skills`
- `/copy`
- `/name`
- `/session`
- `/clone`
- `/logout`
- `/new`
- `/compact`
- `/reload`

`/append-system` is an additional Web UI-native action.

### 25.2 Browser-specific or partial commands

- `/theme` changes the browser theme, not the running Pi terminal theme.
- `/scoped-models` uses the footer scoped picker and does not expose every TUI editor option.
- `/export` supports browser HTML download and explicit new `.html` or `.jsonl` paths, but does not yet provide overwrite confirmation.
- `/hotkeys` reports Web UI shortcuts rather than all Pi action bindings.
- `/fork` has a browser selector but not every native branch-summary option.
- `/tree` has partial filters and navigation.
- `/login` reports provider status but directs OAuth and API-key login to Pi TUI.
- `/resume` supports current or all sessions, switch, rename, and safe delete, but lacks all native sort and path toggles.

### 25.3 Unsupported commands

These return structured unavailable output rather than raw server errors:

- `/import`
- `/share`
- `/changelog`
- `/quit`

There is no browser equivalent for Pi's external editor shortcut.

## 26. Command palette and keyboard access

The command palette searches actions, tabs, models, and up to 140 visible slash commands. Empty searches show up to 80 results. Ranking favors label prefixes, word starts, label matches, then descriptions and keywords.

Implemented shortcuts:

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+K` | Open command palette |
| `Ctrl/Cmd+L` | Open model selector |
| `Ctrl/Cmd+P` | Cycle models forward |
| `Shift+Ctrl/Cmd+P` | Cycle models backward |
| `Shift+Tab` | Cycle thinking effort |
| `Ctrl/Cmd+T` | Toggle thinking output |
| `Ctrl/Cmd+O` | Toggle global tool and bash expansion |
| `Alt+Enter` | Queue a follow-up |
| `Alt+Up` | Restore observed queued text |
| hold `Esc` | Abort active bash or agent work |
| `Ctrl/Cmd+C` with focused composer and no selection | Clear the prompt |
| `Ctrl/Cmd+F` | Search the active transcript, file, or subagent output |
| `Alt+Up` and `Alt+Down` on a Control Deck section | Reorder within one side |
| `Alt+Left` and `Alt+Right` on a Control Deck section | Move between sides in Both mode |

Composer-specific model, thinking, and tool shortcuts run only while the composer has focus. Autocomplete consumes navigation keys while its list is active.

## 27. Accessibility contract

The implementation uses native buttons, inputs, details elements, dialogs, listboxes, menus, tab lists, trees, and separators where possible. Important behavior includes:

- roving focus in advanced model selection;
- keyboard resizing and reordering;
- focus trapping in modal dialogs;
- focus restoration to the invoking control;
- prompt fallback when an invoking control is hidden;
- polite or assertive live regions for status and failure;
- `aria-busy` during transcript loading;
- labels and tooltips for truncated content;
- reduced-motion handling;
- 44-pixel targets in the v2 mobile disclosure UI;
- browser axe coverage for selected desktop and mobile flows.

No feature may rely on hover alone for essential use. Touch pointers suppress hover-only help.

## 28. Network and security model

### 28.1 Default trust boundary

The default bind is `127.0.0.1:31415`. This is the safe normal mode. Any browser that can reach an authenticated Web UI can control Pi with the Web UI process user's permissions.

`--host 0.0.0.0` or the optional Remote Web UI package opens trusted-LAN access. Remote PIN authentication is off on first use unless configured. When enabled, the server generates a fresh four-digit PIN for each start and challenges non-local clients. Localhost remains frictionless.

The PIN is a trusted-network convenience. It is not hardened multi-user authentication, rate-limited internet authentication, TLS, or a defense against a hostile local network. The server must not be exposed directly to the public internet.

### 28.2 Localhost-only mutations

The central trust policy restricts these classes of operation to localhost:

- network open and close;
- remote-auth settings;
- workflow-policy saves;
- subagent slot saves, cancel, and dismiss;
- recovery-plan creation;
- restart, shutdown, update plan, apply, and rollback;
- optional package installation;
- skill-file save;
- file delete, move, save, and default-editor open;
- session delete;
- credential logout;
- custom-theme save;
- Git worktree removal.

Additional handlers apply confirmation, project trust, capability, active-session, same-origin, revision, digest, or path-confinement checks.

### 28.3 Remote authentication behavior

Remote authentication uses an HTTP cookie backed by a random in-memory token and expiry. Enabling or disabling authentication closes active SSE clients so remote clients must re-authenticate under the new policy. Public remote-auth paths are limited to the login surface, status route, and favicon.

### 28.4 Path safety

Server-side browser values never directly select arbitrary host paths for:

- subagent output;
- agent registry files;
- session deletion;
- session attachment;
- project file reads or writes;
- theme writes;
- app-runner discovery.

Opaque IDs, configured roots, canonical path checks, regular-file checks, and lexical project bounds are used according to the operation. The append-system picker is the documented exception that intentionally follows symlinks outside its visible roots after bounded discovery and launch-time validation.

### 28.5 Browser rendering safety

Markdown code text and syntax tokens use text nodes or `textContent`. File image MIME types come from a fixed extension map. ANSI rendering accepts safe SGR sequences rather than injecting terminal HTML. Extension UI uses known data shapes and does not run extension-supplied JavaScript.

Static assets use MIME types, `X-Content-Type-Options: nosniff`, ETags, conditional requests, and Brotli or gzip for eligible assets.

### 28.6 Secrets

Provider API keys remain server-side. Supervisor credentials, IPC paths, recovery tokens, private update state, raw registry files, and credential paths are excluded from browser diagnostics and public status. Generated diagnostics redact token-like values and remove URL query strings.

Internal recovery environment variables are credentials. They must not be logged, copied into settings, or supplied to untrusted child processes.

## 29. Updates, restart, and rollback

The update interface covers Pi, Web UI, and eligible registered optional packages.

The transaction flow is:

1. Resolve current ownership and moving release metadata once.
2. Create a private plan with exact target versions and commands.
3. Hash the plan with SHA-256.
4. Show the exact plan for confirmation.
5. Apply only the matching transaction ID and digest.
6. Acquire a cross-process install lock.
7. Revalidate runtime identity and ownership.
8. Execute commands with process-tree timeouts.
9. Verify installed targets.
10. Record ordered durable receipts.

Accepted outcomes are success, partial, failed, and rolled-back. Unsupported source, linked, pnpm, Yarn, opaque, nested, and unknown ownership fails closed with manual guidance.

A Web UI candidate installs beside the active runtime under the Pi agent directory. The server probes it before activation. The stable launcher follows private `current` and `previous` pointers. Health verification lasts at least 90 seconds and requires the expected version plus a changed boot identity. Failed activation restores the prior pointer automatically.

Zero downtime is not promised. App runners stop. Existing supervised Pi tabs can remain on code already loaded while new or reloaded tabs use the new version.

Legacy broad update endpoints return `410 Gone`.

## 30. Persistence and storage

| Data | Default location or owner |
| --- | --- |
| Web UI settings | `~/.pi/webui/settings.json` |
| legacy settings import | `$XDG_CONFIG_HOME/pi-webui/settings.json` or `~/.config/pi-webui/settings.json` |
| session summary profile | `~/.pi/agent/session-summary.json` |
| saved workspaces | `$XDG_CONFIG_HOME/pi-webui/workspaces.json` or `~/.config/pi-webui/workspaces.json` |
| agent-run registry | `$XDG_STATE_HOME/pi-webui/` or `~/.local/state/pi-webui/` |
| managed Web UI runtimes | `<PI_CODING_AGENT_DIR>/webui/runtimes/` |
| project app runners | `<cwd>/.pi-webui-runners.json` |
| project themes | `<cwd>/.pi/themes/` |
| global themes | `~/.pi/agent/themes/` |
| Pi global settings | `~/.pi/agent/settings.json` under the normal agent root |
| Pi project settings | `<cwd>/.pi/settings.json` |
| uploaded attachments | private operating-system temp directory |
| native exports | private operating-system temp directory |
| browser presentation | same-origin local storage and IndexedDB |

Web UI settings use schema version 8. Interface layout uses schema version 3. Writes use private temporary files, atomic replacement, same-process serialization, and a bounded cross-process writer lock. Dead or malformed lock records are cleaned conservatively.

The settings migration imports a valid legacy file once only when the new file is absent. It never deletes or modifies the old file. An explicit `PI_WEBUI_SETTINGS_FILE` disables that import.

Native export downloads use opaque single-use style tokens with a ten-minute lifetime. Export temp artifacts expire after one hour.

## 31. Environment variables

### 31.1 Main runtime controls

| Variable | Purpose |
| --- | --- |
| `PI_CODING_AGENT_DIR` | Selects the Pi agent root |
| `PI_WEBUI_HOST` | Default bind host |
| `PI_WEBUI_PORT` | Default port and agent registry scope |
| `PI_WEBUI_PI_BIN` | Pi executable |
| `PI_WEBUI_REMOTE_AUTH` | Startup remote-PIN choice |
| `PI_WEBUI_OUTPUT_MODE` | `normal` or `compact-v1` default |
| `PI_WEBUI_RPC_SUPERVISOR` | Set to `0`, `false`, `no`, or `off` only after explicit shutdown to use direct mode |
| `PI_WEBUI_SETTINGS_FILE` | Web UI settings override |
| `PI_SESSION_SUMMARY_CONFIG_FILE` | Session summary profile override |
| `PI_WEBUI_FAST_PICKS_FILE` | Saved directory fast-pick override |
| `PI_WEBUI_WORKSPACES_FILE` | Saved workspace file override |
| `PI_WEBUI_APP_RUNNER_PTY` | Set to `off` or another false value to disable PTY use |
| `PI_WEBUI_ARTIFACT_ROOTS` | Adds trusted document-artifact roots using the operating-system path delimiter |
| `PI_WEBUI_NPM_BIN` | npm executable used by managed package operations |
| `PI_WEBUI_PROMPT_TIMEOUT_MS` | Prompt request timeout, default two hours |

### 31.2 Usage and release lookups

- `PI_WEBUI_PI_LATEST_VERSION_URL`
- `PI_WEBUI_PI_RELEASES_API_BASE_URL`
- `PI_WEBUI_NPM_REGISTRY_URL`
- `PI_WEBUI_CODEX_USAGE_URL`
- `PI_WEBUI_CLAUDE_BIN`
- `PI_WEBUI_CLAUDE_USAGE_TIMEOUT_MS`

These are deployment and test overrides. Normal users do not need them.

### 31.3 Voice providers

- `PI_VOICE_CONFIG_PATH`
- `PI_VOICE_STT_URL`
- `PI_VOICE_TTS_URL`
- `PI_VOICE_STT_PROVIDER`
- `PI_VOICE_TTS_PROVIDER`
- `PI_VOICE_GROQ_STT_MODEL`
- `PI_VOICE_OPENAI_STT_MODEL`
- `PI_VOICE_OPENAI_TTS_MODEL`
- `PI_VOICE_OPENAI_TTS_VOICE`
- `PI_VOICE_OPENAI_TTS_FORMAT`
- `PI_VOICE_TTS_VOICE`
- `PI_VOICE_TTS_FORMAT`
- `PI_VOICE_PROVIDER_TIMEOUT_MS`
- `GROQ_API_KEY`
- `OPENAI_API_KEY`

### 31.4 Optional companion controls

- `PI_BANG_AUTOCOMPLETE_INCLUDE_HISTORY`
- `PI_BANG_AUTOCOMPLETE_RUNTIME_STORE_PATH`

### 31.5 Internal and diagnostic controls

The implementation also uses private activation, restore, recovery, supervisor-cursor, update-lock, optional-feature, artifact-root, development, startup-delay, and editor-command variables. They support update handoff, tests, or managed deployment. They are not stable end-user configuration contracts. Recovery and update-lock values are secret and short-lived.

## 32. HTTP API groups

This section lists the implemented route groups. The exact payload contracts remain contributor interfaces and may change with the browser and server together.

### 32.1 Health, status, and live events

- `GET /api/health`
- `GET /api/webui-status`
- `GET /api/events`
- `GET /api/native-parity`
- `GET /api/pi-release-notes`
- `GET /api/update-status`

### 32.2 Tabs, workspaces, state, and transcript

- `GET, POST /api/tabs`
- `PATCH, DELETE /api/tabs/<id>`
- `POST /api/tabs/close`
- `POST /api/tabs/reopen`
- `GET, POST /api/workspaces`
- `DELETE /api/workspaces/<id>`
- `GET /api/state`
- `GET /api/messages`
- `GET /api/stats`
- `GET /api/last-assistant-text`

### 32.3 Pi interaction

- `POST /api/prompt`
- `POST /api/steer`
- `POST /api/follow-up`
- `POST /api/abort`
- `POST /api/bash`
- `POST /api/abort-bash`
- `POST /api/new-session`
- `POST /api/model`
- `POST /api/thinking`
- `POST /api/thinking-cycle`
- `POST /api/steering-mode`
- `POST /api/follow-up-mode`
- `POST /api/auto-compaction`
- `POST /api/compact`
- `POST /api/extension-ui-response`

Prompt requests support browser request deduplication. Prompt, steering, follow-up, and queue bodies are capped at 24 MiB.

### 32.4 Session operations

- `GET /api/sessions`
- `GET /api/session-tree`
- `GET /api/fork-messages`
- `POST /api/fork`
- `POST /api/clone`
- `POST /api/switch-session`
- `POST /api/session-rename`
- `POST /api/session-delete`
- `POST /api/tree-navigate`

### 32.5 Models, resources, settings, and prompts

- `GET /api/models`
- `GET /api/scoped-models`
- `POST /api/model-cycle`
- `GET, POST /api/settings`
- `GET, POST /api/tools`
- `GET, POST /api/skills`
- `GET, POST /api/skill-file`
- `GET /api/commands`
- `GET /api/append-system-files`
- `POST /api/append-system-selection`
- `GET, PUT /api/tabs/<id>/sampling-parameters`
- `GET, PUT /api/interface-preferences`
- `GET, PUT /api/webui-output-mode`

### 32.6 Files, directories, attachments, and runners

- `GET, POST /api/directories`
- `GET, POST /api/path-fast-picks`
- `GET /api/path-suggestions`
- `GET /api/bang-suggestions`
- `GET, DELETE /api/files`
- `POST /api/files/create`
- `POST /api/files/move`
- `GET /api/files/search`
- `GET, POST /api/files/content`
- `POST /api/files/open-default`
- `POST /api/attachments`
- `GET /api/app-runners`
- `POST /api/app-runner`
- `POST /api/app-runner/input`
- `POST /api/app-runner/context`
- `POST /api/app-runner/stop`
- `POST /api/app-runner/clear`
- `GET, POST, DELETE /api/app-runner-config`
- `GET /api/app-runner-files`
- `GET /api/artifacts/<token>/manifest`
- `GET /api/artifacts/<token>/download`
- `GET /api/artifacts/<token>/page/<number>`

### 32.7 Git

Core Git routes include status, root, panel, commits, diffs, untracked previews, fetch, pull, branch, worktree, operation, stash, undo, reflog, submodule, tag, signing, and path-mutation routes.

Guided workflow read routes are:

- staged content
- generated message
- default commit message
- branch name
- PR description
- initial-file status

Guided workflow mutation routes are:

- init
- README and ignore-file preparation
- initial commit
- main branch
- remote
- initial push
- add
- branch worktree
- commit
- push
- publish
- create PR
- cancel

All use the `/api/git-workflow/` prefix.

### 32.8 Summaries, Intercom, and subagents

- `GET, PUT /api/session-summary/preferences`
- `POST /api/session-summary/generate`
- `GET /api/intercom/conversations`
- `GET /api/subagents`
- `GET /api/subagents/output`
- `GET, POST /api/subagents/config`
- `POST /api/subagents/cancel`
- `POST /api/subagents/dismiss`

### 32.9 Optional packages and companion setup

- `GET /api/optional-features`
- `POST /api/optional-feature-install`
- `POST /api/optional-feature-install-batch`
- `POST /api/optional-feature-migration/recheck`
- `POST /api/optional-feature-migration/dismiss`
- `GET, POST /api/safety-guard/config`
- `GET, POST /api/git-workflow/preferences`
- `POST /api/git-workflow/launch-admission`
- `POST /api/git-workflow/generate`
- `GET, POST /api/workflow-policy`

### 32.10 Voice and usage

- `GET /api/features/natural-conversation`
- `GET, POST /api/conversation-mode`
- `GET /api/conversation-voices`
- `POST /api/conversation-voice`
- `POST /api/stt/transcribe`
- `POST /api/tts/speech`
- `GET /api/codex-usage`
- `GET /api/claude-usage`
- `GET, PUT /api/codex-fast-mode`

### 32.11 Network, authentication, maintenance, and downloads

- `GET /api/network`
- `GET /api/network/qr`
- `POST /api/network/open`
- `POST /api/network/close`
- `GET, POST /api/remote-auth`
- `POST /api/remote-auth/settings`
- `GET /api/auth-providers`
- `POST /api/auth-logout`
- `POST /api/restart`
- `POST /api/shutdown`
- `POST /api/update/plan`
- `POST /api/update/apply`
- `GET /api/update/transactions/<id>`
- `POST /api/update/rollback`
- `GET /api/native-download/<token>`
- `POST /api/recovery/plan`

## 33. Important bounds

| Area | Bound |
| --- | ---: |
| default JSON body | 1 MiB |
| custom-theme body | 256 KiB |
| prompt-style body | 24 MiB |
| interface-layout body | 32 KiB |
| event server history | 200 |
| browser Events rows | 120 |
| restored tabs | 256 |
| saved workspaces | 20 |
| tabs per saved workspace | 30 |
| file tree entries | 1,200 |
| file search scan | 12,000 entries |
| file search results | 200 |
| file read or write | 2 MiB |
| path suggestions | 20 |
| bang suggestions | 24 |
| fast picks | 30 |
| session selector | 200 |
| app-runner output | 1,000 lines and 240,000 characters |
| code highlighting | 50,000 characters and 2,000 lines |
| Intercom initial conversations | 32 |
| Intercom messages per conversation | 200 |
| native download token | 10 minutes |
| upload temp retention | 24 hours |
| export temp retention | 1 hour |

Bounds prevent browser or server work from growing without limit. A bounded result must report omission, truncation, or unavailable state when that fact matters to the user.

## 34. Compatibility and known limitations

- The package requires Node.js 22.19 or newer.
- Browser automation primarily covers Chromium. WebKit runs are opt-in when its system libraries are installed.
- Phone and tablet v2 shells are previews and are off by default.
- PWA installation and browser notifications vary by browser and origin security.
- Plain LAN HTTP may disable install and notifications.
- Remote PIN auth is not internet-grade authentication.
- An operating-system restart cannot resume an in-progress model request.
- App runners do not survive Web UI restart.
- Independent Pi or tmux processes are invisible unless wrapped, registered, or attached.
- Attached sessions without heartbeat evidence appear stale.
- Metadata-only agent registrations cannot provide output.
- Subagent recovery is bounded and may show aggregate omissions.
- Native `/import`, `/share`, `/changelog`, and `/quit` are unavailable in Web UI.
- Native `/login` still requires Pi TUI for OAuth and API-key entry.
- `/tree`, `/fork`, `/resume`, `/scoped-models`, `/export`, and `/hotkeys` have documented browser-specific gaps.
- Arbitrary TUI custom components, header and footer components, and autocomplete providers do not cross Pi RPC.
- The file viewer does not render SVG, PDF, video, audio, or arbitrary binary formats.
- The app-runner terminal reducer is not a full VT100 emulator.
- Syntax coloring is approximate and may misclassify unusual nested language constructs.
- Compact mode reduces display work but makes no promise about model speed or network latency.
- Append-system symlinks can point outside visible roots and can be retargeted after selection.
- Summary redaction cannot identify every semantically sensitive string in free-form prose.
- A disconnected browser can miss a one-shot Guided Git activation. It is not replayed automatically.
- Guided Git fallback can nearly double provider requests and cost.
- Web UI-local reviewer enforcement does not cover launch paths that bypass the helper.
- Downgrading to a release that predates the two-sided Control Deck can overwrite newer layout fields. Stop Web UI and back up `~/.pi/webui/settings.json` first.

## 35. Verification and acceptance

The package's `npm run check` performs syntax checks and runs the Node/static test suite. `npm test` runs the package test aggregator. `npm run test:browser` runs Playwright separately.

Feature groups have focused tests for:

- HTTP endpoint guards and real server behavior;
- RPC supervisor continuity and backpressure;
- tabs, workspaces, drafts, and layout persistence;
- desktop Control Deck placement, resizing, and visibility;
- mobile and tablet shells;
- transcript streaming, Markdown tails, syntax highlighting, and compact mode;
- files, images, search, ignored paths, and live updates;
- Git panel, worktrees, advanced operations, Guided Git, and fallback;
- tools, skills, settings, sampling, and append-system selection;
- summaries and workspace coordination;
- subagent protocols, registry, launch policy, recovery, and browser display;
- Intercom filtering and conversation display;
- optional-feature migration and installation;
- update planning, locking, execution, activation, verification, and rollback;
- voice conversation behavior;
- startup diagnostics, service-worker lifecycle, and accessibility checks.

A change to user-visible behavior is complete only when the implementation, focused tests, this specification, and the appropriate README or technical reference agree.

## 36. Authoritative source map

Use these files when resolving disagreement with this document:

| Area | Source |
| --- | --- |
| package metadata and entry points | `package.json` |
| Pi commands and startup behavior | `index.ts` |
| standalone server and route behavior | `bin/pi-webui.mjs` |
| stable runtime launcher | `bin/pi-webui-launcher.mjs` |
| detached Pi process owner | `bin/pi-webui-rpc-supervisor.mjs` |
| browser structure | `public/index.html` |
| browser behavior | `public/app.js` |
| issue wizard and optional gateway client | `public/issue-wizard-state.mjs`, `public/issue-bot-client.mjs` |
| document artifact serving and viewer | `bin/pi-webui.mjs`, `public/app.js` |
| responsive shell state | `public/mobile-shell-state.mjs` |
| streaming and Markdown scheduling | `public/stream-*.mjs`, `public/transcript-renderer.mjs` |
| syntax highlighting | `public/syntax-highlight.mjs` |
| voice loop | `public/voice-conversation.mjs` |
| PWA cache and notifications | `public/service-worker.js`, `public/manifest.webmanifest` |
| Pi-side Web UI helper | `webui-rpc-helper.mjs` |
| session summaries | `session-summary.ts`, `lib/session-summary-*.mjs` |
| optional companion catalog | `lib/optional-feature-catalog.mjs` |
| native command parity | `lib/WEBUI_TUI_NATIVE_PARITY.json` |
| trust policy | `lib/trust-boundaries.mjs` |
| layout schema | `lib/ui-layout-settings.mjs` |
| saved workspaces | `lib/webui-workspaces.mjs` |
| agent observation | `lib/agent-run-*.mjs` |
| reviewer launch policy | `lib/subagent-launch-*.mjs` |
| Git worktrees and preferences | `lib/git-worktrees.mjs`, `lib/git-workflow-preferences.mjs` |
| update transaction logic | `lib/update/` |
| current behavioral evidence | `tests/` and `tests/browser/` |

When source and this specification differ, the tested source is the current implementation. Update this file in the same change that changes the behavior.
