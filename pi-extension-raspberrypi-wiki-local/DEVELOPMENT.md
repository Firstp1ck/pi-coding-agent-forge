# Development guide: Raspberrypi Wiki Local for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Pi 1.2 start events

Prompt-based routing skips `before_agent_start` events with `messageType: "custom"` before inspecting prompt text or checking the local corpus. User events and legacy events without `messageType` retain normal routing. The repository's `tests/pi-wiki-start-compat.test.mjs` covers this boundary for all five local-wiki extensions.

## Development checks

```bash
validate_wiki /home/firstpick/pi-coding-agent-forge/pi-extension-raspberrypi-wiki-local
npm install --package-lock-only --ignore-scripts
npm pack --dry-run
bun build index.ts --target=node --outfile=/tmp/raspberrypi-wiki-local-index-check.js
```

A lightweight registration/smoke check can be run with Bun by loading `index.ts` into a fake Pi extension API and calling the registered tools.

## Additional implementation details

Corpus-specific tuning lives in `index.ts`. Keep query expansion, stop-word/downweight rules, parser behavior, and smoke-test expectations synchronized when the documentation corpus changes.
