---
description: Generate a PR branch name from staged changes and generated commit messages.
---

Generate one branch name for the current staged work.

Inputs to inspect:
- staged diff only (`git diff --cached`)
- generated commit message files if present:
  - `dev/COMMIT/staged-commit-short.txt`
  - `dev/COMMIT/staged-commit-long.txt`

Write exactly this file (create directory if missing):
- `dev/COMMIT/staged-branch-name.txt`

Required content format:

```text
<type>/<short-feature-name>
```

Rules:
- Use the same primary type taxonomy as `/git-staged-msg` where possible: `fix|feat|change|perf|test|chore|refactor|docs|style|build|ci|revert`.
- Use lowercase kebab-case after the slash.
- Keep it short and reviewer-friendly, ideally 2-5 words after the slash.
- No spaces, underscores, uppercase letters, trailing punctuation, or extra lines.
- Base it only on staged work; do not include unrelated unstaged changes.
- No code fences or extra prose in the output file.
