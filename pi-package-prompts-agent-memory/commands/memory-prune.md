---
description: Review long-term Pi memory for stale, duplicate, or low-signal entries
argument-hint: "[section|topic]"
---

Review `~/.pi/agent/MEMORY.md` for pruning opportunities.

Scope: `$ARGUMENTS`

Read:
1. `~/.pi/agent/MEMORY.md`
2. Relevant daily/source files only when needed to verify an entry

Find entries that are:
- stale or superseded
- duplicated elsewhere
- too specific or transient
- unsupported by available evidence
- better represented as a rule note or separate troubleshooting note

Return:
- `## Keep`
- `## Prune Candidates`
- `## Merge / Rewrite Candidates`
- `## Proposed Patch`
- `## Confidence`

Rules:
- Do not edit unless explicitly asked.
- Be conservative; preserve useful durable preferences.
- Include confidence per proposed change and explain anything below 90/100.
