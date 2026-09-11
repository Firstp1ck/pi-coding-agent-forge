# Development guide: Code Quality

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Release status and contract ownership

This document is the shipped scanner contract that replaces implementation detail from the planning design. It defines what implementation and tests must preserve. It is not a final-release claim: scanner integration acceptance remains pending the parent-owned serialized runtime fix and revalidation pass. In particular, contributor acceptance must not treat the contract as proof that all destination validation, saved-report validation, deadline/cancellation, adapter-failure, or human-summary requirements have passed.

The package remains dependency-free for Git-only operation. It has no version bump and no runtime dependency for optional analyzers. The package must not install, download, upload, publish, configure Pi, commit, stash, reset, or modify a reviewed repository as part of scanner operation.

### Available, partial, unavailable, and deferred work

| Area | Status | Contractual result |
| --- | --- | --- |
| Git-backed capture, physical lines, direct npm dependency changes, source-free reports | implemented, pending final integration acceptance | Report evidence with capture coverage and explicit limits. |
| Current-only snapshots and compatible saved-report comparison | implemented, pending final integration acceptance | Compare current physical totals only; do not invent edit churn. |
| ast-grep pattern candidates | optional and partial | Windows x64 pin only, explicit trusted executable, scanner-owned rule and frozen input. Empty output is still partial. |
| jscpd token-clone evidence | optional and coverage-dependent | Windows x64 pin only, explicit trusted executable, scanner-owned settings and frozen input. |
| Callable complexity, analyzer-defined SLOC, callable trend deltas, erosion, verbosity proxy | unavailable | Never infer, estimate, or report a clean zero state. Pure fixture algorithms do not enable live scanner measurement. |
| POSIX-specific pathname, process-tree, and analyzer behavior | deferred | No POSIX support claim until separately verified. |
| Automatic lifecycle hooks, watchers, CI enforcement, automatic refactoring, history databases, generic plugins, full benchmark recreation, dependency graphs, and universal scoring | deferred | Do not add them through this package. |

## Package layout and publication boundary

Runtime content belongs under `skills/code-quality`; contributor tests remain at the package root. The package contains the skill workflow, references, scanner entry point, collection/report/metric modules, optional adapter modules, and packaged AST rules. Test fixtures, evaluation scenarios, and routing fixtures are development-only.

The npm `files` allowlist is exactly:

```json
["skills", "README.md", "TECHNICAL.md", "DEVELOPMENT.md", "LICENSE"]
```

npm may include package metadata automatically. It must not include contributor tests, evaluation data, source fixtures, temporary reports, or other development-only artifacts. Package installation must retain the skill's relative script, rule, and reference paths.

## Scanner interface contract

The scanner is a Node command-line program at `skills/code-quality/scripts/scan.mjs`. It is not a Pi extension, registered tool, or new slash command. It accepts only argument arrays through the Node process; no shell interpolation, implicit configuration, or analyzer discovery is permitted.

| Operation | Required options | Allowed optional options |
| --- | --- | --- |
| `scan` | `--base <commit>`, one or more `--scope <root>` | `--include-untracked`, `--format json|human`, `--out <new-report>`, `--git <trusted-path>`, `--ast-grep <trusted-path>`, `--jscpd <trusted-path>` |
| `snapshot` | one or more `--scope <root>` | the same current-capture options except `--base` |
| `compare` | `--before <saved-report>`, `--after <saved-report>` | `--format json|human`, `--out <new-report>` |

The default format is human. Capture operations require explicit scope, and Git comparison requires an explicit baseline. Resolve a chosen Git baseline to one commit identity before collection; never assume or fetch a branch such as `main`, and never re-resolve a moving ref during a scan. `compare` reads only validated saved reports and does not rerun collection or analyzers.

Exit `0` means a report was produced. Exit `2` means invalid options, unsafe saved/output input, or a collection/analysis failure. Diagnostics must use stable redacted categories rather than source, absolute private paths, environment contents, or full tool stderr.

