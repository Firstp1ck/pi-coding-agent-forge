# Requirements-engineering guidance skill

- **Status:** Planned; implementation not started
- **Recommended target:** New first-party skill package `pi-skill-requirements-engineering/`, with `skills/requirements-engineering/SKILL.md`
- **Proposed package name:** `@firstpick/pi-skill-requirements-engineering`; confirm before package creation or publication
- **Scope:** Support a user starting a software project and continuing its requirements-engineering work
- **Source:** IU Internationale Hochschule, *Requirements Engineering*, IREN01, version 003-2023-0817, [local PDF](../../docs/re-swe/Script_Requirements-Engeenering.pdf). Page references below are **PDF pages**.

## 1. Goal and success criteria

Build a conversational Pi skill that helps a user start, update, and resume requirements engineering (RE), even when they provide no project context in the request. Every start, update, or resume must leave the user with **either a maintained RE plan and its next ready step or a concrete guide to the next safe step**. The skill should help prepare the interview, survey, review, and other working documents needed for that step. It guides the project owner; it never substitutes AI output for stakeholder evidence or approval.

Completion requires demonstrated behavior in these scenarios:

1. With only a project directory and no explanatory prompt, the skill first identifies candidate continuation plans and asks the user before using one. If none is selected, it discovers available progress evidence before asking further context questions. A vague or empty project receives an actionable first-step guide rather than a fabricated full plan; a sufficiently understood project receives a small, revisable RE plan.
2. Each plan step identifies its purpose, actor, inputs or pending decision, expected result, completion evidence, status, and next ready action. A guide identifies who should act, what to ask or inspect, why, the expected result, and what makes the step done.
3. An update shows the proposed change and its impact on requirements, dependent work, decisions, priorities, reviews, documents, and the plan or guide. It preserves prior decisions and completed evidence; approved scope is not silently changed.
4. Resume rereads project records, reconciles new evidence and unfinished drafts, identifies blockers, and continues from the current plan or next-step guide without repeating answered questions. If no skill-owned record exists yet, it uses the same zero-context discovery path instead of pretending there was a prior session.
5. The user can request an interview guide, survey questions, or another suitable RE working document. A draft is labeled as a draft, linked to its purpose and sources, and never presented as a completed interview or approval.
6. Requirements remain linked to business problems and sources. Review findings, stakeholder agreement, permission to implement, and actual implementation remain distinct.
7. Missing interactive integrations, cancelled dialogs, unavailable files, or a failed write produce an honest limitation plus the next safe user action. They never produce invented answers or a false saved-state claim.
8. Contract checks, scenario evaluations, package-content checks, documentation and link checks pass. Any behavior that relies on model judgment is reported as evaluated, not guaranteed by a static Markdown test.
9. Documentation with status, progress, or update information informs the initial briefing. If it is missing, stale, or insufficient, relevant code, tests, and configuration provide bounded evidence of current behavior. The skill labels observations versus inferred intent, asks only the remaining user questions, and changes its next-step recommendation according to the answers.
10. If a usable continuation plan exists, the skill asks the user which plan, if any, they want to continue **before** treating it as active or changing it. When no completed Grill Me interview is evidenced for the chosen plan, it also asks whether the user wants that interview first. Declining Grill Me does not block an approved plan continuation.
11. For major goals, the skill shows which relevant stakeholder roles and other sources have contributed, which voices are missing, and whose actual confirmation is still needed. The project owner's account is not silently attributed to another stakeholder.
12. Before proposing implementation of a requirement, the skill checks its problem, source, unambiguous wording, relevant exception paths, and a testable acceptance method; quality requirements have a measurable target when one is needed. Missing information remains open rather than receiving an AI-generated approval.
13. A consequential unknown or assumption has a named person or role to ask, the evidence needed, and a condition or time to revisit it when known. The next-step guide points to the highest-impact unresolved item rather than accumulating ownerless questions.
14. On a proposed change, the skill shows links from affected requirement IDs to related documents, models, acceptance checks, and plan steps, flags which validations are now stale, and asks the user to confirm the impact before updating approved material.
15. Four fictional end-to-end examples cover an empty project, conflicting documentation and code, competing continuation plans, and a changed requirement. Each specifies expected guidance and a prohibited outcome; scenario evaluations check behavior rather than exact wording.
16. The skill can explain a technical word or sentence in plain language on first use or whenever the user asks, grounded in a concise glossary derived from the script. It distinguishes script terminology from skill-specific wording, uses the project's agreed glossary for local meanings, and asks when a meaning is disputed rather than silently redefining it.

