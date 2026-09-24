# Requirements working documents

Use this reference after the current question and audience are known. Every generated document is a draft until the named people perform or confirm its work. Give each file an objective, source or audience, related requirement IDs when known, author, date, version, and status.

Source basis: IU Internationale Hochschule, *Requirements Engineering*, IREN01, version 003-2023-0817, PDF pp. 24-33, 38-52, 58-68, and 120-149. The guidance below is paraphrased and adapted for this skill. The PDF is not bundled.

## Pick methods for the current question

Do not recommend one method for every project. Check these factors first:

- the decision or uncertainty to resolve;
- whether stakeholders can state the needed knowledge;
- stakeholder availability, location, number, and preferred communication;
- group power differences or conflict;
- whether important knowledge is tacit and visible only in real work;
- the needed breadth, detail, and novelty;
- existing documents, systems, prototypes, and constraints;
- privacy, consent, time, language, and accessibility needs.

Choose the smallest useful combination:

| Situation | Useful method | Limit to state |
| --- | --- | --- |
| A person can explain detailed work and is available for follow-up | Interview | Time-intensive; answers still need confirmation and wider coverage checks |
| Many distributed people need the same questions | Survey | Little opportunity for immediate clarification; pilot the wording first |
| People omit habitual steps or exceptions | Observation plus follow-up interview | Obtain permission; observed habits are not automatically desired requirements |
| Several roles must expose conflicts or build shared understanding | Facilitated workshop | Power dynamics and weak facilitation can silence people; attendance is not automatic agreement |
| Existing rules or behavior may already be documented | Document and system review | Records may be stale; implementation does not prove desired behavior |
| An interface or solution assumption needs early feedback | Prototype feedback | Participants may mistake a prototype for a promise or finished product |
| A missing stakeholder cannot participate | Record the missing voice and plan direct follow-up | Role-play can suggest questions but cannot count as that stakeholder's evidence |

Combine methods when their weaknesses differ. For example, observe a task, interview the worker about exceptions, then send the summary back for confirmation. See PDF pp. 30-33 and 38-52.

## Common document header

```markdown
# Draft: <document title>

- Status: draft | ready to use | results awaiting confirmation | confirmed
- Objective: <question or decision this supports>
- Audience or participant role: <role, not invented person>
- Related requirements: <IDs or unknown>
- Sources used: <links, statements, or unknown>
- Author: <name or role>
- Date: <date>
- Version: <version>
- Privacy and retention: <approved handling or unresolved>
```

Never label a session complete because its guide exists. Keep a prepared document, session notes, interpreted results, participant confirmation, stakeholder agreement, and implementation approval separate.

## Interview guide

Build the guide around one objective. Prefer open, problem-focused questions before asking about a favored solution.

```markdown
## Opening

- Explain the objective, expected duration, note handling, and how the summary will be checked.
- Confirm participation and any recording or privacy choice. No recording is assumed.

## Core questions

1. Walk me through the current situation when <problem or event> occurs.
2. What outcome are you trying to achieve, and how do you know it worked?
3. Where does the work become difficult, delayed, risky, or repetitive?
4. What information, people, documents, or systems do you rely on?
5. What exceptions or failure cases occur? What should happen then?
6. What quality, timing, security, accessibility, privacy, or volume conditions matter?
7. Which rules or constraints apply, and where can we verify them?
8. What have I misunderstood or failed to ask?

## Neutral follow-ups

- Can you give a recent example?
- What happens immediately before and after that?
- Who else sees this differently or holds part of the answer?
- What evidence would let us check that statement?

## Notes

<Leave space. Mark direct statements, observations, and interviewer interpretations separately.>

## Closing understanding check

- Summarize the main problem, desired outcome, exceptions, unknowns, and disagreements.
- Ask what needs correction.
- Explain when and how the participant will receive the results summary.
```

After an actual interview, create a separate result for confirmation:

```markdown
# Interview results awaiting participant confirmation

- Participant and represented role: <actual identity under approved privacy rules>
- Session date: <date>
- Evidence captured: <notes or recording consent and location>
- Summary of statements: <source-attributed points>
- Interviewer interpretations: <clearly labeled inferences>
- Candidate requirements: <IDs or drafts, not agreed by default>
- Open questions and conflicts: <items>
- Confirmation requested: <what the participant should correct or confirm>
- Confirmation status and evidence: <pending or link>
```

The source describes preparation, conduct, and participant confirmation of results on PDF pp. 46-48.

## Stakeholder survey

A survey sent to stakeholders differs from a conversational questionnaire used to ask the project owner for bounded choices.

```markdown
## Survey definition

- Population: <who should respond and why>
- Purpose: <one decision or learning goal>
- Distribution and closing date: <owned by an authorized person, or undecided>
- Response handling: <anonymous or identified, access, retention, optional items>
- Pilot reviewer: <person or role>

## Introduction for respondents

<Plain statement of purpose, expected time, data use, optional questions, and contact route.>

## Questions

1. <Neutral closed question with complete, non-overlapping choices and an optional "Other" when needed.>
2. <Open question when the range of answers is not known.>
3. <Scale question whose endpoints and each value are explained, with "Not applicable" when valid.>

## Review before sending

- Does each question support the purpose?
- Is wording short, neutral, and understandable to the population?
- Are choices and scales explained without forcing an answer?
- Are sensitive questions necessary and optional where appropriate?
- Did a small pilot reveal ambiguous wording or missing choices?
```

Do not claim responses, response rates, or consent before the survey is sent and completed. The source contrasts interviews and questionnaires on PDF pp. 46-48.

## Observation guide

