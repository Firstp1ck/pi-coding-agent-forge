---
name: patch-md
description: Agents should invoke this skill to create, migrate, inspect, apply, verify, or roll back versioned PATCH.md v2 lifecycle packages with machine-readable manifests, deterministic plans, drift detection, and transactional safety.
---

# Patch MD Skill

## When to Use

Use this skill to:

- create or update a patch package;
- migrate a legacy prose-only `PATCH.md` to schema v2;
- inspect patch status after package updates;
- plan, apply, verify, or roll back a patch;
- reapply a patch across machines or package layouts.

## Required v2 Artifact

A trusted patch package contains:

```text
PATCH.md
patch.manifest.json
scripts/<lifecycle-handler>.mjs
```

Tests and fixtures are required for package-version or layout-dependent patches.

- `PATCH.md` explains intent, scope, transformations, verification, rollback, and limitations.
- `patch.manifest.json` is the machine-readable source of truth.
- The lifecycle handler discovers actual runtimes and implements semantic, idempotent transformations.

Use `PATCH-TEMPLATE.md`, `TOOL-CALL-SPEC.md`, and `patch-manifest-v2.schema.json`.

## App-specific package location

For an app-specific patch, the app's verified configuration/home directory is the canonical package location, normally `<app-config>/patches/<patch-id>/`.

- Resolve the actual config/home from the app's documented runtime settings, launch options, or verified environment overrides before assuming a default. Ask when the location cannot be established safely.
- Save the complete reconstructable package there: `PATCH.md`, manifest, lifecycle handlers, transformation profiles/assets, documentation, and required tests/fixtures. Do not deliver only a note that depends on a checkout, temporary capture, or versioned app-install directory.
- A repository may retain a development mirror, but report the app-config package as the canonical artifact. Keep runtime assets package-relative and verify the copied package independently.
- For T3 Code, use its resolved T3 home (`T3CODE_HOME` when configured, otherwise the verified `~/.t3` default), for example `~/.t3/patches/<patch-id>/`. Keep patch artifacts outside live `userdata`; storing a patch never authorizes editing app settings or runtime state.
- Do not silently move existing patches, receipts, or backups. Preserve their explicit state directory for rollback, and use `--state-dir` when a separately chosen config-local state directory is intended.
- Patch storage is not patch application. After an app update, run fresh read-only status/plan and obtain plan-bound approval before any installed mutation; never silently reapply.

## Lifecycle Commands

Resolve paths relative to this skill directory:

```bash
node ./scripts/patch_md_extract.mjs --patch /path/to/PATCH.md --strict
node ./scripts/patchctl.mjs status --patch /path/to/PATCH.md
node ./scripts/patchctl.mjs plan --patch /path/to/PATCH.md
node ./scripts/patchctl.mjs apply --patch /path/to/PATCH.md --plan-hash <reviewed-hash>
node ./scripts/patchctl.mjs verify --patch /path/to/PATCH.md
node ./scripts/patchctl.mjs rollback --patch /path/to/PATCH.md --confirm
```

## Workflow

Choose the lifecycle mode below from the user's request and current patch state. Always enter through strict extraction, use read-only status/plan before mutation, and finish with verification or an explicit blocker report.

## Mode A — Create or Migrate

1. Discover actual runtime entrypoints, package dependency graphs, and the verified app-config package destination when the target is an app.
2. Define stable logical targets instead of user-specific absolute paths.
3. Add package support ranges and semantic fingerprints.
4. Implement three-way status: applicable, already-applied/upstreamed, or unsupported.
5. Add idempotent transformation and postconditions.
6. Add offline verification, receipt-based rollback, fixtures, and tests.
7. Parse with strict mode and run the package test suite.

Legacy `--no-strict` parsing is allowed only to extract facts for migration. Never apply from legacy parser output.

## Mode B — Status and Plan

1. Run strict extraction; stop if `ok=false`.
2. Run `patchctl status`.
3. Run `patchctl plan` and review every required target, package version, path, before-hash, transformation, and risk.
4. Do not proceed when a required target is unsupported or the plan reports drift.

Status and plan must be read-only.

## Mode C — Apply

1. Obtain explicit user approval for installed/global package mutation when not already requested.
2. Apply only with the exact fresh plan hash.
3. The handler must prepare and verify all target outputs before committing.
4. Use sibling temporary files, restrictive backups, atomic rename, and automatic rollback on commit failure.
5. Write a non-secret receipt with package versions and before/after hashes.
6. Run offline verification against the exact runtime entrypoints.

Never silently reapply after an update.

## Mode D — Verify

Verification must include, where applicable:

- syntax/type checks;
- semantic postconditions;
- actual runtime/package resolution checks;
- no-secret local protocol capture;
- native TUI and RPC/WebUI variants;
- a second apply producing zero writes.

Network, billing, credential, or live-provider checks must be separately identified and approved.

## Mode E — Rollback

1. Require `--confirm`.
2. Load the apply receipt.
3. Refuse rollback if a target no longer matches the recorded after-hash.
4. Restore backups atomically.
5. Verify restored before-hashes and archive the receipt.

## Verification

After changing this skill or its runner, execute:

```bash
npm run check --prefix <pi-skill-patch-md-package-root>
```

Before depending on a created or migrated patch, also run strict extraction, its fixture/unit tests, `patchctl status`, and offline `patchctl verify`. Run the Pi skill evaluator when available. Record any intentionally deferred network, billing, platform, or live-provider checks.

## Parser and Manifest Requirements

Strict v2 validation requires:

- every fixed heading exactly once and in canonical order;
- contiguous unique Change indexes;
- complete scope-to-change mapping;
- recursive variable resolution with cycle detection;
- complete shell fences preserved as blocks;
- contained manifest and lifecycle handler paths;
- valid v2 manifest fields, risk metadata, verification, and rollback.

## Guardrails

- Prefer upstream fixes or public extension/provider APIs over installed `dist/` edits.
- If `dist/` mutation is unavoidable, resolve from actual executable/runtime entrypoints and fail closed on unknown layouts.
- Never patch every matching package directory blindly.
- Never log credentials, authorization headers, request bodies containing user content, or secret environment values.
- Never execute verification prose as shell commands; use manifest argv steps or reviewed handler code.
- Never claim implementation or verification without file and command evidence.
- Never modify paths outside the reviewed plan.

## Output Contract

Report:

- patch ID/version and manifest path;
- status or reviewed plan hash;
- modified targets and before/after hashes;
- verification results;
- receipt or rollback archive path;
- unsupported targets, deferred live checks, and restart requirements;
- the canonical app-config package path and confirmation that all reconstruction files were saved and the copied package was verified (or the exact storage blocker).
