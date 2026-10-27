# Large-scale path

Read this when the assessment in [SKILL.md](../SKILL.md) classifies the migration as large-scale. The numbered steps still apply. This file adds the mechanics that a single-session, single-worker port can skip: a dependency map, cycle breaking, dependency tiers, a survey-build loop, build ownership, worker isolation, resource bounds, and records that let another session continue.

Whole-application rewrites are large-scale by default. The skill ships no executable tooling for this path. The agent creates the helpers listed below inside the target project or a scoped workspace, verifies each against the acceptance criterion given, and treats them as project code: reviewed, versioned, and documented.

## When this path applies

Any one of these signals is enough. The thresholds are defaults; the contract may set others.

| Signal | Default threshold |
| --- | --- |
| Source inside the boundary | more than about thirty thousand lines, or more than about fifty translation units |
| Dependency graph | cycles at package or crate granularity |
| Workers | more than one worker writing at a time |
| Sessions | the work will not finish in a few sessions |
| Targets | more than one platform family must pass |
| Frameworks | the source relies on a framework that Rust must replace or bridge |

## Helpers to create per project

Each helper is small, repository-specific, and verified before use. Write them in a language the project already has (shell, Python, or Node.js), keep them under the migration records directory or the project's tooling directory, and record their location in the contract.

### Dependency map

Output: every unit inside the boundary with its imports, at two granularities: source unit (file or module) and proposed Rust crate. List every cycle with its members. Emit a deterministic leaves-to-root order.

Acceptance: every unit appears exactly once; cycles are enumerated, not hidden; two runs on the same tree produce identical output; a known cycle planted in a scratch copy is reported.

### Manifest and queue

Output: the manifest in [RECORDS.md](RECORDS.md), built from the map. The queue is every manifest row whose state is `pending` or whose output is missing on disk. A status command prints counts per state, per tier, and per kind.

Acceptance: stopping is free and resuming is re-running the status command; a row never advances a state without its `checks` and `log` columns filled; the row for a planted fake output file is reported as inconsistent.

### Build owner

Output: one process per integrated tree runs builds and tests. It writes numbered logs tagged with the revision or content fingerprint that produced them. Workers never run the build tool in a shared tree; they read the latest log and cite its number.

Acceptance: every log carries its revision; a worker that repairs against a log older than the current tree is told so; two concurrent build requests serialize instead of colliding.

### Guardrails

Output: a deny-list of commands for worker contexts. At minimum: `git stash`, `git reset`, `git checkout --`, `git clean`, history rewrites, package installation, network access unless the build needs it, and the build tool when a build owner exists. Enforce the list with the harness's permission system when it has one; otherwise write the rules into every worker prompt and have reviewers check for violations.

Acceptance: a worker that attempts a denied command fails visibly and the attempt is logged.

### Resource bounds

Output: limits on memory, CPU, process count, disk, and command duration for builds and tests, using facilities that exist on the machine (cgroups through `systemd-run`, `ulimit`, container limits, or test-runner flags). A disk watch that stops scheduling new builds below a threshold. One build directory per worktree, or a shared cache such as `sccache`, decided before parallel work starts.

Acceptance: a test that allocates past the limit is killed and reported, not left to take the machine down; disk usage is reported in every status run.

## Dependency map, cycles, and tiers

1. Build the map before writing the manifest. Inspect shared types, generated code, and conditional compilation; they create edges the import list does not show.
2. Break cycles as explicit work units of kind `cycle-break`. Options, in order of preference: move the shared types into one home module; split a unit so the cyclic part stands alone; replace a cyclic call with a trait or callback owned by the lower tier; accept one crate for an entire strongly connected component when splitting costs more than it saves. Record the before and after map for each cycle-break unit and re-run the map to prove the cycle is gone.
3. Assign tiers from the acyclic map, leaves first. A unit's tier is one more than the highest tier it imports.
4. Port one tier at a time. Keep higher tiers gated out of the build until every dependency compiles. Ungating a tier means adding it to the build and running the survey build described below.
5. Shared types get a canonical home module recorded in the rulebook. Two workers must never define the same type.

