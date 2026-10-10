# Technical reference: Feature System Prompt for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Install

```bash
pi install npm:@firstpick/pi-extension-feature-system-prompt
```

## What it changes

The extension decides whether a request is feature work before the main agent begins.

- Clear questions, reviews, research, troubleshooting, and bug fixes stay lightweight.
- Requests that add a capability receive a short instruction to load `feature-development-workflow`.
- Short follow-up messages can continue the previous feature decision when the connection is clear.
- Delegated Pi child sessions skip this parent-only routing pass and follow the bounded task contract supplied by their parent.

The complete feature workflow is not copied into every conversation. Pi loads it only when the request needs it.

## Requirements

Install and enable `feature-development-workflow`. Complex feature handling also requires the skill’s packaged complex-feature reference.

Reload Pi after changing the extension, skill, or settings.

## Failure behavior

If classification is unavailable or unclear, Pi receives a short fallback telling it to decide from the request and repository evidence. The full feature workflow is loaded only when that decision supports it.

If the enabled skill or a required reference cannot be read in a parent session, feature implementation stops with a configuration message. The extension does not silently continue with a partial policy. Pi child sessions are identified by the runtime's child marker and skip this check because their inherited skill catalog may be intentionally stripped.

## T3 Code compatibility

When Pi runs inside T3 Code, required implementation and review work can use T3 Code's own delegated agents. A missing native Pi subagent integration alone is not a reason to ask you for a workflow waiver or another implementation approval.

Required worker outcomes, independent reviews and safety controls still apply. If T3 delegation cannot provide a mandatory outcome, the agent must stop at that step rather than skip it.

After updating the extension, start a fresh Pi provider session in T3 Code so it loads the updated instructions. This change does not alter T3 permission modes or other safety extensions.

## Privacy and limitations

Classification uses the active conversation model only for ambiguous requests. It runs separately without tools and receives bounded request context.

The extension routes guidance; it does not grant permission, make product decisions, or replace runtime safety controls.
