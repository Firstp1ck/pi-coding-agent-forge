---
name: feature-development-workflow
description: Feature implementation workflow for authorized new capabilities. Use to classify a feature as lightweight or complex, resolve blocking decisions, and govern implementation, integration, review, reporting, and completion without applying complex gates to non-feature work.
license: MIT
compatibility: Portable Agent Skills-style skill. The core requires no harness-specific tool; complex features require a harness that can provide the mandated delegated implementation and independent review outcomes, or an explicit user waiver.
---

# Feature Development Workflow

Use this skill for a user-authorized request to deliver a **new capability**. It preserves decision, implementation, review, and completion evidence while scaling the process to the feature's actual risk and scope. It is guidance, not a runtime guard: loading this skill does not install a package, enable an integration, change settings, or create hard enforcement.

## When to Use

Use when the request adds a user-visible, product, system, interface, workflow, or integration capability and the agent is expected to implement it.

Do not use for:

- Bug fixes that restore documented or intended existing behavior.
- Refactors with no new capability.
- Documentation-only, test-only, formatting-only, or dependency-maintenance work.
- Planning, research, review, troubleshooting, incident response, operations, or a question without requested feature delivery.
- Installation, enablement, publication, deployment, or configuration changes unless that action is separately authorized.

### Should trigger

- “Add a workspace export feature with authorization rules and a CSV download.”
- “Implement a new notification preference channel and migrate existing defaults.”
- “Create a small user-facing toggle that enables the requested display behavior.”
- “Build this new integration endpoint and deliver it with tests.”

### Should not trigger

- “Fix the crash when an empty CSV is uploaded.”
- “Refactor the cache module without changing behavior.”
- “Add API documentation and unit tests for the existing endpoint.”
- “Research options for notification providers before we choose one.”
- “Review this pull request for security issues.”

### Ambiguous requests

A request such as “add a tiny flag” may be a feature, a bug fix, or a configuration change. Inspect the affected behavior and user intent before routing. If it is feature delivery, classify it; otherwise use the workflow appropriate to the actual task.

## Invocation Design

- Invocation mode: model-invoked after explicit package enablement.
- Leading concept: **feature implementation workflow**.
- Route only when delivery of a new capability is requested; do not use this as a catch-all engineering process.
- Creation of this package is inert. Review it before any later installation or enablement, which requires explicit authorization.

## Inputs and Assumptions

Collect or establish:

- User outcome, scope, constraints, and explicit authorization for side effects.
- Relevant repository conventions, architecture, tests, deployment constraints, and existing interfaces.
- Decisions that affect scope, architecture, interfaces, security, migration, compatibility, reliability, or rollout.
- The available harness capabilities and any project planning/report conventions.

Do not ask again for a decision already answered by reliable project evidence. Do not begin implementation while a consequential blocking decision is unresolved.

## Portable Workflow

1. **Preflight the required capability**
   - Before entering a phase that mandates delegated implementation or independent review, verify that the selected harness can produce that outcome.
   - If the capability is unavailable, stop before that phase; report the unavailable capability and affected gate, then request an explicit user waiver or approved alternative. Do not silently lower a mandatory gate or claim completion.
   - Completion criterion: required capabilities are available, or a recorded explicit waiver/alternative exists.

2. **Inspect, decide, and classify**
   - Inspect the codebase, conventions, constraints, and relevant documentation. Resolve only consequential decisions; group unresolved questions with a recommendation and trade-off.
   - Record the classification rationale. A feature is **complex** when it has at least two meaningful implementation slices, crosses components or contracts, requires migration or rollout work, has material security or reliability risk, or benefits from separate implementation and test/hardening ownership. Otherwise classify it as **lightweight**.
   - Validate any injected or inherited preliminary classification against repository evidence. Reclassify only when recorded material evidence contradicts it; if any complex criterion is met, keep or change the classification to complex.
   - Completion criterion: the feature class and rationale are recorded, and no blocking decision remains.

