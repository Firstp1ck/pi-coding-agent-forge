---
name: architecture-review
description: Review module boundaries, interface contracts, dependencies, and design trade-offs before implementation or during an architectural refactor. Ground recommendations in actual callers, change patterns, failure modes, and verification needs.
---

# Architecture review

Evaluate whether the design makes the project's real changes easier and safer. A review request stays read-only; recommendations do not authorize implementation or persistent notes.

## Scope and evidence

Read project instructions, the relevant design or plan, existing decisions, callers, and tests. Follow the repository's terminology and documentation layout. Identify the concrete problem: repeated cross-module edits, misunderstood ordering, difficult failure handling, slow verification, or an upcoming capability. Without a named area, use recent change history to choose a bounded scope.

Distinguish observed code, proposed design, and assumptions. Respect an existing ADR unless new evidence justifies revisiting its trade-off. Missing sources are a limitation, not permission to invent requirements.

## Review process

1. **Describe the interface callers actually rely on.** Include inputs, outputs, invariants, ordering, errors, side effects, configuration, and relevant performance constraints. Types alone are not the whole contract.
2. **Trace ownership and dependencies.** Show where state and decisions live, which knowledge crosses boundaries, and whether dependency direction matches responsibility. Classify dependencies as in-process computation, local infrastructure, owned remote systems, or third-party services before choosing adapters and tests.
3. **Evaluate what each abstraction hides.** If removing it makes complexity disappear, it may be forwarding without adding value. If removing it scatters policy or error handling across callers, it is earning its place. Explicit validation, resource ownership, or compatibility can justify a thin wrapper.
4. **Follow a representative change.** Name the modules it would touch. Keep related behavior and verification together; do not combine unrelated responsibilities merely to minimize the interface.
5. **Check the test boundary.** Can callers and tests exercise important behavior through a stable contract? Keep useful internal algorithm tests. Compare substitutes with the real dependency's relevant semantics rather than assuming a fake proves integration.
6. **Compare proportionate alternatives.** Include keeping the current design when viable. For a consequential interface decision, compare a materially different design with usage examples, migration cost, and failure behavior. Delegation is optional and follows the active harness policy.

## Long-term contract checks

Apply only the concerns the change actually touches:

- Compatibility with existing callers, external consumers, and supported data formats.
- Persisted-state migration, mixed-version operation, and rollback or forward-recovery limits.
- Ownership of resources, cancellation, timeouts, bounded retries, and partial failures.
- Concurrency, idempotency, and invariants during interrupted or repeated operations.
- Operational signals that distinguish success, failure, and degraded operation.

Do not invent line-count, dependency-count, or inheritance quotas. Splitting, abstraction, messaging, and dependency injection each need a concrete benefit. One production implementation can justify an interface when it enforces ownership or isolates a volatile dependency; a second implementation is not a universal prerequisite.

## Findings and verification

For each finding, provide the affected interface and code evidence, a realistic change or failure scenario, its consequence, and the smallest justified remedy. Separate defects from preferences and unverified risks. State what an improvement would make easier to change or verify and what it would cost.

For proposals, name the checks needed to validate them. For an implemented design, inspect relevant tests and run authorized checks when useful. Package dependency tools do not by themselves describe source-module structure or prove an absence of cycles. Never claim a check ran from a suggested command alone.

Deliver a compact structure/dependency map when helpful, prioritized findings, retained strengths, and unresolved decisions. Save ADRs or reports only to an authorized repository location or established tracker. Do not write project architecture into global agent memory or require named agents from another environment.
