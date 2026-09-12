# Quickshell offline documentation reference

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Requirements

Pi with TypeScript extension support and Python 3.10 or newer. Python uses only its standard library. Setup needs HTTPS access to `quickshell.org` and `doc.qt.io`; retrieval does not.

Linux was tested with Node.js 22, Python 3.14 and Bun 1.4 for contributor checks. Other platforms have not been exercised. Git is no longer required for setup.

## Coverage

Setup downloads every guide, module and type-reference page listed for the selected Quickshell release on the official website. This covers the core toolkit, IO/IPC, widgets, services and compositor integrations published for that release.

It also downloads the current Qt 6 QML, Quick, Controls and Layouts indexes, then follows linked in-scope QML/Quick documentation. This includes common controls, layout behavior, properties, signals, methods and code examples. The evaluated collection contained 8 Quickshell guides, 168 API pages and 816 Qt pages. Counts can change upstream.

Not included: screenshots, videos, style assets, executable examples, arbitrary Qt C++ modules, third-party shell docs or every linked external service manual. This is an agent-readable text collection, not a fully rendered website mirror.

Individual upstream API members can say "No details provided". The package preserves that gap rather than inventing behavior. A correct-looking component still needs runtime testing against the user's installed libraries.

## Commands

| Command | Purpose |
| --- | --- |
| `/quickshell-wiki-local-setup` | Discover and download the newest published stable Quickshell docs and current core Qt references |
| `/quickshell-wiki-local-setup --version v0.3.1` | Download a particular published Quickshell documentation version instead |
| `/quickshell-wiki-local-setup --version latest` | Explicitly choose newest published stable docs, overriding an environment pin for this download |
| `/quickshell-wiki-local-setup --rollback` | Restore the preceding validated snapshot without downloading anything |
| `/quickshell-wiki-status` | Show availability, source versions, source counts, download timestamp, storage and unavailable optional Qt links |
| `/quickshell-wiki-smoke-test` | Check guide/API/Qt retrieval, exact sections, links and output bounds without network access |
| `/skill:quickshell-local` | Load the documentation workflow explicitly |

Setup reports progress in Pi. A fresh download or refresh takes several minutes. It does not refresh automatically at startup or during lookup. Run setup whenever you want to check for newer documentation.

The six model tools search, list sections, extract, read, follow links and run the smoke test. Exact integration contracts are in [DEVELOPMENT.md](DEVELOPMENT.md#tool-contracts).

## Version selection

The default is the newest stable documentation release published on the official Quickshell site, compared numerically. A newer installed Quickshell binary does not prove that a matching documentation release exists. Conversely, repository metadata can omit a release that the website already publishes.

The original package followed the website repository's `v0.3.0` default. The expanded setup instead found the separately published `v0.3.1` docs. It no longer relies on that repository default or a hard-coded version.

`master` can be requested explicitly, but setup fails if the site does not publish it. It never silently substitutes stable documentation for an unavailable development version.

Qt documentation comes from the current `qt-6` channel, independently of the selected Quickshell version. Its advertised version is reported separately. Some Qt pages advertise a minor version such as `6.11`, while others advertise `6.11.2`.

Check `quickshell --version` and the installed Qt version before applying new APIs. Setup does not change installed software. When an environment pin disagrees with the active snapshot, lookup reports the mismatch rather than mixing releases.

## Configuration and storage

Set environment variables before starting Pi:

| Variable | Default | Purpose |
| --- | --- | --- |
| `QUICKSHELL_DOCS_PATH` | `~/.quickshell-docs` | Documentation base path; the new collection is stored beside it with an `.offline` suffix |
| `QUICKSHELL_DOCS_VERSION` | `latest` | Optional persistent Quickshell documentation pin |

For the default base path, the new collection lives in `~/.quickshell-docs.offline/`. A legacy Git clone at `~/.quickshell-docs/` is left intact. Fresh installations do not need that clone or even an existing base directory.

Relative base paths resolve against Pi's startup working directory. A leading `~/` is accepted. Restart Pi after changing its launch environment. A command-line version override changes the downloaded snapshot, not the environment; remove a conflicting environment pin before querying it.

Each successful setup keeps a new snapshot and retains earlier snapshots. The active and preceding snapshots support rollback. There is no automatic pruning. Repeated updates therefore use additional disk space. Do not edit generated snapshot files; their contents and inventory are checked for consistency.

## Migration and offline transfer

After updating the package, reload Pi and run setup. It creates the new collection beside the old checkout and switches retrieval only after the download succeeds. It does not pull, reset, clean or overwrite the old repository.

Before migration, the old guide-only collection remains readable with a visible coverage warning. An invalid active snapshot is reported as an error, not silently replaced with legacy guides.

To transfer the full collection offline, copy the entire `<base>.offline` directory and point `QUICKSHELL_DOCS_PATH` at the corresponding base on the destination. Keep the directory name relationship intact. Run status and smoke test after copying. The legacy clone is optional.

Only documentation retrieval becomes offline. A cloud-backed Pi model still needs its own network connection; a separately configured local model is needed for a fully offline conversation.

## Update safety and limits

- Only official Quickshell and Qt HTTPS documentation locations are fetched. Redirects outside the allowed source boundaries are refused.
- Setup fetches at most four pages concurrently. Per-response, total-download, page-count and runtime limits prevent an unbounded crawl.
- Current limits are 4 MiB per response, 200 MiB total response data, 1400 documentation pages and roughly 30 minutes overall. Limits are not exposed as user settings.
- A failed required download, parse error or exceeded limit prevents activation of the new snapshot. An existing active snapshot remains selected.
- Missing nonessential Qt links returning 404 or 410 are reported separately. Required Qt pages and every selected Quickshell guide/API page must succeed.
- Only one setup runs against a collection at a time. If an interrupted process leaves a `.setup-lock` directory, inspect it and confirm that no setup is running before removing that lock. Do not delete snapshots to clear a lock.
- Rollback validates the retained snapshot before selecting it. It does not access the network.

## Privacy and licensing

Downloads do not execute upstream scripts, install dependencies, load QML or read your desktop configuration. Lookups use the local collection and an in-memory index. Downloading and version discovery happen only during setup.

Retrieved text and local citation paths can be sent to your configured model provider. The package contains the downloader and skill, not redistributed upstream documentation. Downloaded Quickshell and Qt content retains its upstream licensing; the package's MIT license does not relicense that content.

## Troubleshooting

**Still seeing guide-only coverage.** Reload the updated package, run setup, then inspect status. Having the legacy clone alone does not provide the full API or Qt reference.

**Requested version is not published.** Use `latest` or one of the releases listed in the error. A Git branch or binary patch release is not necessarily a published documentation channel.

**HTTP error or interrupted download.** The existing snapshot remains usable. Retry later. If there is no prior snapshot, complete setup before relying on full offline coverage.

**An optional Qt link is unavailable.** Inspect the reported URL and search for the current type. The evaluated site linked to an obsolete `qml-qtquick-timer.html`; the correct Qt QML Timer reference was downloaded successfully.

**A member has no explanation.** That can be an upstream documentation gap. Inspect installed `.qmltypes`, matching source code or official supporting documentation, and keep uncertainty explicit.

**No matching section.** List headings first and use the exact title or original member anchor. An empty match returns empty text, not the whole page. Parent sections do not automatically include child sections.

**Output is omitted or truncated.** Narrow the query or use a specific property/method anchor. Search defaults to five results, section lists to 40 headings, extracts to three sections and 6000 characters, and reads to 8000 characters. Read/extract text has a 12000-character maximum.
