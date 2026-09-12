# Development guide: Quickshell docs local

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Scope and sources

Version 0.2 replaces guide-only setup with published-site acquisition. The ArchWiki and Hyprland packages remain the model for local-first search, bounded extraction and citations. No shared wiki engine or sibling package is changed.

Quickshell release discovery uses `https://quickshell.org/sitemap-index.xml` and its bounded child sitemaps. All `/docs/<selected-release>/guide/` and `/types/` URLs are downloaded. Numeric semantic-version ordering chooses the newest stable release. An explicit published version overrides it; `master` is not a fallback.

The source repository's `versions.json` is not authoritative for published releases. In the evaluated state it advertised default `v0.3.0` and omitted `v0.3.1`, while the site's sitemap already listed v0.3.1. The earlier repository-only diagnosis was incomplete.

Qt acquisition starts with QML, Models, Quick, Window, Controls and Layouts pages under `https://doc.qt.io/qt-6/`. Discovery follows linked `qml-qtquick-*`, `qml-qtqml-*`, basic `qml-<type>.html`, `qtqml*` and `qtquick*` pages. Example-project download pages and unrelated Qt C++/other-module graphs are excluded. The documented closure, not all of Qt, defines Qt coverage.

## Source map

- `index.ts`: Pi registration, setup invocation, Markdown sections, legacy loading, search/extract/related and smoke checks.
- `snapshot.ts`: immutable snapshot loading, path/source boundaries, digest and inventory validation, source-version checks and cache.
- `scripts/sync_docs.py`: standard-library HTTP downloader, constrained redirects, sitemap selection, HTML-to-text conversion, publication, lock and rollback.
- `skills/quickshell-local/SKILL.md`: component-oriented source selection, diagnostics, version checks and safety.
- `tests/wiki.test.ts`: retained guide/parser/routing tests and setup argument tests.
- `tests/snapshot.test.ts`: new source, snapshot, lookup, integrity, offline and version-boundary tests.
- `tests/test_sync_docs.py`: acquisition/parser/version/lock/failure/rollback fixtures.
- `tests/evaluate.ts`: seven source-backed guide/API/Qt retrieval simulations and smoke checks.
- `references/full-corpus-evaluation.md`: measured full-corpus results and caveats.
- `references/evaluation.md`: historical guide-only evaluation, retained with an explicit correction notice.

## Local installation and checks

Review the package before enabling it. When authorized:

```bash
pi install /absolute/path/to/pi-extension-quickshell-wiki-local
```

From the package directory, with Pi's peer packages available through normal module resolution:

```bash
npm test
npm run test:corpus -- /path/to/documentation-base
tsc --noEmit --allowImportingTsExtensions --module nodenext --target es2022 --skipLibCheck index.ts snapshot.ts
bun build index.ts --target=node --packages=external --outfile=/tmp/quickshell-index-check.js
npm install --package-lock-only --ignore-scripts --legacy-peer-deps
npm pack --dry-run --json
```

The full corpus must first be downloaded to `/path/to/documentation-base.offline`. Contributor tests require Bun and Python; runtime setup needs Python 3.10 or newer, while retrieval runs in Pi. Lockfile-only installation skips scripts and avoids resolving a second Pi installation for host-provided peers.

Direct helper verification:

```bash
python3 scripts/sync_docs.py --root /tmp/quickshell-test.offline
python3 scripts/sync_docs.py --root /tmp/quickshell-test.offline --version v0.3.0
python3 scripts/sync_docs.py --root /tmp/quickshell-test.offline --rollback
```

The helper prints progress to stderr and a final JSON result to stdout. These commands download documentation; unit tests use injected HTTP fixtures instead.

## Storage and publication contract

`QUICKSHELL_DOCS_PATH` remains the documentation base for compatibility. New storage is its `.offline` sibling, leaving an existing guide clone untouched. There is no Git pull, reset, clean, stash, migration delete or upstream build execution.

Storage consists of `current.json` and immutable `snapshots/<32-hex-id>/` directories. A snapshot contains:

- `manifest.json`: schema/parser versions, selected Quickshell release, advertised Qt versions, selection mode, timestamp, source counts, discovered Quickshell inventory count, transfer bytes, optional unavailable Qt URLs, SHA-256 and coverage description.
- `pages.json`: normalized documents with `title`, `sourceUrl`, `source`, `version`, `text`, `links` and a relative `file` name.
- Numbered `.md` citation files containing the same text plus source and version headers.

`current.json` contains `schemaVersion`, `snapshot` and `previous`. The helper validates a new snapshot before atomically replacing the active pointer using a same-directory temporary file. The previous pointer remains active after a failed acquisition. Snapshot files are not pruned automatically.

An exclusive `.setup-lock` directory scopes concurrent setup and rollback to the storage root. Normal completion/failure removes the owned lock. An abrupt termination can leave a stale lock for manual inspection; the code never guesses that another process is dead.

Rollback validates the prior snapshot, then swaps the active and previous identifiers without network access. Both snapshots remain on disk. Incomplete newly created snapshot directories are removed only when allocated by the failing invocation and not yet published.

Validation checks pointer identifiers, relative numbered filenames, allowed source origins/paths, source-kind/version consistency, unique sources/files, source counts, page count and a SHA-256 of `pages.json`. Symlinked storage entries and citation files are refused. Publication and rollback additionally verify citation text against the normalized records. The hash checks consistency, not cryptographic authentication of the publisher.

