# Storyboard format (version 1)

A video is two files side by side:

- `storyboard.json`: steps, timing, camera, rings, captions and the end card.
- `scenes.html` (optional): `<style>` blocks and one `<template>` per recreated screen.

Paths in the storyboard (scenes file, screenshots, logo) are relative to the storyboard file. Times inside a step are seconds from the start of that step.

## Top level

```json
{
  "version": 1,
  "title": "Pacsea in 35 seconds",
  "width": 1920, "height": 1080, "fps": 30,
  "scenes": "scenes.html",
  "theme": { "accent": "#3b82f6" },
  "allowTerms": ["Pacsea", "Arch"],
  "steps": [ ... ],
  "outro": { ... }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Always `1` |
| `format` | no | `"clip"` (default) uses the short-clip shot count. `"episode"` supports longer sequences and validates each shot and the continuity between shots. |
| `title` | no | Page title; not shown in the video |
| `width`, `height` | no | Default 1920x1080. The layout is tuned for that size |
| `fps` | no | 12–60, default 30 |
| `scenes` | when a step uses `scene` | Path to the scenes HTML file |
| `theme` | no | `accent`, `glow`, `background`, `font`, `mono` (CSS values) |
| `allowTerms` | no | Words the caption checker should accept (product names, terms the audience knows) |
| `spotlightOutline` | no | `true` outlines every active spotlight in cyan with a dark edge and soft outer band. The stroke keeps the same thickness on screen as the scene scales. |
| `captionMotion` | no | `"continuous"` keeps a single caption plaque visible across edits. Match each incoming `box` to the previous final position and width and follow new targets with timed glides. |
| `captionEase` | no | `"fast-slow"` gives caption glides a quick launch and a long slowdown. A glide covers about three quarters of its distance by halfway through its allotted time. Holds and arrival times come from the caption track. |
| `captionStyle` | no | `"two-line"` gives every caption a fixed two-line block with a fixed line pitch. The badge, the text column and both baselines stay on the same pixels whatever the wording, and captions fade in place without the small upward slide. A caption that needs a third line still renders, and `inspect` reports it as overflow. Without this field captions keep the default one-line style. |
| `framing` | no | `"full-app"` fits the entire scene inside the output throughout, preserving its aspect ratio and edges. Use a complete app image or scene. Close with a caption on the final app state. |
| `view` | no | Box the camera fits targets into, default `{"x":150,"y":60,"w":1620,"h":820}` |
| `maxZoom` | no | Largest zoom factor, default 3.2 |

## Step

```json
{
  "caption": { "bold": "Press Space", "rest": "to add apps to your list." },
  "duration": 7,
  "scene": "pacsea",
  "setup": [ { "type": "class", "target": "#list-ff", "remove": "off" } ],
  "camera": [
    { "at": 0, "rect": [0, 40, 1920, 600] },
    { "at": 4.4, "move": 1.0, "rect": { "target": "#install", "pad": 140 } }
  ],
  "highlights": [ { "from": 4.6, "to": 6.9, "rect": { "target": "#install", "pad": 22 } } ],
  "keys": [ { "at": 1.0, "label": "Space", "hint": "add firefox" } ],
  "cursor": [ { "at": 0.4, "x": 1250, "y": 300 }, { "at": 1.5, "x": 1000, "y": 24, "click": true } ],
  "actions": [ { "at": 1.1, "type": "show", "target": "#il1" } ]
}
```

| Field | Meaning |
| --- | --- |
| `caption` | `bold` (required), `rest`, optional `number` (`""` hides the badge) |
| `duration` | 3–12 seconds |
| `scene` | Id of a `<template>` in the scenes file. Each step gets its own fresh copy |
| `image` | Screenshot path instead of `scene`. Optional `imageSize: [w, h]`; otherwise read from the file |
| `transition` | Incoming shot boundary. `"cut"` switches picture and caption together on the first frame. The default `"fade"` overlaps both shots for 0.5 seconds. |
| `drift` | Set to `false` to hold a fixed scale between authored camera moves. The default adds a subtle push. |
| `clamp` | `false` lets the camera show past the scene edges (for small floating cards) |
| `setup` | Actions applied instantly for the whole step, to put the scene into the right state |
| `camera` | Keyframes. Each has `at`, `rect`, optional `move` (seconds the glide takes; default: the whole gap since the previous key) |
| `highlights` | Rings: `from`, optional `to` (default end of step), `rect` |
| `keys` | Key chips: `at`, `label`, optional `hint`, optional `dur` (default 1.1 s) |
| `cursor` | Pointer keyframes: `at`, `x`, `y` in scene pixels, optional `click`, optional `hide` on the last key |
| `actions` | Timed changes inside the scene, see below |
| `section` | Turns the step into an opening, chapter or closing card over the still app. See [Section cards](#section-cards) |
| `focusFade` | Seconds. The caption and the spotlight scrim fade in together, starting at the step's first spotlight `from` (or at the step start when there are none). It replaces the caption's usual incoming crossfade. Start plus `focusFade` must fit in the step |
| `avoid` | Rects (same forms as below) the caption must not cover, such as a dialog or a changed result. Nothing moves the caption; the layout check compares the regions with the rendered caption |

### Rects

Either `[x, y, width, height]` in scene pixels, or `{"target": "<css selector>", "pad": 10}`. `pad`, when supplied, must be a finite number. A target rect follows the element's live position, so it stays right after layout changes. Prefer targets.

### Spotlights and caption placement

`spotlights` is a step-level list of lit regions. Each takes `from`, an optional `to` (defaults to the end of the step), and a `rect` in **scene pixels** or a target selector. Active regions keep their original brightness. The rest of the scene dims by 58%. With no active region the whole scene is visible at its original brightness.

An optional caption `box` specifies **output pixels** as `[left, top, width]`. Its height follows the wrapped text. For example, this step lights Search and the first result, with the caption over a lower pane in the 1920×1080 output.

```json
{
  "duration": 6,
  "scene": "package-search",
  "transition": "cut",
  "spotlights": [
    { "from": 0, "rect": { "target": "#search", "pad": 4 } },
    { "from": 2, "rect": { "target": "#result-1", "pad": 4 } }
  ],
  "caption": { "bold": "Type a name", "rest": "to see matching packages.", "box": [100, 768, 620] }
}
```

For text that follows the feature within a shot, keep the caption width fixed and add a `track` to the caption. Each key gives the arrival time and the new top-left corner in output pixels. The position holds until `at - move`, then eases to the destination. The default move takes 0.55 seconds, capped by the available time. With `transition: "fade"`, the caption fades out at the old position and fades in at the new one.

```json
{
  "bold": "Press Space",
  "rest": "to add the selected package to the list.",
  "box": [76, 212, 590],
  "track": [
    { "at": 2.4, "x": 310, "y": 212, "move": 0.55 },
    { "at": 4.1, "x": 1240, "y": 596, "move": 0.45, "transition": "fade" }
  ]
}
```

With continuous captions, use the same width throughout. Finish a move, hold while the viewer reads, then start the next glide from that position. A long crossing needs more time than a change to the next row. The renderer keeps a two-line minimum height. Shorten copy that would introduce a third line. Check calls to action and chapter boundaries as well as moves within a shot. Measure the largest change between consecutive encoded frames, since a continuous path can still be too fast to follow.

### Section cards

A step with `section` shows a title card over its app image or scene. The app stays visible under a shade, so viewers keep their bearings.

```json
{
  "scene": "queue",
  "duration": 4,
  "setup": [{ "type": "text", "target": "#status", "text": "Draft" }],
  "section": {
    "kind": "chapter",
    "title": "Approve a draft",
    "body": "Check the summary, then send it back.",
    "credit": "Illustrative sample",
    "fadeIn": 0.5,
    "fadeOut": 0.5,
    "shade": 0.62
  }
}
```

| Field | Meaning |
| --- | --- |
| `kind` | `"opening"` (first step only), `"chapter"` or `"closing"` (last step only, and not together with an `outro`) |
| `title` | Required. Keep it to about eight words |
| `body`, `credit` | Optional lines under the title. Use `credit` for a disclosure such as "Illustrative sample" |
| `fadeIn`, `fadeOut` | Seconds, default 0.5 each. Together they must fit inside `duration` |
| `shade` | 0–1, default 0.62. How strongly the app under the card is darkened |

The ramps work differently by kind:

- An **opening** rises from black over `fadeIn`, then the card fades out over `fadeOut` and the app is left showing.
- A **chapter** card fades in and out over the app.
- A **closing** card fades in over the app, then the whole frame fades to black over `fadeOut`. The final frame is black. Set `fadeOut: 0` to end on the card instead.

A section holds the app still. `setup` applies, but the step has no caption, no drift, and no `camera`, `spotlights`, `highlights`, `cursor`, `keys`, `actions`, `focusFade` or `avoid`; validation rejects those fields. The neighbouring steps' captions only overlap the card during the usual crossfade at its edges; use `transition: "cut"` on the card and on the step after it for a clean switch.

With `captionMotion: "continuous"`, a section ends the caption sequence. The caption before it fades out, and the first caption after it may start anywhere and fades in. Captions on consecutive ordinary steps still have to start where the previous one ended. Give the step after a chapter `focusFade` so its caption and spotlight arrive together; a mid-sequence `focusFade` is rejected because it would hide a continuous caption.

### Layout inspection

The player page exposes `window.__EV.inspect(t)`. It seeks to `t` (seconds), exactly like `seek`, and returns what is on screen in output pixels:

```json
{
  "time": 6,
  "step": 1,
  "opacity": 1,
  "section": null,
  "caption": { "rect": [300, 800, 600, 69.6], "textOverflow": false, "opacity": 1 },
  "spotlights": [{ "rect": [960, 360, 360, 180], "opacity": 1 }],
  "avoid": [[924, 324, 432, 252]]
}
```

- `step` is the most visible step at `t`; at a crossfade the incoming step wins the tie. `caption`, `spotlights` and `avoid` belong to that step. `step` is `null` while only the outro shows.
- `opacity` is the primary step's own visibility: 1 on a settled frame, below 1 during a crossfade, 0 while only the outro shows.
- `rect` values are `[x, y, width, height]`, taken from the rendered layout, so they include font metrics and the caption's current position along its track.
- `caption.textOverflow` is true when the caption crosses the frame edge, when a two-line caption needs a third line, or when a continuous placed caption grows past its two-line minimum.
- `spotlights` lists the active regions. Their `opacity` is the scrim's visibility, including a `focusFade` entrance.
- While a section card is the primary step, `section` is `{kind, step, title, opacity, black, rect, textOverflow}`. `opacity` is the card's, `black` is the full-frame black layer and `rect` is the title block. `caption` is `null` and the lists are empty.

Every value depends only on `t`, so any seek order returns the same report.

### Actions

Every action has `type` and `target` (a CSS selector inside the step's scene). Timed actions also have `at`.

| Type | Extra fields | Effect |
| --- | --- | --- |
| `type` | `text`, `cps` (default 16) | Types `text` into the element, character by character |
| `text` | `text` or `html` | Replaces the element's content |
| `class` | `add` and/or `remove` | Space-separated class names |
| `show` | `dur` (0.35), `dx` (0), `dy` (10) | Fades and slides the element in. It is hidden before `at` |
| `hide` | `dur` (0.35), `dx` (0), `dy` (10) | Fades the element out |

Offsets are in scene pixels. For a lateral entrance, set `dx: 36, dy: 0`. With both offsets zero, only opacity changes. A hide travels in the opposite direction from a show with the same offsets.

Elements start the step exactly as the template defines them. A common pattern is a CSS class such as `.off { opacity: 0 }` in the template for things that appear later, removed with `setup` in later steps.

## Outro

```json
{
  "duration": 4.5,
  "logo": "pacsea.svg",
  "title": ["Install apps on Arch", "without memorizing commands"],
  "product": "Pacsea",
  "version": "0.8.2",
  "url": "github.com/Firstp1ck/Pacsea"
}
```

`title` is required: one or two lines. `logo` is an image path; use `logoText` for a short text mark instead. `lead` replaces "Available now in". Duration 2–8 s, default 4.

## Scenes file

```html
<style>
  .app { position: absolute; inset: 0; background: #1e1e2e; font: 20px/30px 'JetBrains Mono', monospace; }
  .off { opacity: 0; }
</style>
<template id="main" data-width="1920" data-height="1080">
  <div class="app">...</div>
</template>
```

- `data-width` and `data-height` set the scene size in pixels (default 1920x1080).
- Use fixed pixel sizes so the layout does not depend on the window.
- Use local fonts and images only, so the video renders the same on every run and machine.
- Give every element you target a unique `id`.

## Delivery fields

`description` is optional non-empty text for the introductory paragraph in the copy-ready description. Include what viewers learn, any illustrative-data disclosure and soundtrack attribution.

`chapters` is an optional non-empty array of `{ "start": 0, "title": "Find the item" }`. Times are seconds from the beginning of the delivered movie. Assembly rounds them to MP4 milliseconds, then checks strictly increasing starts beginning at zero, before the movie ends, with distinct whole-second description timestamps. Titles are non-empty single lines. Without this list, section starts define chapters; a zero chapter is added when needed. Both embedded chapters and description timestamps come from that list. The general storyboard validator does not validate chapters; assembly does.

See [the complete Stockroom example](../examples/stockroom/storyboard.json) for all production fields together.
