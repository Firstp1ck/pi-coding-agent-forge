# Development guide: Requirements engineering

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Package contents

- `skills/requirements-engineering/SKILL.md` contains routing, the problem/requirement/solution separation, evidence and approval boundaries, the five working modes, the requirement template and quality check, saving rules, and Pi notes. It tells the model to answer in the user's language.
- `skills/requirements-engineering/references/GLOSSARY.md` contains concise source-grounded terms and separate skill-specific working language.
- `skills/requirements-engineering/references/RECORDS.md` contains adaptable project-record and plan-step templates.
- `skills/requirements-engineering/references/WORKING-DOCUMENTS.md` contains method selection, draft document templates, readiness checks, and review guidance.
- `skills/requirements-engineering/references/EXAMPLES.md` contains four fictional end-to-end teaching and evaluation scenarios.

`README.md`, `TECHNICAL.md`, and `DEVELOPMENT.md` are included in the npm tarball so their relative navigation links work after packaging. The source PDF is excluded. The package has no runtime dependencies.

## Design contract

The skill selects one of five working modes from the user's situation: A preparation, B live elicitation, C evaluation of notes or documents, D alignment and conflict resolution, and E change of an agreed requirement. Modes can switch mid-conversation. Every response ends with a concrete next step naming who acts and what makes it done.

Every documented requirement links to a problem entry (`P-<number>`). Solution proposals are recorded but traced back to their problem before becoming requirements.

Evidence and authority states remain separate: stakeholder statement, document claim, code observation, and model inference; draft, completed activity, interpretation, and participant-confirmed summary; content readiness, agreement, implementation approval, and implementation evidence. The requirement template carries separate `Status`, `Agreed by`, and `Approved for implementation` fields for this reason. The agent may propose priorities but never sets them.

Candidate continuation plans are listed and confirmed before use; the newest is never chosen by default. Bounded, read-only project discovery precedes questions when working in a project directory. One canonical requirement register or an established tracker is used. Changes to agreed material require a change preview and confirmation from the responsible authority. Failed reads, writes, or optional integrations result in an honest limitation and next action, never fabricated state.

Versions up to 0.1.0 used a nine-step workflow with a mandatory plan-confirmation gate and an optional, plan-linked Grill Me interview. The mode-based skill replaced it. Grill Me integration was removed deliberately; the contract test asserts its absence. The four reference files were kept and stripped of Grill Me content.

## Source basis

The method and glossary guidance paraphrases:

> IU Internationale Hochschule. *Requirements Engineering*. IREN01, version 003-2023-0817. PDF pages 14-20, 24-35, 38-52, 58-68, 101-102, and 120-149.

Page numbers refer to the PDF, not printed footer numbers. The package must not include the PDF or large excerpts. Preserve source identity and page citations when changing source-derived guidance. Mark workflow terms introduced by this skill instead of attributing them to the source.

## Maintenance boundaries

Review `SKILL.md`, the references, `tests/contracts.test.mjs`, and the scenario fixtures together when changing routing, modes, record states, approval boundaries, or completion outcomes. Keep the long templates in references so normal invocation does not load them unless needed.

Do not add a fixed phase order. The source describes elicitation, documentation, review, alignment, and management as recurring work shaped by the project situation. Do not add a universal requirements template or automatic authority assumptions.

Package creation does not authorize installation, enablement, publication, contact with stakeholders, or writes to another project. Those are separate user decisions.

## Verification

From a source checkout with Node.js 18 or later and npm, run:

```bash
npm test
npm pack --dry-run --json
```

`tests/contracts.test.mjs` checks fixture structure, negative mutations, routing examples, package resources, local links, fences, and the dry-run archive. Tests and scenario fixtures are contributor resources in the source checkout, not included in the npm archive. `tests/scenarios/README.md` documents the semantic evaluation procedure for the 38 inputs and their separate rubrics. The contract test also asserts key safety sentences in `SKILL.md`; update those assertions when rewording them. Static test counts do not measure conversational coverage.

For version 0.1.0, the installed Pi skill loader was also exercised directly against this package and returned one skill with no diagnostics. This checks discovery, not interactive invocation. Transcript simulations inspect answer quality without live project writes or questionnaire dialogs. `tests/scenarios/EVALUATION.md` records evaluations of the 0.1.0 skill only, including live persistence, update, write-failure, and questionnaire checks run on 2026-09-26. The mode-based skill has not been model-evaluated yet.

From the repository root:

```bash
git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'
```

Also inspect the dry-run file list, resolve every local Markdown link, check balanced fences, and confirm that no PDF or runtime dependency is bundled. Model-run scenario checks must evaluate behavior and source attribution rather than exact prose. An unavailable interactive UI or model evaluator is a named omission, not a pass.
