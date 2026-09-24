# Development guide: Requirements engineering

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Package contents

- `skills/requirements-engineering/SKILL.md` contains routing, the portable workflow, approval boundaries, and the Pi adapter.
- `skills/requirements-engineering/references/GLOSSARY.md` contains concise source-grounded terms and separate skill-specific working language.
- `skills/requirements-engineering/references/RECORDS.md` contains adaptable project-record and plan-step templates.
- `skills/requirements-engineering/references/WORKING-DOCUMENTS.md` contains method selection, draft document templates, readiness checks, and review guidance.
- `skills/requirements-engineering/references/EXAMPLES.md` contains four fictional end-to-end teaching and evaluation scenarios.

`README.md`, `TECHNICAL.md`, and `DEVELOPMENT.md` are included in the npm tarball so their relative navigation links work after packaging. The source PDF is excluded. The package has no runtime dependencies.

## Design contract

The skill has three entry branches: start, update, and resume. Every branch ends with one of two outcomes:

- a maintained RE plan whose next step is ready; or
- a next-step guide that names the actor, action, reason, expected result, and completion evidence.

Plan discovery and user confirmation happen before a candidate continuation plan becomes active. Grill Me is optional and requires a separate user choice when a selected plan lacks a completed plan-specific interview. Without a selected plan or skill-owned record, the skill uses bounded, read-only project discovery.

The guidance uses one canonical requirement register and decision record, or links to an established tracker. Review, agreement, implementation approval, and implementation remain separate states. Failed reads, writes, or optional integrations result in an honest limitation and next action, never fabricated state.

## Source basis

The method and glossary guidance paraphrases:

> IU Internationale Hochschule. *Requirements Engineering*. IREN01, version 003-2023-0817. PDF pages 14-20, 24-35, 38-52, 58-68, 101-102, and 120-149.

Page numbers refer to the PDF, not printed footer numbers. The package must not include the PDF or large excerpts. Preserve source identity and page citations when changing source-derived guidance. Mark workflow terms introduced by this skill instead of attributing them to the source.

## Maintenance boundaries

Review these files together when changing routing, record states, approval boundaries, or completion outcomes. Keep the long templates in references so normal invocation does not load them unless needed.

Do not add a fixed phase order. The source describes elicitation, documentation, review, alignment, and management as recurring work shaped by the project situation. Do not add a universal requirements template or automatic authority assumptions.

Package creation does not authorize installation, enablement, publication, contact with stakeholders, or writes to another project. Those are separate user decisions.

## Verification

From a source checkout with Node.js 18 or later and npm, run:

```bash
npm test
npm pack --dry-run --json
```

`tests/contracts.test.mjs` checks fixture structure, negative mutations, routing examples, package resources, local links, fences, and the dry-run archive. Tests and scenario fixtures are contributor resources in the source checkout, not included in the npm archive. `tests/scenarios/README.md` documents the semantic evaluation procedure for the 38 inputs and their separate rubrics. Static test counts do not measure conversational coverage.

The installed Pi skill loader was also exercised directly against this package and returned one skill with no diagnostics. This checks discovery, not interactive invocation. Transcript simulations inspect answer quality without live project writes, questionnaire dialogs, or Grill Me state. Live persistence and interactive start/update/resume checks remain distinct from those simulations.

From the repository root:

```bash
git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'
```

Also inspect the dry-run file list, resolve every local Markdown link, check balanced fences, and confirm that no PDF or runtime dependency is bundled. Model-run scenario checks must evaluate behavior and source attribution rather than exact prose. An unavailable interactive UI or model evaluator is a named omission, not a pass.