The script describes elicitation, documentation, and review/alignment as recurring core activities without a fixed order. Requirements management continues over the project lifecycle. This implementation plan is staged for building the skill; **the RE workflow offered to users must not become a mandatory waterfall**. [PDF pp. 14-17](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=14), [136-142](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=136).

## 2. Scope and boundaries

**Version 1 includes:** a portable skill with start/update/resume instructions; user-confirmed selection of existing continuation plans; bounded, read-only zero-context discovery from project documents or relevant code; a plan-or-guide decision rule; human-readable project records; traceable requirements and decisions; a concise source-grounded glossary and on-demand plain-language explanations; stakeholder/source coverage and confirmation checks; a small requirement-readiness check; owned unknowns; change-impact links; situational elicitation guidance; drafts of interview guides, questionnaires and other needed documents; a review/approval checklist; and optional interaction with Pi's questionnaire tool and Grill Me command.

**Not in version 1:** automated terminology-drift detection, a new extension, automated stakeholder contact, sending surveys, audio or video recording, integration with an external requirements tracker, automatic legal/regulatory advice, a diagram editor, formal BPMN/UML validation, or a universal requirements template. Do not bundle or paraphrase large portions of the copyrighted PDF. Model and prototype suggestions remain optional and audience-driven. [PDF pp. 58-68](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=58), [72-114](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=72).

The skill may draft questions *for a real stakeholder*. Its own questions to the project owner are not stakeholder answers. It must not claim that a participant was interviewed, a reviewer approved a requirement, or a feature was implemented without evidence.

## 3. Decisions to settle before implementation

| Decision | Working recommendation | Why it matters |
| --- | --- | --- |
| Distribution | Build a first-party skill package, following `pi-skill-project-readme/`; use `.agents/skills/requirements-engineering/` only for a project-local pilot if needed. | Package docs, discovery, routing tests, and the exact install name depend on this choice. |
| Project-record location | Ask the user for a writable project location; use `requirements/<project-name>/` only as an example. Respect an existing tracker as the canonical register. | Do not create competing records or expose sensitive notes in the source-script directory. |
| Plans | Follow the host project's plan policy. In this repository, active plans belong in `plans/planned/` and verified completed plans in `plans/archive/`. | A resume must update the same plan, not create a second one. |
| Authority | Ask which people or established project process can confirm requirements and approve implementation. | An AI review and a project owner's report of a stakeholder opinion are not that stakeholder's approval. |
| Language, privacy, and retention | Ask for the preferred language and storage restrictions before saving personal stakeholder details or interview results. | Notes and dialogs may contain sensitive information. |
| Optional UI | Detect whether the native questionnaire tool and the Grill Me extension are available; neither is a hard dependency. | The skill must still provide guidance in ordinary conversation if the UI is unavailable. |

Do not treat these recommendations as approval to install packages, create records in another project, contact people, or publish an npm package. If a decision remains open, state the assumption in the plan and give the next clarifying action.

## 4. Product and record contract

### Existing-plan confirmation

