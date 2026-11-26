# Visual style

The look comes from a set of product release clips (T3 Code 0.1.12, five clips, 21–36 s each, 1920x1080 at 30 fps, no audio). The engine already draws most of it. This guide explains what it does so you can plan shots that fit.

## The frame

| Element | What it looks like | Where it comes from |
| --- | --- | --- |
| Stage | Pure black with a faint blue glow at the top centre | `theme.background`, `theme.glow` |
| Interface | Large and sharp, fading into black at all four edges | your scene, the stage mask |
| Focus ring | Rounded outline, 2 px, accent colour, soft outer glow; pops in slightly | `highlights` |
| Caption | Bottom centre: small grey number badge, **bold white lead**, grey rest | `caption` |
| Key chip | A keyboard key above the caption with a short grey hint | `keys` |
| Pointer | White arrow with a dark outline; a ring pulses on click | `cursor` |
| End card | Logo tile, two-line headline (white, then grey), "Available now in **Product** `version`", small URL | `outro` |

The interface sits in the upper 80% of the frame. The bottom band belongs to the caption. Nothing else appears on screen: no titles, arrows, emoji or stickers.

## Camera

- Every step has a camera, even if it only starts wide and drifts. The engine adds a slow 1.2% push-in so held shots never look frozen.
- Moves ease in and out and take 0.8–1.2 s. Faster feels jumpy; slower drags.
- Zoom until the thing you ring fills about a third to two thirds of the frame. UI text should look like a comfortable reading size on a phone.
- The engine keeps the scene filling the frame, so aiming near an edge never shows the scene border.
- Steps crossfade into each other over 0.5 s. A new step can start from a completely different framing.

## Rhythm of a step (6–7 s)

| Time | Happens |
| --- | --- |
| 0.0–1.0 s | Wide or medium shot; the caption fades in |
| 1.0–2.0 s | Camera glides in; ring appears as the move ends |
| 2.0–3.5 s | Hold on the ring; the viewer reads |
| 3.5–5.0 s | The action: typing, a key chip, a click; the UI changes |
| 5.0–7.0 s | Camera glides to the result; second ring; hold |

Leave each ring up for at least 1.5 s. Never show two rings at the same time.

## Colour

Default accent is blue `#3b82f6`. Change `theme.accent` to suit the product if blue clashes with its UI (the Pacsea example uses a soft periwinkle to sit with a purple theme). Keep the stage black.

## End card

Two short lines. The first says what the product does for the viewer, the second adds the benefit or contrast:

- "Multi-repo projects / however your code is laid out"
- "Install apps on Arch / without memorizing commands"

Use the product's real logo when you have it (SVG or PNG). Otherwise set `logoText` to a short mark such as "T3".
