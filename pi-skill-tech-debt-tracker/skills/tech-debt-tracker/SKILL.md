---
name: tech-debt-tracker
description: Assess and prioritize technical debt from recurring maintenance friction, defects, reviews, or deferred work. Use evidence, affected change paths, cost of delay, and effort uncertainty to maintain a project-owned backlog without duplicating its tracker.
---

# Technical debt tracker

Record a deliberate trade-off or demonstrated maintenance cost, not every departure from a preferred style. A debt review is report-only unless updates to a project record were requested.

## Discover the source of truth

Read project instructions, the existing tracker/debt records, relevant decisions, and supplied findings. Preserve identifiers and links. Without a registry, propose a repository-owned location or return the backlog in chat. Do not create a second registry or automatically append project knowledge to global agent memory.

## Assess each candidate

- **Evidence:** a reproducible defect, repeated cross-module edits, measured verification cost, supported dependency risk, or a concrete upcoming change the design obstructs.
- **Consequence:** who pays the cost, how often, what can fail, and what delay changes. Distinguish observed cost from prediction.
- **Contract:** behavior, compatibility, ownership, and data constraints a remedy must preserve.
- **Options:** fix locally, schedule a broader change, contain the problem, or accept it. Small or duplicated code is not automatically debt.
- **Effort and uncertainty:** a supported range or relative size, dependencies, and investigation that could change the estimate. Do not invent deadlines from severity labels.

Categorize architecture, code, tests, documentation, dependencies, or operations when useful. Prioritize by consequence, recurrence, exposure, cost of delay, and effort. Priorities remain proposals unless already decided by the user or project process.

## Actionable records

Use the existing tracker format. Useful fields include identifier, evidence and revision/date, affected area, consequence, remedy, preserved contract, verification, owner or unresolved ownership, dependencies, effort uncertainty, rationale, and status.

Retain accepted trade-offs with reasons and revisit triggers. An intentional limitation becomes actionable when its assumptions change, not simply because it is old. Link ADRs rather than repeating decisions elsewhere.

## Verification and review

Before calling debt resolved, inspect actual changes and promised verification. A closed issue or worker claim is insufficient. Reassess recurring failures after the fix and keep residual work explicit.

Review relevant debt when starting work in that area, after incidents, or at the user's chosen cadence. Mark obsolete items with evidence rather than silently deleting them. Report trends only from comparable historical records; one snapshot does not establish growth or improvement.

## Output and safety

Return prioritized candidates with evidence, rationale, effort uncertainty, recommended actions, and limits. Keep immediate correctness/security defects distinct from optional improvements and surface urgent findings through the actual project process.

Do not install dependencies, rewrite code, create/close external issues, or write persistent records unless within existing authorization. For requested registry updates, preserve unrelated entries and report exactly what changed.
