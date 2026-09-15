# Guided Git workflow: technical reference

Advanced user guidance for native generation, the Pi TUI workflow, WebUI activation, safety checks, limits, and recovery.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Requirements

- Pi with extension support
- Node.js 22.19 or newer
- Git available on `PATH`
- A normal, non-bare Git worktree on an attached branch
- An active model for direct generation commands, or a valid configured model for native or browser generation
- Authenticated system `gh` only when publishing a repository that has no remote
- A compatible WebUI RPC session for browser activation

One extension provides the workflow launcher and all three generation commands. No additional prompt package is required.

## Commands

```text
/git-guided-workflow
/git-guided-workflow-setup
/git-staged-msg [en|de] [auto|never|required]
/git-branch-name
/pr [en|de]
```

Unknown or extra arguments are rejected before repository data is read or a model is called. Generation commands require an idle Pi session with no queued messages and support Pi's interactive TUI and compatible RPC sessions.

`/git-staged-msg` defaults to English with automatic scope selection. It writes:

- `dev/COMMIT/staged-commit-short.txt`
- `dev/COMMIT/staged-commit-long.txt`

`/git-branch-name` accepts no arguments and writes `dev/COMMIT/staged-branch-name.txt`.

`/pr` defaults to English and writes one file under `dev/PR/`. The current branch is encoded as a single safe filename, so `feat/example` becomes `dev/PR/feat%2Fexample.md`.

The three generation commands generate files only. They do not stage, commit, create or switch branches, push, or run GitHub CLI. The guided workflow performs only the mutations you confirm.

## Native generation and privacy

Each generation command calls its selected model directly. Commands invoked normally use the active Pi model. Browser-launched commands use the model saved in Guided Git Setup through an isolated provider request, without changing the parent tab's active model or reasoning effort. The command does not expand a slash-prompt template, send a parent-agent message, or enter an agent tool loop, and it shows the selected provider and model before sending data.

Only the complete bounded context needed for the artifact is sent:

- commit generation sends the complete staged diff, either directly or across sequential analysis requests;
- branch generation sends the complete staged diff and may also send the validated generated commit files when both exist; and
- PR generation sends the current branch/base identities, complete bounded commit list and diff, and an optional `.github/PULL_REQUEST_TEMPLATE.md`.

Git content, filenames, commit text, templates, and generated chunk summaries are marked as untrusted data. They can still contain private information. Do not invoke generation unless sharing that context with the selected model provider is acceptable.

`/git-staged-msg` requires a complete valid UTF-8 staged diff and captures at most 16 MiB. At or below 1 MiB, it sends one direct request. Above 1 MiB, it divides the complete diff into UTF-8-safe chunks of at most 512 KiB and analyzes them sequentially. Each accepted summary is limited to 16 KiB and may use any non-empty safe plain-text presentation; delimiters and layout are guidance only. Chunk-summary requests also carry a 4,096-token provider output ceiling; commit synthesis and correction use an 8,192-token ceiling, with the byte parser remaining authoritative. The final synthesis sends the ordered summaries, not the full diff again. At the 16 MiB ceiling, UTF-8 boundary handling permits at most 33 analysis requests, followed by one synthesis request. The command reports this multi-request work before it starts and reports when analysis is complete.

Large-diff generation can therefore take longer and cost more than direct generation. A successful large-diff run uses one request per chunk plus one synthesis request. Chunk-summary formatting never adds a retry. An invalid final commit response can add one final correction request, for a maximum of 35 requests at the capture ceiling. A provider failure, cancellation, or empty, unsafe, or oversized summary stops later requests. A diff above 16 MiB or invalid UTF-8 is refused rather than truncated or sampled.

The 1 MiB all-or-nothing limit for `/git-branch-name` remains unchanged. PR commit, diff, and template context still has a combined 1 MiB cap; the optional template also has a 128 KiB cap.

Chunk-summary presentation is not parsed as a response format. The command trims surrounding whitespace and accepts any remaining non-empty text that stays within the byte limit and contains no unsafe control or bidirectional characters. If the direct response or large-diff synthesis cannot be safely separated into final commit artifacts, `/git-staged-msg` makes exactly one final correction request to the same model. Direct final correction reuses the captured staged snapshot. Large-diff final correction reuses the retained summaries and does not resend or reanalyze the diff chunks. The request includes validation feedback and the failed response when it is safe and fits the 32 KiB correction bound. Oversized output and output containing unsafe control or bidirectional characters are omitted from final correction. A second unsafe or structurally invalid final response is terminal. Quality deviations do not start correction. Provider failures, cancellation, Git failures, source drift, and artifact-write failures do not start correction. Branch and PR generation do not use correction requests.

