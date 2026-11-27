---
description: Promote only durable, general daily-memory facts into long-term MEMORY.md
argument-hint: "[date-range|topic|recent]"
---

Curate `~/.pi/agent/MEMORY.md` from `~/.pi/agent/memory/`.

Scope: `$ARGUMENTS`
If no scope is given, inspect the newest daily-memory entries since the `_Last updated` date in `MEMORY.md`.

Goal:
- Keep `MEMORY.md` as a lean, high-signal long-term profile.
- Promote only information that will still help future agents across many sessions.
- Update existing entries when possible instead of appending near-duplicates.

Must read first:
1. `~/.pi/agent/MEMORY.md`
2. `~/.pi/agent/memory/index.json`
3. Relevant daily files under `~/.pi/agent/memory/` for the requested scope/date range
4. Nearby existing `MEMORY.md` sections before editing them

Promotion criteria — add/update only if at least one applies:
- Stable user preference, communication style, workflow preference, or recurring behavioral pattern
- Durable project/goal/study context likely useful in future sessions
- Important long-term operational rule not already captured elsewhere
- Major life event, decision, or constraint with future relevance
- Repeated troubleshooting pattern that generalizes into a rule or workflow

Do not promote:
- One-off bugs, command outputs, package versions, paths, hardware details, or transient environment state
- Routine logs, implementation minutiae, temporary TODOs, or completed housekeeping
- Troubleshooting case details unless the lesson is broadly reusable
- Sensitive/private details unless already intentionally stored and clearly useful
- Anything with less than 95/100 confidence after checking available memory context

Editing rules:
- Prefer modifying an existing bullet over adding a new one.
- Keep each addition short: usually one bullet, one sentence.
- Preserve headings, tone, and existing organization.
- Remove or replace stale wording when a newer memory clearly supersedes it.
- Do not duplicate information already present in `MEMORY.md`, AGENTS rules, or active rule notes.
- Update `_Last updated` only if `MEMORY.md` changed.

Confidence requirement:
- Every edit/addition must be backed by explicit daily-memory evidence and fit the promotion criteria.
- Required confidence: >= 95/100 per changed item.
- If confidence is lower, inspect more relevant files.
- If still lower than 95/100, skip the item and mention why.

Workflow:
1. Determine scope from `$ARGUMENTS` or from entries newer than the current `MEMORY.md` update date.
2. Read source memory notes and identify candidate facts.
3. Classify each candidate as `promote`, `update existing`, or `skip`.
4. Apply precise edits to `~/.pi/agent/MEMORY.md` only for high-confidence promoted items.
5. Re-read the edited section/file to verify structure and no accidental duplication.
6. Report:
   - Changed items with confidence scores
   - Skipped notable candidates and why
   - Source files inspected
