# Development guide: Hyprland Wiki Local for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Pi 1.2 start events

Prompt-based routing skips `before_agent_start` events with `messageType: "custom"`. A loaded Hyprland skill must not trigger setup warnings or abort an unrelated custom-message continuation. User events and legacy events without `messageType` retain normal routing. The repository's `tests/pi-wiki-start-compat.test.mjs` covers this boundary for all five local-wiki extensions.

## Preserved package internals

The first tool call builds the cache through the shared `pi-utils` local-wiki engine. Cache invalidation uses schema version, docs path, page count, and newest source mtime. Markdown parsing uses frontmatter titles and ignores headings inside fenced code blocks.
