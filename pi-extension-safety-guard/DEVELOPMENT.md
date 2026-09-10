# Development guide: Safety Guard for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Parser and analysis contract

`src/shell-analysis.ts` uses pinned `web-tree-sitter` and the `tree-sitter-bash` WASM grammar. It never executes commands or reconstructs input for execution. Runtime/grammar initialization is lazy and shared; each analysis owns and deletes its parser and syntax tree. Initialization failure is cached until reload. Late initialization after a timeout deletes the newly created parser.

Limits are 65,536 input characters, 32 operations, 4,096 visited analysis nodes, 64 container levels, a 50 ms parse deadline checked through the parser progress callback and after parsing, and a 5-second initialization deadline. These are bounded analysis checks, not an OS CPU/memory sandbox. Inputs with unsupported controls also fall back.

The supported AST admits only program/list/pipeline containers, literal command nodes, comments, and `&&`, `||`, `;`, or `|` separators. Newlines separate commands through the grammar. Literal arguments come from plain words, raw strings, or double-quoted strings without expansions/escapes. Concatenations and other nodes fail closed to whole-command approval. Directory/environment-changing commands, interpreter/execution wrappers, executable paths, and Git global options also force fallback for the entire invocation. No reusable partial analysis is returned.

On supported inputs, command-risk regexes must match at offset zero in the normalized argv text. This avoids treating quoted command text passed to `echo` as an executing command. Each operation retains `inPipeline` metadata. Only non-pipeline `echo`/`printf` output is exempt from SQL checks. Any pipeline operation with a matching SQL risk ignores saved operation grants and makes the prompt whole-command-only. The receiver must be part of the approval identity; a producer-only grant cannot authorize a different downstream client. No new SQL data-flow evaluator or client allowlist is implied.

The pinned grammar can put a conditional list under a pipeline for some mixed chains. Analysis rejects that grouping rather than guessing pipe membership or assigning the pipeline context to a sequential sibling. On fallback, bounded original text is scanned for context and an unverified-execution risk always requires approval. Heredoc bodies remain visible to fallback SQL checks. This is not a semantic proof of arbitrary program behavior.

## Approval identities and persistence

`src/approvals.ts` owns permission identities. Display labels never authorize calls. All keys use normalized cwd. The store remains version `1` and validates each entry's discriminator, tool, fields, known rule IDs, and computed key.

| Discriminator | Identity | Meaning |
| --- | --- | --- |
| Missing or `exact` | `kind:normalized-cwd:value` | Legacy/new exact complete command or protected path |
| `rule` | `rule:` + JSON `["bash", cwd, ruleId]` | Legacy standalone-only `git.switch.create.v1` |
| `operation` | `operation:` + JSON `["bash", cwd, argv]` | New literal argument-list permission, reusable only in supported analyses |
| `operation-rule` | `operation-rule:` + JSON `["bash", cwd, ruleId]` | New constrained operation-type permission |

The new catalog IDs are `git.switch.create.operation.v1`, `git.switch.existing.operation.v1`, and `git.branch.delete-merged.operation.v1`. They validate argument count, case-sensitive flags, and simple branch tokens. Expanding an existing catalog rule requires a new ID. The old standalone recognizer is unchanged and is checked only against the whole original input. It must never authorize an operation inside a chain.

Session and permanent stores use the same identities. Reusable grants are explicit choices, not implicit conversions of exact approvals. Malformed entries, unknown IDs, mismatched keys, and legacy label-key patches are ignored. Older versions cannot match the new prefixes as exact commands. Older strict readers may drop unknown entries when rewriting the store; document this operational limitation rather than promising lossless downgrade.

All permanent grants from one decision are deduplicated and committed in one read-modify-write operation through a mode-0600 temporary file and rename. Temporary files are cleaned on failure. A failed save blocks the invocation. Cross-process last-writer races remain an existing limitation; this does not implement cross-process locking. Notifications are best-effort after commit and show scope/labels, not complete command contents.

