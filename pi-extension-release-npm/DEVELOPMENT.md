# Development guide: Release npm for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Implementation boundaries

The canonical release coordinator lives in `release/` and uses only Node standard-library modules. `dev/scripts/release-workflow.sh` calls this implementation with the repository root as its default. The bundled `release-workflow.sh` calls it with the caller's current directory as its default. Both honor `PI_NPM_PACKAGES_ROOT` and the CLI's `--root`. Do not copy coordinator logic back into shell wrappers.

| Module | Responsibility |
| --- | --- |
| `release/engine.mjs` | Discovery, independent package jobs, preparation, dependency ordering, upload and verification |
| `release/artifact.mjs` | Bounded gzip/tar reading, artifact identity and normalized comparison |
| `release/workspace.mjs` | Isolated copies, symlinks, and linked-worktree Git context |
| `release/process.mjs` | Bounded child commands, launcher use, parsing, retained logs and cancellation |
| `release/auth.mjs` | Chromium discovery/launch, validated npm browser challenges and bounded approval polling |
| `release/batch.mjs` | Cancellable verification probe slots shared by monitoring and occupancy checks |
| `release/checkpoints.mjs` | Private content-addressed full-workspace checkpoints for publication hooks |
| `release/monitor.mjs` | Bounded registry polling, backoff, transient errors and deadline/cancellation propagation |
| `release/uploads.mjs` | Private upload receipts and exact tarball digest verification |
| `release/versions.mjs` | Supported stable dependency ranges |
| `release/cli.mjs` | Argument/config validation, root resolution, retry selection, signals, rendering, report persistence |
| `release/terminal.mjs` | Fixed viewport, selection/filter/detail state and terminal cleanup |
| `release-records.ts` | Final-record parsing and Pi summaries |
| `compact-release-output.ts` | Structured progress rendering with legacy shell-output fallback |
| `index.ts` | Pi setup, selection, confirmation, one confirmed publish invocation, logs and abort UI |

The older bump/readiness/publish/comparison shell helpers remain standalone compatibility tools. The coordinator does not invoke them. Their fixture tests remain only where they test a retained entry point, such as npm pack JSON compatibility.

## Engine contract

```js
import { runRelease } from './release/engine.mjs';
const { records, counts, exitCode, report } = await runRelease({
  root, mode: 'plan', targets: ['pi-utils', 'pi-extension-release-npm'],
  publisher: 'npm', access: 'public', strictAuth: false, concurrency: 4,
  refresh: false, exclusions: ['pi-extension-gui-testing'],
  signal, onEvent,
});
```

`targets` is an array of paths or `all`. Optional `cacheDir` and `logDir` customize engine storage. `verifyTimeout` sets the verification window in seconds, default 1200, positive and at most 86400; CLI values must be integers. Defaults are documented in the technical reference. The engine canonicalizes roots and rejects targets escaping them. Private and excluded records finish as skipped. Global setup/cleanup errors reject the invocation; package failures return final records and let independent packages finish.

The engine never writes stdout or sets the process exit code. It emits immutable snapshots with `target`, `name`, `version`, `oldVersion`, `status`, `stage`, `detail`, `action`, and `logPath`. Package names/versions may be null when scanning fails. Stages are `scan`, `compare`, `prepare`, `validate`, `dependency`, `authenticate`, `publish`, and `verify`.

Final statuses are `unchanged`, `skipped`, `ready`, `published`, `processing`, `failed`, `blocked`, and `cancelled`. `ready` is also transient during publish. Transient statuses include `pending`, `running`, and `candidate`; registry monitoring stays running until confirmation, timeout or cancellation. Actions are `error`, `skip`, `publish-first`, and `publish-update`. Never treat a publish-mode ready event as a terminal outcome.

Records add `directory`, `localVersion`, `candidate`, `cached`, `published`, `warnings`, and an optional selected `client`. Counts contain `total`, overlapping `candidates`, and one count for each final status. Final status counts sum to total. A post-publication hook failure can leave the package status published and the run exit code nonzero.

