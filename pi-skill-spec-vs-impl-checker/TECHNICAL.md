# Technical reference: Spec Vs Impl Checker

Advanced user inputs, evidence, compatibility, and limitations.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Install

```bash
pi install npm:@firstpick/pi-skill-spec-vs-impl-checker
```

## Canonical source and comparison scope

Provide a specification, plan, issue, or documented promise and the implementation to compare. The skill preserves canonical identifiers and records the source version. It does not require a combined plan or named agents.

Identify whether the target includes committed, staged, unstaged, or relevant untracked changes. A committed diff alone does not describe an uncommitted implementation. Conflicting intent remains an open decision until the contract is established.

## Two evidence dimensions

Implementation can match on inspection, be partial, missing, deviated, or ambiguous. It can also be not inspected or inaccessible. A user-reported description is not direct inspection; inaccessible means an attempted read failed. Ambiguity refers to unresolved intent.

Validation records passed relevant checks, failed checks, unrun checks, inadequate tests, blocked checks, or inspection-only evidence. These gaps can coexist. An inadequate test is not made sufficient merely by running it, and a test file's existence does not prove a requirement.

## Finding content and limits

Findings connect a source requirement or realistic failure scenario to the affected code, consequence, and evidence. Scope drift is assessed separately from missing functionality. Preferences are not contract violations. A requirement is called verified only when relevant evidence against the target state supports it, with remaining limits explicit.

## Read-only operation

Comparison does not authorize a fix, tracker update, or persisted report. Authorized checks can run when useful and available, with commands, outcomes, environment, and omissions recorded. If saving is requested, use the established project record rather than global memory.
