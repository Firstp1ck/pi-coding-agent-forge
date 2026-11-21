# Technical reference: Release npm for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Requirements and package selection

Use a supported Node.js runtime compatible with your Pi installation, npm, and Bash for shell commands. Publication uses npm and requires an installed Chromium-based browser. Bun remains available for readiness checks only. Linux is tested; Windows requires Git Bash and retains the existing Pi process-tree abort support, but the new standalone dashboard has not been verified there.

The workflow discovers direct child folders containing `package.json`, excluding hidden folders and `node_modules`. If there are no child packages and the current root has a manifest, it checks that package as `.`. Select nested packages explicitly with `--target` or `--targets`. npm workspace declarations do not expand the selection. Targets must stay inside the selected root.

Private packages and configured exclusions are skipped, including aliases resolving to an excluded directory. A package with invalid metadata, missing packed Pi resources, or failed publication validation cannot be published. A failed package blocks dependents only when they require its unpublished version; independent packages continue. Dependency checks use the requirements in the prepared package, including changes made by release hooks. Required workspace dependencies outside your selection must already be published at a compatible version. They are not released automatically. Optional dependencies and explicitly optional peer dependencies do not block consumers. An unbundled required local reference must be changed to a published registry range or bundled before release.

## Pi commands and confirmation

| Command | Action |
| --- | --- |
| `/release-npm` | Choose packages, compare and validate, review the plan, then confirm publication |
| `/release-npm-setup` | Configure an npm token and verify authentication |
| `/release-toggle` | Show or hide terminal progress; switch compact/detailed output in other clients |
| `/release-abort` | Cancel the active release subprocess |
| `/release-npm-logs` | Select a saved Pi run log; append `close` to close the log viewer |

Preflight does not require a successful sign-in. Private registries may still require credentials to read packages. Publishing checks authentication after confirmation. Run `/release-npm-setup` or use your usual npm login flow before publishing. When npm challenges an upload, browser approval is required for that registry. The workflow opens the approval link in Chromium, Chrome, Brave, or Edge on your system, then waits up to ten minutes. Complete the approval in that browser; the workflow resumes automatically. If npm offers a five-minute remembered approval option, you may select it in the browser. npm controls the grant and its expiry. The workflow does not select the option, share approval tokens between packages, or assume the grant remains valid; a renewed challenge opens a new approval flow. There is no alternate-client fallback or token-based bypass for this approval. Never put tokens in chat, source files, or release reports.

Before checks, every discovered package starts selected. Uncommitted Git changes are marked as a reminder; comparison uses the files on disk, including dirty files. In Pi's terminal picker, arrows, `PgUp`/`PgDn`, and `Home`/`End` move; `Space` toggles; `Ctrl+A` selects all; `Ctrl+X` clears all; `Enter` starts checks; `Esc` cancels. Other Pi clients use paged choices.

After mixed preflight results, Pi shows every failure and offers only ready candidates. You can publish all eligible packages or select a subset. The terminal confirmation has separately scrollable summary and selection panes. `Tab` switches panes, `Space` toggles, `A` selects all or clears all, `Enter` publishes, and `Esc` cancels. Selections persist across pages in other clients. The confirmed set runs together so required releases can be ordered.

### Pi progress and logs

The Pi terminal window shows one package status line, a second line for planned versions, and extra lines for warnings/failures. `…` means work remains; `✓` means the check or publication finished; `✗` marks a failure. Several comparisons can be active together. Counts distinguish ready work, verified publications, uploads still processing in the registry, and problems.

Arrow keys and `PgUp`/`PgDn` scroll. `Home` jumps to the start; `End` follows active work. `Esc`, `q`, or `Ctrl+O` hides the progress window and returns to Pi input. `/release-toggle` shows it again. `Ctrl+C` or `/release-abort` aborts the active release. Other clients display a release card or widgets. Pi remains usable while work runs.

