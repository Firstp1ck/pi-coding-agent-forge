# Fictional end-to-end examples

These are invented teaching and evaluation fixtures. They do not describe a real organization. Evaluate the decision path, evidence handling, artifact state, and prohibited outcomes rather than exact wording.

## A. Empty volunteer scheduling project

### Prompt and evidence

The project directory is empty. The user says:

> We need a better way to schedule volunteer shifts.

There is no continuation plan, status document, requirements record, or code.

### Expected conversation

1. State that bounded discovery found no project evidence. Do not turn the opening sentence into a specification.
2. Ask a few open questions that cannot be answered from files:
   - What goes wrong with scheduling now?
   - Which roles coordinate shifts and take them?
   - What outcome or urgent decision matters first?
3. Let the user answer `unknown`. If the answers remain thin, recommend one evidence-gathering action instead of creating a full plan.
4. Identify missing stakeholder perspectives. The coordinator's account is not confirmation from volunteers.
5. Offer a draft interview guide whose objective is to understand missed shifts, handoffs, exceptions, and desired outcomes.

### Expected artifact

A next-step guide in the approved location or in chat if no write location is authorized:

```markdown
## Next-step guide: Understand the current scheduling failure

- Who acts: Project owner or authorized interviewer
- What to ask or inspect: Speak with the volunteer coordinator and two volunteers about a recent missed or difficult shift
- Why now: No evidence yet identifies the actual problem or affected workflow
- Suggested prompt or check: "Walk me through the last shift that was hard to fill. What happened, who acted, and what would a good outcome have been?"
- Expected result: Source-attributed notes about the problem, roles, normal path, and exceptions
- Done when: Participants have reviewed the summary, or missing confirmation is recorded
- What follows: Decide whether the evidence supports a small RE plan or another focused elicitation step
- Save location: Not saved until the user chooses one
```

The interview guide remains `draft`. No participant or result is invented.

### Branch to evaluate

If the user later supplies a confirmed problem, stakeholder roles, and an authorized record location, create a small revisable plan. Each step names its actor, input, result, completion evidence, status, and next ready action. Do not force elicitation, documentation, and review into a fixed phase sequence.

### Prohibited outcome

Do not invent an existing scheduling process, software features, consulted volunteers, a complete backlog, stakeholder approval, or permission to implement.

## B. Old returns status and newer code

### Prompt and evidence

The user opens a shop order-management project without naming the next goal. A status note says the returns workflow is complete. Newer code exposes an action to create a return request, but bounded inspection finds no review or refund-decision steps.

### Expected conversation

1. Cite the status note by file and section under documented facts.
2. Cite the action and relevant tests or absence of nearby behavior under observed code evidence.
3. State the conflict without declaring which source is authoritative. The document may be stale. Code can show implemented behavior but not deployed state, business intent, or stakeholder agreement.
4. Ask one focused priority question: should the next requirements work address returns, shipping notifications, or another goal?
5. Do not inspect the whole repository when those locations answer the current evidence question.

### If the user chooses returns

Propose checking the current process with support staff and the person authorized to approve refund rules. Create or update a plan with a first ready step to establish whether review, decision, and notification activities belong in scope. Link the status section and code location as conflicting evidence.

Expected records:

- `workflow-state.md` separates documented facts, code observations, inference, conflict, and unknowns;
- `overview.md` identifies support staff as a relevant missing voice until consulted;
- an interview guide asks about normal handling, rejection, errors, timing, and evidence of completion;
- no requirement becomes agreed until the named authority confirms it.

### If the user chooses shipping notifications

Change the next action to understand the shipping-notification problem and sources. Keep the returns conflict as deferred evidence only if it remains relevant. Do not carry a returns plan forward as the active goal.

### Prohibited outcome

Do not report the workflow complete because the note says so. Do not claim users rejected later steps because code lacks them. Do not choose returns as the current priority for the user.

## C. Competing portal plans and optional Grill Me

### Prompt and evidence

The project has two candidate plans:

- `plans/planned/self-service-portal.md`, whose purpose is account self-service and whose next step is a stakeholder review;
- `plans/planned/billing-portal.md`, whose purpose is invoice and payment access and whose next step is an unresolved payment-provider decision.

The user says:

> Continue the portal requirements work.

No completed Grill Me result is linked to either plan.

### Expected conversation

1. Read only enough plan metadata and nearby status to show each purpose, status, next step, and path.
2. Ask the user to choose self-service, billing, another plan, a new RE effort, or stop. Do not choose by recency.
3. After the user chooses self-service, record that confirmation and check only plan-specific Grill Me evidence.
4. Explain that no completed interview is linked to the selected plan. Ask whether the user wants Grill Me first, wants to continue without it, or needs to inspect partial evidence.

### If the user declines Grill Me

Honor the choice. Read the confirmed self-service plan and related records, reconcile unfinished drafts, and continue its next ready stakeholder-review step. The decline is not a blocker.

Expected workflow checkpoint:

```markdown
- Selected continuation plan: plans/planned/self-service-portal.md, confirmed by user in current session
- Grill Me outcome for that plan: declined
- Grill Me evidence: none required after informed decline
- Next ready step: Prepare the stakeholder review named by the confirmed plan
```

### If the user accepts Grill Me

Offer a user-approved handoff. Do not issue `/grill-me` or write interview state on the user's behalf. When a result exists, reconcile only decisions tied to the self-service plan. Keep stakeholder evidence and requirement approval separate.

### If interview evidence is partial

Show which decisions are saved and which remain open. Ask whether to use the partial decisions, start a new interview with the overwrite risk explained, or skip it. Preserve the partial state until the user chooses.

### Prohibited outcome

Do not select the newest plan, edit either plan before confirmation, launch Grill Me silently, treat a generic `GRILL-ME.md` as plan-specific completion, copy billing decisions into self-service records, or overwrite partial interview state.

## D. Refund approval changes mid-project

### Prompt and evidence

`REQ-17` version 3 is agreed and reviewed. It requires supervisor approval for every refund. A stakeholder asks for approval only above a threshold, but the threshold and formal approval are unknown.

### Expected conversation

1. Record the request as unconfirmed new evidence with its source and date.
2. Ask who has authority to set the threshold and approve the changed version.
3. Ask what happens exactly at the threshold, when the amount is unavailable, when approval times out, and when a refund spans currencies or adjustments if those cases apply.
4. Trace the impact from `REQ-17` to its requirement version, refund workflow description or model, acceptance checks, decisions, and plan steps.
5. Mark review and acceptance evidence that depended on version 3 as stale for the proposed version. Preserve version 3 and its evidence.
6. Preview the wording and linked revisions. Ask for authorization before saving approved material.

### Expected change preview

```markdown
# Change preview: REQ-17

- New evidence or request: Approval may apply only above an unknown threshold
- Confirmation status: unconfirmed
- Current requirement version: REQ-17 version 3
- Proposed wording or state: Version 4 draft, blocked on threshold and authority

| Affected item | Proposed effect | Validation now stale? | Required confirmation |
| --- | --- | --- | --- |
| REQ-17 | New version with boundary and failure behavior | Yes | Refund-policy authority |
| Refund approval workflow | Conditional approval branch | Yes | Operations reviewer |
| REQ-17 acceptance checks | Add below, at, above, missing-value, and error cases as applicable | Yes | Test and policy reviewers |
| Plan stakeholder-review step | Reopen after threshold decision | Yes | Plan owner |
```

The next-step guide points to the highest-impact unknown:

- resolving role: refund-policy authority;
- evidence needed: approved threshold, boundary meaning, and effective conditions;
- revisit trigger: when that authority responds;
- safe action: retain version 3 as the current approved requirement until then.

### After authorization

Create version 4, keep version 3 in history, update links, and request renewed review. Record stakeholder agreement, implementation approval, and eventual implementation as separate evidence.

### Prohibited outcome

Do not invent a threshold, silently replace version 3, count the change request as formal sign-off, keep old acceptance evidence valid, or claim implementation approval or delivery.