`--out` is optional and create-only. Without it, the scanner writes no persistent report. A requested report path must be outside selected source scope, must not replace an existing file, and must have a safe non-symlink ancestor chain. Output validation must canonicalize Windows and POSIX forms before checking containment. This is a release requirement; final implementation acceptance is pending the recorded runtime fix and revalidation.

## Capture, baseline, and Git contract

### Scope and baseline semantics

A Git `scan` considers eligible staged and unstaged worktree content together. `HEAD` is a review baseline, not proof that all dirty work belongs to the current task. The skill workflow must record dirty-start attribution and say when S0 was unavailable. Explicit untracked inclusion is opt-in. Index-only comparison, ignored-file inclusion, implicit submodule traversal, and global-exclude discovery are unsupported.

Analyze the same normalized selected roots on both sides, including unchanged neighbors needed for clone detection. Additions and deletions remain additions and deletions. Exact-content rename records are a separate policy and do not make added or removed callables appear as zero-valued changed callables. Snapshot comparison may compare compatible current observations, but edit churn is unavailable outside a frozen Git scan.

Classify paths using an ordered, versioned policy: explicit user category override; safety artifact/vendor rule; test rule; documentation rule; known-source production rule; then `uncategorized`. Initial safety exclusions include nested `node_modules`, `vendor`, `dist`, `build`, `coverage`, and minified files. Tests, documentation, production, and uncategorized inputs retain separate counts. User categorization cannot override safety exclusions. Excluded and never-enumerated populations need bounded accounting or `unknown`, never invented zero counts.

### Raw source collection

Git metadata must use byte-oriented NUL-delimited forms. Do not split path records on whitespace or newlines, and do not rely on quoted Git path output. Resolve and use a trusted Git executable with argument arrays. Sanitize inherited Git injection, alternate repository/index selections, external diff, trace variables, global/system configuration, optional locks, lazy fetch, replace objects, prompts, pager, system attributes, and external attributes. Preserve legitimate repository and worktree metadata; do not bypass ownership checks with a global safe-directory setting.

Read tree blobs through one persistent raw `git cat-file --batch` process with object IDs. Parse declared byte lengths, do not enable filters or text conversion, and fail a missing object locally. Never use `git archive`, live worktree `git diff`, checkout, or `hash-object --path` as a substitute for raw capture.

Compute numstat in a scanner-owned frozen before/after directory with `--no-index`, `--numstat`, `-z`, `--no-ext-diff`, `--no-textconv`, `--diff-algorithm=myers`, `--no-indent-heuristic`, and `--no-renames`. The isolated diff must disable repository attributes and conversion. Treat diff exit `1` as differences, not tool failure. Preserve raw bytes, CRLF, and missing final newlines.

Exact-content rename detection groups captured SHA-256 identities of eligible removed and added paths. Record a rename only for an unambiguous one-to-one group. Duplicate-content ambiguity remains added and removed, and category moves are preserved.

### Current capture and stability

For every selected regular file, retain bounded bytes once with identity, byte count, SHA-256, category, language, and capture source. Reject symlinks, junction escapes, submodules, devices, special files, unreadable eligible paths, invalid encodings, sparse/skip-worktree inputs without established support, and unmerged index stages as incomplete evidence. Do not follow paths outside the selected repository.

Immediately re-enumerate and rehash the same inputs, index identity, and frozen eligibility inputs. Detect membership, type, content, index, or ignore-policy changes. Discard an unstable attempt and recollect only once if the shared deadline permits. A second mismatch, unreadable comparison input, or exhausted deadline produces `inconsistent` coverage and no trend conclusion. Capture is best effort, not atomic; a modification restored between observations can evade detection and must not be claimed impossible.

Every analyzer receives only scanner-owned frozen materializations. Verify those bytes after each analyzer. A tool that modifies frozen input invalidates the capture and stops later analysis. Delete only scanner-owned temporary directories.

