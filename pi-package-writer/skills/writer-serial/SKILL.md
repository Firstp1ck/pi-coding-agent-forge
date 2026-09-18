---
name: writer-serial
description: Plan and continue web novels or serialized fiction with installment payoffs, long-range continuity, earned hooks, and controlled recaps.
license: MIT
---

# Serial fiction

## When to use

Use for web novels, episodic prose, multi-volume continuity, or an installment whose ending needs stronger forward interest.

## Inputs and assumptions

Identify the installment length, current arc, open promises, reader knowledge, and any explicitly named platform constraints. Do not assume a commercial platform or scraping requirement.

## Portable workflow

1. Read the latest checkpoint and the actual preceding installment.
2. Identify what this installment gives the reader and what it asks them to anticipate.
3. Advance at least one meaningful line of change. Do not replace progress with repeated status descriptions or recap.
4. Choose an ending appropriate to the scene: decision, revelation, reversal, partial resolution, or earned cliffhanger.
5. Track unresolved threads by setup, current state, and intended payoff. Keep future plans separate from events.
6. For a new arc or volume, carry over only relevant state and reintroduce it through current pressure.
7. Save the installment and accurate continuation notes using [the project workflow](../../references/project-workflow.md).

## Safety and side effects

No automatic publishing, schedule creation, market scraping, or chapter spamming. The author approves major arc changes.

## Scripts, references, and dependencies

Use [formats](../../references/formats.md) and continuity guidance. No mandatory external services.

## Verification

Check local payoff, non-repetitive progression, earned hooks, and consistency of abilities, injuries, relationships, timelines, and knowledge.

## Pi adapter

Use `/writer new book "The Ninth Gate" --format web-novel`, then `/writer new chapter` or `/writer continue`.
