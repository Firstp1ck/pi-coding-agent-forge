# Cache-aware context pruning and validated phase continuation

- **Status:** Proposed; implementation pending
- **Classification:** Complex
- **Feature slug:** `cache-aware-agent-context-pruning`
- **Target package:** `pi-extension-context-curator/` *(new)*
- **Integration owner:** Primary Pi session
- **Last updated:** 2026-09-13

This companion remains unimplemented. Its trigger and integration contract now include automatic validated phase checkpoints from the [small-model reliability toolkit](../archive/small-model-reliability-toolkit.md). The toolkit owns checkpoint completeness and reset eligibility; this package owns provider-visible transformation, transport capability, continuation epochs and restoration. The frozen version-1 adapter contract is in the toolkit plan's section 30. No runtime installation or provider calls are authorized by this plan revision.

The reliability-side implementation is completed and archived, with production checkpoint-only behavior, retained-session plan phases and narrowly verified live pre-transform recovery. This companion's provider transformation and continuation integration remain pending; the reliability report does not claim they were implemented.

## 1. Goal

Implement a Pi extension that lets the running agent inspect large exploratory tool results, explicitly retain a bounded factual summary, and exclude discarded raw material from subsequent LLM requests while:

1. preserving the original session history on disk;
2. keeping tool-call/result protocol structure valid;
3. making pruning decisions deterministic and branch-aware;
4. limiting prompt-cache disruption to a deliberate one-time checkpoint transition;
5. retaining artifact/source references so discarded material can be retrieved when needed;
6. never claiming that editing an already-cached prompt prefix is cache-neutral.

The primary scenario is web research: the agent receives several search/fetch results, selects useful facts and citations, records a checkpoint, and continues without repeatedly sending irrelevant raw results.

## 2. Fundamental cache constraint

Provider prompt caches generally reuse an unchanged prompt prefix. If a previously transmitted tool result is later removed or rewritten, the reusable prefix ends at the first changed token. The implementation therefore cannot guarantee unchanged cache reads/writes after pruning historical content.

The design must optimize for:

- **best case:** raw data is filtered or summarized by the tool before the main model ever sees it;
- **supported agent-curation case:** the main model sees raw results once, creates one stable checkpoint, and all later requests use the same compact representation;
- **explicitly avoided case:** relevance is recalculated and historical messages are changed before every request.

A checkpoint may cause one cache miss/write transition. Once created, its transformed context must remain byte-stable so subsequent requests can again benefit from prefix caching.

## 3. Measurable success criteria

1. The agent can call one stable `context_checkpoint` tool after inspecting eligible results.
2. On the next LLM request, selected raw results are absent or replaced by bounded deterministic placeholders and the retained summary is present exactly once.
3. Session JSONL continues to contain the original unmodified assistant and tool-result messages.
4. Checkpoint state survives reload/resume and follows the active session branch.
5. Tool calls and their corresponding results remain structurally valid for Anthropic Messages, OpenAI Responses/Codex Responses, and OpenAI-compatible chat transports.
6. A checkpoint decision is immutable by default; later calls do not silently reclassify old context.
7. Multiple selected results are curated in one batch so the prompt prefix changes once rather than once per result.
8. Retained summaries, handles, artifact references, and injected placeholders have strict size/count limits.
9. Status output distinguishes observed token reduction from provider-reported cache behavior.
10. Credential-free tests prove deterministic context transformation, persistence, branching, protocol validity, and bounded behavior.
11. Provider/transport smoke tests verify that stateful continuation does not replay stale unpruned history.
12. Documentation clearly states the one-time cache invalidation trade-off and recovery behavior.

## 4. Scope

### In scope

- A new `@firstpick/pi-extension-context-curator` package.
- A stable agent tool for explicit checkpoint creation.
- Candidate handles for eligible tool-result messages.
- Non-destructive context transformation through Pi's `context` event.
- Append-only checkpoint state through `pi.appendEntry()`.
- Branch-aware state reconstruction from `ctx.sessionManager.getBranch()`.
- Deterministic retained-summary and placeholder injection.
- Status, preview, and last-checkpoint undo commands.
- Token/common-prefix estimates and provider-reported cache-usage diagnostics.
- Compatibility tests for current Pi message and provider payload shapes.

