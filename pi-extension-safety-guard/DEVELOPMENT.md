# Development guide: Safety Guard for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Published behavior baseline

The npm `@firstpick/pi-extension-safety-guard@0.2.8` tarball was inspected before restoring pattern-driven checks. Its integrity was `sha512-wncm2izx/2k5SPhvHsPMwiGKQhu36X9sPYpVB0+o/cXaees0Bf5UW+yFE6bYBUwEwTsgXoGjoQZSXgtg7DqvAA==`. The published handler scans shell risk patterns outside heredoc bodies and SQL patterns across the whole command, returning immediately when no pattern matches. It has no parser-based approval gate.

The rollback retains verified improvements: compound-command batching, scoped approvals for supported operations, quoted-literal risk matching, exact source highlights, and the compact native selection UI. Pattern checks, not parser success, determine whether a prompt or model review is needed. An isolated handler comparison allowed all 11 saved blocker entries as stored and blocked seven representative risk cases in both published 0.2.8 and the revised code. No command strings were executed.

## Parser and analysis contract

`src/shell-analysis.ts` uses pinned `web-tree-sitter` and the `tree-sitter-bash` WASM grammar. It never executes commands or reconstructs input for execution. Runtime/grammar initialization is lazy and shared; each analysis owns and deletes its parser and syntax tree. Initialization failure is cached until reload. Late initialization after a timeout deletes the newly created parser.

Limits are 65,536 input characters, 32 operations, 4,096 visited analysis nodes, 64 container levels, a 50 ms parse deadline checked through the parser progress callback and after parsing, and a 5-second initialization deadline. These are bounded analysis checks, not an OS CPU/memory sandbox. Inputs with unsupported controls also fall back.

Rejected AST constructs retain a specific reason and a display-only `trigger` source range. Heredoc ranges cover the opener and delimiter, not the embedded program. Missing syntax uses a zero-width location. Initialization failures, unexpected parser exceptions, and limits without a location remain distinct and never fabricate a trigger. Error text from dependencies is not exposed. The analyzer still stops at the first rejected construct and returns no partial operations or reusable permissions. These syntax diagnostics are not approval triggers; only actual risk-pattern matches are shown as triggers.

The supported AST admits only program/list/pipeline containers, literal command nodes, comments, and `&&`, `||`, `;`, or `|` separators. Newlines separate commands through the grammar. Literal arguments come from plain words, raw strings, or double-quoted strings without expansions/escapes. Concatenations and other unsupported nodes disable reusable operation analysis. Directory/environment-changing commands, interpreter/execution wrappers, executable paths, and Git global options also force pattern-checking fallback for the entire invocation. No reusable partial analysis is returned; none of these conditions alone requires approval.

On supported inputs, command-risk regexes must match at offset zero in the normalized argv text. This avoids treating quoted command text passed to `echo` as an executing command. Each operation retains `inPipeline` metadata. Only non-pipeline `echo`/`printf` output is exempt from SQL checks. Any pipeline operation with a matching SQL risk ignores saved operation grants and makes the prompt whole-command-only. The receiver must be part of the approval identity; a producer-only grant cannot authorize a different downstream client. No new SQL data-flow evaluator or client allowlist is implied.

The pinned grammar can put a conditional list under a pipeline for some mixed chains. Analysis rejects that grouping rather than guessing pipe membership or assigning the pipeline context to a sequential sibling. On fallback, the complete input is scanned for known patterns, without the parser's input-size cutoff. Shell checks use `maskHeredocBodies`, which replaces heredoc bodies and terminators with same-length whitespace while retaining line breaks and source offsets. SQL checks still see the complete original text. A fallback with no matching enabled risk returns without prompting or model review. Matched fallback risks require whole-command approval and cannot reuse operation grants. This is not a semantic proof of arbitrary program behavior.

## Approval identities and persistence

`src/approvals.ts` owns operation identities. `src/approval-store.ts` owns shared entry validation, exact identities, physical stores, migration, and trust receipts. Display labels never authorize calls. Local keys use normalized cwd; global exact-operation keys intentionally omit it. The store remains version `1` and validates each entry's discriminator, tool, fields, known rule IDs, and computed key.

