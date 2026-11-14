# Web UI design and architecture overhaul

Status: implementation authorized and active on 2026-11-14. Planning completed 2026-11-14. Production installation, publication and release are not authorized by this execution task.

Planning owner: parent agent. Repository baseline: `06351edae0d87829dfa8c747d31a061825568b0e`. Target package: `@firstpick/pi-package-webui`, currently `0.11.1`.

## Purpose and scope

Reduce feature crowding across the complete Web UI while preserving its core visual design. Use T3 Code as a reference for organizing work and exposing contextual controls. Preserve Pi's existing workflows and extension contracts.

The plan covers desktop, tablet and phone navigation, sessions and workspaces, conversation and composer, files and Git, runners, agent activity, settings and companion features. It also covers the frontend module boundaries, state ownership, transport integration and backend seams needed to maintain that interface as features grow.

The user approved the compact visual prototype and authorized implementation on a new worktree and branch, using parallel Sol workers and Sol reviewers with at most two review rounds per wave. Implement this plan incrementally. Publishing and changes to the running installation remain outside this task.

The selected direction is a focused workspace with Conversation, Sessions, Project, Activity and Settings. Preserve Pi's current visual system and support Classic layouts through shared controllers. Extract native modules incrementally; retain the HTTP/SSE and supervisor contracts. Ship the focused shell as an opt-in preview before changing fresh-install defaults.

## Planning process

- Three `gpt-6.1-sol` scouts at high reasoning inspected the UI, runtime architecture and local T3 Code reference independently.
- `gpt-6-astra` at high reasoning advised on architecture and design using the reference evidence and current Pi source.
- The parent wrote this plan, verified reviewer findings and made all plan corrections.
- Two independent `gpt-6.1-sol` agents at high reasoning reviewed architecture/migration and design/feature coverage.
- Fable consultation and Opus workers were requested initially. The user explicitly waived Anthropic models because they are unavailable. These slots are waived, not silently substituted.

## Constraints to preserve

1. Preserve the existing theme contract, custom theme support, backgrounds, typography, rounded panels, borders, accent treatment and transcript presentation. Reorganizing controls must not become a new visual brand.
2. Account for every existing capability and command. Each needs a discoverable destination and a migration check; moving something out of the default view must not remove it.
3. Preserve session isolation, drafts, attachments, queued work, transcript continuity, explicit approvals and the distinction between browsing a workspace and changing a session's working directory.
4. Preserve extension/custom-UI behavior, optional-companion availability, trusted-network restrictions and local-only administrative actions.
5. Migrate incrementally with explicit ownership and rollback boundaries. Do not combine a full frontend rewrite, backend rewrite and persistence migration in one cutover.
6. Keep the main conversation and composer useful on narrow screens and with the software keyboard open. Accessibility and keyboard behavior are acceptance criteria.
7. Measure crowding, workflow reachability and rendering behavior against a captured baseline before claiming an improvement.

## Evidence limits

The README's screenshots are explicitly from v0.4.8. They document visual identity but do not prove the current layout or feature inventory. The parent inspected the main-window image and the current theme contract. Current source and the scout inventory must establish the behavior at the repository baseline.

The current mobile shell has opt-in phone and tablet modes. Its route and navigation behavior must be reconciled with the overhaul, rather than creating a competing mobile navigation system.

## T3 Code reference

The Sol reference scout inspected T3 Code revision `7ff2eabf56d30af15a8ac86b0eb46013a9e910ee` at `/mnt/SSD_NVME_4TB/GitHub/Testing/t3code-v2`. That checkout has uncommitted changes, including the contextual-panel implementation. These observations describe its working tree, not a verified release or the running application.

| Observed pattern | Application to this plan | Reference in the T3 checkout |
| --- | --- | --- |
| Navigation and settings replace each other in the sidebar region | Give configuration a dedicated destination instead of adding it to the conversation controls | `apps/web/src/components/AppSidebarLayout.tsx` |
| Thread lists combine project scope and bounded activity collections | Reuse Pi's tab groups and session statuses; avoid inventing a second project hierarchy | `apps/web/src/components/Sidebar.tsx`, `sidebar/SidebarThreadHeader.tsx` |
| Thread-scoped panel descriptors are separate from feature resources | One contextual inspector can show files, changes or activity without owning those resources | `apps/web/src/rightPanelStore.ts`, `components/RightPanelTabs.tsx` |
| Composer controls adapt to measured available width | Keep immediate actions visible and offer named overflow actions on smaller screens | `apps/web/src/components/chat/ChatComposer.tsx`, `CompactComposerControlsMenu.tsx` |
| Settings search knows category, anchor, aliases and availability | Search should navigate to the actual setting and preserve its scope | `apps/web/src/components/settings/settingsSearch.ts`, `settingsScope.ts` |
| Sidebar and contextual panels become sheets on narrow screens | Adapt the same feature destinations to Pi's existing phone/tablet shell | `apps/web/src/components/ui/sidebar.tsx`, `RightPanelSheet.tsx` |
| Lightweight shell state is separate from detailed conversation state | Stream updates should not rerender unrelated navigation and configuration | `packages/client-runtime/src/state/threadShell.ts`, `threadDetail.ts` |

Borrow these responsibilities and interaction patterns. Do not adopt T3's styling, Electron-only features, multi-environment configuration, event-sourced backend or dependencies merely to reorganize Pi. Its large `ChatView`, `ChatComposer` and `Sidebar` components are not module-size targets. No measured usability or performance benefit is claimed from source inspection alone.

## Current architecture and constraints

The runtime scout found two major coordination points. The browser's `public/app.js` integrates feature rendering and interaction; `bin/pi-webui.mjs` combines HTTP routing, tabs, Pi process ownership, SSE, files, Git, runners and administration. The server file is 18,402 lines at the baseline. Its `createTabRecord()` and `attachRpcToTab()` connect many otherwise distinct domains. Line counts locate risk; they are not acceptance targets.

The UI scout counted 51,757 lines in `app.js`, 19,763 CSS lines, 29 static dialogs and two dynamic dialog families. Twelve expandable deck sections and five Common Options categories overlap with footer, composer and palette actions. The main problem is mixed responsibilities and repeated entry points, not just the number of controls. Useful shortcuts stay; their handlers and state owners become shared.

Existing boundaries are worth keeping:

- Browser commands use HTTP and output uses tab-scoped SSE. SSE already implements bounded buffering, backpressure and slow-client eviction. Replacing it with WebSockets is not part of this overhaul.
- Direct and supervised Pi processes share a process interface. Supervisor protocol 1.3 validates scope, epoch and sequence; gaps trigger authoritative refresh. HTTP restart and explicit shutdown have different child-process consequences.
- Settings writes already use a bounded cross-process lock and private atomic replacement. Layout schema v3 supports migration, stable IDs, `null` defaults, explicit empty selections and optimistic revisions. The parent checked these rules in `lib/ui-layout-settings.mjs`, `saveInterfacePreferences()` and `mergeWebuiSettings()`.
- Extension status, widgets and blocking requests are tab-scoped and replay after reconnect. Responses carry the originating tab and request identity. Arbitrary extension JavaScript and arbitrary TUI components are not supported and are not introduced by the redesign.
- `lib/optional-feature-catalog.mjs` already defines companion package identity and minimum ranges. The UI must consume that catalog rather than duplicate it in a new feature registry.
- The operation-specific guards in `lib/trust-boundaries.mjs` remain authoritative. Remote PIN admission, socket-address localhost checks, confirmations and filesystem containment must survive route extraction. Remote access is not universally read-only.
- Native updates have their own plan/apply transaction and cannot be treated as a reversible shell preference. UI rollback must not invoke deprecated update rollback endpoints or change supervisor ownership.

The generic settings implementation currently lives in `lib/git-workflow-preferences.mjs`. Extracting that storage responsibility is useful, but changing its path, schema and locking behavior in the same move would create unnecessary migration risk.

## Information architecture

The parent selected these choices after the Astra consultation and corrected them against the two independent Sol reviews.

Use five semantic destinations throughout: Conversation, Sessions, Project, Activity and Settings. Phone keeps the existing label Chat for Conversation. Desktop regions are presentations of these destinations, not additional feature hierarchies.

### Desktop workspace

Give the existing regions four jobs:

1. Session navigation identifies the workspace and session. Grouped sessions, search, new/resume actions and working/attention indicators live here. Default to the left session list for fresh installs after rollout. Preserve top-tab and left-list preferences as alternate presentations of the same session model, without rendering two persistent rosters.
2. Conversation contains transcript, composer and immediate execution controls. Model, effort, attach, send, follow-up/steering mode and stop remain close to the prompt. Scope is visible when a control affects a session rather than a global default.
3. Context inspector contains one selected tool view, with lightweight tabs for open files, changes, runners and activity. Opening an inspector view must not change the session's working directory, selected model or process state. Closing it hides the view and leaves resources with their owners.
4. Settings is a dedicated, searchable destination with categories. It replaces the central content temporarily and keeps a return-to-conversation action and active-work indicator. Opening settings does not recreate the conversation, transport or session.

When the active session is running or voice is engaged, every destination exposes a session-labeled run-control strip with Abort and End conversation as applicable. Preserve the existing abort-hold behavior and authoritative voice shutdown action. These controls must be reachable in the active focus scope, including a full-height inspector or modal mobile surface whose background is inert. Opening Settings must not leave a recording microphone controllable only through hidden composer content. Steer/follow-up can use a single labeled Return to conversation action that restores the draft; Abort/End do not require that detour.

The workspace dashboard remains an explicit Home destination for orientation and session startup. It should not duplicate every setting or become another required step before chatting.

Use one compact session-context strip for workspace, branch, model/effort and important runtime state. Retain configurable footer details for users who want them. The default must not show the same model picker, queue list and Git summary in several expanded regions.

The existing two-sided Control Deck becomes a supported Classic layout. Its section order, side assignment, visibility and widths remain stored intact. New users receive the focused layout only after parity gates pass. Existing users retain Classic until they choose the focused layout. Both layouts invoke the same feature controllers and canonical view instances. Removing Classic would require a separate deprecation decision.

Preserve explicit split conversations independently of the inspector. On constrained widths, suspend the secondary presentation without closing its Pi session or discarding its arrangement. The embed/split URL behavior remains compatible. Opening Project or Activity must not replace the second conversation silently.

### Phone and tablet

