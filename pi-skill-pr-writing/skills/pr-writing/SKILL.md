---
name: pr-writing
description: Agents should invoke this skill whenever they write, draft, or revise a pull request title or description, including when a PR workflow such as /pr, file-pr, or full-stop asks for one. Produces short, evidence-first PR text in the style of the T3 Code and Pi maintainers, with outcome titles, Problem/Change/Scope/Verification bodies, and stated limits.
license: MIT
compatibility: Portable Agent Skills-style skill. Guidance only. No tools, scripts, or dependencies. It does not create, push, or edit PRs by itself.
---

# Writing a pull request

A PR description exists so a reviewer can decide fast. They want to know what was broken, what you changed, why that change is the right size, and how you know it works. Everything else is noise.

This guide is distilled from merged PRs by the T3 Code maintainers (Julius Marminge, Theo Browne) and the Pi maintainer (Mario Zechner), plus the contribution rules both projects publish. See [references/examples.md](references/examples.md) for annotated excerpts.

## Before you write

1. Read the target repo's `CONTRIBUTING.md`, `AGENTS.md`, and `.github/pull_request_template.md`. Their rules win over this guide. Keep the template's headings and delete its comments.
2. Read the full diff against the base branch, not just your memory of the session. Describe what the diff does.
3. Check that the PR fixes one problem. If you see two independent fixes, or a fix plus a refactor, say so and suggest a split before writing.
4. Collect evidence: the command you ran, the test that fails on the base branch and passes here, numbers, screenshots. If you have none, say what is unverified instead of inventing it.

## Title

Use the repo's commit convention, usually `type(scope): summary`, in lowercase plain words.

State the outcome a user or reviewer will see, not the code you touched:

- Good: `fix(web): mic button always sits next to send`
- Good: `perf(server): long threads open 2 to 6x faster from a cold cache`
- Good: `test(desktop): two-account callback test uses two distinct ports`
- Weak: `fix: update ChatInput component layout logic`
- Weak: `Improve performance of thread loading`

A plain change description is fine for internal or library work (`fix(tui): shorten image fallback paths and clamp width`). A number belongs in the title only when you measured it. Reverts keep git's default title.

## Pick the size of the body

Match the body to the diff, not to how hard the session felt.

- **Trivial** (one-line fix, docs, changelog, revert). One to three sentences, no headings. `Reverts owner/repo#7440` is a complete body.
- **Small fix**. Two short paragraphs without headings. First the symptom and cause, then the fix and how you checked it. Add a link to a failing CI run if that is how you found it.
- **Normal**. Four sections: Problem, Change, Scope, Verification. Use the repo template's names when it has one.
- **Large, performance, or design change**. The four sections plus a measured table, a "Not in this change" list, and a short "Why X and not Y" note when a reviewer will ask about an alternative.

If it does not fit on one screen, check whether the PR is doing too much before you trim words.

## The four sections

### Problem

The symptom first, in concrete terms. Then the cause.

- Name the exact failure: the test name, error string, panic location, timing, memory figure, or the CI runs where it happened.
- Say how you found it and how often it happens ("5 of 20,000 back-to-back bind/close pairs returned the same port").
- Explain the cause as a short trace: what calls what, and where it goes wrong. Cite the commit or PR that introduced a regression.
- For a feature, state the user's problem in one or two sentences ("A long password typed on a phone keyboard is easy to get wrong").

### Change

How the diff fixes the problem.

- Lead with the one sentence a reviewer must remember.
- Use one bullet per component or mechanism, saying what it does now. Name functions, flags, and files in backticks when they help a reviewer find the change. Do not list every file touched.
- When the fix spans server, client, and tests, say why each part is needed for this same fix.
- Mark scope limits plainly: "Test-only.", "No migration and no new index.", "Production code is unchanged."
- Mention side changes a reviewer would trip over, such as an updated `AGENTS.md` or removed workaround.

### Scope

Why this PR exists and is allowed.

- Link the issue with a closing keyword (`Fixes #213`) or the maintainer request that asked for it.
- For a small obvious fix with no issue, say why it needs none ("the CI runs above show the failure").
- Point to related or prior PRs that touched the same behavior.

### Verification

What you ran and what you saw. "Tests pass" alone is not evidence.

- Prove the fix against the base branch: the reproduction or test fails on `main` with the original error, and passes on this branch. Give counts ("fails 3 of 3", "passes 5 of 5").
- For a race or flake, say how you forced the timing, because stress runs that never fail prove nothing.
- For performance, give a before/after table with the setup (data size, cold or warm, hardware) and confirm both sides return the same result.
- For UI, embed before/after screenshots side by side and link a short recording when motion or timing matters. Upload evidence to the PR. Never commit PR-only assets.
- List the focused checks you ran with their result. Broad repo-wide checks are optional unless the repo requires them.
- End with **Not checked:** and name what you could not verify and why (no macOS, no real device, no live server).

## Optional sections

- **Measured**: a before/after table. Columns are the scenario, then before and after.
- **Not in this change**: known related problems left out on purpose, each with one reason. Do not repeat items.
- **Why X and not Y**: one paragraph when you rejected an obvious alternative or a competing PR.
- **Credit**: name the person who reported or reproduced the bug.

## Agent attribution

When an agent did the work, end with one line naming the model and harness, for example "Made by Claude Opus 5.5 in Claude Code (T3 Code)." Add a review line if a separate model reviewed it ("Reviewed with sol-loop: 1 pass with GPT-6.1 Sol."). Follow the repo's rule if it asks for a different format, and follow the harness's attribution footer when one is required. Some projects reject PRs from specific models, so check `CONTRIBUTING.md`.

## Voice

- Plain, direct, technical. Write for a busy maintainer who knows the codebase.
- First person is fine for what you did ("I built the crate against a local copy of zbus"). Mario writes PRs as notes to a colleague ("This implements the abstraction @mitsuhiko and I talked about on a call today").
- Present tense for the new behavior ("The field now has the usual eye icon").
- Numbers over adjectives. "About 3x less" beats "significantly faster".
- No emojis, no cheerful filler, no "This PR aims to". Apply the `unslop` skill if it is available.
- Keep the template's headings. Do not add a heading for one sentence.

## Do not

- Paste the agent's work log. "Watched the PR to green, CodeRabbit posted two findings" belongs in a PR comment or nowhere.
- List changed files as the description of the change.
- Claim checks you did not run, or say "should work".
- Copy the issue text back into the PR.
- Edit `CHANGELOG.md` when the repo says maintainers own it.
- Bundle a refactor, a formatting pass, or a second fix "while you were there".

## Final check

- [ ] The title states the outcome in the repo's commit format.
- [ ] The body size matches the diff.
- [ ] Problem names the concrete symptom and its cause.
- [ ] Change explains the mechanism and why each part is needed.
- [ ] The issue or request is linked, or the reason it is not is stated.
- [ ] Verification shows base-fails and branch-passes evidence, or says what is unverified.
- [ ] UI changes have before/after evidence uploaded to the PR.
- [ ] Repo template headings are kept and its comments removed.
- [ ] No work log, file list, emojis, or invented results.
