# Development guide: Code Quality

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Contract status and scope

This document is the package's canonical scanner contract. It consolidates the normative requirements from the planning design so the implementation contract does not drift from a second copy. It defines what implementation and tests must preserve.

The accepted F8-F12 hardening changes and C3 human-summary display-cap correction are implemented and have regression coverage: output-scope and ancestor guards, saved-report validation, command budget and cancellation propagation, analyzer failure-path integrity, actionable human contributors, and distinct disclosure for display-level truncation. Independent Anthropic and Moonshot reviews are complete, and the accepted fixes passed parent-run regression checks. This is implementation acceptance within the reduced scope below, not publication or a new version.

The shared 20-item human-summary display limit now emits a per-category notice whenever it hides nonempty contributor rows, including a category fully hidden by earlier rows. That notice is distinct from the 1,000-row JSON-cap omission count and directs readers to `--format json`; unlisted contributors are not evidence of no regression.

The package remains dependency-free for Git-only operation. It has no version bump and no runtime dependency for optional analyzers. The package must not install, download, upload, publish, configure Pi, commit, stash, reset, or modify a reviewed repository as part of scanner operation.

### Implemented, partial, unavailable, and deferred work

| Area | Status | Contractual result |
| --- | --- | --- |
| Git-backed capture, physical lines, direct npm dependency changes, source-free reports | implemented and Linux regression-tested | Report evidence with capture coverage and explicit limits. |
| Current-only snapshots and compatible saved-report comparison | implemented and Linux regression-tested | Compare current physical totals only; do not invent edit churn. |
| F8-F12 output, report-validation, lifecycle, adapter-integrity, and contributor-summary safeguards | implemented and regression-tested | Retain the guards and source-free, bounded failure behavior. Independent review completed; future changes still require affected regression checks. |
| ast-grep pattern candidates | optional and partial | Windows x64 pin only, explicit trusted executable, scanner-owned rule and frozen input. Empty output is still partial. The pin was not run in the current Linux validation. |
| jscpd token-clone evidence | optional and coverage-dependent | Windows x64 pin only, explicit trusted executable, scanner-owned settings and frozen input. The pin was not run in the current Linux validation. |
| Callable complexity, analyzer-defined SLOC, callable trend deltas, erosion, verbosity proxy | unavailable | Never infer, estimate, or report a clean zero state. Pure fixture algorithms do not enable live scanner measurement. |
| Linux Git-only behavior | current verification evidence | Current Linux tests cover the Git-only path. They do not establish Linux structural-analyzer support. |
| Windows Git and pinned-adapter behavior | historical verification evidence | Retained Windows results support the pinned contracts only. They were not rerun in the current Linux validation and are not a general Windows support claim. |
| POSIX structural-analyzer behavior | deferred | Do not claim it from Git-only or process-lifecycle evidence. |
| Automatic lifecycle hooks, watchers, CI enforcement, automatic refactoring, history databases, generic plugins, full benchmark recreation, dependency graphs, and universal scoring | deferred | Do not add them through this package. |

## Skill invocation and writing contract

`SKILL.md` requires invocation before and throughout every write or edit of code intended to remain in a permanent file, regardless of language, file type, Git tracking or change size. This includes code embedded in retained documentation or templates and prototypes promoted from scratch work. Direct writes, patches, generation and delegated implementation have the same applicability. Generated or vendored artifacts remain subject to repository ownership policy.

The primary workflow is write-and-improve, not review-only by default. Authorization to implement a coding task includes justified improvements to task-owned code; it does not grant unrelated refactoring authority. Explicit review-only requests remain non-mutating. Quality practices apply to every write, while optional extra cleanup stays bounded to one pass on at most three confirmed findings. Scans, S0/S1/S2 snapshots and formal reports are not prerequisites for small edits.

