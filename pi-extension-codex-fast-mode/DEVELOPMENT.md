# Development guide: Codex Fast Mode for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Request transformation

`index.ts` registers `before_provider_request` and returns a shallow copy of a plain serialized payload only when a speed override applies. It never mutates the original payload or its nested fields.

- `normal` returns `undefined`, preserving the existing request.
- `fast` writes `service_tier: "priority"` only for provider `openai-codex` and API `openai-codex-responses`.
- `ultrafast` writes `service_tier: "ultrafast"` only for that provider/API, model ID `gpt-6-astra`, and a payload whose `model` is also `gpt-6-astra`.

Other providers, APIs, models, invalid modes, and malformed payloads are unchanged. A selected but ineligible Ultrafast preference never silently requests Priority instead. The exported transformer continues accepting booleans as the original Fast/Normal contract.

The public [Ultrafast API guide](https://developers.openai.com/api/docs/guides/ultrafast-mode) documents the tier for Responses over HTTP and WebSockets. This extension deliberately does not broaden its scope to API-key billing or preview-only GPT-5.6 Sol access. Subscription eligibility follows [Codex speed documentation](https://developers.openai.com/codex/speed).

No credentials, plan information, network calls, authentication changes, model registration, or model selection are involved. The tier is request intent; authenticated backend acceptance is not covered by offline tests.

## Commands and session state

The canonical in-memory state is `mode: "normal" | "fast" | "ultrafast"`. `on` maps to Fast and `off` to Normal. Explicit `normal`, `fast`, and `ultrafast` arguments are supported. A bare command maps Normal to Fast and either enabled mode to Normal. `status` is read-only.

All mutations reject a busy session or pending messages before modifying state. Selecting Ultrafast also requires an eligible current model. Successful Ultrafast selection emits a warning containing plan requirements and the 8× included-usage / 6× purchased-credit or pay-as-you-go charges. The explicit command selects the preference; the WebUI adds a pre-selection cost confirmation.

Session entries keep custom type `codex-fast-mode` and write `{ mode, enabled: mode !== "normal" }`. The compatibility boolean lets older versions safely interpret either enabled mode as Fast. New versions read legacy boolean-only entries as Fast/Normal. A valid explicit mode is authoritative; invalid explicit modes are ignored rather than falling back to a conflicting boolean.

`session_start` and `session_tree` reconstruct the latest valid snapshot from `ctx.sessionManager.getBranch()`, not abandoned branches. An empty branch defaults to Normal. A restored Ultrafast preference can remain selected on an unsupported model without rewriting its requests.

## Status and WebUI contract

The `codex-fast-mode` status key retains `on` for Fast and `off` for Normal, adding the exact value `ultrafast`. It represents the selected preference, not upstream acceptance. Consumers that support only on/off must be updated before displaying Ultrafast.

The WebUI companion normalizes these values to `normal | fast | ultrafast`, preserves legacy boolean writes, and waits for the exact desired mode. An enabled boolean cannot confirm a Fast/Ultrafast transition. Browser disable-off-first handling applies to either enabled tier.

The package publishes README, technical reference, and development guide so relative navigation works after npm installation. Package publication remains a separate release action.

## Development checks

```bash
npm test
npm run check
npm run smoke
npm pack --dry-run --json
```

The deterministic tests cover command grammar and completions, all mode transitions, legacy state migration, invalid snapshots, branch restoration, busy and pending-message guards, exact provider/API/model isolation, matching serialized model checks, malformed payload passthrough, non-mutation, status publication, and credit warnings. No authenticated or paid model request is made.

The companion WebUI tests cover exact mode normalization, legacy HTTP writes, conflicting intent rejection, model eligibility, status-confirmed transitions, cost-confirmation cancellation, and disabling an Ultrafast integration.

## License

MIT
