# Technical reference: Small Model Reliability for Pi

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Commands

Use `/reliability on [goal]` to arm the extension or create a task, `/reliability off` to disable it for this session, and `/reliability reset` to forget only the active pointer. Reset does not remove task artifacts. Inspect state with `/reliability status`, `scratchpad`, `verify`, `suggest`, `evidence [status|list|show <E-id>]`, and `tasks [--all]`. Resume or archive a saved task with `/reliability resume <task_id>` or `/reliability archive <task_id>`.

Choose a lane with `/reliability lane retrieval|agentic|coding|structured-output|general`. Inspect a gate with `/reliability gate [retrieval|agentic|coding|structured-output|final]`; resolve a displayed escalation or human-review item with `/reliability gate resolve <QGE-id> approve|reject` or `/reliability gate review <OV-id> approve|reject`. Activate a declarative output contract with `/reliability output-contract <path>` or inspect existing contracts with `/reliability output-contract [status]`.

Use `/reliability checkpoint [status|list|show <CP-id>|recover <CP-id>|retry|auto-on|auto-off]`. A checkpoint is an immutable validated handoff. This host has no supported curator transport that resets or compresses the active chat, so production behavior is checkpoint-only. `/reliability --mode plan-on [goal]`, `plan-off`, and `plan-status` control retained-session plan mode. `/reliability profile strict|balanced|relaxed`, `mode adaptive|lite|supervised`, and `context full|compact|delta` tune this session.

Use `/reliability scope [status|clear|approve <SC-id>|reject <SC-id>]` and `/reliability approval [status|approve <A-id>|reject <A-id>]` to inspect or decide pending scope/effect requests. Scope expansion and one exact effect require native confirmation. RPC clients that support Pi's confirmation dialogs can approve these actions. Clients without a confirmation-capable UI leave them pending.

Use `/reliability map <criterion_id> <operation> [exact command]` to associate an observed operation with a criterion, and `/reliability attest <criterion_id> <user-observed evidence>` for a real native-confirmed user observation. A mapping is evidence coverage only. It is not permission to run a command. Every `bash` or `powershell` action still needs a current native-confirmed scope and a single-use native approval for that exact normalized effect. The `pre-approved` scope label does not provide blanket shell permission. Scope checks are Pi-tool controls, not an operating-system sandbox: approving a command does not restrict the filesystem or network access of the code it runs.

`/reliability focus off|retrieval|agentic|coding|structured-output|general` only narrows active reliability-owned tools; it never restores tools another owner or the user disabled. `/reliability advisor` reports automatic-advisor eligibility and recent audit records; it does not call a model itself.

`/reliability orchestrate [--run]` is a dry run unless `orchestrationMode` is `separate-model`, exact models are configured for the requested roles, and native confirmation succeeds. It uses direct Pi data-only completions with no subprocesses, tools, extensions, or child continuations. The roles' output is advisory and non-authoritative.

`/reliability eval [--suite retrieval|agentic|coding|all] [--model provider/model] [--run] [--write]` defaults to offline fixtures. A live run requires an exact allowlisted configured model, a currently available native adapter, and native confirmation of the sanitized case packet. Expected answers and independent oracles stay local; cancellation or timeout ignores late output.

## Input confirmation and retained-session plans

`/reliability on <goal>` explicitly starts a new task. With `/reliability on` alone, an ordinary prompt does not start an authoritative task until you use `/reliability input confirm`. The native dialog displays the proposed task or correction (up to 8,192 UTF-8 bytes). Confirmation creates a new current instruction, not proof that an earlier raw, transformed, templated, steering, or follow-up message was delivered. Canceling or lacking a confirmation-capable UI leaves the pause intact. After reload or loss of live text, use `/reliability input confirm <exact task or correction text>`. Historical guessed input cannot be upgraded; start a new explicit task instead.

While input is uncertain, consequential tools, completion, automatic advice, and automatic plan advancement are paused. A rejected or handled prompt can conservatively leave a pause. Internal reliability continuations add no user authority. Session replacement does not transfer a task's authority; resuming a task in another session does not make old approvals current.

