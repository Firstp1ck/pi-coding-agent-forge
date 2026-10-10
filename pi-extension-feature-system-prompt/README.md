# Feature System Prompt for Pi

Recognizes feature requests and loads the feature workflow only when it is actually needed.

## What you can do

- Recognizes requests that add a new capability.
- Loads the feature workflow only when it is needed.
- Keeps bug fixes and ordinary edits lightweight.
- Leaves delegated child sessions to their parent-approved task contract.
- Stops parent feature work safely when the required feature skill is unavailable.

## Install

Install it through Pi:

```bash
pi install npm:@firstpick/pi-extension-feature-system-prompt
```

Restart Pi if the package does not appear in your current session.

## How to use it

Use Pi normally. When you request a new capability in the parent session, the extension loads the feature workflow; ordinary fixes, questions, small edits, and delegated child execution continue without a second routing pass.

When Pi runs inside T3 Code, the workflow can use T3 Code's own agents for implementation and review. It does not require a separate Pi subagent integration when T3 delegation is available.

## Before you start

The `feature-development-workflow` skill must be installed and enabled. If it is missing, the extension stops safely and tells you what is unavailable.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-feature-system-prompt/TECHNICAL.md) for complete commands, configuration, compatibility, security, and troubleshooting information.
