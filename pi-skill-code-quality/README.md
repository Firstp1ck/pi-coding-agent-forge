# Code Quality

Review a code change for real maintenance risks, then make a small cleanup only when you authorize it.

## Helpful when

- A feature or refactor is hard to review because several files or responsibilities changed together.
- You want to inspect repeated logic, growing functions, dependencies, warnings, or unclear ownership without turning every style preference into a defect.
- You want one bounded cleanup after behavior has been checked.

## What to share with Pi

- The change, files, package, or module roots to review.
- Whether the request is review-only or permits implementation and one cleanup pass.
- The baseline, repository rules, existing checks, and any behavior that must not change.

## Try asking

> Review this change against its dirty-start baseline. Do not edit files or save a report. Focus on correctness, repeated error handling, and maintainability in `src/import`.

## What you'll get

- Evidence-backed findings tied to the selected scope and available checks.
- A clear distinction between confirmed issues, accepted trade-offs, missing evidence, and false positives.
- At most three focused cleanup candidates when you authorize a cleanup pass.

## Keep in mind

Review-only is the default. The skill does not automatically format, fix, save workspace memory, install tools, or persist scanner output. Existing project policy and correctness checks take priority over examples and measurements. The Git-only scanner path has current Linux evidence. Optional structural-tool pins have Windows x64 evidence only and were not rerun on Linux. Unsupported or missing evidence stays visible as unavailable or partial.

## Install

```bash
pi install npm:@firstpick/pi-skill-code-quality
```

Restart Pi if the skill does not appear in your current session.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for advanced usage, scanner options, optional tools, compatibility, privacy, and limitations.
