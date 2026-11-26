# Development guide: Explainer Video

Contributor-only implementation, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Layout

| Path | Role |
| --- | --- |
| `skills/explainer-video/SKILL.md` | Agent workflow |
| `skills/explainer-video/assets/engine.js` | Frame engine. Classic script in the browser (`globalThis.ExplainerVideo`), CommonJS in Node for tests |
| `skills/explainer-video/assets/player.html` | Page template with `__TOKEN__` placeholders |
| `skills/explainer-video/scripts/lib/storyboard.mjs` | Loading, validation and page assembly, shared by both CLIs |
| `skills/explainer-video/scripts/validate.mjs` | Validator CLI |
| `skills/explainer-video/scripts/render.mjs` | Renderer CLI |
| `skills/explainer-video/examples/pacsea/` | Reference example and test fixture |
| `skills/explainer-video/tests/` | `node:test` suite |
| `../tests/routing/explainer-video.json` | Routing fixture (repository-level, not published) |

## How rendering works

1. `buildPage` reads `player.html` and replaces every token in one regex pass, so a token inside user content is never expanded. The storyboard JSON is inlined with `<` escaped. A `<base href>` points at the storyboard folder so relative image paths resolve.
2. The renderer writes the page to a temporary directory, starts the browser with `--headless=new --remote-debugging-port=0` and a throwaway profile, reads `DevToolsActivePort`, and talks to it over Node's built-in `WebSocket` (flattened target sessions).
3. For each frame it calls `window.__EV.seek(t)` and `Page.captureScreenshot`, and pipes the PNG into `ffmpeg -f image2pipe`.
4. Cleanup (browser, ffmpeg, temp directory, partial MP4) runs in `finally` and on SIGINT/SIGTERM. The browser starts in its own process group and the whole group is stopped, because a Chromium helper that outlives the main process can recreate the profile folder after it is deleted. Every DevTools command has a 30 s timeout and browser start has 20 s.

The page is a single file because Chromium refuses ES module imports from `file://` URLs.

## Engine invariants

- `seek(t)` is a pure function of `t`. Every frame resets touched elements to their template state (`innerHTML`, `className`, inline opacity/transform) and replays `setup` plus all actions with `at <= t`. This is what lets the renderer capture frames in any order and lets stills match video frames exactly.
- No CSS transitions or animations in the player. Motion comes only from the engine; a CSS transition would make frames depend on wall-clock timing.
- Rects given as `{target}` are measured each frame from `getBoundingClientRect()` and converted back to scene coordinates with the camera transform applied in the previous frame. The result does not depend on that transform, so the camera can follow an element that moves.
- Steps overlap by `CROSSFADE` (0.5 s): each fades in over the 0.25 s before its start and out over the 0.25 s after its end.
- `clampCamera` keeps the scene covering the area above the caption band, with a 60 px margin that falls inside the stage mask's fade.

## Validation rules

Errors block rendering (unless `--force`): schema shape, unknown scenes or images, times outside a step, malformed rects, 2–6 steps, 3–12 s per step, captions over 14 words, an outro without a one- or two-line title. With `--force` the renderer still computes the length from the valid steps.

The step and duration limits cap a video at 80 s (6 × 12 s plus an 8 s outro), so there is no separate total-length error.

Warnings are advice: 3–5 steps, captions over 10 words, bold lead over 4 words, missing full stop, jargon and filler words (lists in `storyboard.mjs`), static steps, missing outro, total over 45 s. `allowTerms` suppresses jargon warnings per storyboard.

## Tests

```bash
cd pi-skill-explainer-video
npm test                     # unit tests (engine maths, validator, page assembly)
npm run validate:example     # the Pacsea example passes --strict
node skills/explainer-video/scripts/render.mjs skills/explainer-video/examples/pacsea/pacsea.json \
  --no-video --sheet /tmp/sheet.png   # end-to-end smoke test, needs a browser and ffmpeg
```

The end-to-end render is not part of `npm test` because it needs a browser and ffmpeg. Run it after changing the engine, player or renderer, and look at the sheet.

Routing fixture check from the repository root:

```bash
node dev/scripts/validate-skill-routing-fixtures.mjs
```

## Style source

The visual rules reproduce five T3 Code 0.1.12 release clips posted on X in November 2026 (1920x1080, 30 fps, 21–36 s, silent). `references/style.md` records what was measured from them. Keep that file in sync if the look changes.
