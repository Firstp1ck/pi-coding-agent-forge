# Technical reference: Prompts Code Workflows for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

Reusable prompt templates for code review, debugging, issue planning, incident triage, and landing-page design concepts in any repository.

## Install

```bash
pi install npm:@firstpick/pi-prompts-code-workflows
```

For local testing from this repository root:

```bash
pi install ./pi-package-prompts-code-workflows
```

## Configuration

No required configuration. After installation, type `/` in Pi to autocomplete the prompt templates.

`/recomended` uses the agent's latest relevant response as its source. Every argument is an exclusion and may be a recommendation number, label, or short description:

```text
/recomended 2 "skip the database migration"
```

Run it without arguments to implement all actionable recommendations. If the source recommendations or an exclusion are ambiguous, the prompt tells the agent to ask before making changes.

## Landing-page concepts

`/land-page [brand, stack, or visual direction]` builds five landing-page concepts for a second-brain note-taking app. It creates routes at `/1`, `/2`, `/3`, `/4`, and `/5`, with a compact route switcher on every page.

Arguments are optional. Use them to point Pi toward existing brand files, name a preferred style, or clarify project constraints:

```text
/land-page Follow docs/brand.md. Keep the existing Astro stack and avoid new dependencies.
```

The prompt tells Pi to inspect the repository before making changes. It should use the established framework, route layout, components, and dependencies. It also asks Pi to avoid overwriting unrelated numbered routes and to get approval before introducing a framework or major dependency.

The exact file locations depend on the project router. The visible routes remain `/1` through `/5` whether the project uses a pages directory, an app directory, or another routing convention.

The target project must provide a frontend environment where five routes can be implemented. Available formatters, type checks, tests, builds, and browser tools determine how much verification Pi can perform.

If the command finds existing `/1` through `/5` routes, review the conflict it reports rather than forcing an overwrite. You can also add route constraints in the command arguments.

## Dependencies

No repository-local Pi extensions, tools, skills, or other prompt packages are required. This bundle only contributes prompt templates through `pi.prompts`.

## Troubleshooting

If a prompt such as `/land-page` does not appear, restart Pi and type `/` to refresh prompt autocomplete. Check that the package appears in `pi list` and is enabled in `pi config`.