`createSafetyGuardExtension` accepts internal `allowStorePath` and `analyzeShellFn` options for isolated tests and failure injection. Tests must never use the user's permission/configuration files.

## Bash decision and prompt flow

1. Check cancellation and existing exact whole-command permissions, then the legacy standalone grant without broadening it.
2. Analyze the complete command. Unsupported input requires whole-command approval, even without a known regex hit.
3. For supported syntax, inspect every operation and determine its risks and any applicable exact-operation or operation-type grant. Repeated occurrences remain separate in the display.
4. If all matching enabled risks are covered and syntax is supported, proceed. Otherwise collect all pending risk labels and build one prompt with `src/bash-prompt.ts`.
5. Offer Block/once, complete-command session/permanent, and, only for supported analysis, exact-operation session/permanent. Offer operation-type session/permanent only when every pending operation has an eligible catalog type.
6. If optional auto-review is enabled and the entire bash input fits its 4,096-character bound, request one verdict for the complete invocation with all pending risk labels. Model decisions never persist permissions. Failure falls back to the single prompt.
7. Reject unknown/unoffered choices, cancellation, and UI errors. After an explicit remembered approval, commit all pending entries at the chosen scope/lifetime. Never execute selected fragments.

Prompt scope/lifetime choices apply only to operations marked NEEDS APPROVAL. Existing grants retain their lifetimes. This replaces the earlier per-risk dialogs and shortest-scope reduction. A rejected invocation still saves no new grants.

Prompts cap the authorization display at 12,000 characters. If the full scope does not fit, only Block/once remains available and truncation is explicit. JSON-escaped input and escaped control characters in risk excerpts prevent raw terminal controls from being rendered. Existing configurable context lines still apply to risk excerpts.

## Auto-review protocol

The request contains rule/category/risk metadata, cwd, and bounded command/path input, not conversation history, file contents, tool results, or credentials. Bash combines pending risk labels and categories and uses the highest matching risk level. Oversized bash input skips model review instead of approving from incomplete text.

Calls use the configured authenticated model without tools, retries, or cache retention. Bounds remain a 20-second timeout and a 256-token output budget. Accept exactly one JSON object containing only `verdict` (`allow` or `block`) and a one-line reason of at most 512 characters. Authentication failure, timeout, malformed output, and invalid responses fall back to confirmation.

## Verification

- `tests/shell-analysis.test.mjs`: real grammar, literal quoting/comments, supported chains, unsupported constructs, bounds, catalog flags, and identity separation.
- `tests/approvals.test.mjs`: retained legacy recognizer and namespace regressions.
- `tests/approval-runtime.test.mjs`: real handlers with temporary stores and mocked UI/model decisions, including the scope/lifetime matrix, one-prompt batching, legacy compatibility, fallback behavior, cancellation, persistence failure, and protected paths.
- Existing runtime/config/excerpt/model tests retain coverage of setup, context limits, and review indicators.

No test command strings are executed. From this package directory, use a Node version supported by the pinned Pi SDK. The clean-install setup was verified with Node 22.23.2:

```bash
npm install --include=dev --ignore-scripts
npm test
npm pack --dry-run --json
```

Pi AI, coding-agent, and TUI are shared runtime peers, with version-pinned development dependencies for the test baseline. A package-local install provisions them from npm; neither a global Pi installation, root-repository dependency, nor a junction is needed. Do not use `--legacy-peer-deps` or omit development dependencies for this test setup. The root repository is not an npm workspace, so its lockfile does not govern this package's standalone dependency installation.

The test command preloads `tests/register-typescript.mjs`. This test-only loader uses Node's TypeScript stripping API to load `.ts` files, including the published pi-utils dependency inside node_modules, without changing package resolution. It is excluded from the published payload. Native grammar bindings are not used; tests load the shipped WASM grammar, so lifecycle scripts can remain disabled. Node may print an experimental-API warning for type stripping. Tests use real installed dependencies, not parser or SDK stubs.
