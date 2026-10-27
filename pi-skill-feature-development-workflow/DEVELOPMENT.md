# Development guide: Feature Development Workflow

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Package contents

- `skills/feature-development-workflow/SKILL.md` — routing, portable workflow, lightweight path, safety rules, and Pi mapping.
- `skills/feature-development-workflow/references/COMPLEX-FEATURE-CONTRACT.md` — canonical-plan, implementation, integration, review, report, waiver, and complex-completion requirements.
- `skills/feature-development-workflow/tests/test_skill_contract.py` — standard-library contract test.
- `tests/routing/feature-development-workflow.json` — positive, negative, and ambiguous routing cases.

## Intended routing

Use for a user-authorized request to add a new product or system capability where implementation workflow governance is needed. Do not route bug fixes, refactors, documentation-only or test-only work, planning/research/review alone, troubleshooting, operations, or questions that do not request feature delivery.

## Verification

```bash
cd <package-root>
npm test
node -e "JSON.parse(require('node:fs').readFileSync('tests/routing/feature-development-workflow.json', 'utf8')); console.log('routing JSON: PASS')"
npm pack --dry-run --json
```

Tests require Python 3.10+ and use only the standard library. The package has no npm runtime dependencies.

The adapter contract tests preserve native Pi `subagent` support while accepting T3's app-owned `delegate_task`, including harness-prefixed names. They also require provider/model discovery through `orchestrator_capabilities`, retain fail-closed delegation outcomes and keep harness-specific mechanics outside the portable workflow.
