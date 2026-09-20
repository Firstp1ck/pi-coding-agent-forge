# Technical reference: Prompts Git PR for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md)

Reusable prompt templates for commit messages, pull request descriptions, and branch review workflows.

## Included prompts

- `/check-pr` — audit PR commits by author/branch/URL and identify risks.
- `/git-staged-msg` — generate short and long conventional commit messages from staged changes.
- `/git-branch-name` — generate a `type/feature-name` PR branch name from staged changes.
- `/pr` — write a concise PR description from the current branch diff and save it under `dev/PR`.
- `/pr-review-branch` — run a non-editing PR-style review against the base branch.
- `/pr-review-implement` — safely implement valid PR review suggestions.
- `/pr-update` — append new branch changes to an existing PR draft.

## Install

```bash
pi install npm:@firstpick/pi-prompts-git-pr
```

For local testing from this repository root:

```bash
pi install ./pi-package-prompts-git-pr
```

## Configuration

No required configuration. After installation, type `/` in Pi to autocomplete the prompt templates.

`/git-staged-msg` accepts optional output preferences:

```text
/git-staged-msg [language: en|de] [scope: auto|never|required]
```

`/pr` accepts an optional output language:

```text
/pr [language: en|de]
```

If Guided Git Workflow is installed, its same-named extension commands take precedence over these templates. Its `/pr` has a separate native implementation; see its [technical reference](../pi-extension-git-guided-workflow/TECHNICAL.md) for behavior and input limits.

This package's `/pr` template defaults to English. It follows the repository's contribution guidance and required PR template. Otherwise, it uses a few short paragraphs without mandatory headings or bullet lists. Small changes usually need no more than 100–200 words. Verification notes distinguish actual results from tests that were merely added or not run; relevant risks and limitations stay in the draft.

The PR body is saved to `dev/PR/<current-branch>.md` under the repository root. `/pr` does not publish it and replies with the saved path. Review the draft before posting, including any required AI-assistance disclosure.

`/git-staged-msg` defaults to English with automatic scope selection. It resolves the Git repository root before reading staged changes and always writes its output under the root-level `dev/COMMIT` directory, including when invoked from a nested subdirectory.

## Dependencies

No repository-local Pi extensions, tools, skills, or other prompt packages are required. This bundle only contributes prompt templates through `pi.prompts`.