On **any** start, update, or resume, first check the host project's established plan location for plans that might continue this work. Read only enough metadata and nearby status to identify relevant candidates; list each candidate's purpose, status, last known next step, and file path. A plan's presence is not permission to work on it. Ask the user whether to continue one of those plans, choose another, start a new RE effort, or stop. If several candidates exist, let the user choose explicitly; do not select the newest by default. Even when a request names a plan, confirm that it is the one the user intends to continue before using its instructions, editing it, or taking its next action. If the user declines, leave the plan untouched and return to ordinary project intake or their chosen task.

For the **selected** plan, check whether a completed Grill Me decision interview is actually linked to it, such as a saved result and recorded decisions. A generic `GRILL-ME.md` file or an unfinished interview is not proof of completion for that plan. If completion is absent, offer the choice to start a Grill Me interview **before** continuing; if evidence is partial or unclear, explain what was found and ask whether to use the saved partial decisions, run a new interview, or skip it. Do not launch `/grill-me`, replace `.pi/grill-me/state.json`, or mark the interview complete without the user's choice. If the user opts in, provide a user-approved handoff and reconcile its resulting decisions with the selected plan; if they decline, continue the confirmed plan without requiring Grill Me. If either choice remains unanswered, give a next-step guide asking for that decision rather than silently proceeding.

Record the chosen plan and the Grill Me decision with links to the evidence in the workflow checkpoint. Never copy an unrelated plan's decisions into the canonical RE record. This confirmation gate is a skill-design safeguard, not a sequence prescribed by the script.

### Zero-context project entry

When invoked in a project without a useful prompt or a skill-owned record, the skill checks for candidate continuation plans and applies the confirmation gate above before proposing a plan or resuming work. If none is selected, it must establish context. This is a **read-only, bounded discovery pass**, not permission to change code or assume product intent:

1. Find the project's existing entry documents and any current status, progress, update, roadmap, or decision sections. Prefer a project-owned, current record over an old summary; note the file and section for each claim. Do not assume a heading makes a statement current or approved.
2. If these documents are absent, stale, or do not answer the relevant question, inspect only the code, tests, configuration, and entry points needed to understand what the project appears to do and what work is evidenced. Use the repository's supported exploration tools where available. Code and tests can show implemented behavior or intended checks; neither proves business goals, stakeholder agreement, or unfinished priorities. Do not run untrusted project code merely to gather context.
3. Give the user a short picture with **documented facts**, **observed code evidence**, **inferences**, **conflicts**, and **unknowns** kept distinct. If there is no documentation or code, say so rather than constructing a fictional project history. Ask a few focused questions about the business problem, desired outcome, current priority, stakeholders, or a conflict the evidence exposed. Do not ask for facts already established, and let the user say "unknown."
4. Use the answers to choose and explain the next RE action. Show who should act, what to ask or inspect, the expected result, and how to know the step is done. If an answer is missing, guide the user to the next safe way to obtain it. Create a small plan only when the answers and evidence support one; otherwise save an actionable next-step guide. On later invocations, update that same plan or guide with new evidence.

This intake order is a skill design decision, not an algorithm mandated by the script. It applies the script's emphasis on provisional system context, multiple sources, iterative learning, and checking interpretations with stakeholders. [PDF pp. 15-19](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=15), [24-35](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=24).

### Start, update, resume

- **Start:** Confirm whether any existing plan is the user's intended continuation. If none is selected and no project context was supplied, run the zero-context entry path. Establish the business problem and intended outcome before settling on a solution; draft a short vision and provisional system/context boundaries. Ask about relevant people, documents, existing systems, quality needs, constraints, target readers, and the first elicitation goal. If the facts are thin, save a next-step guide rather than inventing the rest of the plan. [PDF pp. 17-29](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=17).
- **Update:** Confirm the target plan before using or changing it. Identify the new fact, source, date, affected requirement IDs and documents. Show the proposed revision and whether earlier reviews, priorities, baselines, or steps need rework. Get confirmation before changing an agreed decision. Update the existing plan or guide, including its next ready action. [PDF pp. 120-125](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=120), [136-149](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=136).
- **Resume:** Identify candidate plans and obtain the user's selection and Grill Me preference before continuing. Then read the confirmed plan and saved project record; summarize what is confirmed, hypothetical, blocked, or awaiting a person. Reconcile relevant Grill Me results and unfinished working documents, then show the maintained plan's next ready step or an updated guide. If there is no saved record or selected plan, use zero-context entry without claiming that one existed. Never restart an active questionnaire merely to recover context.