Pi saves progress, outcomes, failure details, and per-package log locations under `~/.pi/agent/release-npm-logs/`. `/release-npm-logs` opens these run logs. Detailed child-command output is retained separately in the package logs described below, rather than flooding the Pi window.

## Standalone shell workflow

In this repository:

```bash
./dev/scripts/release-workflow.sh --plan --all
./dev/scripts/release-workflow.sh --check --target pi-extension-notes
./dev/scripts/release-workflow.sh --publish --targets pi-utils,pi-extension-release-npm --report .release-reports/run.json
```

The installed extension also includes `release-workflow.sh`; run it with Bash using its installed path. The repository wrapper defaults to the repository containing the wrapper, even when invoked elsewhere. The bundled wrapper defaults to your current directory. `PI_NPM_PACKAGES_ROOT` overrides either default; `--root <directory>` overrides that environment variable. Relative target paths resolve under that root. Report and retry-file paths resolve under your current directory.

Choose exactly one mode:

| Mode | Behavior |
| --- | --- |
| `--check` | Compare packed content, determine planned versions, and validate changed/new candidates |
| `--plan` | The same isolated readiness work, suitable for a pre-confirmation plan |
| `--publish` | Recheck the selected packages and publish eligible candidates immediately |

Check and plan never write planned versions or generated hook output to source packages. Preparation uses temporary workspaces in every mode, including publish. Existing bundles are preserved there; missing bundles may be installed with dependency lifecycle scripts disabled and without writing a source lockfile. Missing bundled build tools are restored before comparison hooks run. Comparison-hook output is discarded before building the final versioned candidate from clean captured inputs. Release lifecycle hooks remain enabled for packages you selected.

| Option | Default and meaning |
| --- | --- |
| `--all` or `--target all` | All direct child packages, or `.` for a single-package root |
| `--target <directory>` | One directory, including `.` or an in-root absolute path |
| `--targets <dir,dir,...>` | Several directories, supported in every mode; paths cannot contain commas |
| `--targets-json <array>` | Literal directory paths as a JSON array, including names containing commas; Pi uses this form |
| `--root <directory>` | Override the wrapper/environment root |
| `--concurrency <1-64>` | Four comparison/validation workers and at most four active verification probes by default; uploads remain sequential |
| `--verify-timeout <seconds>` | Verification deadline from each upload submission, including time waiting for a verification slot; default 1200 seconds, integer from 1 to 86400 |
| `--refresh` | Bypass cached comparison results; registry metadata is fresh on every invocation |
| `--exclude <name-or-directory>` | Add an exact package name or path exclusion; repeatable |
| `--publisher npm`, `bun`, or `auto` | npm by default; auto also chooses npm; Bun is limited to check/plan |
| `--access public` or `restricted` | public by default |
| `--strict-auth` | Require authentication during check/plan as well |
| `--no-strict-auth` | Disable the explicit authentication check; registry permissions still apply |
| `--plain` | Disable terminal controls and print concise progress/outcome records |
| `--json` | Print only the JSON report to stdout; diagnostics use stderr |
| `--report <file>` | Save a JSON report atomically, replacing an existing report |
| `--retry-failed <file>` | Freshly check failed, blocked, cancelled, or processing targets from a matching-root report |
| `--help` or `-h` | Show help without starting release work |

Publish uses strict authentication unless you explicitly disable it. Check/plan default to non-strict authentication. `--check-alt-client` now fails with guidance to run a separate `--check --publisher bun`; it is never ignored. The older standalone bump/readiness/publish helpers remain available for compatibility and do not have all the coordinator's isolation and reporting guarantees.

### Exclusions

Create `.release-config.json` in the release root:

```json
{
  "exclusions": ["unfinished-package", "@example/internal-preview"]
}
```

Only the `exclusions` setting is accepted. Entries must be nonempty exact npm names or directory paths; globs are rejected. Malformed JSON, unknown settings, or invalid entries stop the run before package work. Command-line exclusions are added to this list. Exclusion configuration is loaded only from the chosen root, so a package-root invocation does not inherit its parent workspace's exclusions.

