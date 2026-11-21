# Test Plan Generator

Turn requirements, changes, or a bug report into a practical test plan ordered by risk and value.

## Helpful when

- A feature needs test coverage.
- A bug fix could cause regressions.
- You need to decide what to test manually and automatically.

## What to share with Pi

- The canonical requirement, issue, diff, or plan you already have
- Relevant code, existing tests, and available execution evidence
- Important user journeys, risks, platforms, and time limits

## Try asking

> Plan tests for this cancellation fix using the issue, diff, and existing tests. Identify the outcome each test must detect, its priority, and any unverified behavior.

## What you’ll get

- Tests grouped by type and priority
- Expected results and important test data
- Coverage gaps and suggested order

You can start from a small diff or bug report; the result separates proposed checks from verified behavior.

## Keep in mind

The plan describes what should be tested; it does not prove the tests were run or passed.

## Install

```bash
pi install npm:@firstpick/pi-skill-test-plan-generator
```

Restart Pi if the skill does not appear in your current session.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for advanced usage, configuration, compatibility, and limitations.
