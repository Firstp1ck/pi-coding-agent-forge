---
name: refactoring-advisor
description: Plan or carry out behavior-preserving refactors, migrations, duplication removal, and interface cleanup. Use concrete maintenance friction, characterization evidence, incremental changes, and compatibility checks rather than size thresholds.
---

# Refactoring advisor

Make the next real change easier while preserving the behavior callers depend on. A request for a plan or review does not authorize edits. Separate requested behavior changes from structural changes so their effects remain assessable.

## Establish the baseline

Read the relevant implementation, callers, tests, project instructions, and decisions. Identify the maintenance problem with a concrete example: the same policy changes in several places, resource lifetime is unclear, or a caller must understand internal ordering.

Inspect staged, unstaged, and relevant untracked work. Record the task's starting state; do not require committing, stashing, or discarding unrelated changes. Run focused existing checks when available. Distinguish baseline failures from regressions introduced by the refactor.

Use characterization tests where important existing behavior is not otherwise protected. Derive expected results independently from examples, documented contracts, or observed behavior. If behavior is disputed, resolve or record the conflict before encoding it as a permanent expectation.

## Choose the design

- Keep code that changes for the same reason together. Shared syntax with different ownership or contracts may deserve separate implementations.
- Ask what callers must know before and after: invariants, errors, ordering, configuration, and side effects as well as types.
- Remove forwarding layers only after checking whether they enforce validation, compatibility, observability, or resource ownership.
- Prefer a small interface that hides real complexity. Avoid replacing one difficult file with many shallow helpers that spread the same knowledge.
- Preserve useful public and internal test boundaries. A simpler interface does not automatically make algorithm-level tests redundant.

An available architecture-review skill can help with a consequential design decision; its absence does not block a bounded refactor. File length, field count, prop depth, or a preferred pattern alone is not evidence for restructuring.

## Incremental execution

1. State the preserved behavior and compatibility, intended design improvement, ownership, and checks that detect regressions.
2. Choose independently reviewable and verifiable steps. Keep intermediate states usable when possible. For an unavoidable atomic cutover, explain why, name the complete integration boundary, and defer success until it passes.
3. Run narrow affected checks after meaningful steps. Broaden checks when shared contracts, migrations, or new failures warrant it; do not repeat the entire suite after every edit without a reason.
4. Preserve failure handling, cancellation, resource cleanup, concurrency semantics, and persisted data behavior. Do not silently drop guards to simplify code.
5. Inspect the final diff and validate original caller scenarios, including relevant errors. Report pre-existing failures and unrun checks separately.

### Migration choices

- **Expand-contract:** add the compatible new form, migrate callers in dependency-aware batches, then remove the old form once usage and supported-version constraints permit it.
- **Branch by abstraction:** introduce a justified contract, move callers behind it, substitute the implementation, and retire the transition mechanism when no longer needed.
- **Incremental replacement:** route a bounded responsibility through the replacement, verify it, and migrate the remainder without maintaining competing sources of truth.

For persisted data, check mixed-version reads/writes and whether reversal is possible after new data is written. A Git revert is not a data rollback. Name restore or forward-repair limits when needed and do not execute destructive recovery without authorization.

## Deliverable and safety

For a plan, report the problem evidence, proposed contract, steps with checks, migration/recovery limits, and success criteria. Include deferred work in that response. For implementation, add actual changes, validation results, deviations, and remaining risks. Update a project tracker or repository record only when that write is authorized; naming a tracker as the source of truth does not authorize modifying it. Do not automatically write global memory.

Do not reset the workspace or commit all changes to create a checkpoint. If a task-owned step fails, repair or reverse only its isolated edits when safe. New dependencies, public behavior changes, or broader scope require existing authorization or a decision from the user.
