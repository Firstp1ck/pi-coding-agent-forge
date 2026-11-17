# Compact workspace direction

Updated 2026-11-14 following the request for a more compact, minimal interface with complete feature access.

## Decisions

- Use a 46px activity rail and a collapsible 202px session list. Together they occupy approximately the same width as the previous sidebar; collapsing the list is the deliberate focus action.
- Reduce the header to one 47px row. Keep session actions beside the session title, project context beside the branch, and prompt actions beside the prompt.
- Keep one inspector for files, changes, runners, activity, and feature details. Configuration gets a dedicated Settings destination.
- Use flatter surfaces, fewer enclosing cards, and collapsed tool history. Keep Pi's theme colors, restrained gradients, typography, and rounded controls.
- Make All tools a visible, browsable launcher: 45 entries grouped by task, search across labels and descriptions, keyboard navigation, and pinnable shortcuts. Pins last for the current page visit in this mock.
- Show pending decisions until resolved. A simulated running response has a session-labeled stop action in the workspace and in the modal launcher.
- On phones, use Chat, Sessions, Activity, Project, and All tools. Settings is available through All tools. Inspectors use the available content area.

## References and adaptation

[Zed's command palette](https://zed.dev/docs/command-palette) provides searchable actions. Pi adds visible category browsing so remembering a command name is optional.

[VS Code's custom layout](https://code.visualstudio.com/docs/configure/custom-layout) separates the activity bar, sidebars, and panels. Pi uses a small rail, collapsible session navigation, and one contextual inspector.

[Linear's contextual menus](https://linear.app/now/invisible-details) bring actions to their object and expose shortcuts. Pi places session, message, and composer actions beside those objects, with the same features also discoverable in All tools.

The earlier T3 Code study still supplies the separation between navigation, conversation, inspection, and settings. None of these references justifies replacing Pi's framework, backend, or visual identity.

## Feature access

| Home | Examples |
| --- | --- |
| Sessions | New/resume, groups/workspaces, rename/clone/fork, tree/summary/export, split, context/compaction |
| Compose | Attachments, modes/sampling, voice, steering, commands/templates, side questions, find, feedback and message actions |
| Project | Files/search/editing/annotations, changes, advanced Git/worktrees, runners, releases and artifacts |
| Activity | Agents/approvals, queues, workflow/todo/gates, intercom, projections, events, extensions and usage |
| Settings | Themes, layout/visibility recovery, Essential/Detailed presentation, shortcuts, scoped resources, companions, accounts, remote access, updates and help |

This catalog demonstrates the access model. The canonical overhaul plan remains the exhaustive behavior-preservation contract; a catalog entry is not evidence that its production capability is implemented.

## Verification

At 1440px width in Chromium, compared with the preceding mock source:

| Region | Previous | Compact | Reduction |
| --- | ---: | ---: | ---: |
| Header height | 69px | 47px | 32% |
| Composer height | 130.7px | 98.6px | 25% |
| Composer region including status and approval | 238.7px | 163.6px | 31% |

These are mock layout measurements, not production usability results. W0/W7 still measure crowding and workflow reachability in the real Web UI.

Acceptance: PASS for this static interactive mock. The inline script parses. Chromium checks passed for session drafts, navigation collapse, project changes, catalog search/filtering/pinning, keyboard access, scoped previews, Settings/theme, approvals, and stopping a running demo from both Settings and the modal launcher. No browser errors or horizontal document overflow at 1440, 1100, 980, 728, 600, 390, and 320px. Screenshots were inspected for desktop conversation/changes, launcher, light Settings, mobile conversation, and mobile launcher.

No dependencies or production packages changed. No application-wide tests, backend actions, production compatibility tests, screen-reader audit, or user usability study were performed. Feature detail choices are selection previews; the mock does not execute Git operations, run agents, record audio, persist installation settings, or implement the Classic shell. It demonstrates where those controls will live.
