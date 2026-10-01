# Git Footer Status for Pi

Shows Git state, token use, context use, and model information in Pi’s footer.

![Status bar with metrics and git context](https://unpkg.com/@firstpick/pi-extension-git-footer-status/images/Statusbar_v0.1.5.png)

## What you can do

- Shows the current Git branch and changed-file state.
- Displays model, context, token, cost, average token output speed, and every available provider subscription-usage window.
- Warns about ongoing Git operations, sync state, and Codex Auto transport that can hide subscription usage.
- Refreshes automatically and can also be refreshed on demand.

## Install

Install it through Pi:

```bash
pi install npm:@firstpick/pi-extension-git-footer-status
```

Restart Pi if the package does not appear in your current session.

## How to use it

For Codex subscription usage, select SSE transport in `/settings`, then send a model request. If your active model uses a Codex subscription with Auto transport, the footer warns you at startup and when you use `/new`.

The footer appears automatically and updates as you work. In the Web UI, click **SYNC** to apply pending remote changes: when both pull and push are available, it attempts the fast-forward-only pull first and offers the push only after that pull succeeds. If **Push** discovers new incoming commits, it switches to the same pull-first workflow instead of offering a force-push. Pull failures open a native popup with deduplicated, selectable, and copyable error output. If local and remote histories diverged, the popup explains that conflicts are not yet known and offers **Merge changes** (the default), **Rebase commits**, or **Review changes**; merge and rebase each require confirmation, and actual conflicts open the Git Changes panel.

- `/git-footer-refresh` — refresh the Git and usage information now.
- `/git-footer-visibility` — choose which footer items are shown.
- `/git-footer-visibility status` — review the current visibility choices.

The `⚡ 6.2k tok @ 42.5 tok/s` item shows cumulative output tokens and average output speed across live samples from the session. The average stays visible while Pi is idle.

The visibility screen lets you change the terminal and Web UI separately. Command-line shortcuts for changing several items at once are in the technical reference.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-git-footer-status/TECHNICAL.md) for complete commands, configuration, compatibility, security, and troubleshooting information.
