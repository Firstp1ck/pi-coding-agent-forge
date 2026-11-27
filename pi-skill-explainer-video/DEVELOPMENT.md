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
- Target rects are measured with the scene camera temporarily removed, then restored. Inverting a rounded camera transform caused sub-pixel seek-order drift. The browser capture helper also rebuilds raster layers before screenshots to prevent Chromium from reusing text layers from a previous zoom.
- Steps overlap by `CROSSFADE` (0.5 s): each fades in over the 0.25 s before its start and out over the 0.25 s after its end.
- `clampCamera` keeps the scene covering the area above the caption band, with a 60 px margin that falls inside the stage mask's fade.

## Validation rules

Errors block rendering (unless `--force`): schema shape, unknown scenes or images, times outside a step, malformed rects, 2–6 steps in clip format or at least two in episode format, 3–12 s per step, captions over 14 words, an outro without a one- or two-line title. With `--force` the renderer still computes the length from the valid steps.

Clip limits cap a clip at 80 s. Episode format removes the maximum step count while retaining shot duration and motion validation.

Warnings are advice: 3–5 steps, captions over 10 words, bold lead over 4 words, missing full stop, jargon and filler words (lists in `storyboard.mjs`), static steps, missing outro, total over 45 s. `allowTerms` suppresses jargon warnings per storyboard.

## Tests

```bash
cd pi-skill-explainer-video
npm test                     # unit and real-browser/media integration tests
npm run validate:example     # the Pacsea example passes --strict
node skills/explainer-video/scripts/render.mjs skills/explainer-video/examples/pacsea/pacsea.json \
  --no-video --sheet out/sheet.png   # end-to-end smoke test, needs a browser and ffmpeg
```

The package suite includes browser and encoded-media checks when Chromium, FFmpeg and ffprobe are installed. The contact-sheet command adds a visual smoke check after changing the engine, player or renderer.

Routing fixture check from the repository root:

```bash
node dev/scripts/validate-skill-routing-fixtures.mjs
```

## Style source

The visual rules reproduce five T3 Code 0.1.12 release clips posted on X in November 2026 (1920x1080, 30 fps, 21–36 s, silent). `references/style.md` records what was measured from them. Keep that file in sync if the look changes.

## Production tools

The renderer delegates headless Chromium lifetime and CDP to `scripts/lib/browser.mjs`. `layout.mjs` inspects every encoded frame in forward, reverse and deterministic shuffled order. Actual caption geometry is checked against frame bounds, active spotlights and declared `avoid` rectangles, with 1 px overlap/continuity tolerance and 0.02 opacity visibility threshold. Up to 60 screenshots are compared across seek orders. Only the primary step is inspected during a crossfade. Failures are grouped with timestamps in the optional JSON report.

`scripts/lib/sheet.mjs` selects reading holds, adds numbered timestamp/title labels and paginates after 32 shots. Assembly decodes these selected frames from the final encoded delivery. Overview mode retains its 12 evenly spaced frames.

`scripts/assemble.mjs` owns local assembly. `delivery.mjs` derives or validates chapters, escapes FFmetadata, produces descriptions, compares source fingerprints and file identities, and checks ffprobe results. `proc.mjs` bounds child execution and cleanup. Supplied audio is encoded to 48 kHz AAC; video is copied. Verified staged files replace destination files with the MP4 last. A rename failure can leave earlier sidecars replaced; the error names them.

The master comment stores SHA-256 over storyboard JSON, scene HTML, engine/player code, dimensions/fps, direct step images and outro logo. Assembly requires it to match. Nested scene HTML image/font dependencies are not fingerprinted. Re-render after those change. Existing unfingerprinted masters must be re-rendered.

`chapters` is validated by assembly, not the general validator. The optional `description` field adds the learning summary before the timestamp list. Explicit chapters start at zero and increase within the encoded duration; section steps supply defaults. Final verification requires H.264, exact dimensions/fps/frame count, AAC duration within 0.03 s when supplied, and chapter starts/ends within 1 ms.

New behavior lives in `sections.test.mjs`, `inspect.test.mjs`, `layout.test.mjs`, `delivery.test.mjs` and `assemble.test.mjs`. Tests use real Chromium and media tools where available, exercise obstructed captions, seek order, pagination, stale masters, bad chapters, short audio and aliasing, and verify earlier outputs survive validation/process failures. Run the full package suite after renderer or delivery changes. Missing browser/media tools cause integration skips and must be reported.

The fictional Stockroom example under `examples/stockroom/` is a 64-second, 24 fps fixture. Its independent expected outcome is Sample box changing from 4 to 6. `score.mjs` writes original stereo PCM. The retained delivery and decoded stills live under repository `dev/videos/explainer-video-sample/`; see that folder's README for rebuilding.

Frame-boundary selection uses `firstFrameAt` to find the first encoded frame whose actual `frame / fps` time reaches an edit. It intentionally avoids epsilon-rounding a cut earlier than the player. Closing black uses `round(total * effectiveFps) - 1`, including renderer frame-rate overrides, so fractional-duration exports end on black. Section cuts clear captions and all earlier key badges. Two-line captions reserve a 48 px badge column even for a hidden number; badge text stays on one line, with room for three digits. Regression fixtures cover all these cases and verify the sample click against the actual item-row bounds.

Delivery edge regressions normalize chapter boundaries to MP4 milliseconds before producing description timestamps, escape multiline global metadata values, resolve dangling output symlinks before any write, and require finite target padding. Source audio must cover the shorter of storyboard and encoded video duration within 10 ms. The filter resets timestamps, pads the fractional final frame and trims decoded audio to the delivered duration. Regression checks include real encoded metadata titles and fractional-duration soundtrack assembly.
