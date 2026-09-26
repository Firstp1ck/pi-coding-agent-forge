# Development guide: Skills for Pi

Contributor-only implementation, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Resource lifecycle

The extension owns `/skills` in TUI mode. `@firstpick/pi-utils/scoped-resource-command` owns the shared Session, Global, and Model command flow, while `@firstpick/pi-utils/resource-management` resolves and stores profiles.

Skill names remain the stable selection identifiers. The extension passes discovery and description fields through `getResourcePresentation()`. The shared selector renders discovery in its own column, shows only the selected skill's description below the list, and includes both fields in search without writing presentation data to saved profiles.

Candidate discovery covers standard user and project skill directories, configured Pi packages, and explicitly loaded skills when `--no-skills` or `-ns` disables normal discovery. Keep source presentation separate from discovery and enablement rules.

## Prompt filtering

The `before_agent_start` handler writes the enabled, model-invocable skills to `event.systemPromptOptions.skills`. Pi uses that structured list for transcript section updates and HTML exports. Returning only a filtered `systemPrompt` changes the provider request but leaves the transcript's skill section unchanged.

Do not force the whole prompt when structured options suffice. Retain text filtering for an earlier handler's `forceSystemPrompt` and for legacy events without structured options. Keep the unfiltered runtime catalog separate so later selection changes can re-enable skills.

## Verification

Run `bun test` from this package after changing discovery, command ownership, source presentation, or invocation filtering. Shared selector behavior is covered by the `pi-utils` test suite.

`tests/prompt-filtering.test.ts` checks structured prompt filtering, empty selections, manual-only skills, legacy events, earlier and later prompt overrides, branch and model changes, runtime inheritance, and RPC non-interference. It also uses Pi's prompt serializer, transcript replay, and HTML exporter to verify that a corrected skill section replaces an older unfiltered section in the exported current prompt. Fixtures use temporary settings and session files and make no provider requests.
