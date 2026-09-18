# Writer for Pi

Plan, write, and resume novels, light novels, serial fiction, and manga scripts with a saved project and a reusable writing voice.

## What you can do

- Blend styles such as emotional, epic, intimate, lyrical, dark, humorous, or restrained.
- Learn as you write, with beginner-friendly questions, short examples, and one small exercise at a time.
- Resume from saved drafts, continuity notes, and a writing checkpoint across Pi sessions.
- Develop characters and worlds, review drafts, and save revisions without replacing the originals by default.
- Adapt prose into manga or webtoon scripts with panels, dialogue, and visual pacing.

## Install

Once published to npm:

```bash
pi install npm:@firstpick/pi-package-writer
```

The npm release is not published yet. For local setup, see [DEVELOPMENT.md](DEVELOPMENT.md).

## How to use it

Start Pi in the folder where you want to keep your writing projects.

### New to writing? Start here

```text
/writer start
```

Give your project a working title and share anything that interests you: a character, a place, a feeling, or a rough idea. You can leave both blank. You do not need to know writing terminology or have a whole book planned.

Pi helps you turn that starting point into a person who wants something, a problem, and a small first scene. It explains one useful idea at a time. You can try writing yourself, write together, or ask for a short example. Feedback focuses on what works and one improvement to try next.

Your learning notes and next step are saved with the project. Use `/writer continue` to pick up where you stopped. For help with a project you already have, use `/writer coach`.

### Already have a direction?

Use `/writer` and choose **New book** to select format, voice, genre, and language yourself. You can also start directly:

```text
/writer new book "The Lantern Keeper" --format light-novel --style "emotional, epic" --genre fantasy --language English --brief "A keeper must choose which city receives the last light."
/writer new chapter "The Unlit Harbor" --brief "An intimate opening, about 1500 words, ending on a difficult decision."
```

Later, start Pi in the same folder and resume:

```text
/writer continue
```

Other useful commands:

| Command | What it does |
| --- | --- |
| `/writer list` | Find your projects in this workspace |
| `/writer open the-lantern-keeper` | Select a project without starting the model |
| `/writer status` | Show the saved checkpoint and recent writing units |
| `/writer new scene` | Start a smaller piece of writing |
| `/writer review --target "chapters/chapter-0001.md"` | Ask for critique without requesting edits |
| `/writer adapt --target "chapters/chapter-0001.md" --format manga` | Create a separate visual-script adaptation |
| `/writer help` | Show all command forms |

The 18 bundled skills can also respond to ordinary requests such as "Give these two characters different dialogue voices" or "Check who knows about the missing key."

## Before you start

Use a trusted workspace with Pi's read, write, and edit tools enabled. The package uses your active model. Manuscript text read by Pi becomes part of that model's context and may be sent to its provider.

Keep backups or version control. Draft quality and continuity checks depend on the model, and preservation instructions are not a filesystem sandbox. Avoid concurrent writing sessions on the same project.

Manga support produces text scripts and storyboards, not finished artwork. Nothing is published or uploaded to a separate writing service automatically.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for all commands, the skill catalog, saved-project locations, compatibility, privacy, and troubleshooting.
