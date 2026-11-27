# Explainer Video

Create captioned walkthroughs of a software project. Keep the whole app visible, highlight the active feature and float a short caption beside it. For YouTube, the skill also guides intro and section transitions, a product-led thumbnail, music, credits and a timestamped description.

## Helpful when

- You ship a feature and want a 30-second clip for the release post or README.
- New users keep asking how to do one task, and a screenshot is not enough.
- You want to explain a terminal or keyboard-driven app to people who never use the terminal.

## What to share with Pi

- The product name and where its docs, screenshots or source live.
- Who will watch, and what they should be able to do afterwards.
- Real screenshots, the app's theme colours, or its UI markup, if you have them.
- The version number and link for the end card.

## Try asking

> Make a 30 second explainer video for Pacsea that shows a non-technical Arch user how to find, check and install apps. Use Pacsea's own theme colours and end with version 0.8.2.

## What you'll get

- A 1080p MP4. Short release clips typically run 20–40 seconds. Feature episodes can run around three minutes.
- A contact sheet of frames so you can check every step at a glance before sharing.
- The storyboard and scene files, so you can change a caption or timing and render again.

## Keep in mind

Pi checks every feature it shows against the product's docs or source, but when it recreates a screen, versions, sizes and names in it are illustrative. Pi tells you when that is the case. Rendering happens on your machine with a headless browser that opens no windows; nothing is uploaded.

You need Node.js 22 or newer, a Chromium-family browser and ffmpeg.

## Install

```bash
pi install npm:@firstpick/pi-skill-explainer-video
```

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for render commands and options, requirements, troubleshooting and limits.
