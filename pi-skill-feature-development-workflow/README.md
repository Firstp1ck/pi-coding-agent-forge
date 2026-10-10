# Feature Development Workflow

Guide a new capability from a clear idea through implementation, review, and a verified finish.

## Helpful when

- You want to add something the product cannot do yet.
- A feature touches several parts of a project.
- You want planning and review to match the size of the change.

## What to share with Pi

- What users should be able to do
- Important rules and things that should not change
- How you will know the feature is complete

## Try asking

> Add project labels to this app. Clarify any important choices, make the smallest complete change, and verify the result.

## What you’ll get

- A clear scope and plan
- Implementation matched to the agreed outcome
- Verification, review results, and remaining risks

When Pi runs inside T3 Code, the workflow can use T3 Code's own agents for implementation and review. You do not need a separate Pi subagent integration when T3 delegation is available.

## Keep in mind

Pi may pause for a decision when the request leaves an important product or safety choice unresolved. This package is not installed or enabled automatically; installation requires explicit authorization. It has no npm runtime dependencies.

## Install

```bash
pi install npm:@firstpick/pi-skill-feature-development-workflow
```

Restart Pi if the skill does not appear in your current session.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-skill-feature-development-workflow/TECHNICAL.md) for advanced usage, configuration, compatibility, and limitations.
