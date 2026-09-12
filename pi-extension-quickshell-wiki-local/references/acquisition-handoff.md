# Acquisition handoff

Owner: main session, single-agent implementation under the user's explicit waiver. This is not a delegated-worker outcome.

## Delivered

- `scripts/sync_docs.py`: official sitemap release discovery, complete selected Quickshell guide/API inventory, core Qt link closure, text/member/code parsing, bounded downloads, atomic publication, retained snapshots and offline rollback.
- `tests/test_sync_docs.py`: parser, source, selection, storage, recovery and limit fixtures.

## Verification

- Python unit suite: 11 passing tests, exit 0.
- Full live setup: 992 pages for v0.3.1, including all 176 selected Quickshell URLs and 816 Qt pages.
- Pinned live setup: 991 pages for v0.3.0.
- Rollback through the TypeScript wrapper restored v0.3.1 without downloading again.
- One obsolete optional Qt Timer URL returned 404; the required QtQml Timer page succeeded. No required acquisition was omitted.

## Integration contract

Use `<base>.offline/current.json` to select an immutable snapshot. Validate manifest/digest/source inventory before reading. Citation files are relative numbered Markdown files inside that snapshot. Legacy clone contents must not be modified. Downloads run only during explicit setup, never lookup.

Qt and Quickshell versions are independent. Default selection is newest published stable, not the source repository's default metadata and not the installed binary's version. A requested unpublished version fails.

## Limits and residual risks

Four workers, two attempts for transient failures, 30-second requests, 4 MiB response/200 MiB total/1400-page budgets and a roughly 30-minute deadline. No images or browser rendering. Source HTML or sitemap changes can cause a safe setup failure. An interrupted process can leave a stale lock. Published upstream descriptions can still be incomplete.

See [full evaluation](full-corpus-evaluation.md) and [development contracts](../DEVELOPMENT.md).
