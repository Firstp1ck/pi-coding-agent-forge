# Guided Git workflow for Pi

Use native Pi commands to generate Git text safely, or start a careful commit-and-push flow in Pi's terminal interface or a compatible WebUI.

## What you can do

- Generate validated Conventional Commit files from staged diffs up to 16 MiB with `/git-staged-msg`; large diffs are analyzed completely in bounded sequential requests before one final synthesis.
- Generate a safe branch-name file with `/git-branch-name`.
- Generate a reviewer-focused pull-request description with `/pr`.
- Review staged changes, commit, and push through the existing `/git-guided-workflow` TUI flow.
- Start the richer Guided Git browser flow from the same workflow command in a compatible WebUI.

## Install

```bash
pi install npm:@firstpick/pi-extension-git-guided-workflow
```

Restart Pi and any connected WebUI tabs after installation.

## How to use it

Open Pi inside the repository you want to work with. To use the guided flow, run:

```text
/git-guided-workflow
```

In Pi's native terminal interface:

1. Choose the current staged set or confirm **Stage all changes**.
2. Write a message manually, or choose generation when an active model is available. Guided message generation accepts staged diffs up to 16 MiB.
3. Review the exact message and staged summary, then confirm the commit.
4. Push to the shown destination, or finish with the commit kept locally.

In a compatible WebUI, the same command asks that WebUI to open its Guided Git workflow for the originating tab. The browser keeps its staging, isolated generation profile, artifact checks, commit, push, and optional pull-request controls. The saved generation model runs independently without changing the tab's active model or reasoning effort.

You can also generate artifacts directly:

```text
/git-staged-msg en auto
/git-branch-name
/pr en
```

The commands write under `dev/COMMIT/` and `dev/PR/`; they do not stage, commit, switch branches, push, or create a pull request.

## Before you start

This extension runs Git with your user permissions. Review staged changes and displayed destinations carefully. The guided TUI never force-pushes, but a normal push still changes a remote repository.

Manual message entry never needs a model. Model generation sends the required complete, bounded Git or repository context directly to the selected model provider only after you select generation or invoke a generation command. Direct commands use the active Pi model; browser-launched generation uses the model saved in Guided Git Setup without changing the parent tab's model or reasoning effort. That content may contain private code, commit text, filenames, or a pull-request template. Do not generate unless sharing that content with the selected provider is acceptable.

Generation commands call the selected model directly. They do not expand prompt templates or ask a parent agent to run Git or file tools. Both `/git-staged-msg` and guided TUI message generation use one request for a staged diff at or below 1 MiB. Above 1 MiB, both send every byte of the staged diff to the provider in bounded sequential chunks, then ask once for a final message using the retained summaries. This takes several requests, can cost more, and may take longer. Both report the request count before analysis starts.

`/git-staged-msg` applies staged-only language, scope, type, length, and body guidance. Those are quality guidelines, not reasons to discard safe generated text. Chunk summaries accept any non-empty bounded safe plain text; presentation and delimiters are not enforced. If the final commit response cannot be safely parsed into message artifacts, the command can send one final correction request. Large-diff final correction reuses the retained summaries and does not analyze the chunks again. A provider failure, empty or unsafe chunk summary, repository drift, cancellation, or unsafe artifact path writes no new artifact and produces no stale success.

Requesting the browser workflow sends no repository path, diff, preferences, or Git data in the activation signal. The WebUI then owns its browser workflow and passes the configured generation profile privately to the extension command.

Git hooks and signing remain enabled for guided commits. Hooks can change the worktree or index while a commit is being created. A timed-out push can be uncertain; the workflow will not retry it automatically.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for complete commands, limits, WebUI compatibility, safety, and troubleshooting. Contributors can use [DEVELOPMENT.md](DEVELOPMENT.md).