Plan mode keeps all phases in the same Pi session: exploration, planning, implementation, summary, verification, and final report. It no longer promises fresh-session isolation. Ask Pi to inspect its named handoffs with `reliability_status` and update them with `reliability_record_progress`. The supported Markdown slots are exploration, plan, summary, verification, final report, and at most 12 numbered failures. Each artifact is limited to 32,768 UTF-8 bytes and edits require a current version check. Writes are limited to the active phase. These controls do not grant generic access to `.pi/tasks/`, and Markdown status markers cannot attest tests, approve scope, or complete work. Checkpoint/input pauses and applicable scope budgets also apply to artifact access.

## Checkpoint recovery

`/reliability checkpoint recover <CP-id>` requests a native-confirmed check, not a force-unfreeze. Only the same live process can recover a durability failure before any provider reset or restore dispatch. Current task, session, branch, workspace, artifacts, and settled tools must still match, and the repaired transition must be saved and reopened successfully. Recovery retains context, epoch, approvals, and consumed budgets; it does not revive expired approvals.

Reloaded, crashed, interrupted, reset-attempted, failed-restore, or otherwise provider-uncertain attempts remain blocked. Generic `resume`, `reset`, task replacement, `retry`, and toggling automatic checkpoints cannot clear an active recovery freeze. Preserve the task and native session records; this release has no supported recovery for unknown provider state.

## Configuration

Save optional settings in trusted `.pi/reliability.json`. Invalid policy enums fall back conservatively with a visible warning. Numeric inputs are clamped to the documented range; unknown or malformed nested values use their defaults. The balanced profile is the default unless a command changes the in-session profile.

### Top-level settings

| Key | Default in the balanced profile | Allowed values or limits |
| --- | --- | --- |
| `enabled` | `false` | Boolean session-start preference. |
| `profile` | `balanced` | `strict`, `balanced`, or `relaxed`. |
| `requirePlan`, `requireVerification` | `true`, `true` | Legacy guidance settings. Relaxed defaults both to `false`; they do not bypass the shared completion-evidence authority. |
| `maxRepeatedAction` | `3` | Integer 2–10; strict 2, relaxed 5. |
| `maxRecoveryAttempts`, `maxRecoveryActions`, `maxRecoveryElapsedMs` | `2`, `6`, `600000` | Integers 1–5, 2–20, and 1,000–3,600,000 ms; relaxed defaults are 3, 8, and 900,000 ms. |
| `scratchpadEnabled`, `progressWidget` | `true`, `true` | Booleans. |
| `contextBudgetChars` | `6000` | Integer 1,800–20,000. This bounds only the extension header. |
| `contextMode` | `compact` | `full`, `compact`, or `delta`; profile defaults are full, compact, and delta. |
| `supervisionMode` | `adaptive` | `adaptive`, `lite`, or `supervised`; strict uses supervised, balanced uses adaptive, and relaxed uses lite. |
| `storeRawToolLogs`, `rawLogMaxChars` | `false`, `50000` | Boolean and integer 1,000–500,000. Raw logs remain local and should be treated as sensitive. |

### Retrieval, scope, and output settings

| Object and keys | Defaults | Limits |
| --- | --- | --- |
| `retrieval.maxSources`, `.maxPassages`, `.maxPassageChars`, `.maxClaims` | 12, 24, 2,000, 30 | Integers 1–12, 1–24, 1–2,000, and 1–30. |
| `retrieval.requireMaterialClaimCitations`, `.requireConflictDisposition` | `true`, `true` | Booleans; values other than `false` require the check. |
| `scope.maxToolCalls`, `.maxErrors`, `.maxIterations`, `.approvalTtlMs` | 48, 3, 24, 300,000 | Integers 1–500, 1–100, 1–500, and 1,000–3,600,000 ms. |
| `scope.phaseToolFocus` | `false` | Boolean; only narrows reliability-owned tools. |
| `structuredOutput.maxCandidateChars`, `.maxSchemaChars`, `.maxCandidatesPerTask` | 50,000, 32,000, 3 | Integers 1,000–50,000, 1,000–32,000, and 1–3. |

