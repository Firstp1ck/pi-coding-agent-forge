# Technical reference: Release npm for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Install

```bash
pi install npm:@firstpick/pi-extension-release-npm
```

## Authentication

Publishing requires an npm account and an access token with permission for the selected packages.

Run `/release-npm-setup`, paste the token into Pi’s private input, and let the setup verify the npm account. You can also configure npm authentication yourself before using the release command.

Never paste an npm token into a normal chat prompt or commit it to the repository.

## Workspace requirements

Run `/release-npm` from the package workspace root. Packages must be direct child folders and contain valid npm package information.

Release readiness expects:

- a valid package name, version, and license;
- a README;
- valid Pi extension entries when the package provides extensions; and
- the files referenced by the package metadata.

When a candidate declares `bundledDependencies`, the workflow installs any missing bundled packages before validating its npm artifact. Planning does this only in the temporary workspace; publishing prepares the selected source package. Dependency lifecycle scripts remain disabled during this preparation.

Nested package folders are not discovered.

Planning normally prepares only the release candidates and leaves unrelated packages and installed dependencies out of the temporary workspace. Candidates with bundled dependencies keep their installed dependencies so validation uses the existing bundle versions. Candidates with release lifecycle scripts or local dependency references use a full temporary workspace to preserve access to repository resources; preparation and cleanup can take longer in that case.

## Commands

- `/release-npm-setup` — configure and verify npm authentication.
- `/release-npm` — choose which packages to check, find release candidates among them, run checks, and show a publish plan.
- `/release-toggle` (or `Ctrl+O`) — in the terminal, show or hide the progress window; in the Web UI, switch between compact and detailed progress.
- `/release-abort` — stop the current release.
- `/release-npm-logs` — open a saved release report.

## Release flow

1. The extension checks npm authentication.
2. You choose which packages to check. All packages start ticked.
3. It compares local publishable files with the published packages to find release candidates.
4. It prepares version changes and runs package-readiness checks.
5. Pi shows the exact packages and versions that would be published.
6. You choose all, selected packages, or cancel.
7. Only the confirmed package list is published.

The release output stays visible while Pi remains usable. Reports are stored under `~/.pi/agent/release-npm-logs/`.

### Choosing packages to check

Before any checks run, Pi lists every package in the workspace with all of them ticked. Packages you untick are left out of the checks and cannot be published in that run.

| Key | Action |
| --- | --- |
| `↑` `↓`, `PgUp` `PgDn`, `Home` `End` | Move the cursor |
| `Space` | Tick or untick the package under the cursor |
| `Ctrl+A` | Tick all packages |
| `Ctrl+X` | Untick all packages |
| `Enter` | Start the checks for the ticked packages |
| `Esc` | Cancel the release |

Pressing `Enter` with nothing ticked shows a reminder instead of starting.

Packages with uncommitted Git changes (staged, unstaged, or new untracked files) are highlighted and marked `● uncommitted changes`, and the title counts them. The mark is only a reminder: the checks compare files on disk, so uncommitted changes are still checked and published. Outside a Git repository nothing is marked.

In the Pi Web UI and other remote clients, Pi uses its standard choice prompt instead, with **Start checks**, **Select all**, **Deselect all**, one entry per package, and **Next packages** / **Previous packages** when the list needs more than one page.

Checking only some packages skips version planning for the rest. If an unticked package also needs a release, for example a shared package the ticked ones depend on, it is not bumped or published in that run.

### Progress window

In the terminal, live progress opens in a fixed-size window in the middle of the screen. The window shows a short view instead of the raw script output:

- `package-name ✓` — no problems found. `…` means the package is still being checked, and `✗` means it is blocked.
- `  0.3.4 → 0.3.5 · bump and publish` — a second line, only for packages that will get a new version and be published. During publishing it changes to `publishing…` and then `published`.
- `  ! message` or `  ✗ message` — warnings and failures for that package. Problems that belong to no package, such as npm sign-in failures, are listed at the end.

Every package is listed as soon as the release starts, and its mark changes from `…` as its check finishes. A spinner marks the package being checked or published right now and turns next to the progress line while the release runs. Checks run one package at a time and can take a few seconds each, because each check compares your files with the published npm version. The last line counts the packages, how many will be published, and how many have problems. The full output, including every individual check, is still saved in the release report; open it with `/release-npm-logs`.

While the window is open, your keys go to the window, so you can scroll it straight away. The list scrolls along with the package being checked, starting at the top, and the progress line stays at the bottom of the window.

Between package checks, the window shows workspace preparation, version changes, bundled dependency preparation, and cleanup. These steps appear in the progress line too, so a pause after the final package check is identified as workspace work.

| Key | Action |
| --- | --- |
| `↑` `↓`, `PgUp` `PgDn` | Scroll; this stops the list from following the current package |
| `Home` / `End` | Jump to the first line / follow the current package again |
| `Esc`, `Ctrl+O` or `q` | Hide the window and return to the Pi input; the release keeps running |
| `Ctrl+C` | Abort the running release step |

While the window is hidden, you can type in Pi and run commands. Press `Ctrl+O` or run `/release-toggle` to show the window again, or run `/release-abort` to stop the release.

In the Pi Web UI, output is shown as a scrollable release card instead.

### Choosing packages to publish

In the terminal, Pi opens a separate window with two parts that scroll on their own: the preflight summary and the package list.

| Key | Action |
| --- | --- |
| `Tab` | Switch between the summary and the package list |
| `↑` `↓`, `PgUp` `PgDn`, `Home` `End` | Scroll the focused part |
| `Space` | Tick or untick the package under the cursor |
| `A` | Tick all packages, or untick all when every package is ticked |
| `Enter` | Publish the ticked packages |
| `Esc` | Cancel without publishing |

Pressing `Enter` with nothing ticked shows a reminder instead of publishing.

In the Pi Web UI and other remote clients, Pi uses its standard choice prompt instead. The full summary is posted in the chat first. If there are more packages than fit on the screen, choose **Next packages** or **Previous packages** to move between pages; your selections are kept.

## Safety and limitations

- Nothing is published before confirmation.
- Failed checks remain visible and block unsafe candidates.
- The package list is fixed before confirmation instead of being rediscovered during publishing.
- Preparing a missing bundled dependency requires npm registry access, but runs with dependency lifecycle scripts disabled.
- This extension is designed for this repository’s package layout, not every possible npm workspace.
- Stopping a release may leave already published packages published; inspect the saved report before retrying.

## Troubleshooting

- Run `/release-npm-setup` again when npm authentication fails.
- Confirm that the current folder is the workspace root.
- Check package names and versions when a candidate is unexpectedly skipped.
- Open `/release-npm-logs` after a partial or failed run.