This repository explicitly excludes the unfinished `pi-extension-gui-testing` package. You cannot override an exclusion with `--target`; change the configuration deliberately when the package is ready.

### Standalone dashboard

A live terminal shows a fixed viewport with one row per package, including name, version, stage, result, elapsed time, and status counters. The list scrolls within the terminal and resizes with it. Child output stays in retained logs.

| Key | Action |
| --- | --- |
| Arrows, `PgUp`/`PgDn`, `Home`/`End` | Select a row or move through pages |
| `f` | Cycle all packages, changed/error packages, and errors |
| `a`, `c`, `e` | Select those filters directly |
| `Enter` | Open or close the selected package's details and log tail |
| `Esc` or `q` | Return to the table |
| `Ctrl+C` | Cancel, then restore the cursor and terminal input mode |

Details show a bounded tail of the package log. The full log remains on disk. Redirected output, CI, and dumb terminals use plain records automatically. `--plain` forces that mode. The dashboard closes after the run and prints aligned counts, groups of published, processing, ready, and problem packages, and log locations on separate lines. Zero-value optional counts and individual unchanged packages are omitted. Processing uploads include a next step for checking confirmation without another upload.

## Reports, storage, and retries

Use a report to keep full package outcomes and log locations:

```bash
./dev/scripts/release-workflow.sh --publish --all --report .release-reports/run.json
./dev/scripts/release-workflow.sh --plan --retry-failed .release-reports/run.json --refresh
./dev/scripts/release-workflow.sh --publish --retry-failed .release-reports/run.json --report .release-reports/retry.json
```

A retry requires the same canonical root and selects failed, blocked, cancelled, or processing targets. It invokes fresh release work rather than replaying uploads. Ready or published packages are never added automatically. Repair failed dependencies or explicitly select a wider set if the retry needs a release outside its target list. `--retry-failed` cannot be combined with another target selection. A report without any of these targets produces a diagnostic.

Reports contain absolute root/log paths, package metadata, and outcomes. Keep reports and logs private when hooks may print sensitive information. On POSIX systems, run-log directories use permission `0700`, and logs and reports use `0600`. Raw child diagnostics stay in package logs; summaries show the command failure category and log location. Package warnings remain visible even when an upload was verified. A receipt-cleanup failure keeps the verified publication recorded and returns a nonzero result with a diagnostic; retained receipts continue to prevent duplicate submissions. A report write failure makes the command fail and prints a diagnostic; it cannot reverse a completed upload. JSON stdout still describes the engine's package results.

Comparison caches live under `~/.cache/pi-release-npm/<workspace-id>/`. Workspace scratch lives under `$XDG_CACHE_HOME/pi-release-npm-workspaces/`, defaulting to `~/.cache/pi-release-npm-workspaces/`. This keeps large copies off memory-backed temporary storage by default. Copy-on-write is used when the filesystem supports it; other filesystems may need room for one repository snapshot, one full working copy, validated tarballs, and deduplicated hook checkpoints. Packages with publication hooks retain their prepared workspace state in private temporary checkpoints, so verification does not hold a separate full working copy for every upload. Jobs needing full repository context run one at a time, while ordinary package checks can use the remaining worker slots. Snapshot copying also uses bounded parallel work. Completed working copies are removed promptly, and invocation cleanup removes the shared snapshot.

Detailed logs live in your operating system's temporary directory under `pi-release-npm-logs-<user-id>/<run-id>/`, separated by operating-system user. Logs and comparison caches remain until you remove them. Safe cleanup while no release runs is to delete old log directories, comparison-result JSON files, or abandoned workspace scratch directories. Upload receipts in the cache’s `uploads/` directory protect against duplicate submissions. Keep them until the workflow verifies the upload; do not delete the entire cache while a publication is unresolved. `--refresh` avoids deleting the comparison cache manually.