```markdown
## Scope and permission

- Activity and location: <scope>
- Observer and participants: <roles>
- Permission, privacy, and safety limits: <confirmed rules>
- Behaviors not to record: <limits>

## Observation prompts

- Trigger and intended outcome
- Actors, handoffs, tools, information, and sequence
- Delays, workarounds, interruptions, errors, and recovery
- Differences between documented and observed work
- Questions to ask afterward rather than interrupting the task

## Interpretation boundary

- Direct observations: <what occurred>
- Participant explanations: <what they said>
- Observer inferences: <what needs checking>
- Candidate follow-up: <interview, document check, or another observation>
```

Observation can uncover tacit details, but existing behavior may be accidental or unsuitable for the future process. See PDF pp. 49-50.

## Workshop agenda and notes

```markdown
## Preparation

- Objective and expected result: <specific outcome>
- Invited roles and decision authority: <coverage>
- Missing roles: <gap and follow-up>
- Facilitator and note-taker: <people>
- Inputs: <requirements, conflicts, models, or evidence>
- Ground rules: <participation, critique timing, decision method>

## Agenda

1. Confirm objective, authority, and ground rules.
2. Review evidence and disputed meanings.
3. Gather or compare requirements with the chosen technique.
4. Record conflicts, options, owners, and unresolved questions.
5. Confirm decisions made, decisions deferred, and required follow-up.

## Notes and confirmation

- Evidence and ideas: <attributed where needed>
- Findings and conflicts: <records>
- Decisions and authority: <records>
- Missing voices: <follow-up>
- Participant review status: <pending or evidence>
```

A workshop can expose conflicts, but powerful participants can dominate. Record represented roles and seek missing confirmations. See PDF pp. 42-44.

## Context summary

```markdown
# Draft context summary

- Business problem and desired outcome: <confirmed or hypothetical>
- Proposed system responsibilities: <items>
- Human and external-system responsibilities: <items>
- Relevant context: <people, systems, documents, events>
- Outside current context: <items and confirmation>
- Data or material entering and leaving: <items>
- Boundary disputes and unknowns: <questions with owners>
- Review needed from: <roles>
```

Boundaries are provisional while evidence is incomplete. See PDF pp. 24-26.

## Prototype feedback guide

```markdown
- Learning objective: <assumption or requirement to test>
- Prototype fidelity and missing behavior: <limits explained to participants>
- Tasks or scenarios: <realistic prompts>
- Observe: <actions, confusion, errors, unmet expectations>
- Ask afterward: <reasoning, alternatives, exceptions, quality needs>
- Findings: <observations separate from participant statements>
- Decisions not yet made: <items>
- Follow-up confirmation: <person or role>
```

Say clearly that the prototype is a learning aid, not a release promise. See PDF pp. 50-52.

## Requirement readiness check

Check content readiness before proposing implementation of a requirement version:

- Is its business problem or goal linked?
- Is the actual source named?
- Is the wording unambiguous for its readers?
- Are relevant exception and failure paths covered?
- Can someone describe how acceptance will be checked?
- Does a quality requirement have a measurable target and operating condition when needed?
- Are dependencies and affected records linked?

If content evidence is missing, set readiness to `needs clarification`. Name the person or role to ask, the evidence needed, and a revisit condition when known.

Then check authorization separately. A clear, testable requirement can be ready while still lacking implementation approval. Record it as ready, keep implementation blocked, and name the authority or process that must approve that version. Readiness does not replace stakeholder agreement or implementation approval. See PDF pp. 20 and 122-128.

## Situational review checklist

Choose the checks relevant to the project's risk, requirement type, readers, and available review time. Record findings before changing requirements.

### Content

- required detail and relevant requirements are present;
- the problem, source, dependencies, and linked records are traceable;
- the requirement reflects the source's intent rather than an unmarked inference;
- requirements do not contradict one another or commit to an unjustified design;
- acceptance can be checked, including relevant exceptions and quality targets.

### Form and audience

- wording is clear, precise, and consistent with the project glossary;
- required structure, notation, and format are followed;
- readers have the context and legend needed to understand text or models;
- document purpose, detail, and format still fit the audience.

### Agreement and authority

- relevant stakeholder roles reviewed the stated version;
- missing perspectives and unresolved conflicts remain visible;
- material changes received renewed review;
- agreement and implementation approval each have separate evidence.

```markdown
# Review log: <scope and version>

- Review purpose and selected criteria: <items>
- Reviewers and represented roles: <people or roles>
- Missing reviewers: <roles>
- Findings: <IDs, severity, location, evidence>
- Corrections: <separate later action and links>
- Re-review needed: <scope and owner>
- Agreement evidence: <separate link or not obtained>
- Implementation approval: <separate link or not obtained>
```

The source separates recording review findings from later corrections and calls for renewed alignment after changes. See PDF pp. 120-130.

## Conflict and priority support

Record the parties, evidence, interests, disputed terms, options, decision process, outcome or deferral, and later approval. Do not let the loudest participant or the agent settle a conflict.

Offer prioritization approaches as choices:

- MoSCoW for broad grouping;
- value and risk discussion;
- customer or user impact;
- dependency-aware ordering;
- an established project method.

Explain the selected method and its limits. Do not invent scores or treat priority as approval. See PDF pp. 131-149.

## Change impact check

Start from the changed source, decision, or requirement ID. Trace outward to requirement versions, dependencies, working documents or models, acceptance checks, reviews, decisions, and plan steps. Mark validations that relied on the old statement as stale. Preview the changes and obtain authorization before replacing approved content. Use the change preview in `RECORDS.md`.
