---
description: Convert an issue into a root-cause analysis and step-by-step implementation plan.
argument-hint: "<issue-url|id|summary>"
---
Analyze this issue and produce an implementation plan: **$@**

Required steps:
1. Read issue details and related code paths.
2. Define root cause (or most likely causes with confidence level).
3. Identify impacted modules, interfaces, and side effects.
4. Propose implementation steps in execution order.
5. Add validation plan (tests/checks) and rollback considerations.

Save to:
- `dev/ISSUES/issue-fix-plan.md`

Output sections:
- `## Problem`
- `## Root Cause`
- `## Impacted Areas`
- `## Implementation Plan`
- `## Validation`
- `## Risks / Rollback`

No code edits in this command.