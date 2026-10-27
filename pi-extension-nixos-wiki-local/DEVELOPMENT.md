# Development guide: Nixos Wiki Local for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Pi 1.2 start events

Prompt-based routing skips `before_agent_start` events with `messageType: "custom"`. A loaded NixOS skill must not trigger setup warnings or abort an unrelated custom-message continuation. User events and legacy events without `messageType` retain normal routing. The repository's `tests/pi-wiki-start-compat.test.mjs` covers this boundary for all five local-wiki extensions.

## Mock tests

These tests use local fixture docs and do not require NixOS:

```bash
cd pi-extension-nixos-wiki-local
bun tests/mocktest.ts
```
