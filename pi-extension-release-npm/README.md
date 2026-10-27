# Release npm for Pi

Guides this workspace’s npm release process and asks before publishing.

## What you can do

- Finds packages that are ready to release.
- Plans and checks required version updates.
- Runs package readiness checks before publishing.
- Shows package checks, workspace preparation, and cleanup as they happen.
- Requires confirmation before anything is published.

## Install

Install it through Pi:

```bash
pi install npm:@firstpick/pi-extension-release-npm
```

Restart Pi if the package does not appear in your current session.

## How to use it

1. Run `/release-npm-setup` once if npm publishing is not configured.
2. Run `/release-npm`. Pi lists your packages with all of them ticked, and marks packages with uncommitted Git changes with `●`. Press `Enter` to check them all, or narrow the list first: `Space` ticks or unticks one package, `Ctrl+X` unticks all, and `Ctrl+A` ticks all again.
3. The checks start and look for release candidates. The progress window shows when it is checking packages, preparing the workspace, or cleaning up.
4. Review the package list, planned versions, and any failures.
5. Confirm publishing only when the plan is correct. In the terminal, the summary and package list open in their own scrollable window: press `Space` to tick packages, `A` to tick all, `Enter` to publish the ticked ones, or `Esc` to cancel.

Useful controls:

- Progress window — in the terminal, progress opens in a window in the middle of the screen. Each package gets one line with a green ✓ when it is fine, plus a second line when it will be bumped and published. Warnings and failures show up under the package. The full output is saved in the release report. Scroll it with the arrow keys or `PgUp`/`PgDn`. Press `Esc` to hide it and type in Pi again; the release keeps running.
- `Ctrl+O` or `/release-toggle` — show or hide the progress window. In the Web UI, it switches between the short and detailed view.
- `Ctrl+C` or `/release-abort` — stop the active release.
- `/release-npm-logs` — open a saved release report.

The exact workspace layout, release scripts, and publishing rules are documented in the technical reference.

## Before you start

This extension is designed for the package workspace described in the technical reference. Run the planning form first; publishing always requires confirmation.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-release-npm/TECHNICAL.md) for complete commands, configuration, compatibility, security, and troubleshooting information.
