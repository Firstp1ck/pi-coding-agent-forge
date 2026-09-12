# Quickshell full-corpus validation checklist

[Current evaluation](full-corpus-evaluation.md) · [Contributor guide](../DEVELOPMENT.md)

- [x] Discover published releases from the official sitemap, including v0.3.1.
- [x] Download all selected Quickshell guides/API pages and core Qt references.
- [x] Preserve original member anchors, warnings, code and source versions.
- [x] Resolve cross-source links and report unavailable optional references.
- [x] Keep setup bounded and preserve the previous snapshot on required-source failure.
- [x] Verify live fresh setup, legacy preservation, version pinning and rollback.
- [x] Cover invalid URLs/versions, lock contention, corruption and offline retrieval in tests.
- [x] Tune expanded-corpus search and evaluate seven realistic retrieval tasks.
- [x] Bundle the Python helper, snapshot reader, skill and contributor tests.

Final build, package, wiki and documentation checks are recorded in the feature plan and implementation report. Publication, Pi enablement, actual widget execution and non-Linux verification are outside this delivery.