| Discriminator | Identity | Meaning |
| --- | --- | --- |
| Missing or `exact` | `kind:normalized-cwd:value` | Legacy/new exact complete command or protected path |
| `rule` | `rule:` + JSON `["bash", cwd, ruleId]` | Legacy standalone-only `git.switch.create.v1` |
| `operation` | `operation:` + JSON `["bash", cwd, argv]` | New literal argument-list permission, reusable only in supported analyses |
| `operation-global` | `operation-global:` + JSON `["bash", argv]` | Permanent exact argument-list permission across working directories, still requiring supported analysis |
| `operation-rule` | `operation-rule:` + JSON `["bash", cwd, ruleId]` | New constrained operation-type permission |

The new catalog IDs are `git.switch.create.operation.v1`, `git.switch.existing.operation.v1`, and `git.branch.delete-merged.operation.v1`. They validate argument count, case-sensitive flags, and simple branch tokens. Expanding an existing catalog rule requires a new ID. The old standalone recognizer is unchanged and is checked only against the whole original input. It must never authorize an operation inside a chain.

Global records require `kind: "bash"`, `cwd: ""`, a nonempty string argv array, no rule ID, and the exact `globalOperationAllowKey` result. The empty cwd is a validated marker only for the new discriminator, never a wildcard for existing identities. The UI offers this scope only with permanent lifetime. Matching checks the new global key alongside the local operation key only after successful analysis and outside SQL pipelines. Stored values/labels remain display metadata, not approval identities.

Local session and permanent stores use the same identities. Reusable grants are explicit choices, not implicit conversions of exact approvals. Malformed entries, unknown IDs, mismatched keys, and legacy label-key patches are ignored. Older versions cannot match the new prefixes as exact commands. Older strict readers may drop unknown entries when rewriting the store; document this operational limitation rather than promising lossless downgrade.

`ApprovalPersistence` routes EVERYWHERE records to the global file under `getAgentDir()` and cwd records to the exact cwd's `CONFIG_DIR_NAME/safety-guard-allow.json`. It does not inherit ancestor stores. New writes validate every record and reject mixed/mismatched scope. Reads and writes enforce an 8 MiB state-file bound; malformed JSON errors never echo raw stored contents.

Local trust uses a separate user-owned `${globalFile}.receipts.json` envelope: `{ version: 1, files: { [absoluteLocalFile]: sha256OfExactFileBytes } }`. The local file must match its receipt, and its entries must be non-global records for the current cwd. Missing, tampered, cloned, wrong-cwd, and global-in-local data cannot authorize calls. Project `.pi`, approval, and ignore symlinks are rejected. The local ignore rule is appended rather than replacing existing content. The threat boundary is project-controlled files alone, not hostile code already running as the user with access to the global receipts.

Permanent mutations use an exclusive `${globalFile}.lock` created with `wx`, plus mode-0600 temporary files, fsync, and rename. Lock contention fails with a retry/inspection message; stale locks are not automatically deleted. Local receipt failure restores the previous local bytes when the file still contains this transaction's output. A failed save blocks the invocation. Files changed externally can fail verification; no automatic approval is inferred. Notifications remain best-effort after commit and show scope/labels rather than full command contents.

Lazy migration is performed under the same lock. It preserves a unique private `${globalFile}.legacy-<uuid>.bak`, merges current-cwd legacy grants with verified local records, saves the local file and receipt, verifies that local file, and only then removes migrated global records. Other cwd records and global grants remain. A conflict or write failure retains trusted legacy records and reports incomplete migration. Backups are never automatically read as grants.

`allow-clear-permanent` clears current-cwd local state and global EVERYWHERE/current-cwd legacy records only. Unverified local files are left untouched and their receipt is removed; other cwd stores/receipts remain intact. Failed clear operations report errors.

