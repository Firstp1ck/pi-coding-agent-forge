# Technical reference: Explainer Video

Commands, options, requirements and troubleshooting for people who run the renderer themselves or want to edit a video by hand.

[Back to the README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Requirements

| Tool | Version | Used for |
| --- | --- | --- |
| Node.js | 22 or newer | the validator and renderer |
| Chromium, Google Chrome, Brave or Microsoft Edge | any recent release | drawing each frame, headless |
| ffmpeg and ffprobe | with libx264 and AAC | encoding and verifying the MP4 and contact sheets |

The package has no npm dependencies. It works on Linux and macOS. Windows should work with the browser path passed explicitly but is untested.

## Files Pi creates

A video is a small folder you can keep in your project:

| File | What it holds |
| --- | --- |
| `<name>.json` | The storyboard: steps, timing, camera moves, rings, captions and the end card |
| `scenes.html` | Recreated screens, when the video needs motion inside the UI |
| images | Screenshots and the logo the storyboard points to |

The complete storyboard format is in the skill's `references/storyboard.md`. Caption rules are in `references/writing.md`, and the visual rules in `references/style.md`.

## Commands

Run these from anywhere; paths are relative to your current directory. `<skill-dir>` is the installed skill folder, for example `~/.pi/agent/npm/node_modules/@firstpick/pi-skill-explainer-video/skills/explainer-video`.

Check a storyboard:

```bash
node <skill-dir>/scripts/validate.mjs video/pacsea.json
node <skill-dir>/scripts/validate.mjs video/pacsea.json --strict   # warnings fail too
```

Exit codes: `0` valid, `1` errors (or warnings with `--strict`), `2` usage error.

Render:

```bash
node <skill-dir>/scripts/render.mjs video/pacsea.json [options]
```

| Option | Default | Effect |
| --- | --- | --- |
| `--out <file.mp4>` | `<storyboard name>.mp4` next to the storyboard | Where the video goes |
| `--no-video` | off | Skip the video; use with the options below |
| `--stills <t,t,...>` | none | Save PNG frames at these times in seconds |
| `--stills-dir <dir>` | `stills/` next to the storyboard | Folder for stills |
| `--sheet <file.png>` | none | Save a contact sheet |
| `--sheet-mode overview` or `shots` | overview | Twelve evenly spaced frames, or a labeled frame from every shot. Requires `--sheet` |
| `--check-layout` | off | Check every frame for caption overflow, overlap, continuity and seek-order changes |
| `--report <file.json>` | none | Save timestamped layout findings. Requires `--check-layout` |
| `--preview <file.html>` | none | Save a page that plays the video in a browser (Space pauses, arrow keys seek) |
| `--fps <n>` | storyboard value, else 30 | Frame rate |
| `--crf <n>` | 18 | x264 quality; lower is sharper and larger |
| `--chromium <path>` | `$CHROME_PATH`, then a PATH lookup | Browser binary |
| `--force` | off | Render despite validation errors |

The preview page loads screenshots and the logo from the storyboard folder on your machine, so it stops showing them if you move or delete that folder.

A 35-second 1080p video renders in about a minute on a desktop CPU and is around 10 MB.

For a delivery assembled from the storyboard, set its frame rate in the storyboard itself. `--fps` overrides rendering and preview timing, but assembly expects the frame rate recorded in the storyboard.

## Example

The package ships a complete five-step video for the Pacsea package manager in `examples/pacsea/`. Render it to see the style:

```bash
node <skill-dir>/scripts/render.mjs <skill-dir>/examples/pacsea/pacsea.json --out pacsea.mp4
```

The screen in that example is a recreation in Pacsea's default theme colours. Package versions and sizes in it are illustrative.

## Privacy and safety

- Rendering is local. The browser runs headless with a temporary profile that is deleted afterwards; no window opens.
- Scenes are your own HTML and run in that browser with access to local files next to the storyboard. Do not render scene files from people you do not trust.
- Screenshots end up in the video. Check them for names, email addresses, tokens or other private data before sharing.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `no Chromium-family browser found` | Install chromium, or pass `--chromium /path/to/browser` or set `CHROME_PATH` |
| `ffmpeg not found on PATH` | Install ffmpeg |
| `selector "#x" matches nothing` | The `target` in an action or rect does not exist in that step's scene; check ids in `scenes.html` |
| `Image failed to load` | A screenshot or logo path is wrong; paths are relative to the storyboard |
| `player did not start` | The scenes file has broken HTML or a script error; open the `--preview` page to see it |
| `--fps must be a whole number from 12 to 60` | Pick a frame rate in that range; 30 matches the reference style |
| Text looks blurry | Zoom less (larger camera rect) or recreate the screen in HTML instead of a small screenshot |
| Captions use the wrong font | The default stack prefers Inter, then Noto Sans. Install Inter or set `theme.font` |

## Limits

- The renderer creates a silent master. Assembly accepts supplied music or narration; it does not compose music or synthesize speech. Videos should still make sense muted.
- One caption per step. Use more steps rather than longer captions.
- The layout is tuned for 1920x1080. Other sizes render but need a custom `view` box.
- Clip format uses 2–6 steps of 3–12 seconds each. Set `"format": "episode"` for a longer walkthrough. Shot timing and continuity checks still apply.

## Layout checks and shot sheets

Run `render.mjs` with `--no-video --check-layout --report out/layout.json` before a long render. Failures exit with code 1 before video, stills or sheets are written; the requested report is still written. Checks use actual rendered caption boxes, including declared exclusion regions. They cannot identify an undeclared dialog or prove a demonstration matches the real product. During crossfades only the more visible step is inspected. Screenshot comparisons sample each step rather than every canvas pixel.

With `--sheet-mode shots`, more than 32 shots continue in `sheet-p2.png`, `sheet-p3.png` and so on. Surplus pages from an earlier, longer render are retained. Use the pages named in the current output.

## Complete walkthrough example

Stockroom shows an invented item's quantity changing from 4 to 6. It includes opening, chapter and closing cards, fixed two-line captions, caption motion and a dialog. Its screens and data are fictional.

Create an `out/` directory, then run:

```bash
node <skill-dir>/scripts/validate.mjs <skill-dir>/examples/stockroom/storyboard.json --strict
node <skill-dir>/scripts/render.mjs <skill-dir>/examples/stockroom/storyboard.json \
  --check-layout --report out/layout.json --out out/visual.mp4
node <skill-dir>/examples/stockroom/score.mjs out/score.wav
node <skill-dir>/scripts/assemble.mjs <skill-dir>/examples/stockroom/storyboard.json \
  --visual out/visual.mp4 --audio out/score.wav --out out/stockroom.mp4 --sheet out/sheet.png
```

The soundtrack is generated locally from original notes and contains no downloaded recordings. The sample runs 64 seconds at 24 frames per second.

## Assemble the finished delivery

```bash
node <skill-dir>/scripts/assemble.mjs video/storyboard.json \
  --visual out/visual.mp4 --audio music.wav --out out/finished.mp4 \
  --description out/youtube-description.txt --sheet out/sheet.png
```

`--visual` and `--out` are required and must name different files. `--audio`, `--description`, `--sheet` and `--chromium` are optional. Without audio, the delivery stays silent. The default description path is the MP4 name with `.description.txt` instead of `.mp4`. It contains the title, optional introduction and chapter timestamps. The sheet samples every shot from the encoded delivery.

Use a master rendered by this version from the current storyboard and assets. Masters without provenance or with changed tracked sources are rejected; re-render them first. Additional images or fonts loaded inside scene HTML are not included in this check. Re-render after changing those too.

Chapter times come from your explicit list, or from section cards when no list is supplied. Chapter times are rounded to milliseconds before export. They begin at zero, increase, lie before the end and have distinct whole-second description timestamps after rounding. Short chapters remain valid MP4 chapters; assembly warns when their number or length is unsuitable for YouTube. Chapter validation happens during assembly.

The soundtrack must cover the storyboard. Assembly pads any fractional final video frame caused by frame rounding, trims extra audio, converts it to 48 kHz AAC and checks that its end is within 0.03 seconds of the video. Chapter boundaries must match within 1 millisecond. Video dimensions, frame rate and frame count must match the storyboard. Files are staged before replacement. If moving several verified files fails partway through, the error names files already replaced. Keep sources and the master separate from delivery files.

Assembly exits 0 for success, 1 for validation, media or process failure, and 2 for usage errors. It does not upload or publish anything.