Exit code `0` means the run completed without failures or unverified uploads. `1` includes verification timeouts, failures, and operational errors; `130` means cancellation. A timeout leaves the package marked processing, with its upload receipt retained. It is not reported as published. A partial failure does not undo healthy publications. Inspect individual outcomes and warnings, including hooks that failed after a release was confirmed.

## Version and publication behavior

For changed packages, the next version follows npm's latest stable `major.minor.patch`: increment the patch through 9, then roll to the next minor `.0`. A local version above that target is reduced. First releases keep the source version; unchanged packages keep theirs. Prerelease planning is outside this policy.

Publish writes the planned source version immediately before upload. An unsuccessful upload can leave that version in place. All eligible candidates are prepared and validated before the first upload or browser approval. Uploads then run sequentially from each original package directory using its npm configuration. Independent uploads continue while earlier submissions are verified. Required new dependency releases must verify at a compatible version before their consumers upload; an unverified or failed dependency blocks only those consumers. The command waits for every submitted package and its publication hooks before returning. A version already containing the identical artifact is skipped; different content at that version fails. Authentication or network failures do not mean a package is absent. The workflow saves a private upload receipt before submission. For an accepted or uncertain upload, the workflow starts bounded registry checks until publication is verified, cancellation is requested, or its verification deadline expires. The deadline begins at submission and includes waiting for a verification slot. Existing receipts are monitored alongside independent work. It never submits the upload again automatically. The default wait is twenty minutes per package; `--verify-timeout 1800` allows thirty minutes. Progress shows elapsed time and the next check.

Nothing can unpublish a package automatically. A cancellation during upload may leave an unresolved release; a later retry checks the registry again. npm may scan new uploads for several minutes before they become available. The workflow checks package version, identity, registry tarball integrity, and the exact compressed tarball digest saved at submission before marking it published. These checks apply to new uploads and recovered receipts. If monitoring times out, rerun the workflow or retry its report to resume the same checks against the saved receipt, without another upload. Existing receipts are monitored in check/plan mode too. If the upload never appears, inspect the retained logs and npm status before deciding how to recover. New-upload publication hooks run after confirmation in a restored copy of their complete prepared workspace, including generated and unpacked files, sibling state, and copied external resources. Preparation hooks are not replayed. Only one full publication-hook workspace runs at a time. A hook failure remains a warning on a verified publication and makes the run exit nonzero. Hooks deferred by a timeout or cancellation and later receipt recovery require manual review. Lifecycle hooks are trusted code, not sandboxed code, and scripts with explicit absolute paths can still write outside their temporary workspace.

## Troubleshooting

- Browser approval: approve in the Chromium-based browser opened on the system. An expired challenge or ten-minute timeout requires a fresh attempt. Install a supported browser if none is found.
- Verification timeout: the upload is still unverified. Rerun the workflow to resume monitoring, or increase `--verify-timeout` for a slower registry. Do not delete its receipt or manually republish while its outcome is uncertain.
- Sign-in failure during publication: run `/release-npm-setup` or npm login for the configured registry. Disabling the sign-in check does not grant permissions.
- Missing Pi resource or bundle: inspect the package log, ensure the resource is included in the published files, and repair dependency preparation before retrying.
- Unexpected skip: check private/exclusion settings and the actual packed content. Version-only changes do not require publication.
- Blocked dependent: include and repair the required dependency release, or use a compatible already published version.
- Slow cold run: comparison packs artifacts; hooks, bundles, local dependencies, and full repository context may require more work and may bypass cached comparisons. Full-context jobs share one captured repository and run serially to bound storage.
- No space left on device: check free space where workspace scratch and the npm cache live. Avoid setting `XDG_CACHE_HOME` to a small tmpfs. A normal failure removes its scratch automatically; inspect abandoned directories only after confirming no release is active.
- Report root mismatch: use `--root` for the original workspace. Reports cannot be transplanted to another checkout.
- Abort: inspect final outcomes and retained logs before retrying; previously verified publications remain published.