## Survey-build loop

Use this loop when units cannot compile individually because their dependencies are still in the source language or still gated.

1. Translate the whole tier. Workers do not run the compiler; they follow the rulebook and the inventory.
2. The build owner runs one survey build for the tier and writes the error log.
3. Slice the log by crate and module, leaves to root. Each slice is a repair unit with the log number in its `log` column.
4. Fixers repair from their slice without running the compiler. They cite the log number and the rulebook rule they applied.
5. Re-survey. Repeat until the tier builds clean.
6. A failure class that appears three times across slices is a rule defect. Stop repairing instances and queue a rulebook amendment, which ends the current batch. Apply it under D-PROC-01, bump the rulebook version, and regenerate the affected slice in the next batch.

When the target's type check is cheap enough, let workers run it on their own unit and skip the slicing; keep the build owner for integrated builds and tests.

## Placeholders at scale

Isolated port tiers may carry placeholders so a tier can build before every body is ported. Every placeholder is a tracked debt entry:

- Use `todo!("MIG-nnn: ...")` with the source location, never a dummy return value.
- End every ported file with a trailer `// PORT STATUS: confidence=<high|medium|low> todos=<n>`. Reviewers compare `todos=` with the actual marker count; an undercount is a finding.
- Burn down placeholders before ungating the next tier that depends on them. A tier whose placeholders are hidden behind a green build is not done.
- Before acceptance, a search for `todo!`, `unimplemented!`, and `MIG-` markers must return nothing in release code.

## Review topology

Per unit: one implementer, two reviewers in separate contexts who see only the source unit, the diff, the rulebook, and the inventory rows, and one fixer who resolves findings. Reviewers never see the implementer's narrative. A finding names a source location and a rule or an observed behavior. A long justification comment next to a workaround is itself a finding: the code is wrong, not under-explained.

If independent contexts are unavailable, run one separate review pass per unit and state the limitation in the manifest.

## Benchmarks per tier

Record the benchmark baseline on the pilot units before scaling. Run the benchmarks from the contract after every tier ungates. A regression beyond the budget blocks the tier like a failing test. Added copies across interop boundaries are the usual cause; measure them instead of assuming. In an incremental replacement, a regression that measurement attributes to glue may run under a transitional budget recorded in the contract until the neighbouring units move; that budget becomes blocking when the tier that holds the neighbouring units ungates, or at acceptance, whichever the contract names.

## Source parity

Under D-SCOPE-04 with tracking, update the parity ledger from [RECORDS.md](RECORDS.md) at every batch boundary: each source commit after the pinned revision is `present`, `missing`, `partial`, or `inapplicable` in Rust, with evidence. Reconcile the ledger to the source head or the freeze revision before acceptance. A successful Git merge does not establish parity.

## Worker isolation

- Assign disjoint write ownership per worker or give each worker its own worktree. Workers sharing a worktree share the Git index; stage only intended paths and never stash.
- Separate worktrees still need separate build directories or a shared cache; decide this in D-PROC-03.
- Serialize changes to shared files (the rulebook, the manifest, home modules for shared types) through one owner.
- Keep repository hooks and protections in place; workers do not disable them.

## Continuation across sessions

On resume:

1. Read the contract, the rulebook version, and the manifest. Do not trust the previous session's summary.
2. Run the status command. Compare manifest fingerprints against the working tree; rows whose source or target fingerprint changed go back to `drafted`.
3. Read the latest build log number and its revision. A log from another revision is stale.
4. Continue from the queue. Retain unresolved findings; do not repeat completed checks without a relevant change.

## Stopping rules

Stop the affected work, preserve evidence, and report when any of these holds:

- The same failure persists after the bounded number of repair rounds in the contract.
- The spending cap from D-PROC-05 or the approved estimate from D-BUDGET-01 is reached.
- Disk, memory, or build time crosses the bounds in the contract.
- A rulebook amendment is queued and the next batch depends on it.
- A decision in the catalogue is still open and the next batch depends on it.

Continue independent work when possible. Escalate the concrete decision with its evidence instead of lowering acceptance criteria or widening unsafe.
