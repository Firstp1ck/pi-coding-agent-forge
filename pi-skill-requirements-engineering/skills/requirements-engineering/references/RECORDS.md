# Adaptable requirements records

Use these Markdown shapes only when the project lacks a canonical tracker or record format. Keep an established tracker canonical and link to its items instead of copying them. Ask for the writable location, language, privacy rules, retention rules, and approval authority before saving personal or sensitive material.

The forms below are starting points. Remove fields the project does not need. Keep evidence and authority fields that prevent a draft, inference, review, agreement, approval, and implementation from being confused.

## Record map

A small file set is usually enough:

- `overview.md` records the problem, vision, provisional context, stakeholder and source coverage, audience, and agreed domain glossary.
- `requirements.md` is the one canonical Markdown requirement register when no tracker already fills that role.
- `decisions.md` records decisions, conflicts, assumptions, and consequential open questions.
- `workflow-state.md` points to the confirmed plan or stores the current next-step guide. It also links to evidence and working drafts.
- `working-documents/` contains only drafts and results needed for current work.

Do not create all files by default. Start with the smallest record that preserves the evidence and next action.

## `overview.md`

```markdown
# Requirements overview: <project>

- Record owner: <person or role, or unknown>
- Last checked: <date and source>
- Preferred language: <language or unknown>
- Storage and retention limits: <limits or unknown>

## Business problem and intended outcome

- Problem: <confirmed statement, hypothesis, or unknown>
- Why it matters: <source-linked evidence or unknown>
- Intended outcome: <confirmed statement or open question>
- Current solution ideas: <ideas, not approved requirements>

## Provisional context

- Inside the proposed system boundary: <items or unknown>
- People and systems in the relevant context: <items or unknown>
- Outside the current context: <items and who confirmed this>
- Boundary questions: <unresolved questions>

## Stakeholders and sources

| Goal or topic | Relevant roles or sources | Contributed evidence | Missing voice | Confirmation still needed from |
| --- | --- | --- | --- | --- |
| <goal> | <roles, documents, systems> | <source links or none> | <role or none known> | <person, role, or process> |

## Readers and authority

- Intended readers: <audience>
- Who can confirm requirements: <people or process, or unknown>
- Who can approve implementation: <people or process, or unknown>

## Project glossary

| Term | Agreed project meaning | Confirmed by | Date or evidence |
| --- | --- | --- | --- |
| <term> | <meaning or disputed alternatives> | <person or role> | <link or unknown> |
```

## `requirements.md`

Use stable IDs and retain prior versions. If a field is relevant but unsupported, write `unknown` and assign the clarifying action. Link to an external tracker item when that is the canonical requirement.

```markdown
# Requirement register: <project>

## REQ-<number>, version <number>

- Type: functional | quality | constraint
- Status: candidate | needs clarification | ready for review | reviewed with findings | agreed | superseded
- Stability: low | medium | high | unknown
- Wording: <one clear statement>
- Business problem or goal: <link or unknown>
- Source or author: <person, role, document, observation, or code evidence>
- Owner: <person or role, or unknown>
- Dependencies: <IDs or none known>
- Priority: <value and decision source, or undecided>
- Normal path: <observable behavior or link>
- Relevant exceptions and failure paths: <behavior or unknown>
- Quality target and operating condition: <measure or not applicable>
- Acceptance or verification method: <testable method or unknown>
- Related documents, models, and checks: <links>

### Separate state evidence

- Readiness: <result, findings, reviewer, date>
- Stakeholder review: <who reviewed which version, findings, date>
- Agreement: <who confirmed which version, evidence, or not confirmed>
- Implementation approval: <authority, version, evidence, or not approved>
- Implementation: <evidence, version, or not established>

### Version history

| Version | Date | Change | Source or authority | Stale evidence |
| --- | --- | --- | --- | --- |
| <version> | <date> | <summary> | <source> | <reviews, checks, documents, or none> |
```

Never infer agreement or implementation approval from a readiness review. Never infer actual implementation from approval.

## `decisions.md`

