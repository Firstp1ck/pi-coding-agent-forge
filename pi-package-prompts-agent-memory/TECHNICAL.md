# Technical reference: Prompts Agent Memory for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md)

Reusable prompt templates for curating durable Pi agent memory from daily/session notes.

## Included prompts

- `/update-memory` — promote durable, general facts from daily memory into long-term memory.
- `/memory-summarize` — summarize recent daily memory into a concise context brief.
- `/memory-search-context` — search memory for topic-specific facts with sources and confidence.
- `/memory-prune` — review long-term memory for stale, duplicate, or low-signal entries.
- `/memory-rule-add` — draft a scoped rule note from a repeated preference or workflow.
- `/memory-session-save` — append a concise end-of-session note to daily memory.

## Install

```bash
pi install npm:@firstpick/pi-prompts-agent-memory
```

For local testing from this repository root:

```bash
pi install ./pi-package-prompts-agent-memory
```

## Configuration

No required configuration. After installation, type `/` in Pi to autocomplete the prompt templates.

## Dependencies

No repository-local Pi extensions, tools, skills, or other prompt packages are required. This bundle only contributes prompt templates through `pi.prompts`.

## Oh My Pi compatibility

OMP 19.2.1 discovers these templates as slash commands when you link the package. Run `omp plugin list` to check the link, then start a fresh session.

The templates refer to the shared Pi memory paths under `~/.pi/agent/`. Commands that save or prune memory operate on those files when invoked in OMP.
