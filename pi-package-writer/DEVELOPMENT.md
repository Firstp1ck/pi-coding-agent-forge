# Development guide: Writer for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Local development

From the repository root:

```bash
pi install ./pi-package-writer
```

This registers a local package path in Pi settings. The implementation change itself does not run that command, install globally, or publish to npm.

There are no runtime npm dependencies. The extension imports Pi types only. Pi loads the TypeScript sources; Node's type stripping runs the tests without a build step.

## Implementation

- `index.ts` registers `/writer`, provides cancellable native dialogs, checks project trust and idle state, and dispatches one message to the active conversation model.
- `src/command.ts` owns command parsing, option validation, supported formats, and help text.
- `src/store.ts` handles scaffolding, manifests, active selection, safe paths, bounded metadata reads, and exclusive numbered-file creation.
- `src/workflow.ts` maps tasks and formats to bundled skills and constructs the model handoff.
- `skills/` contains 18 original portable Agent Skills. Host-specific command advice lives under each skill's Pi adapter section.
- `references/` contains shared project, format, style, and review guidance.

No model calls happen in extension code. `pi.sendUserMessage()` starts the normal agent turn after local preparation. The command does not change models, tools, or system prompts. No hooks inject writing guidance into unrelated turns.

The command handler has an in-process reentry guard. It rejects busy starts, rechecks idle state after dialogs, and invalidates model dispatch when its session shuts down. Read-only list/status can run while Pi is busy. Review bypasses active-selection writes and its handoff explicitly forbids all file edits. The extension does not intercept later model tool calls, so read-only review is a workflow contract rather than enforced tool isolation.

## Storage contract

Workspace selection is `writing/.active.json`:

```json
{ "version": 1, "id": "the-lantern-keeper" }
```

Each project has `writing/<id>/writer.json`:

```json
{
  "version": 1,
  "id": "the-lantern-keeper",
  "title": "The Lantern Keeper",
  "format": "light-novel",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

IDs use a restricted ASCII slug. Titles that cannot form a valid slug receive a random `book-` ID. Reserved Windows device names are rejected. Directory identity and manifest identity must agree. Future schema versions are rejected without migration.

The manifest owns identity, default format, and the optional `guidance` preference, whose valid values are `beginner` and `standard`. Missing guidance in existing version-1 manifests means standard. Validation rejects other values; no automatic migration or manifest rewrite is needed. Editable Markdown owns story content, genre, language, voice, canon, and progress. Adaptation format is a per-task choice, not an implicit manifest update.

## Beginner workflow contract

`/writer start` creates a new project with `guidance: "beginner"`, a `learning.md` notebook, and an initial checkpoint aimed at a small exercise rather than a whole-book outline. The title and idea may be blank in the UI. A supplied title uses the explicit-command path without dialogs; headless starts require it. Creation still refuses collisions. The normal new-book wizard also accepts `--guidance beginner` and preserves that choice through its dialogs.

`guidanceFor()` resolves the effective preference for each handoff. Start and coach always use beginner guidance; other tasks use an explicit `--guidance` override, then the saved preference, then standard. Task overrides and `/writer coach` do not rewrite the manifest. Skill selection adds `writer-beginner` only for beginner tasks. Beginner starts do not load the outline skill as a prerequisite; medium-specific guidance still loads.

The teaching contract asks one question or gives one exercise per reply, explains concepts briefly through the author's story, and supports trying alone, writing together, or requesting a short example. It forbids completing the author's exercise without a request and avoids grading talent or pretending to measure mastery. Explicit drafting requests remain authoritative.

The model creates or maintains `learning.md` and keeps its next action consistent with `progress.md`. Notes record actual attempts, chosen help preferences, and the next question, not assumed skill mastery. Older projects need no notebook until the model saves one during coaching. Managed-path checks cover this optional file too. Reviews do not update it. This is a prompt-and-skill contract, not a deterministic lesson engine or a write sandbox.

## File creation

The command writes the manifest last during scaffolding so an incomplete directory does not appear as a valid project. Setup failures preserve partial work. Active selection uses a same-directory exclusive temporary file followed by rename. Numbered targets use exclusive file creation and up to 32 bounded collision retries. Existing units are never truncated by reservation.

A new unit contains `<!-- writer:planned -->` and its supplied task brief. The model removes that marker only after replacing the placeholder with the requested draft or plan. The extension does not infer completion from agent termination or maintain a misleading completed-chapter counter.

Paths are resolved from command-time `ctx.cwd`. Managed descendants are checked with `lstat`; symlinks, junctions, multiply linked files, path traversal, device aliases, and alternate-stream names are rejected. External import sources are explicitly selected local text files; their parent is canonicalized. Checks cannot prevent hostile filesystem mutation between validation and use. Model file tools are not sandboxed by this package.

## Bounds and failure handling

- Command input: 8,192 characters.
- Task brief: 4,000 characters.
- Title: 160 characters; style: 240; genre: 160; language: 80.
- Metadata/checkpoint reads: 16 KiB; selection: 1 KiB.
- Discovery: at most 4,096 entries per scanned directory.
- Numbered units: four digits, with no overwrite on exhaustion.
- Handoff: paths and task data, not whole manuscripts; at most 30 numbered paths, ordered by modification time across unit folders.

Errors are displayed without starting an agent turn. Noninteractive status uses a non-triggering custom message because UI notifications are unavailable. Cancellation before local preparation makes no files. A failure after preparation may leave a valid scaffold or placeholder, which the error message explicitly preserves for inspection.

The model owns manuscript saves and checkpoints. Prompt contracts require reading saved state, distinguishing proposals from canon, preserving originals, and verifying saved artifacts. No deterministic semantic continuity engine is claimed.

## Research provenance and scope

The implementation and skill prose in this package were authored for this repository. It does not vendor upstream code, prompts, agents, hooks, or their executable helpers. The following projects informed the capability survey:

| Reference | Ideas considered | Deliberately not imported |
| --- | --- | --- |
| [haowjy/creative-writing-skills](https://github.com/haowjy/creative-writing-skills) | Voice profiles, craft specialization, reader response, saved story memory | Claude/Meridian orchestration and setup |
| [danjdewhurst/story-skills](https://github.com/danjdewhurst/story-skills) | File-based story projects, continuity and series organization | Its CLI, schemas, deterministic continuity engine |
| [YangsonHung/awesome-agent-skills](https://github.com/YangsonHung/awesome-agent-skills/tree/main/skills/en/novel-writer) | Bounded novel planning, continuation, character and world workflows | Its prompt text and mandatory structural defaults |
| [zenstory-ai/oh-story-claudecode](https://github.com/zenstory-ai/oh-story-claudecode) | Serial-fiction workflows, emotional arcs, import and continuation | Market scraping, browser helpers, platform hooks, cover generation |
| [JimLiu/baoyu-skills](https://github.com/JimLiu/baoyu-skills/tree/main/skills/baoyu-comic) | Separate visual format, tone, and storyboard work | Educational-comic pipeline, image backends, rendering scripts |

This is a unified writing suite, not a promise of feature-for-feature compatibility with those repositories. If future changes copy upstream material, preserve its license and attribution and pin the exact source revision instead of treating this table as a substitute license notice.

## Automated validation

From the repository root:

```bash
npm --prefix pi-package-writer run check
npm --prefix pi-package-writer test
cd pi-package-writer
npm pack --dry-run
cd ..

