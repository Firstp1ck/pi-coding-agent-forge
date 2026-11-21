# Refactoring Advisor

Improve difficult code through small steps while keeping its behavior the same.

## Helpful when

- A file or module has become too large.
- Changes are risky because responsibilities are mixed together.
- You want a cleanup plan before editing code.

## What to share with Pi

- The code or area that is hard to maintain
- Behavior that must not change
- Available tests and time constraints

## Try asking

> Plan a small, safe refactor for this module. Keep behavior unchanged and show the checks needed after each step.

## What you’ll get

- The main maintenance problems
- A sequence of small changes
- Tests, checkpoints, and rollback options

Plans preserve existing work and make migration and data-recovery limits explicit.

## Keep in mind

Refactoring should not quietly add features or change behavior. Any such choice should be handled separately.

## Install

```bash
pi install npm:@firstpick/pi-skill-refactoring-advisor
```

Restart Pi if the skill does not appear in your current session.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for advanced usage, configuration, compatibility, and limitations.
