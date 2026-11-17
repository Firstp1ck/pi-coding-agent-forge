# PR Writing

Write pull request titles and descriptions that a busy maintainer can review in a minute.

## Helpful when

- Your agent finished a fix and is about to write "This PR updates several files to improve..."
- A repo like T3 Code or Pi closes PRs that lack evidence, and you want yours to show the failing-before, passing-after proof.
- You have a perf change and need a before/after table that says how you measured it.

## What to share with Pi

- The branch or diff, and the base branch
- The issue or maintainer request the PR answers
- What you ran to check it, with the output, screenshots, or timings you have
- What you could not test

## Try asking

> Write the PR description for this branch against main. The repo has a PR template, so keep its headings. The flaky test failed in CI runs 4391 and 4402, and I forced the race locally with a 300 ms delay.

## What you'll get

- A conventional-commit title that states the outcome, such as `fix(web): mic button always sits next to send`
- A body sized to the diff: two paragraphs for a small fix, Problem, Change, Scope, and Verification for a normal one
- A "Not checked" line that names what is still unverified, instead of a vague "tests pass"

## Keep in mind

The skill only writes text. It does not open, push, or edit a PR. Pair it with your PR workflow, such as `/pr` or `file-pr`, for that. A repo's own `CONTRIBUTING.md` and PR template always win over the skill's defaults.

## Install

```bash
pi install npm:@firstpick/pi-skill-pr-writing
```

Restart Pi if the skill does not appear in your current session.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-skill-pr-writing/TECHNICAL.md) for the sources, the full rule set, compatibility, and limitations.
