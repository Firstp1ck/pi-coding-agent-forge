# Code-quality feedback loop

Status: implementation aborted at the user's request on 2026-09-11. The feature is incomplete; all existing code and index changes are retained. See section 12 for the checkpoint and unfinished gates. Do not resume without a new user instruction.

Target: [`@firstpick/pi-skill-code-quality`](../../pi-skill-code-quality/README.md), currently version `0.1.5`.

## Goal

Improve the existing skill so it can detect maintainability regressions during a change, explain their causes, and guide a small, behavior-preserving cleanup. Keep correctness first. Treat measurements as evidence to inspect, never as a quality score to maximize.

Keep the `code-quality` skill name and published package name. Add a small, optional local scanner inside the skill package rather than a new Pi extension or a second package.

## 1. What the evidence supports

The [Earendil article](https://earendil.com/posts/measuring-code-sloppiness/) makes a useful case for examining code growth, verbosity, and concentrated complexity. Its claim that generated code is almost perfectly correct is not a premise for this design. Passing available tests is evidence, not proof of correctness.

The proposed measurement-and-cleanup loop is an engineering hypothesis worth testing. It is not an intervention already validated by SlopCodeBench.

| Suggestion | Decision and qualification |
| --- | --- |
| Track LOC growth | Include additions, deletions, and net change, separated by production code, tests, and other files. Do not penalize useful tests or required behavior for adding lines. |
| Track complexity concentration | Include the paper's erosion formula when complete callable measurements are available. Also show absolute complexity mass and function-level contributors so an improving ratio cannot hide a worsening function. |
| Combine AST findings and clones | Keep both visible separately. A combined local verbosity proxy is optional and requires compatible line accounting and complete coverage. It is not a SlopCodeBench score. |
| Replace a style prompt with a feedback loop | Adopt a bounded loop and evaluate it. The paper did not test this particular intervention. |
| Refactor after every measurement increase | Reject. An increase starts an inspection; only a concrete maintenance problem justifies cleanup. |
| Add coupling, cohesion, dependencies, and churn | Review boundaries and direct dependency changes immediately. Defer automated dependency graphs and historical function tracking. |
| Automatically apply after substantial work | Improve skill routing and explicit invocation guidance. A skill cannot guarantee invocation or register an automatic post-edit hook by itself. |
| Copy the benchmark's 137 rules | Reject wholesale copying. Start with a small, tested rule set and check licenses before reusing any upstream implementation. |
| Use a universal score or threshold | Reject. Project policies may impose limits, but the skill must not invent them. |

### Research limits that affect the design

- [SlopCodeBench v1, section 4.3](https://arxiv.org/html/2603.24755v1) reports a 34.5% initial verbosity reduction for GPT 5.4 under `anti_slop`, without statistically significant slope differences or consistent correctness gains. This does not prove that prompts never help, or that a scanner will fix degradation.
- The same section reports higher GPT 5.4 cost under `anti_slop`. Cleanup needs a time and scope limit, not an open-ended loop.
- The experiments in the cited version use Python. The benchmark's language-agnostic tasks do not establish equivalent metric behavior in TypeScript, Rust, or shell.
- Appendix G reports a near-zero correlation between erosion and next-checkpoint pass rate. LOC is a stronger raw cost correlate in that table. Erosion is not a validated predictor of extensibility.
- The paper explicitly describes its human repositories as an unmatched calibration panel. Avoid repeating the comparison as proof that agents write code of universally lower quality.
- The [independent audit](https://github.com/kimjune01/slopcodebench-audit/blob/main/findings/00-construct.md) raises relevant construct-validity concerns, but it is a community source audit, not a rerun of the model campaign. Its panel count and table coefficients differ from the requested v1 paper. Do not mix those figures or treat the audit as definitive.
- No peer-reviewed replication was established in the bounded planning search. Preserve source versions and these qualifications in contributor documentation.

## 2. Problems in the current package

The package currently contains guidance and documentation only. There are no scanner scripts, metric fixtures, or package test commands.

| Current issue | Planned correction |
| --- | --- |
| `SKILL.md` starts by running tools rather than understanding the diff | Inspect scope, repository instructions, architecture, existing changes, and checks first. |
| Universal cyclomatic and undefined data-flow limits of `< 25` | Remove invented merge blockers. Use project limits where documented; otherwise use contextual findings. |
| Clippy cognitive complexity appears under cyclomatic measurement | Separate cognitive complexity, cyclomatic complexity, and size. Never substitute one for another in erosion. |
| Language configurations are called the user's standards | Make them opt-in examples subordinate to repository policy. Do not silently enable strictness, replace tooling, or force serial tests. |
| Review instructions run formatters that rewrite files | Default review mode to reporting. Use check modes only when their side effects are acceptable. |
| `SKILL.md` directs logging to `MEMORY.md` | Remove automatic persistence from all documentation layers. Write a report only to an explicitly requested location. |
| Hardcoded `Arc` reviewer and `Zero` security escalation | Remove persona assumptions. Report security concerns directly; refer to another skill only if available and appropriate. |
| Complexity advice favors extracting helpers indiscriminately | Require a meaningful responsibility boundary. A single-caller helper can be useful; many tiny helpers can make navigation worse. |
| npm `files` omits `TECHNICAL.md` and `DEVELOPMENT.md` | Include linked documentation in the package and verify installed links. |

Preserve useful language guidance, correctness checks, security checks, and review examples. Move detailed language configurations to supporting references rather than discarding them. Unsafe defaults should be corrected, not retained as recommended behavior.

## 3. Scope and delivery boundary

### Included in the first complete release

- A concise skill workflow with explicit review and authorized-cleanup modes.
- Baseline, post-implementation, and post-cleanup comparisons.
- A Node.js CLI using core APIs for Git inspection, comparison, and reporting.
- Read-only structural analysis through optional, explicitly selected local tools.
- Git line deltas and npm direct-dependency changes without additional analyzers.
- Tested complexity, size, duplication, and selected AST-pattern adapters for JavaScript/TypeScript and Python.
- Existing Rust and shell review guidance. Structural support is enabled only where adapter fixtures establish coverage; unsupported measurements remain unavailable.
- Human-readable and versioned JSON reports with provenance and coverage.
- Fixture tests, routing cases, packaging checks, and a small longitudinal evaluation protocol.

### Deferred

- Automatic Pi lifecycle hooks, background watchers, and CI enforcement.
- A full SlopCodeBench reimplementation or leaderboard-compatible scores.
- A homegrown multi-language parser, generic plugin system, or large rule library.
- Automatic refactoring and formatter fixes inside the scanner.
- Persistent history databases, trend dashboards, and cross-commit symbol tracking.
- Numeric cohesion scores, whole-repository coupling graphs, and transitive dependency analysis.
- Automatic installs, downloads, uploads, commits, stashes, resets, or memory writes.

Phases below are independently useful. Delivering the workflow correction does not require completing the scanner first, but it must not claim scanner capabilities that have not shipped.

## 4. Skill workflow

For a review-only request, compare the chosen baseline with the current code, inspect findings, and report. Skip implementation and cleanup steps. Run project checks only within the request's authorization; the scanner itself does not run them.

### A. Establish scope and baseline

1. Read applicable repository instructions and the requested change. Identify relevant architecture, tests, and package boundaries.
2. Inspect staged, unstaged, and relevant untracked files. Distinguish the user's existing work from the task's starting point.
3. Determine whether the request authorizes implementation or only review. Do not turn a read-only review into a cleanup task.
4. Discover existing verification commands. Record missing tools and pre-existing failures rather than replacing project configuration.
5. Choose a baseline and fixed analysis scope before editing when possible. Capture an initial metric snapshot, `S0`, for the authorized module or package roots.

`HEAD` is a useful review baseline, but it is not the agent's starting state in a dirty workspace. Reports must not attribute every difference from `HEAD` to the current task. If the skill is invoked only after implementation, say that the pre-task snapshot is unavailable.

### B. Implement and verify behavior

6. Make the requested change using repository conventions. Do not minimize LOC at the expense of clarity, safety, or behavior.
7. Run the relevant authorized tests, type checks, lint checks, formatter checks, and build. Select actual project commands rather than blindly running every language example.
8. Capture post-implementation measurements, `S1`, even if checks fail. Failed correctness checks take priority over optional structural cleanup.

### C. Inspect and optionally clean up

9. Examine changed functions and nearby code, then inspect any measured increases. Search for an existing implementation before adding or extracting another abstraction.
10. Ask whether duplicated branches represent the same behavior, whether a function gained an unrelated responsibility, and whether guards protect real trust boundaries or compatibility requirements.
11. Review dependency additions, module direction, lifecycle ownership, and cohesion qualitatively. Do not invent numeric measurements for these judgments.
12. If authorized and supported by a concrete finding, perform one focused cleanup pass. Default to at most three findings in the touched scope. Ask before broad architectural work or another cleanup pass.
13. Preserve public behavior, security checks, error handling, and compatibility. Add characterization tests first where needed. Do not delete protections merely because tests do not exercise them.

### D. Recheck and report

14. Rerun affected correctness gates after cleanup, plus broader gates when the risk warrants them. Capture `S2` using the same scope, tools, and metric definitions.
15. Compare `S0 → S1` and `S1 → S2`. Separate feature cost from cleanup effects.
16. Classify findings as fixed, accepted with a reason, deferred, false positive, or blocked by missing evidence. A larger metric can be an acceptable outcome.
17. Stop when no justified local cleanup remains or the agreed budget is exhausted. Report unresolved issues and checks not run.

A failed cleanup must not trigger a blanket Git rollback. Undo only isolated edits owned by the cleanup when safe, or ask for guidance. Never remove the user's pre-existing changes.

## 5. Scanner design

### Package layout

Proposed additions, not existing files:

```text
pi-skill-code-quality/
  skills/code-quality/
    SKILL.md
    scripts/
      scan.mjs
      lib/
        git.mjs
        runner.mjs
        metrics.mjs
        report.mjs
      adapters/
    references/
      language-checks.md
      measurement-guide.md
    rules/
      typescript/
      python/
  tests/
    fixtures/
    *.test.mjs
  README.md
  TECHNICAL.md
  DEVELOPMENT.md
  package.json
```

Keep runtime scripts and rules under the existing published `skills` directory. Keep contributor tests at the package root. Resolve script and rule paths from the installed skill location, not from the user's working directory. Split modules only where they own a clear responsibility.

### Interface

Start with three operations:

- `scan`: compare a specified Git baseline with the current worktree within authorized roots.
- `snapshot`: capture current measurements to an explicitly selected output file.
- `compare`: compare two compatible saved measurement snapshots without rerunning analyzers.

Proposed usage:

```bash
node <skill-dir>/scripts/scan.mjs scan --base HEAD --scope src --format json
node <skill-dir>/scripts/scan.mjs snapshot --scope src --out <report-dir>/before.json
node <skill-dir>/scripts/scan.mjs compare --before <report-dir>/before.json --after <report-dir>/after.json
```

Document that these are CLI operations, not registered Pi tools or new slash commands. `/skill:code-quality` remains the explicit Pi entry point.

### Baselines and comparison rules

- Require an explicit baseline for Git comparisons. Resolve it once to a full commit object ID before collection, including an explicitly chosen merge base for branch reviews. Never assume a branch named `main`, fetch one, or re-resolve a moving ref midway through a scan.
- Handle staged and unstaged changes together for worktree review. Offer index-only comparison only if implemented and tested. Untracked inclusion must be explicit. Freeze repository ignore rules and explicit scanner exclusions for both sides; do not discover files through global Git excludes or sweep credentials and unrelated configuration into the scan.
- Analyze the same selected module roots on both sides, including unchanged neighbors needed for clone detection. Distinguish all-callable scope totals from matched-function comparisons.
- Record additions and deletions as such, not as functions whose complexity changed from or to zero. Use exact-content file rename candidates initially; duplicate-content ambiguity remains unmatched. Callable matching is a separate versioned policy, not a side effect of Git rename detection.
- Outside Git, support current snapshots and explicit snapshot comparisons. Without a baseline, report current measurements but no regression claim.
- Require equal compatibility objects under the output contract before comparing snapshots. Input file membership may legitimately change, but missing or truncated measurements must not appear as improvement.

### Git invocation contract

- Use a resolved, trusted Git executable with argument arrays. Collect file metadata using byte-oriented, NUL-delimited formats such as `ls-tree -r -z --full-tree` and `ls-files --stage -z`. Never split pathname records on whitespace or newlines. Decode paths losslessly, or report unsupported encodings rather than merging distinct names. `core.quotepath=false` is not a substitute for `-z`.
- Enumerate tree object IDs once and read raw blobs through one persistent `git cat-file --batch` process. Send object IDs, not pathname expressions, and parse contents by the declared byte length. Do not enable `--filters` or `--textconv`. Missing objects fail locally. Do not use `git archive`, whose export attributes can change the captured content.
- Use a sanitized child environment. Remove inherited Git config injection, alternate repository/index selection, external diff, and trace variables. Set `GIT_CONFIG_NOSYSTEM=1`; point `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` at a scanner-owned empty file. Set `GIT_NO_LAZY_FETCH=1`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_OPTIONAL_LOCKS=0`, and `GIT_TERMINAL_PROMPT=0`. Preserve legitimate repository-format and worktree metadata; never bypass ownership checks with `safe.directory=*`.
- System/global config isolation does not disable repository-local configuration. Source reads must use raw object APIs and direct filesystem reads, never live-worktree `git diff`, checkout, or `hash-object --path`. Conversion filters can execute even when external diff and text conversion are disabled. Pin scanner-owned overrides and document the remaining config inputs during Phase 2.
- Compute line deltas with a bounded, isolated `git diff --no-index` over the frozen before/after directories. Run outside the reviewed repository, with scanner-assigned safe filenames mapped back to original paths so `.gitattributes` cannot become active configuration. Disable system attributes and point `core.attributesFile` at the empty file. Use `--numstat -z --no-ext-diff --no-textconv --diff-algorithm=myers --no-indent-heuristic --no-renames` and `core.autocrlf=false`. Compute exact-content rename candidates from captured SHA-256 groups of removed and added eligible paths. Accept only unambiguous one-to-one groups; account for those renames explicitly and leave duplicate-content ambiguity as additions and deletions. Preserve category moves. Git similarity matching must not choose among ambiguous candidates. Treat exit 1 as differences, not a tool failure. Preserve raw bytes, including CRLF and missing final newlines; never invoke checkout normalization.
- Record Git version, diff algorithm, exact-content one-to-one rename policy, disabled Git rename detection, encoding/line-accounting policy, and effective scanner overrides in provenance and compatibility. Git's documented default similarity is 50%; the reason to pin behavior is reproducibility and configuration independence, not a claim that the default threshold varies randomly.
- Batch Git operations. The number of Git processes must be bounded independently of file count, apart from the single allowed collection retry. Phase 2 freezes the process budget and Phase 3 asserts it for small and large fixtures.

### Snapshot capture and consistency

1. Enumerate the selected paths, file types, and eligibility inputs. Record the relevant index identity and repository ignore inputs. Read each regular file once into a bounded private capture, recording byte count and SHA-256 of the exact bytes retained. Use descriptor metadata checks to catch replacement or modification during a read; size and mtime alone are insufficient.
2. Re-enumerate and rehash the source paths immediately after collection. Compare membership, type, content hashes, index identity, and eligibility inputs with the capture. Detect additions, deletions, same-size edits, and changed discovery rules. Keep a bounded list of diverging paths and the total count.
3. On mismatch, discard the attempt and recollect once only if the overall deadline permits. A second mismatch, unreadable comparison input, or exhausted deadline produces an `inconsistent` snapshot with diagnostics and no valid trend deltas. This is the sole collection retry, not permission to retry analyzers.
4. Run every analyzer against the same frozen capture, never against the changing worktree. Verify temporary input hashes after tool execution; detected analyzer modifications invalidate the capture and stop further analysis. Keep temporary sources out of saved reports and remove only scanner-owned files.

This detects instability on a best-effort basis, not an atomic filesystem snapshot. An edit followed by restoration between observations can escape detection. Accepted analyzer results must refer to the retained capture; they do not certify that the live worktree still has those bytes when reporting finishes. Report the capture identity rather than claiming a live-state guarantee.

### Tool choice and coverage

Use existing analyzers before writing metric extraction code. Phase 2 must select and pin a tested tool contract, not merely discover a similarly named executable.

Preferred candidates for the short compatibility spike:

| Need | Candidate and decision gate |
| --- | --- |
| Per-callable cyclomatic complexity and source size | Evaluate [rust-code-analysis](https://github.com/mozilla/rust-code-analysis) JSON output first. Verify callable boundaries, nested functions, TypeScript syntax, Python behavior, and installation cost. Use [Lizard](https://github.com/terryyin/lizard) or a narrower [Radon](https://radon.readthedocs.io/en/master/commandline.html) adapter only if the first option fails the fixtures. Do not ship all three by default. |
| AST patterns | Use [ast-grep](https://ast-grep.github.io/guide/scan-project.html) with packaged rules, explicit configuration, and positive and negative fixtures. Never use fix mode. |
| Duplication | Evaluate a pinned [jscpd](https://github.com/kucherenko/jscpd) machine-readable report. Describe token clones accurately; do not call them the benchmark's structural-clone implementation. |
| Correctness and established warnings | Let the skill use authorized project checks. Keep the scanner separate from test execution and repository lint-plugin loading. |

The Node entry point should require no new runtime dependency for Git-only reporting. Structural analyzers are optional local prerequisites, documented by version. Missing tools yield useful partial reports; the scanner does not install them or silently switch measurement definitions.

Resolve tools from explicit trusted paths or a PATH search that excludes the reviewed checkout and implicit current-directory entries. Resolve once, verify the supported version, and invoke that exact executable. An already-installed JavaScript CLI may run through a trusted Node executable with its absolute entry path. Do not invoke `npx`, `npm exec`, `pipx run`, `uvx`, or other install-capable wrappers, even with purported no-install flags. On Windows, do not fall back to running an unresolved `.cmd` shim through a shell. Missing, untrusted, or unsupported executables produce `unavailable`, with a setup hint and no installation attempt.

Adapters must disable automatic configuration/plugin discovery and use known local settings. These controls are not a sandbox for arbitrary executables: only approved adapter/tool combinations may run, and their offline behavior needs a fixture test.

Begin with no more than six AST rules across the initial languages. Every rule needs a rationale, known exceptions, and negative examples involving meaningful wrappers, readable temporary variables, or necessary validation. These are review candidates, never automatic fixes.

### Metrics and interpretation

| Signal | Required behavior |
| --- | --- |
| Line change | Report added, deleted, and net physical lines. Distinguish physical LOC from analyzer-defined SLOC. Separate production, tests, generated files, and documentation. |
| Complexity | Report per-callable CC, source span, SLOC, and before/after values when matched. Require matched-function CC, SLOC, and mass deltas even when aggregate erosion falls. Label cognitive-complexity diagnostics separately. |
| Erosion | Calculate `mass(f) = CC(f) * sqrt(SLOC(f))`; report `sum(mass for CC > 10) / sum(all mass)`. Include numerator, denominator, high-CC count, max CC, and top contributors. An empty denominator is not applicable, not zero. |
| Erosion limitations | Label it as a local implementation of the formula, not benchmark parity. The cutoff at 10 is a measurement parameter, not a merge gate. Crossing 10 to 11 creates a discontinuity; adding trivial functions can dilute the ratio. |
| Duplication | Report clone pairs, spans, and unique covered lines. Distinguish existing duplication from newly introduced or expanded duplication. |
| AST patterns | Report rule ID, version, affected span, and reason to inspect. Deduplicate overlapping line coverage. |
| Verbosity proxy | Only calculate the union of pattern and clone lines over the same eligible line universe. Require complete inputs; missing clones are not zero clones. Show components and denominator alongside the proxy. |
| Function/class size and nesting | Report only supported measurements with documented definitions. Do not infer nesting from whitespace or treat a class as another function in erosion. |
| Dependencies | Compare npm direct dependency names, versions, and sections first. Report manifest changes separately from lockfile churn. Other manifest formats remain manual until a tested parser exists. |

Classify with a versioned, ordered pattern list, not an undocumented heuristic. Use normalized repository-relative paths and documented case-sensitive glob semantics. Explicit user category overrides come first, followed by artifact/vendor rules, test rules, documentation rules, then production rules for known source extensions. Anything unmatched is `uncategorized`, not production by assumption. Initial examples include `node_modules/**`, `vendor/**`, `dist/**`, and `*.min.*` for artifacts; `**/tests/**`, `**/__tests__/**`, `**/*.test.*`, and `**/test_*.py` for tests; `docs/**` and `**/*.md` for documentation; and known source files under `src/**`, `lib/**`, and `app/**` for production. Phase 2 freezes the complete defaults, root-level matching behavior, and precedence fixtures.

Exclude vendored, generated, minified, binary, and build-output files from maintainability aggregates by default, but keep bounded exclusion counts. User overrides cannot bypass safety exclusions. Report counts and line changes for each category, including `uncategorized`, plus the rule that classified each included file. Keep tests separate so duplicated setup is not silently judged like production duplication. Record all effective classification and exclusion rules in compatibility; do not silently reload changed rules between snapshots.

Compare per language and scope rather than averaging incompatible language metrics into a repository score. An increase in a measurement is an observation; a confirmed regression requires inspection.

### Output contract

A versioned JSON report must contain:

- Capture identities, file-content manifest digests, source category counts, exclusions, and snapshot consistency status.
- A `compatibility` object containing scanner/schema version, metric-definition versions, adapters and detected tool versions, effective analyzer options, rule content digests, normalized scope roots, untracked policy, exclusion/classification rules, callable-matching policy, Git invocation policy, and configured resource limits.
- Per-metric status such as available, partial, unavailable, not applicable, or incompatible. An `inconsistent` capture cannot supply valid trend deltas.
- Before and after values, denominators, and coverage counts where a comparison is valid. Observed coverage is data, not a compatibility setting; incomplete coverage still blocks complete-scope regression claims.
- Comparison reports require a `matchedFunctionDeltas` section with file-relative paths, callable identities, spans, before/after CC, SLOC and mass, and their deltas. Keep added, removed, and unmatched callables separate. A standalone snapshot stores current callable measurements and marks deltas not applicable; unavailable analyzers never imply an empty clean result.
- Measured observations separate from the agent's interpretation and finding dispositions.
- Bounded diagnostics, divergence counts, and reasons for skipped measurements.

Define compatibility equality over canonical JSON: expand defaults, sort object keys and set-like arrays, and preserve order-sensitive rules and options. Require exact equality; refuse comparisons with a bounded list of differing field paths. Reject unknown compatibility versions. An optional SHA-256 digest accelerates lookup but is not a substitute for the stored object. Do not include commit IDs, changing content hashes, file membership, timestamps, or observed metric values in compatibility, since those are the inputs being compared.

Keep all measured matched-function rows in the JSON within the declared scan/output limits, sorted by descending absolute mass delta with path and callable identity as deterministic tie-breakers. If a limit forces omission, set `partial`, report `totalRows`, `reportedRows`, and `omittedRows`, and prohibit a no-regression conclusion. The human summary lists growing functions separately from improvements and shows the omitted count and access to full JSON. A top-contributor cap must never imply that unlisted functions did not grow.

Separate timestamps and durations from the reproducible measurement payload. Do not add a combined quality score or automatically equate a numeric increase with high severity.

Default to stdout. Saved snapshots contain metrics and identities, not source copies. Persistent reports require an explicit output path. Human reports should lead with actionable contributors, then coverage and check results.

### Safety and execution bounds

- No network requests, telemetry, package installs, repository script execution, or writes to reviewed source files in the scanner.
- Treat configured analyzers as executable code requiring user trust. Do not discover and execute arbitrary binaries or configuration plugins from the reviewed checkout.
- Pass subprocess arguments without shell interpolation. Test Windows executable resolution explicitly.
- Use bounded temporary source copies only where a diff or analyzer requires files. Do not follow symlinks outside the scope, read devices, or traverse submodules implicitly. Clean up only scanner-owned temporary paths.
- Set visible limits for files, total bytes, file size, tool runtime, subprocess count/output, and concurrency. One monotonic overall deadline covers enumeration, both collection attempts, hashing, blob reads, analysis, and report generation. Each subprocess gets the smaller of its own timeout and remaining scan budget. Reserve bounded time for termination and cleanup; kill and reap child processes on timeout or cancellation. Mark unfinished work as partial rather than multiplying per-tool timeouts into an unbounded scan.
- Start with one analyzer process at a time and no analyzer retries. Allow only the single snapshot recollection described above. Phase 2 fixes numeric defaults, including the overall deadline, cleanup allowance, and process budget, from representative fixtures. Git rename detection stays disabled; the scanner's exact-content matching policy is versioned separately. Record configured limits in compatibility and observed truncation in coverage.
- Do not include source snippets, absolute private paths, environment contents, or full stderr dumps in reports by default.
- Keep repository checks outside the scanner. Tests, builds, type checkers, and even check-mode tools may write caches or execute code. Obtain the appropriate authorization and never promise those commands are side-effect-free.

## 6. Implementation phases and completion gates

### Phase 1: Correct the guidance

Update `SKILL.md` and all three documentation layers. Move lengthy language-specific material into references. Add review-only behavior, baseline handling, the bounded loop, missing-evidence reporting, and no automatic memory persistence.

Expand routing to substantial implementations and refactors while retaining existing linting and review uses. Avoid activating for unrelated prose editing, simple explanations, and non-code tasks. Explain the boundaries with architecture-review, refactoring-advisor, and code-security without making them dependencies.

Gate: the workflow is useful without new tools; examples honor project policy; every claimed command exists; no automatic mutation or persistence instruction remains.

### Phase 2: Establish scanner contracts and compatibility

Build small analyzer probes and fixtures for JavaScript/TypeScript and Python. Validate the preferred complexity tool, clone output, source-line definitions, and nested-callable handling. Check redistribution licenses and supported installation paths. Choose one complexity adapter and document the decision in `DEVELOPMENT.md`.

Freeze the baseline semantics, JSON contract and canonical compatibility equality, CLI options, exit statuses, classification defaults, numeric limits, and initial coverage matrix. Test frozen capture and Git isolation as part of the probe, not after adapter implementation. Do not mark this phase complete based on tool documentation alone.

At this freeze, move section 5's normative scanner contract into `DEVELOPMENT.md` and replace that section in the plan with a link and delivery summary. Maintain one contract rather than letting a planning copy drift from the shipped specification.

Gate: real tool output can produce trustworthy callable-level measurements for the supported fixtures. If not, narrow advertised support rather than inventing estimates.

### Phase 3: Implement Git-only evidence and reports

Add safe Git collection, snapshot comparison, physical line deltas, npm manifest comparison, deterministic reports, and explicit partial/unavailable states. Implement path handling and temporary-file cleanup before adding more analyzers.

Gate: reports work without optional analyzers, distinguish dirty-start baselines, refuse incompatible/inconsistent comparisons, and leave repository contents and index unchanged. Git process counts stay within the fixed budget as file counts grow, clean filters never execute, and total timeout tests include termination and cleanup.

### Phase 4: Add structural evidence

Integrate the selected complexity adapter, clone adapter, and small AST rule set. Add per-function deltas, erosion components, and scoped observations. Enable a combined verbosity proxy only after line-union accounting is tested.

Gate: measurements match fixture expectations; unsupported files never count as clean; adding simple functions cannot hide an existing growing hotspot. A growing function outside a human-summary cap remains in `matchedFunctionDeltas`, or an explicit partial/omitted status prevents a no-regression claim.

### Phase 5: Evaluate the feedback loop

Create at least three small maintenance scenarios with four sequential changes each. Include parser growth, repeated error handling, and a legitimate abstraction or validation boundary. Keep correctness tests fixed and protected from the agent's edits.

Compare the old guidance with the revised loop using the same starting repositories, cumulative requirements, model settings, and declared budgets. Record total cost and elapsed time, not only measurements. Keep rule-development examples separate from evaluation examples.

Measure future-change success, regressions, review findings confirmed by a human, unnecessary edits, and maintenance effort. Repeat trials where affordable and report small-sample limitations. Human review should not see treatment labels; model judgments alone are insufficient.

Gate: deterministic tests pass. Before claiming effectiveness, obtain explicit approval for agent-evaluation cost and show evidence that the workflow produces useful findings without observed correctness regressions. If the evaluation is deferred or inconclusive, publish only advisory capability claims.

### Phase 6: Package and document the release

Update package metadata and add package test commands. Set the npm `files` array to exactly `["skills", "README.md", "TECHNICAL.md", "DEVELOPMENT.md", "LICENSE"]`. Keep contributor tests and fixtures at the package root, outside `skills`, and assert their absence from the packed file list. Account for npm's automatically included metadata such as `package.json`. Update the existing Code Quality entry in the repository README to describe before/after review accurately.

Keep README content to purpose, first use, outputs, requirements, and safety. Put options, tool prerequisites, compatibility, report controls, and troubleshooting in `TECHNICAL.md`. Put formulas, JSON contracts, adapters, source layout, fixtures, evaluation methods, and maintenance commands in `DEVELOPMENT.md`.

Gate: inspect the packed file list, verify installed script/reference paths, and smoke-test explicit `/skill:code-quality` loading. Versioning and publication are separate authorized release steps.

## 7. Validation checklist

### Deterministic tests

- Clean and dirty worktrees, staged plus unstaged edits, additions, deletions, and explicit untracked inclusion.
- Missing Git, no initial commit, invalid or unavailable baseline, detached HEAD, and non-Git snapshots.
- Rename ambiguity and explicit exact-only detection under conflicting Git config; byte-oriented paths with spaces, Unicode, and POSIX-only tabs/newlines; Windows paths; CRLF; and files without a final newline.
- Hostile diff/textconv/clean-filter configuration, injected Git environment variables, and paths named `.gitattributes` in frozen diff inputs. Verify that none executes reviewed code or changes raw-byte capture.
- Batched blob framing, missing objects without lazy fetching, fixed process counts across fixture sizes, and an overall deadline that includes capture, analysis, termination, and cleanup.
- Symlinks, submodules, binaries, generated files, unsupported syntax, parse errors, and bounded scans. Check classification precedence, explicit overrides, uncategorized counts, and changed rule sets.
- Empty projects, no callables, exact CC cutoff behavior, nested functions, anonymous functions, and class/function separation.
- Overlapping clone pairs and AST matches without double-counting lines.
- Incomplete tool coverage, missing executables, changed versions/configuration, malformed output, timeouts, and cancellation cleanup. Missing-tool and checkout-local shim fixtures must not invoke installers or make network requests.
- Compatibility equality with expanded defaults and reordered object keys, order-sensitive rule changes, scope/tool/version mismatches, and content-only changes that remain comparable.
- A growing function hidden by lower aggregate erosion after many simple functions are added, including growth outside the summary cap and explicit row-omission reporting.
- Justified wrappers, temporary variables, security guards, and duplicated test setup as false-positive fixtures.
- Dependency additions versus version changes and lockfile-only churn.
- Stable JSON output, same-size input mutations with preserved mtime, additions/deletions during capture, changed index/ignore inputs, one successful recollection, repeated instability, and analyzer attempts to modify frozen inputs. Verify unchanged index/worktree and no unsolicited report files.

### Skill and packaging checks

Add `tests/routing/code-quality.json` using the repository's existing routing fixture format. Run:

```bash
node dev/scripts/validate-skill-routing-fixtures.mjs --skill-root ./pi-skill-code-quality/skills
npm --prefix pi-skill-code-quality test
npm pack ./pi-skill-code-quality --dry-run --ignore-scripts

git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'
```

The package test command is to be added during implementation. Routing fixture validation checks schema and coverage, not actual model routing accuracy; evaluate the prompt cases separately.

Also validate frontmatter, local links, balanced fences, published file inclusion, and the README/TECHNICAL/DEVELOPMENT boundaries. Test the scanner on Windows and at least one POSIX platform. Do not claim an untested platform works.

## 8. Acceptance criteria

The improved package is ready when:

1. The skill reviews an existing change without editing files or writing memory by default.
2. An authorized implementation can produce distinct baseline, implementation, and cleanup comparisons.
3. Every numerical claim identifies its scope, definition, analyzer, and coverage.
4. Reports identify concrete contributors rather than issuing a single quality score.
5. Missing tools and unsupported syntax produce explicit limitations, not reassuring zeroes.
6. Cleanup stays in scope and is followed by appropriate correctness checks.
7. Project policy takes precedence over examples; the skill does not invent universal complexity gates.
8. The scanner is usable with partial capabilities and never installs tools automatically.
9. Tests, package checks, documentation checks, and available platform smoke tests pass, with deferrals stated.
10. Claims about improved long-term maintenance are limited to what the evaluation actually establishes.

## 9. Sources and planning verification

Primary reading:

- [Earendil: Measuring the sloppiness of code](https://earendil.com/posts/measuring-code-sloppiness/).
- [SlopCodeBench, arXiv v1](https://arxiv.org/html/2603.24755v1), especially sections 2.3, 4.2, 4.3, 6, and Appendix G. This plan deliberately retains the version supplied in the original request.
- [arXiv submission history](https://arxiv.org/abs/2603.24755) confirms v2 dated 7 May 2026. Its abstract describes 36 problems and 196 checkpoints, compared with v1's 20 and 93. Do not replace individual figures from v2 without rechecking all dependent claims and citations together.
- [Independent audit overview](https://github.com/kimjune01/slopcodebench-audit) and its [construct-validity finding](https://github.com/kimjune01/slopcodebench-audit/blob/main/findings/00-construct.md).
- [Agent Skills specification](https://agentskills.io/specification).
- [ESLint cyclomatic complexity rule](https://eslint.org/docs/latest/rules/complexity) and [Clippy cognitive-complexity implementation](https://github.com/rust-lang/rust-clippy/blob/master/clippy_lints/src/cognitive_complexity.rs).
- Git's [diff options](https://git-scm.com/docs/git-diff), [batch object reads](https://git-scm.com/docs/git-cat-file), and [configuration environment](https://git-scm.com/docs/git).
- [npm exec behavior](https://docs.npmjs.com/cli/v11/commands/npm-exec/) explains why install-capable wrappers are excluded from analyzer invocation.

Local evidence reviewed: the target package's manifest, skill, README, technical reference, and contributor guide; repository documentation rules and routing validator; installed Pi README, skill documentation, and package documentation.

The article, cited paper sections, and audit finding were retrieved and inspected. Python retrieval initially failed certificate validation for two sites; PowerShell retrieval succeeded without disabling verification. No benchmark campaign or analyzer compatibility experiment was run during planning.

Review verification used Git `2.51.2.windows.1` in temporary repositories. Probes passed for NUL-delimited Unicode/space renames, explicit rename/config overrides, batched raw blob framing, CRLF preservation, and missing final newlines. A negative probe confirmed that live-worktree diff can invoke clean filters despite `--no-ext-diff --no-textconv`; an isolated directory diff avoided that repository configuration. These are contract probes, not tests of an implemented scanner or proof of POSIX support.

## 10. Review dispositions

Verified against the [review](code-quality-feedback-loop.review.md), current package files, official documentation, and the temporary Git probes. The review remains unchanged.

| Finding | Disposition |
| --- | --- |
| H1 | Accepted with a stronger mechanism: retained bytes plus content hashes, post-collection verification, one deadline-bounded recollection, and frozen analyzer inputs. Metadata checks alone cannot close the race; atomic capture is not claimed. |
| H2 | Accepted with corrections: NUL records, explicit exact-only renames, recorded Git version/options, isolated configuration, and raw batched reads. Git documents a 50% default; `GIT_CONFIG_NOSYSTEM` alone does not isolate local/global settings, and disabling textconv does not disable clean filters. |
| H3 | Accepted: a stored compatibility object, canonical equality, mismatch diagnostics, and strict rejection. Changing source contents remain comparison inputs, not compatibility fields. |
| M1 | Accepted with stronger completeness rules: mandatory matched-function deltas and explicit omissions. Sorting or capping by absolute mass delta alone would still hide some growth. |
| M2 | Accepted: resolve trusted installed tools directly and report missing tools as unavailable. No install-capable wrapper fallback. |
| M3 | Accepted: batch object reads, fixed process budget, and one overall deadline. Per-file process spawning was a risk, not a requirement of the original plan. |
| M4 | Accepted: versioned classification patterns, precedence, overrides, uncategorized coverage, and compatibility accounting. |
| L1 | Verified: v2 exists with changed scope. Retain v1 deliberately and require a coordinated citation update before using v2 figures. |
| L2 | Accepted: say that formatters rewrite files. |
| L3 | Accepted: exact publish allowlist and a test that contributor fixtures are absent. |
| L4 | Accepted for Phase 2: move the frozen scanner contract to `DEVELOPMENT.md`, then link rather than duplicate it. |

The original planning task changed only the plan. The execution record below preserves subsequent implementation history. The abort instruction in section 12 supersedes earlier permissions to continue; versioning and publication were never authorized.

## 11. Implementation execution record

### Classification and authorization

- Integration owner: the parent Pi session implementing this plan.
- Classification: complex. The scanner crosses Git collection, subprocess trust, snapshot compatibility, optional adapters, and reporting contracts. Separate implementation and hardening outcomes are necessary.
- Starting revision: `c06409795dd0f178a1b51306679398a51a340924` on `main`; the worktree was clean at preflight.
- The user authorized implementation, then permitted isolated analyzer downloads and execution where possible. If tools cannot be obtained or validated, continue without those adapters and label the limitations. This permits reduced analyzer coverage, not invented measurements or weakened source-safety controls.
- No global installs, Pi settings changes, publication, version bump, network use by the shipped scanner, or paid longitudinal agent campaign. Phase 5 supplies deterministic scenarios and an evaluation protocol only; effectiveness claims remain advisory.
- Execution uses sequential writers in the shared checkout. No worker may edit this plan, stage or commit files, change unrelated packages, install globally, or launch children.

### Workstreams and dependency order

| ID | Owner and prerequisites | Write boundary and deliverable | Validation and handoff |
| --- | --- | --- | --- |
| P1 | Scout; preflight complete | Isolated temporary directory only. Probe preferred complexity tool, ast-grep and jscpd, versions, licenses, actual output, nested-callable and line coverage, trust/config controls. No repository edits. | Concrete probe outputs and supported/unsupported matrix; managed `code-quality/probes.md` artifact. |
| P2 | Oracle; approved plan available | Read-only architecture challenge of capture, Git isolation, compatibility and bounds. Identify at most three consequential unresolved decisions. | Evidence-backed decision brief; managed `code-quality/contract-challenge.md` artifact. |
| W1 | Worker; P1/P2 inspected and parent approval received | `pi-skill-code-quality/skills/code-quality/scripts/lib/{runner,git,capture,classification}.mjs`, `pi-skill-code-quality/tests/{core,git,capture,classification}.test.mjs`, and `pi-skill-code-quality/tests/helpers/**`. Own safe collection, subprocess bounds, classification, and hostile Git fixtures. | Focused Node tests, exact changed-file list, commands and omissions; managed `code-quality/core-handoff.md`. |
| W4 | Hardening worker; user continuation and parent W1 inspection complete | W1's four runtime libraries and four test files, `tests/helpers/**`, plus new `tests/safety.test.mjs`. Close W1's omitted safety fixtures and verified lifecycle/limit defects without changing the public capture interface. | Missing-Git/unborn/detached cases, injected environment, same-size mutations, hanging/malformed batch, cancellation and cleanup, configured limits; managed `code-quality/hardening-handoff.md`. |
| W2 | Retained worker; W4 diff inspected and parent approval received | Remaining files under `pi-skill-code-quality/skills/code-quality/scripts/`, packaged `rules/**`, `pi-skill-code-quality/tests/{metrics,report,cli,adapters}.test.mjs`, and `pi-skill-code-quality/tests/fixtures/**`. W1 libraries remain read-only unless parent approves a specific correction. Own CLI, metrics, compatibility, reports and verified optional adapters. | CLI and metric/adaptor fixtures, no-analyzer path and cross-module checks; managed `code-quality/scanner-handoff.md`. |
| W3 | Worker; W2 diff inspected and parent approval received | Package `SKILL.md`, `references/**`, README/TECHNICAL/DEVELOPMENT, `package.json`, new `tests/{contract,packaging,evaluation}.test.mjs`, `tests/evaluation/**`, repository `tests/routing/code-quality.json`, and only the Code Quality catalog row in repository `README.md`. Own corrected workflow, documentation, packaging and independent hardening/evaluation cases. | Package/routing/pack dry-run checks and protected sequential scenarios; managed `code-quality/package-handoff.md`. |
| R1/R2 | Independent fresh-context reviewers; integrated checks complete | Read-only integrated diff, tests and plan. Different provider families where available, separate from the primary implementation provider. | Findings with evidence and severity; managed review artifacts. Parent records every disposition. |
| I1 | Parent; all preceding work inspected | Canonical plan, small accepted integration fixes, and `reports/code-quality-feedback-loop.html`. | Combined tests, packaging/document checks, review dispositions, limitations, mutual plan/report links. |

Every worker begins with a supervisor approval barrier. The parent inspects the preceding actual diff, evidence and unresolved questions before releasing the next writer. Temporary analyzer probe inputs stay outside the checkout. Managed handoff paths are bound through the workflow output fields and their actual references are retained with run evidence.

### Integration and rollback

Keep the package dependency-free for Git-only operation. Freeze supported tool contracts from real probes before implementation; if a probe fails, record that adapter as unavailable and continue under the user's authorization. Do not advertise unsupported language or platform coverage. Move section 5 to DEVELOPMENT.md only once the implemented contract is frozen, retaining links and explicitly identifying any deferred requirements.

Run affected tests after each writer, then package tests, routing validation, packaging inspection, Markdown/link checks, Windows CLI smoke tests and any available POSIX checks before review. If a change fails, isolate and correct only task-owned edits; never use a blanket reset, clean, stash or rollback. Stop on unapproved scope/interface/security changes or lane infrastructure failures.

### Progress and decisions

- Preflight complete: package is guidance-only at version `0.1.5`; Node and Git exist, candidate analyzers were not found on PATH or in the inspected Python/Node installations.
- Approved P2 eligibility decision: freeze repository-owned `.gitignore` files and the actual `.git/info/exclude`; override system/global excludes and `core.excludesFile`. Use identical frozen eligibility rules on both comparison sides, verify their stability, and do not support including ignored files. Never traverse symlinks, submodules or special files. Invalid encodings and unreadable eligible inputs produce explicit incomplete coverage. Intentional policy exclusions have bounded counts and are distinct from collection failures.
- POSIX preflight: `wsl.exe --list --quiet` reports that WSL is not installed. No WSL installation is authorized or attempted; a genuine POSIX runtime remains unavailable pending other local evidence.
- Approved P2 rename correction: isolated numstat uses `--no-renames`, replacing the proposed `-M100%`. The scanner accepts only one-to-one exact-content SHA-256 groups among removed and added eligible paths, accounts for those unique renames explicitly, and leaves duplicate-content ambiguity unmatched with full line additions/deletions. Provenance, compatibility and fixtures must reflect the actual flags and preserve category moves.
- P2 completed in run `0952d063-eecb-4daa-b929-1596e335d6fc`, model `openai-codex/gpt-5.6-sol:high`. Its feasibility assessment supports a dependency-free Git-only implementation. The two requested policy corrections above are accepted; the proposed capture-lifetime boundary is adopted. W2 receives retained bytes or scanner-owned materializations, never live repository paths as analyzer input. W1 owns explicit cleanup and post-analyzer hash verification.
- Additional index policy: reject unmerged stages as incomplete evidence. Sparse/skip-worktree inputs need an explicit unsupported/partial result unless fixtures establish a documented safe behavior; do not silently substitute an index blob for missing live-worktree content.
- P1 completed in run `0f9b1f72-5dd2-4376-8ff4-56a7a8497185`, model `openai-codex/gpt-5.6-terra:high`. Isolated Windows probes obtained rust-code-analysis `0.0.25`, ast-grep `0.45.3`, jscpd `5.2.0` and investigated Lizard `1.24.0`. No tools were installed globally or added as package dependencies.
- Parent inspected the retained malformed TypeScript output and callable summaries: rust-code-analysis and Lizard return success for malformed inputs, omit Python lambdas, and disagree on definitions. No live complexity adapter is approved. Callable complexity, SLOC and erosion remain unavailable until a separate parse/coverage contract passes; pure measurement/comparison algorithms may still have deterministic fixtures without claiming live scanner support.
- ast-grep `0.45.3` may supply positive review candidates under explicit packaged rules, but parse completeness was not established. Its results must remain partial, including an empty result, and cannot support a clean-code conclusion or complete verbosity proxy. jscpd `5.2.0` may supply token-clone evidence with explicit parameter-specific fixtures, coverage checks, and line unions derived from spans, never its tool-defined duplicated-line statistic. Source-bearing output fields must be discarded.
- W1 contract approved: `collectGitInputs(options, budget)` returns retained before/current captures, line changes, unique rename records, collection compatibility, provenance, coverage and explicit cleanup. Current-only/non-Git collection is also required. `materializeAnalyzerWorkspace(snapshot, selection, budget)` returns scanner-owned paths, report-path mapping, verification and cleanup. Bytes/private paths stay internal; report-safe projections use relative paths, identities, modes, categories, language, byte counts, hashes, capture source and bounded diagnostics. W2 owns schema assembly and never rereads source paths.
- Initial resource contract: overall deadline 60 seconds, with 3 seconds reserved for termination/cleanup; 5,000 selected paths; 64 MiB retained source budget across before/current; 2 MiB per file; 8 MiB analyzer output; 64 KiB retained stderr; 20 divergence examples with total count; one analyzer at a time, no analyzer retries, one capture recollection; at most 23 Git processes and 40 total subprocesses including termination helpers; per-process runtime at most 20 seconds and remaining scan budget. Representative fixtures must verify these bounds. Changes require parent approval and recorded evidence, not silent widening.
- W1 initial integration check: all 15 submitted Node tests passed, but parent-owned temporary reproductions demonstrated four failures: a non-Git file cap reported complete after dropping a file; subdirectory Git scans reported a modification as deletion; nested-directory and bracket-pattern ignores were not honored; a directory junction allowed capture outside the repository. Source inspection also found unbounded batch waits, swallowed termination failures, and reads without enforced byte bounds. These seven accepted integration findings block W1 acceptance and W2 release until corrected and retested.
- Approved bound correction for F3: replace the custom ignore matcher with trusted Git `check-ignore --no-index` against scanner-owned frozen ignore inputs. Raise the fixed Git process ceiling from 18 to 23 to include isolated initialization and both collection/verification attempts. The worker's explicit worst-case budget is 2 setup, 10 first-attempt, 9 second-attempt, 1 isolated diff, and 1 separately counted initialization. Keep the 40 total-process limit and shared deadline. Do not weaken verification to save process slots; fixtures must assert the actual maximum independently of file count.
- W1 checkpoint `d7577db1-7fda-4025-b942-231084e023b1` reported 25 passing tests after F1–F7 corrections. The parent reran all 25 successfully on continuation and inspected the corrected bounds, ignore evaluator and path checks. Original four reproduction cases now have passing regression fixtures. Full safety acceptance remains pending W4 and independent review.
- The workflow `192d4785-d11d-4775-9c85-3bd1a1cc20b1` ended after the parent deliberately paused W2, run `75659536-9271-422f-8d60-0c52438d48c5`, over an unexpected non-empty index. W2 made no edits; W3 was unstarted. This was an intentional ownership pause, not an analyzer or implementation failure. The retained W2 session is resumable.
- The user's subsequent `continue` authorizes further implementation with the existing staged versions preserved. No stage, unstage, reset or commit is authorized. A read-only staged/working patch checkpoint is retained outside the repository. The staged patch SHA-256 is `e7479249910548fc726e71e5c0285c6384f8e82c4fa3f2791c8c03ade06f32b9`. Future worker handoffs must report the expected non-empty index truthfully rather than claim `noStagedFiles: true`. During W4 the cached patch changed again to SHA-256 `b705c7246b63dab7eb6538bb4b55849a2101de0a56702ea0ac5424c8dc011635`; parent inspection found only in-scope versions staged, including its own unchanged plan text, with HEAD unchanged. Preserve such external index-only restaging and continue under the user's continuation instruction. Do not revert it to enforce a stale hash. Stop for unexpected source-content changes, unrelated paths or actual ownership conflicts, not solely because an external actor stages already-owned task edits.
- Continuation order is W4 hardening, parent inspection, retained W2 implementation, parent inspection, W3 documentation/packaging, integrated review and report. W4 is necessary because W1 explicitly omitted several planned lifecycle/race/environment fixtures and source inspection found remaining batch error/close and configurable-limit gaps. No scout or advisory rerun is needed; P1/P2 evidence remains applicable.
- Parent-approved W4 fixes: handle batch spawn/stream errors without uncaught process events; make batch close/abort waits bounded and their failures observed; check Windows tree-termination availability before analyzer execution; honor configured process/output limits throughout Git execution; add the previously omitted safety fixtures. Any additional failure must be reproduced and escalated before changing scope or interfaces.
- W4 completed as `d1e3ceda-384b-468e-8c85-f2626b09dac7`. Parent inspected batch error/timeout/abort logic, limit propagation, tree-termination preflight and new safety fixtures, then independently ran all 36 core tests with `--unhandled-rejections=strict`: 36 passed, none skipped. Staged and unstaged whitespace checks passed. W4 is accepted as W2's dependency, not as a substitute for final independent review.
- W2 is released under the existing reduced analyzer contract. Offline snapshot comparison can compare stored metrics and physical-line totals but cannot reconstruct edit additions/deletions from source-free snapshots. Such edit deltas must be unavailable rather than inferred from net totals; Git `scan` retains exact frozen-byte numstat evidence. Include Git version in compatibility, preserve bounded validation of saved inputs and reject output paths that would replace or enter the selected source scope. Reports remain advisory and source-free.
- Approved W2/W1-seam correction: untracked discovery must prune by the fixed scanner artifact exclusions and requested roots before collecting pathname output, while still finding relevant ancestor/nested `.gitignore` inputs. Do not use live/global Git ignore discovery or raise the 8 MiB output cap. Parent probes reduced this checkout's untracked pathname output to 807 bytes for the package scope and 34,274 bytes with root-level scanner artifact pruning, versus W2's reported 23,951,713 bytes without pruning. Use one canonical exclusion definition for both classification and Git pathspecs, with nested artifact directories excluded consistently. Ignored file counts that were never enumerated must be recorded as unknown/pruned, not invented. Scope and discovery policy remain versioned in compatibility; metadata process counts remain fixed. W2 may make this precise correction in W1's Git/capture/classification modules and add regression fixtures.
- W2 handoff `9aea3718-6402-4c3a-b43f-e2bacc4dbe34` delivered CLI/report/metric modules and optional adapters. Parent reran all 54 current tests successfully. W2 is not finally accepted: parent reproductions show that backslash-form Windows scopes allow output inside selected source directories, a junction ancestor allows report output outside the intended destination, and saved-report validation accepts a negative physical-line total. Source inspection also identifies incomplete whole-command deadline/cancellation propagation, analyzer-integrity checks bypassed on tool errors, and a human summary that omits the available concrete line/AST/clone/dependency contributors. These accepted integration findings need a serialized fix pass and revalidation.
- W3 may proceed with the independently useful Phase 1 workflow correction, documentation drafts, packaging and evaluation fixtures while these named runtime fixes remain pending. It must not normalize the bugs as supported behavior or claim final safety/acceptance. No concurrent runtime writer is allowed. After W3 settles, the parent will arrange the focused W2 fix pass before final package validation and independent reviews. Section 5 remains in this plan until the corrected shipped contract is frozen.
- W3 completed as `9351f85c-1da6-40f7-839f-0d8844b664ad`. Parent inspected the skill, three documentation layers and manifest, and independently ran `npm --prefix pi-skill-code-quality test`: 71 passed, none failed or skipped. Markdown whitespace checks passed. W3 provides routing/packaging checks and three four-step held-out scenario definitions with protected correctness tests; no longitudinal agent campaign was run.
- W3's Bash probe `where.exe pi 2>nul & npm root -g` created a stray empty root `nul` file outside its allowed paths. After provenance was established, the parent verified it was an empty regular file and removed exactly that task-created artifact. No user-authored file or index entry was changed.
- A retained W2 fix pass is approved for parent-verified findings F8–F12: canonical output-scope/ancestor guards, strict saved-report validation, full CLI budget/cancellation, analyzer failure-path integrity, and actionable human contributors. The bounded reproduction/fix packet is retained outside the repository. Exact write boundary is W2 runtime modules and its four tests, with only a private collection-root accessor or shared cancellation plumbing allowed in W1 modules if required; public capture/report paths must remain source-free. W3 documentation and the canonical plan stay parent-owned. All package tests and targeted reproductions must be rerun.
- The retained W2 fix pass completed as `3d1dc18f-e53d-487a-85b6-f133bf0ba360`. It implemented the accepted F8–F12 corrections and added regression fixtures. Parent inspection covered the changed output guards, command lifecycle and validation tests; the parent independently ran the complete package suite: **79 passed, 0 failed, 0 skipped**. General, staged and Markdown whitespace checks passed. Passing these checks is not independent review or final acceptance.
- The user then requested: `update plan and abort work accordingly`. Further implementation, documentation changes, checks beyond this plan update, reviews and report generation were stopped. The subagent fleet reported no active runs.

## 12. Aborted implementation checkpoint

Aborted at the user's request on 2026-09-11. This is an incomplete, unreleased worktree checkpoint, not a rollback or a completion claim. Earlier release permissions and planned next steps in section 11 are historical and must not trigger automatic continuation.

### Retained work and verification

| Area | State at abort |
| --- | --- |
| P1/P2 tool probes and contract challenge | Complete. Real Windows probes support restricted ast-grep and jscpd adapters. Callable-complexity candidates failed the required parse/coverage checks. |
| W1/W4 capture and hardening | Implemented and fixture-tested. Includes raw Git reads, frozen capture, real Git ignore evaluation, bounded subprocesses, source-path checks and instability detection. |
| W2 scanner and F8–F12 fixes | Implemented. `scan`, `snapshot` and `compare`, reports, optional adapters and accepted integration fixes are retained. Final independent acceptance is outstanding. |
| W3 guidance, documentation, packaging and evaluation fixtures | Implemented as drafts pending final integration. The exact publish allowlist, package test command and routing fixture are present. |
| Latest parent-run package suite | `npm --prefix pi-skill-code-quality test`: 79 passed, 0 failed, 0 skipped, on Windows. |
| Packaging and routing | Dry-run package inclusion and routing checks passed during W3. The final package suite also passed its dry-run packaging test. No package was installed or published. |
| Pi skill loading | Explicit skill-path loading through the installed Pi loader passed with zero diagnostics. No interactive slash-command execution or packed-and-extracted installation smoke test was performed. |
| Independent implementation review | Not started: 0 of the required 2 outputs. The earlier contract challenge does not satisfy this gate. |
| Final HTML report | Not created. |

### State preserved

- Branch `main`, HEAD `c06409795dd0f178a1b51306679398a51a340924`.
- Staged, unstaged and untracked task changes remain in place. No staging, unstaging, reset, commit or rollback was performed for the abort.
- Package version remains `0.1.5`; no release, global installation or Pi settings change was made.
- No active subagent remained when the abort was checked. No replacement or review run should be launched automatically.
- Existing managed handoffs and workflow receipts remain available for `192d4785-d11d-4775-9c85-3bd1a1cc20b1` and `43018db2-e514-4ef6-85b5-e18376a314ff`. The latest fix handoff is associated with run `3d1dc18f-e53d-487a-85b6-f133bf0ba360` and the retained `code-quality/scanner-handoff-v2.md` artifact. Earlier W2 output is also preserved in the workflow receipt.
- Isolated analyzer downloads and local checkpoint artifacts remain outside the repository. They were not removed as part of this abort. The verified empty `nul` artifact created by a worker probe had already been removed.

### Unfinished work, only if the user reauthorizes it

1. Reinspect the current staged and working changes before resuming. Treat this checkpoint as evidence, not proof that the workspace is unchanged.
2. Finish independent inspection of F8–F12 and run the two fresh, read-only implementation reviews. Verify and disposition every finding; fix only accepted findings and rerun affected checks.
3. Reconcile documentation with the latest fixes. `DEVELOPMENT.md` still contains pre-fix pending-status text. Restore useful original language configuration blocks as opt-in reference examples, and preserve research versions and qualifications in contributor documentation. These documentation checks were not completed before abort.
4. Finalize one scanner contract: reconcile section 5 with `DEVELOPMENT.md`, then replace the planning copy with a link. This move was deliberately left unfinished.
5. Complete final packaging/path verification and any explicitly approved platform smoke tests. POSIX behavior remains untested; no WSL or other platform installation was authorized.
6. Keep live callable complexity, SLOC, erosion and the verbosity proxy unavailable unless a separately validated adapter establishes coverage. Audit any remaining full-plan requirements against actual code rather than treating a passing test count as full coverage.
7. Keep the longitudinal agent campaign deferred until separately approved. Current scenarios and protected tests do not establish long-term effectiveness.
8. Create and mutually link the final HTML report only after renewed authorization and completion of its evidence prerequisites. Versioning and publication still require separate approval.
