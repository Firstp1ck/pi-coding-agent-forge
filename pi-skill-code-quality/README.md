# Code Quality

Improve code as Pi writes it to permanent files, from a one-line fix to a larger implementation.

## Helpful when

- You are creating or changing source, scripts, tests, saved examples or configuration-as-code.
- You want clear control flow, meaningful abstractions and reliable error handling built into the change, not left for a later review.
- You want to improve maintainability without sacrificing behavior, security checks or useful tests.

## What to share with Pi

- The behavior to implement and the files or module you want changed.
- Repository conventions, relevant checks and compatibility requirements.
- Any protected files or existing work that must remain untouched.

## Try asking

> Add retry cancellation to `src/import`. Improve the code as you write it, reuse existing error handling, and test cancellation without changing the public API.

Once enabled, the skill instructs Pi to apply it to every permanent code write, including small edits. You do not need to request a separate quality review each time. Use `/skill:code-quality` to load it explicitly when needed.

## What you'll get

- Code improved directly within the requested scope.
- Relevant checks and a concise account of any unresolved risks.
- Optional before/after evidence when a larger change warrants measurement.

## Keep in mind

An explicit review-only request stays read-only. The skill does not authorize unrelated rewrites, tool installations or automatic memory/report storage. Its always-apply instruction guides the agent; it is not a hook that intercepts every file write.

The scanner is optional and remains read-only. The Git-only scanner path has current Linux evidence. Structural-tool pins have Windows x64 evidence only. Missing or partial measurements are not proof of clean code.

## Install

```bash
pi install npm:@firstpick/pi-skill-code-quality
```

Restart Pi if the skill does not appear in your current session.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for activation, scope, scanner options, optional tools, compatibility, privacy and limitations.
