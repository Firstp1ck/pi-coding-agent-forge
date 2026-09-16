# Development guide: Frontend design

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Package layout

- `skills/frontend-design/SKILL.md` contains the installable skill and requires a behavior pass before implementation.
- `skills/frontend-design/references/expected-behavior.md` contains the behavior classification, trigger-based checklist, application scenarios, acceptance checks, and external sources. The skill requires reading it before coding. Keep it in the published file list.
- `tests/skill-contract.test.mjs` checks package metadata, frontmatter, required visual and behavior guidance, reference coverage, licensing, documentation links, and Markdown structure.
- `package.json` declares the Pi skill directory and npm tarball contents.

The package has no runtime code or dependencies.

## License and modification notice

The package uses Apache 2.0 and keeps the complete terms in `LICENSE`. The installable skill carries a short modification notice. Keep both files in the npm tarball.

## Behavior guidance design

The previous skill treated quality mostly as visual direction, with brief mentions of mobile, focus, motion, errors, and empty states. It did not require an inventory of controls, complete interaction flows, or observable behavior checks.

The revised skill keeps the visual workflow and adds three working categories: baseline usability, feature-dependent expectations, and product decisions. This classification is an engineering synthesis, not an industry standard. W3C WAI/APG, GOV.UK Design System, and Nielsen Norman Group support specific conventions; source links and qualifications live in the packaged reference.

Keep mandatory behavior rules in the main skill. Keep the detailed examples and rationale in the reference rather than duplicating them in several documents. A focused fix must not trigger a full redesign. An implied requirement must not become authorization to change business policy, retain sensitive data, or act on external systems.

The examples deliberately include hard cases: a failed settings save, out-of-order catalog responses, an uncertain payment result, a rejected member removal, a partial upload failure, and a rejected board move. Preserve their distinction between an observable frontend result and a backend guarantee.

## Testing

From the package root, run:

```bash
npm test
npm pack --dry-run --json
```

The contract test uses Node's built-in test runner and needs no installed dependencies. Inspect the dry-run file list whenever package metadata changes. The behavior reference must appear in the tarball, since a local link check alone cannot establish that npm will include it.

These are text and packaging contracts, not evidence that a model follows the instructions or that a generated application is usable. When evaluating model behavior, give it a brief with unstated expectations, such as notification settings backed by an existing service. Inspect whether it loads stored values, retains edits on failure, avoids false success, and checks keyboard use without being prompted for each detail. Also test a static article or visual-only brief to detect unnecessary scope expansion. Record the model, tools, prompt, output, and actual interaction evidence rather than claiming a behavioral improvement from text tests alone.

From the repository root, also run:

```bash
git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'
```

## Release maintenance

Use the repository's npm release workflow after the package tests and dry-run tarball check pass. Publication is a separate external action and requires explicit approval. Keep the package name, install command, root catalog entry, and repository directory metadata in sync when renaming the package.
