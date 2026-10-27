# Development guide: Theme bundle for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Native themes and WebUI metadata

Pi 1.2 validates theme files during startup. Every JSON file under `themes/` uses `https://pi.dev/schemas/theme.schema.json`. Native `export` fields are limited to `pageBg`, `cardBg`, and `infoBg`.

`webui-backgrounds.json` stores the former Catppuccin Mocha and Matrix background-image fields, keyed by theme name. It is published outside the `pi.themes` directory so Pi never loads it as a theme. WebUI merges only its supported background fields into the bundled-theme catalog; native theme files and custom-theme saves remain schema-only.

## Checks

From the package directory in this repository:

```bash
npm test
npm pack --dry-run --json
```

The tests reuse WebUI's shared theme contract to validate all sixteen palettes and check that the separate background metadata is published. Also run WebUI's `tests/theme-contract.test.mjs` and `tests/http-endpoints-harness.test.mjs` when changing the catalog integration. For a host upgrade, validate the palettes with that Pi release's native theme validator as well; the shared browser contract alone cannot prove upstream compatibility.