3. **Follow the lightweight path when classified lightweight**
   - State success criteria, narrow scope, assumptions, and checks. Make the smallest safe implementation, run relevant checks, and report changed files, evidence, and residual risks.
   - A lightweight feature does **not** automatically require a canonical complex plan, two delegated implementation outcomes, two independent reviews, or an HTML report. Add only requirements that the user, repository, or actual risk independently requires.
   - Completion criterion: the requested capability is delivered within scope, relevant validation evidence is recorded, and remaining uncertainty is disclosed.

4. **Follow the complex path when classified complex**
   - Read [references/COMPLEX-FEATURE-CONTRACT.md](references/COMPLEX-FEATURE-CONTRACT.md) before implementation. Create the canonical plan, preserve its workstream boundaries, and use its mandatory implementation, integration, review, report, waiver, and completion conditions.
   - Completion criterion: the reference's complex completion checklist is satisfied; otherwise report the feature as incomplete.

5. **Keep authorization and evidence current**
   - Stop and resolve an unapproved product, scope, architecture, security, migration, compatibility, deployment, or interface decision before continuing.
   - Run affected and cross-workstream checks after integration. State checks not run, failures, waivers, and residual risks accurately.
   - Completion criterion: the final status distinguishes verified evidence from omissions, waivers, and risks.

## Safety and Side Effects

- Ask before external side effects, destructive actions, configuration changes, publication, installation, enablement, deployment, or overwriting user-authored work when authorization is unresolved.
- Keep implementation ownership isolated; do not let concurrent writers modify the same shared files without a defined integration sequence.
- Do not present model-invoked instructions as hard enforcement. Existing runtime controls, if any, remain separate.
- Do not replace missing mandated evidence with a self-check, a planning pass, a repeated run, or a claim that the work is probably complete.

## Scripts, References, and Dependencies

- `references/COMPLEX-FEATURE-CONTRACT.md` contains the portable contract for complex features. Read it only after classification selects the complex path.
- `tests/test_skill_contract.py` validates the routing, portability boundaries, and required policy terms using Python 3.10+ standard library only.
- `../../tests/routing/feature-development-workflow.json` contains repository routing examples relative to this skill directory.

No runtime package dependency is required. This package does not implement delegation, reviewer selection, runtime settings, or enforcement.

## Verification

From the package root, run:

```bash
npm test
npm pack --dry-run --json
```

For feature work, success means the classification, decisions, implementation, validation, and risks are evidence-backed. A complex feature is complete only under the contract reference; a lightweight feature is complete only under its scoped success criteria.

## Pi Adapter

- In Pi, read the active feature policy and the repository plan before beginning a governed feature workflow. The active policy owns feature outcomes and completion gates; delegation mechanics remain separate.
- Before a Pi phase that requires delegated workers or reviewers, verify the delegation capability for the current harness.
- Outside T3 Code, verify the `subagent` capability is active. Inside T3 Code, use its app-owned `delegate_task` capability, including harness-prefixed tool names, for implementation workers and independent reviewer runs. Discover current provider/model support with `orchestrator_capabilities`; do not infer usability merely from a catalog entry.
- An available T3 `delegate_task` satisfies the `subagent` capability requirement; do not ask for a waiver or extra implementation approval solely because Pi's native `subagent` tool is absent. This changes the delegation mechanism, not required worker outcomes, review independence, authorization, or completion evidence.
- If the selected harness cannot provide a mandatory delegation outcome, stop before that phase and ask the user for an explicit scoped waiver or approval of a named alternative.
- Use Pi's repository-reading, file-editing, and validation tools to inspect evidence, make bounded changes, and verify commands. Use the Pi progress UI for multi-step work when available.
- For a complex feature in Pi, place the canonical plan under the repository's planning convention (otherwise `plans/planned/<feature-slug>.md`), preserve one integration owner, and save the final report under the repository's report convention (otherwise `reports/<feature-slug>.html`). Use the `html-report` skill for that report when it is available.
- Do not install this package or modify Pi settings without explicit user confirmation. A later approved local installation may use `pi install <absolute-path-to-package>`.
