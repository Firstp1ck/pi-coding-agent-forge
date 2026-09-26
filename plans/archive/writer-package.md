# Pi writer package

Status: implemented and locally verified. See [the validation report](../../pi-package-writer/tests/VALIDATION.md) for checks and remaining live-model evaluation.

## Scope

Create `@firstpick/pi-package-writer` with original, portable writing skills covering the capabilities discussed in the online survey. Do not vendor upstream Claude hooks, browser scrapers, model selection, or image-generation integrations. Credit the research sources and explain the difference from upstream bundles.

## Implementation plan

1. Add portable skills for planning, characters, worlds, style, prose, novels, light novels, serial fiction, manga scripts, adaptation, import, continuity, revision, reader feedback, and research.
2. Implement `/writer` with a cancellable UI menu and explicit arguments for new books, chapters, scenes, volumes, opening projects, continuing, and focused writing tasks.
3. Persist projects under the invoking workspace's `writing/` directory. Refuse collisions, validate local paths and metadata, reject symlink traversal, and keep saved manuscript state separate from chat history.
4. Hand bounded tasks to the active Pi conversation model. Load only relevant bundled skills. Do not claim generated drafts or checkpoints are saved until the agent actually saves them.
5. Add unit, filesystem, command-integration, and package-content checks. Test cancellation, busy handling, restart/resume, corrupt state, collisions, and unsafe paths.
6. Document installation, workflows, controls, privacy, limits, and contributor contracts. Add the repository catalog entry without changing the existing review-extension work.

## Completion criteria

- One package registers the skills and `/writer` command.
- New work is saved in an explicit project directory; continuing re-reads saved state.
- Style, format, genre, language, and work scope remain independent choices.
- Review is read-only and revision/adaptation use new outputs by default.
- No global installation, npm publication, external manuscript upload, or generated images in this change.
- Tests, documentation checks, and npm package inspection pass, with live-model quality checks reported separately.
