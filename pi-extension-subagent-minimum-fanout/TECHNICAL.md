# Technical reference: Subagent Review Diversity for Pi

Advanced user setup, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

Provides conditional reviewer-provider guidance without blocking launches. The extension does not impose a minimum child or worker count. Direct single workers, sequential workers, workflows, schedules, and dynamic fanout remain allowed.

## Install

```bash
pi install npm:@firstpick/pi-extension-subagent-minimum-fanout
```

## Behavior

When delegation tools are active, the agent receives reviewer-selection guidance:

- Use different providers if suitable models are available, authorized, and unblocked.
- Check current availability and known authentication, quota, rate-limit, outage, model-scope, and policy restrictions. A listed model is not proof that it is usable.
- If no usable alternative exists or an alternative fails, continue with the same provider or model and record the fallback reason and evidence. No waiver is needed for provider reuse.
- Preserve the required separate, read-only, fresh-context reviewer runs and outputs.
- Do not retry known-blocked providers merely for diversity, bypass restrictions, or duplicate live reviewer runs.

Worker counts and management operations remain unrestricted by this extension. Implementation details are documented in `DEVELOPMENT.md`.

## Recommended policy

Use this package when different review providers are useful but provider availability must not prevent progress. Two independent reviewer runs remain required wherever the active workflow requires them. Plans, ownership, isolation, and successful review evidence remain that workflow's responsibility.

## Requirements and compatibility

- A compatible Pi runtime with delegation tools enabled.

The package has no configuration, commands, network access, file access, or persistent state. Reload or restart Pi after updating from the previous blocking version. Existing workflows that explicitly demand different providers must also be updated to permit fallback.

## Limitations

This is prompt guidance, not hard enforcement or an automatic provider-health check. The agent must verify usability and fallback evidence. The extension cannot prove that reviewers are useful, independent, or successfully completed, and does not override restrictions imposed by other tools or policies.

## Security and privacy

- The extension adds reviewer-selection guidance to the in-memory system prompt when delegation tools are active.
- It sends no data over the network and does not read, write, or persist files.
- It does not validate or block tool input. Tool validation and other safety controls remain unchanged.

## License

MIT