## Resource and execution contract

One monotonic 60,000 ms deadline includes enumeration, both possible capture attempts, hashes, raw blob reads, analyzers, report creation, termination, and cleanup. Reserve 3,000 ms for cleanup. Each subprocess receives the smaller of 20,000 ms and remaining work time.

| Limit | Value |
| --- | ---: |
| Selected paths | 5,000 |
| Retained source bytes | 64 MiB |
| Bytes per file | 2 MiB |
| Analyzer stdout | 8 MiB |
| Retained stderr | 64 KiB |
| Divergence examples | 20 |
| Analyzer concurrency | 1 |
| Analyzer retries | 0 |
| Capture recollections | 1 |
| Git subprocesses | 23 |
| Total subprocesses, including termination helpers | 40 |
| Saved report bytes | 4 MiB |
| Saved-report validation depth / nodes | 32 / 100,000 |
| Compatibility differences | 20 |
| Contributor and metric rows | 1,000 |
| Human contributors | 20 |

Timeout, cancellation, spawn error, output ceiling, malformed batch framing, close/abort failure, and failed termination must be bounded and observed. An analyzer runs only after Windows tree-termination capability is checked. Do not retry analyzers. Report unfinished work as partial or unavailable rather than multiplying timeouts. Final acceptance is pending the recorded full CLI deadline/cancellation and adapter failure-path integrity corrections.

## Optional analyzer contract

No adapter is found implicitly or installed. An adapter accepts only a direct trusted executable outside the checkout, resolves it once, validates its exact expected version and SHA-256, uses scanner-owned configuration, runs offline with poisoned proxy variables, and uses no shell, `.cmd` shim, `npx`, `npm exec`, `pipx`, `uvx`, or install-capable wrapper.

| Adapter | Pinned Windows x64 contract | Persisted result |
| --- | --- | --- |
| ast-grep | 0.45.3, executable SHA-256 `daff0f5963faab7617045833132a3538c85eee65f3afeedf347f829a7b8d83fb`; MIT evidence in the retained probe | Packaged direct JavaScript/TypeScript `console.log` and Python `print` rules. Keep only rule/version, relative path, range, language, severity, and message. Parse completeness is unestablished, so status is partial even with zero rows. |
| jscpd | 5.2.0, executable SHA-256 `e5d85c518e917b304a11f63864bb93e6a2afa23c315e5b657321cd29fb156265`; MIT evidence in the retained probe | Scanner-owned strict JSON settings use JavaScript, TypeScript, and Python with `minTokens: 5`, `minLines: 2`, no Git ignore, no baseline/blame/cross-format mode, and no exit-code flag. Validate format source coverage and calculate inclusive physical-line span unions. |

The adapter contract discards ast-grep matched text, lines, metavariables, labels, and byte offsets, and jscpd fragments and tool-defined duplicated-line statistics. Source-bearing fields never enter saved reports. Missing, unsupported, untrusted, malformed, timed-out, input-mutating, or parse-ambiguous results are unavailable or partial, never an empty clean result.

The probe considered rust-code-analysis 0.0.25 and Lizard 1.24.0 for callable metrics. Both returned success for malformed sources and had callable-definition gaps; neither is selected. This is why live complexity, SLOC, callable deltas, and erosion remain unavailable.

## Measurement and report contract

Reports use `code-quality-report-v1` and compatibility version `scanner-compatibility-v1`. Canonical JSON sorts object keys while preserving array order. Compatibility equality is exact over the recorded scanner/schema versions, normalized scope, collection and ignore policy, Git version/policy, metric definitions, adapter pins/options/configuration/rule hashes, callable matching policy, classification/exclusion rules, and limits. It excludes changing content identities, membership, timestamps, source buffers, and observed coverage. Unknown versions are rejected; mismatches return a bounded list of differing paths.

