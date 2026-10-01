# Development guide: Git Footer Status for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Diagnostic surfaces

`/git-footer-pi-debug` exposes bounded prompt-estimator diagnostics, and `Ctrl+Alt+G` exposes Git signing-mismatch diagnostics. Keep these outputs free of credentials and private provider payloads.

## Git inspection safety

Periodic status refreshes and auxiliary Git probes are read-only background work. Run them through `runGitRead`, which invokes `git --no-optional-locks`, so inspecting a repository does not refresh its index or create optional lock contention. Keep mutations such as the startup fetch outside this helper.

Run `node --test tests/git-snapshot.test.mjs` from this package directory after changing Git snapshot behavior.

## Extension status labels

The native footer renders bare `on` and `off` values under `codex-fast-mode` as `Codex fast: on` and `Codex fast: off`. It leaves already-labeled values, unrelated statuses, and the source status map unchanged, preserving the Fast Mode extension's WebUI contract.

Run `node --experimental-strip-types --test tests/provider-usage-integration.test.mjs` to verify both states and prevent duplicate prefixes.

## Codex Auto transport warning

The `session_start` handler checks `startup` and `new` reasons, `ctx.hasUI`, active `openai-codex` provider, and `modelRegistry.isUsingOAuth`. It lazily imports Pi's `SettingsManager`, reads saved transport with the current cwd and `ctx.isProjectTrusted()`, and warns only for Auto with no settings-load errors. It never calls a settings setter. Errors in this advisory check must not prevent footer initialization.

`ExtensionContext` does not expose the live transport setting. This check therefore observes saved global/trusted-project settings, not SDK-only in-memory overrides. It does not change provider usage capture or add network requests.

`tests/provider-usage-integration.test.mjs` uses the real Pi settings reader with temporary settings files to cover Auto defaults, explicit transports, trusted project precedence, malformed settings, auth/UI/lifecycle gates, warning text, and unchanged file contents. Run `node --experimental-strip-types --test tests/*.test.mjs` from this package directory.

## Token speed regression coverage

`tests/speed-persistence.test.mjs` drives assistant lifecycle events and verifies that both footers display the sample average rather than the latest live or final measured speed. It also covers cumulative output, idle persistence, optional statistics, session reset, no-sample measured fallbacks, and session-history estimates. Run `node --experimental-strip-types --test tests/speed-persistence.test.mjs` from this package directory.

## Additional implementation details

- Shows compact runtime metrics in the footer:
  - input/output/cache tokens
  - export-backed initial prompt estimate (`PI: X tok`, same estimator as `/stats-pi`, compacted as `k` for thousands; falls back to live context data if Pi HTML export is unavailable)
  - always-visible cumulative session output counter and average token output speed, measured from assistant streaming lifecycle events. `buildFooterTelemetry` uses `computeSessionSpeedStats(sessionSpeedSamples).avg` for `averageTokenSpeed`, shared by native and Web UI renderers. Samples are valid 2-second rolling speeds, collected at most once every 250 ms, with the latest 20,000 retained. The arithmetic mean stays visible while idle. Without samples, the existing live, last-measured, or session-history estimate is used. `session_start` clears live state, last-measured speed, and session samples so a new or reloaded session cannot inherit the previous average.
  - optional inline session speed stats, average `speed-avg`, 1% low `speed-low`, and max spike `speed-max`, remain hidden by default. The average repeats the main speed. The 1% low is the mean of the slowest 1% of samples, with at least one sample. Enable these via `/git-footer-visibility show all speed-avg speed-low speed-max`.
  - cost + context-window usage
  - provider subscription usage captured passively from `after_provider_response` headers: available Codex windows are parsed independently and labeled from provider-reported `*-window-minutes` metadata (with neutral primary/secondary fallbacks), while Anthropic uses its explicit 5h/7d unified windows; shown only for the matching active provider and hidden for API-key Anthropic auth, when no valid window is available, or for stale snapshots
  - current model and reasoning level
- Shows git status context on the path line:
  - branch/detached state
  - ahead/behind
  - staged/unstaged/untracked/conflicts
  - operation state (rebase/merge/cherry-pick/revert/bisect)
  - stash/submodule/worktree/tag/last-commit-age/signing mismatch indicators
- Publishes the same footer data as a structured `git-footer-webui` status payload so Pi Web UI can render the extension-owned footer instead of duplicating this logic in the Web UI package. The payload also carries the sanitized provider-usage snapshot and its response-capture timestamp independently of footer-chip visibility, allowing other Web UI views to reuse the same live source without parsing display text.
