# Complex Feature Contract

Read this reference only after the portable workflow classifies a requested new capability as **complex**. It defines the mandatory evidence and gates for a complex feature. It does not prescribe a harness's worker-launch commands, reviewer-selection APIs, model identifiers, settings paths, or runtime enforcement; use the selected harness adapter for those mechanics.

## 1. Classification and blocking decisions

A complex feature has at least two meaningful implementation slices, crosses components or contracts, requires migration or rollout work, has material security or reliability risk, or benefits from distinct implementation and test/hardening ownership. Record the evidence for the classification and reclassify only when material evidence contradicts it.

Before implementation, resolve decisions that materially affect scope, architecture, interfaces, security, migration, compatibility, deployment, or rollout. Do not begin while a blocking decision remains unresolved. The decision record must distinguish approved decisions, assumptions, open risks, and explicitly rejected or deferred options.

## 2. Canonical plan

Create one canonical plan using the repository convention. It must include measurable success criteria; scope and non-goals; approved decisions and invariants; an execution DAG or waves; exact workstream boundaries and ownership; acceptance checks; integration and rollback guidance; risks; decision/progress records; and unique worker handoff artifacts.

Name one **integration owner**. Only that owner updates shared plan state and accepts integrated results. Workers read the plan, stay within assigned ownership, and report through their own unique handoff artifacts.

Completion criterion: the plan exposes an executable dependency order and makes every required outcome, owner, check, and rollback path inspectable.

## 3. Mandatory implementation outcomes

Design the plan for **at least two distinct implementation worker runs** with meaningful, independently verifiable deliverables. Planners, scouts, reviewers, repeated turns, token work, and filler changes do not count as implementation outcomes. If safe decomposition is impossible, redesign the work or obtain explicit user approval for an exception before implementation.

Preserve one-writer isolation and dependency order. Each worker handoff records its identity/status, changed files and summary, commands and exit codes, validation omissions, deviations/assumptions, unresolved decisions and residual risks, and integration notes.

Completion criterion: two qualifying implementation-worker outcomes exist, their actual changes and evidence are available for inspection, and no shared ownership conflict was silently accepted.

## 4. Central integration and validation

The integration owner centrally inspects both actual changes and their evidence rather than accepting completion claims. Resolve conflicts against approved decisions, preserve scope, and run affected plus cross-workstream checks on the integrated result. Record integration results, failures, and intentional omissions.

Do not continue through an unapproved product, scope, architecture, security, migration, compatibility, deployment, or interface decision. Do not call the feature integrated merely because independent branches pass in isolation.

Completion criterion: the integrated result passes its applicable checks, and the integration record identifies the evidence and any remaining limitation.

## 5. Independent review quorum and finding disposition

After integration, obtain **two distinct, read-only, fresh-context reviewer-run outputs**. Each independently assesses architecture, correctness, security, edge cases, tests, maintainability, and compliance with the plan and acceptance criteria. Use provider families distinct from each other and, when feasible, from the primary implementation provider if suitable models are available, authorized, and unblocked. Check current availability and known authentication, quota, rate-limit, outage, model-scope, and policy restrictions rather than treating a catalog entry as proof of usability. If no usable different-provider alternative exists, or an attempted alternative fails, continue with the same provider, including the same model in separate reviewer runs if needed. Record the fallback reason and evidence; no user waiver is required for provider or model reuse. Do not retry known-blocked alternatives merely to obtain diversity, bypass restrictions, or replace a still-live reviewer run. Worker self-checks, main-agent review, multiple roles in one run, and two outputs from one run do not count.

For every finding, record reviewer run identity and provider/model; affected file or symbol; violated requirement or failure mode; evidence and severity; and a disposition of `accepted`, `rejected`, `deferred`, or `needs verification`. The integration owner independently verifies every finding. Only verified, accepted findings may be implemented; accepted fixes require revalidation.

Completion criterion: the qualifying review quorum and every finding disposition are current in the canonical plan.

## 6. Final HTML report

Create a polished, self-contained HTML report at the repository report convention. The report links to the canonical plan, and the plan links back to the report. Include an executive summary, scope, design decisions, architecture, implementation map, testing and acceptance evidence, independent-review findings and dispositions, residual risks, and usage or rollout guidance. Use evidence-based diagrams, workflows, dependency/sequence graphs, tables, or other useful visuals where they clarify the evidence.

Completion criterion: the saved report is current, self-contained, evidence-based, and mutually linked with the plan.

## 7. Waiver and incomplete status

If a required capability or other prerequisite prevents a mandatory outcome, stop at that gate. Provider diversity alone is not a mandatory outcome; use the same-provider fallback in section 5 when needed. Report the exact limitation and affected gate, then ask the user to explicitly waive the gate or approve a named alternative. Do not silently substitute a weaker process, and do not mark the feature complete until the waiver or alternative is recorded and its conditions are satisfied.

A waiver is explicit, scoped, and recorded; it is not inferred from time pressure, an unavailable tool, a worker claim, or a failed retry.

## 8. Complex feature completion gate

A complex feature is complete only when the canonical plan records:

1. the required implementation-worker outcomes and central integration evidence;
2. current affected and cross-workstream validation evidence;
3. the qualifying independent review quorum and every finding disposition;
4. revalidation of accepted fixes;
5. the current self-contained HTML report linked with the plan; and
6. any explicit waiver or approved alternative required by an unavailable mandatory prerequisite.

Until all applicable items above are recorded, report the complex feature as **incomplete**. Do not downgrade this gate merely because the code appears finished.
