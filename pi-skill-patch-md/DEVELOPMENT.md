# Development guide: PATCH.md

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Safety enforcement

The approval extension invokes `patchctl apply` with an argument vector rather than shell interpolation. `patchctl` recomputes the plan immediately before transactional mutation so a stale reviewed hash cannot authorize changed work.

## Storage guidance contract

`skills/patch-md/SKILL.md` owns the model-invoked app-config storage rule. App-specific reconstruction packages have a canonical config/home location; a repository can keep a development mirror. The handler must remain package-relative so the copied artifact does not depend on repository or temporary captures. The trusted runner's explicit state directory remains authoritative for receipts and backups; this guidance does not change approval or relocation behavior.

`tests/storage-guidance.test.mjs` checks the complete-package, verified-home, outside-userdata, copied-package verification, and no-silent-migration/application requirements. No runtime configuration or parser schema changes are needed for this guidance update.

## Test

```bash
npm test
```
