# Development guide: Cursor Composer for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Preserved advanced implementation details

Delegates explicit tasks from Pi to Cursor SDK using `composer-2.5`.

It also registers a native Pi custom model provider:

```text
cursor-composer/composer-2.5
```

This provider wraps Cursor SDK local-agent runs, so it behaves more like a delegated agent than a raw chat-completions model. While Cursor is doing long internal tool runs, the provider emits periodic thinking/progress heartbeats so Pi Web UI does not look silent.

## Provider transcript contract

The stream callback accepts Pi's normalized `TranscriptContext`. `context.ts` uses `normalizeContext()` and `getCurrentSystemPrompt()` to replay system text, named sections, replacements, and removals into one current prompt. It omits system messages from conversation replay so stale instructions are not duplicated. Explicit prompt overrides and `includeSystemPrompt: false` also apply to transcript system messages. Legacy shorthand contexts remain supported for smoke and benchmark scripts.

Cursor executes its own SDK tools, not Pi's declared tools. The wrapper does not forward Pi tool declarations as executable Cursor tools. Its historical tool-result recovery tool remains separate.

`tests/context-serialization.test.ts` covers normalized system deltas, non-mutation, prompt and message overrides, exclusions, legacy contexts, and tool-result truncation. Run `npm test` with Pi 0.86.0 or newer peers installed; these tests do not call Cursor.

## Install

From npm after publish:

```bash
pi install npm:@firstpick/pi-extension-cursor-composer
```

```bash
# Option A: install as a local package
pi install ./pi-extension-cursor-composer

# Option B: live-link all repo Pi packages for development
./dev/scripts/sync-pi-package-symlinks.sh
cd pi-extension-cursor-composer
npm install
```

The package depends on `@cursor/sdk`. Published/local `pi install` installs that dependency automatically; the repo symlink workflow needs the package-local `npm install` step because the sync script only creates symlinks. Then reload Pi with `/reload`.

## Check the upstream SDK dependency

The package temporarily pins the last Cursor SDK release before its vulnerable Undici dependency chain appeared. Check whether the current npm `latest` release has resolved the issue with:

```bash
npm run check:upstream
```

The command creates an isolated temporary lockfile for `@cursor/sdk@latest`, runs `npm audit` against its production graph, prints a concise human- and agent-readable evaluation, and removes the temporary directory. The evaluation states whether the issue is fixed, shows the resolved SDK/ConnectRPC/Undici versions, summarizes advisory severity, and recommends whether to keep the local SDK pin. It does not run dependency lifecycle scripts or call Cursor or Pi.

Exit codes:

- `0` — npm reports no vulnerable `undici` package in the latest SDK graph.
- `1` — the vulnerable chain remains.
- `2` — the result is indeterminate, such as a registry, npm, or malformed-response failure.

The check intentionally relies on npm dependency resolution and advisory data instead of an AI judgment. Review a successful result before removing the SDK pin, then run the package tests and live Cursor smoke test.

## Configure auth

Set `CURSOR_API_KEY`, or run:

```text
/cursor-composer-setup
```

The setup command can save the key to Pi global `.env`, workspace `.env`, or only the current process. It then asks whether to add `cursor-composer/composer-2.5` to Pi's `enabledModels` scoped-model list in `~/.pi/agent/settings.json`.

If you already have a scoped model list, setup appends Composer 2.5. If you do not, adding it creates an explicit scoped list; use `/scoped-models` afterward if you want to include other models too.

## Commands

- `/cursor-composer-status` — check API key, SDK install status, native provider id, and scoped-model status.
- `/cursor-composer-add-scoped-model` — add `cursor-composer/composer-2.5` to Pi `enabledModels`.
- `/cursor-composer-models` — list Cursor models visible to the key and verify `composer-2.5`.
- `/cursor-composer [flags] <prompt>` — run Composer 2.5 on a prompt.

Flags:

- `--plan` / `--agent`
- `--thinking=low|medium|high`
- `--sandbox`
- `--no-auto-review`
- `--cwd=subdir` or `--workspace-subdir=subdir`

