---
name: test-plan-generator
description: Plan risk-based tests for a specification, change, migration, bug fix, or release. Map important behavior and failure modes to suitable test boundaries, existing evidence, and explicit verification gaps.
---

# Test plan generator

Produce a test plan someone can execute and assess. Planning a test does not mean it exists, ran, or passed.

## Inputs and scope

Discover the canonical requirements, issue, plan, architecture decisions, and test commands from the supplied context and repository. Accept a small diff or bug report without demanding a particular directory, combined plan, or completion report. Preserve existing requirement IDs; do not create a competing registry.

Read affected code and existing tests when available. Identify baseline failures, inaccessible environments, supported versions, and behavior needing verification. Missing or contradictory intent is an open decision, not an invented acceptance criterion.

## Planning process

1. Extract observable requirements, invariants, compatibility promises, and important failure paths. Include operational and non-functional constraints where relevant.
2. Prioritize by consequence and likelihood of failure, exposure, and difficulty of detecting it later. Data integrity, concurrency, recovery, security, and accessibility can each be release-critical. A test category never determines its priority by itself.
3. Choose the smallest stable boundary that detects each failure. Use focused unit tests for algorithms, contract/integration tests for dependency semantics, and end-to-end checks for important cross-system behavior. Name what each boundary misses.
4. Define independent expected outcomes using a worked example, specification, invariant, or trusted fixture. Recomputing the implementation's result is not an independent oracle.
5. Reuse existing meaningful coverage and identify actual gaps. Avoid duplicating a scenario across every layer without a distinct failure it would catch.
6. Sequence setup and checks by dependency. Recommend one failing behavior test and minimal implementation at a time when test-first work fits. Small behavior-preserving refactoring can happen while tests remain green.

## Test design guidance

Prefer real in-process collaborators. Use doubles when they provide a needed fault, timing, cost, or isolation boundary; verify their contract against the real dependency where drift matters. Do not mock internal calls merely to assert today's implementation.

For a confirmed bug, the regression test must fail for the original symptom. For migrations, include old/new compatibility and recovery constraints. For concurrency, control ordering when possible rather than relying only on stress. For performance, specify workload, correctness checks, and comparable conditions.

If code-quality is available, read its `testing.md` reference for detailed examples. Find that file in the references directory of the discovered code-quality skill, never this skill's directory or an assumed sibling checkout. This is optional; the guidance above suffices to produce the plan.

## Output and verification

Match detail to risk. A small fix may need a few cases; a substantial change benefits from a table:

| Requirement or risk | Scenario and independent expected outcome | Boundary and limits | Priority with reason | Existing evidence or gap | Command/environment |
| --- | --- | --- | --- | --- | --- |

Distinguish **planned**, **implemented but not run**, **passed**, **failed**, **inadequate**, and **blocked/not checked**. Inadequate means an existing test does not detect the required outcome; it may also be unrun or blocked. Record co-occurring gaps rather than implying that executing an inadequate test would verify the requirement. Link actual evidence when supplied and identify its revision/environment. Never describe a mapped requirement as behaviorally verified.

Keep requirement mapping, execution, and measured code coverage separate. Do not infer a percentage from test counts; mapping percentages require a defined requirement denominator and identifiable mapped items. Use coverage targets only when established by the project or user.

Conclude with critical-path execution order, unresolved acceptance decisions, and unavailable checks. Do not write files, alter tests, install tools, or contact another agent merely because a plan was requested; follow the user's authorized scope.
