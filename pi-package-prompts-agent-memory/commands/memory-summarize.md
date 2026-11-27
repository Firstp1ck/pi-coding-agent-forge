---
description: Summarize recent daily memory into a concise context brief
argument-hint: "[date-range|topic|recent]"
---

Summarize recent Pi memory into a short context brief.

Scope: `$ARGUMENTS`
If empty, use the newest daily memory files from `~/.pi/agent/memory/`.

Read:
1. `~/.pi/agent/MEMORY.md`
2. `~/.pi/agent/memory/index.json` if present
3. Relevant daily files under `~/.pi/agent/memory/`

Return:
- `## Context Brief`
- `## Active Preferences / Rules`
- `## Recent Decisions`
- `## Open Follow-ups`
- `## Sources`

Rules:
- Be concise and source-grounded.
- Separate durable facts from transient notes.
- Do not edit files.
- Include confidence per section and explain any confidence below 90/100.
