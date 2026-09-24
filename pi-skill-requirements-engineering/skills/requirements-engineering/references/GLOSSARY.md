# Requirements-engineering glossary

This reference paraphrases IU Internationale Hochschule, *Requirements Engineering*, IREN01, version 003-2023-0817. Page citations are PDF pages. The source PDF is not bundled. These definitions are neither quotations nor a formal standard.

A project's agreed glossary controls its local domain language. If a local meaning differs, show the two meanings and ask the relevant person which one belongs in the requirement. Do not rewrite stakeholder wording or claim agreement without evidence.

Explain an unfamiliar term briefly on first use. If the user asks about a sentence, explain the decision or action it implies in their project instead of reciting definitions.

## Goals and requirements

| Term | Plain-language meaning | Source |
| --- | --- | --- |
| Requirements engineering, RE | Recurring work to find, document, check, agree, and manage what a system needs to achieve. It is not a one-time specification phase. | PDF pp. 14-17 |
| Business problem | What people need to change or achieve in their work. It gives a proposed system its reason. | PDF p. 19 |
| Project or product vision | A short account of the project's goal and motivation that helps people check their shared understanding. | PDF pp. 61-62 |
| Solution or system | A particular way to address the problem. Choosing one early can hide other options. | PDF pp. 18-19 |
| Requirement | A needed function or property of a proposed system, tied to a goal or problem. A suggestion is not automatically an agreed requirement. | PDF pp. 17-20 |
| Functional requirement | A capability the system must provide. | PDF p. 20 |
| Quality requirement | How well the system must perform or protect something. Use a measurable target and operating condition when they matter for checking it. | PDF p. 20 |
| Constraint | An organizational, legal, or technical condition that limits an acceptable solution. Check whether it applies to this project. | PDF p. 20 |

## People, context, and elicitation

| Term | Plain-language meaning | Source |
| --- | --- | --- |
| Stakeholder | A person or group affected by the system or its creation, or involved in it. Stakeholders can have conflicting needs. | PDF pp. 15, 26-28 |
| System context | The relevant surroundings for understanding requirements, including people, connected systems, and sometimes documents. | PDF pp. 24-26 |
| System boundary | What the proposed system will do, as distinct from what a person or connected system does. It may change while scope is clarified. | PDF p. 25 |
| Context boundary | What belongs to the relevant surroundings and what can be left outside the current analysis. | PDF pp. 25-26 |
| Requirements source | A stakeholder, document, existing system, or other place from which a possible requirement comes. A source need not have decision authority. | PDF pp. 24-27 |
| Elicitation | Finding and understanding possible requirements through suitable sources and methods. The needed detail depends on the current question. | PDF pp. 24, 30-33 |
| Interview | A guided conversation that permits follow-up questions. Its summary should be checked with the participant. A draft guide is not evidence that an interview happened. | PDF pp. 46-48 |
| Survey or questionnaire | Prepared questions for a group. The author usually cannot clarify each response in the moment. It differs from an interactive tool that asks the project owner for choices. | PDF p. 48 |
| Observation | Watching real work to uncover details people may not mention. Existing habits still need scrutiny before they become requirements. | PDF pp. 49-50 |
| Prototype | An early representation or working slice used to learn about a problem, solution, or interface. It need not become part of the final product. | PDF pp. 50-52 |

## Documentation, checking, and agreement

| Term | Plain-language meaning | Source |
| --- | --- | --- |
| Requirements documentation | A shared record of current understanding, written for its intended readers. Its form can mix text, tables, sketches, prototypes, and models. | PDF pp. 58-68 |
| Model | A simplified account of one part of a process or system, often drawn with defined symbols. Readers need its notation and relation to nearby text. | PDF pp. 66-68 |
| Glossary | The project's agreed meanings for domain words, abbreviations, and terms used in a special way. | PDF p. 63 |
| Use case | A main system function viewed by a person or another system outside it. A use-case diagram gives an overview, not detailed steps or data. | PDF pp. 101-102 |
| Review or checking | Examining requirements for missing, unclear, contradictory, or unsuitable content and recording findings. Finding an issue is separate from correcting it. | PDF pp. 120-126 |
| Traceability | The ability to follow a requirement to its source or purpose and through dependencies and related records. | PDF p. 122 |
| Testability | The ability to describe how implemented behavior or a property would be checked. It does not mean the test ran. | PDF p. 123 |
| Acceptance criterion | A specific condition used later to judge whether a requirement was met. Writing it does not mean the result was accepted or implementation was authorized. | PDF p. 123 |
| Agreement or alignment | Work with relevant stakeholders toward shared understanding and addressed conflicts. Agreement on meaning differs from authorization to implement. | PDF pp. 121, 125 |
| Conflict | A disagreement or contradiction that relevant people must examine before deciding what to do. An agent can record options but cannot settle it for them. | PDF pp. 131-133 |
| Release for implementation | An explicit decision that work may proceed on a stated requirement version. It does not prove implementation or remove every quality concern. | PDF p. 125 |

## Managing requirements over time

| Term | Plain-language meaning | Source |
| --- | --- | --- |
| Requirement status and stability | Status records where an item is in the work. Stability records how likely its content is to change. Neither proves review, agreement, or implementation approval. | PDF pp. 136-138 |
| Priority | Relative importance or order for attention. Value, risk, cost, stakeholder needs, and dependencies may affect it. Priority is not approval. | PDF pp. 142-143 |
| MoSCoW | A grouping into must, should, could, and won't for now. It does not order every item inside a group. | PDF pp. 143-144 |
| Requirement version | An identifiable revision of one requirement, used to follow changes and recover earlier wording. | PDF pp. 139-140 |
| Requirement configuration | An identified, fixed set of particular requirement versions considered together. A change produces a different configuration. | PDF p. 140 |

## Terms introduced by this skill

These are working terms for the skill. They are not definitions from the course source.

| Term | Meaning in this skill |
| --- | --- |
| Living RE plan | A user-selected, revisable set of requirements actions. Each step states its actor, purpose, inputs, expected result, evidence, status, and next ready action. |
| Next-step guide | The immediate handoff used when a credible plan is not yet possible. It states who acts, what to ask or inspect, why, the expected result, and what makes the step done. |
| Requirement readiness | A check for a linked problem and source, clear wording, relevant exceptions, testable acceptance, and a measurable quality target where needed. It grants no approval. |
| Confirmed versus inferred | Confirmed means the named person or authoritative record supports the claim. Inferred means the agent drew a tentative conclusion from evidence such as code. |

For example, "REQ-17 is testable but not released for implementation" means someone can describe how to check it later, but no verified decision yet authorizes work on that version. See testability on PDF p. 123 and release for implementation on PDF p. 125.
