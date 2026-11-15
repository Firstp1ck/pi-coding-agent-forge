# Provider-grouped model picker

User asks for a hierarchical Choose model list: provider first, newest release first where reliable metadata exists, otherwise alphabetical. This is a bounded presentation improvement; selection scope and application behavior stay unchanged.

## Contract

- Provider groups sorted alphabetically, models nested under accessible provider headings. Search matches provider/model/name and keeps matching group context. No forced current-first reorder across groups; retain current badge and initial keyboard highlight.
- Within each provider, models with valid explicit releaseDate or release_date (ISO calendar date or timezone-qualified ISO timestamp) sort newest first; undated models follow alphabetically by display name, then ID. If no valid dates exist, the whole group is alphabetical. Date ties resolve alphabetically. Do not infer release chronology from version numbers, IDs, context windows or registry iteration order. Show release dates only when valid metadata exists.
- Preserve original model objects, provider and ID exactly, input array ordering, saved scoped-model order, request target guards, retry/error behavior and keyboard navigation. No metadata network requests or provider calls introduced.
- Sol worker owns public/model-catalog-order.mjs and tests/model-catalog-order.test.mjs only. Export groupModelCatalog(models): [{provider, models}], with original model references; export modelReleaseDate(model): YYYY-MM-DD or null. Parent owns app integration, accessible grouped list rendering/styles and actual-app browser cases after concurrent Settings worker settles. No parallel app.js writer.
- Pure tests: unsorted multi-provider list, dated/undated/tied/malformed values, calendar validation, fallback order, stable input/reference preservation. Parent: actual fake-Pi app grouping/search/current/keyboard/apply identity, long names and narrow layout, screenshots. Independent Sol review max two rounds; parent fixes findings. Cache/inventory/docs coordinated with concurrent UI work.

## Round-one disposition

Accepted BUG-001: a three-line provider heading covered the keyboard-highlighted model at 320px. Parent reproduced the exact failure: heading bottom 355.265625, title top 341. Provider headings now remain in normal flow, scoped only to grouped model catalogs, so their height cannot obscure options. No measured-height dependency or fixed clearance is needed. Added a thirty-model ArrowUp regression after desktop-to-320px resize. All eight model hierarchy/selection browser cases passed after the fix, including failed selection retry and stale-catalog ownership. Screenshot inspected. Final round two is limited to this fix and direct regressions.