At each handoff, offer practical support for the next action: a focused question, a document to inspect, a proposed interview guide, or a review checklist. If the next action is blocked, name the required decision/person and a safe way to obtain it. Promote a guide to a plan once enough is known; retain the earlier answers. Keep planned steps revisable rather than implying that the lesson order is the project order. [PDF pp. 15-17](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=15), [33-35](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=33).

### Practical checks during the RE cycle

These are short, situational prompts, not mandatory forms for every conversation:

- **Stakeholder coverage:** For each important goal, compare the involved roles and other sources with those actually consulted. Flag missing perspectives and propose an interview, survey, observation, or document review as the next action. Record who confirmed the resulting understanding and who has not; a project owner's report is not another person's sign-off. [PDF pp. 26-29](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=26), [123-125](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=123).
- **Requirement readiness:** Before an item is handed toward implementation, ask whether its business problem and source are traceable, its wording is clear, relevant failure or exception paths are described, and acceptance can be checked. For a quality requirement, ask for a measurement and operating condition when necessary. Mark an incomplete item "needs clarification" with a next action; this check does not replace stakeholder agreement or implementation approval. [PDF p. 20](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=20), [122-125](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=122), [127-128](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=127).
- **Owned unknowns:** Keep consequential assumptions and open questions with their source, the person or role able to resolve them, the evidence to obtain, and a revisit trigger or date only when one is known. Escalate an unresolved, high-impact question into the next-step guide instead of letting it disappear in meeting notes. [PDF pp. 24-26](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=24).
- **Change impact:** From a changed source, decision, or requirement ID, show affected requirements, working documents or models, planned steps, and acceptance checks. Flag earlier validations that may no longer hold. Preview the proposed revisions and obtain authorization before changing approved requirements or scope. [PDF pp. 122-128](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=122), [136-141](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=136).

### Plain-language terms and project meanings

Use the [source-grounded glossary draft](../../docs/re-swe/requirements-engineering-glossary.md) for concise paraphrases of terms from the script and clearly labeled working definitions introduced by this skill. Explain an unfamiliar term briefly on first use; when asked "What does this mean here?", restate it in the project's situation, contrast nearby concepts when useful, and point to the relevant PDF page if the user wants the source. For a technical sentence, explain the decision or action it implies rather than reciting definitions. Do not require a glossary lesson before the user can work.

The project-specific glossary in `overview.md` is authoritative for that project's agreed domain vocabulary. If it differs from the general reference, show both meanings and ask the relevant person which one is intended before changing requirements or stakeholder wording. A project-specific definition or a skill-only term such as "next-step guide" must not be attributed to the script. If a term is absent from the reference, acknowledge that and seek a reliable source rather than inventing a definition. This conversational clarification belongs in version 1; automatic scans for terminology drift remain later scope. [PDF p. 35](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=35), [p. 63](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=63), [p. 124](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=124).

### Canonical artifacts

At the chosen project location, use a small, adaptable set of Markdown records unless a canonical tracker already exists:

- `overview.md`: vision, business problem, provisional scope/context, stakeholder roles, sources, who has contributed to each major goal, missing perspectives, target audience, and the project's agreed domain glossary, distinct from the skill's general reference.
- `requirements.md`: one canonical register with stable ID, type, wording, linked problem or goal, source/author, owner, version, dependencies, priority, relevant exception paths and a measurable quality target where applicable, acceptance or verification method, links to affected documents and checks, and separate readiness, review, agreement, implementation-approval, and implementation states. Use "unknown" when evidence is missing.
- `decisions.md`: dated decision and conflict records with participants, rationale, affected IDs, and unresolved or deferred status. Track consequential assumptions and questions here with a resolving role, required evidence, and revisit trigger; do not invent a deadline.
- `workflow-state.md`: last confirmed checkpoint, current focus, the next consequential open question or confirmation, the user's selected continuation plan (if any), the plan-specific Grill Me offer/outcome and evidence link, and links to the records, drafts, and discovery evidence (file/section or code location). Keep observations and user-confirmed decisions distinct. When no plan exists, keep the next-step guide here; otherwise link to the plan and its next ready step without duplicating it.
- `working-documents/`: only the interview guides, surveys, observation sheets, workshop notes, review logs, prototype feedback, or other drafts actually needed. Each carries its objective, source or audience, related IDs where known, author, date, version, and draft/ready/confirmed status.

Follow existing plan conventions for the living RE plan. In this repository, write it once under `plans/planned/`, revise it after new evidence, and move it to `plans/archive/` only after verifying the plan-wide completion criteria. Do not confuse that **project RE plan** with this **plan to implement the skill**. If writing is declined or fails, still give the next-step guide in chat and say what was not saved. [PDF pp. 60-64](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=60), [136-141](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=136).

## 5. Implementation sequence

These stages build the skill. They are not a sequence imposed on a user's RE project.

### Stage A: Settle the package and interaction contract

- [ ] Resolve the decisions in section 3 or record explicit, bounded assumptions for the first release.
- [ ] Define routing examples for start, update, resume, a no-context project invocation, one or several candidate plans, a previously completed or partial Grill Me interview, requesting a working document, an ambiguous request, and non-RE requests. Specify when to ask a plain open question versus several bounded choices.
- [ ] Choose the minimum project-record templates and decide how to reference an existing tracker without copying its requirements.

**Exit:** A reviewer can tell when the skill applies, which output it owes the user, where it may write, and when it must ask rather than assume.

### Stage B: Build the skill and guidance references

- [ ] Create the package manifest, portable `SKILL.md`, and short focused references or templates as needed. Put the four fictional scenarios from section 6 in `skills/requirements-engineering/references/EXAMPLES.md`, with example prompts and expected artifacts. Review the [glossary draft](../../docs/re-swe/requirements-engineering-glossary.md) against the cited pages, move the agreed paraphrases into `skills/requirements-engineering/references/GLOSSARY.md`, and replace the source-directory draft with a pointer so definitions have one maintained home. Keep `SKILL.md` focused on routing and when to read those references; do not load or bundle the entire PDF.
- [ ] Implement the start/update/resume instruction paths and the invariant that each ends with a maintained plan or next-step guide. Define what constitutes a ready step, a blocker, completion evidence, a saved checkpoint, and an honest write failure.
- [ ] Implement bounded plan discovery and the user-confirmation gate before adopting or editing any continuation plan. Check plan-specific Grill Me completion evidence; ask whether to start an interview if none is confirmed, handle partial/unknown results without overwriting them, and honor a decline.
- [ ] Implement bounded doc-first discovery for no-context use after that gate: locate status/progress/update evidence, fall back to relevant code and tests when it is absent or insufficient, expose provenance and uncertainty, and turn unanswered gaps into focused owner questions. Route the answers into a justified next action or provisional plan.
- [ ] Define one canonical requirement/decision record and an update path that preserves versions, sources, completed steps, and approval boundaries. Track consequential unknowns with a resolving role, required evidence, and revisit trigger; make the next action point to a high-impact unresolved question when needed. Align any generated plan with the host project's plan lifecycle.

**Exit:** Walkthroughs of both a vague and a well-scoped project produce usable guidance. With a candidate plan, no next step is taken before user confirmation and the plan-specific Grill Me choice; a later update or resume revises the same confirmed record rather than starting over.

### Stage C: Elicitation and working documents

