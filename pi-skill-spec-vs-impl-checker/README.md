# Specification vs Implementation Checker

Check whether the software does what its specification, plan, or documentation promises.

## Helpful when

- A feature must match written requirements.
- Documentation may be out of date.
- You want to find missing or conflicting behavior before release.

## What to share with Pi

- The specification, plan, README, or issue
- The code or project to compare
- Which requirements matter most

## Try asking

> Compare this implementation with the specification. Trace each requirement to evidence and clearly report anything missing or different.

## What you’ll get

- A requirement-by-requirement comparison
- Evidence from the implementation
- Missing, conflicting, or uncertain behavior

The result separates what code inspection shows from what relevant checks actually verified.

## Keep in mind

If either the specification or the implementation is unclear, the result will identify the gap rather than inventing intent.

## Install

```bash
pi install npm:@firstpick/pi-skill-spec-vs-impl-checker
```

Restart Pi if the skill does not appear in your current session.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for advanced usage, configuration, compatibility, and limitations.
