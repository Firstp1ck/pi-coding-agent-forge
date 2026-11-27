# Technical reference: Prompts Release Docs for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md)

Reusable prompt templates for release preparation, documentation updates, branch summaries, and user-facing announcements.

## Included prompts

- `/announce-branch` — create a short user-facing branch announcement.
- `/announce-version` — create a short user-facing version announcement.
- `/readme-update` — update README content from actual branch changes.
- `/release-new` — generate release notes for a version.
- `/ship` — prepare verification notes, release notes, commits, and risks.
- `/summary` — summarize recent repository work.
- `/update-wiki` — update wiki docs from branch changes.

## Install

```bash
pi install npm:@firstpick/pi-prompts-release-docs
```

For local testing from this repository root:

```bash
pi install ./pi-package-prompts-release-docs
```

## Configuration

No required configuration. After installation, type `/` in Pi to autocomplete the prompt templates.

## Dependencies

No repository-local Pi extensions, tools, skills, or other prompt packages are required. This bundle only contributes prompt templates through `pi.prompts`.

## Oh My Pi compatibility

OMP 19.2.1 discovers these templates as slash commands when you link the package. Run `omp plugin list` to check the link, then start a fresh session.
