---
description: Implement the agent's latest recommendations, with optional exclusions.
argument-hint: "[exclusions: numbers, labels, or descriptions]"
---
Implement the actionable recommendations from the agent's most recent relevant response.

Exclusions supplied with this command: `$ARGUMENTS`. An empty value means no exclusions.

Selection rules:
1. Treat every supplied argument as an exclusion, not as extra implementation scope.
2. Match exclusions by recommendation number, label, or short description.
3. If there are no exclusions, implement every actionable recommendation.
4. Before editing, briefly list what you will implement and what you will skip.
5. If the referenced recommendations or an exclusion are ambiguous, ask for clarification instead of guessing.

Implementation rules:
- Inspect the current repository state and follow its local instructions.
- Make the smallest coherent changes that implement the selected recommendations.
- Preserve unrelated user changes.
- Do not perform destructive actions or external side effects without existing authorization.
- Run the relevant checks or tests.
- Report changed files, verification results, and anything left unresolved.