This change is guidance and routing only. The scanner stays read-only and gains no new operations or hooks. Routing fixtures include one-line changes, scripts, tests, retained examples and prototype promotion alongside negative prose/chat/scratch cases. Contract tests check writing-first activation, scoped authorization, the review-only exception and optional measurement. These static checks verify the instruction contract, not actual model adherence to every write.

The prior scanner's implementation reviews and acceptance evidence above do not establish an evaluation of this revised writing policy. Longitudinal effectiveness remains unproven.

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

`--out` is optional and create-only. Without it, the scanner writes no persistent report. A requested report path must be outside selected source scope, must not replace an existing file, and must have a safe non-symlink ancestor chain. Output validation canonicalizes Windows and POSIX forms before checking containment. This safeguard is implemented, regression-tested and independently reviewed.

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

Timeout, cancellation, spawn error, output ceiling, malformed batch framing, close/abort failure, and failed termination must be bounded and observed. An analyzer runs only after Windows tree-termination capability is checked. Do not retry analyzers. Report unfinished work as partial or unavailable rather than multiplying timeouts. The command-wide budget, cancellation, and adapter failure-path corrections are implemented and regression-tested. Those checks do not replace required independent review or parent acceptance.

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

Reports retain report-safe capture identities, manifest digests, normalized relative metadata, counts, coverage, metric status, provenance, compatibility, and bounded diagnostics. They never retain frozen source bytes, raw analyzer output, full stderr, environment values, or absolute private paths. Saved-report validation rejects unsafe links, oversize or malformed JSON, source-bearing fields, unknown versions, non-finite or invalid measurement totals, and structurally shallow metric objects. The accepted validation correction is implemented, regression-tested and independently reviewed. Validation checks the supported report structure and known source-bearing fields; it is not a general sensitive-data detector for arbitrary strings in hand-authored reports.

Physical line count is raw-byte LF-delimited physical lines, including a nonempty final line without LF. It is not SLOC. Direct npm dependency comparison covers only direct `dependencies`, `devDependencies`, `optionalDependencies`, and `peerDependencies` in captured `package.json`; lockfile-only churn is not inferred.

The pure callable formula, used only when a future approved adapter supplies complete callable rows, is:

```text
mass(f) = CC(f) * sqrt(SLOC(f))
erosion = sum(mass(f) where CC(f) > 10) / sum(mass(f))
```

The cutoff is a measurement parameter, not a merge threshold. An empty denominator is not applicable. Any future output must include numerator, denominator, high-CC count, maximum CC, per-callable before/after CC, SLOC, mass, added/removed/unmatched callables, and deterministic row caps. It must not let simple additions dilute a growing hotspot or omit rows while claiming no regression.

All metric and contributor rows have a 1,000-row JSON cap with total, reported, and omitted counts. Omission makes evidence partial and blocks a no-regression conclusion. Human output presents available actionable contributors before coverage and checks, and separates growing callable contributors when such rows are available. Its shared 20-item display cap emits a distinct per-category omission notice whenever it hides nonempty rows, even when an earlier category exhausts the display budget; both notice types direct readers to `--format json` and state that unlisted contributors are not evidence of no regression. The contributor-summary and display-cap corrections are implemented and regression-tested, while independent review and parent acceptance remain outstanding.

No combined quality score exists. Pattern, clone, and callable measurements remain separate. A combined verbosity proxy is unavailable until a complete compatible AST/clone line universe exists.

## Tests and maintenance checks

Run the package suite from the repository root:

```bash
npm --prefix pi-skill-code-quality test
```

For optional Windows x64 adapter fixtures, set `CODE_QUALITY_AST_GREP_EXE` and `CODE_QUALITY_JSCPD_EXE` to absolute paths of the already obtained pinned executables. Unset, relative or missing paths skip those fixtures. The CLI mutation fixture uses the same ast-grep variable. Tests never download tools; the adapters still enforce their exact hashes and versions.

