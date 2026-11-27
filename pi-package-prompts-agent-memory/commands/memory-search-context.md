---
description: Search Pi memory for topic-specific context with sources and confidence
argument-hint: "<topic>"
---

Find memory context for: `$ARGUMENTS`

Read:
1. `~/.pi/agent/MEMORY.md`
2. `~/.pi/agent/memory/index.json` if present
3. Matching daily files under `~/.pi/agent/memory/`
4. Matching rule notes under `~/.pi/agent/memory/notes/`

Return:
- `## Relevant Durable Facts`
- `## Relevant Recent Notes`
- `## Active Rules`
- `## Sources`
- `## Confidence`

Rules:
- Do not edit files.
- Prefer exact source matches over inference.
- Mark stale, conflicting, or weakly supported items.
- Include confidence for each returned fact and explain anything below 90/100.
