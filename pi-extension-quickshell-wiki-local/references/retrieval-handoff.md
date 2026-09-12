# Retrieval handoff

Owner: main session, single-agent implementation under the user's explicit waiver. This is not a delegated-worker or independent-review outcome.

## Delivered

- `snapshot.ts`: snapshot consistency, file/source/version boundaries and immutable cache.
- `index.ts`: full-corpus loading, original member anchors, source-aware search and related links, setup/rollback invocation, version/coverage reporting and legacy warning path.
- TypeScript tests: retained guide coverage plus snapshot, source, rank, version, offline, corruption and argument regressions.
- `tests/evaluate.ts`: seven realistic guide/API/Qt retrieval simulations.

## Verification

- TypeScript/Bun suite: 27 tests.
- Real-corpus simulations: seven canonical documents ranked first; all exact extracts were untruncated with zero omitted sections.
- Full-corpus smoke test: 17 passing checks.
- TypeScript no-emit check: exit 0.
- Live Node setup bridge downloaded the full corpus beside an existing legacy clone without changing its Git status.

The Python suite and additional packaging/document checks are part of central integration, not credited as independent review.

## Important contracts

Lookups do not contact the network. Results distinguish `docsVersion` from per-page `sourceVersion`, expose `sourceUrl`, and cite immutable local Markdown paths. Sources are `quickshell-guide`, `quickshell-api` and `qt`. Exact type names outrank substring-only matches; exact anchors allow narrow property/method extraction.

An active snapshot takes precedence over legacy guides. Explicit version mismatch and corrupt snapshot errors do not silently fall back. Legacy guide-only mode remains readable until migration succeeds and clearly requests expanded setup.

## Remaining risks

Upstream members can have no semantic explanation. Newest references may exceed installed versions. Snapshot files must not be edited. Runtime widget behavior and interactive Pi UI remain untested.

See [full evaluation](full-corpus-evaluation.md) for measured sizes, ranking evidence and caveats.
