# Development guide: Rewrite in Rust

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Package layout and discovery

- `skills/rewrite-in-rust/SKILL.md` is the canonical, portable workflow. Its frontmatter name matches the directory and the Pi skill command.
- `skills/rewrite-in-rust/references/` holds long-form material the workflow reads on demand:
  - `DECISIONS.md`: the user decision catalogue with stable IDs, both rounds, and the recording format;
  - `RECORDS.md`: shapes for the contract, rulebook, inventory, manifest, parity ledger, unsafe register, evidence log, and handoff;
  - `LARGE-SCALE.md`: helpers to create per project, cycle breaking, tiers, the survey-build loop, worker isolation, continuation, and stopping rules;
  - `SOURCE-LANGUAGES.md`: interop glue per source language, type recovery for dynamic sources, framework services, garbage-collected sources, test classes, and the parity harness;
  - `EXAMPLES.md`: worked Rust examples moved out of the workflow to keep it short.
- `package.json` exposes `./skills` through `pi.skills`, includes the `pi-package` discovery keyword, and declares public npm access. Every reference is listed in its `files` array.
- `tests/package.test.mjs` checks package metadata, the published file list, reference linkage from `SKILL.md`, decision-ID format, uniqueness, and consistency across the skill and references, step references against the workflow headings, documentation links including in-document anchors, the Grill Me offer wording, and Markdown fences.
- All three documentation layers and the MIT license are included in the npm archive so their relative links remain usable.

The skill started as a supplied root-level `SKILL.md` with instructions only. It then gained idiomatic-Rust guidance, an unsafe policy, and worked examples. Version 0.2.0 added the decision catalogue, the scale classification, the large-scale path, record shapes, source-language references, and the Pi adapter for Grill Me. Do not keep a duplicate at the package root.

The npm file allowlist includes the skill, its references, documentation, and license; npm also includes `package.json`. Contributor tests are not published. There are no runtime dependencies, install hooks, bundled scripts, or executable entry points.

## Maintenance contract

Preserve assessment versus implementation scope, one project-specific migration contract, a recoverable original, and explicit behavior and safety evidence. Compilation, soundness, performance, and release readiness are separate claims.

The skill must not assume a particular source language, crate layout, runtime, agent provider, or private helper. Helpers needed during a migration belong in the target project or a scoped temporary workspace, not in this package. If that ever changes, add scripts under the skill directory with their own tests and update the test that asserts references are Markdown documents.

Preserve the idiomatic-Rust target and the unsafe policy: safe redesign first, `unsafe` only for unavoidable FFI or a benchmarked hot path, each block registered and justified.

Decision IDs in `references/DECISIONS.md` are stable identifiers that migration contracts in user projects refer to. Do not renumber or reuse them. Add new entries at the end of their group and retire old ones by marking them retired in place. The tests reject any `D-` ID used in the skill or a reference that the catalogue does not define.

Every reference must be named from `SKILL.md` (as a backticked path or a link) and listed in `package.json`; the tests enforce both. Keep `SKILL.md` as the short workflow and move long material into a reference.

Grill Me integration lives only in the `Pi adapter` section of `SKILL.md`. The skill offers the command and consumes a saved result; it never issues `/grill-me`, never answers questionnaires, and must not be exercised through scripted or background Pi runs. The package test checks the offer wording statically; leave the interview itself as a manual check in a real session.

Rust examples in `SKILL.md` and `references/EXAMPLES.md` must compile on current stable Rust and pass `cargo clippy -- -D warnings` when wrapped in a scratch library crate with the stubs each example names. Check them after editing; the package tests do not compile them. A scratch check:

```bash
cargo new --lib /tmp/rust-rewrite-examples
# copy each example into src/ of that crate, add the named stubs (Config, parse_config,
# parser::render, List, Item, SizeError, GlobError), then:
cargo clippy --manifest-path /tmp/rust-rewrite-examples/Cargo.toml --all-targets -- -D warnings
```

Keep optional background links distinct from required dependencies. Changes to the workflow need semantic review; static packaging tests cannot demonstrate that an agent can successfully migrate a real application.

Follow the repository's [skill portability guide](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-package-skill-lifecycle/vendor/pi-skill-skill-creator/skills/skill-creator/references/SKILL-PORTABILITY.md) when editing the skill.

## Local verification

From this package directory, with Node.js 18 or later and npm:

```bash
npm test
npm pack --dry-run --json
npm publish --dry-run --access public
```

No dependency installation or build step is required. Inspect the archive list for exactly eleven files: the skill, five references, three documentation files, the license, and the package manifest. These checks do not prove registry authorization, name availability, or migration quality.

From the repository root:

```bash
./dev/scripts/check-publish-readiness.sh --target pi-skill-rust-rewrite --skip-auth --skip-registry
git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'
```

Before a release, exercise Pi's skill loader against an extracted tarball and confirm that it discovers only `rewrite-in-rust` with no diagnostics. Interactive invocation, the Grill Me offer, and real migration outcomes require separate manual checks.

## Local use and release

To try the package from a checkout without registering it permanently, run from the repository root:

```bash
pi -e ./pi-skill-rust-rewrite
```

After explicit authorization to publish, use the repository release tooling or publish from this directory:

```bash
npm publish --access public
```

Check the npm version and intended account first. Package creation and dry-run validation do not authorize publication, installation into a user's configuration, or deployment.
