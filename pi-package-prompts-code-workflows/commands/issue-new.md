---
description: Draft a clean GitHub issue from a user perspective with strict title/body structure.
argument-hint: "<problem-or-feature-request>"
---
Create a GitHub issue for: **$@**

Requirements:
- Plain language, maintainer-friendly, no jargon-heavy phrasing
- No duplicated information
- Write as user-reported

Title format:
- `[Type]: [Title]`
- Type must be one of: `Feature | Bug | Improvement | Doc | Question`

Body format:
```markdown
### Short Summary
<max 2 sentences>

### Body
<only if needed; concrete details, list style preferred>
```

Quality bar:
- Repro/expectation should be obvious for bugs
- Value/goal should be obvious for features
- Keep concise