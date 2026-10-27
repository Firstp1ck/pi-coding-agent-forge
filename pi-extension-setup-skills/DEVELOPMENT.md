# Development guide: Skills for Pi

Contributor-only implementation, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Resource lifecycle

The extension owns `/skills` in TUI mode and applies profiles in explicitly owned T3 RPC sessions. `@firstpick/pi-utils/scoped-resource-command` owns the shared Session, Global, and Model command flow, while `@firstpick/pi-utils/resource-management` resolves and stores profiles.

Skill names remain the stable selection identifiers. The extension passes discovery and description fields through `getResourcePresentation()`. The shared selector renders discovery in its own column, shows only the selected skill's description below the list, and includes both fields in search without writing presentation data to saved profiles.

Candidate discovery covers standard user and project skill directories, configured Pi packages, and explicitly loaded skills when `--no-skills` or `-ns` disables normal discovery. Keep source presentation separate from discovery and enablement rules.

## Prompt filtering

The `before_agent_start` handler writes the enabled, model-invocable skills to `event.systemPromptOptions.skills`. Pi uses that structured list for transcript section updates and HTML exports. Returning only a filtered `systemPrompt` changes the provider request but leaves the transcript's skill section unchanged.

Do not force the whole prompt when structured options suffice. Retain text filtering for an earlier handler's `forceSystemPrompt` and for legacy events without structured options. Keep the unfiltered runtime catalog separate so later selection changes can re-enable skills.

## T3 RPC ownership and refresh

The shared `isT3ResourceProfileContext` helper accepts only RPC mode with an exact self-PID `T3_PI_RESOURCE_PROFILES=t3-v1:<process.pid>` binding. The T3 injected extension binds the unbound launch request before lifecycle handlers run. Unmarked or wrong-PID clients never opt in; TUI always uses its existing lifecycle and refresh timing.

T3 uses the existing branch directive and defaults resolver, including legacy disabled-name pins. Native T3 tool exceptions belong to the tools extension only; this extension must not infer skill enablement from available tools or add a T3-specific skill allowlist. Profile names refresh before new prompts and explicit `/skill:name` input. Candidate discovery returns a local snapshot and only publishes it after generation, exact model, branch, session and cwd checks. Prompt refresh reuses that snapshot; model and tree changes refresh discovery. Runtime inheritance uses the current runtime skills, rather than a permanent name whitelist. `--no-skills` still limits profiles to loaded commands. Structured skill options, forced text prompts, legacy events and manual-only skills use the same filtering path as TUI.

T3-only profile reads are queued so concurrent RPC input cannot invalidate a prompt merely by reading the same policy. Context changes still reject stale publication and retry once. A matching current policy is applied; if ownership remains but no consistent snapshot can be established, the prompt advertises no skills and explicit input receives a retry notification rather than disappearing silently. Read failures retain a matching last valid policy and report an error. These paths do not change TUI refresh timing.

## Verification

Run `npm test` from this package after changing discovery, command ownership, source presentation, or invocation filtering. Shared selector behavior is covered by the `pi-utils` test suite.

`tests/prompt-filtering.test.ts` checks structured prompt filtering, empty selections, manual-only skills, legacy events, earlier and later prompt overrides, branch and model changes, runtime inheritance, and RPC non-interference. It also uses Pi's prompt serializer, transcript replay, and HTML exporter to verify that a corrected skill section replaces an older unfiltered section in the exported current prompt. Fixtures use temporary settings and session files and make no provider requests.

T3 cases add exact ownership, external-default refresh, explicit invocation, legacy disabled pins, runtime growth, CLI restrictions, installed-skill expansion, repeated starts, stale model/branch/session/shutdown work and TUI timing preservation. Full-discovery tests isolate both home and agent directories. `tests/t3-preflight-regression.mjs` executes Pi 1.1's actual input, prompt, model-switch and serializer paths across concurrent denied input, allowed steering and model changes. Its fixture stops at the provider boundary without constructing a stream or making provider requests.

`tests/t3-tools-integration.test.ts` loads the skills and tools package entrypoints in both orders with isolated legacy T3 launch arguments and settings. It verifies ownership binding before session callbacks, independent skill filtering, denied explicit skill invocations, native T3 tool access and real codemode loadout filtering. The fixture registers inert tools and makes no MCP or provider requests. The skills runtime needed no additional behavior change for the native tool exception.
