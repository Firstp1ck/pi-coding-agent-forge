# Writer technical reference

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Requirements

- Pi with extension commands, Agent Skills, project trust, and the standard read/write/edit tools.
- Node.js 22.19 or newer, matching the package's declared runtime requirement.
- An available model selected in Pi. No particular provider or model is forced.

The guided menu uses Pi's standard dialogs. It works in the terminal and in RPC clients that implement those dialogs. Explicit command forms do not need dialogs. In noninteractive use, invoke the command through a host that dispatches extension commands; the menu itself is unavailable.

If Pi has not trusted the workspace, use `/trust` in an interactive session and restart Pi before using writer commands.

The command refuses to start writing while Pi is busy. It does not enable tools, install dependencies, spawn agents, or change your model. It is independent of the separate workflows extension.

## Command reference

Use double or single quotes around multi-word values. Backslashes in Windows paths are preserved. A backslash immediately before a matching quote escapes that quote. Use `--option value`, not `--option=value`.

| Command | Behavior |
| --- | --- |
| `/writer` | Guided menu |
| `/writer help` | Usage reference without reading projects |
| `/writer new book "Title"` | Create a project and ask Pi to plan the opening |
| `/writer new chapter ["Title"]` | Reserve a chapter target and ask Pi to draft one chapter |
| `/writer new scene ["Title"]` | Reserve a scene target and ask Pi to draft one scene |
| `/writer new volume ["Title"]` | Reserve a volume target and ask Pi to plan one volume, not write the entire volume |
| `/writer continue [project-id]` | Read saved state and resume the next clear step |
| `/writer open <project-id>` | Select a project without calling the model |
| `/writer list` | List projects and report unreadable project entries |
| `/writer status [project-id]` | Show saved progress and recent numbered units without calling the model |
| `/writer outline` | Develop or refine the requested outline |
| `/writer style` | Compare voice choices and propose a style profile |
| `/writer brainstorm` | Explore distinct alternatives without adopting them as canon |
| `/writer characters` | Develop motivations, relationships, arcs, or dialogue voices |
| `/writer worldbuilding` | Develop settings, systems, and their consequences |
| `/writer research` | Ask the model to investigate a bounded factual question with available tools |
| `/writer review` | Request read-only critique and continuity checks |
| `/writer revise` | Request a new revision under the project's revisions folder |
| `/writer adapt` | Request an adaptation to a new file |
| `/writer import --source "path/to/draft.md"` | Reconstruct context from a local Markdown or text manuscript without replacing its source |

New-book options:

- `--format`: `novel`, `light-novel`, `web-novel`, `short-story`, `manga`, or `webtoon`. `roman` is an alias for `novel`.
- `--style`: free-text voice or blend, such as `"epic, intimate"`. There is no closed preset list.
- `--genre`: independent of format and style.
- `--language`: output language. Otherwise Pi is told to use the author's conversation language.
- `--brief`: premise, constraints, or audience boundaries.

Writing-task options, including new chapters, scenes, and volumes:

- `--project <id>` selects the project for this task. Successful writing launches also make it active. Reviews do not change the active selection.
- `--brief "Instructions"` defines the scope, target length, POV, or desired effect.
- `--target "chapters/chapter-0001.md"` is supported for continue, review, revise, and adapt. It must name an existing Markdown file inside the selected project.
- `--format manga` selects the destination for adapt. It does not change the project's default format.
- `--style "restrained, melancholic"` supplies a preference for the style workflow.
- `--source "path/to/manuscript.md"` selects the original for import. Relative source paths resolve from Pi's current working directory, not the book directory. Absolute paths are accepted.

If a target or scope is omitted, the model must inspect the saved state and clarify an ambiguous request. It must not assume permission to rewrite the entire project. Import requires an explicit source and an existing project. PDF, EPUB, and DOCX conversion are separate tasks.

## Bundled skills

These are original Pi-ready skills covering the capabilities surveyed during development, not verbatim copies of the upstream bundles.

