# Development guide: Guided Git workflow for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Architecture

`index.ts` owns five Pi command registrations, surface routing, active nested-model lifecycle, session-shutdown cancellation, native workflow orchestration, WebUI activation, and user notifications.

`src/core.ts` owns shell-free bounded Git execution, repository preflight, status parsing, staged fingerprints and snapshots, fingerprint-enclosed status capture, commit-message validation, and commit/push plans.

`src/native-generation.ts` owns strict command argument parsing, staged/branch/PR generation contexts, commit capture and chunk bounds, UTF-8-safe partitioning, untrusted analysis/synthesis/correction requests, closed-output parsers, base resolution, artifact naming, snapshot revalidation, and secure transactional writes.

`src/preferences.ts` owns the separate bounded native settings file and profile validation. `src/message-files.ts` owns safe commit-artifact previews and deterministic one-file defaults. `src/repository-setup.ts` owns bounded initialization, starter-file, and one-shot GitHub publication plans, with current-workflow guards immediately before mutations after asynchronous revalidation. `src/tui.ts` owns centered overlay options and native SelectList, SettingsList, and Editor wrappers, including resize-required editor gating when the native cursor viewport cannot fit.

The registered commands are:

```text
git-guided-workflow-setup
git-staged-msg
git-branch-name
pr
git-guided-workflow
```

The three generation handlers parse arguments before repository or model work, require an interactive TUI or RPC surface, require an idle session, and share one active-generation slot. Setup is TUI-only and does not mutate the session model or WebUI preferences. Normal invocations require the active model. WebUI invocations carry a private versioned generation profile that resolves a configured model independently. The existing guided TUI command retains its Stage → Message → Commit → Push state machine.

## Native model lifecycle

A generation handler captures one immutable context and builds the corresponding `NativeModelRequest`. A normal command completes that request through `ctx.modelRegistry.complete` with the active model. A WebUI command decodes a private base64url profile argument, validates its exact version, provider, model, and supported reasoning effort, resolves the configured model through `modelRegistry`, and calls that provider's `streamSimple` independently with registry-supplied authentication. It never assigns `ctx.model` or `ctx.thinkingLevel`, so the parent session profile needs no restoration.

Before a direct provider call, `normalizeContext(request)` moves the shorthand system prompt into the transcript's leading system message. Do not pass `NativeModelRequest` directly to `provider.streamSimple()`. The registry completion path still accepts shorthand contexts. TUI and WebUI regression tests read provider instructions with `getCurrentSystemPrompt()` and check that isolated generation receives no parent tools.

Both paths pass a request-specific provider output-token ceiling, concatenate text response parts only, reject aborted/error responses, apply the relevant byte and safety checks, then pass the parsed value and the original context to the matching write helper. Chunk summaries use 4,096 output tokens, commit candidates and correction use 8,192, branch names use 128, and PR bodies use 32,768. The byte parsers remain authoritative because token-to-byte ratios vary by provider. Neither path calls `pi.sendUserMessage`, expands prompt templates, registers an LLM-callable helper tool, or asks an agent loop to inspect the repository.

Commit context acquisition passes `COMMIT_GENERATION_CAPTURE_MAX_BYTES` explicitly. At or below `COMMIT_GENERATION_DIRECT_MAX_BYTES`, the handler preserves the existing one-request `buildCommitModelRequest` path. Above that threshold it calls `partitionStagedDiff`, then loops over the returned chunks with `await` so only one `buildCommitChunkAnalysisModelRequest` completion is active at a time. `parseCommitChunkSummaryOutput` trims each response and accepts any non-empty bounded safe text; delimiter and layout guidance is not enforced. After all summaries are retained in order, one `buildCommitSynthesisModelRequest` completion produces the candidate commit output. No chunk-analysis result is persisted.

`finalizeCommitOutput` owns the single additional final completion allowance. For `/git-staged-msg`, it handles rejection by `parseNativeCommitOutput` for unsafe, empty, oversized, or unparseable content. For both commit entry points, it also consults the advisory `commitPresentationIssue` check for a Conventional Commit summary, a matching long-message subject, and typed body bullets. It does not validate scope policy, subject length, or blank-line style. Presentation feedback uses `COMMIT_PRESENTATION`; the prompt asks for commit messages, not a review or a mechanical relabeling of proposed fixes as completed work. `buildCommitCorrectionModelRequest` receives the original staged context on the direct path. On the chunked path it receives `{ kind: "summaries", context, summaries }`, so final correction reuses the same validated summary array without a second partition or analysis loop. The builder adds the bounded first response and validation code/message as untrusted JSON. A first response above the 32 KiB output cap or containing unsafe control or bidirectional characters is omitted rather than copied into final correction. The corrected response passes through the same parser, with no further call. When the first response was safe, a failed, unsafe, or still-nonconforming presentation rewrite returns that original text with an editing warning instead of failing generation. This optional rewrite failure is consumed before configured provider fallback can run. Cancellation always propagates, even with a safe original. When the first response was invalid, existing correction failure semantics remain unchanged. The 16 MiB ceiling therefore permits at most 35 requests. Initial provider failures, cancellation, Git/context drift, and transaction failures bypass correction. Branch generation remains a single-completion operation with its existing input limit. PR generation uses the bounded analysis and synthesis path described below when its combined context exceeds 1 MiB.

