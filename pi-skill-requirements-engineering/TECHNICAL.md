# Technical reference: Requirements engineering

Advanced user setup, usage, compatibility, privacy, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

This portable skill helps you elicit, document, check, and agree on requirements. It does not impose a waterfall. Elicitation, documentation, review, alignment, and change management can repeat in the order the project needs.

## Install or enable

Pi does not install or enable this skill automatically. Install it with:

```bash
pi install npm:@firstpick/pi-skill-requirements-engineering
```

After installation, restart Pi if it does not appear in the current session. The package has no npm runtime dependencies.

## Language

The skill and its references are written in English. Pi answers in the language you use and may translate template field names. Requirement and problem IDs such as `REQ-12` and `P-3` stay unchanged.

## Working modes

Pi picks a mode from your situation and asks when it is unclear:

| Mode | Use it when |
| --- | --- |
| A: Preparation | You are preparing an interview, workshop, or stakeholder survey. |
| B: Live elicitation | You or a stakeholder want to work out requirements in the chat, one question at a time. |
| C: Evaluation | You bring notes, transcripts, emails, tickets, or a specification to analyze. |
| D: Alignment | Stakeholders disagree or need to settle scope and priorities. |
| E: Change | A source, decision, or agreed requirement changes. |

In every mode Pi separates the problem (what should change and why), the requirement (what a system must do or be), and the proposed solution (a concrete implementation). Each documented requirement links to a problem entry (`P-<number>`). A missing link is recorded as an open question.

Besides interviews, Pi can suggest and draft observation guides, surveys, workshop agendas, context summaries, prototype feedback guides, readiness checks, and review logs when the situation calls for them.

## Requirement fields and states

A requirement record contains an ID, version, title, linked problem, wording, type, source, exceptions, measurable quality target where needed, dependencies, priority, acceptance criteria, and open questions. You can drop fields your project does not use.

These states stay separate:

- **Content status:** draft, ready for review, agreed, or rejected.
- **Agreed by:** the people or roles who agreed, with date and version.
- **Approved for implementation:** the person or process that released this version.
- **Implemented:** evidence that the work happened.

A clear, testable requirement can still lack approval. Agreement does not authorize implementation. Priorities proposed by Pi are labelled as proposals until the responsible person decides.

## Projects, records, and existing trackers

In a project directory, Pi first reads a bounded set of project documents, and code only when needed. It separates documented facts, code observations, its own inferences, conflicts, and unknowns. Code shows what was built, not whether anyone wanted or agreed to it.

If the project already uses a tracker such as Jira, it stays the source of truth. Pi links to its items rather than starting a second list.

If saved plans or work states exist, Pi lists them and asks which one, if any, to continue. It does not pick the newest one by default and does not edit a plan before you confirm it.

Choose a writable location before Pi saves anything. `requirements/<project-name>/` is only an example. The record templates are adaptable and do not override project policy, regulatory obligations, or an established approval process.

## Changing agreed requirements

When something changes, Pi records the new information with its source and date, traces affected requirements, acceptance criteria, tests, documents, decisions, and planned work, and shows a change preview. Reviews and agreements based on the old version are marked as stale for the new one. Pi asks the responsible person to confirm before changing agreed material. Without that confirmation, the current version stays valid. Confirmed changes become a new version, and the old one is kept.

## Optional Pi questionnaire

Pi can use its native questionnaire interface for a short set of related choices you make yourself. This is not a survey sent to stakeholders. If you ask for clarification, Pi answers and then continues the same questionnaire. If you cancel it, Pi stops the dialog and returns the open choice to you in the chat. If the interface is unavailable, Pi continues in ordinary conversation.

## Privacy and authority

Decide the preferred language, storage location, retention period, and restrictions before saving personal stakeholder details or interview results. When analyzing notes or transcripts, Pi keeps only details a requirement needs, prefers roles over names, and leaves out contact data and credentials.

Pi may draft contact material but does not contact people, send surveys, record conversations, or claim consent. What you report about another person's view is recorded as your statement, not their confirmation. Role-play can help prepare questions but never counts as a stakeholder's input. Legal constraints stay unverified until a qualified person confirms they apply.

## Source and terminology

The method guidance and bundled glossary paraphrase IU Internationale Hochschule, *Requirements Engineering*, IREN01, version 003-2023-0817. Citations use PDF page numbers. The source PDF is not bundled.

A project's own agreed glossary controls local domain meanings. If it conflicts with the general glossary, Pi shows the difference and asks the relevant person which meaning applies. It does not silently rewrite stakeholder language.

## Compatibility and limitations

- Designed as a portable Agent Skills-style skill and packaged for Pi.
- Works in a plain chat without project files. Reading project evidence requires read access; saving records requires an authorized writable location.
- Does not require a particular tracker, elicitation sequence, diagram notation, or questionnaire interface.
- Cannot verify inaccessible stakeholder statements, deployment state, legal applicability, or implementation status.
- Does not provide legal advice or formal BPMN or UML validation.
- Model judgment guides method choice and evidence interpretation. Evaluate representative sessions instead of treating static wording checks as a behavioral guarantee.

## Upgrading from earlier versions

Versions up to 0.1.0 centered on a plan-confirmation gate with an optional Grill Me interview. The current skill is organized around the five working modes above and no longer offers or checks Grill Me. Existing records and plans stay usable: Pi still lists saved plans and asks before continuing one. If you relied on Grill Me, start it yourself when you want it; the skill will treat its saved result as your input, not as stakeholder agreement.

## Troubleshooting

- **Pi writes a requirement straight from a solution request:** ask it to separate problem, requirement, and solution, or say "what problem does this solve?". Pi should record the solution as a proposal and ask about its purpose.
- **Several plans look relevant:** choose one explicitly, name another plan, start a separate effort, or stop. Pi should not select the newest plan for you.
- **Documents and code disagree:** state which source supports each claim, then ask who can establish current intent. Neither source alone proves stakeholder agreement.
- **Almost everything is Must:** ask Pi to help narrow priorities. It should ask whether the system would be accepted without each item and leave the final decision to the responsible person.
- **A write fails:** Pi keeps the full result in the conversation, names what was not saved and why, and suggests a safe retry location.
- **A requirement remains incomplete:** it stays a draft with an open question naming who to ask and which evidence is missing. Pi should not invent a deadline.
- **A term is unclear:** ask for a plain explanation in the current project context. Pi cites the general source when useful and says when a term is not in the glossary.
