# Migration notes

## 0.1.x to 0.2.0: optional VBA module editing

- Nothing changes unless you use the new tools. `workbook_edit` still preserves VBA byte-for-byte.
- New tools: `workbook_vba_read`, `workbook_vba_edit`. New command: `/workbook-vba [status|enable|disable]`. New setting: `PI_WORKBOOK_VBA_EDITING`.
- VBA editing needs Windows, desktop Excel, and *Trust access to the VBA project object model*. Other platforms report it as unavailable.
- Rollback: run `/workbook-vba disable`, or reinstall 0.1.6. Files written by 0.2.0 are ordinary `.xlsm` workbooks.

## Preview contract to expanded operation matrix

The public workbook contract remains `1.0`. This release is additive: the original value/formula/style/dimension/merge operations keep their exact field shapes, while additional strict operation variants are added to the same discriminated union. Stored calls using the original schema therefore require no argument migration.

### Behavioral hardening

- Unexpected added and removed OOXML parts now fail integrity validation unless the operation explicitly declared each changed part.
- Reads include `displayedValue`, rich-text runs, conditional-format ranges, validation ranges, and hyperlink metadata.
- Inspect results include formula/calculation policy, redacted protection state, VBA inventory, advanced-feature preservation policies, and lazy-storage diagnostics.
- Preview output paths may point to the deterministic cache when `outputDir` is omitted. Consumers must use the returned path rather than assuming a random directory.
- Object-adding operations on `.xlsm` can fail even when the same operation works on `.xlsx`, because byte-identical active-content protection can make `[Content_Types].xml` or relationship parts immutable.
- `copyRange` accepts an optional `sourceSheet` for cross-sheet range templates. Calls without it retain same-sheet behavior.
- Content-changing operations now reject overlap with shared, array, data-table, and dynamic spill formula regions instead of risking partial corruption.

### Removed behavior

No prior accepted operation was removed. Native Excel and Aspose mutation remain unavailable and are never selected as fallback engines.

### Upgrade verification

Run:

```bash
npm run check
npm test
npm run test:excel       # controlled interactive Excel host
npm run test:native      # expected to fail qualification closed
npm run test:pi-modes
npm run pack:dry
```

Always inspect, dry-run, commit with `expectedSha256`, validate, diff, and render focused output after upgrading.
