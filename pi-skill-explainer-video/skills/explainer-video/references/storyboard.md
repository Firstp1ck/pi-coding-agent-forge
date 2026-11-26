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
| `title` | no | Page title; not shown in the video |
| `width`, `height` | no | Default 1920x1080. The layout is tuned for that size |
| `fps` | no | 12–60, default 30 |
| `scenes` | when a step uses `scene` | Path to the scenes HTML file |
| `theme` | no | `accent`, `glow`, `background`, `font`, `mono` (CSS values) |
| `allowTerms` | no | Words the caption checker should accept (product names, terms the audience knows) |
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
| `clamp` | `false` lets the camera show past the scene edges (for small floating cards) |
| `setup` | Actions applied instantly for the whole step, to put the scene into the right state |
| `camera` | Keyframes. Each has `at`, `rect`, optional `move` (seconds the glide takes; default: the whole gap since the previous key) |
| `highlights` | Rings: `from`, optional `to` (default end of step), `rect` |
| `keys` | Key chips: `at`, `label`, optional `hint`, optional `dur` (default 1.1 s) |
| `cursor` | Pointer keyframes: `at`, `x`, `y` in scene pixels, optional `click`, optional `hide` on the last key |
| `actions` | Timed changes inside the scene, see below |

### Rects

Either `[x, y, width, height]` in scene pixels, or `{"target": "<css selector>", "pad": 10}`. A target rect follows the element's live position, so it stays right after layout changes. Prefer targets.

### Actions

Every action has `type` and `target` (a CSS selector inside the step's scene). Timed actions also have `at`.

| Type | Extra fields | Effect |
| --- | --- | --- |
| `type` | `text`, `cps` (default 16) | Types `text` into the element, character by character |
| `text` | `text` or `html` | Replaces the element's content |
| `class` | `add` and/or `remove` | Space-separated class names |
| `show` | `dur` (0.35), `dy` (10) | Fades and slides the element in. It is hidden before `at` |
| `hide` | `dur` (0.35), `dy` (10) | Fades the element out |

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