`src/session-approvals.ts` stores native `safety-guard-session-approvals` custom snapshots containing `{ version: 1, sessionId, entries }`. `pi.appendEntry` owns persistence; these entries are excluded from model context. Restore uses all session entries and only the current session UUID, so clears survive branch navigation and forks cannot reuse copied grants. An empty snapshot revokes session grants. Runtime reload/new/resume lifecycle and session-ID changes restore the correct map. Persistence exceptions append a compensating prior snapshot where possible because the native manager can update memory before its disk write fails. In-memory sessions have no cross-process persistence.

Approvals are reloaded for guarded calls and status/list actions. A session or cwd change while a confirmation is open blocks the pending decision. Direct `write`/`edit` to the canonical approval, receipt, and backup filenames is treated as protected-path access.

`createSafetyGuardExtension` accepts internal `allowStorePath` and `analyzeShellFn` options for isolated tests and failure injection. Tests must never use the user's permission/configuration files.

## Bash decision and prompt flow

1. Refresh session and current/global permanent approvals, performing any safe current-cwd migration. Check cancellation and existing exact whole-command permissions, then the legacy standalone grant without broadening it.
2. Attempt bounded operation analysis. If it is unsupported or fails, use the published shell/SQL pattern-checking fallback; do not invent an unverified-execution risk.
3. For supported syntax, inspect every operation and determine its risks and any applicable exact-operation or operation-type grant. Repeated occurrences remain separate in the display.
4. If there are no uncovered matching enabled risks, proceed regardless of parser status. Otherwise collect actual matched risk labels and build one prompt with `src/bash-prompt.ts`.
5. Offer Block/once and, only for complete supported analysis, exact-operation session/permanent plus global exact-operation permanent. Offer operation-type session/permanent only when every pending operation has an eligible catalog type. Whole-command remembered choices are no longer generated; fallback and incomplete previews offer only Block/once.
6. If optional auto-review is enabled and the entire bash input fits its 4,096-character bound, request one verdict for the complete invocation with all pending risk labels. Model decisions never persist permissions. Failure falls back to the single prompt.
7. Reject unknown/unoffered choices, cancellation, and UI errors. After an explicit remembered approval, commit all pending entries at the chosen scope/lifetime. Never execute selected fragments.

`BashChoice` represents whole-command scope only for the no-lifetime Allow once decision. New remembered bash grants are operation-based. Removed whole-command option strings are rejected as unoffered choices; existing exact identities remain valid for legacy grants and protected file tools.

Prompt scope/lifetime choices apply only to operations marked NEEDS APPROVAL. Existing grants retain their lifetimes. This replaces the earlier per-risk dialogs and shortest-scope reduction. A rejected invocation still saves no new grants.

`src/trigger.ts` maps normalized risk matches through each operation's original `argumentRanges`, retaining quotes around fully matched arguments. Fallback matches use `patternMatchRange` against the original or same-length masked input, so they point to the actual risk text rather than the unsupported shell syntax. It renders bounded, control-escaped excerpts with source line/column positions and `>>> ... <<<` markers. Highlighting uses the computed span, not a search for marker-like text in untrusted input. Truncated snippets and missing locations are explicit. These ranges are display metadata only and never participate in permission identity or execution.

`src/bash-prompt.ts` places the Trigger section before the complete command, then builds shared sections and a plain-text message without ANSI escapes. The terminal formatter adds theme-based headings and risk states without changing that content. Empty context sections and duplicate single-command text are omitted. Scope guidance is separate from the detail body: `bashSelectionHint` describes the highlighted choice, while `bashSelectionSummary` supplies compact guidance for the available RPC choices. Both share the same scope descriptions. `GLOBAL_OPERATION_WARNING` is the canonical global-scope warning. TUI selection help shows it in warning color; RPC summaries include it separately from cwd-only guidance. Global records display `EVERYWHERE` in notifications/listing, and the existing permanent-clear operation revokes them.

`src/bash-dialog.ts` renders terminal prompts through `ctx.ui.custom` and Pi's native `SelectList`, with Block selected first. Text wraps at a maximum of 100 columns. The detail viewport uses the available terminal height, with selection-page keybindings for scrolling and a full selected-label fallback when the native list truncates it. The selected-choice hint stays below the list, outside the scrolling details; its wrapped height is reserved when sizing the viewport. Rendering rebuilds themed text on each frame. The abort listener is removed on completion, disposal, or failure. Other UI modes retain `ctx.ui.select` with plain text, unchanged choice identities, and the same abort signal. The handler still rejects unoffered choices and blocks on UI errors.

