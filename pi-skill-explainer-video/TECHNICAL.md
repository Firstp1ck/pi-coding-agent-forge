# Technical reference: Explainer Video

Commands, options, requirements and troubleshooting for people who run the renderer themselves or want to edit a video by hand.

[Back to the README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Requirements

| Tool | Version | Used for |
| --- | --- | --- |
| Node.js | 22 or newer | the validator and renderer |
| Chromium, Google Chrome, Brave or Microsoft Edge | any recent release | drawing each frame, headless |
| ffmpeg | with libx264 | encoding the MP4 and contact sheets |

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
| `--sheet <file.png>` | none | Save a 4x3 contact sheet of evenly spaced frames |
| `--preview <file.html>` | none | Save a page that plays the video in a browser (Space pauses, arrow keys seek) |
| `--fps <n>` | storyboard value, else 30 | Frame rate |
| `--crf <n>` | 18 | x264 quality; lower is sharper and larger |
| `--chromium <path>` | `$CHROME_PATH`, then a PATH lookup | Browser binary |
| `--force` | off | Render despite validation errors |

The preview page loads screenshots and the logo from the storyboard folder on your machine, so it stops showing them if you move or delete that folder.

A 35-second 1080p video renders in about a minute on a desktop CPU and is around 10 MB.

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

- No audio or voice-over. Videos are designed to work muted.
- One caption per step. Use more steps rather than longer captions.
- The layout is tuned for 1920x1080. Other sizes render but need a custom `view` box.
- 2–6 steps of 3–12 seconds each, so at most 80 seconds with the end card. Split longer topics into a series.
