---
name: writer-revision
description: Critique and revise fiction at structural, scene, line, or copy-editing scope while preserving voice, story facts, and original drafts.
license: MIT
---

# Fiction revision

## When to use

Use when prose is confusing, flat, repetitive, over-explained, structurally weak, or inconsistent with the intended voice.

## Inputs and assumptions

Clarify review versus revision, the exact range, intended reader effect, and what must stay unchanged. Read the actual passage and relevant context.

## Portable workflow

1. Follow [review guidance](../../references/review.md). Diagnose the highest-impact problem before polishing sentences.
2. Separate structural, causal, character, viewpoint, pacing, style, and copy issues.
3. Cite concrete passages. Explain the reader effect and propose repairs with trade-offs.
4. When revision is authorized, preserve agreed facts and voice. Do not make every character concise, casual, or witty.
5. Save a new revision file by default. Identify changes that affect later scenes and ask before propagating them.
6. Compare the new passage with the original for omissions, invented facts, lost subtext, and flattened rhythm.
7. Update saved progress only for authorized writing, following [the project workflow](../../references/project-workflow.md).

## Safety and side effects

A review request does not authorize edits, even to notes. Do not use AI-detector scores as a quality target or claim a rewrite guarantees human authorship or publication.

## Scripts, references, and dependencies

No external dependencies. [Style guidance](../../references/styles.md) helps preserve intentional language choices.

## Verification

Show what improved, what was preserved, what changed materially, and any dependent passages left untouched. Read saved revisions back before reporting success.

## Pi adapter

Use `/writer review --target "chapters/chapter-0001.md"` for critique or `/writer revise --target "chapters/chapter-0001.md" --brief "Reduce explanation but keep the lyrical voice"` for a new revision.