Reports use `schemaVersion: 1`, run `id`, canonical `root`, `mode`, `publisher`, `access`, ISO timestamps, `logDir`, `records`, `counts`, `exitCode`, and `warnings`. They omit temporary workspaces, command output, credentials, and internal references. CLI report writes use an exclusive private temporary file in the destination directory, then rename. Retry validation requires the matching canonical root and valid in-root targets; only failed/blocked/cancelled/processing targets enter a new engine call.

## Artifact and publication invariants

Comparison uses complete npm tar artifacts, including generated files, binary bytes, additions, deletions, and executable flags. Manifest normalization ignores only the top-level version. The stable next-version rule rolls patch 9 to the next minor `.0`; a higher local version is reduced when content changes.

The comparison cache includes source bytes/modes, ancestor configuration/manifests/lockfiles, runtime/client identity, registry version/integrity, and relevant environment. Results are persisted only when the compared snapshot fingerprint and copied configuration match the key inputs. A failed cache revalidation discards the key without discarding a completed artifact comparison. Dirty files matter. Hooks, bundles, local dependencies, and nonregular inputs conservatively bypass lookups. Registry queries are reused within a run but refreshed across invocations and before publication verification. Default and scoped registry configuration are queried together with npm's own resolver; multi-key `config get` uses key=value lines even with `--json`. An explicit publishConfig registry avoids that configuration subprocess. Missing integrity bypasses cache. Metadata accepts a single manifest object or npm 12's array result, with validation at the boundary. The latest lookup explicitly overrides npm's configured default tag. Package-level E404 establishes absence; missing tags, auth/network/JSON errors fail the package.

Only candidates prepare dependencies and run publication validation. All lifecycle/bundle preparation uses temporary workspaces in every mode. Hooks/local dependencies can require repository context, siblings, installed modules, and isolated Git metadata. Existing bundle trees are copied; missing bundles install with scripts disabled, no saved dependencies and no lock writes. Candidate/sibling planned versions are applied only within workspaces. Packed Pi resources must exist.

Publication uploads the exact validated tarball. Full-context jobs share one immutable captured repository per context root. Each comparison or preparation starts with an independent working clone of that snapshot; comparison output is removed before candidate preparation. Missing bundles are restored before comparison hooks run. `prepublishOnly` runs before isolated comparison packing, so changed build inputs cannot hide behind stale generated files. Candidates run it again after assigning the planned version in a fresh workspace; comparison-hook output cannot enter the final tarball. Pack uses its normal lifecycle; resource declarations and their shapes are validated from the packed manifest. `publish`/`postpublish` run explicitly after registry confirmation with automatic script expansion disabled. For those hooks only, `WorkspaceCheckpoints` captures the whole workspace and external roots after preparation, then the working copies are removed. Content-addressed blobs deduplicate state between packages. Opaque handles and package-relative restore paths stay in a private map. One promise chain restores one full hook workspace at a time, runs explicit hooks once, and removes it before the next restore. Preparation hooks never replay during restoration. Definitive published progress precedes hooks; hook failures leave that result published with warnings and a nonzero exit. The source manifest version is written only at upload, after checking that scanned source metadata has not changed. Hooks and bundled dependency preparation do not run in the source tree. Absolute-path side effects in trusted hooks remain outside isolation guarantees.

Selected dependencies needing an unpublished version create ordering edges. Published-compatible dependencies do not block independent updates. Unsupported/unsatisfied unpublished ranges and cycles fail explicitly. Comparison and candidate preparation use the configured pool with at most one full-context job. Every eligible candidate finishes validation before the first upload or approval. Uploads remain sequential in dependency order, while independent receipt monitors overlap them. The scheduler waits for definitive dependency verification and a fresh compatible registry-range lookup before submitting a consumer. Cycle detection and check/plan dependency ordering remain explicit. Each ready candidate retains only an artifact path and compressed SHA-512 digest; occupancy checks lazily parse the prepared file and permit normalized equality. Parsed artifact maps and compressed buffers are released after validation.

