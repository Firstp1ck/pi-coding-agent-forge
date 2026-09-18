---
name: writer-workflow
description: Coordinate fiction planning, drafting, continuation, revision, and adaptation using saved project files. Use for starting or resuming books, chapters, scenes, volumes, or manga projects.
license: MIT
---

# Writing workflow

## When to use

Use for multi-step fiction work, especially when continuing across sessions or choosing which writing specialty to apply.

## Inputs and assumptions

Identify the project, current task, output format, language, audience, desired voice, and requested scope. Saved manuscript evidence takes precedence over an unsupported recollection from chat.

## Portable workflow

1. Read [the project workflow](../../references/project-workflow.md) and inspect the saved project state.
2. Separate format, genre, style, and unit of work. Read [format guidance](../../references/formats.md) and [style choices](../../references/styles.md) only as needed.
3. Choose relevant specialist skills. Planning uses brainstorming and outlining. Drafting uses prose, the medium skill, and continuity. Revision uses critique and voice checks. Visual adaptation uses adaptation and manga guidance.
4. Clarify only missing decisions that affect this deliverable. A new book starts with an agreed direction, not automatic whole-book generation.
5. Complete one bounded step. Save authorized outputs, verify them, and record the next step. Stop at an author decision rather than guessing approval.

## Safety and side effects

Creating and drafting can write local files. Reviewing is read-only. Preserve existing prose and keep proposed ideas separate from canon. Do not install, publish, upload, or generate images merely to run a writing workflow.

## Scripts, references, and dependencies

No scripts or external services required. Specialist instructions live in sibling skill directories. The shared references define file responsibilities and medium-specific checks.

## Verification

Confirm the requested scope was delivered, saved paths exist when saving was requested, the checkpoint matches the files, and unresolved choices remain visible. Do not report a reserved target as a finished chapter.

## Pi adapter

Use `/writer` for the guided menu, `/writer new book "Title"` to start, and `/writer continue` to resume. The command uses the active model and saves projects under the invoking workspace's `writing/` directory. It does not need the separate workflows extension.
