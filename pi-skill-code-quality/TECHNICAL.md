# Technical reference: Code Quality

Advanced user commands, optional tools, compatibility, privacy, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Always-applied writing behavior

When enabled, code-quality instructs Pi to apply its writing practices whenever it creates or edits code in permanent files. This includes one-line fixes, tests, scripts, notebook code, configuration-as-code and retained code examples. Permanent means intended to survive the task, whether tracked by Git or not. A scratch prototype enters this scope when it is saved for ongoing use.

Code improvement is part of an authorized coding task, not a separate review requiring another cleanup approval. Pi should improve the code it writes within your requested scope, preserve existing work and verify affected behavior. Explicit review-only requests still prohibit edits. Prose-only work and code shown only in chat do not require this skill.

Apply the practices on every code-writing task, but scale the effort. Small edits need a focused inspection and relevant verification, not mandatory snapshots, analyzers or a formal report. Extra cleanup beyond the requested implementation is limited to one focused pass on at most three confirmed findings. Broader work needs approval.

This is an agent instruction, not runtime enforcement. The package registers no file-write hook and cannot guarantee model invocation. `/skill:code-quality` explicitly loads it when automatic selection misses it. Optional scanner execution is separate from applying the writing practices.

## Requirements and platform status

The optional local scanner runs with Node.js. Git comparisons need a trusted Git executable. The current-only `snapshot` operation can collect a scoped filesystem observation when Git is unavailable, with limitations reported in its coverage.

Current verification distinguishes the Git-only scanner from optional structural tools. The Git-only capture and report path has current Linux evidence. That evidence does not establish general POSIX support or any structural-analyzer behavior. Earlier Windows evidence covered the pinned structural-tool contracts, but it is historical and was not rerun in the current Linux validation.

The scanner never installs optional tools. It also does not run project tests, linters, formatters, builds, or repository scripts. Run those only through the skill workflow when the request authorizes them.

## Scanner commands

These are command-line operations, not new Pi slash commands. `/skill:code-quality` explicitly loads the writing workflow in Pi; ordinary permanent-code tasks should invoke the skill without needing that command. Replace `<installed-skill-dir>` with the installed `skills/code-quality` directory, run the command from the repository you want to inspect, and choose paths appropriate to that repository.

### Compare a Git baseline with the current worktree

```bash
node <installed-skill-dir>/scripts/scan.mjs scan --base HEAD --scope src --format human
```

`scan` requires `--base <commit>` and one or more `--scope <root>` options. It combines eligible staged and unstaged worktree changes. Add `--include-untracked` only when those files belong in the requested review. It does not assume a branch name, fetch a baseline, or make an index-only comparison.

### Capture the current scoped observation

```bash
node <installed-skill-dir>/scripts/scan.mjs snapshot --scope src --format json
```

`snapshot` requires one or more `--scope <root>` options and does not accept `--base`. It is useful when you need a current observation rather than a Git comparison.

### Compare saved observations

```bash
node <installed-skill-dir>/scripts/scan.mjs compare --before reports/s0.json --after reports/s2.json --format human
```

`compare` accepts only `--before <saved-report>` and `--after <saved-report>`, plus `--format` and optional `--out`. It does not recapture source or rerun analyzers. Compatible saved observations can compare current physical-line totals, but cannot reconstruct Git edit churn.

### Options shared where supported

- `--format json|human` selects stdout format. The default is `human`.
- `--out <new-report>` writes one explicit, new report file as well as stdout. It is create-only and is rejected when it would replace an existing file or enter the selected source scope. Without `--out`, the scanner writes no persistent report.
- `--include-untracked` is available to `scan` and `snapshot`, not `compare`.
- `--git <trusted-path>` selects Git for `scan` and `snapshot`.
- `--ast-grep <trusted-path>` and `--jscpd <trusted-path>` opt into the corresponding structural adapter for `scan` and `snapshot`.

Unknown flags and incompatible operation options fail rather than being ignored. The scanner returns `0` after producing a report and `2` for rejected input or collection failure. Its diagnostics are intentionally redacted.