Keep the existing Chat, Sessions, Activity and Project route vocabulary. Settings opens from a stable More entry and command search. Context inspectors become full-height sheets or route content according to available width, with the same feature state and action IDs as desktop.

Preserve the current viewport classifier initially: phone at 720px or below, with its compact landscape exception; tablet through 1050px. Do not import T3's breakpoints without measurement. When space is constrained, collapse optional regions before squeezing the composer below usable width. Reflow must not close an unsaved editor or reset a draft.

Back closes the foremost transient surface, then returns to the prior destination. It must not accidentally close a session or abort a run. Deep links retain their versioned target and tab/run/blocker identity. An unavailable target explains why it cannot be opened and offers a safe return; it never silently targets another session.

### Layout-mode precedence

Name the new preference **Desktop layout**, with Focused and Classic choices. Do not create a third universal switch that competes with phone and tablet opt-ins. Its versioned browser record stores `desktopLayout`, not a global mobile mode. Phone and tablet keep their existing independent URL/stored/default resolution. W3 adapts the v2 hosts to the shared navigation/controller model; it does not silently turn v2 on.

| Condition, in precedence order | Effective presentation | Persistence effect |
| --- | --- | --- |
| Explicit recovery URL `shell=classic` on any viewport | Desktop Classic or compact legacy shell, bypassing focused/v2 initialization | Temporary override only; no preference writes |
| Phone viewport without recovery override | Existing phone resolver: `mobileShell=legacy` or `v2`, then stored phone preference, then existing default | Ignore tablet and Desktop layout choices; preserve phone key |
| Tablet viewport without recovery override | Existing tablet resolver: `tabletShell=legacy` or `v2`, then stored tablet preference, then existing default | Ignore phone and Desktop layout choices; preserve tablet key |
| Desktop without recovery override | Valid explicit Desktop layout preference; an absent record uses the server cohort default below; invalid/unreadable storage uses Classic | Ignore compact-mode keys; save only deliberate desktop changes |

Phone/tablet `preview` storage values continue to enable v2 according to the existing resolver. Resize and rotation recompute only the presentation selected by this table, never mutate any mode preference, and transfer canonical views through the same host coordinator. Preserve the logical destination when supported; otherwise show Conversation with a return target while retaining dirty buffers and session state. Turning off one compact opt-in does not disable the other. Removing the recovery override restores each prior mode. Test every table row, conflicting URL values and desktop/phone/tablet crossings with drafts and an open inspector.

### Progressive disclosure

The default conversation keeps immediate actions visible. Infrequent operations move to labeled menus, the inspector or Settings. The command palette remains a parallel access path, not the sole way to discover a feature.

Keep blocking approvals and critical connection errors visible even when their feature is collapsed or hidden. Summarize routine activity and allow expansion. Do not copy the reference's activity-first banner ordering if it hides a required response.

### Compact design refinement — 2026-11-14

The user requested a bolder, more compact and minimal design after viewing the first mock. The revised [interactive prototype](../../dev/mockups/pi-webui-focused/README.md) and its [design record](../../dev/mockups/pi-webui-focused/DESIGN.md) establish this direction for the focused shell:

- A narrow activity rail, collapsible session list, single-line header, and compact composer. Flatten secondary cards and collapse completed tool history; preserve Pi's visual tokens and message identity.
- All tools is a visible, categorized launcher, with intent search, keyboard navigation, and user-pinned shortcuts. The same action definitions feed contextual menus and the catalog. No feature may be reachable only by knowing its command or shortcut.
- Session, message, project, and composer menus expose actions for that object. One inspector hosts the selected tool. Critical decisions and session-labeled run/voice stop controls remain reachable in every active focus scope, including the launcher.
- The focused phone prototype labels its More entry **All tools**. This remains a launcher for the existing destinations, including Settings; it does not add another navigation hierarchy. Existing mobile-mode precedence and legacy compatibility remain unchanged.

