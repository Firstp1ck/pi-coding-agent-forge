# Technical reference: Feature Development Workflow

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

Portable Agent Skill package for new feature implementation work. It helps an agent classify a requested feature as lightweight or complex, preserve blocking decision and completion gates, and use a proportionate workflow without treating model-invoked guidance as runtime enforcement.

## Install or enable

This package is not installed or enabled automatically. When installation is explicitly authorized, install the published package with:

```bash
pi install npm:@firstpick/pi-skill-feature-development-workflow
```

Creation, review, and packaging alone do not change runtime configuration. The skill has no npm runtime dependencies.

## Delegation compatibility

In Pi's terminal UI, complex feature work needs an active subagent integration. When Pi runs inside T3 Code, T3 Code's own delegated agents can satisfy that requirement. A missing native Pi subagent tool alone does not require a workflow waiver or another implementation approval when T3 delegation is available.

The agent must still verify that the selected providers and models can run the required work. Worker outcomes, independent reviews, authorization and completion evidence remain unchanged. If the current environment cannot provide a mandatory outcome, the agent must stop at that step and request a scoped waiver or an approved alternative.
