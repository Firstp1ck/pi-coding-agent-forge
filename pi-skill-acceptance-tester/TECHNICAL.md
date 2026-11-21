# Technical reference: Acceptance Tester

Advanced user inputs, evidence, compatibility, and limitations.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Install

```bash
pi install npm:@firstpick/pi-skill-acceptance-tester
```

## Defining the assessed state

Provide the target revision or worktree, the agreed completion criteria, and required environment or rollout conditions. Existing project gates remain binding. When criteria or access are missing, the assessment identifies exactly which conclusion cannot be reached.

Evidence is tied to a revision and environment. A green report from an earlier commit can suggest checks to repeat, but it does not validate changed code. Source inspection, relevant execution, and requirement mapping are different evidence.

## Readiness outcomes

| Outcome | Recommendation | Meaning |
| --- | --- | --- |
| PASS | Go within the assessed scope | Applicable required gates passed with current evidence. |
| CONDITIONAL PASS | Go within accepted conditions only | The responsible person/process explicitly accepted named exceptions, and all remaining required gates passed. |
| FAIL | No-Go | A required gate demonstrably failed or a blocking defect remains. |
| INCOMPLETE | No-Go | Required evidence, access, or a consequential acceptance decision is unavailable. |

An inadequate or unrun test leaves runtime verification incomplete unless a separate explicit project gate already fails on test adequacy. Missing proof is different from proof of broken behavior. Mixed failures and evidence gaps are reported as FAIL with the unverified gates still listed.

## Coverage and retesting

No default coverage threshold is imposed. An agreed target can remain a required gate, with its metric and limitations stated. After authorized fixes, failed and affected regression checks are repeated; project-wide gates still apply when required.

## Authority and report storage

A readiness review does not authorize edits, deployment, release, or publication. Accepted exceptions must come from the responsible user/process. Reports stay in the conversation unless saving is requested or required by the authorized workflow.