- [ ] Offer a small method-selection guide based on stakeholder availability, group dynamics, tacit knowledge, project constraints, desired detail, and existing documents/systems. Combine methods when needed instead of recommending one universal interview. [PDF pp. 24-33](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=24), [38-52](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=38).
- [ ] For important goals, identify stakeholder/source coverage, missing roles and unconfirmed findings. Suggest a specific follow-up for a missing voice and never count a project owner's report as that stakeholder's confirmation. [PDF pp. 26-29](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=26).
- [ ] Draft an interview guide with objective, role, open problem-focused questions, neutral follow-ups, exceptions, quality and constraint prompts, note space, and a closing understanding check. Provide a separate results summary for a participant to confirm after an actual interview. [PDF pp. 46-48](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=46).
- [ ] Draft survey questions with a defined population, purpose, neutral concise wording, open/closed formats, explained scales and optional responses, and a review/pilot step. Distinguish a survey document sent to stakeholders from a Pi questionnaire used to ask the project owner. [PDF pp. 46-48](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=46).
- [ ] Support task-specific observation guides, workshop agendas/notes, context summaries, prototype feedback, and review checklists on request. Mark missing facts and all unperformed sessions as such. Recheck affected drafts after an update.

**Exit:** A user can obtain and revise a useful draft for a chosen RE activity without the skill inventing participants, results, consent, or approval.

### Stage D: Review, conflict handling, and optional interaction tools

- [ ] Add a situational review checklist for content, form, testability, source/problem traceability, consistency, and stakeholder agreement. Record findings before corrections and require renewed review after material changes. [PDF pp. 120-130](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=120).
- [ ] Add a short requirement-readiness check before implementation handoff: linked problem/source, clarity, relevant exceptions, testable acceptance method, and a measurable quality target when needed. Missing evidence yields a clarification action, not approval. [PDF p. 20](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=20), [122-128](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=122).
- [ ] On a source, decision, or requirement change, present the affected requirement IDs, documents/models, acceptance checks, and plan steps; mark stale review evidence and ask for confirmation before changing agreed scope. [PDF pp. 122-128](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=122), [136-141](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=136).
- [ ] Record conflicts, relevant parties, options, decision process, outcome or deferral, and subsequent approval separately. Offer MoSCoW, value/risk, customer impact, and dependency-aware ordering as choices, not an automatic score. [PDF pp. 131-149](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=131).
- [ ] Use the [questionnaire skill](../../pi-package-questionnaire/README.md) and native tool only for related, bounded owner choices; preserve its clarification snapshot and handle cancellation or unavailability without guessed answers.
- [ ] Offer a user-approved handoff to the [Grill Me extension](../../pi-extension-grill-me/README.md) when a confirmed continuation plan has no plan-specific completed interview, or when the user otherwise requests deeper project-decision work. It includes questionnaire support, needs an interactive UI, and starting `/grill-me` again can replace its existing state. Do not repeat a completed plan-specific interview by default, and do not restart or overwrite a partial one without an explicit choice. Treat a saved `GRILL-ME.md` as decision input, not as the canonical requirement register or evidence from absent stakeholders.

**Exit:** The skill keeps decisions and approvals attributable, uses optional Pi integrations only when available and suitable, and still guides the user without them.

### Stage E: Validate and document

