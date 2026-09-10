# Technical reference: Stop Slop

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Runtime and installation

Requires Node.js 20+ on Windows, macOS, or Linux. There are no third-party runtime dependencies, API keys, model downloads, or configuration files. Unslop is optional.

Install the skill through Pi:

```bash
pi install npm:@firstpick/pi-skill-stop-slop
```

If you only need a standalone CLI, you can install the same package through npm:

```bash
npm install --global @firstpick/pi-skill-stop-slop
```

Pi's package installation does not promise to expose npm binaries on your shell's PATH. The skill resolves and runs its own bundled checker. You do not need a global npm install for that path.

## Commands

```bash
slopcheck README.md
slopcheck draft.txt --format text --json
slopcheck revised.md --baseline original.md --json
slopcheck revised.md --baseline original.md --max-score 30 --fail-on-regression
slopcheck README.md --ignore SLP030
slopcheck --rules
```

Omit the filename, or use `-`, to read UTF-8 text from stdin. Only one current input and one baseline are supported per invocation. A baseline is a text file, not a JSON report. Comparisons rerun both texts with the same version and settings.

| Option | What it does |
| --- | --- |
| `--json` | Prints a machine-readable report instead of the readable summary. |
| `--baseline <file>` | Compares the current input with the original prose in this file. |
| `--format markdown\|text` | Chooses the input format for both texts. Default: `markdown`, regardless of file extension. |
| `--ignore <IDs>` | Disables comma-separated rule IDs in both texts. Unknown IDs are errors. |
| `--max-findings <N>` | Shows at most N findings, from 0 to 10,000. Default: 200. Counts and scores still include all matches. |
| `--max-score <N>` | Fails when the current overall score is greater than N, from 0 to 100. Equality passes. There is no default score gate. |
| `--fail-on-regression` | Fails when the overall score increased or comparison was not possible. Requires `--baseline`. It does not gate individual categories. |
| `--timeout-ms <N>` | Limits each input read to N milliseconds, from 1 to 60,000. Default: 10,000. |
| `--rules` | Lists rule IDs and descriptions, then exits. Can be combined with `--json`. |
| `--help` | Shows usage without reading input. |
| `--` | Treats following arguments as a filename, including names starting with `-`. |

Exit codes:

- `0`: evaluation completed and requested gates were met.
- `1`: a gate failed, the input or baseline had no prose, or all rules were ignored.
- `2`: invalid options, unreadable or oversized input, invalid UTF-8, a read timeout, or another execution error.

Errors go to stderr. With `--json`, stderr errors are JSON too. Reports go to stdout. Redirection is optional; never redirect a report onto its input file because the shell would overwrite the draft before the checker reads it.

## Reading the scores

The overall score and eight category scores are penalties from 0 to 100. Lower means fewer patterns under these rules. None is an AI probability, authenticity rating, or guarantee of good writing. A null score means the text could not be scored or the category was disabled, not that it passed.

The categories cover formulaic phrases, rhetoric, repeated openings and transitions, adverb candidates, em dashes, sentence-length uniformity, passive-voice candidates, and vague emphasis or absolute claims. Findings distinguish literal matches, heuristics, and statistical checks.

Raw counts and rates provide context. For example, an em-dash count is exact within the evaluated text, while an adverb count is a candidate count based on a word list and suffixes. Passive voice is also a candidate count, not a parser's grammatical verdict.

Short inputs are weak evidence. Texts under 100 words receive a warning and use a length floor for several penalties. Repeated-opening checks need six sentences. Rhythm needs six sentences and 60 words; before that, its score is zero and the report says it was not assessed. No-prose input does not pass.

There is no universal passing score. Choose a target for your audience and preserve useful wording even when it is flagged. A score of 30 can be a local review target, but this package does not claim that 30 separates good writing from bad writing.

## Revision comparisons

Negative deltas mean fewer measured patterns. Check category changes and counts as well as the overall result. A lower total can hide more vague wording or a change in sample size. Rhythm becoming eligible or ineligible is reported as a comparison warning.

Keep the ruleset, format, and ignored rules fixed. If your house style permits em dashes, `--ignore SLP030` makes that exception explicit. Do not disable a rule solely to pass a check. Disabled categories no longer contribute to the overall score, so results from different settings should not be compared as if they used the same scale.

The comparison cannot validate meaning. Review the diff for lost facts, weakened safety warnings, changed numbers, invented evidence, and damaged quotations. The skill defaults to at most three revision passes rather than chasing a zero score.

## Input coverage and limitations

Both inputs must be UTF-8 and no larger than 1 MiB each. Local regular files and stdin are supported; directories and special files are rejected. There is no recursive directory scanning, PDF/DOCX extraction, remote fetching, or automatic rewriting.

Markdown mode excludes common fenced code blocks, lines indented by four spaces or a tab, same-line inline code, closed initial YAML frontmatter, HTML comments, tags, URLs, reference-link definitions, and ordinary inline-link destinations. Visible link labels, headings, lists, and blockquotes remain prose. An unclosed fenced block excludes the remainder of the file.

This is not a complete Markdown renderer. Nested-list text indented as code is excluded; multiline inline code, complex HTML, escaped delimiters, and link destinations over 2,047 characters may not be handled as you expect. Markdown markers inside words can interrupt phrase matches. Review the excerpts and word count. Use `--format text` or select a prose-only excerpt when the Markdown exclusions are wrong for your input.

Sentence boundaries use punctuation and Markdown block boundaries, with a small abbreviation exception list. Soft line wraps do not normally create sentences, but headings and list items can. Abbreviations, unusual punctuation, and tables can distort rhythm and passive percentages.

English is the only intended language; language is not detected automatically. A low score on another language is not meaningful. The evaluator does not judge authenticity, whether claims have evidence, every kind of false agency, arbitrary three-item lists, or whether a sentence "sounds human." It makes no optional LLM calls.

## Privacy and side effects

The CLI reads only the specified input and baseline, makes no network calls, and writes reports only to stdout or stderr. It does not create caches or modify drafts. It never executes text from an input.

Reports include exact source excerpts. Your terminal, redirected files, CI logs, and agent sessions may retain them. When an agent reads the report, its configured model may receive those excerpts. Local evaluation is not a promise that the surrounding agent session is offline.

## Updates and troubleshooting

Pin a package version when results are part of a repeatable gate. On update or rollback, rerun the baseline and revision together. Do not compare scores from old saved reports with a new ruleset. Keep baseline drafts outside the installed package so an update cannot replace them.

- **Command not found:** ask Pi to use the checker bundled with the loaded skill, or use the optional standalone npm installation above.
- **No prose or fewer words than expected:** check Markdown exclusions and retry with a prose-only excerpt or `--format text`.
- **False positives:** preserve required wording and document the exception. Use `--rules` to find a specific rule to ignore when the house style calls for it.
- **Truncated findings:** increase `--max-findings`. Counts and scores already include the hidden matches.
- **Timeout:** finish the stdin stream or check the file source before raising `--timeout-ms`.
- **Scores fall after deleting content:** check the word-count change and the actual diff. The checker cannot tell whether the deletion removed necessary information.

## Attribution

The phrase and structure guidance comes from Hardik Pandya's MIT-licensed [stop-slop](https://github.com/hardikpandya/stop-slop). This package adds its own deterministic scoring rather than reproducing upstream's subjective five-dimension rating. See [LICENSE](LICENSE) for notices and [DEVELOPMENT.md](DEVELOPMENT.md) for the pinned source and implementation contracts.