### Non-goals

- Deleting or rewriting historical session JSONL entries.
- Guaranteeing zero cache impact after an already-sent prefix changes.
- Letting a background classifier rewrite history before every call.
- Treating model-generated summaries as authoritative without source references.
- Persisting complete raw web results when the originating tool does not already provide an artifact/content handle.
- Pruning user requirements, system instructions, write/edit results, errors, security decisions, or unclassified tool output by default.
- Provider billing tests in the automated suite.

## 5. Approved design decisions

| Decision | Working default | Rationale |
|---|---|---|
| Product form | New standalone extension | Keeps the behavior optional and avoids patching Pi core initially. |
| Trigger | Explicit agent tool call, or an automatic validated phase-boundary request from the reliability adapter | Both paths validate an inspectable checkpoint once; neither permits per-call relevance reclassification. |
| Persistence | Append-only custom entries | Survives resume/branching without entering LLM context directly. |
| Context behavior | Rewrite eligible tool-result content to a placeholder; inject one stable checkpoint summary | Preserves tool-call/result protocol integrity while removing most raw tokens. |
| Curation unit | Explicit result handles, committed as one batch | Gives precise control and a single cache transition. |
| Eligibility | Read-only exploratory tools only, allowlisted | Avoids losing mutation/error/security evidence. |
| Cache policy | Freeze each checkpoint after creation | Allows the new prompt prefix to become reusable. |
| Raw data | Leave in session history and tool-owned artifacts | Enables audit/recovery without resending it to the model. |
| Undo | Append a superseding state entry | Never edits prior session records. |
| Stateful transports | Capability-tested; fail open by retaining context if safety is uncertain | Prevents stale provider-side continuation from bypassing the transformation. |

## 6. User and agent flow

```text
Agent calls web/search/fetch tools
        |
        v
Tool results enter session unchanged
        |
        v
Context hook exposes deterministic curation handles
        |
        v
Agent inspects results once
        |
        v
Agent calls context_checkpoint({ summary, discard, sources })
        |
        v
Extension validates and appends checkpoint state
        |
        v
Next context build replaces selected raw results with stable placeholders
and injects one retained summary with source/artifact references
        |
        v
Future requests remain append-only until another explicit checkpoint
```

A tool result cannot be discarded before the agent has seen it unless the originating tool itself performs pre-filtering. That distinction must be documented.

## 7. Proposed package layout

```text
pi-extension-context-curator/
├── index.ts
├── package.json
├── README.md
├── LICENSE
├── src/
│   ├── contracts.ts
│   ├── config.ts
│   ├── eligibility.ts
│   ├── handles.ts
│   ├── state.ts
│   ├── transform.ts
│   ├── tool.ts
│   ├── commands.ts
│   ├── diagnostics.ts
│   └── provider-compat.ts
└── tests/
    ├── fake-pi.mjs
    ├── state.test.mjs
    ├── transform.test.mjs
    ├── protocol-validity.test.mjs
    ├── branching.test.mjs
    ├── limits.test.mjs
    ├── provider-payload.test.mjs
    └── installed-host-smoke.test.mjs
```

`index.ts` should contain registration/wiring only. State reduction and context transformation must be pure and independently testable.

## 8. Data contracts

### 8.1 Candidate handle

Candidate handles are deterministic, local identifiers derived from the session ID, active branch entry ID, and tool-call ID. They must not contain raw result text.

```ts
interface CandidateHandleV1 {
  schemaVersion: 1;
  handle: string;          // e.g. ctx_7f3a91c2
  entryId: string;
  toolCallId: string;
  toolName: string;
  estimatedTokens: number;
  artifactRefs: string[];
}
```

Handles are validated against the current active branch when a checkpoint is created. The agent cannot prune arbitrary IDs or entries from another branch.

### 8.2 Checkpoint entry

Custom entry type: `context-curator-checkpoint`.

