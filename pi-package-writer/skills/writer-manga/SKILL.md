---
name: writer-manga
description: Write manga, comic, or webtoon scripts and storyboards with drawable panels, dialogue, silent beats, reading direction, and page-turn or scroll reveals. Produces text, not images.
license: MIT
---

# Manga and webtoon scripts

## When to use

Use for original visual storytelling, prose-to-comic adaptation, page planning, or revising panel pacing.

## Inputs and assumptions

Confirm manga versus webtoon, reading direction, page or episode budget, audience, dialogue language, and whether the requested output is a script, storyboard, or optional image-prompt draft.

## Portable workflow

1. Read the manga and webtoon sections of [format guidance](../../references/formats.md).
2. Identify the emotional and causal sequence before distributing it across panels.
3. Give each page or scroll segment a purpose. Reserve reveals and quiet beats deliberately.
4. Describe one drawable moment per panel with subject, action or expression, framing when useful, dialogue, captions, and sound effects.
5. Convert interior monologue into visible behavior or sparse captions where possible. Do not discard essential internal conflict merely to reduce text.
6. Check spatial continuity, character positions, speech order, dialogue density, and transitions between panels.
7. Save a new script or storyboard. Keep art style separate from narrative tone and reading format.

## Safety and side effects

This skill does not render images. Do not call image/video services, reuse protected characters without an appropriate request, or incur generation costs automatically. Preserve adaptation sources.

## Scripts, references, and dependencies

No image backend required. [The project workflow](../../references/project-workflow.md) explains project and checkpoint handling.

## Verification

Count pages or scroll segments against the requested budget. Check that each panel is drawable and readable, that dialogue fits the intended layout, and that reveals work in the chosen reading direction.

## Pi adapter

Use `/writer new book "The Last Train" --format manga` or `/writer adapt --format manga --target "chapters/chapter-0001.md"`. Choose `webtoon` for vertical scrolling.
