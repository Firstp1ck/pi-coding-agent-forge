# Historical guide-only evaluation, version 0.1.0

This report describes the initial guide-only implementation. It is not the current coverage or verification record. See [the full-corpus evaluation](full-corpus-evaluation.md) for version 0.2.0.

Correction: repository metadata was insufficient to determine published documentation releases. The official site publishes v0.3.1 even though the repository's `versions.json` omits it. The updated setup uses the website's sitemap, not that file.

[Contributor guide](../DEVELOPMENT.md) · [README](../README.md)

## Result

The package passed 17 deterministic tests, six source-backed retrieval simulations, nine smoke checks, a fresh download and an update of that checkout. Confidence is **93/100 for offline usage-guide retrieval**, not complete Quickshell API coverage or a browser-rendered documentation mirror.

The current implementation is a lightweight, isolated adaptation of the local-wiki template. Success criteria were a downloadable official source, explicit coverage and version reporting, useful bounded retrieval, safe manual setup, and an npm package containing its matching skill. No existing wiki package or shared parser was changed. No package was published or enabled in Pi settings.

## Corpus profile

| Property | Observed value |
| --- | --- |
| Official website | https://quickshell.org/docs/ |
| Download source | https://github.com/quickshell-mirror/quickshell-web.git |
| Default local destination | `~/.quickshell-docs` |
| Evaluated commit | `3490deb23c60615bfeeebda1811d883df9438e29` |
| Commit timestamp | `2026-08-20T19:46:28-07:00` |
| Evaluation date | 2026-09-12 |
| Format | Markdown and text-only MDX, YAML title frontmatter |
| Physical guide files | 11 |
| Selected release | `v0.3.0` from `versions.json` |
| Selected inherited pages | 8 |
| Source directories | `src/guide/v0_1_0`, `v0_2_0`, `v0_3_0` |
| Other declared versions | `master`, `v0.2.0`, `v0.1.0` |
| Excluded | Repository READMEs, site implementation, assets, generated type data |
| Includes/components | No include expansion or MDX execution; raw reference markers remain visible |

Upstream `src/config/io/guides.ts` establishes oldest-to-newest guide inheritance. The selected installation and QML language guides come from `v0_2_0`; unchanged introductory, sizing and FAQ pages remain in `v0_1_0`. Advanced options and distribution use `v0_3_0`.

The website's `src/config/io/generateTypeData.ts` expects generated module JSON through `VERSION_FILE_PATH`. The checkout's version entries refer to `./modules`, but that directory is absent. A plain clone is therefore sufficient for guides, not a full type-reference build. The older `quickshell-docs` repository describes a Hugo/Rust build and is not used as the current guide source.

Local context also verified the Quickshell entry in the Hyprland Wiki's Status bars page. The ArchWiki applications page provided related desktop-shell context, not a substitute for Quickshell's own docs.

## Changes driven by evidence

- Added frontmatter titles and a synthetic introductory section. The generic template would otherwise use filenames or an unrelated first H1 and could discard opening warnings during extraction.
- Selected inherited guides by release. Indexing all 11 physical files would mix duplicate old and new setup, language and distribution content.
- Scoped discovery to guide files, excluding website implementation and repository READMEs.
- Resolved `@docs/guide/...` links against the selected release and reported missing `@docs/types/...` references explicitly.
- Removed generic `Scope` and `Variants` routing triggers. Tests show that unrelated scope, QML and compositor prompts remain untouched.
- Made absent section matches return empty text, rather than the template's whole-page fallback.
- Preserved code fences, indentation and source markers without executing examples.
- Replaced persistent caching with a memory cache for eight pages. The signature includes every selected file, not just the newest modification time.
- Kept read and extract text within 12000 characters and added result/section/link omission counts.

### Corpus-specific search tuning

The initial novice query included `on`, which matched words such as Introduction and Position. Ignoring it reduced the second-place irrelevant result from score 71 to 4 after the combined tuning changes.

All eight selected guides mention Quickshell. Weighting `quickshell` at 0.15 preserves literal topic-only searches while reducing its contribution to unrelated matches. Other domain words remain at full weight; no Arch or Hyprland stopword list was copied.

The initial `process -> StdioCollector` expansion put Introduction first for the architecture question and FAQ second. Removing that expansion, together with the broad-term tuning, put the FAQ first. The skill still recommends `Process StdioCollector` explicitly when program-output handling is actually the topic. `qmlls -> language server` comes directly from the installation guide.

## Simulation results

Each simulation ran `search -> sections -> exact section extract` against the cloned corpus. Prompts and exact queries are retained in `tests/evaluate.ts`. Scores below are reviewer judgments of evidence quality, not statistical accuracy measurements or live-model success rates. Each selected guide ranked first.