Only one native generation command can be active at a time, including its correction request. Session shutdown aborts the nested model request, including settling the command when a provider does not cooperate with cancellation. An aborted or failed command writes no new artifact and reports no stale success.

## Generated output guidance and checks

The commit model is asked to:

- use one of `build`, `change`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, or `test`;
- follow Conventional Commit syntax;
- satisfy the requested scope policy;
- keep the subject within 72 Unicode characters; and
- begin the long message with the short subject and use typed body bullets.

These are quality guidelines. A deviation does not discard the generated message or start correction. Delimiters and layout are optional: framed output is separated directly, while other safe text uses its first content line as the short message and the complete text as the long message. Commit output is rejected only when it is empty, an artifact exceeds its byte limit, or the content contains unsafe control or bidirectional characters.

Generated branch names use an allowed type, `/`, and two to five lowercase kebab-case words. Traversal and invalid Git-ref forms are rejected.

Generated PR descriptions must be bounded Markdown with no unresolved common template placeholders, unsafe controls, empty sections, or unsupported claims that tests or checks ran. No execution evidence is supplied to `/pr`, so the description must use neutral verification wording.

Commit responses and chunk summaries do not require delimiters; they are bounded untrusted text, and presentation is guidance only. Branch and PR responses retain required delimiters because they map to one specialized validated artifact contract. The first empty, unsafe, or oversized final commit response can enter the single correction path described above; every other unsafe or structurally invalid final output is rejected.

## Artifact and snapshot safety

Commit and branch generation bind the canonical repository root, attached branch, HEAD, and stable staged fingerprint. PR generation binds the root, current branch, HEAD, resolved base, merge base, commit range, complete diff, and optional template. Source state is checked again around the write; drift restores the previous artifact where possible.

Artifact directories and destinations must remain inside the canonical repository root and may not be symlinks. Writes use private same-directory temporary files and backups through Pi's file-mutation queue. The two commit files are replaced as one coordinated transaction and roll back together on failure.

PR base resolution uses the first valid source in this order:

1. a distinct configured upstream base;
2. one unambiguous remote symbolic default;
3. local `main`;
4. local `master`.

The command does not invent a base. Detached HEAD, missing or ambiguous bases, unrelated histories, an empty range, or branch/base drift are rejected.

## Guided workflow surfaces

`/git-guided-workflow` accepts no options and refuses to start while Pi is busy or messages are queued.

In Pi's native TUI, its stages are:

```text
Initialize → Stage → Message → Commit → Push
```

Every screen is a centered, width-bounded and height-bounded overlay. Lists and settings use Pi's native list components, and commit text uses the native editor. Press Escape to cancel without mutation. Choose **Finish** to stop. Stage all, initialization, starter creation and staging, commit, push, and publication have explicit confirmation boundaries. The workflow rejects conflicts, detached HEAD, bare repositories, and active merge, rebase, cherry-pick, revert, or bisect operations.

Manual message entry uses Pi's native editor and needs no model. Press `Shift+Enter` or `Ctrl+J` to insert a body newline; Enter submits the editor. If the terminal is too short for the native editor and its cursor, editing and submission pause until you resize it; Escape still cancels and the unchanged document regains focus after the terminal grows. Existing paired `dev/COMMIT/` files can be previewed and explicitly reused, but remain labeled unverified for the current index. One clean staged added, modified, or deleted file with no other changes can offer `created`, `updated`, or `deleted` plus the exact path. That status and repository identity are captured between matching staged fingerprints after your Stage or direct-entry selection. Mixed, renamed, conflicted, unsafe, and overlong paths get no automatic message. Every selected message is reviewed and rebound to a fresh staged fingerprint before commit.

Optional TUI generation sends the complete stable staged diff only after you select generation. It accepts up to 16 MiB, using one request at or below 1 MiB and sequential analysis of chunks up to 512 KiB followed by final synthesis above that threshold. It reports the request count before analysis starts. Large diffs can take longer and cost more, with at most 34 requests. Unlike `/git-staged-msg`, the guided TUI does not request a final correction or write message artifacts. Generation failures, cancellation, and diffs above 16 MiB leave manual entry available. The workflow rechecks root, branch, HEAD, operation state, and staged content before commit.

