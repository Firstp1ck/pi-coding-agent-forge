# Development guide: Prompts Code Workflows for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Additional implementation details

- `/fix` — fix a reported issue end-to-end with verification.
- `/incident` — triage incidents with impact, severity, mitigation, and investigation plan.
- `/issue-fix` — turn an issue into root-cause analysis and implementation plan.
- `/issue-new` — draft a clean maintainer-friendly issue.
- `/land-page` — build five distinct landing-page concepts at `/1` through `/5`.
- `/recomended` — implement the latest agent recommendations, excluding any points supplied as arguments.
- `/review` — review code for correctness, security, performance, and maintainability.
- `/sum-issue` — summarize current feature/fix state and next step.

## `/land-page` prompt contract

The template accepts all trailing text through `$ARGUMENTS` and treats it as optional design or project context. Keep these requirements intact when revising it:

- Five implemented concepts at `/1` through `/5`.
- A usable concept switcher on every route.
- Meaningfully different art direction rather than palette-only variations.
- Real copy and working interactions.
- Responsive and accessible output.
- Repository inspection before edits and verification afterward.
- Conflict handling for existing routes and approval before major dependency changes.

The prompt stays framework-neutral so it can follow the target project's router and component conventions. It moved here from the unpublished `@firstpick/pi-prompts-frontend` package, which was removed.

## Validation

From the package directory, inspect the npm archive before publication and confirm every file in `prompts/` is present:

```bash
npm pack --dry-run
```
