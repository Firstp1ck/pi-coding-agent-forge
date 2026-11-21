# Tests that protect behavior

Read this reference when writing or substantially changing tests. Choose effort according to the failure being prevented; not every reversible edit needs a new test.

## Choose a boundary and an independent oracle

Name the user/caller behavior or invariant and a stable boundary that exposes it. Use a focused unit boundary for algorithms, an integration boundary for persistence or dependency semantics, and an end-to-end boundary when the cross-system path is the risk. State what the chosen boundary cannot catch.

Expected values come from the contract, a worked example, a trusted fixture, or an independently justified property. Repeating the implementation's calculation can reproduce its bug:

```typescript
// The contract says these two line items total 15.
expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
```

Calculating the expected value with the same reducer as `calculateTotal` would add little evidence. Property tests are useful when their property is independent, such as reversing twice restoring the input or a serialization round trip preserving a documented value.

## Implement one behavior at a time

When test-first work fits, write a focused failing test, run it to establish that it fails for the intended reason, implement the smallest coherent change, then refactor while the checks remain green. Avoid writing a large imagined suite before learning from the first working slice.

Use existing agreed interfaces and test conventions. Ask the user only when the test boundary would settle an unresolved product or public-contract decision, require a new dependency, or add material scope. Do not repeatedly request approval for routine test choices already within the task.

For a bug, demonstrate the original symptom failing before relying on the regression test. If the original version cannot be run, say so and distinguish inspection or a constructed reproduction from observed base-fails evidence. A failure caused by missing setup or a different exception does not prove the test catches the bug.

## Collaborators and test doubles

Prefer real deterministic in-process collaborators. Introduce a fake, stub, or mock for a concrete reason: injected faults, controlled time, unavailable services, slow infrastructure, cost, or isolation. The useful distinction is the contract being tested, not whether the dependency belongs to your team.

Avoid asserting internal call counts or order unless that interaction is itself the contract, such as one charge per idempotency key or closing a resource after use. Do not mock every collaborator merely to reproduce implementation structure.

Where a fake can drift from production, add representative contract/integration checks against the real implementation. An in-memory database does not establish production transaction, collation, or concurrency semantics.

## Retain the tests that catch distinct failures

Broader tests do not automatically replace lower-level tests. Before deleting a test, identify the behavior, edge case, precision, or diagnostic value it protects and demonstrate that retained checks cover it adequately. Preserve useful algorithm, characterization, security, and failure-path coverage.

Remove redundant or implementation-coupled assertions deliberately. Do not weaken expected outcomes, skip failures, or regenerate snapshots just to make a refactor pass. Inspect snapshot changes against the intended behavior.

## Long-term project checks

Select relevant cases, rather than applying this as a universal checklist:

- Compatibility with supported callers, versions, serialized formats, and persisted data.
- Migration phases, mixed-version reads/writes, and recovery after new data is written.
- Failure, cancellation, resource cleanup, bounded retries, and partially completed work.
- Concurrency and idempotency, using controlled ordering where possible; state the limits of stress runs.
- Performance under comparable conditions, with a correctness check and a baseline.
- Accessibility and security behavior when they are part of the requirement or affected failure path.

Report what ran against which revision/environment and what remains unverified. Keep planned cases, passing executions, requirement mapping, and measured code coverage separate. Static text checks on a skill validate its structure, not the behavior of a model following it.