- [ ] Add contract/routing checks and scenario evaluations for no-context entry with current progress docs, stale or conflicting docs, code but no progress docs, and an empty project. Verify provenance, focused questions, and answer-dependent recommendations. Cover one or multiple candidate plans, user selection or refusal, a confirmed plan with no completed Grill Me interview, a completed interview, partial or ambiguous interview evidence, user acceptance or refusal of the offer, and unavailable UI. Also cover a major goal with an unrepresented stakeholder, an unconfirmed interview result, a requirement missing exception or measurable quality criteria, an ownerless high-impact unknown, and a changed source that invalidates a review and affects a document, check, and plan step. Retain vague start, detailed start, interrupted session, blocked step, failed write, draft-document request, distinct review versus approval, optional-tool cancellation, and clarification/resume.
- [ ] Turn all four section 6 examples into scenario evaluations with both the expected output and the forbidden outcome. For the shop and portal examples, test different user answers; for the changed rule, verify that only a confirmed revision is saved and prior review evidence is marked stale. Do not grade against exact prose.
- [ ] Evaluate a user asking what "system boundary" means, what "testable but not released for implementation" means in their project, and what a term means when the project glossary differs from the general reference. Verify a plain explanation, honest source attribution, no invented stakeholder agreement, and no forced glossary walkthrough. Check that definitions are paraphrased and the bundled package does not include the PDF.
- [ ] Inspect model-run outputs for correct guidance, provenance, safety, and PDF-grounded method advice. Record failures and revise instructions/templates; static string checks alone cannot prove conversational quality.
- [ ] Write a package-specific user `README.md`, advanced-user `TECHNICAL.md` when needed, and contributor `DEVELOPMENT.md`; link them by the repository's documentation rules. Include privacy and human-approval warnings, practical first use, install instructions using the **confirmed** published package name, and a root README catalog entry when the package is added.
- [ ] Run the package's relevant tests, routing fixtures, package dry-run inspection, Markdown whitespace/link checks, and a Pi discovery/start/update/resume smoke test in a safe fixture. Report any unavailable live UI or evaluator checks explicitly; do not claim publication or installation.
- [ ] Before archiving this plan, update the pointer in `docs/re-swe/interactive-requirements-engineering-skill-proposal.md` so it links to the archived location.

**Exit:** Every success criterion in section 1 has a matching observed check or a named deferral. Documentation, links, package contents, and unchanged unrelated files have been verified. Only then archive this plan according to repository policy.

## 6. Fictional end-to-end examples for version 1

These examples are invented teaching and evaluation fixtures, not evidence about a real organization. During implementation, put the fuller sample conversations and draft outputs in `skills/requirements-engineering/references/EXAMPLES.md`. Keep `SKILL.md` focused on decisions and boundaries. Each example below describes a behavior to test, not lines the model must repeat.

### Example A: Volunteer shift scheduling, no project files

- **Situation:** A volunteer coordinator opens an empty project and says, "We need a better way to schedule shifts." There is no continuation plan, progress document, or code.
- **Expected path:** State that no project evidence was found. Ask about the scheduling problem, who coordinates and takes shifts, and the most urgent decision. If the answers remain thin, give a next-step guide to speak with the coordinator and volunteers, including a suggested question, expected notes, and what would complete the step. Offer a clearly labeled draft interview guide. Create a small RE plan only when the answers justify one.
- **Must not:** Invent existing features, claim volunteers were consulted, or generate an approved specification from the opening sentence.

### Example B: Shop order-management app, old status note and newer code

- **Situation:** A small shop's project documentation says its returns workflow is complete, but a bounded inspection finds code for creating a return request and no evidence of the later review steps. The user has not said what work they want next.
- **Expected path:** Cite the document and code locations separately, explain that neither proves the deployed business process, and ask whether returns or another problem is the current priority. If the owner chooses returns, propose a check with support staff and an RE plan to clarify the missing steps. If the owner chooses shipping notifications, change the proposed next action accordingly; do not carry over the returns assumption.
- **Must not:** Report the returns workflow as complete because the document says so, or treat missing code as proof that users never agreed on the workflow.

### Example C: Two customer-portal plans and an optional Grill Me interview

- **Situation:** The project has separate self-service and billing portal plans. The user asks to continue work without naming either. The selected plan has no plan-specific completed Grill Me result.
- **Expected path:** Show bounded summaries and ask which plan, if any, the user wants to continue. After they choose self-service, ask whether they want a Grill Me decision interview first. If they decline, read that confirmed plan and guide its next ready step. If they accept, offer a user-approved handoff and later reconcile only decisions tied to that plan. If an interview is partial, present that state instead of treating it as complete.
- **Must not:** Pick the newest plan, execute a plan step before confirmation, launch `/grill-me` silently, or overwrite an unrelated interview state.

