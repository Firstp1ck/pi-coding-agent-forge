# Development guide: Stats for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Preserved implementation and format details

Token and cost analytics for Pi session history.

![Token stats dashboard](https://unpkg.com/@firstpick/pi-extension-stats/images/stats_v0.1.2.png)

## What it does

- Parses local Pi session `.jsonl` files for the current workspace.
- Aggregates usage by the machine's local calendar day.
- Displays compact daily token bars and cost bars with totals.
- Shows input/output/cache breakdown, estimated initial prompt input (`PI: X tok`) with source split-up, cached-input token share, cost burn rate, and top model usage.
- Highlights highest-cost day, projected 30-day cost, scoped session averages, recent-vs-prior spend, most expensive sessions, and model/session cost concentration.

## Install

```bash
pi install npm:@firstpick/pi-extension-stats
```

## Configuration

No required configuration.

## Commands

- `/stats [days|all]` — show token usage dashboard (default: last 14 days).
- `/stats tokens` — show current context token breakdown by source/type.
- `/stats-pi` — show export-backed estimated initial prompt input token breakdown. It creates a temporary Pi HTML export, decodes its embedded session data, then counts Pi's system prompt text, active provider-level tool schemas, framing overhead, and optional historical calibration (falling back to live context data if export is unavailable).
- `/stats-pi detailed` — add a concise detail view of the exported initial prompt snapshot: active tool schemas, available-tool prompt entries, skills, context files, metadata, and estimate components.
- `/calibrate` — start an isolated calibration session with a fixed probe prompt, then update `/stats-pi` and the footer `PI: X tok` estimate from the first assistant response usage. `/calibrate current` reuses the current branch if it already has a suitable first-turn usage sample.
- `/stats-last [days|all]` — show non-zero daily usage graph.
- `/stats-most-expense [days|all]` — show most expensive sessions.
- `/stats-model-compare [days|all]` — show model token/cost comparison.
- `/stats-cost-trend [days|all]` — show cost trend and projections.
- `/stats-cache [days|all]` — show cached-input share and token mix. Cached-input share is `cacheRead / (input + cacheRead + cacheWrite)`; it is not a request-level cache hit rate or a monetary savings estimate.

## Pi 1.2 custom-message starts

`before_agent_start` refreshes structured prompt options for user and custom runs. Custom starts clear pending first-user calibration because they carry no `prompt` or `images`. Their assistant usage remains part of recorded session totals, but cannot train the user-prompt estimate. `tests/stats-payload.test.mjs` covers both real user calibration and custom starts.

## Prompt input estimate

`/stats-pi` and the `PI: ~X tok` value in `/stats` estimate the full initial model input, not just raw prompt text. `/stats-pi` prefers Pi's own HTML export data for the exact exported system prompt and active tool definitions; it falls back to live context data when a temporary export cannot be produced, so it can still be run before any LLM prompt in a fresh session.

The token calculation is intentionally provider-agnostic:

```text
promptTextTokens = weighted text estimate of the system prompt (from exported session data when available)
toolSchemaTokens = weighted text estimate of active tool definitions JSON (from exported session data when available)
framingTokens = conservative message/request framing allowance
baseEstimate = promptTextTokens + toolSchemaTokens + framingTokens
estimatedInitialInput = baseEstimate × historicalCalibrationMultiplier
```

The historical multiplier is learned opportunistically from future sessions by comparing the pre-call estimate with the provider-reported first assistant `usage.input + usage.cacheRead + usage.cacheWrite` after subtracting the first user prompt estimate. `/calibrate` performs the same calculation on demand by opening an isolated session and sending a fixed probe prompt; `/calibrate current` can reuse the current branch once its first assistant response has usage data. Without samples, `/stats-pi` reports an uncalibrated estimate and a conservative range. Provider-reported usage in Pi session JSONL remains the authoritative post-call value.

The version-1 Web UI payload also includes an optional `promptContext` object with independently consumable `initialPrompt`, `snapshot`, and `currentContext` sections. Initial-prompt components are calibrated to sum exactly to the reported estimate. Current-context provider usage remains separate from heuristic character-derived source composition. Structured inventories are deterministic and capped, omit tool parameter schemas and skill locations, and reduce context-file paths to workspace-relative or basename-only display values. Existing `promptEstimate`, `lines.*`, and command text remain available for compatibility.

## Cost coverage metadata

Session-recorded cost remains the source for every aggregate. The extension does not maintain a second provider rate table or rewrite historical values.

For records whose provider is exactly `ollama-cloud`, token-bearing messages with a zero or missing total cost are marked unpriced. The additive version-1 Web UI fields are:

- top-level `costInfo`, with the source, complete or partial status, estimate flag, Ollama Cloud message count, unpriced message count, and one display warning;
- `unpricedMessages` on totals, daily rows, model aggregates, and session aggregates.

Terminal and Web UI formatters display an all-unpriced cost as `unavailable`. Mixed aggregates show their recorded subtotal followed by `recorded + unavailable`. Other providers preserve recorded zero costs because the extension cannot infer whether those models are paid, local, or free.

## Tools

None.

## Example view

```text
/stats 7
Token usage — last 7 days

May 06  in 18k  out 4k   $0.11  ████
May 07  in 42k  out 9k   $0.29  █████████
May 08  in 12k  out 2k   $0.06  ██

Total: 72k input, 15k output, $0.46
Cached-input share: 38%
```

Use it to understand which days, sessions, and models are driving token volume and cost.