| Skill | Focus |
| --- | --- |
| `writer-workflow` | Bounded tasks, saved state, continuation, author approval |
| `writer-brainstorm` | Creative alternatives and trade-offs |
| `writer-outline` | Scene, chapter, volume, and series structure |
| `writer-characters` | Motivation, relationships, voice, character exploration |
| `writer-worldbuilding` | Settings, rules, costs, institutions |
| `writer-style` | Emotional, epic, lyrical, restrained, and blended voices |
| `writer-prose` | Viewpoint, dialogue, scene causality, drafting |
| `writer-novel` | Novels and short fiction |
| `writer-light-novel` | Voice, readable scenes, volume arcs, illustration notes |
| `writer-serial` | Installment payoff, hooks, long-running threads |
| `writer-manga` | Panels, dialogue, page turns, webtoon scroll beats |
| `writer-continuity` | Evidence-linked canon and knowledge checks |
| `writer-revision` | Structural critique and voice-preserving revision |
| `writer-reader` | Explicitly simulated first-time reader responses |
| `writer-adaptation` | Moving stories between media |
| `writer-import` | Source maps and proposed reconstruction of existing work |
| `writer-research` | Factual details without exposing private manuscripts |

Skills can be invoked directly, for example `/skill:writer-style`, when skill commands are enabled. Direct skill invocation does not automatically create or select a project. The workflow command points the model at the relevant bundled instructions for its task.

## Storage and continuation

Projects live under `writing/<project-id>/` in the folder where `/writer` runs. There is no global manuscript database or cross-workspace search. Start Pi in the same workspace to resume, or copy the complete `writing/` directory to the new workspace.

Each project contains editable brief, style, outline, continuity, and progress documents, plus folders for chapters, scenes, volumes, characters, worlds, revisions, scripts, and import notes. The progress document is a human-readable checkpoint with saved paths, the next step, and open decisions.

The command creates project scaffolds and numbered placeholder files, including the supplied task brief so an interrupted start can be recovered. The model writes the actual manuscript and updates the checkpoint after saving. There is no background autosave, autonomous chapter loop, or guarantee that an interrupted model run updated its checkpoint.

A reserved chapter is not a completed chapter. `/writer status` counts reserved or drafted files, not approved work. If a run stops early, `/writer continue` asks Pi to inspect the files and resolve stale or ambiguous state before proceeding.

Keep the whole project when making backups. There is no destructive reset or delete command. To archive a project, move its directory while Pi is idle, then select another project with `/writer open`.

## Privacy and safety

The extension itself makes no network requests and does not inspect projects at startup. Project access begins only when a command needs it and Pi trusts the workspace.

The active model receives the workflow request and any manuscript text it reads. Normal provider costs and privacy terms apply. Research may use installed tools when the task calls for it, but the skill instructs Pi not to include private manuscript passages in search queries without approval.

Project creation refuses an existing target. Numbered-unit creation refuses to overwrite an existing file. The command rejects unsafe paths, symlinks/junctions in its managed paths, and multiply linked files. These checks are not a sandbox for the model's ordinary tools or a defense against hostile simultaneous filesystem changes.

Review requests instruct the model not to modify any files. Revisions and adaptations request separate outputs. These are model instructions, not tool-level write blocking. Higher-priority host policies remain in force.

Do not use multiple Pi sessions to edit one project at the same time. Exclusive target creation prevents name collisions, but model edits and checkpoints are not a cross-session transaction.

## Limits and troubleshooting

- If `/writer` is missing, enable the package's extension and reload Pi. Skills and commands can be enabled separately in Pi's package configuration.
- If a command reports missing tools, enable read/write/edit in Pi. Review only requires read.
- If a project already exists, use `/writer open <id>` or choose another title. Existing directories are never silently merged.
- If active selection is corrupt or points at an archived book, use `/writer list` and `/writer open <id>`. Selection errors do not silently switch you to another book.
- If setup fails midway, partial files are preserved. Inspect or move that directory before retrying; do not delete useful work blindly.
- If a checkpoint is missing or stale, ask Pi to reconstruct it from saved work and review the result before continuing.
- Metadata and displayed checkpoints are limited to 16 KiB. Keep checkpoints concise and move historical detail into chapter summaries or reference notes.
- A directory may contain at most 4,096 entries for command discovery. Numbered targets use four digits. Split unusually large projects into volumes or workspaces.
- Lists show up to 100 projects and 10 warnings. Status shows the last 20 numbered paths; workflow requests include at most 30, with the total count. Pi must inspect further files when the task needs them.
- Writing quality, word counts, continuity audits, and simulated reader reactions need human review. No deterministic canon validator or quality guarantee is included.
- Manga and webtoon support stops at text scripts/storyboards. Images, covers, PDF/EPUB production, publishing, and market scraping are not bundled.

## Updates and recovery

Updating this package does not automatically rewrite existing projects. Unsupported project versions are rejected rather than silently migrated. Back up projects before manual format changes, and retain a compatible package version if you need to roll back.

For implementation details, source provenance, and validation, see [DEVELOPMENT.md](DEVELOPMENT.md).
