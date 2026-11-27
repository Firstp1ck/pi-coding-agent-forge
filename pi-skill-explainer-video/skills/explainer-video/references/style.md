# Visual style

The look comes from a set of product release clips (T3 Code 0.1.12, five clips, 21–36 s each, 1920x1080 at 30 fps, no audio). The engine already draws most of it. This guide explains what it does so you can plan shots that fit.

## Short release clip framing

| Element | What it looks like | Where it comes from |
| --- | --- | --- |
| Stage | Pure black with a faint blue glow at the top centre | `theme.background`, `theme.glow` |
| Interface | Large and sharp, fading into black at all four edges | your scene, the stage mask |
| Focus ring | Rounded outline, 2 px, accent colour, soft outer glow; pops in slightly | `highlights` |
| Caption | Bottom centre: small grey number badge, **bold white lead**, grey rest | `caption` |
| Key chip | A keyboard key above the caption with a short grey hint | `keys` |
| Pointer | White arrow with a dark outline; a ring pulses on click | `cursor` |
| End card | Logo tile, two-line headline (white, then grey), "Available now in **Product** `version`", small URL | `outro` |

This close-up layout reserves the bottom band for captions. For a feature walkthrough use the full-window layout below.

## Cut around the action

In the multi-repo clip, three examples build across the frame in the first five seconds. The next shot keeps the list steady while rows appear. Later the camera travels sideways from the file changes to the repository controls. Those moves explain three different things. They show a comparison, a new result, and the connection between two places. [Original multi-repo clip](https://x.com/jullerino/status/2125495369291477159)

Choose the composition by asking what the viewer needs to see change.

| What the viewer needs to follow | How to stage it |
| --- | --- |
| A query producing matches | Keep the input and the first rows in one frame with `drift: false`. Type, reveal the matches, and give the viewer time to read the first one. |
| A choice between examples | Keep their labels aligned. Introduce each example on its own beat and finish with all choices visible. Label an editorial comparison when it differs from the product UI. |
| A change in another pane | Keep both panes visible if the text fits. Otherwise pan from the selection to its result at the same scale. The MCP events clip keeps the thread and its subscriber side by side. [Reference](https://x.com/jullerino/status/2125496073385074963) |
| A different workspace or modal | Cut on the input that opens it. Land on the relevant content and hold through the decision. The sign-in clip cuts from the warning to the approval page and back to the conversation. [Reference](https://x.com/jullerino/status/2125495953981653092) |
| Something small the viewer might miss | Frame the surrounding controls first. Let a single ring settle on the detail, then release it as the viewer acts. |

Save a zoom for a genuine change of scale. Give a confirmation less time than a result someone must read. A single caption can span a reveal, a pause and a result. Inspect adjacent shots together. If three in a row have the same opening, move and hold, try keeping one locked or starting the next on the result. Keep a recurring treatment when it helps the viewer compare like with like.

## Keep the entire app in view

For a full-window walkthrough, use the same terminal or application dimensions throughout. Keep every outer border, the toolbar, and the footer inside the frame. When a modal opens, preserve the surrounding application as the viewer would see it. Use the opening to orient the viewer and end on the final application state.

Keep the active controls at their native brightness. A narrow lit area works for a selected row. When an action crosses panes, briefly light both the input and its result so the viewer can see their relationship. Keep the dimmed interface recognizable.

Place the caption beside the particular row, button or field its words explain. Look first for a dim strip that shares an edge with that feature. Along a long row, align the text with the label or value the viewer is reading. Check the actual wrapped caption, since a second line can cover the next row.

Anchor each outline to the named text or control in the visible state. For text inside a screenshot, measure its bounds and account for the image's offset and scale. End the highlight when its target disappears. Check the last frame before a selection or dialog changes and the first frame after it.

Keep the caption in place when adjacent targets can share a readable position. When it needs to move, choose its landing beside the next explained feature and glide there in one continuous movement. Check every stop against the words and UI visible at that moment. If a dialog blocks the route, choose another landing or take a smooth path around it. Inspect the move at playback speed to catch early departures, reversals and stops in unrelated space.

## Checking text alignment

Identify each target by its visible words and its row, pane or dialog. Two matching labels can occupy different parts of a frame. When the interface changes, measure the target again. In a terminal recreation, repeated spaces inside an SVG text run can collapse even when the source describes a fixed-width grid. Anchor each word group at its measured column or use the browser’s rendered glyph bounds. Include a fixture with a leading icon, a column gap and a word near the outline.

Check a crop from the finished MP4 at ordinary playback size. Both ends of the label should sit inside the outline, with enough clearance to read them. Read the instruction against the whole frame. If it asks viewers to review a list, price or disclosure, keep those supporting lines visible throughout the reading hold as well as the focused control. Compare the crop with the expected words when a grid or DOM check passes but the picture looks wrong. For captions, watch the frame where the next target appears. Hold beside the current control until the next move helps the viewer follow the action. Nearby values can share one caption position while the outline changes.

## Full-page section cards

Build the card over a fixed app frame. Fade a translucent layer across every pane, including the title bar, footer and previously highlighted control. The app should still be recognizable behind it. Place the heading and supporting text above that layer. Pause inputs and clear the ordinary instructional caption during the hold.

- **Opening** — Name the project and the concrete tasks viewers will learn.
- **Chapter** — Explain what was just established and what the viewer will do next. Keep the object of each action clear when switching records, tools or workspaces.
- **Closing** — Show what the viewer accomplished and give the project and music credits.

Allow roughly half a second for the dimming and brightening and several fully settled seconds to read. Read the copy at reduced playback size and extend the hold if needed. Recheck export chapters, description timestamps and musical phrasing whenever a card changes the running time.

## Colour

Default accent is blue `#3b82f6`. Change `theme.accent` to suit the product if blue clashes with its UI (the Pacsea example uses a soft periwinkle to sit with a purple theme). Keep the stage black.

## End card

Two short lines. The first says what the product does for the viewer, the second adds the benefit or contrast:

- "Multi-repo projects / however your code is laid out"
- "Install apps on Arch / without memorizing commands"

Use the product's real logo when you have it (SVG or PNG). Otherwise set `logoText` to a short mark such as "T3".
