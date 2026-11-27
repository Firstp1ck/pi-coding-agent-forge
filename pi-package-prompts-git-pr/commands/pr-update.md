---
description: Merge latest branch changes into existing PR draft without removing prior content.
---
Update PR draft file with new branch changes.

Compare:
- current branch vs the repository default branch (`main`, `master`, or upstream default)
- recent commits since last PR draft update

Target file:
- `dev/PR/<current-branch>.md`

Rules:
- Append missing updates only
- Keep additions concise and reviewer-friendly
- Do **not** delete existing entries already in the PR file
- Avoid duplicate bullets

Output:
- Updated PR markdown
- Short note listing what was newly added