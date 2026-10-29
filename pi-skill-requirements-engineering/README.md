# Requirements engineering

Find out what users and stakeholders actually need, write it down as clear requirements, and get them agreed without turning guesses into decisions.

## Helpful when

- Someone asks for a solution ("we need an Excel export") and you want to find the real problem behind it.
- You are preparing an interview, workshop, or survey with users or other stakeholders.
- You have meeting notes, transcripts, emails, or tickets that need to become structured requirements.
- Stakeholders disagree about scope or priorities, or an agreed requirement has changed.

## What to share with Pi

- What the project or feature is about and who is involved
- Any notes, transcripts, existing requirements, or tracker links you already have
- Who you will talk to, how much time you have, and who may approve requirements
- The format you want, such as a table, Jira tickets, user stories, or a specification chapter

## Try asking

> Customers want an Excel export for open invoices. Help me find out which problem is behind it, and prepare a 30-minute interview with accounting.

Other useful requests include:

> Turn these interview notes into requirements. Mark what is a problem, a requirement, or a proposed solution, and list open questions by person.

> Sales and support disagree about what goes into the first release. Help us decide and document the decision.

> REQ-17 may need to change. Show the impact before editing the agreed version.

## What you'll get

- An interview or workshop guide that covers the problem before discussing solutions
- Requirements, each linked to the problem it solves, with acceptance criteria and a quality check
- Open questions grouped by the person who can answer them, plus stakeholder groups not yet heard
- A decision record for conflicts, and a change preview before agreed requirements are revised

## Keep in mind

Pi can organize what people said and draft questions, but it cannot speak for people who were not asked, approve requirements, or authorize implementation. "Agreed" and "approved for implementation" stay separate until the right people confirm them.

Notes and transcripts often contain personal or commercially sensitive information. Pi keeps only what a requirement needs, and asks where to save before writing anything. It never contacts stakeholders or sends surveys for you.

## Install

```bash
pi install npm:@firstpick/pi-skill-requirements-engineering
```

After installation, restart Pi if the skill does not appear in your current session.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for advanced usage, compatibility, privacy, and limitations.
