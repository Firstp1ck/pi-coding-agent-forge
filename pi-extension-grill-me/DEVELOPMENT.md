# Development guide: Grill Me for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Architecture

`index.ts` owns the command prompt, project-local persistence, and the three Grill Me tools. `/grill-me` checks the UI mode and questionnaire registration before it creates state or sends the kickoff message. This ordering prevents an unavailable command from replacing an existing interview.

The interview loop remains model-guided. The command sends a protocol that tells the model how to build rounds, handle questionnaire results, record answers, and save complete or partial results. There is no deterministic interview state machine in this extension. Tests can verify the generated protocol and runtime boundaries, but they cannot prove that an arbitrary model will obey every instruction.

## Questionnaire loading

The package declares `@firstpick/pi-package-questionnaire` as an exact runtime dependency and lists it in `bundledDependencies`. Pi packages use separate module roots, so the dependency must be present in the Grill Me tarball.

The package manifest exposes only the Grill Me entry point. During `session_start`, that entry point checks `pi.getAllTools()`:

1. If a `questionnaire` tool already exists, Grill Me keeps it and does not register another one.
2. Otherwise, Grill Me imports the bundled questionnaire factory and registers its tool.
3. A second check after the import protects against another extension registering the tool while the import is pending.
4. An instance flag prevents repeated session hooks from registering the bundled tool again.

This supports standalone installation and coexistence with a separately loaded questionnaire package without adding a global registry.

The dependency's skill file ships with the bundle but is intentionally not registered as a Pi skill by Grill Me. The tool already supplies its schema and usage guidelines. Grill Me supplies its own interview protocol, including stopping rather than asking in chat when a questionnaire is cancelled or unavailable. If a separately loaded questionnaire skill suggests a chat fallback, the kickoff prompt explicitly replaces that advice for the active Grill Me interview.

## Command protocol

The kickoff prompt requires the model to:

- inspect the codebase before asking for facts the project can answer;
- group currently independent decisions into rounds of no more than 20 questions;
- use questionnaire for every initial and follow-up decision;
- give each question stable IDs, choices, Other support, and a recommendation;
- resume clarification with the exact questionnaire ID and revision;
- record all newly returned explicit answers in one `grill_record_turns` call, in questionnaire order, with one question per entry;
- skip empty batches and never replay already recorded answers after clarification;
- convert option IDs to visible labels and retain all multi-select and custom values;
- evaluate a completed round before opening another one;
- stop after cancellation or unavailability and save answered decisions as partial results;
- save final results only after all identified ambiguities are resolved.

When `/grill-me` receives no plan, it writes a sentinel plan to state and asks the model to use questionnaire intake. The protocol requires recording the resolved plan-intake answer before any codebase discovery or other turn, because the first resolved answer replaces that sentinel. A stop choice remains a recorded answer and leads to a partial save through the model-guided protocol.

## Tool contracts

### `grill_record_turns`

The preferred questionnaire recording tool accepts `{ turns: [...] }` with 1–20 entries, matching the questionnaire round limit. Each entry has these fields:

- `question`
- `recommendedAnswer`
- optional `userAnswer`
- `decisionStatus`, one of `resolved`, `open`, or `needs-codebase-check`
- optional `notes`

A resolved turn requires a non-blank `userAnswer`; notes are not an answer. Validation checks every entry before reading or changing state. Invalid batches throw an error for Pi to report as a tool failure, without saving any turns. The error identifies the entry when a resolved answer is missing. Answers are trimmed, and all optional notes and statuses are preserved.

Both recording tools share `recordTurns`, which queues the entire read-modify-write window with Pi's `withFileMutationQueue` and writes state once per call. Both also declare sequential execution. This protects recording calls within one Pi process, not concurrent processes or an overlapping `/grill-me` state reset. File writes retain the existing persistence behavior; this is not crash-safe transactional storage.

The batch response reports `Recorded N grill turns (#first–#last)`, with `details.path`, total `details.count`, and the newly `details.recorded` count. Each turn remains separate in state and Markdown. A one-entry batch supports plan intake and partial questionnaires. Empty batches are rejected.

The model converts option IDs to visible labels and includes every selected label and custom Other value in `userAnswer`. It must submit only new answers after resume. Recording is append-only, without automatic retry deduplication.

### `grill_record_turn`

The existing single-question tool accepts the same fields directly and retains its successful response and count. Use it for individual answers or codebase discoveries. Questionnaire rounds should use `grill_record_turns` instead. Both tools apply the same validation; validation failures now throw rather than returning an `isError` field that Pi ignores on successful execute returns.

### `grill_save_results`

The tool reads the active state and renders Markdown. It accepts an optional project-relative output path, shared-understanding summary, agreed decisions, open risks, and next decision. The default path is `GRILL-ME.md`. Path resolution rejects writes outside the project root.

## Persistence format

State lives at `.pi/grill-me/state.json` under the active project. It contains timestamps, the project directory, the interview plan, and an ordered array of turns. This file-based format predates questionnaire rounds and remains unchanged.

`grill_save_results` renders that state with the plan and each recorded turn. Optional final or partial summary fields are appended as separate Markdown sections.

## Test design

`tests/grill-me.test.ts` uses a mock Pi API and temporary project directories. It covers:

- the generated round, clarification, cancellation, and partial-save instructions;
- plan intake and replacement of the missing-plan sentinel;
- UI, mode, missing-tool, and inactive-tool guards without state replacement;
- standalone bundled questionnaire registration, repeated hooks, and existing-tool coexistence;
- exact dependency and bundling metadata;
- ordered batch persistence and Markdown export for multi-select, custom answers, notes, and mixed statuses;
- schema and runtime batch limits, malformed entries, and invalid later answers without partial writes;
- single-entry plan intake, mixed single/batch recording, and concurrent recording without lost turns;
- prompt and tool guidance preferring batches, skipping empty results, and avoiding replay after resume;
- the existing record and Markdown save behavior.

Node's built-in TypeScript stripping normally rejects `.ts` files below `node_modules`. Pi itself loads extension TypeScript through jiti. The test-only `register-typescript.mjs` hook supplies equivalent type stripping so the bundled questionnaire factory can be exercised by the Node test runner.

## Local development

From this package directory, you can link the extension entry point into Pi's global extension directory:

```bash
ln -s "$PWD/index.ts" ~/.pi/agent/extensions/grill-me.ts
```

Run `/reload` in Pi after creating or changing the link. Local linking changes the active Pi setup and is separate from running the package tests.

## Validation

Run the package checks from `pi-extension-grill-me`:

```bash
npm test
npm run check
npm run smoke
npm pack --dry-run --json
```

When a change consumes questionnaire runtime behavior directly, also run from `pi-package-questionnaire`:

```bash
npm test
npm run check
```

The package dry run must include the bundled questionnaire entry point, runtime, skill, license, README, and package manifest. Inspect the tarball list rather than assuming a declared dependency was bundled.

For documentation changes, run the repository Markdown whitespace check and verify each relative link:

```bash
git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'
```
