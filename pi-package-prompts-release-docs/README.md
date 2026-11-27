# Prompts Release Docs for Pi

Adds ready-made prompts for release notes, announcements, README updates, and wiki updates.

## What you can do

- Creates release notes and announcements.
- Updates README and wiki content from real changes.
- Summarizes branches and versions for publication.
- Keeps generated release material in predictable project folders.

## Install

Install it through Pi:

```bash
pi install npm:@firstpick/pi-prompts-release-docs
```

Restart Pi if the package does not appear in your current session.

With Oh My Pi (OMP), link this checkout from the repository root and start a new OMP session.

```bash
omp plugin link ./pi-package-prompts-release-docs
```

## How to use it

Choose the prompt for the document you need, such as `/announce-version` or `/readme-update`, and point Pi at the real changes or release information.

- `/announce-branch` — create a short user-facing branch announcement.
- `/announce-version` — create a short user-facing version announcement.
- `/readme-update` — update README content from actual branch changes.
- `/release-new` — generate release notes for a version.
- `/ship` — prepare verification notes, release notes, commits, and risks.
- `/summary` — summarize recent repository work.
- `/update-wiki` — update wiki docs from branch changes.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-package-prompts-release-docs/TECHNICAL.md) for complete commands, configuration, compatibility, security, and troubleshooting information.