```ts
interface ContextCheckpointV1 {
  schemaVersion: 1;
  checkpointId: string;
  createdAt: number;
  branchAnchorId: string;
  summary: string;
  discardedHandles: string[];
  sources: Array<{
    handle: string;
    label?: string;
    url?: string;
    artifactRef?: string;
  }>;
  estimatedTokensRemoved: number;
  status: "active" | "superseded";
}
```

Requirements:

- Cap summary length, handle count, source count, and every string field.
- Accept only HTTP(S) source URLs and validated tool-owned artifact references.
- Store no duplicate raw result content in the custom entry.
- Treat malformed or unknown schema versions as non-operative and report diagnostics.

### 8.3 Automatic reliability checkpoint adapter

Implement the version-1 request, capability, receipt, epoch and restoration contract frozen in [the toolkit plan, section 30](../archive/small-model-reliability-toolkit.md#frozen-checkpoint-adapter-contract). The explicit `context_checkpoint` workflow remains supported. Automatic requests require a durable validated reliability checkpoint, an eligible settled semantic boundary and verified provider/transport support.

Reliability renders the canonical Markdown and seed, preserves requirements/evidence/scope/budgets, and validates the post-reset receipt. The curator rebuilds the supported provider-visible continuation, preserves the append-only session, and supplies exact seed/epoch/branch evidence. Unsupported or uncertain transports return checkpoint-only without changing context. A failed handshake restores the prior epoch when supported or leaves the task paused; mutation is forbidden during unresolved recovery.

The explicit placeholder path in section 10 is not itself a fresh-continuation proof. Full automatic clearing needs transport-specific epoch reset tests. Faithful fake-adapter tests demonstrate only the contract and cannot unlock production reset support.

### 8.4 Superseding/undo entry

Custom entry type: `context-curator-control`.

```ts
interface ContextCheckpointControlV1 {
  schemaVersion: 1;
  action: "disable" | "restore";
  checkpointId: string;
  createdAt: number;
}
```

Undo is append-only. Restoring raw content is allowed only through an explicit user command because it causes another prompt-prefix change.

## 9. Eligibility and safety policy

Default eligible tools:

- `web_search`
- `brave_search`
- `fetch_content`
- `get_search_content`
- other configured, explicitly read-only research tools

Default excluded content:

- user and system messages;
- assistant decisions and final answers;
- `write`, `edit`, Bash, subagent, deployment, release, authentication, or other potentially mutating tool results;
- errors and blocked safety operations;
- tool results participating in an unresolved parallel batch;
- custom messages owned by other extensions;
- compaction and branch summaries.

Configuration may add a tool to the allowlist only when its output is read-only and its call/result protocol is understood. Unknown tools remain in context.

## 10. Context transformation

The `context` handler receives a deep copy and must not mutate session storage.

For every active checkpoint:

1. Rebuild active state from append-only custom entries on the current branch.
2. Resolve each discarded handle to exactly one eligible tool-result message.
3. Preserve the original assistant tool-call message.
4. Replace the selected tool-result text with a deterministic placeholder:

   ```text
   [Context checkpoint <id>: raw result omitted; retained findings follow. Source handle: <handle>.]
   ```

5. Insert one deterministic custom summary after the final result covered by that checkpoint.
6. Keep message order stable.
7. Avoid `Date.now()` or other changing values in injected context.
8. Return `undefined` when no transformation is needed.

The summary injection should contain:

- checkpoint ID;
- agent-authored retained facts;
- source labels/URLs/artifact references;
- an explicit note that omitted raw material is not evidence unless restored.

The same session branch and checkpoint state must produce byte-equivalent provider-visible content on every subsequent call.

### Why placeholders instead of deleting messages

Keeping the tool-result message and replacing only its content preserves call/result pairing across provider protocols. Entire call/result groups may be removed later only after transport-specific tests prove that mixed assistant content, reasoning blocks, and parallel tool batches remain valid.

## 11. Tool and command interfaces

### 11.1 Agent tool

Register the tool at extension startup and keep it active for the whole session so the system prompt/tool schema remains stable.

```ts
context_checkpoint({
  summary: string,
  discard: string[],
  sources?: Array<{
    handle: string,
    label?: string,
    url?: string,
    artifactRef?: string
  }>
})
```

Behavior:

- Validate all handles against current eligible branch candidates.
- Reject duplicate, stale, ineligible, or already-discarded handles.
- Require a non-empty bounded summary.
- Preview estimated token reduction in tool-result `details`.
- Persist only after complete validation.
- Return the checkpoint ID and state that pruning begins on the next LLM call.
- The explicit tool never automatically restores or removes previous checkpoints. A failed automatic-reset handshake may restore the prior provider-visible epoch through the validated adapter recovery contract; prior checkpoint and session records remain intact.

The tool description should encourage batching all completed research results into one checkpoint. Avoid dynamic system-prompt modifications and active-tool toggling.

### 11.2 User commands

- `/context-curator status` — list active checkpoints, estimated tokens removed, and compatibility mode.
- `/context-curator candidates` — list currently eligible handles without changing context.
- `/context-curator preview <handles...>` — estimate the transformation, read-only.
- `/context-curator undo-last` — explicit confirmation, then append a restore control entry.
- `/context-curator off|on` — session-scoped fail-open toggle; `off` retains all original context.

Commands must use Pi's native selection/list UI where a list is required.

## 12. Cache-preservation strategy

1. Keep system prompt text and tool definitions stable from session start.
2. Do not dynamically enable/disable the checkpoint tool.
3. Prefix eligible result content with deterministic handles the first time it is shown.
4. Encourage one checkpoint per completed research phase, not one per result.
5. Never re-run relevance classification automatically on later prompts.
6. Keep checkpoint summaries and placeholders byte-stable.
7. Apply checkpoint state at a clear boundary, then return to append-only conversation growth.
8. Record provider-reported `cacheRead` and `cacheWrite` only as observations, not guarantees.
9. Do not enable cache writes for any optional one-off summarizer call.
10. Prefer originating tools that store full output externally and return bounded content, because unseen raw data causes no main-context cache disruption.

## 13. Provider and transport compatibility

The implementation must test these families separately:

| Transport | Required check |
|---|---|
| Anthropic Messages | Placeholder and summary serialization remains valid; cache breakpoint behavior is observed. |
| OpenAI Responses | The next request reflects transformed history rather than stale previous-response continuation. |
| OpenAI Codex Responses/SSE | Session affinity remains, but historical edits are actually transmitted. |
| OpenAI Codex cached WebSocket | Detect whether append-only continuation bypasses modified history; fall back safely if it does. |
| OpenAI-compatible Chat Completions | Tool-call/result pairing remains valid after placeholder replacement. |
| Providers without cache reporting | Token reduction works; cache diagnostics show `unknown`. |

If a stateful transport cannot safely represent changed historical context, the extension must fail open by retaining the original context and report `unsupported transport` rather than pretending pruning succeeded. A future core-level checkpoint API may be proposed if extension-level transformation cannot safely reset provider continuation.

## 14. Persistence and branching

- Reconstruct state from `ctx.sessionManager.getBranch()` on `session_start` and reload.
- Apply only checkpoint/control entries present on the active branch.
- A fork inherits checkpoints copied into its branch history.
- Tree navigation recomputes state from the selected branch; no global mutable decision map is authoritative.
- Compaction may summarize already-curated content. After `session_compact`, re-resolve surviving handles and retire checkpoints whose target messages are no longer present.
- Never scan unrelated session files or trust entry IDs from another session.

## 15. Diagnostics and observability

Expose:

- raw estimated context tokens before transformation;
- transformed estimated tokens;
- estimated tokens removed per checkpoint;
- first changed message index/common-prefix estimate;
- latest provider-reported cache read/write values when available;
- active provider/transport compatibility status;
- stale, unresolved, or retired handle counts;
- whether full raw content remains available through the session/artifact reference.

Do not calculate a universal “cache savings” number from token estimates. Cache pricing and matching are provider-specific.

## 16. Failure behavior

- Invalid or stale checkpoint state: retain original context and report a bounded warning.
- Unknown provider/transport behavior: retain original context.
- Summary injection failure: retain original context.
- Partial handle resolution: reject checkpoint creation; do not prune a subset silently.
- Reload/resume parse failure: ignore malformed custom entries and retain context.
- Context-hook exception: allow Pi's normal extension error handling, but never return a partially transformed message list.
- Undo failure: leave the active checkpoint unchanged.

Fail-open means “keep more context,” never “drop uncertain context.”

## 17. Implementation workstreams

### Wave 0 — contracts and compatibility spike

- Confirm installed Pi event/message types and provider payload serialization.
- Build minimal fake session/branch fixtures.
- Verify deterministic tool-result handles.
- Test whether OpenAI/Codex stateful continuation honors context-hook history changes.
- Stop and escalate if provider continuation cannot be reset safely from an extension.

### Wave 1 — pure state and transformation core

Write boundary:

- `src/contracts.ts`
- `src/config.ts`
- `src/eligibility.ts`
- `src/handles.ts`
- `src/state.ts`
- `src/transform.ts`

Deliver:

- strict schemas and bounds;
- branch state reducer;
- candidate resolution;
- deterministic placeholder/summary transformation;
- protocol-validity and property-style tests.

### Wave 2 — Pi integration

Write boundary:

- `src/tool.ts`
- `src/commands.ts`
- `src/provider-compat.ts`
- `index.ts`

Deliver:

- checkpoint tool;
- status/preview/undo commands;
- `session_start` reconstruction;
- `context` event integration;
- provider/transport capability gate.

### Wave 3 — diagnostics and package completion

Write boundary:

- `src/diagnostics.ts`
- `README.md`
- `package.json`
- `LICENSE`
- installed-host and payload tests

Deliver:

- token/common-prefix and cache-usage diagnostics;
- package metadata and tarball contents;
- operating, privacy, cache, recovery, and limitation documentation.

### Wave 4 — integrated validation and review

- Run package tests, type checks, diff checks, and package dry-run.
- Run credential-free installed-host smoke scenarios for search → checkpoint → next call.
- Inspect provider payloads for all locally testable transports.
- Obtain two independent read-only reviews focused on:
  1. message/protocol/provider correctness and cache claims;
  2. state persistence, branching, safety, tests, and UX.
- Disposition every finding as `accepted`, `rejected`, `deferred`, or `needs verification`.

## 18. Test matrix

| Area | Required cases |
|---|---|
| Candidate handles | Deterministic; collision-resistant; no raw text; stale/foreign IDs rejected. |
| Eligibility | Allowlisted research tools accepted; mutating/error/unknown content retained. |
| Transformation | One result; many results; parallel results; multiple checkpoints; stable repeated output. |
| Protocol | Tool call/result pairing; mixed assistant text; multiple tool calls; reasoning blocks; error results excluded from pruning. |
| Bounds | Oversized summary; too many handles/sources; long URLs/artifact refs; malformed entries. |
| Persistence | Reload, resume, fork, tree branches, superseding undo, malformed state. |
| Compaction | Targets retained; targets summarized away; stale checkpoint retirement. |
| Cache model | Common-prefix boundary before/after checkpoint; one-time transition; no later drift. |
| Provider payloads | Anthropic, OpenAI Responses, Codex SSE/WebSocket, Chat Completions. |
| Failure mode | Unsupported transport and hook errors retain original context. |
| Privacy | Custom state contains summaries/references only, never duplicated raw results. |
| UX | Status/candidates/preview/undo cancellation; no-UI behavior. |
| Packaging | `npm test`, typecheck, `npm pack --dry-run`, install from tarball. |

## 19. Acceptance checks

1. In a fixture containing at least three large web results, one checkpoint reduces subsequent provider-visible input by the expected bounded amount.
2. The original session messages remain byte-identical before and after checkpoint creation.
3. Repeated context builds after the checkpoint are deterministic.
4. The first changed provider-visible message is identified and reported, demonstrating honest cache-prefix impact.
5. No mutating, error, user, system, or unknown-tool message is pruned under defaults.
6. Checkpoints survive reload/resume and diverge correctly across branches.
7. Undo restores raw context only after explicit user confirmation and records the resulting second cache transition.
8. Unsupported stateful transports retain original context and display a clear reason.
9. Package tests and installed-host smoke tests pass without network credentials or billable requests.
10. Documentation never promises cache neutrality or universal cost savings.

## 20. Rollout

### Phase A — observe mode

- Generate candidates and previews only.
- Measure deterministic token reduction and provider compatibility locally.
- Do not alter outgoing context.

### Phase B — explicit opt-in pruning and validated automatic boundaries

- Enable `context_checkpoint` transformations only after an explicit session/user setting.
- Accept automatic reliability phase-boundary requests only after the versioned adapter and real provider/transport suite pass. Preserve the toolkit's strict opt-in rollout, pressure/cooldown bounds, checkpoint-only fallback and mutation-blocking handshake.
- Keep unsupported transports fail-open.
- Collect local diagnostics; no telemetry leaves the machine.

### Phase C — default-on tool availability

- Keep the tool registered and available by default. Pruning requires either an explicit agent checkpoint or a validated reliability adapter request under an enabled opt-in profile; automatic requests cannot bypass transport, durability or handshake gates.
- Consider broader eligible-tool configuration only after transport and branch tests pass.

## 21. Rollback and recovery

- Disable the extension or run `/context-curator off`; original session messages remain available.
- Older extension versions safely ignore the new custom entry types.
- Do not delete checkpoint entries during rollback.
- `undo-last` appends a control record rather than mutating history.
- If checkpoint state is unreadable or incompatible after an upgrade, retain all original context.
- Full raw tool output remains recoverable from session history and any originating tool artifact, subject to that tool's retention policy.

## 22. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---:|---|
| Historical edit invalidates prompt cache | High | One explicit batched checkpoint, then byte-stable append-only context; honest diagnostics. |
| Stateful provider continuation ignores transformed history | High | Transport-specific payload tests and fail-open compatibility gate. |
| Invalid tool protocol after pruning | High | Preserve assistant tool call and tool-result message; replace content only. |
| Model drops important evidence | High | Explicit retained summary plus source/artifact references; user undo; conservative eligibility. |
| Hidden automatic relevance drift hurts cache repeatedly | High | No per-call classifier; immutable checkpoint decisions. |
| Branch state leaks between histories | Medium | Rebuild only from active branch entries. |
| Compaction leaves stale handles | Medium | Re-resolve after compaction and retire missing targets. |
| Summary contains sensitive source data | Medium | Local-only persistence, strict bounds, documentation, no telemetry. |
| Cache metrics are misinterpreted | Medium | Separate token estimates from provider-reported R/W and avoid universal savings claims. |
| Agent overuses checkpoints | Low | Tool guidance recommends one checkpoint per completed research phase. |

## 23. Evidence and references

### Repository patterns

- `pi-extension-todo-progress/index.ts` — branch-state persistence and deterministic `context` event injection.
- `pi-extension-todo-progress/tests/` — extension test convention.
- `plans/planned/session-scoped-model-effort.md` — plan structure and acceptance/review conventions.

### Installed Pi documentation

- `pi-package-webui/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
  - `context` event receives a deep copy and can return filtered messages.
  - `pi.appendEntry()` persists state without adding it to LLM context.
  - `tool_result` can modify result content before persistence when pre-filtering is preferred.
- `pi-package-webui/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md`
  - session entries are append-only/tree-structured and custom entries do not participate in context.
- `pi-package-webui/node_modules/@earendil-works/pi-coding-agent/docs/compaction.md`
  - compaction replaces older context with a summary and uses cache-disabled one-off summarization requests.

### Exploration record

- Repo Explorer effectiveness report: `/home/firstpick/.pi/agent/skills/repo-explorer/repo-explorer-effectiveness-2026-07-28T21-33-56-219Z-npm-packages-6765dda935.md`

## 24. Completion record

Implementation is complete only when:

- all acceptance checks are evidenced;
- integrated diffs match this plan or deviations are recorded;
- provider/transport compatibility is demonstrated or safely gated;
- independent review findings are dispositioned and accepted fixes revalidated;
- package installation and rollback are tested;
- this plan is moved from `plans/planned/` to `plans/archive/` only after final verification.