Exact-version occupancy and artifact checks prevent conflicting or duplicate publication. Upload runs from the original package directory with npm using the validated tarball and `--ignore-scripts --json --auth-type web`, plus pinned default/scoped registry arguments. Dry-run validation also disables automatic publication scripts. An EOTP response supplies `authUrl` and `doneUrl`. The latter must use HTTPS on the configured registry origin. The workflow opens the former directly in an installed Chromium-family browser, polls the completion endpoint for up to ten minutes, and retries the same tarball with the short-lived OTP in child environment variables only. Approval tokens never enter arguments, reports, logs, or npm configuration. Authentication rejection clears the unsent receipt. Publication never falls back to Bun. The registry may remember a browser-selected five-minute grant; the engine neither selects nor caches that grant. Every EOTP still requires a same-registry completion challenge and its token is used only for that package retry.

Before each upload, the engine atomically stores a private schema-1 receipt under `cacheDir/uploads/`, keyed by registry and package name. It records version, action, SHA-512 of the compressed validated tarball, timestamp and deferred hook names. Success or ambiguous upload starts receipt-backed monitoring with an immediate fresh artifact check, then backoff from ten to thirty seconds for up to twenty minutes by default. Waiting progress stays `running` at stage `verify`. The deadline starts when that upload attempt is submitted, including command duration and verification-slot queue time. `verificationSlots` limits active probes to `--concurrency`, including occupancy probes; queue cancellation removes entries before they run. The combined deadline/user signal reaches both registry lookups and remote tarball commands; sleeps are cancellable too. New and recovered receipts both require registry integrity, exact version/identity and the submitted compressed digest, rather than normalized content equality. E404 and transient transport/429/5xx errors retry, while auth/metadata/integrity/content failures stop. A timeout becomes final `processing`, with the receipt retained. Per-attempt verification tarballs are removed promptly. Every later invocation checks and monitors the receipt before comparison or upload, verifies version, registry integrity, identity and the original tarball digest, then removes it only after confirmation. Corrupt or conflicting receipts fail safely without resubmission. Persistent registry transport errors can exhaust the window and leave the upload unverified. Final processing sets exit code 1; required consumers still block until their dependency is confirmed. Recovered receipts warn that deferred publication hooks require manual review, because a later invocation has no original checkpoint. No live registry behavior is assumed from mocked tests.

Registry/auth/config timeouts are 30 seconds, installs 180 seconds, and other commands 120 seconds. npm internal fetch retries are disabled. Command parsing captures at most 4 MiB; complete output goes to retained package logs. Abort/timeout sends process-group TERM followed by bounded KILL on Linux. Engine npm/bun child commands use `~/.local/bin/t3-build` when installed and never bypass a failed launcher.

Scratch roots use XDG_CACHE_HOME or the user cache directory rather than `/tmp`. Snapshot traversal admits at most 16 filesystem jobs. Regular files use exclusive `copyFile` with `COPYFILE_FICLONE`, preserving source isolation and falling back to copying when reflinks are unavailable. File modes and timestamps are restored explicitly, followed by directory modes after link relocation. Copy traversal records symlink paths, so relocation does not walk the complete copied tree a second time. Failed copies drain all active jobs before cleanup. Snapshot destinations must be fresh; existing regular files are never overwritten. A per-invocation context promise prevents duplicate repository captures. The bounded scheduler admits at most one full-context job while allowing ordinary packages to use the remaining worker slots. Queued context jobs do not occupy those slots, and the total job count still respects the configured concurrency. Comparison cleanup releases working copies and local/remote tarballs promptly; plan/check cleanup releases prepared artifacts immediately. Publish preparation removes working copies after capturing needed hook state, retaining validated tarballs until submission; receipt monitoring then needs no local artifact. Probe destinations belong to their probes, so package cleanup never removes an active probe directory. Unexpected orchestration failures abort owned work; final cleanup drains monitors and the hook queue before deleting shared scratch. Earlier definitive events and uncertain receipts survive cancellation. Final cleanup removes the shared context and all remaining scratch. Agent `handoffs` directories are excluded from snapshots and fingerprints; untracked release inputs such as patch assets remain included. Never substitute hardlinks for reflinks or retain a full snapshot for every package.