## What a report can show

Git-backed scans can show raw physical-line additions, deletions, and net change by category, plus direct npm dependency manifest changes when captured `package.json` files are valid. Physical lines count LF-delimited raw bytes, including a final line without a newline. They are not source lines of code.

The scanner may also show optional AST-pattern candidates and token-clone evidence when their selected adapter completes with stated coverage. Optional findings are inspection prompts, not automatic fixes or clean-code certificates.

Callable complexity, analyzer-defined SLOC, callable trend deltas, erosion, and the combined verbosity proxy are currently unavailable. Do not read their unavailable state as zero complexity, zero clones, or a passing quality gate. See [measurement guidance](skills/code-quality/references/measurement-guide.md) for how to interpret partial and unavailable evidence.

## Optional structural tools

Provide an explicit direct executable path outside the reviewed checkout. The scanner does not search for, install, or run arbitrary local shims. The retained pins are Windows x64-only. No live optional analyzer ran in the current Linux validation, so their Windows-pinned paths remain unavailable there:

| Tool | Tested version | What it supplies | Important limit |
| --- | --- | --- | --- |
| ast-grep | 0.45.3 | Direct `console.log` candidates for JavaScript and TypeScript, and direct `print` candidates for Python | Parse completeness is unestablished, so every result is partial, including no findings. |
| jscpd | 5.2.0 | Token-clone spans for JavaScript, TypeScript, and Python | Coverage depends on the selected formats and configured source counts. |

The adapters use scanner-owned settings and frozen copies. A missing, unsupported, untrusted, malformed, timed-out, or input-modifying tool produces unavailable or partial evidence. It does not produce an empty clean result.

## Scope, compatibility, and limits

Use the same scope roots, tool selection, and options for snapshots you plan to compare. Saved reports with different compatibility settings are rejected rather than compared as if they measured the same thing. Capture consistency or incomplete coverage also blocks a no-regression conclusion.

The fixed limits are 60 seconds for the complete operation with 3 seconds reserved for cleanup, 5,000 selected files, 64 MiB retained bytes, and 2 MiB per file. A subprocess gets at most 20 seconds and no more than the remaining operation budget. Analyzer stdout is capped at 8 MiB and retained stderr at 64 KiB. The scanner retains at most 20 divergence examples, runs one analyzer at a time with no analyzer retry, allows one capture recollection, and caps Git and total subprocesses at 23 and 40. Saved reports are capped at 4 MiB. Contributor and metric rows are capped at 1,000, and human summaries list at most 20 contributors.

These are limits, not quality thresholds. A capped or incomplete result stays partial.

## Privacy and side effects

The scanner makes no network requests, sends no telemetry, executes no repository scripts, and does not modify reviewed source files or the Git index. It uses temporary scanner-owned material only when needed and removes that material after use. Saved reports contain relative metadata, hashes, measurements, and bounded diagnostics rather than captured source bytes, raw analyzer output, environment contents, full stderr, or absolute private paths.

Optional analyzers are executable code. Select them only when you trust the exact executable. Their use is opt-in and does not authorize project checks or cleanup.

## Troubleshooting

- **`invalid-cli-options` or exit code 2:** supply the operation's required options. `scan` needs `--base` and `--scope`; `snapshot` needs `--scope`; `compare` needs both saved reports.
- **No Git baseline is available:** use a current-only `snapshot` and report that a Git trend comparison is unavailable.
- **A report says partial, unavailable, incompatible, or inconsistent:** inspect its reason and coverage. Do not turn it into a clean result or compare it as a complete baseline.
- **An optional tool is unavailable:** verify the direct executable path, platform, and pinned version. Do not use an install-capable wrapper as a workaround.
- **`--out` is rejected:** choose a new report path outside the selected source roots. The scanner will not overwrite a prior report.
- **The report is too large or a limit is reached:** narrow the requested scope. Do not increase the fixed limits without a documented compatibility change.

For the implementation contract, test coverage, evaluation protocol, and release-acceptance status, see [DEVELOPMENT.md](DEVELOPMENT.md).
