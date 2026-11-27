---
description: Review selected code or files for correctness, security, performance, and maintainability.
argument-hint: "[files/context]"
---

Review the selected code/files for:

Files/context: `$ARGUMENTS`

1. correctness bugs
2. security risks
3. performance issues
4. maintainability/readability concerns

Return:
- a short summary
- prioritized findings (high -> low)
- concrete fixes with file/line references when possible
- optional quick patch plan
