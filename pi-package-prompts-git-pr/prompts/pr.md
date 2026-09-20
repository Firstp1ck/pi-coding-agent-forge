---
description: Write a short, plain-language PR description from the branch diff and save under dev/PR.
argument-hint: "[language: en|de]"
---
Create a PR description for the current branch in `${1:-en}` (`en` = English, `de` = German).

Read the branch diff and commits against the repository default branch (`main`, `master`, or upstream default). Check the repository's contribution guidance and PR template, including `.github/PULL_REQUEST_TEMPLATE.md` if present. Follow required formatting and disclosure rules; otherwise use the style below.

Writing style:
- Write like a developer explaining a change to a teammate, not a generated report. Use plain, direct language and concrete facts from the diff.
- Start with the problem or reason for the change, then explain what changes. Prefer 1–3 short paragraphs, roughly 100–200 words or fewer for a small fix. Add length only when reviewers need it.
- No headings by default. Use a short list only for genuinely separate changes, and headings only when the description would otherwise be hard to follow. Do not force Summary / Changes / Risks / Test plan sections.
- Include a brief verification sentence with actual results. If tests were not run or results are unknown, say so plainly. Never turn added tests into a claim that they passed.
- Mention risks, compatibility changes, or limitations only when concrete and relevant. Do not add "Risk: low", "No breaking changes", or other boilerplate just to fill space.
- Link a related issue only when known. Use `Fixes #...` only when the change actually resolves it.
- Skip file-by-file inventories, diff statistics, repeated summaries, promotional wording, decorative formatting, and unnecessary implementation detail. Keep details that explain a non-obvious decision.
- Do not invent personal experience, testing, or human review to sound natural. Do not leave template placeholders unresolved.

Save only the PR body to `dev/PR/<current-branch>.md` under the repository root. Do not publish it. Reply with the saved path rather than repeating the draft.