Example:

```text
/cursor-composer --plan --thinking=high Review this repo and propose the safest migration plan.
```

## Native Pi model

After setup and `/reload`, check:

```bash
CURSOR_API_KEY=crsr_... pi --list-models | grep cursor-composer
```

In Pi, it should appear as:

```text
cursor-composer/composer-2.5
```

Use `/model` to select it, or add it through setup/`/cursor-composer-add-scoped-model` for scoped Ctrl+P cycling. Changes to `enabledModels` are persisted, but the current session's scoped list may need `/scoped-models`, `/reload`, or a new session to refresh.

Provider usage/status behavior:

- The native provider forwards Cursor SDK `turn-ended` usage into Pi assistant-message usage, so `git-footer-status` can show input/output tokens, cache read/write tokens, cost, context, and speed.
- If the installed Cursor SDK does not emit final usage, the provider estimates input/output tokens from prompt/output text and records a `cursor-composer.usage_estimated` diagnostic; cache tokens are not estimated.
- Pricing defaults to Cursor's fast Composer 2.5 tier because Cursor documents Fast as the product default: `$3/M` input and `$15/M` output. Standard pricing is `$0.50/M` input and `$2.50/M` output.
- Set `CURSOR_COMPOSER_PRICE_TIER=standard` to use standard pricing, or override individual rates with `CURSOR_COMPOSER_INPUT_COST_PER_MILLION`, `CURSOR_COMPOSER_OUTPUT_COST_PER_MILLION`, `CURSOR_COMPOSER_CACHE_READ_COST_PER_MILLION`, and `CURSOR_COMPOSER_CACHE_WRITE_COST_PER_MILLION`.
- Cursor publishes input/output prices, not a separate cache discount; cache read/write rates default to the active input rate unless overridden.
- Default verbosity is `quiet`: show one short working line, final assistant text, requests, and errors.
- Set `CURSOR_COMPOSER_PROVIDER_VERBOSITY=normal` to include tool/status progress.
- Set `CURSOR_COMPOSER_PROVIDER_VERBOSITY=debug` to include rawer Cursor stream details.
- `CURSOR_COMPOSER_PROVIDER_HEARTBEAT_MS=15000` controls quiet heartbeat checks; only `normal`/`debug` show repeated heartbeat lines.
- Set `CURSOR_COMPOSER_PROVIDER_HEARTBEAT_MS=0` or `false` to disable heartbeats entirely.
- Set `CURSOR_COMPOSER_PROVIDER_AUTO_REVIEW=false` to disable Cursor local auto-review.
- Set `CURSOR_COMPOSER_PROVIDER_SANDBOX=true` to enable Cursor SDK sandboxing for native model runs.
- Large Pi `toolResult` messages are truncated by default before they are replayed into the native provider prompt. This keeps previous `read`/`bash` dumps from being resent to Cursor on every turn while preserving the message header, head/tail previews, original size, content hash, and a deterministic Recovery ID. Truncation uses Pi's normal tool-output byte and line limits.
- When a provider prompt contains truncated tool results, the local Cursor agent also receives an ephemeral `pi_get_truncated_tool_result` custom tool. Composer can call it with the Recovery ID and an optional line range to fetch exact omitted historical content for that provider run without replaying every large output up front. Recovery IDs are deterministic for the same persisted tool result, but the recovery map itself is rebuilt per provider run rather than stored separately.
- Set `CURSOR_COMPOSER_PROVIDER_TRUNCATE_TOOL_RESULTS=false` to restore the previous full tool-result replay behavior.

## Tool

The extension registers `cursor_composer_agent` for Pi to call when you explicitly ask to use Cursor/Composer.

By default, tool use requires interactive confirmation because Cursor SDK local mode can run commands and edit files. To allow unattended runs, set:

```bash
export CURSOR_COMPOSER_REQUIRE_CONFIRMATION=false
```

Use that only if you accept unattended Cursor SDK tool execution.
