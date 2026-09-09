# Stop Slop

Check prose with repeatable local style scores, then measure what changed after a revision.

## Helpful when

- You used Unslop and want a measurable check of the result.
- A draft repeats the same openings, transitions, or rhetorical patterns.
- You need exact passages to review and a before/after comparison, not a vague instruction to “sound human.”

## What to share with Pi

- The draft or its file path, intended audience, and tone.
- Any wording that must stay unchanged, including quotations, commands, numbers, and safety warnings.
- Whether you want an evaluation only or edits followed by another check.

## Try asking

> Run Stop Slop on docs/launch.md after Unslop. Save the current text as the baseline, revise the flagged prose, and compare the result. Keep the performance figures and quotations unchanged. Stop after two passes and explain any findings you kept.

Unslop is optional. To check an untouched draft, ask “Evaluate this draft with Stop Slop; do not edit it.” You can also start with `/skill:stop-slop`.

## What you’ll get

- Eight category scores covering formulaic phrases, rhetoric, repetition, adverbs, em dashes, rhythm, passive voice, and vague emphasis.
- Flagged text with line and column locations, counts, and suggested checks.
- A comparison showing which scores improved or worsened after editing.

The bundled `slopcheck` command checks a file without changing it:

```bash
slopcheck README.md
slopcheck revised.md --baseline original.md --json
```

Pi can run the bundled checker directly if `slopcheck` is not on your PATH. No separate CLI installation is needed for the skill workflow.

## Keep in mind

Scores measure defined style patterns, **not AI probability or writing quality**. Lower is fewer patterns, not necessarily better prose. Grammar checks are heuristics. Keep wording that serves the reader, even when it is flagged.

Requires Node.js 20+ and English text. The checker runs locally and does not edit files or use a network. Reports contain excerpts of your draft, so your agent's normal session logging and model privacy rules still apply.

## Install

```bash
pi install npm:@firstpick/pi-skill-stop-slop
```

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for commands, score interpretation, compatibility, and limitations. Based on Hardik Pandya's MIT-licensed [stop-slop](https://github.com/hardikpandya/stop-slop), with a deterministic evaluator added for this package.