Prompts cap the authorization display at 12,000 characters. If the full scope does not fit, only Block/once remains available and truncation is explicit. JSON-escaped input and escaped control characters in risk excerpts prevent raw terminal controls from being rendered. Existing configurable context lines still apply to risk excerpts.

## Auto-review protocol

The request contains rule/category/risk metadata, cwd, and bounded command/path input, not conversation history, file contents, tool results, or credentials. Bash combines pending risk labels and categories and uses the highest matching risk level. Oversized bash input skips model review instead of approving from incomplete text.

Calls use the configured authenticated model without tools, retries, or cache retention. Bounds remain a 20-second timeout and a 256-token output budget. Accept exactly one JSON object containing only `verdict` (`allow` or `block`) and a one-line reason of at most 512 characters. Authentication failure, timeout, malformed output, and invalid responses fall back to confirmation.

## Verification

- `tests/shell-analysis.test.mjs`: real grammar, literal quoting/comments, supported chains, unsupported constructs, bounds, catalog flags, and identity separation.
- `tests/approvals.test.mjs`: retained legacy recognizer, local/global namespace separation, and exact argv boundaries.
- `tests/approval-store.test.mjs`: physical destinations, private modes, native Git ignore verification, trust receipts, tampering/clones, scope filtering, migration backups and retry, partial-write rollback, busy locks, symlinks, clear isolation, and malformed state.
- `tests/session-approvals.test.mjs`: real Pi SessionManager persistence/reopening, reload, durable clear, tree navigation, fork/new-session isolation, failure compensation, invalid records, and in-memory sessions.
- `tests/approval-runtime.test.mjs`: real handlers with temporary stores and mocked UI/model decisions, including routine diagnostics with working/broken parsing, all command-risk categories, source offsets after masked heredocs, risk detection beyond parser limits, the scope/lifetime matrix, one-prompt batching, legacy compatibility, cancellation, persistence failure, and protected paths.
- `tests/bash-dialog.test.mjs`: compact fallback text, semantic highlighting, exact option ordering, global warning visibility before confirmation, TUI/RPC scope guidance, unavailable/truncated global choices, native list selection, narrow-width wrapping, detail scrolling, cancellation, and abort.
- Global runtime cases cover cross-cwd reload, exact-argument restrictions, pending-only grants, fallback/SQL/file-tool isolation, malformed persisted records, privacy-safe listing, revocation, model-review bypass, cancellation, and persistence failure.
- `tests/trigger.test.mjs`: screenshot heredoc regression, specific syntax reasons and source spans, quoted risk mapping, Unicode offsets, control escaping, bounded snippets, missing syntax, and cached parser-load failure without a fabricated snippet.
- Existing runtime/config/excerpt/model tests retain coverage of setup, context limits, and review indicators.

No guarded command vectors are executed. The ignore test runs only Git initialization and `check-ignore` inside a temporary fixture; it skips when Git is unavailable. From this package directory, use a Node version supported by the pinned Pi SDK. The clean-install setup was verified with Node 22.23.2:

```bash
npm install --include=dev --ignore-scripts
npm test
npm pack --dry-run --json
```

Pi AI, coding-agent, and TUI are shared runtime peers, with version-pinned development dependencies for the test baseline. A package-local install provisions them from npm; neither a global Pi installation, root-repository dependency, nor a junction is needed. Do not use `--legacy-peer-deps` or omit development dependencies for this test setup. The root repository is not an npm workspace, so its lockfile does not govern this package's standalone dependency installation.

The test command preloads `tests/register-typescript.mjs`. This test-only loader uses Node's TypeScript stripping API to load `.ts` files, including the published pi-utils dependency inside node_modules, without changing package resolution. It is excluded from the published payload. Native grammar bindings are not used; tests load the shipped WASM grammar, so lifecycle scripts can remain disabled. Node may print an experimental-API warning for type stripping. Tests use real installed dependencies, not parser or SDK stubs.
