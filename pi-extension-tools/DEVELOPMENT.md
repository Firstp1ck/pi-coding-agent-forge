# Development guide: Tools for Pi

Contributor-only implementation, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Resource lifecycle

The extension owns `/tools` and applies tool state in TUI mode and explicitly owned T3 RPC sessions. `@firstpick/pi-utils/scoped-resource-command` owns the shared Session, Global, and Model command flow. `@firstpick/pi-utils/resource-management` owns profile resolution and compatible settings writes.

Tool names remain the stable selection identifiers. The extension passes `ToolInfo.sourceInfo.source` as discovery metadata and `ToolInfo.description` as selected-item help to the shared selector. Presentation metadata is never stored in resource profiles.

Use `webui-tools-config` for session branch entries so WebUI and TUI resume the same explicit or inherited choice. Capture Pi's runtime tool baseline before applying a saved selection. Do not let WebUI register a second `/tools` command.

## Runtime enforcement

Keep the effective saved selection separate from both registered and currently active tools. An explicit empty selection denies every Pi tool; owned T3 RPC sessions retain native T3 tools. Runtime inheritance has no selection policy. Preserve unavailable selected names so later registration does not accidentally deny them.

`before_agent_start` prunes active tools against the saved selection. `context_with_system` repeats that check for each request, including tool continuations. It replays excluded names through transcript `toolsRemoved` and `toolsAdded` fields, then appends a request-local removal delta when needed. Earlier messages and their historical tool declarations remain unchanged. This handles tool declarations captured before the active set was corrected.

`tool_call` blocks excluded names even if an extension reactivates them after request preparation. Enforcement only removes tools; it does not reactivate selected tools that another extension intentionally holds inactive. All three handlers require TUI or validated T3 ownership and stop enforcing after shutdown. Failed settings reads retain the last successfully resolved policy.

## T3 RPC ownership and refresh

`isT3ResourceProfileContext` accepts only `ctx.mode === "rpc"` with `T3_PI_RESOURCE_PROFILES=t3-v1:<process.pid>`. The T3 injected extension must bind the launch request `t3-v1` before `session_start`. Consumers never bind requests or infer ownership from UI availability, arguments, MCP or permissions. Inherited bound markers with another PID are ignored, and TUI always follows its original path.

`recomputeT3` uses the canonical defaults reader and resolver, with current branch pins first. It reads defaults at startup, model/tree changes and `before_agent_start`. T3-only reads are queued so concurrent prompt preparations each finish a fresh read instead of invalidating one another. Queued requests reject branch/session changes before starting, and reads reject results after generation, model, branch or session identity changes. Repeated `session_start` and unchanged effective name sets do not reactivate selected lazy tools. Runtime inheritance carries no whitelist and does not reset dynamic activation on each prompt. Saved tool names remain literal. Owned T3 RPC sessions exempt native tool names matched by the package-local `src/t3-native-tools.ts` predicate: `mcp__t3-code__` and Pi's normalized `mcp__t3_code__`, both requiring a nonempty suffix. Startup and changed-policy application retain active native tools; request filtering and call guards use the same predicate. Do not rewrite saved selections or force provider-held inactive tools active.

`src/t3-resource-profiles-compat.ts` is loaded by the package entrypoint, not as a second auto-discovered extension. It recognizes legacy RPC chat launches only with the explicit T3 bridge, its MCP/runtime environment and no helper restrictions, then binds before `session_start`. Raw new-protocol and inherited markers are not rebound. Native `codemode` and `tool_search` catalogs use the same saved resolver and native T3 exception, covering declared, callable and registered loadouts, the discovery API catalog and execution-context tools. The predicate does not change tool exposure or bypass permission handlers. Wrapped tool contexts preserve non-enumerable methods and lazy guarded getters through property descriptors; object spread would lose Pi's `executeTool` method.

This is a model-tool selection rule, not isolation from trusted extensions or nested calls made inside an enabled gateway.

## Verification

Run from this package directory:

```bash
bun test
```

`tests/enforcement.test.ts` covers MCP reactivation, late registration, repeated requests, blocked calls, unavailable selected tools, lazy activation, empty selections, scope precedence and inheritance, settings-read failures, non-TUI modes, shutdown, and transcript preservation. Tests use temporary settings files and do not connect to MCP servers.

T3 cases also cover ownership markers, prompt refresh, unchanged lazy selections, repeated starts, exact-model and branch precedence, unrestricted runtime activation, stale async model/branch/session/shutdown work and unchanged TUI refresh timing. Native-tool regressions cover both namespace forms, empty selections, late declarations, request history, allowed calls, provider-held inactive tools and denied lookalikes. Cross-package tests in the skills package exercise both extension load orders with the real native codemode loadout implementation. `tests/t3-resource-profiles-compat.test.mjs` covers legacy launch restrictions, native discovery catalogs, non-enumerable context methods and lazy getters. The npm files list includes `src` so the compatibility module ships with the existing package.
