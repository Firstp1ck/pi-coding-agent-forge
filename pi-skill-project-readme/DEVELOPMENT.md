# Development guide: Project README

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Package contents

- `skills/project-readme/SKILL.md` — routing, evidence-first workflow, audience profiles, safety boundaries, and completion criteria.
- `skills/project-readme/references/PROJECT-README-TEMPLATE.md` — canonical adaptive README template and profile-specific ordering guidance.
- `skills/project-readme/references/PROJECT-TECHNICAL-TEMPLATE.md` — advanced user reference scaffold, user-operation boundaries, and navigation rules.
- `skills/project-readme/references/PROJECT-DEVELOPMENT-TEMPLATE.md` — contributor guide scaffold for architecture, interfaces, state, validation, and maintenance.
- `skills/project-readme/references/SECTION-DECISIONS.md` — rationale for including, conditionally including, relocating, or excluding README sections.
- `skills/project-readme/tests/test_skill_contract.py` — standard-library contract tests for routing and required workflow terms.
- `tests/routing/project-readme.json` — positive, negative, and ambiguous routing cases.

`TECHNICAL.md` and `DEVELOPMENT.md` are repository documentation and are intentionally excluded from the npm tarball, following neighboring skill-package convention. The published package includes the skill contract, references, tests, routing fixture, user README, and license.

## Intended routing

Use for requests to create, harmonize, restructure, audit, review, or update a project README. Separately approved companion creation may support that README task. Do not route requests whose primary outcome is writing a standalone technical or contributor guide, API reference material, release notes, generic prose, or unrelated implementation work.

The skill's model-invoked instructions guide behavior but do not install the package, modify runtime settings, or provide hard enforcement. Repository-local policy and explicit write authorization remain authoritative.

## Contract boundaries

The implementation must keep these behaviors aligned across the skill, template, references, and tests:

- inspect repository evidence before making project claims;
- choose a user-oriented or developer/library-oriented profile;
- preserve useful verified content in update mode;
- keep development and implementation information out of user-oriented READMEs;
- retain essential safety, privacy, destructive-operation, and compatibility warnings near affected user steps;
- require the visual-assets gate for visual user products without inventing images or features;
- ask independently for exact-path creation consent for each missing companion and record approved, declined, or unanswered decisions;
- create no declined, unanswered, empty, duplicate, or review-only companion, and preserve existing files unless their edits are authorized;
- keep advanced user operations in `TECHNICAL.md` and implementation, API/tool contracts, schemas, tests, and maintenance in `DEVELOPMENT.md`;
- write and verify approved destinations before removing relocated README content, and link only to existing destinations; and
- omit irrelevant optional sections rather than leaving empty scaffolding.

Changes to package naming, routing boundaries, profiles, required visual behavior, or documentation-layer policy are product-contract changes and should be reviewed together with the contract tests.

## Companion template evidence

The companion templates use the repository documentation layers in [AGENTS.md](../AGENTS.md) and these inspected package examples:

| Package documents | Patterns used |
| --- | --- |
| [Writer technical reference](../pi-package-writer/TECHNICAL.md) and [development guide](../pi-package-writer/DEVELOPMENT.md) | Complete user commands, requirements, storage, privacy, recovery, contributor setup, implementation contracts, state, and validation limitations |
| [Brave Search technical reference](../pi-extension-brave-search/TECHNICAL.md) and [development guide](../pi-extension-brave-search/DEVELOPMENT.md) | User configuration, credentials, commands, scheduling detail, and focused contributor checks |
| [HTML Report technical reference](../pi-skill-html-report/TECHNICAL.md) and [development guide](../pi-skill-html-report/DEVELOPMENT.md) | Skill requirements, contributor resource inventory, routing, and verification |
| This package's [technical reference](TECHNICAL.md) and development guide | Evidence rules, audience profiles, write scope, limitations, and bidirectional document navigation |

The examples inform section choices, not exceptions to policy. Some existing technical references mix in tool contracts or contributor details; the new technical template excludes those categories under `AGENTS.md` and places them in the development template instead. The templates remain self-contained in the published skill and do not require these sibling packages at runtime.

This is a lightweight skill-contract addition with no runtime implementation, migration, new dependency, installation, or publication. It adds two optional scaffolds and file-specific creation consent to one existing documentation workflow. The templates do not make every section mandatory, and consent instructions are not a deterministic write guard.

Contract tests check the consent instructions, review and existing-file boundaries, template layer separation, Markdown structure, resource references, and package inclusion. They do not execute a model conversation or prove that a model follows the guidance.

## Verification

From the package directory, run:

```bash
npm test
node -e "JSON.parse(require('node:fs').readFileSync('tests/routing/project-readme.json', 'utf8')); console.log('routing JSON: PASS')"
npm pack --dry-run --json
```

From the repository root, also run:

```bash
git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'
```

Tests require Python 3.10+ and use only the standard library. The discovery pattern in the npm test script uses double quotes so it works in both POSIX shells and npm's default Windows shell. Single quotes in the Windows npm script made the pattern literal and produced zero discovered tests. Review the dry-run tarball listing to confirm that only the paths declared in `package.json` are included. The package has no npm runtime dependencies.
