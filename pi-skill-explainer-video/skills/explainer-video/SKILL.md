---
name: explainer-video
description: Create short, silent tutorial and explainer videos (MP4) for apps, tools and features, in a clean product-launch style. Dark stage, close-up UI with smooth zooms, a glowing focus ring, numbered plain-language captions and an end card. Use when someone asks for a demo video, feature walkthrough, release clip, how-to video or "explain X in a video" for a non-technical audience. Renders locally with headless Chromium and ffmpeg.
license: MIT
compatibility: Needs Node.js 22 or newer, a Chromium-family browser (chromium, google-chrome, brave or edge) and ffmpeg with libx264. Runs headless and opens no windows. No npm dependencies.
---

# Explainer video

Make a 20–40 second video that shows a viewer how to do something, one step at a time. Each step pairs a close look at the real interface with one short sentence. The style matches modern product release clips: black stage, the UI large and sharp, the camera gliding to what matters, a blue ring around it, and a caption like **"2  Approve, paste the address** and it's done."

The video is silent. The captions carry the whole explanation, so the writing matters as much as the visuals.

## Workflow

### 1. Pin down what the viewer should take away

Before touching any file, settle:

- **Who watches.** Default to someone who has never used the product and does not know its vocabulary.
- **What they can do after watching.** List three to five actions in the viewer's words ("find an app", "install several at once"). These become the steps.
- **What is real.** Read the product's README, docs, screenshots or source to confirm every feature you show exists and works the way the video claims. Never show a feature that does not exist.

If the user gave only a product name, research it and propose the step list before building.

### 2. Write the captions first

Write one caption per step, then read them in order without visuals. They must tell the story alone. Follow [the writing guide](references/writing.md). In short:

- A **bold lead** of one to four words that names the action ("Press Space"), then a grey rest that says what it gets you ("to add apps to your list.").
- At most ten words per caption. One idea each. End with a full stop.
- Everyday words. Describe what something does, not what it is called internally. "Community packages", not "AUR". "Check what will change", not "preflight".
- No filler or hype: never "simply", "just", "seamless", "powerful".

Write the end card: a two-line headline (what the product lets you do, then the benefit or contrast), the product name and version, and a short URL.

### 3. Choose how to show the interface

Pick per step:

- **Screenshot step** (`"image": "shot.png"`). Fastest and most authentic. Use when the step needs no motion inside the UI: the camera, ring and pointer still move. Capture screenshots at high resolution (at least 1920 px wide).
- **HTML scene** (`"scene": "<template id>"`). Recreate the screen in HTML/CSS when the step needs things to happen: typing, a list filling up, a dialog opening. Copy real labels, layout and colours from the product (themes, CSS, screenshots). Mark illustrative data (versions, sizes, names) as illustrative in a comment and in your report.

For terminal apps (TUIs), an HTML scene with a monospace grid in the app's real theme colours works well; see `examples/pacsea/`. For web apps, you can often reuse the app's own markup and CSS.

### 4. Write the storyboard

Copy `examples/pacsea/` as a starting point. The format is in [the storyboard reference](references/storyboard.md). Plan each step with the rhythm from [the style guide](references/style.md):

1. Start wide enough to orient the viewer (0–1 s).
2. Glide in on the first point of interest (about 1 s move).
3. Ring it and hold for at least 1.5 s.
4. Make the change happen (typing, a key press shown as a key chip, a click).
5. Optionally glide to the result and ring it.

Give each step 5–8 seconds. Prefer `{"target": "#id"}` rects over hand-measured coordinates so the camera and ring follow the real element.

### 5. Validate, look, fix, render

Run the scripts from this skill's directory (`<skill-dir>` below):

```bash
node <skill-dir>/scripts/validate.mjs storyboard.json
node <skill-dir>/scripts/render.mjs storyboard.json --no-video --sheet out/sheet.png --stills 2,9,15 --stills-dir out
```

Fix every validation error. Treat caption warnings as real unless the term is a product name or something the audience knows; add those to `allowTerms`.

**Look at the contact sheet and stills before rendering the video.** Check that:

- the ring sits on the right element and nothing important is cut off;
- text in the UI is large enough to read at the chosen zoom;
- captions do not collide with the UI, and the step numbers run 1, 2, 3;
- no step shows stale state from another step (set state with `setup`).

Then render:

```bash
node <skill-dir>/scripts/render.mjs storyboard.json --out out/video.mp4 --preview out/preview.html
```

A 35-second 1080p video takes about a minute. Extract a few frames from the MP4 (`ffmpeg -ss 12 -i out/video.mp4 -frames:v 1 frame.png`) and look at them to confirm the encoded result.

### 6. Report

Give the user the video path, the contact sheet, the caption list in order, the total length, and anything illustrative (mock data, recreated screens). Say which checks you ran. Never claim you watched the video in real time; you inspected frames.

## Rules

- Show only real features, described accurately. A clean mock of a real screen is fine; inventing behaviour is not.
- Keep it short: three to five steps, 20–40 seconds. Split longer topics into a series.
- One caption per step, visible for the whole step.
- Never open a visible browser window. The renderer runs headless; open `preview.html` only if the user asks.
- Do not send product screenshots or data to outside services. Rendering is local.

## Files

- `scripts/render.mjs`: renders MP4, stills, contact sheet and a playable preview page.
- `scripts/validate.mjs`: storyboard and caption checks.
- `assets/engine.js`, `assets/player.html`: the renderer's page and animation engine.
- `examples/pacsea/`: a complete five-step example for the Pacsea package manager.
- `references/style.md`, `references/writing.md`, `references/storyboard.md`.
