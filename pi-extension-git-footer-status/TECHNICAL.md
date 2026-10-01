# Technical reference: Git Footer Status for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

Enhanced Pi footer with git health and model/token telemetry.

![Status bar with metrics and git context](https://unpkg.com/@firstpick/pi-extension-git-footer-status/images/Statusbar_v0.1.5.png)

## Install

```bash
pi install npm:@firstpick/pi-extension-git-footer-status
```

## Configuration

No required configuration.

Performance-related environment toggles:

- `PI_GIT_FOOTER_FETCH=0` — disable startup `git fetch`. Enabled by default.
- `PI_GIT_FOOTER_AUTO_REFRESH_MS=10000` — git status auto-refresh interval. Set `0` to disable.
- `PI_GIT_FOOTER_DISABLE_PROMPT_ESTIMATE=1` — disable the background `PI: X tok` prompt estimate.

Visibility controls:

Changes made with `/git-footer-visibility` or the WebUI Git-footer Visibility dialog are saved globally in `~/.pi/agent/git-footer-visibility.json` and reloaded by every Pi session. `PI_CODING_AGENT_DIR` relocates the agent directory; `PI_GIT_FOOTER_SETTINGS_FILE` can override this settings file directly.

- `PI_GIT_FOOTER_HIDE=cost,context` — hide keys everywhere.
- `PI_GIT_FOOTER_NATIVE_HIDE=model,thinking` — hide keys only in the native TUI footer.
- `PI_GIT_FOOTER_WEBUI_HIDE=webui-refresh-button,webui-details-button` — hide keys only in Web UI.
- `PI_GIT_FOOTER_<KEY>=0|1`, `PI_GIT_FOOTER_NATIVE_<KEY>=0|1`, or `PI_GIT_FOOTER_WEBUI_<KEY>=0|1` — explicit per-key overrides, with dashes written as underscores, e.g. `PI_GIT_FOOTER_WEBUI_CHANGES_MODAL=0`.

Useful keys include metric cards (`tokens`, `cache`, `pi`, `speed`, `cost`, `context`, `usage`), metadata cards (`cwd`, `git`, `git-state`, `sync`, `changes`, `git-extra`, `worktree`, `model`, `thinking`), git subitems (`git-branch-indicator`, `git-ahead`, `git-behind`, `git-staged`, `git-unstaged`, `git-untracked`, `git-conflicted`, `git-clean`, `git-stash`, `git-submodules`, `git-worktrees`, `git-tag`, `git-last-commit-age`, `git-signing-mismatch`), native footer areas (`cwd-branch`, `git-status`, `extension-statuses`), and Web UI affordances (`webui-fetch-state`, `webui-refresh-button`, `webui-details-button`, `webui-cwd-picker`, `webui-pi-calibration`, `webui-context-auto-compaction`, `webui-branch-picker`, `webui-git-init`, `webui-sync-push`, `webui-changes-modal`, `webui-git-tools-modal`, `webui-model-picker`, `webui-thinking-picker`, `webui-changed-files-popover`).

When the Codex Fast Mode extension is enabled, the native footer labels its setting as `Codex fast: on` or `Codex fast: off`. This shows the session preference, not confirmation that OpenAI accepted priority processing.

The initial prompt estimate and session-usage recompute run lazily after the TUI is ready, so the footer should not block startup.

Provider subscription usage is captured from response headers after a model request. Codex primary and secondary windows are handled independently: if the provider returns only one valid window, that window remains visible instead of hiding the whole Usage item. The footer does not guess a missing window or label.

For Codex subscriptions, select SSE transport in `/settings` and send another model request to receive usage data when the provider supplies it. Auto can choose WebSocket, which currently does not supply usage to this footer. When the active model uses Codex subscription authentication and saved transport is Auto, including the default, a warning appears at startup and on `/new`. Reloads, resumes, forks, and model switches do not repeat it. Explicit SSE or WebSocket settings do not trigger this Auto-specific warning.

The check uses global settings and trusted project overrides without changing them. It skips the warning if settings cannot be read reliably. SDK-only in-memory transport overrides are not visible to this check.

## Token output speed

In `⚡ 6.2k tok @ 42.5 tok/s`, `6.2k tok` is cumulative session output, including estimated output while streaming. `42.5 tok/s` is the average output speed across live samples collected since the session was loaded, not the latest streaming speed. Both the native footer and Web UI use this average and keep it visible while idle.

A new or reloaded session starts collecting fresh speed samples. Until samples are available, the footer uses the last measured response speed or an estimate from session history. It shows `— tok/s` if neither is available. Historical estimates include response latency and can differ from live streaming measurements.

Optional inline statistics remain hidden by default. Show them with `/git-footer-visibility show all speed-avg speed-low speed-max`. `speed-avg` repeats the main average, `speed-low` shows the 1% low speed, and `speed-max` shows the highest sampled speed.

## Git sync safety

The Web UI always uses the pull-first workflow when it knows incoming and outgoing commits both exist. If a direct **Push** is rejected because the remote gained commits after the footer last refreshed, the action releases its push lock and enters that same pull-first workflow. It does not offer a force-push from the footer. Diverged histories require you to confirm merge or rebase, or you can review the incoming changes without integrating them.

## Commands

- `/git-footer-refresh` — refresh git/footer information immediately.
- `/git-footer-visibility` — in native TUI mode, open an interactive searchable visibility selector. Use Enter/Space to toggle items, Ctrl+S to apply, and Esc/q to cancel.
- `/git-footer-visibility select [all|native|webui]` — open the native TUI selector for both targets or a specific target.
- `/git-footer-visibility [status|keys]` — inspect available visibility keys and their native/Web UI state.
- `/git-footer-visibility show|hide|toggle|reset [all|native|webui] <key> [key...]` — save global visibility overrides for future Pi sessions, e.g. `/git-footer-visibility hide webui cost context webui-changes-modal`. `reset` removes saved overrides and restores environment/default behavior.
- `/git-footer-pi-debug` — show diagnostics for the initial `PI: X tok` prompt estimate.

## Shortcuts

- `Ctrl+Shift+G` — show Git signing-mismatch diagnostics.

## Example view

```text
🪙 ↑126k · ↓11k │ 💾 R1.4M │ PI: 6.8k tok │ ⚡ 11k tok @ 48.6 tok/s │ 💸 $1.667 (sub) │ 🧠 19.0%/272k                                                                                                                (openai-codex) gpt-5.5 • low
~/pi-coding-agent-forge (main) │ ✎15 │ ⏱15m · Agent
```

At a glance you can see token flow, cache reads, prompt-injection size, average output speed, cost/subscription state, context pressure, model/reasoning level, current repo/branch, dirty-file count, and session time without running `git status`.
