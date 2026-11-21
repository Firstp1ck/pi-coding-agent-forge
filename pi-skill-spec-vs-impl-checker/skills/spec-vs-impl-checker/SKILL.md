---
name: spec-vs-impl-checker
description: Compare a specification, plan, issue, README promise, or acceptance requirement with implementation. Trace requirements to code and actual test evidence, identify scope drift and interface mismatches, and keep unknown or unexecuted checks explicit.
---

# Specification versus implementation

Check whether implemented behavior satisfies the requested contract. A comparison or review request is read-only and does not authorize fixes.

## Establish sources

Read the supplied requirement source and relevant project instructions. Use the canonical tracker or repository document; preserve IDs and cite its version, section, or revision. No particular plan filename, layout, or named review agent is required.

Identify the target revision, worktree changes, and validation evidence. A committed diff alone excludes uncommitted work; state the scope. Conflicting sources or ambiguous intent are open decisions, not implementation defects until the intended contract is established.

## Trace and verify

1. Extract observable requirements and constraints, including acceptance criteria, failures, compatibility, and migrations. Separate explicit requirements from inferred risks.
2. Find the implementing code and callers. Read actual behavior rather than inferring implementation from names or comments.
3. Inspect whether tests exercise the requirement through a suitable boundary and detect a wrong result. A passing assertion about an unrelated internal call is insufficient evidence for an external promise.
4. Run authorized focused checks when needed. Record commands, outcomes, revision/environment, omissions, and baseline failures. Evidence from another revision is not automatically current.
5. Compare interfaces: shapes and types, errors, ordering, state transitions, security constraints, cancellation, and cross-module interactions where applicable.
6. Identify added behavior beyond scope and removed constraints. Distinguish justified supporting changes from unapproved expansion.

## Evidence states

Keep implementation assessment separate from verification:

| Dimension | Values |
| --- | --- |
| Implementation | Matches on inspection / Partial / Missing / Deviated / Ambiguous / Not inspected / Inaccessible |
| Validation | Relevant check passed / Failed / Not run / Inadequate test / Blocked / Inspection only |

Use **verified** only when a relevant check actually passed against the target state and supports the requirement. Name the limits of manual or automated evidence; one passing example does not establish every case. No test and an inadequate test are different gaps.

Use Not inspected when implementation is only described by another source, and Inaccessible when inspection was attempted but access failed. Ambiguous describes unresolved intent, not missing code access. Validation gaps can coexist: an existing test can be both inadequate and not run while CI is blocked. Preserve each material limitation rather than forcing one label to hide the others.

## Findings and output

For substantial work, use a table with requirement source, implementing files/symbols, evidence and limits, both assessment dimensions, and gaps. For a small task, concise findings suffice. Any percentage must identify its denominator and whether it describes mapping or executed checks.

Each finding names the location, source requirement or concrete failure scenario, consequence, and minimal remediation. Label inferred risks; do not present a preferred design as a violated requirement. Route unresolved decisions to the user or actual project owner, without assuming particular agents exist.

Keep the result in chat unless an artifact was requested or required by the active workflow. Save only to the established authorized repository location or tracker. Report inaccessible sources and unrun checks rather than fabricating a complete trace.
