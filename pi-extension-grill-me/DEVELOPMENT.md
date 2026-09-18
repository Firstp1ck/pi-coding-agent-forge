# Development guide: Grill Me for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Architecture

`index.ts` owns the command prompt, project-local persistence, and the two Grill Me tools. `/grill-me` checks the UI mode and questionnaire registration before it creates state or sends the kickoff message. This ordering prevents an unavailable command from replacing an existing interview.

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
- record each explicit answer once and in questionnaire order;
- convert option IDs to visible labels and retain all multi-select and custom values;
- evaluate a completed round before opening another one;
- stop after cancellation or unavailability and save answered decisions as partial results;
- save final results only after all identified ambiguities are resolved.

When `/grill-me` receives no plan, it writes a sentinel plan to state and asks the model to use questionnaire intake. The protocol requires recording the resolved plan-intake answer before any codebase discovery or other turn, because the first resolved answer replaces that sentinel. A stop choice remains a recorded answer and leads to a partial save through the model-guided protocol.

## Tool contracts

### `grill_record_turn`

The tool records one question per call with these fields:

- `question`
- `recommendedAnswer`
- optional `userAnswer`
- `decisionStatus`, one of `resolved`, `open`, or `needs-codebase-check`
- optional `notes`

A resolved turn requires a non-blank `userAnswer`. The tool uses sequential execution so multiple answer writes cannot race inside Pi's normal tool scheduler. It keeps the existing one-question storage format, which also accepts visible labels joined with custom Other text for multi-select answers.

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
- sequential per-question persistence for multi-select and custom answers;
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