### Checkpoint, evaluation, and advisor settings

| Object and keys | Defaults | Limits or meaning |
| --- | --- | --- |
| `contextReset.mode`, `.phaseBoundaries` | `automatic`, `true` | Mode is `automatic` or `off`; boolean phase boundaries. |
| `contextReset.eligibleTransientTokens`, `.contextUsageRatio`, `.hardContextUsageRatio`, `.cooldownTurns` | 12,000, 0.35, 0.70, 4 | Integers 1,000–200,000 and 0–100; ratios 0.05–0.95 and 0.10–0.99. |
| `contextReset.maxAutomaticResetsPerPhase`, `.maxCheckpointChars`, `.maxContinuationSeedChars`, `.adapterTimeoutMs` | 1, 24,000, 16,000, 5,000 | Integers 1–5, 4,000–100,000, 2,000–100,000, and 100–60,000 ms. |
| `contextReset.unsupportedTransport`, `.expireUnusedApprovals` | `checkpoint-only`, `true` | `checkpoint-only` or `retain-context`; boolean. Neither enables a context reset without a verified host transport. |
| `evaluation.liveModels`, `.timeoutMs`, `.maxCases` | `[]`, 120,000, 50 | Up to 12 exact `provider/model` IDs; 1,000–600,000 ms; 1–50 cases. Listing a model never authorizes a call. |
| `advisor.automatic`, `.exactModel`, `.dataScope` | `false`, unset, unset | Automatic calls require `true`, one exact configured model, and `diagnostic-summary`. |
| `advisor.maxCalls`, `.maxRuntimeMs`, `.maxOutputChars`, `.maxTotalTokens`, `.maxTotalCostUsd` | 0, 30,000, 8,000, 0, 0 | 0–10, 100–600,000 ms, 256–100,000 chars, 0–100,000 tokens, and 0–10,000 USD. Automatic calls additionally require positive call/token/cost budgets. |

Transient pressure is a bounded estimate of host-observed built-in tool-result text, using UTF-8 bytes divided by four and capped at 1,000,000 estimated tokens. It is not total context usage or final provider-token accounting. Observations can be lost on reload and rebuilt from later context/results. Checkpoints wait for settled tool batches and valid outgoing work; cooldown and per-phase limits still apply. Hard pressure pauses built-in `grep`, `find`, and `ls` exploration; `read` remains available for recovery inspection under its ordinary scope rules.

### Orchestration and model profiles

`orchestrationMode` defaults to `prompt`; its only other value is `separate-model`. `orchestrationModels` accepts exact model IDs for `supervisor`, `worker`, and `verifier`. `orchestrationTools` defaults to `read`, `grep`, `find`, and `ls` (one to 20 names), but direct data-only roles do not receive those tools.

The resource defaults are `orchestrationMaxOutputChars: 50000`, `orchestrationTimeoutMs: 30000`, `orchestrationMaxStdoutChars: 100000`, `orchestrationMaxStderrChars: 40000`, `orchestrationMaxLineChars: 16000`, `orchestrationMaxTotalOutputChars: 100000`, `orchestrationMaxTotalTokens: 16384`, and `orchestrationMaxTotalCostUsd: 10`. Their ranges are respectively 256–100,000 chars, 100–600,000 ms, 1,024–1,000,000 chars, 1,024–1,000,000 chars, 256–100,000 chars, 1,024–1,000,000 chars, 1–1,000,000 tokens, and 0–10,000 USD.

`modelProfiles` accepts at most 12 distinct exact model IDs with optional `evidence_provenance`, `context_budget_chars`, `max_tool_calls`, and `max_recovery_attempts`. Profiles only narrow the current profile defaults: 1,800 through the current header budget, 1 through the current tool-call budget, and 1 through the current recovery-attempt budget. User configuration cannot mark a profile held-out validated.