## CLI and Pi output contracts

Non-TTY/`--plain` output emits `RELEASE_NPM_PROGRESS <JSON>` for engine snapshots and one `RELEASE_NPM_EVENT <JSON>` per final record. Legacy outcomes map unchanged/skipped to skipped, failed/blocked/cancelled to failed, and preserve ready/published/processing. `originalStatus` preserves the engine result; remaining record fields, including log paths and warnings, remain available. The readable final summary is for people, not parsers. It shows aligned counts and grouped package outcomes, keeps failure stages/details and processing uncertainty visible, puts log paths on their own lines, and gives a next step for processing uploads. Non-TTY final events remain one per record; per-package readable lines are replaced by this grouped summary. Zero optional counts and unchanged package lists are omitted. Child command output never enters these records.

`--json` suppresses all progress, legacy events, and readable summaries, writing one JSON report to stdout. Global/parse errors emit a JSON error object with `schemaVersion`, `error`, and `exitCode`. Report-write diagnostics go to stderr and change the CLI exit code; JSON stdout retains the engine's package outcomes. `--help` returns before config loading or engine invocation. The obsolete `--check-alt-client` flag produces an explicit diagnostic, rather than being ignored.

`parseReleaseRecords()` reads final events and definitive `published` or `processing` progress from the `verify` stage, preserving verified uploads before batch completion or a truncated final line. The engine emits that progress before post-publication hooks. Transient readiness never counts as an upload. Pi uses structured ready records to build the confirmation list, including exact target paths. Legacy `Plan summary:` and readable publish parsing remain fallbacks. A checkout wrapper is used only when its local coordinator exists; otherwise Pi uses its bundled coordinator. Mixed preflight failure does not suppress healthy candidates. Pi sends the confirmed list through one `--publish --targets-json` command to preserve literal paths and dependency ordering. Singular `--target` never splits a path on commas. It parses outcomes before considering the command's nonzero/aborted result and includes earlier preflight failures and retained upload outcomes in the final summary.

Dependency validation also checks omitted workspace packages against their declared registry range before allowing a consumer into the ready set. A provisional bundle difference is compared again after missing bundles are restored. Exact-version occupancy is checked before the publication dry-run, so npm's immutable-version check cannot reject an identical already-uploaded artifact. Windows npm commands resolve `npm-cli.js` and invoke it through Node without a shell. Command errors expose a category, never copied child stderr; detailed logs are created privately.

The compact renderer consumes interleaved progress/final events by target. Its legacy parser still recognizes package headers, version/action lines, readiness results, publication lines, errors, and `Release progress:` phase records. Changing retained helper formats requires keeping that fallback compatible.

## Terminal and Pi UI internals

The standalone renderer owns an alternate-screen viewport, raw input, a 100 ms redraw timer, and a resize listener. One map entry per target prevents duplicate rows. Filters select all, changed/error, or error records. Navigation clamps selection and changes pages; Enter opens details with the trailing 64 KiB of the retained package log. Rendering strips control sequences, bounds row/column counts, and restores the previous raw mode and input flow, cursor and alternate screen on completion, cancellation and invocation failure.

Pi uses `publish-picker.ts` for preflight selection and two-pane confirmation. Git marks come from NUL-delimited `git status --porcelain=v1 -z`, respecting `git rev-parse --show-prefix` and rename/copy source paths. Git failure marks nothing. RPC clients use paged `ctx.ui.select()` choices; terminal height determines page size with a minimum of three and a default of twelve.