### Example D: Refund-approval rule changes mid-project

- **Situation:** A stakeholder asks to change requirement `REQ-17` from supervisor approval for every refund to approval only above a threshold. The threshold and the stakeholder's formal approval are not yet established.
- **Expected path:** Record the request as an unconfirmed change; ask who sets the threshold and what happens at the boundary or on errors. Show affected requirement versions, approval workflow description, acceptance checks, and plan steps, and flag previous review evidence for reassessment. Preview revisions and request authorization before saving them. End with the next action needed to resolve the threshold and approval status.
- **Must not:** Invent a threshold, silently replace the approved requirement, keep a stale acceptance check as valid, or claim that the request is stakeholder sign-off.

## 7. Later scope: terminology checks

Version 1 provides on-demand explanations from a general, source-grounded reference and keeps a separate project-owned glossary, but does not promise automatic terminology analysis. After the core flows are evaluated, consider a focused check that flags undefined abbreviations or the same business term used with conflicting meanings across interview summaries and requirements. Show the conflicting passages, ask a domain owner to confirm the definition, and update the canonical glossary and affected items only after confirmation. Do not silently rewrite stakeholder statements. This extends the script's concern about differing mental models and ambiguous terms. [PDF p. 35](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=35), [p. 63](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=63), [p. 124](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=124).

## 8. Risks and controls

- **Skill instructions are not enforcement.** A portable `SKILL.md` can guide model behavior but cannot by itself guarantee persistence or approval checks. Test representative sessions, distinguish instruction checks from observed behavior, and consider stronger tooling only if evidence shows it is needed.
- **Premature certainty.** A preferred solution, unfinished vision, or unavailable stakeholder can hide alternatives. Keep boundaries provisional and show the next clarifying action. [PDF pp. 17-26](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=17).
- **Stale documents and misleading code.** A progress note may be outdated, while code may implement behavior nobody now wants. Bound discovery to relevant files, identify conflicting evidence, and ask the user which goal or priority is authoritative before turning observations into requirements.
- **Accidental plan continuation.** A discovered plan may belong to another effort or have stale instructions. Ask the user to select and confirm it before treating it as active; never execute its next step simply because it exists.
- **Document sprawl and contradictory state.** A plan, workflow checkpoint, Grill Me result, and working drafts must link back to one canonical requirement/decision record. A Grill Me result must be tied to the chosen plan before counting it as completed for that plan. Do not copy the plan into every file.
- **Privacy and authority.** Participant information and questionnaire answers may persist in Pi sessions or project files. Minimize personal data, respect storage choices, and get authorization before contacting, recording, sending, or asserting approvals.
- **Source and notation limits.** Cite the local script by page for method guidance, do not distribute its copyrighted content or figures, and verify exact diagram syntax against project conventions or standards before generating it.

## 9. Source coverage

| Script section | Planned skill behavior |
| --- | --- |
| [Fundamentals, PDF pp. 14-20](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=14) | Iterative guidance, business problem before solution, functional/quality/constraint types. |
| [Elicitation, PDF pp. 24-52](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=24) | Context, stakeholder/source analysis, situational techniques, interview and survey drafts. |
| [Documentation, PDF pp. 58-68](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=58) | Audience-appropriate vision, overview, detailed record, glossary, mixed forms, and plain-language term explanations on request. |
| [Process/system models, PDF pp. 72-114](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=72) | Optional process, use-case, activity, class, or state model suggestions; no mandatory diagram. |
| [Review/alignment, PDF pp. 120-133](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=120) | Review criteria, separate findings/corrections, conflict decisions, human agreement. |
| [Management/priority, PDF pp. 136-149](../../docs/re-swe/Script_Requirements-Engeenering.pdf#page=136) | Stable IDs, status and versions, change impact, plan updates and situational priority. |
