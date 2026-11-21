# Technical reference: Test Plan Generator

Advanced user inputs, evidence, compatibility, and limitations.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Install

```bash
pi install npm:@firstpick/pi-skill-test-plan-generator
```

## Accepted input shapes

Use the requirements, issue, diff, bug report, or plan you already have. Architecture and test evidence are useful when available. The skill does not require a combined plan, a completion report, or a particular directory structure, and it preserves existing requirement identifiers.

## Priority and boundaries

Priority follows consequence, likelihood, exposure, and the cost of late detection. Concurrency, accessibility, security, and recovery are not inherently optional. Each proposed test names the observable outcome, an independent expected value, its boundary, and what that boundary misses.

Algorithm tests, dependency contract checks, and end-to-end tests serve different purposes. A scenario should appear at multiple layers only when each catches a distinct failure. Test doubles can provide controlled faults or timing, with relevant real-dependency behavior checked where substitutes could drift.

## Reading the plan's evidence

Planned cases do not establish implementation or execution. Existing cases can be unrun, inadequate, passed, failed, or blocked. Several gaps can coexist: a test that only checks a cancellation callback can be both inadequate for file cleanup and unrun on the target revision.

Requirement mapping, executed behavior checks, and measured code coverage are reported separately. A percentage needs its actual denominator; a test count is not a coverage calculation. The skill uses coverage targets only when you or the project established them.

## Optional test-writing guidance

When code-quality is available, its discovered testing reference offers additional examples. The planner remains usable without that package and does not assume a sibling source checkout. Planning alone does not authorize test edits, package installation, or external tracker writes.
