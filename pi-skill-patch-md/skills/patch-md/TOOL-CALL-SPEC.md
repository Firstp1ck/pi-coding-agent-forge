# PATCH.md v2 Tool and Lifecycle Specification

## Package location

App-specific packages belong under the app's verified configuration/home directory, normally `<app-config>/patches/<patch-id>/`. Resolve documented overrides before defaults. For T3 Code, use the resolved T3 home and a `patches/` child outside live `userdata`.

Save all reconstruction files, including local handlers, profiles/assets, docs and required fixtures/tests. Repository directories may be development mirrors, but must not be the only deliverable. Keep executable dependencies package-relative, verify the copied canonical package, and report its location. Do not silently relocate existing receipt/backups; the runner's explicit `--state-dir` remains the state source of truth. Storage never grants application or restart approval.

## Files

- Human document: `PATCH.md`
- Machine manifest: `patch.manifest.json`
- Manifest schema: `patch-manifest-v2.schema.json`
- Extractor: `scripts/patch_md_extract.mjs`
- Lifecycle runner: `scripts/patchctl.mjs`

The manifest and lifecycle handler are the executable source of truth. Prose is never executed directly.

## Extract

```bash
node scripts/patch_md_extract.mjs --patch /path/to/PATCH.md --strict
```

Strict mode requires schema v2. `--no-strict` is migration/read-only mode for legacy documents and must not authorize apply.

### Required v2 heading order

1. `# PATCH.md — ...`
2. `## Purpose`
3. `### Root cause`
4. `### Expected outcome`
5. `## Lifecycle`
6. `## Scope (exact files changed)`
7. One or more contiguous `## Change N — ...` sections
8. `## Verification steps`
9. `## Rollback`
10. `## Operational notes`

Each fixed heading must exist exactly once. Each change declares either `**File:**` or `**Files:**`, and every scope target must map exactly to at least one change.

### Safety rules

- All `${VAR}` values are recursively expanded with cycle detection.
- Unresolved variables are errors.
- Every bash/sh fence is preserved as one complete shell program; lines are never treated as independent commands.
- Manifest and handler paths must remain inside the patch directory.
- Strict output is valid only when `ok=true` and the v2 manifest passes structural validation.

## Lifecycle

```bash
PATCHCTL=/path/to/scripts/patchctl.mjs
node "$PATCHCTL" status   --patch /path/to/PATCH.md
node "$PATCHCTL" plan     --patch /path/to/PATCH.md
node "$PATCHCTL" apply    --patch /path/to/PATCH.md --plan-hash <reviewed-sha256>
node "$PATCHCTL" verify   --patch /path/to/PATCH.md
node "$PATCHCTL" rollback --patch /path/to/PATCH.md --confirm
```

### Handler contract

`manifest.lifecycle.handler` is invoked with:

```text
node <handler> <action> --manifest <manifest> --patch <PATCH.md> --state-dir <dir>
```

Apply additionally receives `--plan-file`; rollback receives `--receipt-file`.

Handlers must print exactly one JSON object to stdout and send diagnostics to stderr.

- `status`: read-only target classifications.
- `plan`: read-only deterministic plan. It must report blocked/unsupported required targets.
- `apply`: consume the reviewed plan, revalidate preconditions, prepare all outputs, then commit atomically or roll back.
- `verify`: offline by default and test the actual discovered runtime entrypoints.
- `rollback`: verify after-hashes against the receipt before restoring backups.

`patchctl` binds apply to a SHA-256 plan hash, serializes apply/rollback with a lock, and stores a mode-0600 receipt under the patch state directory.

## Manifest minimum contract

Required fields:

- `schemaVersion: "2.0"`
- `id`, `version`, `title`, `description`
- `risk`
- `lifecycle.handler`
- `support.platforms` and `support.packages`
- `targets[]` with discovery, package, file candidates, and fingerprints
- `verification[]` with network/billing metadata
- `rollback.supported: true`

See `patch-manifest-v2.schema.json` for the full schema.

## Error behavior

Any ambiguity, unknown required target, version mismatch, semantic fingerprint mismatch, path escape, changed plan hash, drifted rollback target, or failed postcondition must stop without partial mutation.
