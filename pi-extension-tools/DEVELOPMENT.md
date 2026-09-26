# Development guide: Tools for Pi

Contributor-only implementation, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Resource lifecycle

The extension owns `/tools` and applies tool state only in TUI mode. `@firstpick/pi-utils/scoped-resource-command` owns the shared Session, Global, and Model command flow. `@firstpick/pi-utils/resource-management` owns profile resolution and compatible settings writes.

Tool names remain the stable selection identifiers. The extension passes `ToolInfo.sourceInfo.source` as discovery metadata and `ToolInfo.description` as selected-item help to the shared selector. Presentation metadata is never stored in resource profiles.

Use `webui-tools-config` for session branch entries so WebUI and TUI resume the same explicit or inherited choice. Capture Pi's runtime tool baseline before applying a saved selection. Do not let WebUI register a second `/tools` command.

## Runtime enforcement

Keep the effective saved selection separate from both registered and currently active tools. An explicit empty selection denies every tool; runtime inheritance has no selection policy. Preserve unavailable selected names so later registration does not accidentally deny them.

`before_agent_start` prunes active tools against the saved selection. `context_with_system` repeats that check for each request, including tool continuations. It replays excluded names through transcript `toolsRemoved` and `toolsAdded` fields, then appends a request-local removal delta when needed. Earlier messages and their historical tool declarations remain unchanged. This handles tool declarations captured before the active set was corrected.

`tool_call` blocks excluded names even if an extension reactivates them after request preparation. Enforcement only removes tools; it does not reactivate selected tools that another extension intentionally holds inactive. All three handlers are TUI-only and stop enforcing after shutdown. Failed settings reads retain the last successfully resolved policy.

This is a model-tool selection rule, not isolation from trusted extensions or nested calls made inside an enabled gateway.

## Verification

Run from this package directory:

```bash
bun test
```

`tests/enforcement.test.ts` covers MCP reactivation, late registration, repeated requests, blocked calls, unavailable selected tools, lazy activation, empty selections, scope precedence and inheritance, settings-read failures, non-TUI modes, shutdown, and transcript preservation. Tests use temporary settings files and do not connect to MCP servers.
