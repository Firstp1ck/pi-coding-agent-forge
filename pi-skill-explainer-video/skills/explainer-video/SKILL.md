---
name: explainer-video
description: Create captioned MP4 walkthroughs, short release clips and YouTube feature demos for software projects. Use for requests to demonstrate a product, explain its features on video, or produce a thumbnail, chapters and soundtrack for a walkthrough. Renders locally with headless Chromium and FFmpeg.
license: MIT
---

# Explainer video

Start with the product and something the viewer wants to do with it. For a technical walkthrough, keep the complete app in view and guide the eye with light, captions and selective sound. Use the host project's vocabulary, colors and real interface. The film should make sense on mute.

## Decide what to show

- Read the project's description and verify the workflow in its current UI or source. Give the film a product-led title such as “Project name: Review a change.” Put the sample document, package or account inside the demonstration. A viewer who has never heard of the sample should still recognize what the video teaches.
- For a series, inventory the user-facing features, group them by task and update the requested storyboard against the revisions being filmed. Distinguish released features from previews. Use the requested scouts, creators, reviewers and feature worktrees when specified. If the user asks to approve one pilot, deliver that cut for feedback before producing the series.
- Use about three minutes per episode for a feature series unless the user specifies another runtime. A single-action release clip can run 20–40 seconds. Pick fixtures that actually exercise the feature and keep the selected item identifiable from input through result. Disclose illustrative data or simulated outcomes.

## Stage a walkthrough

Start from the [runnable full-window example](examples/walkthrough/storyboard.json). Replace its fictional interface with real captures or an accurate recreation. Use the same dimensions across states. Keep the toolbar, footer and surrounding workspace visible through dialogs, the intro and the credits.

1. Open on the app. Give the product title and learning summary a visible entrance, a readable hold and a handoff to the first input. Check that their type size and placement read as an opening at ordinary playback size.
2. Use `framing: "full-app"`, timed `spotlights` and `spotlightOutline: true`. Dim the surrounding space enough to guide attention while preserving context. Outline the exact row, control or result. When an action affects a second pane, briefly show their relationship.
3. Put a short, upright caption in the nearest clear dimmed space. Use `captionMotion: "continuous"` and `captionEase: "fast-slow"`. Carry its position and width across cuts. Give it a quick smooth launch, a longer deceleration and a still reading hold. Change the words in place. Route around dialogs and active controls, including during the fastest part of the glide.
4. Vary the timing with the work. Let a query fill, a result appear and a selection travel. Give dense results a longer hold. At a major change of task, pause input, reveal the new goal as a chapter heading and guide attention to the next workspace. Use enough scale and motion for the viewer to recognize the change in a single viewing.
5. End on the result. For a YouTube episode, bring in legible project and music credits over that state, hold them and give the film a clear visual ending. Match the type, contrast and accents to the project.

For full-page intro, chapter and outro transitions, use a screen-wide overlay. Smoothly darken the entire app beyond its normal spotlight level, hold the heading and supporting details for several seconds, then lift the overlay or fade out. Use the [section-card staging guide](references/style.md#full-page-section-cards) to pace the copy.

The [storyboard reference](references/storyboard.md) documents coordinates, timing and transitions. The [visual guide](references/style.md) includes the original motion references and a close-up treatment for release clips. The [writing guide](references/writing.md) covers caption length and language.

## Render and inspect

The renderer needs Node.js 22+, headless Chromium and FFmpeg with libx264. Capture and render locally. From the skill directory:

```bash
node scripts/validate.mjs path/to/storyboard.json
node scripts/render.mjs path/to/storyboard.json --no-video --sheet out/sheet.png
node scripts/render.mjs path/to/storyboard.json --out out/visual.mp4
```

Use `"format": "episode"` for a longer storyboard so normal shot and motion validation still runs. Inspect the contact sheet for repetition, then inspect decoded frames around cuts, glides, dialogs and section changes. Check the highlighted target, caption clearance through the whole move, readability at reduced size and the visible outcome. For each change of focus, watch the encoded move from the previous reading hold through the next. Check that the caption travels straight to its next useful position and that the outline encloses the intended text, including its first and last characters. See the [text alignment checks](references/style.md#checking-text-alignment).

When asking for feedback on the opening, chapter change and ending, provide a short sequence of excerpts from all three, with a little adjacent footage. Label it as excerpts and link the full film.

## Package and deliver

For a YouTube cut, follow the [publishing asset guide](references/youtube.md) for the thumbnail, beat cues, soundtrack mix, credits and timestamped description. The renderer produces a silent visual master. Keep the editable storyboard and sources with the finished movie. Provide a playable file, runtime and a timestamp that lets the user judge the change. State what was verified and what data is illustrative.