Push can bind either the commit created in this invocation or an existing HEAD chosen through direct Push entry. The workflow rechecks canonical root, branch, immutable HEAD, remote, and refspec after confirmation. Force options are never used and uncertain push outcomes are never retried automatically.

For a directory outside Git, Initialize binds the directory identity, refuses parent or existing repositories, runs `git init --initial-branch=main --`, and never renames an existing branch. Optional root `README.md` and `.gitignore` starters never overwrite files or follow symlinks. Only selected newly created starter paths can be staged.

When no remote exists, Push can offer publication through authenticated system `gh`. Public and Private have no preselected visibility. Before one invocation, the overlay shows and rechecks `github.com`, authenticated account, root-derived repository name, canonical root, branch, exact HEAD, visibility, and command. Session shutdown is checked again after asynchronous revalidation and immediately before initialization, starter creation or staging, and publication starts. Existing remotes, invalid names, missing authentication, drift, cancellation, and ambiguous results stop without retry or automatic cleanup.

In a compatible WebUI RPC session, `/git-guided-workflow` emits a one-shot activation request for the originating tab. The activation runs no Git command, calls no model, and includes no repository path or Git data. Browser generation requires the three RPC-capable extension commands from this package; same-named prompt templates are not accepted as the native generation path. The WebUI passes its configured generation profile in a private extension-command argument. The extension validates that profile, invokes the selected provider independently, and writes the correlated artifact without switching or restoring the parent tab's active model or reasoning effort.

## Native setup

`/git-guided-workflow-setup` stores native preferences in `git-guided-workflow.json` under Pi's agent directory. This file is separate from WebUI settings and contains no secrets. Opening or cancelling setup does not write it. Press `Ctrl+S` on the settings overlay to save explicitly.

You can select an available primary model and supported reasoning effort, an optional different fallback profile, English or German, automatic/never/required scope, short or long default variant, preserve or stage-all ordering, default entry stage, and an ask/none verification reminder. Unconfigured generation uses the active Pi model. A configured unavailable model or effort disables generation with a warning instead of substituting the active model; manual, saved-artifact, deterministic, initialization, and push flows remain available.

Fallback is limited to one final eligible provider failure. The overlay identifies both profiles and warns before work that fallback resends the staged evidence. Cancellation, invalid output, invalid preferences, drift, Git failures, and artifact failures do not use fallback. Manual entry remains available without any model.

## Troubleshooting

### The browser workflow does not open

Confirm that the originating tab is idle, has no queued messages, and lists `/git-guided-workflow`, `/git-staged-msg`, `/git-branch-name`, and `/pr` as extension commands. Restart Pi and refresh WebUI after installing or updating the extension. A disconnected browser can miss the one-shot activation; it is not replayed automatically.

### Generation is unavailable

For a direct command, select an active model. For browser generation, verify the model saved in Guided Git Setup is still authenticated and available. Confirm that the session is idle. For commit or branch generation, stage at least one change. If `/git-staged-msg` exceeds 16 MiB, `/git-branch-name` exceeds 1 MiB, `/pr` exceeds its 1 MiB combined cap, or required input is not UTF-8, reduce the input or write the artifact manually. If large-diff analysis fails partway through, fix the reported provider, cancellation, or invalid-summary problem and invoke the command again; no partial artifact is installed and completed summaries are not saved across commands.

### PR generation cannot find a base

Configure a distinct upstream base, fetch a remote symbolic default, or keep an existing local `main` or `master` branch. The command deliberately refuses ambiguous and unrelated histories.

### An artifact was not updated

Read the exact failure notification. Check for staged, HEAD, branch, base, or template drift; unsafe symlinks under `dev/`; invalid model output; or cancellation. Prior valid artifacts remain in place when rollback succeeds.

### A commit or push result is uncertain

Do not repeat the operation blindly. Inspect local HEAD and the remote branch with your normal Git tools. The extension deliberately avoids pull, fetch, merge, rebase, reset, amend, stash, and force-push recovery actions.

## Removal and recovery

Remove the extension with:

```bash
pi remove npm:@firstpick/pi-extension-git-guided-workflow
```

Restart Pi and refresh connected WebUI tabs afterward. Removing the extension does not delete generated files or undo commits and pushes.
