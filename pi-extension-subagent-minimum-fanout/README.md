# Subagent Review Diversity for Pi

Guides Pi to use different reviewer providers when usable alternatives exist, without blocking reviews when they do not.

## What you can do

- Launch one worker or several workers as the task requires.
- Run sequential or parallel workers through normal subagent workflows.
- Use different reviewer providers when suitable models are available and unblocked.
- Continue with the same provider or model when alternatives are unavailable, blocked, or fail.

## Install

Install it through Pi:

```bash
pi install npm:@firstpick/pi-extension-subagent-minimum-fanout
```

Restart Pi if the package does not appear in your current session.

## How to use it

There is no setup for everyday use. Ask Pi to review your change with independent reviewers. It receives guidance to check which providers are usable and record why a fallback was needed.

Worker and workflow launch counts are not restricted. If your workflow requires two reviewers, keep two separate, read-only, fresh-context runs even when they use the same provider or model. Provider reuse needs no waiver.

This is guidance, not an availability detector or a hard review gate. Reload or restart Pi after updating from the previous blocking version.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-subagent-minimum-fanout/TECHNICAL.md) for complete commands, compatibility, security, and troubleshooting information.
