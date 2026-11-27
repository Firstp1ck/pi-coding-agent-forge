---
description: Build a publish-ready branch announcement from changes since the default branch and save it under dev/ANNOUNCEMENTS.
---
Create a branch announcement from the **current branch diff vs the repository default branch**.

Do this first:
1. Detect the default branch (`main`, `master`, or upstream default) and inspect commits and changed files against it.
2. Group relevant changes into: Features, Fixes, Improvements, Chores, Refactors.
3. Skip noise (formatting-only, lockfile-only, trivial renames) unless user-visible.

Output constraints:
- Max 800 characters total
- User-friendly and non-technical wording
- Only include changes that actually exist

Save to:
- `dev/ANNOUNCEMENTS/branch_announcement_content.md`

Use exactly:
```markdown
## What's New

- Feature: ...
- Fix: ...
- Improvement: ...
- Chore: ...
- Refactor: ...
```

If a category has no items, omit it.