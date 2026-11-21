# Development guide: Refactoring Advisor

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Additional implementation details

- Adds the `refactoring-advisor` skill to Pi's skill library.
- Plans preserve existing work and make migration and data-recovery limits explicit.
- Bundles `skills/refactoring-advisor/SKILL.md` plus any supporting references, scripts, tests, fixtures, or assets used by the skill.

## Portable guidance contract

The skill uses canonical project inputs and actual roles rather than fixed workspace paths or host agent names. Preserve read-only review boundaries, task authorization, current evidence, and existing user changes. Relative documentation links must resolve in the published archive. Static structure checks do not establish model compliance; evaluate realistic tasks when changing decision rules.