The command API returns `Promise<void>` and has no nested-completion usage return channel. Provider usage remains present on each model response, but Pi's current extension-command API exposes no supported accounting sink for attaching it to the parent session. Do not invent transcript entries or agent turns as an accounting workaround. The user receives a warning before the one correction call so its extra provider work is visible.

Each active native call has one `AbortController`. The completion is raced against its abort signal so session shutdown settles the command even when a provider ignores cancellation. The controller remains active through parsing and artifact transaction completion. A `finally` block aborts and clears ownership. A conflicting generation is refused before context acquisition.

The user receives a provider/privacy notice before context acquisition and a completion notification only after exact artifact verification. Bounded sanitized failures distinguish cancellation from error and never claim a write succeeded. In RPC mode, every command failure is also thrown through Pi's command response; returning normally after an error notification would make WebUI treat the command as successful and misreport an unchanged artifact. Only direct provider/model failures carry the stable fallback-eligibility marker.

## Generation contexts and output contracts

Commit generation binds canonical root, attached branch, HEAD, stable staged fingerprint, and the complete `--cached --binary` diff, with a 16 MiB capture ceiling. The direct threshold remains 1 MiB. Larger commit diffs are partitioned into complete contiguous UTF-8-safe ranges of at most 512 KiB with explicit byte offsets and SHA-256 digests. Summary output is limited to 16 KiB, provider requests carry finite output-token ceilings, and complete ordered coverage is revalidated before synthesis or correction. Branch generation retains its 1 MiB staged-input limit and adds an optional validated pair of generated commit artifacts. PR generation binds current branch, HEAD, resolved base ref/OID, merge base, complete commit list and binary diff, plus an optional safe PR template. `PR_GENERATION_CAPTURE_MAX_BYTES` shares the 16 MiB capture ceiling; `PR_GENERATION_INPUT_MAX_BYTES` remains the 1 MiB direct-request threshold. The template retains its separate 128 KiB bound.

`partitionPrContext` concatenates the complete commit log and diff without adding or dropping bytes. Each analysis request includes `commitsByteLength` to identify their boundary, the bound branch/base identities, and the chunk's contiguous byte range and digest. It reuses the staged-generation UTF-8 partitioning and coverage checks through shared `GenerationChunk` and `GenerationChunkSummary` types. `parseGenerationChunkSummaryOutput` applies the existing 16 KiB safe-text limit with no presentation requirements or retries. Each analysis has a 4,096-token output ceiling. Before each analysis and final synthesis, the handler revalidates the PR snapshot. Final synthesis validates complete ordered summary coverage, sends all summaries plus the unchanged template, and uses the existing PR output parser and transaction. Up to 33 analyses plus one final request are allowed, with one optional verification correction for a maximum of 35 requests. Failed analysis, drift, and cancellation leave previous artifacts untouched.

`prGenerationInstructions` is the canonical native writing policy for direct and synthesized PRs. It asks for short plain paragraphs, no default headings, and relevant template structure without promoting repository text to trusted instructions. Length and layout are advisory. Verification remains explicitly unavailable even when a commit or summary claims tests passed. The final request includes a separate task reminder. This extension does not load the separate `pi-package-prompts-git-pr` template.

After a final `UNSUPPORTED_TEST_CLAIM` rejection, the PR handler revalidates its snapshot and calls `buildPrVerificationCorrectionModelRequest` exactly once. The builder reuses the direct or synthesis request, including the same captured evidence and template. It adds the previous draft as untrusted JSON only up to `PR_CORRECTION_OUTPUT_MAX_BYTES`, 32 KiB; longer drafts are omitted. The correction uses the same model and PR output-token ceiling. Corrected output goes through the same parser and artifact transaction. Other parse failures, chunk failures, cancellation, and drift do not initiate correction. Correction-provider failures use `PR_VERIFICATION_CORRECTION_FAILED`, not the fallback-eligible provider failure code, to prevent a full generation restart.

