---
description: Perform a non-editing PR-style review of current branch vs the default branch and save a detailed report.
---
Review the current branch as a PR into the repository default branch (`main`, `master`, or upstream default).

Hard rule:
- **Do not modify code**. Review only.

Review scope:
1. Detect the default branch and list changed files against it.
2. Evaluate each for:
   - security concerns
   - logic/correctness errors
   - edge cases and error handling gaps
   - code quality/consistency vs project standards (`CONTRIBUTING.md`, lints, conventions)
3. Prioritize findings by severity.
4. Add concrete remediation suggestions.

Save report to:
- `dev/PR/review-<current-branch>.md`

Output sections:
- `## Summary`
- `## High`
- `## Medium`
- `## Low`
- `## Suggested Fixes`