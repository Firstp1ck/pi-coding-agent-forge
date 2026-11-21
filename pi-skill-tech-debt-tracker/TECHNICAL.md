# Technical reference: Tech Debt Tracker

Advanced user inputs, evidence, compatibility, and limitations.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Install

```bash
pi install npm:@firstpick/pi-skill-tech-debt-tracker
```

## Backlog ownership

Use the existing project tracker, debt record, or agreed repository location. Reviews return candidates in the conversation unless updates were requested. No automatic registry is created in global agent memory, and identifying a canonical tracker does not authorize changing it.

## Evidence and prioritization

A candidate needs a demonstrated maintenance cost, explicit trade-off, or supported upcoming risk. Useful evidence includes recurring cross-module changes, reproduction steps, measured verification costs, or affected supported consumers. Keep forecasts distinct from observed costs.

Severity alone does not produce a deadline. Consider recurrence, consequence, exposure, cost of delay, dependencies, and effort uncertainty. Priority remains a proposal unless the responsible user or project process has decided it. A small abstraction or duplicated expression is not automatically debt.

## Useful records

Preserve existing identifiers and link the evidence, affected area, remedy, contract to preserve, verification, ownership, and uncertainty. Accepted trade-offs retain their reason and a condition for revisiting them. Link a decision record rather than copying its rationale into another source of truth.

## Resolution and history

A closed ticket is not implementation evidence. Check the promised change and verification before marking debt resolved, and retain residual work. Report trends only when comparable historical records exist. Review cadence follows the project or user's choice rather than a universal debt-sprint schedule.

Registry edits preserve unrelated entries. External issue creation, code changes, and dependency installation remain separate actions requiring existing authorization.
