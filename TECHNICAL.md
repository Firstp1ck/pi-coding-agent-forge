# Technical reference: Pi Coding Agent Forge

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Installing packages

Install only the packages you need through Pi:

```bash
pi install npm:@firstpick/<package-name>
```

Each package README contains its exact install command and first-use instructions.

## Package types

- **Extensions** add commands, tools, interface elements, or automatic behavior.
- **Skills** give Pi a reusable workflow for a particular kind of task.
- **Packages** bundle larger features, prompts, themes, or related resources.

## Compatibility

Use a supported, patched Node.js runtime. The repository's `.node-version` selects Node.js 24.22.1. The root package accepts Node.js 22.23.4 or later in the 22.x line, 24.22.1 or later in the 24.x line, or 26.12.1 and later supported releases. Individual packages may require a newer major version.

These minimums include the fix for [CVE-2026-111497, also called Node2Shell](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), in Node.js's bundled Brotli decoder. Updating npm or JavaScript dependencies alone does not fix a vulnerable Node.js executable. Update the runtime wherever you run these packages, including containers and CI, then restart existing Node.js processes. An empty `npm audit` report does not establish that the runtime is patched. The version pin selects a runtime only in tools that read `.node-version`; the engine range normally produces an npm warning rather than preventing execution.

Package-specific runtime requirements, setup, configuration, security notes, and limitations are documented in each package's `TECHNICAL.md`.
