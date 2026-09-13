---
name: bounded-code-repair
description: Repair one focused, inspectable code behavior with a declared file boundary, actual validation, and a bounded retry count. Do not use for broad feature delivery, architecture decisions, security review, or documentation-only work.
license: MIT
compatibility: Portable Agent Skills-compatible workflow. The Pi adapter records scope, fresh-read write authority, dependency evidence, and host-observed validation through the reliability extension when available.
---

# Bounded code repair

Make the smallest patch that resolves one defined behavior, then prove the affected behavior with observed checks. A green command, a diff marker, or a model statement alone is not completion evidence.

## When to Use

### Should trigger

- “Fix the focused failing test in this named module and add a regression test.”
- “Make this small behavior-preserving refactor without changing the public API.”
- “Repair this parser result in the two named files, then run its targeted checks.”

### Should not trigger

- “Design and deliver a new multi-area feature.”
- “Audit the repository for security issues.”
- “Update prose only, with no code behavior change.”
- “Explain an unfamiliar repository without requesting a modification.”

## Invocation Design

- Invocation mode: model-invoked for a focused code patch with an inspectable target.
- Leading concept: **one behavioral objective inside one explicit write boundary**.
- Default scope: at most three files and one behavior; a user or governing workflow must explicitly widen it.
- Completion criterion: a minimal in-scope diff and fresh, relevant observed validation both support the stated acceptance criteria.

## Inputs and Assumptions

Establish the failing or desired behavior, acceptance criteria, allowed write paths, forbidden/shared paths, relevant symbols and callers, existing tests, exact validation commands, and any version-sensitive dependency surface. Repository instructions, user requirements, observed tool results, and model hypotheses remain separate trust sources.

## Portable Workflow

1. State one bug or bounded behavior and its acceptance criteria.
   - Completion criterion: the desired outcome is observable, not merely “improve” or “clean up.”
2. Inspect the target, callers, tests, and relevant configuration before mutation.
   - Completion criterion: the patch target and its expected effect are evidence-backed.
3. Declare the write boundary and forbidden/shared paths.
   - Completion criterion: a path outside the boundary has an escalation path rather than an implicit exception.
4. Check version-sensitive dependencies when the patch relies on a framework, library, runtime, CLI, API, or schema.
   - Completion criterion: advice is tied to the exact installed version and source, or the work stops as unknown.
5. Implement the smallest patch that satisfies the objective.
   - Completion criterion: the final diff has no unrelated cleanup, weakened tests, or broadened behavior without authorization.
6. Run targeted checks, then affected broader checks when warranted.
   - Completion criterion: a host-observed result supports each material criterion; unavailable checks remain unknown.
7. Inspect the final diff and retry at most twice after validation failure.
   - Completion criterion: each retry follows an observed failure; architecture, security, migration, dependency, or multi-subsystem decisions escalate.

## Safety and Side Effects

Do not write existing files without a completed fresh inspection of their current content. A partial inspection can authorize only an exact targeted edit entirely inside the inspected span; it never authorizes whole-file overwrite. Do not convert model claims, Markdown checkboxes, test names, or command text into evidence. Do not weaken tests just to obtain green output. Stop for scope drift, an unapproved dependency/version decision, unsafe migration, or exhausted repair attempts.

## Scripts, References, and Dependencies

No script or package installation is required. Read [code scope and validation](references/CODE-SCOPE-AND-VALIDATION.md) before widening a patch or interpreting validation results.

## Verification

Confirm the final diff stays in scope, fresh target reads preceded existing-file writes, expected tests/checks were observed and relevant, unrelated tests were not weakened, and failures/unknowns are reported rather than hidden. Record dependency evidence when an external versioned contract materially affects the patch; do not require it for purely local logic.

## Pi Adapter

- Do not repair against unconfirmed ordinary or queued corrections. `/reliability input confirm` establishes a new native instruction; it does not certify earlier delivery. Revalidate affected old proof after confirmation.
- Coding completion requires mapped host-observed executable validation; manual-only review is not a replacement. Recursive searches that include forbidden or protected descendants remain blocked: narrow the search root instead of relying on globs.

- Set an explicit coding scope with `reliability_scope`; the host enforces allowed paths, tools, budgets, and exact validation commands.
- Existing-file writes need receipt-bound fresh reads. A bounded partial read may support only a unique exact `edit` replacement wholly inside that span; `write` still needs a full current read.
- All `bash` and `powershell` validation use requires a current native-confirmed coding scope plus a single-use native approval for that exact normalized command. `/reliability map <criterion_id> bash <exact command>` maps evidence coverage only; it grants no shell permission.
- Use `reliability_evidence` action `record-dependency` for an external versioned contract after observing the manifest, optional supported lockfile, installed source, and relevant source passage through host receipts.
- The coding completion gate independently detects static external imports in changed code. A detected package needs current verified dependency evidence even when no declared criterion names it; ambiguous or non-code changes require an exact-diff local-only review rather than an exemption.
- Complete a complex canonical plan step only through `reliability_record_progress` or `reliability_submit_worker_result` with required host receipts/artifacts. Markdown is audit context, never completion authority.
