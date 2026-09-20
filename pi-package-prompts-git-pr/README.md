# Prompts Git PR for Pi

Adds ready-made prompts for commits, pull requests, and PR reviews.

## What you can do

- Generates commit messages from staged changes.
- Creates branch names and short, plain-language pull-request descriptions.
- Reviews pull requests without editing them.
- Can help apply valid review suggestions safely.

## Install

Install it through Pi:

```bash
pi install npm:@firstpick/pi-prompts-git-pr
```

Restart Pi if the package does not appear in your current session.

## How to use it

Stage or prepare the relevant Git changes, then choose a prompt such as `/git-staged-msg`, `/pr`, or `/pr-review-branch`. Review generated text before committing or publishing it.

- `/check-pr` — audit PR commits by author/branch/URL and identify risks.
- `/git-staged-msg` — generate short and long conventional commit messages from staged changes.
- `/git-branch-name` — generate a `type/feature-name` PR branch name from staged changes.
- `/pr` — write a concise PR description from the current branch diff and save it under `dev/PR`.
- `/pr-review-branch` — run a non-editing PR-style review against the base branch.
- `/pr-review-implement` — safely implement valid PR review suggestions.
- `/pr-update` — append new branch changes to an existing PR draft.

Run `/pr` on your feature branch, then review the saved draft before posting it. It explains the reason for the change, what changed, and what was verified without forcing a report-style layout. Required repository templates still take precedence. Use `/pr de` for German.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-package-prompts-git-pr/TECHNICAL.md) for complete commands, configuration, compatibility, security, and troubleshooting information.
