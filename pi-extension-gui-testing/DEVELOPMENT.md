# Development guide: GUI Testing for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Status

The package is a scaffold. `index.ts` registers nothing yet.

## Design

The approved design is [plans/planned/gui-testing-spec.md](plans/planned/gui-testing-spec.md). It defines the backends, the setup and check framework, the helper protocol, the data lifecycle and cleanup rules, and the milestone order. Implement it milestone by milestone and move the spec to `plans/archive/` once every milestone is verified.

## Checks

```bash
npm run check
```
