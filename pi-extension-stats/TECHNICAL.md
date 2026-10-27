# Technical reference: Stats for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

![Token stats dashboard](https://unpkg.com/@firstpick/pi-extension-stats/images/stats_v0.1.2.png)

## Install

```bash
pi install npm:@firstpick/pi-extension-stats
```

No configuration is required.

## Commands

- `/stats [days|all]` — show daily tokens and cost using the machine's local calendar; the default is 14 days.
- `/stats tokens` — show what is using the current conversation space.
- `/stats-pi` — estimate the size of Pi’s starting instructions, tools, and context.
- `/stats-pi detailed` — include the main sources that contribute to that estimate.
- `/calibrate` — improve the estimate using an isolated sample.
- `/calibrate current` — use the current branch when it already has a suitable sample.
- `/stats-last [days|all]` — show days with recorded usage.
- `/stats-most-expense [days|all]` — show the most expensive sessions.
- `/stats-model-compare [days|all]` — compare model usage and cost.
- `/stats-cost-trend [days|all]` — show recent spending direction and projections.
- `/stats-cache [days|all]` — show how much previous model input was reused.

## Understanding the prompt estimate

`/stats-pi` estimates the complete starting model input, not only visible prompt text. It includes Pi’s system guidance, active tool descriptions, and request framing.

Pi’s own exported session information is preferred when available. Before a first model response, or when export is unavailable, the command uses a conservative estimate and displays a range.

Calibration compares an estimate with provider-reported usage from a real first response. Runs started by extension-generated custom messages do not train the first-user-prompt estimate. Their recorded usage still counts toward session totals. Provider-reported session usage remains the authoritative value after a model call.

## Cost data and coverage

The extension uses the token counts and cost saved in each Pi session. It does not replace historical costs with current provider rates.

Ollama Cloud costs are estimates based on the rates supplied by the installed provider package when each request ran. Those pinned rates can differ from current Ollama pricing. Subscription credits, peak pricing, and billing adjustments can also make the displayed estimate differ from the amount billed by Ollama.

When an Ollama Cloud message has token usage but a zero or missing recorded cost, the extension treats that message as unpriced. Cost views show `unavailable` instead of `$0.000`, mark aggregate cost as partial, and report the number of unpriced messages. Other providers retain their recorded zero costs because a zero may be valid for local or free models.

## Privacy and limitations

The extension reads local Pi session history for the current workspace. Cost projections use recorded session costs and are not billing guarantees. Cache share describes reused input volume; it is not a request success rate or a guaranteed monetary saving.

## Example

```text
/stats 7
Token usage — last 7 days

May 06  in 18k  out 4k   $0.11
May 07  in 42k  out 9k   $0.29

Total: 60k input, 13k output, $0.40
```
