---
description: Save a concise end-of-session memory note with outcomes and next steps
argument-hint: "[summary/context]"
---

Save an end-of-session note to today’s daily memory file.

Context: `$ARGUMENTS`

Target:
- `~/.pi/agent/memory/YYYY-MM-DD.md` using today’s date

Write only concise facts:
- what changed or was decided
- important files/packages touched
- verification run or explicitly skipped
- unresolved risks or next steps

Do not store:
- secrets, tokens, credentials, or private data
- raw command dumps
- routine chatter or low-signal details

After writing:
1. Re-read the appended note.
2. Report the path, saved bullets, and confidence.

Rules:
- Keep it short: usually 3-6 bullets.
- Use append-only updates unless correcting the just-written note.
- Explain anything below 95/100 confidence.
