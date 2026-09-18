# Writer for Pi

Plan, write, and resume novels, light novels, serial fiction, and manga scripts with a saved project and a reusable writing voice.

## What you can do

- Blend styles such as emotional, epic, intimate, lyrical, dark, humorous, or restrained.
- Start a book, chapter, scene, or volume through one guided command.
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

Start Pi in the folder where you want to keep your writing projects, then enter:

```text
/writer
```

Choose **New book**, give it a title, and choose its format, voice, genre, and language. Pi creates the project and helps you plan the opening. You review the direction before drafting begins.

You can also start directly:

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

The 17 bundled skills can also respond to ordinary requests such as "Give these two characters different dialogue voices" or "Check who knows about the missing key."

## Before you start

Use a trusted workspace with Pi's read, write, and edit tools enabled. The package uses your active model. Manuscript text read by Pi becomes part of that model's context and may be sent to its provider.

Keep backups or version control. Draft quality and continuity checks depend on the model, and preservation instructions are not a filesystem sandbox. Avoid concurrent writing sessions on the same project.

Manga support produces text scripts and storyboards, not finished artwork. Nothing is published or uploaded to a separate writing service automatically.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for all commands, the skill catalog, saved-project locations, compatibility, privacy, and troubleshooting.
