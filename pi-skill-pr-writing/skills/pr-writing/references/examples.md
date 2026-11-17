# Annotated PR examples

Short excerpts from merged PRs, with what each one does well. Read the full PRs for context. Excerpts are trimmed; the links point to the originals.

Sources reviewed in November 2026: 60 merged PRs by Julius Marminge and 50 by Theo Browne in `pingdotgg/t3code`, the merged PRs Mario Zechner authored in `earendil-works/pi` (most of his work lands as direct commits, so the sample is small), and both projects' `CONTRIBUTING.md`, `AGENTS.md`, and PR template.

## Common ground

- Titles use conventional commits and describe the result, often as a sentence about behavior.
- The body opens with the concrete problem, not with "This PR".
- Verification shows the failure on `main` and the fix on the branch, with counts or numbers.
- Unverified parts are named, not skipped.
- No emojis, no marketing tone. Both projects close PRs that read as unreviewed agent output.

## Small fix without headings

[pingdotgg/t3code#37746](https://github.com/pingdotgg/t3code/pull/37746), `fix(ci): iOS preview builds record their tag on macOS awk` (+1/-1)

> The `iOS preview client` job fails whenever a PR needs a fresh iOS build. The build succeeds, then `Record build` exits 2: the macOS runner's BSD awk reads the unescaped `/` in `[^/]` as the end of the regex. PRs that reuse a cached fingerprint skip that step, so the failure looks intermittent.
>
> The fix selects the profile path with `grep -E`, which needs no regex delimiters and behaves the same in BSD and GNU.

Why it works: symptom, exact cause, why it looked intermittent, then the fix and why it is portable. Two paragraphs for a one-line diff.

[earendil-works/pi#7262](https://github.com/earendil-works/pi/pull/7262), `fix(tui): shorten image fallback paths and clamp width`

> Image.render() previously emitted the imageFallback line without truncateToWidth. Long absolute paths exceeded the terminal width and crashed the TUI.
>
> - imageFallback: home-shorten paths to ~/...; OSC 8 file:// link when hyperlinks are available
> - Image.render: truncate fallback lines to the render width
> - tests for shorten, hyperlink, basename, and width clamp

Why it works: one sentence of cause, one of effect, one bullet per change. Mario's style.

## Four-section bug fix

[pingdotgg/t3code#37271](https://github.com/pingdotgg/t3code/pull/37271), `test(desktop): two-account callback test uses two distinct ports`

> **Problem.** The test called `freePort()` twice in a row. `freePort()` binds port 0, reads the port, and closes the socket, so the kernel can return the same port on the next call. On Linux, 5 of 20,000 back-to-back bind/close pairs returned the same port.
>
> **Change.** New `freePorts(count)` holds every probe socket open until all ports are read. Test-only.
>
> **Scope.** CI flake fix, test-only. No issue: the CI runs above show the failure.
>
> **Verification.** Old code with `freePort()` forced to return the same port twice: fails 3/3 with the CI error. Fixed file: 5/5 runs pass. Not checked: the general window between closing a probe socket and the product listening.

Why it works: it measured how rare the flake is, forced the failure on purpose, and said what remains open.

## Race condition proved by forcing the timing

[pingdotgg/t3code#36218](https://github.com/pingdotgg/t3code/pull/36218), `fix(native): KDE SnapShot no longer loses the first reply from KWin`

> Stress alone did not reproduce it: 0 failures in 1200 runs under CPU contention. Forced timing: I built the crate against a local copy of zbus that starts the object server task 300 ms late. Old code: fails 3 of 3 with the CI panic. This change: passes 5 of 5 with the same delay.

Why it works: it admits that the obvious check proved nothing, then shows a check that does.

## Performance with a table

[pingdotgg/t3code#35286](https://github.com/pingdotgg/t3code/pull/35286), `perf(server): long threads open 2 to 6x faster from a cold cache`

The Problem section names the regressing PR and the exact query plan. Verification has a table of cold and warm timings on two real databases, states the setup (fresh clone, page cache evicted, median of 5), and confirms both sides return the same snapshot. Three tests are named that fail on `main` with the old query plan and pass here.

[pingdotgg/t3code#35740](https://github.com/pingdotgg/t3code/pull/35740), `fix(dev): long-running dev servers no longer leak memory when other worktrees install`

Opens with the incident in numbers ("grew to 7.7 GiB RAM plus 50 GiB swap"), uses bold run-in labels instead of headings for Cause and Fix, and ends with what was not reproduced and the leak that remains upstream.

## Small feature

[pingdotgg/t3code#35783](https://github.com/pingdotgg/t3code/pull/35783), `feat(mobile): secret field gets an eye toggle to show what you typed`

> On mobile, the secret request card hides what you type, and you cannot check it before you save. A long password typed on a phone keyboard is easy to get wrong.
>
> The field now has the usual eye icon. Tap it to show the text, and tap it again to hide it.

Then one bullet per platform, a screenshot table for Android and iOS, and a proof paragraph that the stored value matched what was typed.

## Design note

[earendil-works/pi#6916](https://github.com/earendil-works/pi/pull/6916), `feat(agent): add AgentHarness execution tools`

> This implements the abstraction @mitsuhiko and I talked about on a call today. We introduce an `AgentHarnessTool`, which in addition to the arguments passed to `AgentTool.execute()` also gets an arbitrary app specific context.

Why it works: it links the change to the decision behind it and explains the new type in two sentences, then points to the example file.

## Multiple regressions in one PR

[pingdotgg/t3code#37797](https://github.com/pingdotgg/t3code/pull/37797), `fix(mobile): one Working row after worktree setup, and follow-ups no longer drop a short thread`

Opens with "Two regressions found on TestFlight after #37508." Each regression gets a bold one-line label, a paragraph of cause and fix, and its own before/after image. Ends with "Not verified on device" and the two interactions it could not test.

## Patterns to avoid

Seen in the same repos, mostly in automated PRs:

- A first paragraph narrating the agent's session ("Watched PR to green. CodeRabbit posted two Minor findings..."). Put that in a comment.
- The same item repeated in "Not in this change".
- A "Changes" section that lists file paths instead of behavior.
- "Tests pass, confirming the fix works correctly." with no failing-before evidence.
