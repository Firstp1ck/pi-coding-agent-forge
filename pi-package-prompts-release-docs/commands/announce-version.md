---
description: Build a version announcement from changes since the previous release and save to dev/ANNOUNCEMENTS.
argument-hint: "<version>"
---
Create a version announcement for **$1**.

Do this first:
1. Detect changes since the previous release tag (or nearest prior release marker).
2. Group meaningful changes: Features, Fixes, Improvements, Chores, Refactors.
3. Exclude internal-only noise unless it affects users.

Output constraints:
- Max 800 characters total
- User-friendly release wording
- Do not invent changes

Save to:
- `dev/ANNOUNCEMENTS/version_announcement_content.md`

Use exactly:
```markdown
## What's New in v$1

- Feature: ...
- Fix: ...
- Improvement: ...
- Chore: ...
- Refactor: ...
```

If prior release data is missing, state assumptions briefly at the end.