Pi's fixed-size capturing output overlay in `release-output-overlay.ts` avoids the ten-line widget cap. Focus follows the compact view's active package while the footer pins counts. Manual scrolling stops following; End resumes it. Hiding returns focus to the editor. Outside TUI mode widgets retain compact/expanded output. Keyboard handling uses pi-tui matchers and ignores release events. UI cleanup removes subscriptions/timers and closes overlays.

`runScriptLive()` retains process-tree abort support. On Windows it writes an MSYS PID file, signals that process group, and performs a bounded kill fallback because Windows parentage can hide Git Bash children. On Linux the shell process group receives SIGINT and a later SIGTERM fallback. Saved Pi logs remain managed through pi-utils; per-package engine logs are referenced by path.

## Verification and packaging

Run all checks through the host launcher when installed:

```bash
~/.local/bin/t3-build npm test --prefix pi-extension-release-npm
~/.local/bin/t3-build npm pack ./pi-extension-release-npm --dry-run --json --ignore-scripts
~/.local/bin/t3-build node --test dev/scripts/package-publishable-changes.test.mjs
git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'
```

The package test script includes every `tests/*.test.mjs` file, including W1 engine tests, CLI/renderer integration, actual wrappers, Pi partial success/confirmation, reports/retries, bundles/hooks in temporary workspaces, legacy compact output and process-tree tests. The interface fixture's npm client has no network implementation. Engine tests cover comparison caching, dependency ordering, occupancy, ambiguous uploads, delayed registry visibility, receipt recovery, browser approval and child termination. Real npm operations only pack disposable local fixtures. No test authorizes actual registry publication or a real dependency installation.

`tests/release-terminal.test.mjs` uses util-linux `script` for PTY success/cancellation/exception restoration and natural process exit and reports a skip if unavailable. The mock viewport test exercises 96 rows, filters, details and resize. `tests/release-pi.test.mjs` loads the real extension with stubbed Pi utilities and a local mock workflow, verifying a nonzero mixed preflight, explicit confirmation, one multi-target invocation, full partial failure summaries, cancellation before upload, abort after a confirmed publication, and incomplete subprocess outcomes.

The older copied-shell workflow fixtures were replaced because the wrappers now require the canonical `release/` modules. The new tests exercise the actual wrappers/engine rather than asserting removed helper implementation details. `tests/npm-pack-json.test.mjs` continues to cover the retained bump helper's npm JSON shapes. The root comparison-helper suite also remains relevant to those compatibility entry points.

The npm `files` list must include `release/`, `release-records.ts`, all imported Pi helpers, the shell compatibility scripts, and all three documentation layers. W2 adds no runtime dependency or first-party export. Its scheduler, approval-grant, receipt-digest and restored-hook regressions are in `tests/release-engine.test.mjs`; `tests/release-batch.test.mjs` checks slot bounds, queued deadlines, cancellation and recovery after probe errors. `tests/release-checkpoints.test.mjs` covers checkpoint storage independently. Preserve the operator-managed extension version `0.5.2` and `@firstpick/pi-utils` range `^0.3.2` while integrating this work; publication/version management is owned by the release operator.


### Batch review invariants

Required dependency ranges and bundled-package gates come from the validated packed manifest after preparation. A range lookup cannot replace artifact verification when its match is the selected unresolved candidate or retained receipt version. Independently published compatible versions still satisfy existing ranges.

Hook checkpoints restore their original workspace/external paths after preparation/upload cleanup relinquishes those paths. This preserves Git core.worktree and hook-generated absolute paths. Restores and publication hooks remain serialized. Owned-tree cleanup retries restrictive directory modes without walking symlink targets, including the final scratch cleanup. Same-root restoration reuses the exact captured symlink text. Relocation preserves trailing directory requirements and failed traversal through missing components. It follows target metadata only to identify root re-entry after symlink traversal, while captured file contents never follow symlinks.

Definitive publication and hook scheduling precede receipt deletion. A deletion failure retains the publication, adds a sanitized cleanup diagnostic, and makes the run nonzero. Checkpoint capture/restore failures write raw filesystem diagnostics only to the private package log; public records include the operation and error category.
