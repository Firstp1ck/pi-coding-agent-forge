---
description: Fix a reported issue end-to-end with focused changes and verification.
argument-hint: "[issue/context]"
---

Fix the reported issue end-to-end.

Issue/context: `$ARGUMENTS`

Workflow:
1. Read the reported symptom, applicable project instructions, affected code and tests, and current worktree state. Distinguish intended behavior, observed failures, and baseline failures.
2. Establish a repeatable signal for the actual symptom: a focused failing test, CLI/HTTP reproduction, trace replay, or relevant captured evidence. Run it before relying on it. For a straightforward cause, keep the investigation short. For an ambiguous failure, minimize the reproduction, rank falsifiable hypotheses, and test one distinguishing prediction at a time.
3. If the failing environment is unavailable, use logs/traces and bounded inspection, clearly label inference, and name the evidence that would confirm it. Do not claim a reproduction or verified fix you could not observe. Seek a missing consequential decision or access when it blocks safe progress.
4. Add a regression test at a boundary that catches the real bug when practical. Derive its expected result independently and observe it fail for the intended reason. Implement the smallest coherent fix while preserving compatibility, validation, resource cleanup, and cancellation behavior.
5. Re-run the original scenario and affected checks. For a performance regression, compare equivalent workloads and confirm result correctness. Remove temporary instrumentation and report root cause, changes, commands/results, and unverified limits.

Constraints:
- Keep changes focused.
- Avoid unrelated refactors unless required.
- If blocked, explain exactly what's missing.
- Redact secrets in commands, traces, and reports. Do not reset, stash, or commit unrelated work to obtain a clean reproduction.
- Investigation and test effort should follow risk. A simple fix does not require a full debugging ceremony, new dependencies, or delegation.
