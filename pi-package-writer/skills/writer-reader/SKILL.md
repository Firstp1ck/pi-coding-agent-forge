---
name: writer-reader
description: Simulate a specified first-time reader's reactions to fiction, tracking curiosity, tension, attachment, confusion, and payoff without presenting simulation as real audience research.
license: MIT
---

# Reader response

## When to use

Use when the author wants to know where a scene loses attention, reveals too much, confuses a newcomer, or fails to deliver an intended emotion.

## Inputs and assumptions

Specify the reader's familiarity, preferences, and available prior chapters. Do not give a first-time reader access to the outline or secret canon.

## Portable workflow

1. Read the passage in order using only information the specified reader would possess.
2. Record reactions at meaningful turns: what is expected, questioned, feared, understood, or misread.
3. Separate immediate reaction from later craft diagnosis.
4. Identify which questions create productive curiosity and which prevent basic comprehension.
5. Compare the experience with the author's intended effect without treating preference differences as errors.
6. Return a small set of passage-linked observations and possible experiments for revision.

## Safety and side effects

Read-only by default. A model-generated reader persona is not a real beta reader or market sample. Do not claim universal audience response.

## Scripts, references, and dependencies

No external dependencies. Use [review guidance](../../references/review.md) to distinguish evidence, inference, and taste.

## Verification

Check that reactions do not rely on future knowledge and that each major claim points to a passage. State which prior chapters were available.

## Pi adapter

Use `/writer review --brief "Read as a newcomer who enjoys quiet fantasy; mark confusion separately from suspense"`.
