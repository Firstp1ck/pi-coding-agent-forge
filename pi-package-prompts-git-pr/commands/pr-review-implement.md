---
description: Implement valid PR-review suggestions safely and document accepted vs rejected items.
argument-hint: "[review-file]"
---
Implement suggestions from PR review file: **$1** (or auto-detect latest review in `dev/PR/`).

Process:
1. Read review suggestions.
2. Classify each: `apply` or `reject`.
3. Implement only valid, non-regressive suggestions.
4. Keep changes minimal and aligned with project standards.
5. Summarize what was applied/rejected and why.

Output:
- Update code as needed.
- Write summary to `dev/PR/review-implementation-summary.md`.

Rules:
- Skip outdated/incorrect/risky suggestions.
- Preserve behavior unless change is explicitly required.
- Run relevant checks/tests when practical, otherwise state what was not run.