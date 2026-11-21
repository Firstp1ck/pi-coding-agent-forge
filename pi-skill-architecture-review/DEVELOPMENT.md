# Development guide: Architecture Review

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Additional implementation details

- Adds the `architecture-review` skill to Pi's skill library.
- The review explains which knowledge callers must carry and which real changes the design makes easier.
- Bundles `skills/architecture-review/SKILL.md` plus any supporting references, scripts, tests, fixtures, or assets used by the skill.

## Portable guidance contract

The skill uses canonical project inputs and actual roles rather than fixed workspace paths or host agent names. Preserve read-only review boundaries, task authorization, current evidence, and existing user changes. Relative documentation links must resolve in the published archive. Static structure checks do not establish model compliance; evaluate realistic tasks when changing decision rules.
