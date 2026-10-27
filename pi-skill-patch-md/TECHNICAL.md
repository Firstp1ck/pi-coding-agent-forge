# Technical reference: PATCH.md

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

A Pi skill and local runner for versioned patch lifecycle packages.

## Lifecycle

```bash
PATCHCTL=skills/patch-md/scripts/patchctl.mjs
node "$PATCHCTL" status   --patch /path/to/PATCH.md
node "$PATCHCTL" plan     --patch /path/to/PATCH.md
node "$PATCHCTL" apply    --patch /path/to/PATCH.md --plan-hash <reviewed-hash>
node "$PATCHCTL" verify   --patch /path/to/PATCH.md
node "$PATCHCTL" rollback --patch /path/to/PATCH.md --confirm
```

Schema v2 adds:

- a machine-readable `patch.manifest.json`;
- deterministic plan hashes;
- runtime/package discovery;
- semantic fingerprints and fail-closed version handling;
- idempotent, transactional application;
- offline verification and receipt-based rollback.

Legacy prose-only documents may be read with `patch_md_extract.mjs --no-strict` for migration, but cannot be trusted for apply.

## Where app patches are saved

App-specific patch packages are saved under the app's verified configuration/home directory, normally a `patches/<patch-id>/` child. This keeps the files needed to inspect, reconstruct and reapply the patch separate from the app installation that updates replace. A repository may keep a development copy, but it is not the only saved artifact.

For T3 Code, the default is `~/.t3/patches/<patch-id>/`; a configured T3 home takes precedence. Patch files stay outside live `userdata`. Saving them does not change app settings or apply the patch.

Keep the complete package together, including its scripts, supporting files and tests. Existing receipts and backups must remain in their original state directory unless you explicitly arrange a migration. Use `--state-dir /path/to/secure-state` consistently if you choose a config-local state directory; creation alone does not move existing state.

After each app update, inspect status and a fresh plan before approving another apply. An incompatible version or layout is a blocker, not permission to force the patch.

## Native approval dialog

The package also registers the `patch_apply_with_approval` tool. After an agent reviews a fresh `patchctl plan`, it can call this tool with the `PATCH.md` path and exact plan hash.

The tool:

1. recomputes the plan and rejects stale or blocked hashes;
2. displays a native Pi confirmation dialog in TUI or WebUI RPC mode with the patch, targets, writes, risks, and exact hash;
3. refuses to apply without interactive confirmation.

Contributor-level argument handling and plan-recomputation safeguards are documented in `DEVELOPMENT.md`.

Selecting **Yes** applies only that exact reviewed plan. Selecting **No**, **Cancel**, closing the dialog, or running without an interactive UI changes nothing. The tool does not install packages or run live-provider verification.

## Install

```bash
pi install npm:@firstpick/pi-skill-patch-md
```
