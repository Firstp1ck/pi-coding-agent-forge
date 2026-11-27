# Prompts Agent Memory for Pi

Adds reusable prompts for keeping Pi’s long-term memory useful and tidy.

## What you can do

- Adds six ready-made memory-maintenance prompts.
- Helps keep durable notes short and useful.
- Separates stable preferences from temporary conversation details.
- Uses Pi’s normal memory locations.

## Install

Install it through Pi:

```bash
pi install npm:@firstpick/pi-prompts-agent-memory
```

Restart Pi if the package does not appear in your current session.

With Oh My Pi (OMP), link this checkout from the repository root and start a new OMP session.

```bash
omp plugin link ./pi-package-prompts-agent-memory
```

These commands use your existing Pi memory files under `~/.pi/agent/`, including when you invoke them from OMP.

## How to use it

Run `/update-memory` when you want Pi to review and tidy durable memory. Confirm that the proposed notes are accurate and do not contain secrets before keeping them.

- `/update-memory` — promote durable, general facts from daily memory into long-term memory.
- `/memory-summarize` — summarize recent daily memory into a concise context brief.
- `/memory-search-context` — search memory for topic-specific facts with sources and confidence.
- `/memory-prune` — review long-term memory for stale, duplicate, or low-signal entries.
- `/memory-rule-add` — draft a scoped rule note from a repeated preference or workflow.
- `/memory-session-save` — append a concise end-of-session note to daily memory.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-package-prompts-agent-memory/TECHNICAL.md) for complete commands, configuration, compatibility, security, and troubleshooting information.