git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'
```

With Pi installed, run the offline RPC smoke test against its CLI entry:

```bash
npm --prefix pi-package-writer run smoke -- /path/to/pi-coding-agent/dist/bundle/cli.js
```

The smoke test creates disposable workspace and agent directories, disables startup network activity, excludes inherited credentials, and verifies discovery of the command and all 18 skills. It exercises help/list/open/status, menu cancellation, and session replacement without invoking a model or editing real Pi settings.

Tests cover parsing, Windows paths, limits, scaffolding, restart/resume, concurrent reservation, collisions, corrupt metadata, unsafe paths, junctions, hard links, cancellation, missing tools/model, busy handling, read-only review dispatch, import/adaptation routing, skill metadata, local documentation links, and package inclusion declarations. Beginner coverage includes empty-input onboarding, all dialog cancellations, persisted guidance, per-task overrides, older manifests, existing-project coaching, learning-file protection, invalid preferences, and preserving read-only review.

`check` is a syntax check, not a full TypeScript typecheck. Command integration uses a mock Pi API and does not prove live model behavior or every RPC client's dialog support. Inspect the packed file list to ensure all referenced skill resources ship and tests/private manuscripts do not.

## Manual writing evaluation

Use a scratch workspace and disposable fiction, not a private manuscript. Compare output against a no-skill baseline using the same model and brief.

1. Draft the same reunion in emotional/ restrained and epic/ lyrical voices. Check that the difference is deliberate craft rather than adjective changes.
2. Start a light novel, approve its opening, draft a chapter, restart Pi, and continue. Verify that the next turn reads the saved files and respects the established language, POV, and character knowledge.
3. Interrupt a chapter after reservation. Resume and confirm it does not count the placeholder as finished.
4. Seed two conflicting dates and a character who knows a secret too early. Ask for a review. Check evidence coverage and confirm no files changed.
5. Adapt a prose scene into manga and then webtoon. Check drawable panels, dialogue density, reading direction, and page-turn versus scroll reveals.
6. Import a manuscript containing a complete chapter and a fragment. Verify source preservation and explicit approval before inferred canon is adopted.
7. Run `/writer start` with no idea. Check that the model offers a manageable starting point and asks one question, rather than presenting a course or lengthy outline. Ask what a scene is and check for a short explanation tied to the emerging story.
8. Choose to write an exercise yourself. Confirm that the model waits rather than completing it. Submit a small attempt and look for specific feedback on one strength and one improvement, with no invented claims about your ability.
9. Restart after saving a learning step, then run `/writer continue`. Verify it resumes that exercise. Try `/writer coach` on an older project and `--guidance standard` on a beginner project; check that neither changes the saved preference.

Record the model, prompt, inspected files, results, and failures. Do not treat a passing routing test as evidence of good fiction or flawless continuity.
