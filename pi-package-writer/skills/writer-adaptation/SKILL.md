---
name: writer-adaptation
description: Adapt fiction between novels, light novels, serial prose, manga, and webtoon scripts while preserving causal and emotional progression and documenting necessary changes.
license: MIT
---

# Fiction adaptation

## When to use

Use for changing the medium or scope of an existing story, especially converting prose into visual scripts.

## Inputs and assumptions

Read the source, identify its status and permitted use, confirm destination format, language, budget, and elements that must remain unchanged.

## Portable workflow

1. Identify the source's essential events, motives, information sequence, and emotional turns.
2. Read [format guidance](../../references/formats.md) for both source and destination.
3. Map each essential beat to the destination's tools. Prose interiority may become action, silence, imagery, dialogue, or captions.
4. Propose cuts, mergers, or order changes before making changes that alter the story's meaning.
5. Draft the adaptation to a new file, keeping the source intact.
6. Check pacing and readability in the destination medium rather than preserving source paragraph boundaries.
7. Provide a brief change map and update progress under [the project workflow](../../references/project-workflow.md).

## Safety and side effects

Do not assume permission to publish or distribute supplied material. No image generation, external upload, or source replacement is automatic.

## Scripts, references, and dependencies

No rendering services required. Use the manga skill for panels and scroll beats, or prose guidance for a prose destination.

## Verification

Trace essential causal and emotional beats to the adaptation. Check the requested page, episode, or word budget and disclose deliberate omissions.

## Pi adapter

Use `/writer adapt --target "chapters/chapter-0001.md" --format manga --brief "A 20-page episode with two silent pages"`.