Byte counts include serialized JSON, citation and coverage metadata. Character counts measure extracted text only. Every section list and extract below had zero omissions and no truncation.

| Level and query | Selected source and heading | Headings listed | Search bytes | Sections bytes | Extract chars / bytes | Matched sections | Accuracy / effectiveness / token output |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Novice: `how do I install Quickshell on Arch` | `v0_2_0/install-setup.md`, Arch | 19 | 1163 | 2040 | 656 / 1283 | 1 | 95 / 94 / 96 |
| Beginner: `Quickshell bar PanelWindow anchors` | `v0_1_0/introduction.md`, Creating Windows | 9 | 1132 | 1306 | 868 / 1536 | 1 | 94 / 93 / 96 |
| Intermediate: `Quickshell childrenRect binding loops` | `v0_1_0/size-position.md`, childrenRect and binding loops | 7 | 1154 | 1182 | 1263 / 1983 | 1 | 95 / 94 / 96 |
| Advanced: `Quickshell process per widget` | `v0_1_0/faq.md`, Should I use a process per widget | 19 | 1130 | 2519 | 133 / 792 | 1 | 95 / 94 / 96 |
| Expert: `Quickshell pragma Env DefaultEnv` | `v0_3_0/advanced.md`, Environment | 16 | 1131 | 1908 | 1000 / 1737 | 2 | 93 / 92 / 94 |
| Developer: `quickshell qmlls language server` | `v0_2_0/install-setup.md`, Language Server | 19 | 1149 | 2040 | 1000 / 1659 | 1 | 95 / 94 / 96 |

The expert guide has two headings named Environment. Both are returned, with levels 4 and 2 visible, and neither is omitted. One covers pragmas and the other lists additional variables. This modest duplication is documented rather than silently dropping source material.

### Top five search results

1. **Novice:** Installation & Setup 63.8; Introduction 4; Usage Guide 3.05; FAQ 1.8; Item Size and Position 1.8.
2. **Beginner:** Introduction 39; Item Size and Position 17.8; QML Language 10.5; FAQ 3.8; Usage Guide 3.05.
3. **Intermediate:** Item Size and Position 45.8; QML Language 21.5; Introduction 10; FAQ 1.8; Installation & Setup 1.8.
4. **Advanced:** FAQ 55.8; Introduction 45; Item Size and Position 29.8; QML Language 21.5; Advanced Options 7.8.
5. **Expert:** Advanced Options 43.8; Installation & Setup 5.8; Introduction 5; QML Language 3.5; FAQ 1.8.
6. **Developer:** Installation & Setup 56.8; QML Language 41.5; Introduction 14; Usage Guide 5.05; FAQ 4.8.

## Verification

- `npm test`: 17 passing deterministic tests.
- Real-corpus evaluation: all six expected guides and decisive passages found; every canonical guide ranked first.
- Smoke test: nine checks passed, covering five searches, headings, guide links, exact extraction and bounded reading.
- Legacy selection: `v0.1.0` retrieves the original QML guide instead of the `v0.2.0` MDX replacement.
- Related links: inherited QML links resolve; missing PanelWindow and Process type-reference links remain visible.
- Fresh setup: actual Git download to a new temporary destination succeeded with Git LFS asset downloads skipped. Eight guides were indexed.
- Update: running setup again succeeded without a reset, clean or overwrite.
- Safety fixtures: wrong origin and dirty checkout were refused before a network pull; offline snapshots were used without running their package scripts.
- Package checks: TypeScript no-emit check, Bun build, lockfile-only dependency check, npm pack dry-run, local Markdown links and whitespace checks.

The generic validator checks for an implementation function literally named `executeSetup`, not only the registered command. The first validation failed because the equivalent function was named `setupDocs`; it was renamed to retain template-validator compatibility without changing setup behavior.

## Remaining caveats

- Full generated type-reference coverage is absent. API questions outside tutorials need official online docs or a matching local source checkout. General Quickshell API completeness is not scored at 90 or above.
- These are deterministic retrieval simulations, not autonomous model conversations. Pi registration and routing were exercised through a test adapter; interactive TUI use and an npm-installed session were not exercised.
- GitHub clone and update worked. Direct HTTP fetching of one official hosted documentation URL returned 403 during discovery, so no hosted HTML mirror is claimed.
- Text-only MDX, upstream type markers and reference-style Markdown links are not rendered. The npm package does not redistribute the upstream guides.
- Some upstream advanced-option snippets show mismatched pragma names. The skill warns against applying those examples without verification.
- Search uses substrings, so lower-ranked results can still be noisy. Use distinctive terms and exact headings.
- Deliberately preserved size and mtime can evade cache invalidation until reload. Only Linux was exercised.

Final scoped scores: **accuracy 94/100, effectiveness 93/100, token output 96/100**. Overall confidence: **93/100**.
