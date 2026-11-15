# Web UI feature destinations

This is the maintained capability contract for the compact Web UI. Existing features retain the destinations, scopes and preservation rules below. The [capability ledger](capability-ledger.md) maps each family to its implementation and tests; [DEVELOPMENT.md](../../DEVELOPMENT.md) describes module ownership and contributor checks.

This contract was established by the approved overhaul plan. It lives with the contributor documentation so inventory checks remain reproducible after the completed execution plan is archived.

### Feature destination map

This map incorporates the UI scout's inventory and the design review corrections. A destination is the primary home; existing commands and keyboard shortcuts continue to invoke the same behavior.

| Capability | Primary destination | Immediate access and preservation |
| --- | --- | --- |
| New, close, resume and switch sessions; tab groups; saved workspaces | Session navigation and Home | Preserve top/left presentation, drafts per tab, close confirmations and restore behavior |
| Settle / Restore and activity shelves | Compact left session sidebar | Browser-local, explicit organization; new work/input or a newer completed run wakes a settled session; never close or abort; preserve group membership |
| New session within a tab, rename, clone, fork, tree, export and summary | Conversation session menu and Session details | Keep tab identity distinct from the durable Pi session it hosts; preserve inline message actions |
| Floating conversation overview | Conversation header → Overview | Read current workspace, Git, runner, agents, queue and usage owners; guarded links to canonical controls; closing never stops work |
| Split conversations | Conversation layout action | Preserve independent session ownership, embed links and return on sufficient width |
| CWD picker, recent/saved directories, create directory, branch worktrees | Session context and Project | Browsing files must not implicitly change CWD; show target before mutation |
| Transcript, thinking, tools, Markdown, code, images and search | Conversation | Keep output modes, follow/history scroll and context-sensitive find |
| Mobile Essential/Detailed presentation | More: Presentation and Settings: Appearance | Retain the existing browser-local preference; this changes process chrome, never transcript content or server `compact-v1` output processing |
| Prompt editor, uploads, paste, text attachments, slash/path/bash suggestions | Composer | Preserve attachment lifetime, queue intent and suggestion-versus-send precedence |
| Model, effort, speed, plan/operating mode and per-session sampling | Composer/context controls and Activity: Session/Sampling | Compact model/effort pickers apply to the captured session and show effective or pending-next-prompt values; persistent defaults belong in Settings |
| Steering, follow-ups, bash queue and prompt lists | Composer and Activity inspector | One compact submission button follows the visible During this run choice; Activity retains queue editing and ownership |
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
| Extension notifications, status, widgets, blocking dialogs, custom messages | Semantic host in conversation/activity | Attention links background decisions to their originating conversation and authoritative dialog replay; preserve request identity, response, timeout and reconnect semantics |
| Native questionnaires, Other answers, edit/retry, per-action feedback and LEARNING creation | Conversation and its response dialogs | Preserve input and feedback association, explicit submission and retry semantics |
| Workflow Mode, minimized inspector, subprocess widgets, classifier details and gates | Conversation mode/status entry and Activity | Keep exact pending gate/model-exception target and originating run; controls obey existing capabilities |
| Read-only subagent terminal projections, retained runs, Auto-Clear/detach and cancellation | Activity: Agents | Closing/detaching a projection is distinct from cancelling the real agent; preserve telemetry and external-agent identity |
| PWA install education, notification targets, offline/restarting/boot-failure recovery | Settings: Help/System with global recovery affordances | Preserve direct notification navigation, offline limits and accessible retry/Classic startup escape |
| Release notes, sponsorship and help | Settings: About and Help | Maintain visible Help access outside Settings and preserve existing destinations |

Use the existing catalog's twenty companion identities as a reconciliation checklist: shell completion/shell choice, BTW, Guided Git, npm/AUR release, manual review, workflows, classification, safety, skills/tools, todo, remote, questionnaires, voice, footer, stats, speed and themes. This is a family summary, not a replacement package registry. Installation, enablement, capability availability, hidden-by-preference and failure are separate states. Include a stable Show hidden controls/Reset visibility action in Settings and the palette; hiding a control must not make recovery undiscoverable.