The suite covers contract documentation, packaging, evaluation fixtures, collection safety, Git isolation, bounds, classification, metrics, report validation, CLI behavior, optional adapters, and hardening. Tests must preserve the existing deterministic coverage for dirty/staged/untracked changes, raw path behavior, hostile Git configuration, capture instability, limits, missing Git/baselines, malformed tools, source mutation, and source-free report handling. New runtime defects require a minimal reproduction and parent escalation before a cross-boundary correction.

Validate routing coverage with:

```bash
node dev/scripts/validate-skill-routing-fixtures.mjs --skill-root ./pi-skill-code-quality/skills
```

Validate packaging without lifecycle scripts:

```bash
npm pack ./pi-skill-code-quality --dry-run --ignore-scripts
```

Also check Markdown fences, frontmatter, relative links, documentation-layer boundaries, published file inclusion, and whitespace. Current Linux verification covers the Git-only scanner path and POSIX process-lifecycle regressions, but it does not run the Windows-pinned structural adapters. Earlier Windows results are historical evidence for those pins, not current cross-platform acceptance.

## Research context and limits

The feedback loop is an engineering hypothesis, not a demonstrated maintenance intervention. The [Earendil article on code sloppiness](https://earendil.com/posts/measuring-code-sloppiness/) motivates inspection of growth and concentrated complexity, but it does not validate this scanner or turn passing checks into proof of correctness.

- [SlopCodeBench v1, section 4.3](https://arxiv.org/html/2603.24755v1) reports a 34.5% initial verbosity reduction for GPT 5.4 under `anti_slop`, without statistically significant slope differences or consistent correctness gains. The same section reports higher cost. That result supports a bounded cleanup budget, not a claim that prompts or scanning improve maintenance.
- The v1 experiments use Python. They do not establish equivalent metric behavior for TypeScript, Rust, or shell. Appendix G reports a near-zero correlation between erosion and next-checkpoint pass rate, while LOC is the stronger raw cost correlate in that table. Erosion is not a validated predictor of extensibility. The paper also calls its human repositories an unmatched calibration panel, so this package must not repeat the comparison as proof that agents write universally lower-quality code.
- The [arXiv submission history](https://arxiv.org/abs/2603.24755) records v2 on 7 May 2026. Its abstract describes 36 problems and 196 checkpoints, compared with v1's 20 and 93. This documentation deliberately cites v1 figures and does not mix v2 figures into v1 claims without rechecking the dependent evidence.
- The [independent SlopCodeBench audit](https://github.com/kimjune01/slopcodebench-audit) and its [construct-validity finding](https://github.com/kimjune01/slopcodebench-audit/blob/main/findings/00-construct.md) raise relevant concerns. They are community-source audit material, not a rerun of the model campaign. Their panel count and coefficients differ from the requested v1 paper, so neither source is treated as definitive or combined with the other's figures.

No peer-reviewed replication was established in the bounded planning search. The evaluation protocol below is a plan for collecting evidence, not evidence of effectiveness.

## Evaluation protocol

`tests/evaluation/` contains held-out maintenance scenario descriptors for parser growth, repeated error handling, and a legitimate validation boundary. Each scenario has four cumulative requirement steps and named protected correctness checks. Treatment agents may edit only task-owned implementation files in their temporary scenario repository; fixed correctness tests and their expected outcomes remain protected and are run after every step. Do not use rule-development fixtures as evaluation scenarios.

A future evaluation compares old guidance with the revised loop using the same starting repository, cumulative requirements, model settings, allowed tools, and fixed correctness suite. It records future-change success, correctness regressions, confirmed human review findings, unnecessary edits, maintenance effort, elapsed time, and declared cost. Reviewers receive diffs, requirements, and test evidence without treatment labels. Human review is required; model judgment alone is insufficient.

The protocol allows at most two runs per treatment per scenario, 45 wall-clock minutes per run, and zero paid spend. Any nonzero spend or expanded trial count needs explicit approval before execution. No paid campaign is authorized. The fixtures and protocol establish an evaluation plan, not evidence of effectiveness; publish only advisory capability statements unless a separately approved evaluation produces results.
