# Release npm for Pi

Find changed npm packages, check their releases, and choose what to publish in Pi.

## What you can do

- Compare the files npm would publish and plan the next versions.
- Check several packages together, with live progress and saved logs.
- Publish healthy packages even when other packages fail their checks.
- Review and confirm the exact package selection before Pi starts publishing.
- Approve publication in your Chromium browser and submit independent packages while earlier uploads are verified.

## Install

```bash
pi install npm:@firstpick/pi-extension-release-npm
```

Restart Pi if the commands do not appear in your current session.

## How to use it

1. Open Pi in your package workspace or package folder and run `/release-npm`.
2. Choose which packages to check. All start selected. In the terminal, use `Space` to toggle a package and `Enter` to start.
3. Review the planned versions and any failures. Healthy candidates remain available when another package fails.
4. Choose the packages to publish and confirm. In the terminal, `Space` selects, `A` selects all, `Enter` publishes the selection, and `Esc` cancels.
5. All eligible packages finish validation before the first upload. Complete npm approval in the Chromium-based browser when npm requests it. Independent packages submit in sequence while earlier uploads are checked. If npm offers a five-minute approval option, you may choose it yourself; npm controls its scope and expiry. The workflow stays open until every submitted package has a final outcome. It reports publication only after verifying the registry package. If confirmation takes more than twenty minutes, the run ends as unverified; rerun it to resume checking without uploading again.

Use `/release-npm-setup` to configure npm authentication before publishing. Checking public packages does not require signing in.

During a run, `Ctrl+O` or `/release-toggle` shows or hides the progress window. Use `/release-abort` to stop work and `/release-npm-logs` to open a saved run log. The technical reference also explains the standalone terminal workflow.

## Before you start

You need Node.js, npm, an installed Chromium-based browser, and Bash for the shell entry points. Publish only packages and lifecycle scripts you trust. Planning runs release hooks in temporary workspaces and may download missing bundled dependencies with dependency scripts disabled.

Pi asks before publishing. The standalone `--publish` command authorizes publication immediately. Aborting cannot undo packages already published, and a failed upload may leave the planned version in your source manifest. Inspect the report before retrying.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for commands, configuration, compatibility, security, and troubleshooting.
