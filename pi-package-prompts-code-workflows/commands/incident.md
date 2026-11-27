---
description: Triage an incident with impact, severity, mitigation, and investigation plan.
argument-hint: "[issue/context]"
---

Run incident triage for this issue.

Issue/context: `$ARGUMENTS`

Process:
1. State impact and current severity.
2. Identify likely blast radius.
3. Gather highest-signal evidence first.
4. Propose immediate mitigation.
5. Propose root-cause investigation plan.

Return:
- Incident summary
- Timeline (known events)
- Hypotheses + confidence
- Immediate actions
- Next checkpoints