Readers keep a cache keyed by active snapshot and manifest/pages file sizes and mtimes. Snapshots are immutable; do not edit generated files. Deliberately preserving size/mtime can hide an edit until reload. A corrupt active snapshot fails explicitly instead of silently falling back to guide-only data.

## HTTP bounds and source failures

Only HTTPS `quickshell.org` sitemap/document paths and `doc.qt.io/qt-6/*.html` are accepted. URLs with credentials, queries, unsafe path components or unsupported ports are refused. Redirects are validated before following them; cross-host redirects are rejected. Documentation redirects to a different page are not silently accepted as equivalent content.

The downloader uses four workers, a 30-second request timeout, at most two attempts for transient network errors and HTTP 429/5xx, a 4 MiB response ceiling, 200 MiB aggregate response ceiling, 1400-page ceiling and a 30-minute overall deadline checked between batches. The Node wrapper has a 31-minute subprocess limit and a 1 MiB captured-output cap. Setup does not execute downloaded scripts or QML.

Every selected Quickshell guide/API page and required Qt seed/type page must download and parse. An optional linked Qt page may be unavailable with HTTP 404/410; that URL and status remain in the manifest/status. Other errors prevent publication. The evaluated corpus has one obsolete Qt Timer link; the valid `qml-qtqml-timer.html` reference is required and present.

## Parser contract

Python's `HTMLParser` builds a bounded-depth element tree. Quickshell extraction uses the `data-pagefind-body` container; Qt extraction uses the article content. Navigation, sidebars, scripts, styles, SVG icons and control chrome are excluded. Missing title/content or unexpectedly short document text fails parsing.

Headings retain original IDs in Markdown `{#anchor}` suffixes. Quickshell `typedata-root` members become individual headings containing member names/signatures and their original anchors. Details, warnings, parameter descriptions and read-only flags remain. Tables retain row/cell separation. Code fences preserve indentation, decode entities and choose a fence length that cannot collide with embedded backticks.

`index.ts` strips explicit heading suffixes from display titles while retaining their anchors. Exact title or anchor matching takes precedence over substring matching. Sections are flat; parents do not implicitly include their children. No-match extraction returns empty text and zero matches.

Rendered sources no longer expose source-only `@@Type` markers in examples. Legacy Markdown can still contain them. The parser does not correct upstream mistakes or invent explanations for members labeled "No details provided".

## Retrieval and search

Search spans three sources: `quickshell-guide`, `quickshell-api` and `qt`. Source filtering narrows queries without changing the active snapshot. Qualified Quickshell slugs such as `Quickshell.Services.Pipewire/PwNodeAudio`, exact titles, returned paths and source URLs are valid page references. A unique short type name is accepted; ambiguous short names require a returned path.

Scoring retains the template's title/slug/heading/text weights. Exact type-name matches receive a bonus so Slider outranks RangeSlider and all-members pages, and the SystemTray singleton outranks its module listing. Broad `quickshell`, `qt` and `qml` terms are downweighted based on observed corpus noise. The minimal generic stopwords and documented aliases remain explicit in `CONFIG`.

Cross-source related links resolve normalized upstream URLs against the downloaded inventory. Missing eligible references are counted and bounded. Unrelated external references are not downloaded or represented as local evidence.

## Tool contracts

All six tools return a JSON text content block and the corresponding structured object in `details`.

| Tool | Parameters |
| --- | --- |
| `quickshell_wiki_search` | `query`, optional `source`, `limit` 1-50, `includeSnippets`, `includeDetails` |
| `quickshell_wiki_sections` | `page`, optional `maxSections` 1-100 |
| `quickshell_wiki_extract` | `page`, optional `section`, `query`, `maxChars` 1000-12000, `maxSections` 1-25, `minTokenMatches` 1-50, `requireAllTerms` |
| `quickshell_wiki_read` | `page`, optional `maxChars` 1000-12000 |
| `quickshell_wiki_related` | `page`, optional `limit` 1-50 |
| `quickshell_wiki_smoke_test` | Empty object |

Retrieval metadata includes collection `docsVersion`, `mode` and `coverage`; page results add `source`, `sourceUrl`, `sourceVersion`, `title` and local `path`. Reads and extracts include citations and truncation metadata. Extracts expose matched sections and omission counts. Search and related results also report omitted entries.

Status adds acquisition timestamp, source counts, Qt versions, snapshot ID, selection mode and optional missing Qt links. The legacy loader continues to report `legacy-guides` with a setup warning. Unknown pages, mismatched pinned releases and corrupt snapshots become explicit tool errors.

The three command names are unchanged. Setup now accepts either `--version <latest|published-version|master>` or `--rollback`. No custom list UI is introduced; Pi supplies native command discovery and tool rendering.

## Verification and review boundaries

The user explicitly waived the complex workflow's delegated implementation and independent-review gates because the session lacked subagents. Main-agent integration, self-review and tests remain separate from independent review; none is claimed.

Acquisition and retrieval handoffs are retained in `references/`. The full evaluation documents seven real-corpus simulations, output sizes, missing-source caveats and source-grounded scores. The implementation plan and final HTML report record the waiver, decisions, integration checks and remaining limits. Interactive TUI behavior, npm publication, actual widget execution and non-Linux platforms remain unverified unless later evidence is added.
