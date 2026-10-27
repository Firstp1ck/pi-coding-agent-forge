# Repository rules

This file applies to the whole repository. A more specific `AGENTS.md` in a package directory may add package-specific rules, but it must not weaken the documentation layers or dependency rules defined here.

## Documentation goal

Write documentation for the person reading it:

- `README.md` is the friendly starting point for users.
- `TECHNICAL.md` is an advanced user reference.
- `DEVELOPMENT.md` is for contributors and implementation details.

Do not put every fact in the README. Do not hide essential usage or safety information in a developer document. Move information between layers instead of deleting it.

## Required documentation layers

### `README.md` — human guide

The README answers:

1. What is this package or skill?
2. Why would I use it?
3. What can it do?
4. How do I install it?
5. How do I use it for the first time?
6. Is there anything important to configure or keep safe?
7. Where can I learn more?

Use plain language, short sections, and realistic examples. Keep exact command names, but explain what each important command does.

The README may contain:

- a one-sentence purpose;
- user-facing features;
- installation instructions;
- a practical first-use flow;
- common commands or example requests;
- essential requirements;
- prominent safety and privacy warnings;
- links to `TECHNICAL.md` when advanced user information exists.

The README must not contain:

- internal API endpoints;
- request or response payloads;
- schemas or protocol details;
- internal algorithms or architecture;
- source-file maps;
- contributor test commands and fixtures (user-facing health checks are allowed);
- benchmark implementation methods;
- repository contribution or package-publication internals. User-facing release steps remain allowed when release management is the package’s purpose.

### `TECHNICAL.md` — advanced user reference

`TECHNICAL.md` is still user documentation. It is not a developer dump.

It may contain:

- complete user commands and options;
- user-editable settings and environment variables;
- runtime requirements and supported platforms;
- storage and configuration locations users may need;
- compatibility and operational limitations;
- security and privacy behavior;
- safe update, migration, and rollback behavior;
- troubleshooting guidance;
- links to `DEVELOPMENT.md` for implementation details.

It must not contain:

- HTTP/API/RPC endpoint catalogs;
- request, response, or event payload formats;
- tool schemas or protocol contracts;
- internal state machines, algorithms, hash construction, or locking design;
- the package’s implementation source layout or implementation-specific file names;
- development setup, local linking, or repository package-publishing internals;
- test suites, fixtures, benchmarks, or contributor validation commands.

An API key, service address, user-visible confirmation hash, or health-check command may appear in `TECHNICAL.md` when an end user must configure, verify, or approve it. The package’s internal calls, hash construction, and test implementation belong in `DEVELOPMENT.md`.

### `DEVELOPMENT.md` — contributor guide

Create `DEVELOPMENT.md` only when the package has contributor or implementation information to preserve.

It is the correct place for:

- API and RPC endpoints;
- payloads, schemas, protocols, and event contracts;
- architecture and internal control flow;
- source layout and important implementation files;
- internal algorithms, hashes, locks, queues, caches, and storage formats;
- tool contracts intended for integrators;
- development installation and local linking;
- contributor tests, fixtures, benchmarks, and validation commands;
- repository maintenance and package-publication internals;
- contributor-only migration notes.

Start it with navigation back to the user documents:

```markdown
# Development guide: Package name

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)
```

## Package and extension README structure

Use this structure for top-level `pi-extension-*` and `pi-package-*` packages:

````markdown
# Friendly package name

One sentence explaining the user outcome.

## What you can do

- Three to five specific user-facing features

## Install

```bash
pi install npm:@firstpick/package-name
```

## How to use it

A short first-use flow, followed by the most useful commands or examples.

## Before you start

Only essential setup, safety, or privacy information. Omit this section when it adds no value.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for complete commands, configuration, compatibility, security, and troubleshooting information.
````

Adapt headings when a package has a better user-facing name, such as `Start it`, `Keep it private`, or `Remote access`. Do not remove the purpose, features, installation, practical usage, or technical-reference link.

## Skill README structure

Use this structure for top-level `pi-skill-*` packages:

````markdown
# Friendly skill name

One sentence describing the outcome.

## Helpful when

- Three recognizable situations

## What to share with Pi

- The context that improves the result

## Try asking

> One realistic request with useful scope or constraints.

## What you’ll get

- Three concrete outputs

## Keep in mind

One short limitation or safety note.

## Install

```bash
pi install npm:@firstpick/pi-skill-name
```

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for advanced usage, configuration, compatibility, and limitations.
````

Every skill must have distinct examples and advice. Do not copy the same generic example across skill packages.

## Documenting a new package

When adding a new first-party package:

1. Create its user-facing `README.md`.
2. Create `TECHNICAL.md` for every new package. It holds the advanced user reference: complete commands and options, configuration, requirements and supported platforms, storage locations, security and privacy behavior, limitations, and troubleshooting. It must add reference detail beyond the README, not repeat it.
3. Add `DEVELOPMENT.md` when implementation or contributor material exists.
4. Link the documents in both directions.
5. Add the package to the correct group in the repository `README.md`.
6. Use the exact published package name in installation commands.
7. Include requirements and safety warnings before users encounter a failure or risk.
8. Keep nested fixture, template, test, worker, and vendored READMEs scoped to their own specialized audience.

Do not create an empty `DEVELOPMENT.md`. Every new package gets a `TECHNICAL.md`; write it as a reference that goes beyond the README instead of repeating it.

## Documenting a change

Update documentation in the same change as user-visible behavior.

### New feature

- Add or update a plain-language feature bullet in `README.md`.
- Add a practical usage step, command, or example.
- Add advanced configuration or limitations to `TECHNICAL.md`.
- Add implementation contracts or tests to `DEVELOPMENT.md`.

### Changed command, option, or setup

- Update the first-use path and common command description in `README.md` when users will notice it.
- Update the complete command or configuration reference in `TECHNICAL.md`.
- Update parser, protocol, or implementation details in `DEVELOPMENT.md`.

### Changed security or privacy behavior

- Keep an essential warning in `README.md`.
- Explain user controls and operational consequences in `TECHNICAL.md`.
- Explain enforcement and internal safeguards in `DEVELOPMENT.md`.

### Deprecation or removal

- Remove stale feature claims and examples.
- Explain the user migration path in `README.md` or `TECHNICAL.md`.
- Keep implementation and compatibility history in `DEVELOPMENT.md` when contributors still need it.
- Update the repository package catalog when a package is renamed, replaced, or removed.

### Internal-only change

Do not add implementation detail to the README or technical reference. Update `DEVELOPMENT.md` when the information will help future contributors maintain or verify the package.

## Writing style

- Prefer everyday words and active voice.
- Explain unavoidable Pi-specific terms the first time they appear.
- Address the reader as “you” when giving instructions.
- Lead with the normal successful path; put rare options later.
- Use concrete examples instead of abstract descriptions.
- Keep paragraphs short and lists focused.
- Avoid marketing claims that cannot be verified.
- Avoid empty sections such as `Tools: None` unless the absence matters to users.
- Do not expose secrets, tokens, private paths, or real credentials in examples.
- Use descriptive image alternative text.
- Avoid version-specific screenshots or claims unless the version is clearly stated.

## Moving existing information

When information belongs in another layer:

1. Move it; do not silently delete it.
2. Rewrite the remaining text so headings and sentences are still complete.
3. Add a link to the destination document when readers may need it.
4. Remove duplicate low-level detail from user documents.
5. Preserve essential warnings in the README even when a fuller explanation exists elsewhere.

## Documentation checks

Before considering documentation complete:

- [ ] The README explains purpose, features, installation, and practical usage.
- [ ] Skill examples and package guidance are specific rather than boilerplate.
- [ ] `TECHNICAL.md` contains only advanced user information.
- [ ] API calls, schemas, architecture, tests, and source details are in `DEVELOPMENT.md`.
- [ ] The exact npm package name is used in install commands.
- [ ] Relative links resolve from the file containing them.
- [ ] Headings are not empty and sentences do not end in dangling colons.
- [ ] Fenced code blocks are balanced.
- [ ] Security and privacy warnings remain visible to users.
- [ ] The repository README catalog reflects new, renamed, or removed packages.
- [ ] Unrelated files and existing user changes are left untouched.

Run at minimum:

```bash
git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'
```

For large documentation changes, also check local links and scan `TECHNICAL.md` files for internal endpoint calls, payload/schema descriptions, source paths, test commands, and development-only headings.

## Dependency rules

### Keep first-party dependency ranges current

Packages in this repository depend on each other, most often on `@firstpick/pi-utils`. An existing install keeps any copy that still satisfies the declared range, even after a newer version is published. A range such as `^0.3.0` lets users keep `0.3.0`. If a package imports something that does not exist in its declared minimum version, it fails at runtime for those users.

After every change, check dependencies before considering the work complete:

1. When a package starts using a new export, option, or behavior of another first-party package, raise its dependency range to the first version that provides it. For example, use `^0.3.2` instead of `^0.3.0` when the export first shipped in `0.3.2`.
2. When you change a shared package such as `pi-utils`, find every package that uses the changed or added code and update its range in the same change.
3. Bump the version of every package whose dependency range changed, so the fix can be published.
4. Confirm that the required version of the dependency is published on npm before publishing a package that depends on it.
5. Do not leave long-stale ranges in place when touching a package. Update them to the current version of the dependency once you have checked the package still works with it.

To check that the declared minimum version provides what the package imports, list the published versions and inspect the minimum one:

```bash
npm view @firstpick/pi-utils versions --json
npm pack @firstpick/pi-utils@<minimum-version>
```

Extract the downloaded archive in an empty directory and confirm each imported export exists.
