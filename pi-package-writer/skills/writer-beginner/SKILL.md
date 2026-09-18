---
name: writer-beginner
description: Help a beginner start or continue fiction through small exercises, plain-language explanations, short examples, and specific feedback. Use when someone wants to learn to write a novel, light novel, short story, manga, or webtoon without advanced knowledge.
license: MIT
---

# Begin writing a story

## When to use

Use when the author asks how to begin, says they lack writing experience, wants a concept explained, or chooses guided learning. Do not assume that every new project belongs to a beginner.

## Inputs and assumptions

A feeling, character, place, what-if, or even "I don't know yet" is enough. A working title is a folder label, not a creative commitment. Use the author's language. Read any existing draft and learning notes before choosing a next step.

## Portable workflow

1. Read [the beginner guide](../../references/beginner-guide.md), then choose only the step relevant now. Never recite the entire guide as a course syllabus.
2. Build on what the author has already shared. If they have no idea, offer a few distinct, concrete seeds or ask what sort of story they enjoy. Ask at most one question per reply and wait.
3. Find a person who wants something and one thing making it difficult. Explain a writing term only when it helps with the next choice, using a short example from this story.
4. Work toward one small scene. A few bullets about what happens next are enough preparation. Do not demand a full outline, ending, magic system, or detailed character biography.
5. Let the author choose to try writing, write together, or see a short original example. Use an already stated preference instead of asking again. Never complete their exercise unless they ask; explicit requests for a drafted chapter still authorize drafting.
6. Give feedback on one specific strength and one useful next improvement. Show a small before/after example when helpful, preserving their voice and story choices. Do not bury the author in corrections or empty praise.
7. Save the current question or exercise, what the author actually tried, helpful feedback, and one next small step. Resume that work next time instead of restarting the introduction.
8. Expand toward a chapter and a loose book plan when the author is ready. Skip familiar concepts and allow the author to leave guided learning at any time.

## Safety and side effects

Treat the author as an adult learning a craft. Avoid grading their talent, diagnosing confidence, or promising a publishable book. Practice drafts and model examples are not automatically approved manuscript text. Preserve original drafts and keep unresolved story choices open. A read-only review remains read-only, including learning notes.

## Scripts, references, and dependencies

No external service or script is required. The [beginner guide](../../references/beginner-guide.md) supplies small exercises and examples. Follow [the project workflow](../../references/project-workflow.md) for local saves and source preservation.

## Verification

The author should have one clear next action, not a reading list or a whole-book assignment. Confirm that explanations match their current question, examples are distinct from their own work, and saved progress records actual attempts rather than assumed mastery. State missing evidence if no writing sample is available.

## Pi adapter

- `/writer start` creates a beginner-guided project with only a working title, optional rough idea, and starting format.
- `/writer continue` resumes saved beginner projects with the same guidance after a restart.
- `/writer coach` teaches one step in an existing project without changing that project's default guidance.
- `/writer continue --guidance beginner` asks for coaching on this task; `--guidance standard` skips teaching on this task.
- Store project-specific learning notes in `learning.md`, with a matching next action in `progress.md`. Do not change the manifest or write a global learner profile.
