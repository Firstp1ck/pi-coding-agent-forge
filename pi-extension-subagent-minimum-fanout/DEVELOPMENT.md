# Development guide: Subagent Review Diversity for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Development

```bash
npm test
npm run check
npm run smoke
npm pack --dry-run --json
```

The package-local tests cover conditional prompt injection, preservation of existing instructions, same-provider and same-model fallback, retained static route diagnostics, and launch pass-through for workers, reviewers, workflows, dynamic fanout, aliases, schedules, and malformed input.

## Guidance contract

The extension appends `REVIEWER_DIVERSITY_GUIDANCE` during `before_agent_start` only when `subagent` or `subagent_gate` is active. It preserves the incoming system prompt and registers no `tool_call` blocker. Static declarations cannot establish live provider usability, so provider selection belongs to the parent agent using current evidence and the active feature or project policy.

The guidance selects different providers when suitable alternatives are available, authorized, and unblocked. Otherwise the parent records evidence and continues with the same provider or model in separate fresh-context runs. It must preserve the required read-only review quorum, avoid duplicate live runs, and respect policy restrictions. `subagent_gate` should retain the required success count with `requireDistinctProviders: false` so provider failure does not prevent same-provider fallback. Explicit user or policy exclusions remain binding.

The exported static analysis helpers remain diagnostic utilities for legacy request shapes, not runtime enforcement. Case and thinking suffixes are normalized before provider/model comparison. A reported `violation` or `failure`, including implicit routes, repeated models, or dynamic reviewer fanout, does not block execution and says nothing about provider availability. Workflow scripts are not statically parsed. Independent run completion and quorum evidence remain the parent workflow's responsibility.

## Additional implementation details

Pi discovers `subagent-minimum-fanout.ts` through the package manifest. The historical package name remains unchanged for installation compatibility.
