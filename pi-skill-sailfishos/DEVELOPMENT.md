# Development guide: Sailfish OS skill

Contributor-only implementation, testing, packaging, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Package structure

`package.json` declares `@firstpick/pi-skill-sailfishos` and `pi.skills: ["./skills"]`. The portable entry point is `skills/sailfishos/SKILL.md`; Pi-only interaction belongs in its final adapter section. Topic references and two POSIX helper scripts are explicitly allowlisted for publication. Tests remain repository-only.

The package has no runtime or development npm dependencies, npm executable entry, automatic lifecycle hooks, or bundled personal memory. Reading the skill cannot activate repositories or grant privileges. The user approves real device operations separately.

## Helpers

- `skills/sailfishos/scripts/inspect.sh`: help/argument validation precedes inspection. The OS guard rejects non-Sailfish targets. Optional service/package commands only query; repository URL userinfo, query, and fragment text are redacted. Session-variable reporting is an explicit presence-only whitelist.
- `skills/sailfishos/scripts/package-available.sh`: validates every package argument before queries, forces the C locale, uses the inverted PackageKit source filter `~source`, distinguishes empty successful results from actual Installed/Available rows, and preserves query failures separately from missing packages.

Invoke either helper through `/bin/sh`; executable mode is not required. Neither helper installs, refreshes, removes, elevates, launches applications, or restarts services. Existing PackageKit activation from a read query is a possible observed side effect.

## Validation

Use Python 3.10+ and POSIX sh. Python tests use only the standard library and create isolated temporary fixtures under the configured temporary directory. Package/service mutations are not performed.

From this package directory:

```sh
npm test
npm pack --dry-run --json
npm publish --dry-run --access public
```

The test suite checks publication metadata, portable headings/resources, documentation links/layers, evidence IDs, absence of personal state, input validation, cached lookup statuses, and inventory redaction/read-only invocations. The full inventory test runs only on Sailfish; help and invalid-argument checks run on other POSIX hosts. Run `/bin/sh -n` on both helper scripts as an additional syntax check.

Inspect a real packed tarball before release. It must contain all runtime references/scripts, package metadata, README, TECHNICAL, DEVELOPMENT, and LICENSE, but no tests, research logs, snapshots, bytecode, caches, credentials, or local helper history. Extract under an empty scratch directory and verify every resource link resolves. Do not change global Pi settings to verify packaging.

The repository-wide readiness checker can be scoped to this package:

```sh
bash ../dev/scripts/check-publish-readiness.sh --target pi-skill-sailfishos --skip-auth
```

That checker requires genuine Bash, not a BusyBox executable named bash. If genuine Bash is absent, run the focused npm checks directly and report the omission. Do not replace the device shell for the check.

## Release

Version 0.1.0 is the first publication candidate. Verify registry availability, npm scope access/authentication, package contents, test results, and a clean scoped Git diff first. A dry run is not publication and does not prove credentials or registry acceptance.

With explicit release authorization, publish from this directory:

```sh
npm publish --access public
```

Then verify the exact registry version and packed contents, and update the README's first-release status. Creating/pushing this package does not authorize publishing it. There is no automatic publication on install or Git push.

## Maintenance and provenance

The package derives from the owner's local Sailfish skill. Retain reusable vendor/upstream operational guidance, but remove personal observations, account helper state, private paths, incident logs, and local research artifacts. Do not redistribute a device snapshot as defaults. Keep direct-command devel-su guidance, supported-release safeguards, and privacy boundaries intact.

Changes to helper behavior need a regression test before implementation. Tests for authentication or package transactions must use controlled mocks; never put real passwords, keys, user inventories, or production data in fixtures. Check current vendor/upstream documentation before updating version-sensitive commands. Passing static checks does not prove model behavior, privileged execution, firmware recovery, SDK builds, or every hardware adaptation works.