The test-claim heuristic uses whole-word matching so `branch`, `runtime`, and `bypass` are not execution claims. It removes specific negated outcomes before looking for affirmative ones instead of exempting a whole clause containing `not run`, `none`, or `keine`. Supplied evidence applies to its clause, not an entire line. This is a conservative text heuristic, not a proof of factual accuracy. Regression tests cover benign fragments, negation mixed with affirmative claims, direct/chunked TUI/RPC correction with unchanged evidence, the single-request bound, correction failure, cancellation, and drift without artifact replacement.

The style follows the short prose examples in Pi PRs [#9501](https://github.com/earendil-works/pi/pull/9501) and [#9504](https://github.com/earendil-works/pi/pull/9504), not a claimed universal Pi template. `tests/native-generation.test.mjs` covers capture above the old limit for both diff-heavy and log-heavy histories, UTF-8 boundaries, complete coverage, rejected incomplete or tampered summaries, the 16 MiB ceiling, template preservation, and shared writing instructions. `tests/tui.test.mjs` covers sequential PR generation in TUI/RPC, finite request limits, failure and cancellation, source drift, and preservation of existing drafts.

Model-facing repository data and generated summaries are JSON-serialized inside named untrusted blocks. System instructions define language, commit quality guidance, preferred commit presentation, required branch/PR delimiters, and safety constraints. Repository data and summaries never become trusted instructions or shell text. Chunk summaries remain free-form bounded text. Final direct, synthesis, and correction requests add a task reminder in a separate text block after the untrusted evidence. This repeats the summary/list objective without incorporating repository text into trusted instructions.

The preferred commit presentation is:

```text
<<<SHORT>>>
<subject>
<<<LONG>>>
<the same subject>

- feat: <implemented feature, if any>
- fix: <implemented fix, if any>
- test: <test change, if any>
<<<END>>>
```

When the preferred commit presentation is absent, the first content line becomes the short artifact and the complete trimmed text becomes the long artifact. Branch and PR outputs retain these required shapes:

```text
<<<BRANCH>>>
<type>/<two-to-five-lowercase-kebab-words>
<<<END_BRANCH>>>
```

```text
<<<PR_BODY>>>
<reviewer-focused Markdown>
<<<END_PR_BODY>>>
```

Commit prompts intentionally ask for stricter presentation than commit parsers enforce. Final commit parsers require non-empty bounded safe content, not closed framing or stylistic compliance. Chunk summaries are trimmed and rejected only when empty, unsafe, or oversized; neither delimiters nor layout cause a chunk retry. Branch and PR parsers retain their documented validation contracts.

## Artifact transaction contract

Canonical destinations are:

```text
dev/COMMIT/staged-commit-short.txt
dev/COMMIT/staged-commit-long.txt
dev/COMMIT/staged-branch-name.txt
dev/PR/<encodeURIComponent(current-branch)>.md
```

`index.ts` injects Pi's `withFileMutationQueue` into every write helper. Transactions verify canonical non-symlink parents and regular destinations, prepare private same-directory files with `wx`, preserve same-directory backups, install by rename, verify exact nonempty bytes, and revalidate the bound source state. Commit short/long writes roll back together. If rollback itself fails, recoverable backups are preserved and `ARTIFACT_ROLLBACK_FAILED` is returned.

## WebUI activation contract

The extension exports these canonical values:

```text
status key: git-guided-workflow:webui-start
payload type: firstpick.pi-extension-git-guided-workflow.start
payload version: 1
```

The exact JSON payload is:

```json
{
  "type": "firstpick.pi-extension-git-guided-workflow.start",
  "version": 1,
  "action": "start",
  "requestId": "<UUID-v4>"
}
```

Do not add tab ID, cwd, repository path, Git data, preferences, model data, or a success claim. The WebUI transport envelope owns the originating tab.

RPC activation calls `ctx.ui.setStatus` with the payload and immediately clears it. This is intentionally at-most-once. The browser requires RPC-capable extension provenance for all three native generation commands; a same-named prompt command is not a valid fallback. The browser passes its configured model and reasoning effort in a private command argument. The extension resolves that model and calls its provider independently through `streamSimple`; the parent session profile stays unchanged while WebUI verifies the generation-correlated artifact.

The PR filename contract is encoded as one path segment. WebUI and extension code must both map `feat/native` to `dev/PR/feat%2Fnative.md`; do not independently reintroduce branch path separators.

## Native TUI state and safety

The TUI workflow state is ephemeral and command-owned:

```text
Initialize → Stage → Message → Commit → Push → Finish
```

`src/tui.ts` gives every custom screen the same centered `78%` width, minimum 36-column width, `85%` maximum height, and one-cell margin. Action and confirmation screens use native `SelectList`, setup uses native `SettingsList` with model submenus, generation uses `GenerationOverlay` backed by native `CancellableLoader`, and commit entry uses native `Editor`. Detail previews are line-bounded so actions remain reachable. Escape never selects a mutation.

`GenerationOverlay` retains native spinner animation, cancellation signals, and timer disposal. Its renderer reserves the cancel hint before cropping long notices to the overlay height budget.

`CommitEditorOverlay` renders the native editor at the panel's interior width and uses the same filled frame for editing and resize-required notices. Native editor separators use `borderMuted`; the outer frame uses `borderAccent`. Top and bottom borders appear only when they fit without clipping the native viewport. Tests cover background resets, theme invalidation, cursor markers, document preservation, and narrow/short bounds.

`renderOverlayPanel` wraps action screens, confirmations, commit editing, generation progress, setup settings, and model submenus in a padded `borderAccent` frame with `customMessageBg` fill. Action lists and previews render at the interior width before framing; the existing height budget reserves horizontal border rows when space permits. Rendering tests check complete borders and background coverage for both workflow menus and confirmations. `setupChromeRows` divides the shared overlay row budget by 1.8, rounds down, and keeps at least one row. It reserves two border rows when that reduced budget is at least eight rows; shorter layouts retain the side borders and prioritize controls. Widths below five columns omit the frame and padding. Every output row fills its assigned width, restoring the panel background after native ANSI resets. Setup items require a description in their local TypeScript type. The list reserves space for the longest wrapped description and native search, scroll, spacing, and help rows. Unused content rows are padded to the terminal-derived budget, so selection changes, filtered results, and model submenus cannot shift the footer or resize the popup. Rendering tests cover every description, stable height across navigation and search, blank-row fill, submenu framing, theme invalidation, and narrow/short resize bounds.

Guided TUI generation acquires a `StagedGenerationContext` with `COMMIT_GENERATION_CAPTURE_MAX_BYTES`, matching the 16 MiB native commit cap. The existing direct prompt remains in use up to 1 MiB. Both commit entry points share `completeChunkedCommit` above that threshold, including ordered chunk validation, finite output-token limits, cancellation, and progress notifications. The guided TUI sends the final output through `finalizeCommitOutput` with invalid-output correction disabled, then parses selectable candidates without artifact writes. A safe but off-task or poorly structured response can receive the one optional presentation rewrite. TUI/RPC regressions reproduce a severity-ranked dependency-review finding, verify a corrected summary and typed list, compare retained synthesis/rewrite evidence, and enforce one final request only. Additional cases cover failed rewrites, cancellation without artifact publication, and no configured fallback after an optional rewrite failure.

Git commands are argv arrays, never shell strings. Normal hooks and signing remain enabled. Timeouts wait for the direct child close barrier; unconfirmed termination and ambiguous commit or push outcomes stop without automatic retry. Push uses an explicit immutable object-ID refspec and no force option.

## Source layout

- `index.ts` — four commands, direct completion integration, cancellation, TUI workflow, and WebUI activation
- `src/core.ts` — Git/state/message core
- `src/native-generation.ts` — native generation contexts, parsers, and artifact transactions
- `src/preferences.ts` — extension-owned native settings
- `src/message-files.ts` — artifact preview and one-file message defaults
- `src/repository-setup.ts` — initialization, starters, and publication
- `src/tui.ts` — centered native overlay components
- `tests/core.test.mjs` — temporary-repository Git and commit/push coverage
- `tests/native-generation.test.mjs` — context, parser, drift, path, and rollback coverage
- `tests/tui.test.mjs` — command registration, direct and chunked request orchestration, provider failure, cancellation, drift, correction reuse, RPC behavior, shutdown, TUI transitions, and documentation contract
- `tests/package.test.mjs` — manifest dependency, registration, allowlist, and bundle contract

## Validation

Run:

```bash
npm test
npm run check
/usr/bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck index.ts src/*.ts
npm pack --dry-run --json
```

Inspect the pack JSON and confirm that `src/native-generation.ts` is present while no nested prompt package or prompt directory is included. Tests use temporary repositories and local bare remotes only; they must not call a real provider or network service.

From the repository root, run the owned-file whitespace check without staging files:

```bash
git diff --check -- pi-extension-git-guided-workflow plans/handoffs/guided-git-native-generation-integration.md
```

## Package maintenance

The npm tarball includes the extension entry point, all source modules, user documentation, contributor guide, and license. Tests are intentionally excluded. The manifest registers only `./index.ts` as an extension resource. Keep generation native: do not add a prompt dependency, bundled dependency, `pi.prompts` registration, copied prompt Markdown, or reverse dependency.
