# Explainer Video

Create captioned walkthroughs of a software project. Keep the whole app visible, highlight the active feature and float a short caption beside it. Add opening and chapter cards, check caption placement, and export a finished MP4 with your soundtrack, credits and matching chapter timestamps.

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

> Make a one-minute walkthrough showing how to update an item's quantity. Start at 4, change it to 6, and show the saved result. Use an opening card, a chapter pause and two-line captions. Check the layout and deliver an MP4 with music and chapter timestamps.

## What you'll get

- A 1080p MP4. Short release clips typically run 20–40 seconds. Feature episodes can run around three minutes.
- A contact sheet of frames so you can check every step at a glance before sharing.
- The storyboard and scene files, so you can change a caption or timing and render again.
- Opening, chapter and closing cards, plus checks for captions covering controls or leaving the frame.
- A finished export with optional music, embedded chapters and a matching description.

Pi starts with an episode brief recording the audience, build, sample data and visible result. Try the included Stockroom example for a complete fictional task with a saved result.

## Keep in mind

Pi checks every feature it shows against the product's docs or source, but when it recreates a screen, versions, sizes and names in it are illustrative. Pi tells you when that is the case. Rendering happens on your machine with a headless browser that opens no windows; nothing is uploaded.

You need Node.js 22 or newer, a Chromium-family browser, ffmpeg and ffprobe. Check each demonstrated command before recording. A flag named `--dry-run` may protect only some command paths.

## Install

```bash
pi install npm:@firstpick/pi-skill-explainer-video
```

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for render commands and options, requirements, troubleshooting and limits.
