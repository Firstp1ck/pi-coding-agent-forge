---
name: writer-continuity
description: Audit and maintain fiction continuity, character knowledge, chronology, world rules, objects, foreshadowing, and series canon using evidence from saved manuscripts.
license: MIT
---

# Continuity and story memory

## When to use

Use before continuing an existing draft, after a consequential revision, or when auditing a novel or series for contradictions.

## Inputs and assumptions

Identify the requested range, authoritative manuscript version, author decisions, and relevant notes. A summary is a retrieval aid, not proof of an event.

## Portable workflow

1. Read [the project workflow](../../references/project-workflow.md) and identify what has actually been approved or written.
2. For the affected scenes, track time, location, character condition, object ownership, and world-rule constraints.
3. Track who knows each important fact and the scene where they learned it. Separate author truth from reader knowledge.
4. Check setups, open questions, payoffs, and deliberately unresolved threads.
5. Cite conflicting passages. Distinguish a contradiction from an unexplained gap, unreliable narration, or an intentional flashback.
6. Propose the smallest repairs with downstream consequences. Do not silently retcon the story.
7. When authorized to maintain notes, record confirmed changes with sources and leave unresolved proposals separate.

## Safety and side effects

Audits are read-only unless note maintenance or revision is requested. Do not treat model confidence as proof, automatically resolve conflicting canon, or claim whole-book coverage after reading excerpts.

## Scripts, references, and dependencies

No deterministic story engine is bundled. This is an evidence-guided model workflow. Use [review guidance](../../references/review.md) for reporting.

## Verification

List the files or ranges checked, the evidence for each finding, and remaining gaps. Verify the checkpoint against actual files before continuation.

## Pi adapter

Use `/writer review --brief "Audit character knowledge and the missing-key timeline"` or load this skill during `/writer continue`.