The additional references are [Zed command search](https://zed.dev/docs/command-palette), [VS Code's configurable regions](https://code.visualstudio.com/docs/configure/custom-layout), and [Linear's contextual menus](https://linear.app/now/invisible-details). Borrow their access patterns, retaining Pi's colors, typography, gradients and components.

The prototype has 45 catalog entries covering the capability families below. Many entries demonstrate placement and selection only; they are not implemented production features. At 1440px its header is 32% shorter and composer 25% shorter than the previous mock. These measurements supplement, rather than satisfy, the W0/W7 production crowding and feature-parity gates. Prototype dimensions and breakpoints are exploratory, not replacements for the production viewport contract.

This refinement follows the user's direction and was checked through rendered screenshots and browser interactions. The earlier Sol reviews covered the plan before this refinement; no new independent review is claimed. Classic retention, canonical state ownership, rollout cohort, migration contracts and the complete feature-preservation map remain required.

### Feature destination map

This map incorporates the UI scout's inventory and the design review corrections. A destination is the primary home; existing commands and keyboard shortcuts continue to invoke the same behavior.

| Capability | Primary destination | Immediate access and preservation |
| --- | --- | --- |
| New, close, resume and switch sessions; tab groups; saved workspaces | Session navigation and Home | Preserve top/left presentation, drafts per tab, close confirmations and restore behavior |
| New session within a tab, rename, clone, fork, tree, export and summary | Conversation session menu and Session details | Keep tab identity distinct from the durable Pi session it hosts; preserve inline message actions |
| Split conversations | Conversation layout action | Preserve independent session ownership, embed links and return on sufficient width |
| CWD picker, recent/saved directories, create directory, branch worktrees | Session context and Project | Browsing files must not implicitly change CWD; show target before mutation |
| Transcript, thinking, tools, Markdown, code, images and search | Conversation | Keep output modes, follow/history scroll and context-sensitive find |
| Mobile Essential/Detailed presentation | More: Presentation and Settings: Appearance | Retain the existing browser-local preference; this changes process chrome, never transcript content or server `compact-v1` output processing |
| Prompt editor, uploads, paste, text attachments, slash/path/bash suggestions | Composer | Preserve attachment lifetime, queue intent and suggestion-versus-send precedence |
| Model, effort, speed, plan/operating mode and per-session sampling | Composer/context controls and Session inspector | Keep effective value visible; persistent defaults belong in Settings |
| Steering, follow-ups, bash queue and prompt lists | Activity inspector | Compact pending-count access beside composer; same queues and ownership |
| Todo/workflow progress, subagent runs, launch/cancel/details, relationships | Activity inspector | Session attention counts and exact-item navigation; policy setup in Settings |
| Intercom conversations and `/btw` | Activity inspector plus compact conversation entry | Keep separate read-only agent messages and side-question semantics |
| Files, search, text editing, Markdown/image preview, file actions | Project inspector | Preserve dirty buffers, filesystem bounds, ignored-file visibility and remote restrictions |
| File selection annotations sent to Pi, attachment text editor and image lightbox | File/attachment context actions | Preserve selected text, originating tab, attachment-versus-project-file distinction and unsaved edits |
| Document artifact cards and page viewer | Conversation card opens Artifact inspector | Keep thumbnails, page/zoom/download, semantic structure, revisions/warnings/diff and search; do not collapse this into the ordinary Files viewer |
| Git status, branches, worktrees, diff, stage, commit, push and PR | Changes inspector | Guided workflow stays coherent with explicit confirmation and originating-session scope |
| Stash, undo/amend/reflog, worktree health/remove/prune, submodules, annotated tags and signing diagnostics | Project: Git tools | Keep a searchable labeled tool catalog and existing guards; destructive utilities never become implicit toolbar actions |
| App runners, detected/custom tasks, output and stop | Project/Runners inspector | Hiding output must not stop a process; explicit stop remains discoverable |
| Context, tokens, cost, cache, usage and stats | Compact status plus Usage inspector | Keep provider-account/source labels; detailed reports load on request |
| Compact now and automatic compaction on/off | Conversation: Session details → Context, with context-meter shortcut | Preserve active-tab scope, in-flight/busy state, existing manual-compaction flow and queued-prompt recovery; Usage remains informational |
| Tools, skills, scoped models, append-system prompt, resource profiles | Settings: Models and resources | Keep Session/Global/Model scopes, applicability and reload consequences explicit |
| Theme selection/editor/backgrounds, panel layout, control visibility, shortcuts | Settings: Appearance and interface | Preserve token contract, custom themes and saved layouts |
| Optional packages, feature enable/disable/setup | Settings: Features | Setup remains possible while disabled; availability derives from existing catalog |
| npm/AUR release execution and progress | Project: Git/Release and Activity | Keep project scope, release review/confirmation and extension ownership; persistent setup stays in Settings |
| Provider sign-in/out and authentication state | Settings: Accounts | Preserve local-only operations and avoid exposing credential material |
| Voice and natural conversation | Composer controls plus Settings: Voice | Preserve microphone state, transport and existing companion limitations |
| Network access, PIN controls and remote status | Settings: Connection | Show remote/local status globally; keep administration guarded server-side |
| Pi/WebUI updates, restart, shutdown and recovery | Settings: System | Running update/recovery status remains visible across navigation and reconnect |
| Events, errors, diagnostics and issue reporting | Activity: Events and Settings: Help | Notices link to retained details; redact support data and preserve issue wizard behavior |
| Extension notifications, status, widgets, blocking dialogs, custom messages | Semantic host in conversation/activity | Keep request identity, response, timeout and reconnect semantics; never make approvals optional |
| Native questionnaires, Other answers, edit/retry, per-action feedback and LEARNING creation | Conversation and its response dialogs | Preserve input and feedback association, explicit submission and retry semantics |
| Workflow Mode, minimized inspector, subprocess widgets, classifier details and gates | Conversation mode/status entry and Activity | Keep exact pending gate/model-exception target and originating run; controls obey existing capabilities |
| Read-only subagent terminal projections, retained runs, Auto-Clear/detach and cancellation | Activity: Agents | Closing/detaching a projection is distinct from cancelling the real agent; preserve telemetry and external-agent identity |
| PWA install education, notification targets, offline/restarting/boot-failure recovery | Settings: Help/System with global recovery affordances | Preserve direct notification navigation, offline limits and accessible retry/Classic startup escape |
| Release notes, sponsorship and help | Settings: About and Help | Maintain visible Help access outside Settings and preserve existing destinations |

Use the existing catalog's twenty companion identities as a reconciliation checklist: shell completion/shell choice, BTW, Guided Git, npm/AUR release, manual review, workflows, classification, safety, skills/tools, todo, remote, questionnaires, voice, footer, stats, speed and themes. This is a family summary, not a replacement package registry. Installation, enablement, capability availability, hidden-by-preference and failure are separate states. Include a stable Show hidden controls/Reset visibility action in Settings and the palette; hiding a control must not make recovery undiscoverable.

## Module and state boundaries

Keep native browser ES modules and the existing Node server. A framework rewrite would mix presentation migration with renderer, build and deployment changes before the new information architecture has proved itself. A later framework decision requires evidence that focused modules cannot meet the contract.

The server currently serves only safe flat public asset names. Initial extraction therefore uses flat `.mjs` filenames with domain prefixes. The names below are proposed module families, not existing files. Nested public directories require a separate tested static-serving change and are not a prerequisite.

| Owner | Responsibility | Must not own |
| --- | --- | --- |
| `public/shell-*.mjs` | Navigation, layout regions, inspector descriptors, transient surfaces, focus and viewport adaptation | Pi process lifecycle, feature data or settings policy |
| `public/session-*.mjs` | Tab/session identity and activation generations, drafts/attachments, queue projections, session summaries and live output coordination | Global layout, direct DOM access from transport callbacks |
| `public/<domain>-controller.mjs` and `public/<domain>-view.mjs` | Views/controllers for files, changes, runners, activity, settings and resources | Other features' private state or a second global event stream |
| `public/platform-*.mjs` | HTTP/SSE adapter, correlated requests, storage adapters and normalized errors | Layout choices or authorization decisions |
| `public/ui-*.mjs` | Existing visual primitives, theme binding, accessible menus/dialogs, resize behavior | Domain requests and persistence |
| `lib/server/` | Composition, route adapters and coherent domain services extracted from the server entrypoint | Browser view state |

Dependency direction is composition to shell/features, then domain services and platform interfaces. Shared UI primitives do not import feature modules. Transport publishes tab-keyed normalized events to session/domain owners; views subscribe to narrow projections. Features request navigation through a shell interface rather than querying another region's DOM.

Use explicit lifecycle contracts for feature views: mount into one host, update from owned state, suspend when hidden where appropriate, and dispose view listeners/observers. Resource shutdown is a separate domain action. During migration a legacy adapter may call existing functions, but each moved capability has one controller and one mutable owner at a time.

The action registry is bounded metadata: stable ID, label/aliases, destination, scope, availability reason and handler reference. Reuse package IDs and existing native command definitions. It powers palette/menu/settings discovery without implementing permissions, inventing a plugin execution system or bypassing confirmation. Dynamic model/skill/session data stays in its domain store. Native/slash commands come from the selected tab's catalog. Invocation revalidates target and scope rather than trusting the state when a menu was opened.

Shell state holds only the selected destination, region visibility, panel descriptors and focus-return targets. Session state holds per-tab drafts, attachments and transcript/queue projections. Server state stays authoritative for process lifecycle, persistence, requests, approvals and package operations. Resource views hold temporary filters, selection and scroll. Persist only intentionally durable preferences; do not write stream tokens, secrets or transient focus state to settings.

Every asynchronous operation captures its target tab/resource identity and request generation. Switching tabs must not redirect its completion. Refreshes discard stale results; mutations use existing server correlation and revision checks. Reconnect reconciliation remains in the transport/session owner, never in a panel's mount hook.

Retain `tabId` as the runtime address, and retain session identity and activation generation where an operation actually replaces the session hosted by that tab. New session operates within the current tab. Resume creates a new terminal tab through `resumeSessionInNewTab()` and selects the returned tab; it preserves the source tab, its Pi process and its draft/resources. Fork also returns a new tab; retain each operation's existing identity semantics rather than generalizing them into an in-place switch. An inspector descriptor is not the resource itself. File buffers, Git reviews and runner resources stay in feature controllers through view changes.

One navigation adapter owns history writes. Push deliberate destination/session changes; replace startup normalization and unavailable-target recovery. Resize, polling and setting edits do not create history entries. Preserve `tab`, `mobileRoute`, `run`, `blocker` and split-embed compatibility parsing. URLs contain identifiers only, never draft text, attachment contents, credentials or approval state. Dirty-editor protection precedes navigation that would discard a buffer.

Every module extraction updates service-worker precaching and package asset checks in the same change. Test online refresh, offline fallback, an already-open page during an update and old/new asset combinations. A failed optional module shows a recoverable local error without blanking conversation or silently losing user input.

### Styles, markup and dialogs

Separate CSS responsibilities while preserving computed appearance. Keep theme variables and their semantics canonical; extract foundations, shell layout, shared controls and feature styles into flat stylesheets only when loading order is explicit and tested. Preserve light-theme adjustments, reduced-motion and forced-colors overrides. Scope feature selectors to their host; avoid a new global specificity contest. Do not rename the 51 required theme tokens or replace the existing color/typography/radius system.

The initial HTML remains a stable shell and host map. Extract dialog content by feature only after ownership, accessible name, return focus and cancellation behavior are tested. A shared surface coordinator orders dialogs/sheets and focus, but the feature owns values, validation and request correlation. Existing native dialogs and dynamic questionnaire/artifact families must all be inventoried. Dialog dismissal never means approval, cancellation of a job or discarding a dirty buffer by implication.

### Backend extraction

Extract behavior behind existing routes, in this order: generic settings storage, workspace/files, Git/worktrees, app runners, companion adapters, then lifecycle/event coordination. Keep updates and supervisor code behind their current tested boundaries; move routing glue only when needed. Preserve direct and supervised process modes, slow-client handling, replay order, shutdown distinctions and helper resource precedence.

Keep compatibility exports when moving settings storage out of `git-workflow-preferences.mjs`. Preserve storage locations and lock/atomic-write behavior. Route extraction must preserve guard ordering before handlers. Characterize helper hooks into upstream Pi separately; UI reorganization does not authorize changing those hooks.

Avoid a generalized event bus, new database, event sourcing, plugin framework or service split. The objective is clear ownership within the existing package.

## Migration and rollback contract

Keep layout selection, view ownership and process/version recovery separate. A reversible layout choice must not imply a reversible native update.

### Preview storage

Introduce an explicitly versioned browser preference record for the focused desktop preview, scoped to the current server origin. Store only Desktop layout, inspector presentation and other new layout preferences there. Keep the current server `uiLayout` v3 record, its existing browser fallback keys and the independent compact-mode keys untouched. Classic continues to use its settings.

The preview record is best-effort. Invalid or unavailable browser storage falls back to Classic without erasing the record or blocking chat. Export/reset controls identify which layout they affect. Do not imply preview preferences synchronize across devices.

Durable synchronization of focused-shell preferences is deliberately outside the first cutover. It is not required to remove crowding. If later added, it needs a separately specified schema version, revision/conflict rules, mixed-client behavior and backup/recovery tests. This avoids silently feeding unknown fields into the strict v3 layout validator.

### Fresh-install defaults

During preview, an absent desktop preference always means Classic. W7 may enable the fresh-install focused default only after implementing a server-owned cohort marker. Browser-storage absence and normalized default layout are never evidence of a fresh installation.

Define a fresh cohort as a new WebUI state root initialized by the rollout release, not a new browser or a claim about the person's history. Before settings migration/default initialization, the server must successfully establish that it created a previously absent WebUI state root and that no legacy settings/migration source or configured pre-existing settings file exists. Pre-existing roots, even empty ones, migrated settings, unreadable/ambiguous evidence and older servers are established/unknown and default to Classic. Never classify an absent `settings.json` alone as fresh.

Persist a versioned `shellRollout` marker with `fresh` or `established` cohort through the existing locked atomic settings writer, outside `uiLayout`, and return only the validated cohort as additive interface-preferences response metadata. Initialization must serialize the absence check, root creation and marker write so concurrent starts cannot disagree. Markers are initialization evidence, not synchronized layout preferences. Never replace a valid existing marker; invalid/future markers yield Classic without being overwritten. If initialization cannot safely prove/persist freshness, use Classic. Introduce this metadata as a separately tested W7 change, with settings normalization and schema handling specified there; W6 extractions retain existing response contracts.

Precedence on desktop is recovery override, then a valid explicit browser choice. If the browser record is absent, use the validated server cohort default or Classic. Invalid/unreadable browser storage is a recovery condition and uses Classic directly. Clearing storage or changing origin on an established installation stays Classic. On a marked fresh installation an absent record returns to that cohort's default; this browser-local behavior must be documented. Existing installations can always select Focused explicitly. Older clients ignore additive metadata, and clients talking to older servers fall back to Classic. Tests cover migrated/empty/missing state, new browsers, cleared storage, alternate origins, concurrent initialization, invalid markers and failed writes. If the marker gate is not ready, keep Focused opt-in for everyone; do not claim the fresh-default rollout is complete.

### Canonical view ownership

Only one layout owns a feature's canonical DOM view at a time. Switching Classic/focused or desktop/mobile moves that view through an explicit host adapter, captures focus/selection/scroll, then restores them. Do not clone IDs, event handlers, editors or live widgets. Controls that are intentionally represented in several places invoke the same controller and derive state from one owner.

The parent integration owner maintains a migration ledger per capability: legacy location, new controller, view host, event sources, persisted keys, tests and whether the legacy path is still active. Removing a legacy handler requires proof that no shell or companion still calls it.

### Rollback levels

| Trigger | Recovery | State preserved |
| --- | --- | --- |
| Focused layout usability or view error | Select Classic; provide a startup escape hatch that bypasses focused initialization | Legacy layout, sessions, drafts, attachments and feature resources |
| Optional inspector/view fails to load | Show failure and retry/close actions; keep conversation operational | Feature-owned buffers/jobs; no implicit retries of mutations |
| New client/module deployment mismatch | Offer controlled reload with dirty-work protection; validate coherent online/offline asset behavior | Durable sessions and recoverable local drafts; never promise in-memory attachments survive a full reload without testing |
| Preference conflict | Refresh current revision and explain conflict; merge only intended fields after revalidation | Other clients' layout edits and unknown IDs |
| Server extraction regression | Revert that isolated source change after stopping its test/runtime instance appropriately | Existing disk schema and protocol, because extraction did not migrate them |
| Binary downgrade or supervisor mode change | Follow documented explicit shutdown and settings-backup procedure | No automatic update rollback is claimed |

## Implementation waves

This plan is now executing. No production wave has yet been completed. Waves are ordered; overlapping development is permitted only after their interfaces are fixed and ownership is isolated. One writer owns a shared checkout. Every worker receives the relevant wave contract, forbidden paths, prerequisites, checks and a unique handoff path. Workers do not rewrite this plan or expand scope.

| Wave | Prerequisite and bounded work | Deliverable and completion gate |
| --- | --- | --- |
| W0: baseline and contracts | Revalidate this plan against the execution revision. Inventory every current control, command, dialog, menu, optional feature and persisted key. Capture Classic/focused-relevant visual fixtures and measure current workflows. | Capability ledger with stable IDs and source anchors; visual token inventory; baseline measurements; explicit approved numerical budgets and fixture matrix. Any newly discovered capability receives a destination before W1. |
| W1: extraction foundation | W0. Extract navigation/history, action discovery, scope metadata, feature mount lifecycle and preferences adapters behind Classic. Establish CSS loading order and dialog/surface ownership. Keep public modules flat and preserve IDs. | Classic behavior unchanged; no duplicate listeners; tests for history/back, dirty views, target generations, availability and scope. Packaged assets and service worker can load all modules. |
| W2: session and conversation ownership | W1. Extract tab/session coordination, composer/drafts, transcript/stream integration, attention summary and extension request host. Reuse existing transcript and stream modules. | Safe tab switches, new-session-in-current-tab and resume-in-new-tab preserving the source; unchanged send/steer/follow-up/abort and compaction behavior; split compatibility; request identity and reconnect recovery tests. No transport churn for same-tab destination changes. |
| W3: focused shell preview | W2. Implement five destinations, sidebar/top alternatives, contextual inspector and full-area Settings host. Add Desktop layout preference and recovery escape hatch; follow the mode-precedence table when adapting mobile hosts. | Preview works at all fixture sizes; mode/viewport changes preserve user work; no duplicate session roster; critical attention and Abort/End remain operable in every focus scope; Classic retains both decks and custom order; phone/tablet opt-ins stay independent. |
| W4: Project and Activity | W3. Move files/editor/artifacts, Git/guided workflows/advanced utilities/releases, runners, queues, subagents/intercom/gates, events and usage into their assigned hosts. Keep heavy views lazy and use canonical controllers. | Every mapped action works from its new home and palette where applicable; hidden views do not terminate resources; dirty-buffer, late-response, wrong-tab, detach-versus-cancel and approval checks pass. |
| W5: Settings and companion integration | W3 and relevant W4 controllers. Organize appearance, notifications, resources, accounts, features, voice, server/remote, help and system administration. Add search with destination anchors and availability reasons. | Session/Global/Model/browser/server scopes remain explicit; disabled companions retain Setup; control hiding never hides required responses; remote/local restrictions and update reconnect behavior pass. |
| W6: backend responsibility extraction | W1 contracts and the affected frontend wave verified. Extract existing route/domain responsibilities in small sequential units, starting with settings storage, files, Git and runners. Separate helper domains only behind tested existing behavior. | Route/error/guard contracts unchanged; direct and supervised modes pass; settings lock/revision behavior and extension request replay preserved; remote companion checks pass. No new protocol, storage path or upstream helper patch behavior. |
| W7: hardening and default rollout | W2-W6 complete for all capabilities. Resolve remaining source-shape tests, verify full capability ledger, accessibility, PWA updates, visual fidelity, crowding and performance. Implement and test the conservative server cohort marker before changing defaults. | All release gates below pass. Proven fresh state roots default to focused desktop; established/unknown installations keep Classic until explicit selection. Compact opt-ins remain independent. Documentation and package/dependency checks complete. |

For each wave, the integration owner verifies combined changes and gives Sol a read-only contract-focused review. At most two review rounds per wave: the first reviews the wave; the second checks accepted fixes and resulting regressions. Record dispositions and recheck accepted fixes. User-waived Anthropic slots do not block this plan; choose available implementation workers only when implementation is authorized, rather than treating the original Opus request as permission for a substitute now.

Maintain a compact implementation contract summary after each wave. Keep this plan under `plans/planned/` until the overhaul itself is implemented and verified, then move it to the ignored `plans/archive/`. Completing the planning task does not archive an unexecuted implementation plan.

## Verification plan

Validate user journeys and preserved contracts at each wave, then evaluate the integrated shell against the frozen baseline before rollout.

### Fixture matrix and observable outcomes

Use isolated test homes, fake Pi where supported, temporary repositories and disposable update-coordination state. Never test destructive operations, remote exposure, credentials or package updates against the user's active installation.

The baseline matrix includes 360×800 and 390×844 phones; 844×390 landscape; 768×1024 and 1024×768 tablets; 1440×900 and 1920×1080 desktop; and 200% zoom. Include keyboard-open phone states, one and many tabs/groups, no optional companions and representative installed companions, top/left sessions, Classic Left/Right/Both decks, split conversations, a long transcript, a large file list and a busy multi-agent session.

Capture default Catppuccin, a light theme and a custom background/theme. Keep text, fixture events, viewport, fonts and data fixed. Compare unchanged component crops for color, typography, borders, gradients, radii and content treatment; inspect whole-page screenshots for intended layout changes. Update visual expectations only with an explanation of the intended difference. Capture and inspect actual browser output during implementation and show screenshots in the working conversation under the applicable runtime rules.

W0 records an action-count baseline for switching sessions, changing model/effort, attaching a file, finding a changed file, opening runner output, finding an approval, configuring a tool profile and changing a theme. Proposed focused-layout targets are direct send/stop, at most two deliberate actions to reach common session/project/activity controls, and at most three to reach named settings categories before editing a value. Search remains optional. A reviewer must be able to follow each path without prior knowledge of icon meanings.

Measure crowding separately from click counts. Freeze fixture states and counting rules in W0: visible secondary action controls, duplicated expanded summaries of the same state, and simultaneously expanded auxiliary content regions. Exclude transcript content, the session roster and required send/stop/attachment/model/effort/approval controls from the secondary-control count; never hide critical state to improve the score. Use the same three-session project fixture and companion availability before/after. At 1440×900, the focused default must reduce visible secondary controls by at least 30% relative to the baseline default, show no duplicate expanded model/queue/Git summary, and open at most one auxiliary inspector by default. At phone/tablet widths, secondary controls must not increase and duplicate expanded summaries must be zero. User-requested Classic/customized/split arrangements are outside the default crowding target but must retain functional parity. W7 records counts and screenshots for idle, streaming and blocked states; a pass requires both the density targets and the capability/reachability gates.

Measure first useful render, input-to-paint, tab-switch-to-content, streaming cadence and retained memory on the same machine/browser with warm and cold cases recorded separately. Compare repeated runs rather than a single timing. W0 fixes regression budgets before code changes; later waves cannot relax them simply to pass. A long transcript must preserve selection, find-in-transcript and manual scroll position while output arrives. Introduce virtualization only if these measurements require it and after those behaviors have dedicated checks.

### Checks by contract

| Contract | Existing starting coverage | Add or extend during implementation |
| --- | --- | --- |
| Layout persistence, Classic customization and width handling | `persistent-ui-layout.spec.mjs`, `control-deck-side-panels.spec.mjs`, `side-panel-section-reorder.spec.mjs`, `composer-action-grid-reorder.spec.mjs` | Preview record corruption/storage denial, shell toggle, old/new client, focus/selection and escape hatch |
| Mobile navigation and accessibility | `mobile-foundation.spec.mjs`, `controls-layout.spec.mjs` | Shared destination/history behavior, keyboard open, full-height inspectors, dirty-editor Back, zoom and attention announcements |
| Conversation continuity and output isolation | `interaction-continuity.spec.mjs`, `stream-output-isolation.spec.mjs`, `optimistic-prompt.spec.mjs`, `search-match-highlighting.spec.mjs` | Same-tab route changes during streaming, tab/session generation races, split and inspector independence |
| Resource and model scope | `resource-profiles.spec.mjs`, `model-search-focus.spec.mjs`, `sampling-tooltip.spec.mjs` | Settings search reveals actual scoped control; stale targets never broaden scope |
| Activity and extension UI | `subagent-observability.spec.mjs`, `intercom-conversation-viewer.spec.mjs`, `feature-decision-output-popup.spec.mjs` | Closed inspector retains blockers; responses target originating tab/request after navigation and reconnect |
| Project/Git | `guided-git-extension-command.spec.mjs`, `guided-git-fallback.spec.mjs`, `file-tree-git-ignored.spec.mjs` | Unsaved buffers, staged-review context, delayed Git/file responses, runner visibility versus lifetime |
| Server/update/remote | `update-reconnect.spec.mjs`, HTTP harness and supervisor Node tests, remote-webui checks | Guard ordering after extraction, old asset clients, direct/supervised mode, storage conflict/lock/crash behavior |

Existing filenames are starting points, not proof that all new behaviors are already covered. The scout found 213 top-level Node tests, including 82 static tests, and 29 browser specs. It found no screenshot-golden assertions, so W0/W7 visual baselines are new work. Selected axe checks disable `aria-required-children`; those exemptions are not an accessibility pass for new navigation. Reassess changed components, retain forced-colors/reduced-motion behavior and manually verify complete keyboard paths. Static tests that inspect function placement must move with the owner or become behavioral tests; do not drop their invariants to make an extraction pass.

Add explicit regression scenarios for all review corrections: Abort/End while Settings or an inert-background sheet is open; independent phone/tablet overrides through rotation; manual/automatic compaction with queued prompts; Essential/Detailed without any output-processing mutation; source-tab preservation on resume; cohort precedence after cleared browser storage; and the frozen crowding counts. These are mandatory checks in their owning waves, not optional exploratory tests.

From repository root, run `npm --prefix pi-package-webui run check` for integrated waves and `npm --prefix pi-package-webui run test:browser -- --project=chromium` for browser acceptance. Run `npm --prefix pi-package-remote-webui run check` when changing shared remote contracts. The package `check` command already runs its Node suite; do not immediately repeat `npm test` without a reason. Use focused browser files during development, then the full suite at W7. Run WebKit with `PI_WEBUI_TEST_WEBKIT=1` where its system libraries are available; record unsupported platforms and real-device checks separately rather than claiming emulation proves them.

### Documentation and dependency work

Update README first-use navigation and visible feature descriptions alongside changed behavior. Put complete navigation, settings scopes, Classic/focused behavior, limitations and recovery in TECHNICAL. Put module boundaries, contracts, storage migration, tests and contributor commands in DEVELOPMENT. Reconcile SPEC with the implemented contracts rather than introducing a competing specification.

No new runtime dependency is selected by this plan. Before implementation changes import new first-party exports or behavior, inspect the minimum published version and update ranges and package versions together. Check the current dependency floor for every touched consuming package, including remote-webui and affected companions. Confirm provider packages are published before dependent publication. No dependency/version changes are needed for this planning document alone.

## Related plans and decisions

| Existing record | Treatment in this overhaul |
| --- | --- |
| [Optional-feature minimal-core plan](../../docs/planned/webui/optional-features/OPTIONAL_FEATURE_MINIMAL_WEBUI_IMPLEMENTATION_PLAN.md) | Reuse its ownership goal. Do not implement its old tools/skills ownership assumptions or generic payload proposal without checking current helper and companion contracts. A new extension protocol is not a prerequisite for this shell. |
| [User-reach roadmap](../../docs/planned/webui/roadmap/WEBUI_USER_REACH_PRIORITY_IMPLEMENTATION_PLAN.md) | Use as candidate task priorities, not usage evidence. W0 measures the selected task paths. |
| [Performance plan](../../docs/planned/webui/performance/WEBUI_PERFORMANCE_UX_IMPROVEMENT_PLAN.md) and [token-speed plan](../../docs/planned/webui/performance/WEBUI_TOKEN_SPEED_IMPACT_REDUCTION_PLAN.md) | Revalidate proposals against current scheduling/backpressure implementation; avoid repeating work already shipped. |
| [Native parity plan](../../docs/planned/webui/native-parity/WEBUI_TUI_NATIVE_FEATURE_PLAN.md) | Preserve native command ownership and semantic UI support. |
| [Natural-conversation progress](../../docs/webui/natural-conversation/NATURAL_CONVERSATION_MODE_PROGRESS.md) | Carry forward documented limitations. Its historical hardware/provider checks are not current runtime proof. |

This plan governs the complete interface organization and the extraction needed to support it. It does not silently cancel older independent features, approve new providers or remove existing supported workflows.

## Consultation decisions

| Astra recommendation | Parent disposition and evidence |
| --- | --- |
| Five destinations; sidebar default with top-tab compatibility; one inspector; Classic retained | Accepted. Existing deck scope labels and saved layout contracts support separating purpose from placement. |
| Preserve split conversations and tab-versus-session identity | Accepted. `splitTabId`, embed mode and activation handling exist in `public/app.js`; these are now explicit scope items. |
| Native ES modules with flat public asset names | Accepted and verified in `normalizeStaticPath()`. Replaced the draft's proposed nested public paths with flat module families. |
| Scope-aware settings and bounded discovery registry | Accepted. Existing Controls mixes session/browser/server/network scope; palette and catalog are reuse seams. |
| Separate browser preview preferences from durable v3 layout | Accepted. Strict field/version normalization makes implicit additive server fields unsafe. Preview sync is explicitly deferred. |
| Same-tab navigation must not reconnect; tab switching may reconnect | Accepted and verified in `connectEvents()`, which closes the prior EventSource. Corrected the draft's stronger, unnecessary transport requirement. |
| Include PWA asset coherence in extraction gates | Accepted and verified in `service-worker.js` and current network-first caching. Asset loading is part of every frontend extraction. |

## Plan review record

Two independent `gpt-6.1-sol` reviews at high reasoning completed. Architecture/migration reported two medium findings; design/feature coverage reported five P2 findings and no P0/P1 findings. The parent verified all seven against source and accepted them. Corrections were written by the parent. No second review round has been requested.

The parent rechecked the corrected sections against each finding and the source contracts, including the distinction between absent and invalid preview storage. All seven planning findings are resolved in this document. The fixes have not received a second independent review; runtime verification belongs to the implementation waves.

| Finding | Disposition, verification and correction |
| --- | --- |
| A1: no discriminator for fresh versus established rollout | Accepted. `readRawWebuiSettings()` maps absent files to defaults and `interfacePreferencesResponse()` has no cohort today. Added conservative server-owned W7 marker, precedence, failure handling and cleared-storage/new-browser/origin tests. Preview remains Classic on absence. |
| A2: resume described as in-place | Accepted. `/api/switch-session` calls `resumeSessionInNewTab()`, and `openNativeResumeSelector()` selects the returned tab. Corrected identity semantics and W2; source-tab preservation is mandatory. |
| D1: Abort/End can be hidden outside Conversation | Accepted. Controls currently live under the composer and `syncMobileShellInteractivity()` makes background layout inert. Added a session-labeled, active-focus-scope run strip and streaming/microphone tests. |
| D2: focused choice conflicts with independent compact modes | Accepted. `resolveMobileShellFeatureMode()` and `resolveTabletShellFeatureMode()` resolve separate keys/overrides; the tablet browser test asserts independence. Renamed the preference Desktop layout and added an explicit precedence/resize/recovery table. |
| D3: compaction actions lack a home | Accepted. `renderContextMeterBar()` exposes Compact now and Auto on/off and calls existing handlers. Added Session details → Context, preserved shortcut/queue semantics and W2 checks. |
| D4: Essential/Detailed conflated with output processing | Accepted. `mobileRenderMore()` explicitly says this does not enable `compact-v1`. Added separate browser-local presentation row and a no-output-mutation regression check. |
| D5: crowding itself has no measurable gate | Accepted. Current composer/deck regions provide countable controls; click/performance measures alone did not prove de-crowding. Added frozen counting rules, a 30% desktop secondary-control reduction target, duplicate-summary limits and W7 evidence requirements. |

## Planning evidence and readiness

The parent checked relative document links and the existence of all twenty browser specs named in the verification table. Source counts confirm 213 Node test files, 82 static test files and 29 browser specs. Importing the pure theme contract confirms 51 required theme tokens. The plan is not ignored; `plans/archive/` is ignored as required.

These checks establish that the plan points at real contracts and checks. Product tests, live browser interactions, fresh visual baselines, performance measurements, provider/device checks and published dependency-floor validation have not run for this documentation-only task. They remain implementation gates, not unproven claims of completion.

Planning acceptance: PASS for delivery of the reviewed plan. Implementation/release readiness is not assessed. The requirement audit is:

| Requested outcome | Evidence in this plan |
| --- | --- |
| Complete Web UI design and architecture overhaul plan | Capability destination map; frontend/state/CSS/dialog/backend ownership; W0-W7 execution and verification contracts |
| Reduce crowding while preserving core visual design | Four region responsibilities, five destinations, explicit density/reachability targets and token/component visual preservation gates |
| T3 Code inspiration | Source-backed reference table with checkout revision, dirty-tree caveat and explicit adoption/rejection choices |
| Multiple Sol scouts | Three completed independent UI/runtime/T3 reconnaissance results incorporated into current constraints and coverage |
| Astra and Fable advice; Opus workers | Astra consultation completed; Fable and Opus explicitly waived by the user because Anthropic was unavailable |
| Parent-authored plan and corrections | Parent is the sole writer; consultation and review results remained advisory |
| Sol plan reviews, verified findings and fixes | Two completed Sol reviews; seven source-verified accepted findings with corrections and parent revalidation above |

Key source references for execution:

- [Current shell markup](../../pi-package-webui/public/index.html), [application coordination](../../pi-package-webui/public/app.js), [visual styles](../../pi-package-webui/public/styles.css) and [theme contract](../../pi-package-webui/public/theme-contract.mjs).
- [Mobile navigation model](../../pi-package-webui/public/mobile-shell-state.mjs), [service worker](../../pi-package-webui/public/service-worker.js), [stream scheduling](../../pi-package-webui/public/stream-render-scheduler.mjs) and [transcript renderer](../../pi-package-webui/public/transcript-renderer.mjs).
- [Server entrypoint](../../pi-package-webui/bin/pi-webui.mjs), [settings storage](../../pi-package-webui/lib/git-workflow-preferences.mjs), [layout contract](../../pi-package-webui/lib/ui-layout-settings.mjs), [trust guards](../../pi-package-webui/lib/trust-boundaries.mjs) and [companion catalog](../../pi-package-webui/lib/optional-feature-catalog.mjs).
- [Supervisor protocol](../../pi-package-webui/lib/rpc-supervisor-protocol.mjs), [RPC helper](../../pi-package-webui/webui-rpc-helper.mjs), [remote companion](../../pi-package-remote-webui/lib/remote-core.mjs), [current specification](../../pi-package-webui/SPEC.md) and [contributor guide](../../pi-package-webui/DEVELOPMENT.md).

## Acceptance criteria for the eventual implementation

These are proposed release gates, not claims that checks have already run.

- Every capability in the final inventory has a destination, an availability rule, an owner and a regression check. Installation-dependent features remain distinguishable from unavailable or failed features.
- From the default conversation view, switching sessions, changing model or effort, attaching a file, stopping a run and responding to an approval remain directly discoverable. Less frequent configuration has a named home and is searchable.
- A conversation can stream while the user opens project files, inspects Git changes or visits settings. Navigation within the active tab must not reconnect transport, restart Pi or lose the current draft. Switching tabs may recreate EventSource, as it does today; it must preserve safe replay, session isolation and continuity. Persistent connections for inactive tabs are outside scope.
- Returning from another destination restores the intended conversation, scroll position, draft and focus. Existing keyboard shortcuts retain their context and do not fire destructively inside unrelated editors or dialogs.
- A running or blocked task remains visible when its detailed view is closed. Attention indicators identify the owning session and open the exact pending item.
- Default, custom, light and dark themes retain their token semantics. Screenshots compare the same fixture content before and after migration, with expected layout changes separated from unintended color, font, contrast or component changes.
- Phone and tablet checks cover portrait, landscape, software keyboard, safe-area insets, long names, nested dialogs and return navigation. No workflow depends solely on hover, dragging or a desktop context menu.
- Accessibility checks cover keyboard navigation, focus restoration, names and states of controls, reduced motion, zoom and announcements for critical status changes without announcing every stream token.
- Reconnection, delayed responses and switching between sessions must not apply results to the wrong session or overwrite newer state. Disposing a view releases its listeners and observers without destroying session-owned state.
- Saved-layout migration is deterministic and recoverable. Reverting the shell must preserve user settings and must not require rolling back native package updates or changing durable session formats.
- Measure input responsiveness, session-switch latency, first useful render, stream-render cadence and memory with fixed fixtures and the same machine/browser. Baseline values and regression budgets are set before implementation; no performance success is inferred from smaller source files.

The current package commands are `npm run check` and `npm run test:browser`. The first already runs the Node test suite. Browser tests default to Chromium; WebKit is opt-in with `PI_WEBUI_TEST_WEBKIT=1`. The verification table distinguishes existing coverage from checks that must be added in the owning waves.


## Execution record — 2026-11-14

Integration owner: parent Astra. Branch: `feat/webui-compact-workspace`. Initial execution revision: `06351edae0d87829dfa8c747d31a061825568b0e`, matching the planning baseline. The original checkout is left unchanged. The approved mock is retained as a repository reference without its nested Git repository or hosting identity.

Classification: complex. This work crosses shell, feature, session and server boundaries, includes opt-in compatibility and rollout, and requires independently owned implementation and verification. The user selected `gpt-6.1-sol` at high effort for implementation and review. Anthropic remains waived. Two fresh-context Sol reviews can run concurrently as round 1 with complementary scopes; round 2 is limited to accepted fixes/regressions. Never exceed two rounds for a wave.

### Execution DAG and ownership

W0 inventory and browser-baseline work run independently in isolated tool-managed worktrees. The parent runs the unchanged Node baseline and establishes execution contracts. Integrate and verify all W0 evidence before W1. Subsequent waves follow the dependency table above; parallelism requires both fixed interfaces and disjoint file ownership. One writer per checkout. Parent alone changes this plan, integrates commits, records finding dispositions and owns shared wiring.

| Workstream | Write ownership | Output and gate | State |
| --- | --- | --- | --- |
| W0-A capability inventory | `pi-package-webui/scripts/overhaul-inventory.mjs`, `pi-package-webui/scripts/tests/overhaul-inventory.test.mjs`, `pi-package-webui/docs/overhaul/capability-inventory.json`, `pi-package-webui/docs/overhaul/capability-ledger.md` | Reproducible source inventory with stable anchors/IDs, all destination families, companion identities and persistence inventory; focused check passes | Integrated; review pending |
| W0-B rendered baseline | `pi-package-webui/scripts/browser/overhaul-baseline.spec.mjs`, `pi-package-webui/scripts/browser/overhaul-fixture.mjs`, `pi-package-webui/scripts/browser/overhaul-metrics.mjs`, `pi-package-webui/playwright.overhaul.config.mjs`, `pi-package-webui/docs/overhaul/browser-baseline.md`, `pi-package-webui/docs/overhaul/browser-baseline.json` | Isolated deterministic fixture, measurements/screenshots, no production state, repeatable test command and explicit omissions | Integrated; supplements and review pending |
| W0-P baseline and integration | Canonical plan, `.gitignore`, reference mock, shared execution contract and any later wiring | Unchanged Node suite result; verify artifacts and coverage; freeze interfaces before W1 | Parent active |

Worker handoffs: `handoffs/webui-overhaul-w0-a.md` and `handoffs/webui-overhaul-w0-b.md` within their isolated checkouts. Workers commit only owned source/evidence and report revision, checks, omissions and exact handoff path. No child delegation, package installation, publication, production launch or edits to the canonical plan.

### Frozen baseline comparison rules

Keep the plan's 30% desktop secondary-control reduction target and zero duplicate expanded summaries. Count only visible, enabled-in-fixture secondary controls, excluding transcript content, roster items and mandatory send/stop/attachment/model/effort/approval controls. Record counted selectors/labels and exclusions so later waves cannot change the denominator. Classify disabled/unavailable controls separately. Use idle, streaming and blocked states with the same three-session fixture.

For same-machine repeated warm/cold runs, freeze these regression budgets before changes: first useful render p95 no greater than baseline p95 plus max(10%, 50ms); input-to-paint and tab-switch-to-content p95 no greater than baseline p95 plus max(10%, 16ms); stream-render gap p95 no greater than baseline p95 plus max(10%, 16ms), with no dropped final output; retained browser heap after fixed navigation cycles no greater than baseline plus max(15%, 10MiB). Report unsupported metrics as missing evidence, never as a pass. Record runtime/browser, fixture, run count and raw samples. These numerical budgets are the integration owner's implementation choices within the approved measurement contract.

The parent validates actual browser measurements and coverage before accepting W0. Later implementation may not relax budgets merely to pass. At each wave record completed contracts, changed owners, test evidence, review round/dispositions and outstanding limitations here; new workers read the current compact contract summary rather than all prior handoffs.

### Current contract summary

W0 is accepted after two review rounds and parent verification of all three accepted fixes. Source inventory, 105 baseline screenshots, corrected input samples and frozen budgets are retained. Known product defects and platform/fixture limitations remain assigned to W2/W3/W7. W1 extraction is now active with three isolated Sol writers and parent-owned shared wiring. Classic remains the current presentation; no focused-shell product acceptance is claimed. The complete overhaul remains incomplete.


### W0 baseline check and BUG-001

| Bug | Severity | Module | Status | Summary |
| --- | --- | --- | --- | --- |
| BUG-001 | Minor | Optional-feature static check | FIXED | Stale exact companion-version assertion failed on unchanged source |

**Spec reference:** W0 reproducible baseline; no production behavior change.
**Found during:** `npm --prefix pi-package-webui run check` on the integration worktree, Node v22.23.5, Linux. Full output: `/tmp/webui-overhaul-w0-node-check.log`.

Reproduction: on source revision `06351edae0d87829dfa8c747d31a061825568b0e`, run `node pi-package-webui/tests/feature-system-prompt-optional-feature-static.test.mjs`. Reproduced in both the new worktree and original checkout without changing the original. Expected: package identity/version assertion agrees with the checked-in companion manifest. Actual: `AssertionError: '0.1.7' !== '0.1.6'`, line 12. The companion manifest was already bumped to 0.1.7; the test retained its previous exact version.

Parent accepted this as a pre-existing test-maintenance defect and updated only the expected literal to 0.1.7. All integration, enablement, availability and catalog assertions remain unchanged. The focused test now exits 0; `git diff --check` exits 0. The full unchanged baseline ran all 213 files: 212 passed, this one failed. A redundant full rerun is deferred to the next integrated wave because the only fix changes that test's version literal. This is not described as an all-green full-suite run. No production code has changed.


### W0-A integration

Integrated worker commit `1920dec89a332ea1752f37a08b5113cedb8721e7` after inspecting its four-file diff, scanner, tests, ledger and handoff. The scanner inventories 1,269 source candidates across all 34 planned capability families, 29 static dialogs, 20 canonical companions and 15 dynamic families. These lexical counts do not establish runtime parity or the crowding denominator. Existing unsupported/degraded native surfaces remain explicitly classified; the overhaul does not invent support for them.

Parent integration correction: moved the inventory test from the npm-shipped top-level `tests/` directory to `scripts/tests/overhaul-inventory.test.mjs`, updating its imports/root and documented command. The test requires repository-only scanner/docs/plan files omitted by npm packaging; keeping it in the published application suite would introduce an unavailable import. All assertions remain. This is a verified packaging-boundary issue, not a reason to broaden the runtime package payload.

The JSON intentionally hashes the current canonical plan; regenerate after plan/source changes and inspect classifications. The source scanner remains evidence tooling, not the runtime action registry. W0-B measurements and integrated review are still pending. No production application code has changed.

Parent W0-A verification: all 10 relocated inventory tests passed; regeneration/check mode and whitespace checks passed. `npm pack --dry-run --json` confirmed repository-only inventory tooling is excluded from the package. No runtime or dependency change was needed.


### W0-B integration and remaining baseline work

Integrated `eb84cd3867d91ffc40c9d7020b6831c345dc34a2`. The parent inspected the six-file diff, source-isolated fixture, metrics, raw-data definitions and representative desktop/tablet screenshots. The accepted 42 screenshots were copied into the integration checkout's ignored `pi-package-webui/test-results/overhaul-baseline/run-2026-11-14T20-17-31-610Z/`. Original performance samples and reference JSON remain unchanged.

Parent fixes: keep repository-only baseline modules under `scripts/browser/` and point the dedicated config there, excluding them from ordinary discovery/npm packaging; clear inherited `PI_*`/`FAKE_PI_*` state overrides before the fixture sets its own temporary configuration. Neither changes production source.

BUG-002: pre-existing tablet-v2 clipping at 768×1024. The layout begins at x=112 but remains 768px wide; the attachment control at x=823–863 is clipped. Parent screenshot inspection confirms content leaves the viewport. Major severity; assign to W3 layout owner. Legacy tablet remains available. Original source remains unchanged for baseline captures. Document-overflow=0 must not be treated as proof that mandatory controls fit.

W0 still lacks representative companion-enabled/resource/model paths, long transcript/large file observations, split/left/right/both arrangements, and keyboard-constrained/zoom layout evidence. Supplement those against unchanged source before accepting W0. Real-device behavior remains a W7 verification limitation rather than something Chromium emulation can prove. No complete W0 acceptance is claimed.


### Supplemental W0 ownership

The parent extends the isolated fixture with `startFixture(request, {fakePi, settings})`: `settings` is serialized only to the temporary fixture file; `fakePi` permits only string-valued `FAKE_PI_TRANSCRIPT_JSON`, `FAKE_PI_GUIDED_GIT_ACTIVATION`, `FAKE_PI_STATS_PROMPT_CONTEXT`, and `FAKE_PI_INTERCOM_LIVE`. All other inherited Pi/fixture overrides remain removed. Existing call sites are unchanged.

Two dependency-independent Sol workers may now run against this integrated fixture in isolated checkouts. W0-C owns only `scripts/browser/overhaul-layout-baseline.spec.mjs`, `playwright.overhaul-layout.config.mjs`, `docs/overhaul/layout-baseline.md` and `docs/overhaul/layout-baseline.json`. It captures Classic variants/split and zoom/keyboard-constrained layout. W0-D owns only `scripts/browser/overhaul-capability-baseline.spec.mjs`, `playwright.overhaul-capability.config.mjs`, `docs/overhaul/capability-browser-baseline.md` and `docs/overhaul/capability-browser-baseline.json`. It captures populated companion/model/resource paths and long transcript/file behavior. Both use the current fixture unchanged, write screenshots under ignored `test-results/overhaul-baseline/`, preserve the frozen reference/budgets, and stop on an interface change outside this boundary. Unique handoffs are `handoffs/webui-overhaul-w0-c.md` and `handoffs/webui-overhaul-w0-d.md`.

Production source remains at the original baseline. Real OS keyboard and native-device checks are not implied by viewport simulations. These workers add missing evidence; they do not fix product defects or weaken release gates. Integrated W0 review begins after their evidence is inspected and combined.

### W1 extraction contracts

W1 starts only after the combined W0 evidence passes review. Its output must be used by the existing application before acceptance. Adding unused modules is not an extraction. The parent owns shared wiring in `app.js`, service-worker assets, package checks, existing static-test updates, contributor documentation and the capability ledger. Workers own the following disjoint new files and their corresponding tests. No worker changes the server, durable layout schema, theme tokens or transport.

| Workstream | New module ownership | Interface and integration seam |
| --- | --- | --- |
| W1-A action discovery | `public/shell-actions.mjs`, `tests/shell-actions.test.mjs` | `filterActionItems(items, query, {limit})` preserves current palette matching, ranking, stable tie order and default limit 80. `checkActionTarget(action, currentTarget)` returns `{ok, reason}` for explicit scope/target metadata. The parent adds stable IDs and metadata to existing catalog producers and keeps their real handlers. Dynamic catalogs remain tab-owned. |
| W1-B navigation and preferences | `public/shell-navigation.mjs`, `public/shell-preferences.mjs`, `tests/shell-navigation.test.mjs`, `tests/shell-preferences.test.mjs` | `createShellHistory({window, onPopState})` returns `write({state, replace, url})`, `back()` and `dispose()`. It becomes the sole browser-history writer/listener, preserving the existing mobile history shape and unrelated history fields. Preference exports read/write the separate preview record and resolve the effective mode using the existing phone/tablet rules. |
| W1-C canonical views and drawer focus | `public/shell-view-host.mjs`, `public/shell-surfaces.mjs`, `tests/browser/shell-ownership.spec.mjs` | `createViewHost({document})` returns `move(node, host)`, `restore(node)`, `restoreAll()` and `dispose()`. `createSurfaceCoordinator({document})` owns drawer activation/deactivation, the Escape/Tab listener and focus return. Parent adapters preserve existing section attributes and native-dialog behavior. |

Action records use explicit, stable IDs, not labels or array positions. A browser/server action has no session target. A session action captures `{tabId, generation}` when presented; a project action also captures `cwd`. Target checks reject changed or missing identity with a useful reason before invoking the existing handler. Explicit tab-selection actions instead validate that their named tab still exists. Availability is recomputed on invocation, separately from control visibility and server authorization. The pure action module does not execute requests, retain dynamic catalogs or become a plugin registry. W1 keeps the current palette presentation; categories and pins use this same catalog in W3.

The preference record key is `pi-webui-shell-preferences-v1`. Its initial payload is `{v: 1, desktopLayout: "classic" | "focused"}`. Add inspector preferences only when the inspector exists. `readShellPreferences(storage)` returns a distinct `absent`, `valid`, `invalid` or `unavailable` status plus a normalized value. `writeShellPreferences(storage, value)` reports success/failure without throwing storage errors into chat. Invalid/future data is not deleted or overwritten during reads. No stream/session data enters this record. The effective-mode resolver gives `shell=classic` recovery priority, then the independently resolved phone/tablet mode for those viewports, then the valid desktop choice. Absent/invalid/unavailable desktop preference means Classic in preview. Existing mobile preference readers and keys remain authoritative.

History writes accept only navigation state and same-origin URLs with the existing identifier/query contract. Preserve `tab`, `mobileRoute`, `run`, `blocker` and split-embed parsing; W1 does not invent a new deep-link format. Deliberate navigation pushes, initialization/recovery replaces, resize never writes. The adapter has one removable popstate listener and does not open an EventSource. The caller must finish any required dirty-buffer confirmation before committing a destructive navigation. Pure view movement and route changes retain buffers. Back/Forward must not discard a buffer to restore presentation.

The view host records each node's original parent and sibling only once, moves that same node, and restores its position without cloning. It preserves focus, text selection and scroll when the moved node stays visible, and never returns focus into an inert/hidden subtree. Idempotent restoration releases its bookkeeping. Disposal restores owned DOM and removes view listeners; it never closes a tab, runner, stream or pending extension request. Existing `mobileCanonicalMountContent` and widget-area movement become adapters to this owner. The drawer coordinator extracts `activateDrawerModal`, `deactivateDrawerModal` and their keyboard behavior. Native `dialog.showModal()` keeps browser-managed focus until its owning feature is migrated; the coordinator must not add a competing trap.

Each worker verifies its own module behavior. Parent integration then checks unchanged Classic/mobile workflows, missing/stale targets, storage denial/corruption, history Back/Forward, repeated mount/unmount, selection/focus, and listener cleanup. All new imports must be present in the npm payload and service-worker cache list. An integrated round-1 review checks the used interfaces and preservation contracts, not only the standalone tests. No CSS split is required in W1 because changing loading order without a layout change adds risk without removing an owner.

Dependency preflight: npm reports `@firstpick/pi-utils` 0.3.2 as published. The parent downloaded the 0.2.5 minimum and 0.3.2 archives into disposable directories without installing either. Both expose the seven utilities imported by the WebUI launcher, through the same root/process/http exports. Package-range, lockfile and consuming-package version changes belong to W1 integration, with the corresponding exact-version tests updated and the launcher checked. This archive inspection does not replace runtime validation.

### W0-C integration and defect disposition

Integrated worker `6ab2e562e07d73e0cbbf26de485dbc4355681b97` as `1ce53e75` after inspecting its four-file diff and handoff. The parent copied the 25 screenshots/raw artifacts into the integration checkout, displayed and inspected the sidebar, narrow split and constrained-phone failure screenshots, and reran the complete dedicated suite. All 13 tests passed in 33.9 seconds, with nine passing layout scenarios and four explicit defect characterizations. The rerun did not overwrite frozen JSON. Log: `/tmp/webui-overhaul-w0-c-integration.log`.

| Finding | Parent disposition and required follow-through |
| --- | --- |
| W0-C-001, hidden split reserves half the narrow workspace | Accepted. Parent reproduced the geometry and inspected the 1024px screenshot; the narrow CSS hides `.terminal-split-shell` while the split-open workspace retains two columns. W3 must reclaim the space or provide a usable narrow split presentation, preserve both sessions/drafts and keep a reachable return path. |
| W0-C-002, phone-v2 status strip intercepts composer | Accepted. Parent rerun confirms prompt/attachment trial-click interception at 844×220; screenshot shows the status strip over the composer. W3 must keep the required controls operable during constrained landscape layout. Native keyboard verification remains distinct. |
| W0-C-003, oversized sidebar with Right deck | Accepted. Parent inspected the 1920px screenshot and reproduced the rail/transcript geometry. W3 must bound sidebar width and preserve space for conversation across deck changes and collapse. This disposition accepts the observed defect, not an unverified CSS root cause. |
| BUG-002, tablet-v2 attachment clipping | Accepted as corroboration of the existing finding. Initial geometry remains clipped even though Playwright can scroll the layout sideways to complete a trial click. Keep the original W3 assignment. |

The supplement's exact defect assertions are historical baseline characterizations. W3 adds positive corrected-behavior regression checks; it must not keep asserting the defect as a release gate. The frozen source-only capture commands are not intended to run unchanged after production extraction. True browser zoom and native keyboards remain explicitly unmeasured. W7 must report their verification status separately from equivalent viewport reflow tests.

### W0-D integration and evidence limits

Integrated worker `c0b13789da2ffdd391dc39e49c40e0409621b3d8` as `67bc04b8` after inspecting its complete four-file diff, fixture boundaries and handoff. The parent copied all 38 screenshots/raw artifacts and inspected the agent gate, phone approval recovery and long-transcript screenshots. This supplements the original crowding/performance reference; it does not alter its counts or budgets.

The twenty cases cover real resource-profile writes at session/model/global scopes, three model-selector paths, representative Guided Git/stats/agent/gate projections, exact background-approval response targets, common phone actions, 200-message reading continuity and a 120-file tree. Model/command catalogs and companion events are explicitly simulated. The existing fake process acknowledges a model change but returns its fixed model afterward, so the three model cases remain partial. All fake processes also share `fake-session`; aggregate agent rows do not prove agent-session isolation. W2 must add opt-in fixture behavior for retained model state and distinct session identities before claiming these ownership contracts pass. Neither limitation blocks pure W1 extraction, but both remain open verification work.

| Finding | Parent disposition and required follow-through |
| --- | --- |
| CAP-001 → BUG-003, undiscovered background approval | Accepted. Server `attachRpcToTab` emits only to that tab's SSE clients; browser `syncTabPolling` stops when no known tab is working/blocked. Parent verified these source paths and the exact-target characterization. W2 must provide bounded background attention reconciliation without replacing the active-tab stream or exposing another tab's dialog over the current conversation. Its regression test must discover a blocker from an initially idle client without manual reload. |
| CAP-002 → BUG-004, phone notification overlap | Accepted. Parent screenshot inspection confirms recovery toasts cover bottom navigation; the recorded hit test identifies the toast at the Sessions target. W3 must place notices outside mandatory navigation/composer hit areas, including stacked notices. Existing top Sessions access is a workaround, not corrected behavior. |

Installed companion/provider combinations and native devices remain unverified. W7 records those limits independently from fixture-based parity. The background-approval recovery counts describe observed workarounds, not acceptable focused-shell targets. Preserve the source-tab draft and exact request/tab response checks when adding positive discovery coverage.

Parent verification: all twenty supplemental capability tests passed in 46.7 seconds on the integrated branch, without overwriting the committed reference. Fourteen scenarios are verified within the documented simulation boundary, three model paths remain partial, and three approval paths characterize the known discovery defect. Log: `/tmp/webui-overhaul-w0-d-integration.log`. Round 1 now reviews the combined W0 evidence and its readiness for W1 with two independent Sol runs. No product implementation acceptance is implied.

### W0 round-1 review dispositions

Two fresh-context Sol/high runs reviewed `bb9e40d`. Review A, inventory/isolation/packaging, completed through task `webui-overhaul-w0-review-a-r1-20261114` and recommends beginning W1 after combined disposition. Review B, measurement/coverage, completed through task `webui-overhaul-w0-review-b-r1-20261114` and identified two tooling blockers. This is one review round with complementary scopes, not two rounds. The requested Sol provider/model is used for both; Anthropic remains waived.

| Finding | Parent disposition and verification |
| --- | --- |
| W0-A-R1-001, P3 stale source-byte total | Accepted and fixed. Parent summed the committed inventory to 4,521,433 bytes over 97 inputs, confirming the ledger's 4,503,032 total was stale. Removed the duplicated total and pointed readers to the per-file sizes/digests. The canonical plan is itself a hashed input and changes during execution; another copied total would immediately drift. No capability classification or production source changed. |
| BUG-W0-B-R1-001, Major input timer omits synchronous work | Accepted. Parent reproduced it in real Chromium: an earlier 80ms handler yielded a 0.8ms reported interval. Changed the probe to capture phase before application bubble handlers. The same regression test now passes. Input measurement version 2 prevents comparisons with the superseded samples. Corrected seven-sample capture and bounded round-2 verification are required before W1. |
| BUG-W0-B-R1-002, Major failed workflows can replace reference | Accepted. Parent executed the original writer in an in-memory VM and confirmed a failed ninth workflow still reached its write call. Added a pure completion guard used by the actual reference writer, checking exact view/state/workflow identities, completed statuses/actions, browser errors, repeated samples and final output. Fourteen focused tests pass, including twelve invalid captures that leave prior file bytes unchanged. Unexpected workflow errors now fail normal captures after preserving diagnostic artifacts. |

Review A also verified all source digests, 1,553 anchors, inventory determinism, isolated fixture configuration, packaging/discovery, existing W1 seams and artifact existence. Its evidence is source/read-only validation plus existing parent logs, not another browser run. Parent inventory regeneration/check and whitespace validation passed after the documentation correction. Review B found the remaining coverage and deferred limits sufficient for W1 after its two blockers are fixed. Round 2 is limited to these accepted fixes, their regressions and the corrected input evidence; it must not restart a general W0/W7 audit. W0 acceptance remains pending that verification.

Parent fix verification: the Chromium regression, seven-sample performance recapture and nine-workflow exercise passed as three tests in 1.2 minutes. The corrected input p50/p95 are 22.1/30.9ms. Only this metric supersedes the original reference; the original samples and correction provenance remain recorded. All other metric values, crowding/workflow records, screenshots and frozen budgets were checked unchanged. The guard accepts the original complete view matrix combined with the new performance/workflow capture. Fourteen focused writer/comparison tests pass; invalid captures preserve the reference bytes. Production sources still match the original baseline. Logs: `/tmp/webui-overhaul-w0-input-before-fix.log` and `/tmp/webui-overhaul-w0-review-fixes-browser.log`. Corrected raw report: `pi-package-webui/test-results/overhaul-baseline/run-2026-11-14T21-04-19-332Z/report.json`.

### W0 acceptance and W1 start

Final fresh-context Sol/high task `webui-overhaul-w0-review-r2-20261114` reviewed `d74938f` against `bb9e40d`. It independently verified all three fixes, the unchanged unrelated reference fields, corrected sample provenance and actual guarded writer. All fourteen test bodies passed its in-memory execution. It found no unresolved accepted finding or qualifying regression and recommended W1. Parent read the report and checked its conclusions against the already completed real-filesystem/browser tests. All three findings are resolved. W0 used two review rounds; no further W0 review will run.

W1-A, W1-B and W1-C may start from this accepted contract in separate tool-managed worktrees. Their exact write sets are the new module/test paths in the W1 table. Unique ignored handoffs are `handoffs/webui-overhaul-w1-a.md`, `handoffs/webui-overhaul-w1-b.md` and `handoffs/webui-overhaul-w1-c.md`. Parent owns every shared integration file and the capability ledger. No worker may alter `app.js`, HTML/CSS, service-worker list, manifests, existing tests or this plan. Module work alone does not complete W1; actual Classic integration and its tests/reviews are required.

The worker interfaces are fixed as follows. `checkActionTarget` accepts scopes `browser`, `server`, `session`, `project` and `tab`; explicit tab selection checks `currentTarget.liveTabIds`, while session/project actions compare the captured target identity. `available: false` yields `unavailableReason` without execution. Shell preference functions export the record key and `resolveShellMode`; the resolver returns `classic`, `focused`, `mobile-v2` or `tablet-v2` under the plan's precedence rules. The surface coordinator exposes `activate(surface, trigger, {close})`, `deactivate(surface, {restoreFocus})` and `dispose()`. Its constructor accepts the document, existing `getFocusableElements` callback and an `onEscape(surface, event)` callback returning true when the caller consumed Escape for an inner tab-group menu. Native modal dialogs take precedence over drawer keyboard handling. The new modules own no session resources and perform no requests.

### W1 integration and review evidence

The parent integrated all three isolated Sol/high outcomes: W1-A `3e1f0989` as `f986ece4`, W1-B `ef246abe` as `b9eee64a`, and W1-C `8030b139` as `099d3c48`. Shared wiring now uses the five modules in the actual Classic/mobile app. The capability ledger contains the compact ownership contract for later workers. No domain process or backend route was replaced. Focused rendering remains W3 work.

Palette records now have stable IDs, destinations and scopes; dispatch checks the captured identity and rebuilds the current catalog before calling its existing handler. Navigation has one history owner and commits before rendering. Canonical section/widget movement preserves the original nodes, while section attributes remain app-owned. One drawer coordinator handles nested Escape and native-dialog precedence. Browser-local shell preferences fall back conservatively; `shell=classic` bypasses previews without erasing their settings. The npm payload, service-worker v157, app entry v186 and syntax checks include every module. The package version is 0.11.2 and its verified pi-utils minimum is 0.3.2.

Parent checks completed before round 1:

- 15 action tests and 19 navigation/preference tests passed. Worker C's 22 real-DOM ownership tests also passed in the integrated browser run.
- Initial app/ownership run: 33 passed, four failed. All four failures reproduced against unchanged production source in worker C's base checkout. Two stale assertions were corrected: the default deck selector must identify the right deck, and the sidebar action group currently contains three buttons. All seven focused integration/selector cases then passed. New cases exercise recovery across resize, history write failure, same-node file filters and drafts through Back, unchanged SSE count, stable palette actions, and offline/online module loading.
- Existing legacy-mobile pointer reordering and tablet file-viewer visibility still fail in both original and integrated code. They remain W3 defects, not waived release gates. Reproduction commands and outputs are `/tmp/webui-overhaul-w1-browser.log` and `/tmp/webui-overhaul-w1-original-browser.log`. The former fails at the Edit-mode order assertion; the latter tablet path opens a file but its viewer remains invisible. Preserve these scenarios when fixing the layout.
- The three-test Classic/performance/workflow capture passed. All six performance measurements remain within the frozen budgets: cold/warm first useful render p95 318.8/188.4ms, input 31.0ms, tab switch 68.6ms, streaming gap 500.1ms, retained heap 9,193,244 bytes. Final output is present. Classic secondary-control counts remain 29 idle and 31 streaming; W1 does not claim the focused 30% reduction.
- A fresh Classic screenshot capture passed after the metrics run. Parent displayed and inspected the desktop idle and mobile Project screenshots. Desktop visual treatment is unchanged; Project retains its canonical filter across navigation. Screenshot roots are `test-results/overhaul-baseline/run-2026-11-14T21-29-26-233Z` and `test-results/w1-integration` under the package. The performance report is in `test-results/overhaul-baseline/run-2026-11-14T21-27-47-191Z`.
- npm dry-run includes 390 files, including all five modules; repository-only scripts/evidence/handoffs remain excluded. The offline browser check confirms all five cached modules import successfully, API responses are not cached, and online reload restores the real palette.

Evidence retention correction: the normal Playwright output directory cleared prior untracked captures during the first W1 run. Parent restored all 105 original W0 screenshots/raw captures from the isolated workers and changed the local W1 configuration to a dedicated output subdirectory. The W0 corrected-input raw report from 21:04 was not recoverable; its committed seven samples, correction metadata and validation logs remain. Do not claim that deleted raw file still exists. W1's fresh seven-sample measurement is independently retained and does not replace the frozen baseline.

The first full package check found three source-shape assertions tied to the old palette/history locations. Parent updated those assertions to the new explicit IDs/history owner, kept their behavioral requirements, and passed each focused test. The second full check ended with signal 143 after the workspace harness, with no assertion failure recorded; its cause is not established. A third check runs in a separate process group, and a full green result remains required before acceptance. Review round 1 will use two complementary fresh-context Sol/high reviewers, with at most one limited fix-verification round afterward. W1 acceptance remains pending their findings and parent disposition.

### W2 fixture prerequisite

W2-F may run while the W1 reviews finish because it changes only opt-in test behavior and does not depend on shell acceptance. Production W2 extraction still waits for W1 disposition. Its exact write set is `pi-package-webui/tests/fixtures/fake-pi.mjs` and new `pi-package-webui/tests/fake-pi-session-ownership.test.mjs`; all app, server, module, manifest, plan and existing browser-test paths remain parent-owned or forbidden.

Under a new `FAKE_PI_SESSION_OWNERSHIP=1` flag, retain successful model choices in subsequent `get_state` replies and expose two deterministic fake model choices. Preserve missing-model rejection without changing the current choice. Give separate processes distinct session identities when no session file is specified; for explicit session files derive a stable identity from the normalized absolute path. A successful `new_session` changes that process's session identity without changing another process or resetting its selected model. Unflagged consumers retain their existing replies and timing. Existing Codex-specific fixtures retain precedence when combined with this flag. No provider calls, session-file reads/writes or real Pi installation are needed.

The worker proves these contracts through bounded direct JSONL child-process tests, verifies default-off compatibility and cleanup, and records commands/exit codes and limitations in `handoffs/webui-overhaul-w2-f.md`. It commits only its two owned files and stops if broader fixture/runtime changes are needed. Parent integrates this prerequisite after W1, then uses it for actual model/session isolation browser checks. W2's two-round review budget includes this fixture work; it gets no separate unlimited review cycle.
