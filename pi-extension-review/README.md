# Deterministic review for Pi

Review Git changes, session work, or selected paths against a frozen snapshot with an isolated reviewer model.

## What you can do

- Review staged, unstaged, untracked, renamed, and deleted Git content on both sides of each change.
- Review files attributed to successful `write` and `edit` calls on the active session branch.
- Review complete files or directories without giving the reviewer shell or write tools.
- Track exact line coverage and continue an incomplete review from its saved snapshot.
- Watch progress in a live status panel without stopping the main agent or reviewer.

## Install

Requires Pi 0.87.0 or newer.

```bash
pi install npm:@firstpick/pi-extension-review
```

Restart Pi after installation.

## How to use it

Open Pi in the project you want to review. Git mode requires the repository root; use paths mode from a package subdirectory. Run setup once to choose a review mode, model, reasoning effort, exclusions, and limits:

```text
/review-setup
```

Setup saves only after the final confirmation. It does not switch the main agent's model or tools.

Start a review with the saved settings:

```text
/review
```

You can also choose the input for one run:

```text
/review git
/review work
/review paths src/index.ts "docs/user guide.md"
```

Use `/review-status` to open or close the live status panel. A paused review keeps its original snapshot and evidence:

```text
/review resume
/review cancel
```

## Before you start

A review sends frozen source text and bounded task context to the reviewer model provider you select. That data may contain private code or conversation text. Check the model and scope before starting.

The reviewer has only snapshot-backed read and structured reporting tools. This is capability isolation inside the Pi process, not an operating-system sandbox. Shell and custom-tool changes cannot always be attributed to exact files. Work mode calls them out instead of guessing.

Coverage proves that the model received exact frozen lines. It does not prove that the model understood them or that no defects exist. Excluded and blocked content stays visible in the report.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for command grammar, storage, limits, privacy behavior, and troubleshooting. Contributors can use [DEVELOPMENT.md](DEVELOPMENT.md).
