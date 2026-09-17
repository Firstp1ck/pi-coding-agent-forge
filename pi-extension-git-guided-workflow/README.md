# Guided Git workflow for Pi

Use native Pi commands to generate Git text safely, or start a careful commit-and-push flow in Pi's terminal interface or a compatible WebUI.

## What you can do

- Generate validated Conventional Commit files from staged diffs up to 16 MiB with `/git-staged-msg`; large diffs are analyzed completely in bounded sequential requests before one final synthesis.
- Generate a safe branch-name file with `/git-branch-name`.
- Generate a reviewer-focused pull-request description with `/pr`.
- Open a centered, bordered popup with its own background and direct Initialize, Stage, Message, Commit, and Push entry points.
- Reuse generated commit files, choose a safe one-file default, initialize a repository on `main`, or publish a no-remote repository through authenticated `gh`.
- Save native generation, language, scope, message, staging, entry, and verification defaults in a framed setup popup with `/git-guided-workflow-setup`.
- Start the Guided Git browser flow from the same workflow command in a compatible WebUI.

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

1. Choose a direct entry. A directory outside Git can be initialized on `main`; an existing repository is never renamed.
2. Preserve the current index or confirm **Stage all changes**. Starter files are created and staged only when you select them.
3. Write a message, generate candidates, explicitly reuse `dev/COMMIT/` files, or choose the one-file default when it is safe.
4. Review the exact message and staged summary, then confirm the commit.
5. Push the bound HEAD to the shown destination. When no remote exists, you may explicitly select Public or Private and publish once through system `gh`.

Run `/git-guided-workflow-setup` to edit native-only defaults in a bordered popup with its own background. Press `Ctrl+S` to save or Escape to cancel. Saving does not switch Pi's active model or reasoning effort. Until setup is saved, generation uses the active model and manual entry remains available.

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

Manual, reused, and deterministic messages never need a model. Model generation sends the required complete, bounded Git or repository context directly to the selected model provider only after you select generation or invoke a generation command. Direct commands use the active Pi model. Native and browser setup profiles run independently without changing the parent session's model or reasoning effort. If native setup includes a fallback, the overlay identifies both providers and warns that one eligible provider failure will resend the same evidence once. Cancellation, invalid output, invalid settings, repository drift, Git errors, and artifact errors never trigger fallback. That content may contain private code, commit text, filenames, or a pull-request template. Do not generate unless sharing that content with the selected provider is acceptable.

Generation commands call the selected model directly. They do not expand prompt templates or ask a parent agent to run Git or file tools. Both `/git-staged-msg` and guided TUI message generation use one request for a staged diff at or below 1 MiB. Above 1 MiB, both send every byte of the staged diff to the provider in bounded sequential chunks, then ask once for a final message using the retained summaries. This takes several requests, can cost more, and may take longer. Both report the request count before analysis starts.

`/git-staged-msg` applies staged-only language, scope, type, length, and body guidance. Those are quality guidelines, not reasons to discard safe generated text. Chunk summaries accept any non-empty bounded safe plain text; presentation and delimiters are not enforced. If the final commit response cannot be safely parsed into message artifacts, the command can send one final correction request. Large-diff final correction reuses the retained summaries and does not analyze the chunks again. A provider failure, empty or unsafe chunk summary, repository drift, cancellation, or unsafe artifact path writes no new artifact and produces no stale success.

Requesting the browser workflow sends no repository path, diff, preferences, or Git data in the activation signal. The WebUI then owns its browser workflow and passes the configured generation profile privately to the extension command.

Git hooks and signing remain enabled for guided commits. Hooks can change the worktree or index while a commit is being created. Generated files are labeled as unverified for the current index until you select and review one. Push and GitHub publication can have uncertain outcomes; the workflow will not retry or clean them up automatically.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for complete commands, limits, WebUI compatibility, safety, and troubleshooting. Contributors can use [DEVELOPMENT.md](DEVELOPMENT.md).
