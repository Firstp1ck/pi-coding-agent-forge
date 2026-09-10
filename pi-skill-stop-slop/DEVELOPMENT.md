# Development guide: Stop Slop

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Scope

This package adapts [hardikpandya/stop-slop](https://github.com/hardikpandya/stop-slop) into a read-only, deterministic prose linter and a portable revision workflow. It has no Pi extension, automatic hook, external NLP library, LLM evaluator, or runtime dependency. Loading the skill does not itself execute the checker.

Upstream's subjective directness, rhythm, trust, authenticity, and density scores are not reproduced. The evaluator scores observable patterns and labels grammar candidates as heuristics. Meaning preservation stays outside the score.

## Source and attribution

The upstream snapshot is pinned to commit [`8da1f030185bdfe8471220585162991eaeb970e9`](https://github.com/hardikpandya/stop-slop/tree/8da1f030185bdfe8471220585162991eaeb970e9).

`skills/stop-slop/references/upstream/PROVENANCE.json` records the source paths and SHA-256 digest of each bundled file. The original `SKILL.md` is stored as `SKILL.md.txt` so Pi does not discover a second skill. Reference files are flattened into that snapshot directory without changing their bytes. Relative links inside the original text still describe the upstream layout; the adapted skill links to the bundled locations.

The snapshot retains upstream's MIT license and copyright notice. The package license credits Hardik Pandya and Firstpick. `.gitattributes` preserves snapshot and fixture bytes across checkouts.

The pattern vocabulary in `scripts/rules.mjs` derives from upstream's phrases and structures. A few supplemental phrases cover the requested general prose checks, such as "it is important to note," "significantly improves," and "seamlessly integrates." The repeated-transition and repeated-opening statistics are additions. Not every upstream prohibition is implemented. Arbitrary false agency, vague claims beyond listed phrases, all three-item lists, narrator distance, punchy endings, and authenticity require judgment. Upstream examples are historical context, not semantic-preservation fixtures.

## Source layout

All runtime paths below are relative to `skills/stop-slop/`:

- `SKILL.md` defines the portable evaluate/revise/compare workflow and a separate Pi adapter.
- `scripts/rules.mjs` owns rule IDs, phrase vocabulary, heuristic patterns, weights, constants, and the ruleset version.
- `scripts/text.mjs` masks common Markdown syntax, normalizes match text without shifting offsets, tokenizes words, segments sentences, and resolves source positions.
- `scripts/analyzer.mjs` exports analysis and comparison functions and constructs deterministic reports.
- `scripts/slopcheck.mjs` handles bounded UTF-8 input, argument validation, rendering, and exit codes.
- `references/evaluation.md` explains interpretation and editorial limits.

`test/` lives at the package root and is excluded from the npm tarball. The `skills/` directory works when copied alone; runtime code does not read the parent package manifest. Tests and contributor commands stay here rather than in the user reference.

## Analysis flow

1. Validate the source type, 1 MiB UTF-8 byte limit, format, ignored rule IDs, and finding limit.
2. Mask excluded Markdown characters with NUL placeholders, preserving CR and LF and every UTF-16 offset. Plain-text mode skips masking.
3. Fold ASCII capitals, straight/curly apostrophes, and nonbreaking spaces without changing length. Avoid general Unicode lowercasing because it can expand characters. Phrase separators accept spaces, tabs, or one soft line break, but not blank paragraphs.
4. Tokenize Unicode letters and numbers, internal apostrophes, and hyphens. Matching vocabulary remains English. This is not automatic language detection.
5. Split prose on sentence punctuation and selected Markdown block boundaries. Soft wraps remain within sentences. A small abbreviation list suppresses some false splits. Headings and list items can count as sentence units.
6. Collect phrase, rhetorical, punctuation, lexical, and sentence-statistic findings. Deduplicate identical rule/span pairs and sort by start offset, end offset, then rule ID using code-unit order, not locale sorting.
7. Count all findings, calculate metrics and scores, then materialize the first `maxFindings` excerpts. Truncation does not change scores or counts.

The Markdown masker is intentionally smaller than CommonMark. It covers fences, same-line code spans, indented lines, closed initial YAML frontmatter, comments, tags, ordinary links, reference definitions, and URLs. Inline destination scans are bounded to 2,047 characters after the opening delimiter. Code masks prevent phrase and rhetorical regexes from bridging hidden text. Tests cover exclusions and exact offsets; the user reference lists unsupported cases.

Inputs are data. No draft text is passed to a shell or evaluated as code. Human-readable output escapes terminal controls in excerpts and filenames. Runtime code uses only Node built-ins and performs no network calls. File handles are checked for regular-file status; POSIX nonblocking open avoids waiting on a FIFO before rejection. A timer bounds stream consumption, not an operating-system filesystem open/stat call. Stdin and file streams are destroyed on success and failure. CLI input decoding rejects malformed UTF-8 and preserves a BOM for source hashing and offsets.

## Rule catalog

`RULES` in `scripts/rules.mjs` is the canonical executable rule catalog. `--rules` renders its IDs, names, kinds, and suggestions.

| ID | Category | Check |
| --- | --- | --- |
| SLP001 | formulaic | Listed filler and announcement phrases |
| SLP002 | formulaic | Listed business-jargon candidates |
| SLP003 | formulaic | Listed meta-commentary |
| SLP004 | vague | Listed performative emphasis |
| SLP010 | rhetoric | Bounded binary-contrast patterns, including some adjacent-sentence pivots |
| SLP011 | rhetoric | Repeated negative listing |
| SLP012 | rhetoric | Listed rhetorical setups |
| SLP013 | rhetoric | Wh- sentence openings |
| SLP014 | rhetoric | Runs of at least three sentences containing at most three words each |
| SLP015 | rhetoric | Listed false-agency and narrator-distance phrases |
| SLP020 | adverbs | An explicit word set plus ASCII `-ly` candidates with a common non-adverb exception set |
| SLP021 | vague | Listed vague declaratives and intensifiers |
| SLP022 | vague | Listed absolute words such as "always" and "everyone" |
| SLP030 | punctuation | Em-dash occurrences |
| SLP040 | repetition | Repeated listed transition words at sentence starts, beyond the first occurrence |
| SLP041 | repetition | Repeated first words in at least 40% of six or more sentences, with at least three occurrences; counts beyond the first |
| SLP050 | rhythm | Low whole-text sentence-length coefficient of variation, when sample requirements are met |
| SLP060 | passive | Forms of "be," up to two optional modifiers, then an `-ed` word or listed irregular participle |

Fragment runs do not bridge paragraph breaks or masked code. Their finding spans the first three sentences in the run. Rhythm has one finding spanning the first three sentences as an illustration; its statistics cover the whole evaluated text. Distinct rules may overlap, for example a vague-intensifier phrase and an adverb candidate in the same passage. Count those as separate measured patterns, not separate editorial defects.

## Scoring contract

Scores are penalties, rounded to two decimal places and clamped to 0..100. There is no default pass threshold.

Let `W = max(wordCount, 100)` and `S = sentenceCount`. Most phrase categories sum `ruleCount × rule.points × 100 / W`. Per-match points live in the rule catalog: filler 12, jargon 6, meta-commentary 10, performative emphasis 10, binary contrast 12, negative listing 12, rhetorical setup 8, Wh- opening 3, fragmentation 8, false-agency phrase 6, vague phrase 12, absolute word 3.

Special categories use these formulas before clamping and rounding:

| Category | Penalty | Overall weight |
| --- | --- | --- |
| formulaic | Sum of active phrase penalties | 20 |
| rhetoric | Sum of active rhetoric penalties | 15 |
| repetition | `100 × (SLP040 count + SLP041 count) / max(S, 6)` | 15 |
| adverbs | `1000 × active adverb candidate count / W` | 10 |
| punctuation | `2000 × active em-dash count / W` | 10 |
| rhythm | `100 × (1 - CV / 0.25)` when CV < 0.25, otherwise 0 | 10 |
| passive | `200 × sentences with active passive candidates / max(S, 5)` | 10 |
| vague | Sum of active vague-language penalties | 10 |

CV is population standard deviation divided by mean sentence length. Rhythm requires at least six sentences and 60 words; otherwise its penalty is zero and `rhythmAssessed` is false. The overall score is the weighted mean of active category scores. A category with every rule ignored is null and excluded from the weight denominator. With no prose or no active categories, the overall score is null. Unavailable rhythm remains zero rather than being reweighted; reports warn about that limitation.

Raw metrics retain candidate counts even if the corresponding rules are ignored. Rule counts and findings include enabled rules only. Changing the finding display limit does not change scores. Adding unrelated prose can dilute several rates, so comparisons expose word-count changes and the skill prohibits padding to pass.

The constants are policy choices, not statistically validated boundaries between good and bad writing. Any change to tokenization, exclusions, matching, counts, scoring, or ordering that alters results must bump `RULESET_VERSION` and update tests. Output-shape changes must also consider `schemaVersion`.

## JavaScript API and report contracts

The npm package exports `analyze`, `compareTexts`, `RULES`, `RULESET_VERSION`, and `MAX_BYTES`:

```js
import { analyze, compareTexts } from '@firstpick/pi-skill-stop-slop';

const report = analyze("Here's the thing: save the file.", {
  format: 'markdown',
  ignore: ['SLP030'],
  maxFindings: 200,
});
const comparison = compareTexts('The file was saved by Mara.', 'Mara saved the file.');
```

`analyze(source, options)` accepts a JavaScript string. Options default to `{ format: 'markdown', ignore: [], maxFindings: 200 }`; limits and unknown rule IDs throw. Repeated ignored IDs are deduplicated and sorted. The CLI's strict UTF-8 validation applies to byte inputs, not JavaScript strings.

A report has these fields:

- `schemaVersion: 1` and `rulesetVersion` identify the output shape and measurement policy.
- `scoreMeaning` states what the scores do and do not mean.
- `input` holds `sha256`, UTF-8 `bytes`, and `format`. The SHA-256 covers the original source, not masked prose. It is a reproducibility identifier, not an anonymization control.
- `settings` contains the normalized analyzer options, including the display limit.
- `metrics` holds word/sentence counts, adverb density, em-dash frequency, passive sentence percentage, repeated-opening/transition counts, and sentence-length mean, standard deviation, CV, and `rhythmAssessed`.
- `scores` contains `overall` and the eight named `categories`.
- `rules` lists every rule with `id`, `category`, `enabled`, and `count`.
- `strongestIssues` lists up to three nonzero categories by descending score, with catalog-order tie breaking and matched rule IDs. This is not a semantic severity ranking.
- `findingsTotal` counts all enabled matches. `findings` contains the bounded displayed subset.
- `warnings` contains stable code/message pairs for no prose, short samples, unavailable rhythm, ignored rules, no active rules, and truncated findings.

A finding contains `ruleId`, `category`, `kind`, `message`, `start`, `end`, `text`, and `suggestion`. Kinds are `literal`, `heuristic`, or `statistic`. Position objects have zero-based UTF-16 `offset` and one-based `line`/`column`. The end is exclusive. Columns count UTF-16 code units, not visual terminal cells; tabs are one unit and emoji can be two. For every finding:

```js
source.slice(finding.start.offset, finding.end.offset) === finding.text
```

`compareTexts(beforeText, afterText, options)` returns `{ before, after, comparison }`. It reanalyzes both raw inputs rather than trusting old report files. `comparison` contains:

- `outcome`: `decreased`, `increased`, `unchanged`, or `not-comparable`;
- `overallDelta`, `categoryDeltas`, and `ruleCountDeltas`, computed as after minus before;
- `wordCountDelta`, `sentenceCountDelta`, and `rhythmAssessmentChanged`;
- `meaningPreserved: 'not-assessed'`.

A score delta is null when either score is null. JSON contains no filenames, timestamps, platform names, random IDs, or timings. With unchanged strings, settings, runtime behavior, and ruleset, serialization order and output are stable. CLI JSON uses two-space indentation and a final newline. Readable output includes the user-supplied filename. JSON errors go to stderr as `{ "error": { "message": "..." } }`; there is no partial stdout report on read or validation failure.

## Development and verification

No dependency install or build step is needed:

```bash
cd pi-skill-stop-slop
npm run check
npm test
npm pack --dry-run --json --ignore-scripts
```

Run the checker from the repository without installing it:

```bash
node pi-skill-stop-slop/skills/stop-slop/scripts/slopcheck.mjs pi-skill-stop-slop/test/fixtures/after.md --baseline pi-skill-stop-slop/test/fixtures/before.md --json
```

To try the local skill in Pi, use `pi install ./pi-skill-stop-slop` from the repository root. This changes Pi's package settings; it is optional, not a test prerequisite.

Tests cover every rule, clean prose, source spans with CRLF and Unicode, Markdown exclusions, short and empty inputs, option validation, deterministic repeated runs, pinned fixture scores, comparisons and regressions, truncation independence, generated score bounds, UTF-8 and size errors, file immutability, stdin timeouts, special-file rejection on POSIX, copied-skill portability, provenance digests, skill discovery, package metadata, and local documentation links. Windows skips the POSIX FIFO case.

The regression fixture measures a drop from 15.77 to 0.94 under ruleset 1.0.0. The remaining adverb candidate in the revision is "rather," retained for its contrast between saving and previewing. This fixture is not a claim that all lower scores preserve meaning.

Before release, inspect an actual tarball as well as the dry run. Confirm that it includes the CLI, all runtime modules, skill references, all three documentation layers, and the licenses. Tests and user drafts must not be bundled. Extract it to a temporary directory, run the CLI there, and confirm npm's bin entry points to an executable script. Publishing and global installation require separate authorization; creating the package does not publish it.

From the repository root, run the documentation whitespace check:

```bash
git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'
```