Reports retain report-safe capture identities, manifest digests, normalized relative metadata, counts, coverage, metric status, provenance, compatibility, and bounded diagnostics. They never retain frozen source bytes, raw analyzer output, full stderr, environment values, or absolute private paths. Saved-report validation must reject unsafe links, oversize/malformed JSON, source-bearing fields, unknown versions, non-finite or invalid measurement totals, and structurally shallow metric objects. This validation requirement is pending the parent-owned runtime correction.

Physical line count is raw-byte LF-delimited physical lines, including a nonempty final line without LF. It is not SLOC. Direct npm dependency comparison covers only direct `dependencies`, `devDependencies`, `optionalDependencies`, and `peerDependencies` in captured `package.json`; lockfile-only churn is not inferred.

The pure callable formula, used only when a future approved adapter supplies complete callable rows, is:

```text
mass(f) = CC(f) * sqrt(SLOC(f))
erosion = sum(mass(f) where CC(f) > 10) / sum(mass(f))
```

The cutoff is a measurement parameter, not a merge threshold. An empty denominator is not applicable. Any future output must include numerator, denominator, high-CC count, maximum CC, per-callable before/after CC, SLOC, mass, added/removed/unmatched callables, and deterministic row caps. It must not let simple additions dilute a growing hotspot or omit rows while claiming no regression.

All metric and contributor rows have a 1,000-row cap with total, reported, and omitted counts. Omission makes evidence partial and blocks a no-regression conclusion. Human output must lead with available actionable contributors, then coverage and checks, include growing contributors separately, and disclose omissions. This presentation requirement is pending the recorded runtime correction.

No combined quality score exists. Pattern, clone, and callable measurements remain separate. A combined verbosity proxy is unavailable until a complete compatible AST/clone line universe exists.

## Tests and maintenance checks

Run the package suite from the repository root:

```bash
npm --prefix pi-skill-code-quality test
```

The suite covers contract documentation, packaging, evaluation fixtures, collection safety, Git isolation, bounds, classification, metrics, report validation, CLI behavior, optional adapters, and hardening. Tests must preserve the existing deterministic coverage for dirty/staged/untracked changes, raw path behavior, hostile Git configuration, capture instability, limits, missing Git/baselines, malformed tools, source mutation, and source-free report handling. New runtime defects require a minimal reproduction and parent escalation before a cross-boundary correction.

Validate routing coverage with:

```bash
node dev/scripts/validate-skill-routing-fixtures.mjs --skill-root ./pi-skill-code-quality/skills
```

Validate packaging without lifecycle scripts:

```bash
npm pack ./pi-skill-code-quality --dry-run --ignore-scripts
```

Also check Markdown fences, frontmatter, relative links, documentation-layer boundaries, published file inclusion, and whitespace. Windows scanner validation is required. POSIX validation remains an explicit deferred item.

## Evaluation protocol

`tests/evaluation/` contains held-out maintenance scenario descriptors for parser growth, repeated error handling, and a legitimate validation boundary. Each scenario has four cumulative requirement steps and named protected correctness checks. Treatment agents may edit only task-owned implementation files in their temporary scenario repository; fixed correctness tests and their expected outcomes remain protected and are run after every step. Do not use rule-development fixtures as evaluation scenarios.

A future evaluation compares old guidance with the revised loop using the same starting repository, cumulative requirements, model settings, allowed tools, and fixed correctness suite. It records future-change success, correctness regressions, confirmed human review findings, unnecessary edits, maintenance effort, elapsed time, and declared cost. Reviewers receive diffs, requirements, and test evidence without treatment labels. Human review is required; model judgment alone is insufficient.

The protocol allows at most two runs per treatment per scenario, 45 wall-clock minutes per run, and zero paid spend. Any nonzero spend or expanded trial count needs explicit approval before execution. No paid campaign is authorized. The fixtures and protocol establish an evaluation plan, not evidence of effectiveness; publish only advisory capability statements unless a separately approved evaluation produces results.