```markdown
# Requirements decisions: <project>

## DEC-<number>: <decision or conflict title>

- Date recorded: <date>
- Status: proposed | decided | deferred | superseded
- Question or conflict: <what must be resolved>
- Participants and represented roles: <people or roles actually involved>
- Missing parties: <relevant roles not represented>
- Options considered: <options>
- Decision method: <authority or established process>
- Outcome: <decision, deferral, or unresolved>
- Rationale and evidence: <links>
- Affected requirement IDs and records: <links>
- Follow-up approval: <authority and evidence, or not obtained>

## OPEN-<number>: <assumption or consequential unknown>

- Statement: <unknown or assumption>
- Source: <where it arose>
- Impact if wrong: <requirements or decisions affected>
- Resolving person or role: <owner, not the agent>
- Evidence needed: <specific answer, observation, document, or test>
- Revisit trigger or date: <condition, date if known, or unknown>
- Status: open | answered | no longer relevant
```

Do not invent a date to make an open item look owned. If a high-impact unknown blocks useful work, make resolving it the next action.

## `workflow-state.md`

```markdown
# Requirements workflow state: <project>

- Last confirmed checkpoint: <date, result, and evidence>
- Current focus: <goal or question>
- Selected continuation plan: <path and user confirmation, or none>
- Grill Me outcome for that plan: offered | accepted | declined | completed | partial | unavailable | not applicable
- Grill Me evidence: <plan-specific link or none>
- Canonical tracker or records: <links>
- Working drafts: <links and status>

## Evidence briefing

- Documented facts: <claim plus file and section>
- Observed code or test evidence: <claim plus location>
- Inferences: <tentative conclusion and basis>
- Conflicts: <sources that disagree>
- Unknowns: <remaining questions>

## Current handoff

- Plan and next ready step: <plan link and step ID>
- Or next-step guide: <guide below>
- Blockers: <required decision, person, access, or none>
- Unsaved work: <what could not be written and why, or none>
```

## Living RE plan step

Every step needs enough information to resume without guessing.

```markdown
### STEP-<number>: <action-oriented title>

- Purpose: <decision or evidence this step supports>
- Actor: <person or role>
- Inputs or pending decision: <links, evidence, or question>
- Action: <what to ask, inspect, draft, review, or decide>
- Expected result: <specific output>
- Completion criterion: <what must be true for the step to be done>
- Completion evidence: <link or observation proving the criterion was met, or not yet produced>
- Status: not started | ready | active | blocked | complete
- Blocker: <missing authority, answer, access, or none>
- Next ready action: <one action that can start now, or none until blocker resolves>
```

A step is ready only when its actor, inputs, permission, action, and completion criterion are defined and available. Evidence need not exist before work starts. A blocker is a missing decision, person, permission, input, or capability that prevents the action. Mark a step complete only when actual evidence proves its completion criterion, not merely because someone began the work.

## Next-step guide

Use this instead of a full plan when project evidence is too thin or a decision blocks credible sequencing.

```markdown
## Next-step guide: <short title>

- Who acts: <person or role>
- What to ask or inspect: <focused question, source, or activity>
- Why now: <uncertainty or risk this resolves>
- Suggested prompt or check: <usable wording>
- Expected result: <answer, notes, decision, or evidence>
- Done when: <observable completion evidence>
- What follows: <decision rule for the next action>
- Save location: <approved path, existing tracker link, or not saved>
```

## Change preview

Show this before changing approved scope or agreed material.

```markdown
# Change preview: <source, decision, or requirement ID>

- New evidence or request: <statement, source, date>
- Confirmation status: unconfirmed | confirmed by <authority>
- Current requirement version: <ID and version>
- Proposed wording or state: <preview, not yet saved as approved>

| Affected item | Link | Proposed effect | Validation now stale? | Required confirmation |
| --- | --- | --- | --- | --- |
| Requirement | <ID> | <new version or dependency> | <yes or no> | <authority> |
| Document or model | <link> | <revision> | <yes or no> | <reviewer> |
| Acceptance check | <link> | <revision> | <yes or no> | <reviewer> |
| Plan step | <link> | <reopen, block, add, or remove> | <yes or no> | <plan owner> |

- Authorization requested from: <person or process>
- Next action if not authorized: <retain current approved version and resolve question>
```

After authorization, create a new version, preserve the old wording and evidence, update linked items, and request renewed review where the preview marked evidence stale.
