# Technical reference: Project README

Advanced user setup, usage, compatibility, safety, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

This portable Pi skill helps create, harmonize, audit, or update project READMEs, with optional advanced user and contributor companions that need separate approval. It adapts its guidance to repository evidence, local documentation rules, project type, and the primary reader instead of forcing every available section.

## Install or enable

This package is not installed or enabled automatically. When installation is explicitly authorized, install the published package with:

```bash
pi install npm:@firstpick/pi-skill-project-readme
```

Restart Pi if the skill does not appear in the current session. The package has no npm runtime dependencies.

## Requests and inputs

Ask Pi to create, harmonize, restructure, audit, review, or update a project README. Helpful inputs include:

- the target repository or README;
- the primary audience and project type;
- repository-local documentation or writing rules;
- the requested write scope and any existing companion documents;
- verified install, run, configuration, update, rollback, and support information; and
- verified image paths or an explicit visual opt-out when relevant.

Example:

> Harmonize this CLI project's README for end users. Keep its safe rollback instructions, verify every command against the repository, and report unsupported claims instead of guessing.

## Audience profiles

The skill distinguishes two primary profiles:

- **User-oriented:** applications, CLI/TUI tools, setup repositories, and installable products. The README stays focused on choosing, installing, configuring, using, updating, recovering, and safely removing the product. Advanced user detail belongs in `TECHNICAL.md`; development and implementation material belongs in linked API or contributor documentation.
- **Developer/library-oriented:** libraries, SDKs, APIs, frameworks, and reusable modules. The README may include the public integration surface, a minimal code example, supported runtimes, concise technical orientation, verification, and links to complete API or contributor documentation.

Repository-local policy takes precedence. The profile guides section selection; it does not override project-specific requirements.

## Companion documents

When a README task has enough material for a deeper reference, Pi explains the proposed contents and asks separately whether to create each missing file at its exact path:

- `TECHNICAL.md` is for advanced users. It covers complete commands, settings, runtime requirements, compatibility, data locations, privacy controls, updates, recovery, and troubleshooting.
- `DEVELOPMENT.md` is for contributors. It holds implementation, architecture, interfaces, development, tests, and maintenance information.

You can approve either file, both, or neither. Approval for one never approves the other. An earlier explicit approval for the same file and scope can be reused without repeating the question. A README request, a local rule, or an unanswered or cancelled dialog is not approval. Pi does not create empty documents or files that merely duplicate existing guidance.

Existing companions can be linked, but are not overwritten or edited unless those changes are authorized. If you decline a missing file, Pi keeps verified content reachable, omits links to the absent file, and reports any move that could not be made. If that prevents compliance with local rules, it asks for a decision rather than deleting content.

Review-only requests remain read-only. They can recommend a companion but do not create one. This consent behavior is skill guidance, not a filesystem write guard.

Example:

> Harmonize the README and ask me about both companion documents. Create TECHNICAL.md only if I approve it, and leave any existing contributor guide unchanged.

## Visual products

For a user-oriented project with a meaningful visual interface, Pi first looks for verified repository images and user-visible behavior:

1. It looks for a **Main Window** image. If none is available, it asks you for an image path or capture, or for explicit permission to continue without one.
2. It identifies two to four common visualizable features. If they are missing or unclear, it asks you to name them.
3. It requests paths or captures for missing feature images and uses descriptive alternative text.

Pi does not invent, generate, capture, or silently substitute visuals. Non-visual projects and explicit opt-outs omit empty image sections and retain the reason in the work record.

## Evidence and write safety

Repository evidence is the source of truth for names, commands, behavior, requirements, compatibility, links, license details, and assets. When evidence is missing or contradictory, Pi reports the gap or asks for input rather than presenting a guess as fact.

In update mode, Pi should preserve useful verified content. It moves detailed material only when repository policy requires it and a suitable destination exists and is within the authorized write scope. A newly approved companion is written and checked before original content is removed. Essential safety, privacy, compatibility, and destructive-operation warnings remain visible before affected steps.

Always review a proposed README before accepting broad restructuring, especially when existing documentation is user-authored or when commands can modify a system.

## Compatibility and limitations

- Designed as a portable Agent Skills-style skill and packaged for Pi.
- Requires a readable project or supplied project evidence; it cannot verify inaccessible behavior.
- Does not create trustworthy badges, commands, compatibility claims, licenses, screenshots, or feature descriptions without evidence.
- Does not replace repository-local security, contribution, API, or documentation policies.
- Creating or reviewing this package does not install it, enable it, publish it, or modify other repositories.

## Troubleshooting

- **The result contains unresolved placeholders or gaps:** provide the requested project evidence, or explicitly approve omission where the section is optional.
- **A visual section is blocked:** provide verified image paths or captures, identify the common features, or explicitly opt out.
- **The README is too long:** restate the primary audience and ask Pi to relocate nonessential depth to an existing in-scope document, or approve a suitable companion when Pi asks.
- **A companion was not created:** give an explicit creation decision for that exact path and provide substantive content or repository evidence. Declined, unanswered, review-only, empty, and duplicate destinations are not created.
- **A local rule conflicts with the generic structure:** follow the repository-local rule and record the adaptation.