For example, the following permits at most one automatic diagnostic advisory call after a qualifying current failure, conflict, or exhausted repair episode. It does not authorize manual orchestration or live evaluation.

```json
{
  "advisor": {
    "automatic": true,
    "exactModel": "provider/model-id",
    "dataScope": "diagnostic-summary",
    "maxCalls": 1,
    "maxRuntimeMs": 30000,
    "maxOutputChars": 4000,
    "maxTotalTokens": 8000,
    "maxTotalCostUsd": 0.05
  }
}
```

Automatic advice requires that exact model to be authenticated in Pi, a safe pre-dispatch token/cost admission, and a current attributable failure, evidence conflict, or exhausted repair episode. It is a bounded data-only diagnostic request and remains non-authoritative.

## Resource filtering

Use `pi config` to select installed resources. To load only the advisory skills, merge this entry into your existing Pi `packages` settings rather than replacing other packages:

```json
{
  "source": "npm:@firstpick/pi-extension-small-modal-reliability",
  "extensions": []
}
```

For the extension without bundled skills, omit `extensions` and set `"skills": []`. Removing or filtering the package does not remove `.pi/tasks` artifacts. Do not downgrade v2 task files in place; keep their original backups and start a new task if an older package cannot read them.

## Storage, recovery, compatibility, and limits

Task state, evidence, checkpoints, scratchpads, plan artifacts, and optional redacted logs live beneath `.pi/tasks/`; evaluation reports live under `.pi/reliability-evaluations/`. New task storage creates `.pi/tasks/.gitignore` without changing repository ignore policy. Existing user-owned task ignores are not rewritten. Symlinked artifact ancestors are rejected. Unconfirmed observations persist hashes/unknown markers, not pending raw text, in reliability records; Pi may retain its own user-message history. Confirmed instructions remain task content. Redaction recognizes selected patterns only and is best effort, never a secret-free guarantee.

Use `/reliability tasks --all` to find saved and archived task IDs, then `/reliability resume <task_id>` to make one active. A well-formed legacy version-1 task is migrated to version 2 when it is loaded and, on the first save, retains the original bytes in `state.v1.backup.json`; prior completion remains unproven until current evidence is recorded. Malformed, unsupported, or identity-mismatched state is recovery-required: the extension blocks mutation and completion, identifies the saved state path, and requires recovery from a saved backup rather than treating the task as missing. `/reliability reset`, `off`, and `archive` do not delete the underlying task record.

Validation used Node.js 22.23.2, Pi 0.85.1, and Linux. Pi 0.85.1 requires Node.js 22.19.0 or newer. Other Pi versions, operating systems, provider adapters, and third-party tools have no compatibility guarantee. Unrecognized third-party tool calls are blocked at execution preflight, not merely excluded from completion evidence. Built-in file/shell tools and this package's own controls have adapters; generic web, wiki, and delegation tools do not yet have verified interoperability. You can load the six skills without the extension when advisory guidance is sufficient, but that mode provides no runtime enforcement.

Recursive `grep`/`find` searches are conservatively refused when their root contains forbidden descendants or protected reliability files. A caller-provided glob is not a security exclusion. Use narrower allowed directories or direct file reads.

Installed dependency verification supports direct regular packages under the current workspace's `node_modules` and supported npm JSON manifests/locks. Hoisted installations outside that workspace are not certified. Decoy manifests, linked/symlinked packages, virtual stores, unsupported layouts, and unverifiable selected passages remain unknown; do not move or copy manifests to manufacture evidence. Purely local changes need no invented dependency record.

Coding completion requires current host-observed mapped validation for the declared coding checks. A manual-only coding review cannot replace executable validation; unsupported validation operations remain unknown. Other human-review criteria still use native attestations.

`contextBudgetChars` bounds only this extension's injected header. Pi does not expose final provider-prompt or tool-schema accounting, so host overhead cannot be reserved. Checkpoints preserve validated task context but cannot reset or compact the active conversation on this host. Completion remains unknown unless current receipt-bound evidence or a native user attestation satisfies every required criterion.
