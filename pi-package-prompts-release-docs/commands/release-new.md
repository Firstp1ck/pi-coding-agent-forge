---
description: Generate release notes file for a version from diff since previous release.
argument-hint: "<version>"
---
Create release notes for version **$1**.

Target file:
- `dev/RELEASES/RELEASE_v$1.md`

Process:
1. Find previous release reference (tag/file/changelog marker).
2. Compare changes from previous release -> current state.
3. Group into user-facing categories.
4. Highlight breaking changes and migration notes if any.

Output format:
- `## Release v$1`
- `## Highlights`
- `## Full Change Summary`
- `## Breaking Changes` (only if needed)
- `## Upgrade Notes` (only if needed)

Style:
- user-friendly, short, precise
- no invented entries