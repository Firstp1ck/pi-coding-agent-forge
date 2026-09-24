# Requirements-engineering glossary

A plain-language reference for the proposed [requirements-engineering skill](../../plans/planned/requirements-engineering-guidance-skill.md). The course source is IU Internationale Hochschule, *Requirements Engineering*, IREN01, version 003-2023-0817, [local PDF](Script_Requirements-Engeenering.pdf). Definitions below are **paraphrases**, not quotations or a formal standard. Page links refer to PDF pages. A project's agreed terminology may be more specific; ask the people involved before treating a local meaning as settled.

When the agent uses an unfamiliar term, it should give a short plain-language meaning on first use. If asked "What do you mean by that?", it should explain the term in the current project's context, distinguish it from nearby terms, and point to the source when useful. For a whole sentence, restate what decision or action it implies rather than reciting a definition. Answer in the user's preferred language and retain the German source term as an alias when useful. If the project uses a term differently, flag the difference and ask which meaning should go into its own glossary. Do not change a stakeholder's wording or claim their agreement on the agent's behalf.

## Goals and requirements

| Term | Meaning in this reference | Source |
| --- | --- | --- |
| **Requirements engineering (RE)** | The recurring work of finding, documenting, checking, agreeing, and managing what a system needs to achieve. It is not just writing a specification once at project start. | [pp. 14-17](Script_Requirements-Engeenering.pdf#page=14) |
| **Business problem** (*fachliches Problem*) | What people need to change or achieve in their work. It is the reason to consider a system, not the system itself. | [p. 19](Script_Requirements-Engeenering.pdf#page=19) |
| **Project or product vision** (*Projekt-/Produktvision*) | A short shared account of the project's goal and motivation. It helps people check that they are discussing the same purpose. | [pp. 61-62](Script_Requirements-Engeenering.pdf#page=61) |
| **Solution or system** (*Lösung/System*) | A particular way to address the problem. Choosing one too early may hide other options. | [pp. 18-19](Script_Requirements-Engeenering.pdf#page=18) |
| **Requirement** (*Anforderung*) | A needed function or property of a proposed system, linked to the goal or problem it should address. A suggested solution is not automatically an agreed requirement. | [pp. 17-20](Script_Requirements-Engeenering.pdf#page=17) |
| **Functional requirement** (*funktionale Anforderung*) | A capability the system must provide, such as letting an authorized person submit a request. | [p. 20](Script_Requirements-Engeenering.pdf#page=20) |
| **Quality requirement** (*Qualitätsanforderung*) | How well the system must perform or protect something, such as a response-time or data-protection property. Specify a measurable condition when it matters for checking the result. | [p. 20](Script_Requirements-Engeenering.pdf#page=20) |
| **Constraint** (*Randbedingung*) | An organizational, legal, or technical condition that limits the acceptable solution. Its applicability must be checked for the project; the agent cannot provide legal approval. | [p. 20](Script_Requirements-Engeenering.pdf#page=20) |

## People, context, and finding requirements

| Term | Meaning in this reference | Source |
| --- | --- | --- |
| **Stakeholder** | A person or group affected by the system or its creation, or involved in it. Different stakeholders can want different things. | [pp. 15, 26-28](Script_Requirements-Engeenering.pdf#page=15) |
| **System context** (*Systemkontext*) | The part of the surroundings that matters for understanding requirements, including relevant people, other systems, and sometimes documents. | [pp. 24-26](Script_Requirements-Engeenering.pdf#page=24) |
| **System boundary** (*Systemgrenze*) | What the proposed system itself will do, as opposed to what a person or connected system does. The boundary can change while scope is being clarified. | [p. 25](Script_Requirements-Engeenering.pdf#page=25) |
| **Context boundary** (*Kontextgrenze*) | What belongs to the relevant surroundings rather than the environment that need not be considered for this system. This boundary can also change as facts emerge. | [pp. 25-26](Script_Requirements-Engeenering.pdf#page=25) |
| **Requirements source** (*Anforderungsquelle*) | Where a potential requirement comes from: a stakeholder, document, existing system, or another relevant source. A source is not automatically a decision-maker. | [pp. 24-27](Script_Requirements-Engeenering.pdf#page=24) |
| **Elicitation** (*Ermittlung*) | Finding and understanding potential requirements using suitable sources and methods. The detail needed depends on the project's current question. | [pp. 24, 30-33](Script_Requirements-Engeenering.pdf#page=24) |
| **Interview** | A guided conversation that can probe answers and clarify meaning. Its notes should be checked with the participant; an interview draft is not evidence that one happened. | [pp. 46-48](Script_Requirements-Engeenering.pdf#page=46) |
| **Survey or questionnaire** (*Fragebogen*) | Prepared questions for a group of respondents. Unlike an interview, the questioner usually cannot clarify an answer in the moment. This is separate from Pi's questionnaire tool for asking the project owner choices. | [p. 48](Script_Requirements-Engeenering.pdf#page=48) |
| **Observation** (*Beobachtung*) | Watching real work to uncover activities people may not think to mention. Observed habits need scrutiny before becoming requirements for a changed process. | [pp. 49-50](Script_Requirements-Engeenering.pdf#page=49) |
| **Prototype** (*Prototyp*) | An early representation or working slice used to learn about a problem, possible solution, or interface. It is not necessarily part of the final product. | [pp. 50-52](Script_Requirements-Engeenering.pdf#page=50) |

## Documentation, checking, and agreement

| Term | Meaning in this reference | Source |
| --- | --- | --- |
| **Requirements documentation** (*Anforderungsdokumentation*) | A shared record of the current understanding, written for its intended readers. It can combine text, tables, sketches, prototypes, and models; its form is not universal. | [pp. 58-68](Script_Requirements-Engeenering.pdf#page=58) |
| **Model** (*Modell*) | A simplified description of one aspect of a process or system, often as a diagram with defined symbols. It needs enough explanation for its readers and should agree with related text. | [pp. 66-68](Script_Requirements-Engeenering.pdf#page=66) |
| **Glossary** (*Glossar*) | The project's agreed meanings for its domain words, abbreviations, and terms used in a special way. This general reference does not override it. | [p. 63](Script_Requirements-Engeenering.pdf#page=63) |
| **Use case** (*Anwendungsfall*) | A main system function viewed by a person or another system outside the one being built. A use-case diagram provides an overview, not the detailed order of steps or data structures. | [pp. 101-102](Script_Requirements-Engeenering.pdf#page=101) |
| **Review or checking** (*Prüfen*) | Examining requirements for missing, unclear, contradictory, or unsuitable content and recording findings. Finding a problem is separate from correcting it. | [pp. 120-126](Script_Requirements-Engeenering.pdf#page=120) |
| **Traceability** (*Verfolgbarkeit*) | Being able to follow a requirement back to its source or purpose and across relevant dependencies and related records. | [p. 122](Script_Requirements-Engeenering.pdf#page=122) |
| **Testability** (*Überprüfbarkeit*) | Being able to describe how the implemented behavior or property would be checked. It does not mean the test has already run. | [p. 123](Script_Requirements-Engeenering.pdf#page=123) |
| **Acceptance criterion** (*Abnahmekriterium*) | A specific condition or check used later to judge whether a requirement has been met. Writing one does not mean anyone has accepted the result or approved implementation. | [p. 123](Script_Requirements-Engeenering.pdf#page=123) |
| **Agreement or alignment** (*Abstimmen/Abgestimmtheit*) | Working with relevant stakeholders until they share an adequate understanding and known conflicts are addressed. Agreement on meaning is distinct from authorization to implement. | [pp. 121, 125](Script_Requirements-Engeenering.pdf#page=121) |
| **Conflict** (*Konflikt*) | A disagreement or contradiction that needs the relevant people to examine facts, interests, or meanings before choosing what to do. The agent may record options but cannot settle it for them. | [pp. 131-133](Script_Requirements-Engeenering.pdf#page=131) |
| **Release for implementation** (*Freigabe zur Umsetzung*) | An explicit decision that work may proceed on a stated requirements version. It does not mean that the requirement is implemented or that every quality concern has disappeared. | [p. 125](Script_Requirements-Engeenering.pdf#page=125) |

## Managing requirements over time

| Term | Meaning in this reference | Source |
| --- | --- | --- |
| **Requirement status and stability** (*Status/Stabilität*) | Status describes where an item is in the work, while stability says how likely its content is to change. Neither alone proves review, agreement, or implementation approval. | [pp. 136-138](Script_Requirements-Engeenering.pdf#page=136) |
| **Priority** (*Priorität*) | The relative importance or order for attention. Value, risk, cost, stakeholder needs, and dependencies can all affect it; priority is not the same as approval. | [pp. 142-143](Script_Requirements-Engeenering.pdf#page=142) |
| **MoSCoW** | A quick grouping into must, should, could, and won't **for now**. It does not by itself order all items within a group. | [pp. 143-144](Script_Requirements-Engeenering.pdf#page=143) |
| **Requirement version** (*Anforderungsversion*) | An identifiable revision of one requirement, so changes can be followed and an earlier wording can be found. | [pp. 139-140](Script_Requirements-Engeenering.pdf#page=139) |
| **Requirement configuration** (*Anforderungskonfiguration*) | An identified, fixed set of particular requirement versions considered together. A change creates a different configuration. | [p. 140](Script_Requirements-Engeenering.pdf#page=140) |

## Working language of the proposed skill

These are **skill-design terms**, not definitions claimed from the course script:

| Phrase | What the agent means |
| --- | --- |
| **Living RE plan** | A user-selected, revisable sequence of requirements-engineering actions, each with an owner, expected result, and next ready step. It is not a fixed sequence taken from the script. |
| **Next-step guide** | A smaller handoff when a credible plan is not yet possible: the immediate action, why it matters, who should act, what to ask or inspect, the expected result, and how to know it is done. |
| **Requirement readiness** | The skill's check for a linked problem and source, clear wording, relevant exceptions, and a way to verify the result. It does not grant human agreement or implementation approval. |
| **Confirmed versus inferred** | Confirmed means the named person or authoritative record actually supports a claim; inferred means the agent drew a tentative conclusion from evidence such as code. An inference must be labeled and checked before being treated as a requirement. |

For example, if the agent says **"REQ-17 is testable but not released for implementation,"** it means there is a way to check the result later, but no verified decision yet authorizes implementation of that requirement version. The user can ask for the source, who must decide, or a simpler explanation. See [testability](Script_Requirements-Engeenering.pdf#page=123) and [release for implementation](Script_Requirements-Engeenering.pdf#page=125).
