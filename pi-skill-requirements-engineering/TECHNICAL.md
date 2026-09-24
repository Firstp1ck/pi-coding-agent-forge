# Technical reference: Requirements engineering

Advanced user setup, usage, compatibility, privacy, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

This portable skill guides recurring requirements work. It does not impose a waterfall. Elicitation, documentation, review, alignment, and management can repeat in the order the project needs.

## Install or enable

Version 0.1.0 is currently unpublished and is not installed or enabled automatically. After publication, and only when installation is explicitly authorized, install it with:

```bash
pi install npm:@firstpick/pi-skill-requirements-engineering
```

After installation, restart Pi if it does not appear in the current session. The package has no npm runtime dependencies.

## Supported requests

Ask Pi to start, update, or resume requirements engineering, explain a term, assess whether a requirement is ready for implementation handoff, or draft a working document. A useful request names the project, any plan under consideration, the desired outcome, and the allowed write locations.

When you provide only a project directory, Pi should:

1. show relevant continuation plans and ask which one, if any, to use;
2. ask whether to use Grill Me when the selected plan lacks a completed plan-specific interview;
3. if no plan is selected, inspect a bounded set of current project evidence;
4. separate documented facts, code observations, inferences, conflicts, and unknowns; and
5. finish with a maintained plan or a concrete guide to the next safe step.

The skill asks an open question when the possible answers cannot be listed honestly, such as the project's business problem. It may offer bounded choices for known candidates, such as two discovered plans, whether to use a saved partial interview, or whether to continue without optional UI.

## Records and existing trackers

Choose a writable project location before saving. `requirements/<project-name>/` is only an example. If the project already has a canonical requirements tracker, keep it canonical and store links or workflow notes instead of copying its requirements into a second register.

A small Markdown record set can contain an overview, requirement register, decisions, workflow state, and only the working documents the project needs. The templates are adaptable. They do not override project policy, regulatory obligations, or an established approval process.

Follow the host project's plan lifecycle. A resume updates the confirmed plan or guide rather than starting a parallel record. A plan's presence does not authorize Pi to use or edit it.

## Optional Pi interaction

Pi can use its native questionnaire interface for a short set of related owner choices. This is not the same as a survey sent to stakeholders. If the interface is cancelled or unavailable, Pi should preserve known answers, report the limitation, and continue in ordinary conversation or give the next safe action.

Grill Me can explore project decisions through an interactive interview. Pi should offer it only after you confirm a continuation plan, unless you request it directly. Starting `/grill-me` again can replace its current project state, so Pi must not launch or restart it without your choice. A saved Grill Me result is decision input, not proof that other stakeholders agreed.

The core workflow does not depend on either integration.

## Privacy and authority

Decide the preferred language, storage location, retention period, and restrictions before saving personal stakeholder details or interview results. Minimize personal data. Questionnaire answers can remain in a model session, while project records may be shared through source control or other project systems.

Pi may draft contact material but does not contact people, send surveys, record conversations, or claim consent. It must keep these states separate:

- a review finding;
- a correction to a requirement;
- stakeholder agreement;
- permission to implement a stated version; and
- evidence that implementation occurred.

Only the project's named people or established process can supply the corresponding confirmations.

## Source and terminology

The bundled glossary contains short paraphrases based on IU Internationale Hochschule, *Requirements Engineering*, IREN01, version 003-2023-0817. Citations use PDF page numbers. The source PDF is not bundled.

A project's own agreed glossary controls local domain meanings. If it conflicts with the general glossary, Pi should show the difference and ask the relevant person which meaning applies. It should not silently rewrite stakeholder language.

## Compatibility and limitations

- Designed as a portable Agent Skills-style skill and packaged for Pi.
- Requires read access to project evidence. Saving records requires an authorized writable location.
- Does not require a particular tracker, elicitation sequence, diagram notation, questionnaire interface, or Grill Me.
- Cannot verify inaccessible stakeholder statements, deployment state, legal applicability, or implementation status.
- Does not provide legal advice or formal BPMN or UML validation.
- Model judgment guides method choice and evidence interpretation. Evaluate representative sessions instead of treating static wording checks as a behavioral guarantee.

## Troubleshooting

- **Several plans look relevant:** choose one explicitly, name another plan, start a separate RE effort, or stop. Pi should not select the newest plan for you.
- **A Grill Me result is partial or unclear:** choose whether to use the saved decisions, start a new interview, or skip it. Preserve the partial result until you approve replacement.
- **Documents and code disagree:** state which source supports each claim, then ask who or what can establish current intent. Neither source alone proves stakeholder agreement.
- **A write fails:** keep the proposed plan or next-step guide in the conversation, name what was not saved, and choose a writable location before retrying.
- **A requirement remains incomplete:** mark it as needing clarification and assign a person or role, required evidence, and a revisit condition when known. Do not invent a deadline.
- **A term is unclear:** ask for a plain explanation in the current project context. Pi should cite the general source when useful and identify skill-specific wording as such.
