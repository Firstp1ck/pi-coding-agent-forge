---
description: Audit recent PR commits by author, explain intent and risks, and propose concrete fixes.
argument-hint: "<author|pr-branch|pr-url>"
---
Review recent commits for **$@** in the PR context.

Workflow:
1. Identify commit range and author-relevant commits.
2. For each commit: explain what changed, why it matters, and possible side effects.
3. Flag critical logic issues (correctness, security, data loss, race conditions, broken edge cases).
4. For each critical issue, provide a specific fix approach.

Return format:
- `## Commit Walkthrough`
- `## Critical Findings`
- `## Suggested Fixes`

Rules:
- Cite files/functions when possible.
- If evidence is insufficient, say so explicitly.
- No code changes unless user asks.