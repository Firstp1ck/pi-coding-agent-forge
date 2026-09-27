# Independent confidence review extension

Status: design delivered; implementation not authorized in this session.
Integration owner: the primary Pi agent implementing this plan in a later session.
Proposed package: `@firstpick/pi-extension-confidence` in `pi-extension-confidence/`.
Future implementation report: `reports/independent-confidence-review.html`. Not created for this design-only phase.

## Outcome and approved scope

Replace the main agent's self-assigned confidence with a score produced by a separately configured model. Give the reviewer the main agent's complete active context. Feed specific criticisms back to the main agent for critical investigation and correction.

User decisions from questionnaire `d23ee543-07f7-4a7f-ae76-f7e3955093aa`:

- Finish the design and implementation plan first. Do not write extension code yet.
- Complete context means everything in the main agent's active context, not the entire historical session branch. Existing compaction summaries remain summaries.
- The initial answer may stream and remain visible while review is pending. Corrections follow afterward.
- Make just one reviewer call. No recheck.
- Model and thinking effort must be user-configurable. No model was selected and no provider call is authorized by this planning phase.

Implementation, installation, enablement, settings changes, publication, and paid live-provider tests are outside this phase. Do not modify the existing confidence-reporting note automatically.

## Classification and capability gate

Classification: complex, confirmed from repository and installed API evidence. Context capture, provider-neutral review, typed findings, automatic continuation, lifecycle cancellation, and native configuration UI are distinct implementation slices. Full-context transfer introduces a privacy boundary. Continuation and score attribution introduce reliability risks.

The current session exposes no `subagent` capability. No worker or independent-review waiver was requested or granted. Future implementation must obtain two qualifying implementation-worker outcomes and two distinct fresh-context read-only review outputs, or explicit scoped waivers. The current deliverable is the design, not a completed feature.

## Recommended architecture

Use an in-process, tool-free reviewer call through `ctx.modelRegistry.streamSimple()`. Do not launch another Pi process, load ambient extensions into a child session, or reuse the repository's large `/review` execution loop.

```text
Main agent writes candidate answer
  -> freeze active-context snapshot + candidate identity
  -> display review pending
  -> one call to configured reviewer, with no executable tools
  -> validate structured result and attach score to candidate
       -> no actionable findings: settle
       -> actionable findings or low score: inject numbered review
            -> main agent investigates every finding
            -> submit evidence-backed dispositions and revised answer
            -> settle without another reviewer call
```

The reviewer is an independent inference, not an oracle. Its score is an assessment of support and correctness in the supplied evidence, not a calibrated probability of truth. A tool-free reviewer cannot verify facts outside that context.

### Design comparison

These are local engineering judgments, not measured performance scores. Scale is 1 to 5, with 5 best.

| Approach | Low orchestration overhead | Fits one-call limit | Public API fit | Decision |
| --- | --- | --- | --- | --- |
| Direct registry model call | 5 | 5 | 5 | Recommended |
| Isolated multi-turn Agent or existing `/review` runner | 3 | 2 | 4 | Unneeded tool/loop machinery for this feature |
| Separate Pi subprocess | 1 | 2 | 3 | Extra startup, auth, context-transfer and lifecycle work |

Evidence is limited to the installed Pi docs/types/source and local review implementation. This does not meet a three-independent-source technology survey, and no comparative latency benchmark was run. No claim about current model rankings, pricing, or provider speed is made.

## Context contract

The reviewer receives the full active input that produced the candidate, plus the candidate itself. Include instructions, system/tool-state changes, tool definitions as evidence, user and assistant messages, tool calls/results, current compaction summaries, custom messages visible to the model, and supported attachments. Preserve ordering and stable references.

Do not reread files or expand tool-output truncation to invent additional context. A tool result that was already truncated for the main agent remains the same result. Files the agent never read are not part of its context. Do not include abandoned branches, credentials from auth storage, or HTTP authentication headers. Provider-private reasoning and opaque server state are not available to an extension and must not be promised.

Proposed capture mechanism:

1. Observe `context_with_system` without mutating the main request. Associate the latest snapshot with the request generation and eventual assistant message.
2. Capture the effective prompt through public context methods where needed. Track system/tool transitions without flattening away their meaning.
3. At `agent_before_settle`, use boundary messages and branch identity to identify the candidate and check snapshot freshness. Do not assume the boundary projection is identical to the last provider input.
4. Freeze the snapshot before the reviewer call. Hash the serialized context and candidate, and assign review/session/branch/request IDs.
5. Put the captured conversation under the reviewer's own evaluation instructions as quoted evidence, not as instructions for the reviewer to obey. Preserve role labels and text exactly. Keep image content as actual image blocks with stable references, not base64 text to be interpreted by the model.
6. Historical tool declarations are data only. Supply no executable tools and request `toolChoice: "none"` where supported. A returned tool call is an invalid review, never something to execute.

### Context fidelity is a release gate

Installed Pi 0.87.1 has an important limitation. `context_with_system` handlers execute in registration order, and later handlers can change their output. Forced system-prompt projection can also run after the context transform. The settlement preview reconstructs session projection rather than rerunning all request-local transforms.

Therefore a naïve snapshot in one hook cannot guarantee the exact final request in arbitrary extension combinations. Before implementation is accepted:

- Prove capture fidelity for the supported host version with fixtures for forced prompts, later context transforms, tool changes and compaction.
- Establish a documented, testable capture ordering contract for supported extension-only operation. Merely naming the file to sort last is not a general guarantee.
- If public hooks cannot expose the required final logical context reliably, stop and propose a narrow read-only post-transform host hook. Host changes require separate user approval.
- Never silently substitute an incomplete session history and label it full context. Report `review unavailable: full-context capture unsupported` instead.

The required contract is semantic content completeness, not byte-identical provider HTTP payloads. Provider-specific envelopes, prompt-role encoding and tokenization differ between models.

### Context limits and privacy

- Full input plus reviewer instructions and output reserve must fit the selected model. Use available model/input-limit metadata and conservative estimates; token estimates are not exact across providers.
- Reject known oversized or unsupported multimodal input before dispatch. Treat provider overflow as review unavailable. Never summarize, trim, drop images, switch models, or retry behind the user's back.
- Setup must disclose that the entire active conversation, including private code and instructions, will go to the selected provider. Require explicit enablement and renewed consent for a changed destination.
- Do not store a second full transcript by default. Keep the snapshot in memory only for the review; persist minimal provenance and findings with normal session privacy. Even findings can quote sensitive content.
- Redaction changes the full-context contract. If a future redacted mode is added, make it explicit and label its omissions. Do not quietly claim redacted context is complete.

## Reviewer request and result

The reviewer should examine material claims and important omissions, instruction compliance, evidence quality, contradictions and unverified assumptions. It must distinguish `incorrect`, `unsupported`, and `uncertain`. Missing evidence is not proof that a claim is false.

Ask it to ignore existing self-reported scores, confident wording and previous review scores when judging the candidate. Those remain in the quoted context when present, but are not evidence of correctness.

Proposed validated result fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Supported result format version |
| `score` | Integer from 0 to 100, reviewer-owned |
| `summary` | Short explanation of the assessment |
| `findings` | Ordered array with unique IDs |
| `findingsComplete` | False if the output budget prevented reporting all identified material concerns |
| `limitations` | Explicit bounds of the review, including unavailable external verification |

Each finding requires:

- `id`, severity and claim type.
- Exact candidate claim text and a candidate reference, or an explicitly typed omission tied to a user requirement.
- A precise reason for concern. Reject vague criticism such as "needs more testing" without naming what is untested and why it matters.
- Supporting or conflicting context references, with quotes where present. An absent source must be marked absent, not fabricated.
- A concrete verification step and what observation would resolve the concern.

A schema validator checks types, finite integer score, unique IDs, bounded output, required fields, candidate references and resolvable context quotes. Validation proves structure/reference existence, not that the reviewer's reasoning is correct. A score below the applicable threshold requires at least one actionable finding explaining why.

Do not average away a severe unsupported central claim. Use a shared prompt rubric covering evidence support, logical consistency, task completion and verification. Explain deductions, but do not pretend arbitrary deduction arithmetic makes the score scientifically calibrated.

Malformed output, truncated output, a tool-call response, missing explanations, or `findingsComplete: false` cannot produce a normal valid score badge. Show review unavailable or incomplete. Preserve clearly labeled valid partial findings if useful. Do not make a second model call to repair the format.

### Feedback shown to the main agent

Render the findings as a numbered list. Example only, not a finding about this repository:

1. Claim: "Cancellation prevents all subsequent writes."
   - Concern: The supplied test covers cancellation before launch, not during an in-flight write.
   - Evidence: The cited test lacks an assertion about writes after cancellation.
   - Verify: Exercise cancellation during the write boundary and inspect recorded side effects.
   - Resolution criterion: A passing regression test, or narrower wording that states the verified limit.

Review text is untrusted critique. It cannot change user scope, authorize external side effects, override safety rules, or order the main agent to run a suggested command without inspection.

## Main-agent investigation and score ownership

On a low score or any actionable finding, append a custom context message at `agent_before_settle` and return a bounded continuation request. High score must not suppress an otherwise actionable criticism. Informational-only notes can remain visible without forcing work.

Instruct the main agent to investigate every returned finding, using existing tools and the original task's permissions. For each ID it must record one disposition:

- `accepted`: independent evidence supports the concern; fix or qualify the answer within scope.
- `rejected`: cite evidence that contradicts the reviewer. Mere disagreement is insufficient.
- `unresolved`: explain missing evidence, authorization or capability, and state the remaining uncertainty.

Propose a small `confidence_resolve` tool to record a structured disposition ledger. Validate review ownership, known IDs, no duplicates, and complete ID coverage. This makes coverage inspectable, but cannot prove that the model genuinely reasoned well. Findings unresolved at a limit remain unresolved, not silently accepted or rejected.

Allow one investigation continuation for the reviewed user request. The main agent may use several tool/model turns within it. Do not schedule another continuation merely because a ledger is missing. Mark the investigation incomplete. A proposed configurable turn/time bound must pause this continuation without cancelling unrelated queued user work; prove that ownership behavior before enabling a hard stop.

The one-review budget belongs to the user request and persists through correction, repeated boundary events, reload and branch restoration. Internal follow-ups, custom messages, model switches or settings changes must not reset it. Mark an attempt as claimed before dispatch so an interrupted call is not retried on resume. A new explicit user request gets a new budget.

The extension renders the authoritative score directly. The main agent may quote it with provenance, but cannot submit or overwrite a numeric score through the resolution tool.

**No recheck means no score for the revision.** Display, for example:

```text
Initial answer confidence: 64/100
Reviewer: <provider/model>, thinking: low
Investigation: 2 accepted, 1 rejected with evidence, 1 unresolved
Revised answer: not re-scored
```

Bind every score to the reviewed candidate hash, model, thinking level and timestamp. If the candidate changes, invalidate any badge implying the score belongs to the current answer. Do not call the revised answer verified just because all findings have dispositions.

The existing user-authored confidence rule remains untouched. On enablement, explain that independently reviewed scores replace self-assessment in this workflow. Resolve any instruction conflict through explicit user approval, not silent edits to persistent Notes.

## Performance and failure behavior

Approved invariant: at most one reviewer invocation per user request, with no automatic recheck, format repair, model fallback or extension-level retry. Pass `maxRetries: 0` to supporting providers. Test actual adapter behavior; one extension invocation is not proof that an arbitrary proxy performs no internal retries.

Proposed defaults for setup confirmation, not yet user-approved numeric settings:

| Setting | Proposal |
| --- | --- |
| Model | Explicit user selection; no silent fallback to the main model |
| Thinking | Suggest `low`, but offer only supported levels and honor the selected level |
| Reviewer timeout | 30 seconds, configurable and cancellable |
| Reviewer output | 2,048 tokens, configurable; truncated results remain incomplete |
| Findings | Up to 8 precise findings; explicit incomplete marker if more cannot fit |
| Threshold | 80 generally, 90 for web-backed work, following the existing user rule |
| Automatic review | Normal substantive final answers; manual off/skip controls; no extra LLM classifier |
| Main-agent investigation | One continuation; propose 8 model turns or 120 seconds once safe ownership enforcement is verified |

If detecting web-backed work, use observed configured web-tool activity conservatively rather than only the main agent's label. Keep thresholds in one settings source. Do not spend an extra model call deciding whether review is needed. Conservative local exclusions may skip simple acknowledgments; ambiguous answers should be reviewed. Exact-response tasks need an explicit suppression path so review messages do not violate their output contract.

Keep inference and serialization off rendering callbacks. No polling or background daemon. Do not send the full context after every tool call. Retain only the latest needed request snapshot rather than serializing and persisting every intermediate snapshot.

Stable reviewer instructions and append-only evidence encoding may allow provider prompt caching across later user requests. This is an optional provider-dependent benefit, not a promise of cache hits, cross-model cache sharing or lower bills. Do not add keep-warm requests.

Full-context input remains the dominant possible cost. Measure local preparation, provider time, input/output/cache tokens, available cost and investigation time separately. Show unknown cost as unknown. Main-agent investigation is additional work even with exactly one reviewer call.

Timeout, authentication failure, missing model, unsupported thinking, context overflow, cancellation and invalid schema produce `Confidence unavailable`, never `0/100` or a self-assessed fallback. Do not block the user's usable original answer indefinitely. Clear timers and abort work on shutdown, disablement, session switch or invalidated request ownership. Ignore stale late results.

Pi's signal may be absent at an idle boundary. The implementation must own a reviewer AbortController and test cancel commands, lifecycle changes and the host's Escape behavior rather than assuming `ctx.signal` covers them all.

## Proposed commands and UI

- `/confidence setup`: model, supported thinking, thresholds and limits using native `SettingsList` and `SelectList` or built-in dialogs. Reuse Pi authentication and respect scoped models.
- `/confidence on` and `/confidence off`: explicit session enablement controls; persistence is a separate confirmed setup choice.
- `/confidence status`: score provenance, findings, dispositions, latency and cost without invoking any model.
- `/confidence cancel`: cancel the owned pending reviewer call or investigation scheduling, not unrelated work.
- `/confidence review`: use the current request's still-unused review budget manually. Refuse if already spent; do not disguise this as an automatic recheck.

Use native lists, not a handwritten list widget. Render the score as extension-owned status/custom content so it is distinct from assistant-authored prose. Provide non-TUI command arguments and structured persisted messages for RPC/JSON/print modes. Do not silently rely on custom TUI components in RPC.

Keep the package inert until explicitly enabled and a destination model is selected. No global settings changes on import. Proposed settings storage is a dedicated extension file under Pi's resolved agent directory, with session overrides; confirm and document its exact path before implementation.

## Implementation waves and ownership

The integration owner alone updates this plan, accepts handoffs, edits the repository catalog, and produces the final implementation report. Future delegated workers must load the applicable coding and feature skills before writing code.

1. S0, read-only API proof. Verify capture fidelity, native thinking support, abort behavior, usage accounting and continuation ownership against the supported Pi version. Produce `plans/handoffs/independent-confidence/api-proof.md`. Stop on a required unapproved host change.
2. W1, context and review core. Own `pi-extension-confidence/src/context.ts`, `protocol.ts`, `reviewer.ts`, `state.ts` and matching tests. Deliver independently testable capture serialization, strict review validation, attempt ownership, provider adapter and cancellation logic. Handoff `plans/handoffs/independent-confidence/core.md`.
3. W2, extension integration and UX. After W1 is accepted, own `pi-extension-confidence/index.ts`, `src/settings.ts`, `src/ui.ts`, `src/feedback.ts`, corresponding integration/UI tests, package metadata and the package's README/TECHNICAL/DEVELOPMENT/LICENSE. Integrate hooks, settings, native lists, direct rendering, ledger tool and one investigation continuation. Handoff `plans/handoffs/independent-confidence/runtime.md`.
4. Parent integration. Inspect actual changes from both workers, resolve seams under explicit ownership, update root README catalog, run combined validation and record results here.
5. R1 and R2, separate fresh-context read-only reviewers. Each assesses the full package and plan; emphasize context/privacy and lifecycle/cost respectively. Save distinct outputs under `plans/handoffs/independent-confidence/review-1.md` and `review-2.md`. Follow the feature contract's provider-availability and fallback rules.
6. Parent disposition and report. Independently verify every review finding before accepting fixes. Record accepted/rejected/deferred/needs-verification status, revalidate accepted fixes, and create the self-contained HTML implementation report with mutual plan/report links.

DAG: S0 -> W1 -> W2 -> integration -> R1 + R2 -> verified fixes -> validation -> report. Workers do not edit another owner's files or shared plan state. Each handoff includes run identity, changed files, commands/exit codes, omissions, decisions, risks and integration notes.

## Acceptance checks

- Full-context fixture includes system instructions, forced prompts, tool definitions/transitions, complete available tool results, custom context, compaction and images. Ordering and reference hashes are stable.
- Later context mutations and unsupported host behavior fail visibly instead of receiving a full-context label. Main request messages remain unmodified by observation.
- Wrong-model context limits and unsupported images never cause silent truncation, summarization, model substitution or extra requests.
- Reviewer invocation count is zero while disabled and at most one per user request, including low scores, fixes, malformed output, repeated settle events, reload, branch changes and provider failures.
- A low score always has precise actionable explanations. Forged references, invalid scores, duplicate IDs, prompt-injection text, truncated JSON and tool-call output are handled conservatively.
- Every returned finding requires a ledger disposition; rejected findings require evidence. New permissions are never inferred from feedback. An incomplete ledger is displayed as incomplete.
- Revised answers do not inherit an original score. No main-agent-provided score can change the authoritative badge.
- Cancellation, timeout, new input, shutdown, fork/switch and late provider results cannot write into another request/session or resume stopped work.
- Review continuations do not accidentally reset the one-call budget or conflict with the durable goal controller and other continuation extensions. User stop/pause wins.
- Native model/thinking/settings UI honors model scope and supported efforts. Narrow terminals, long findings, cancellation and non-TUI modes work.
- Mock-provider tests prove limits without paid calls. Validate TypeScript, package tests, npm pack dry-run, Markdown diff and relative links. Add host-level fixture tests where fake event handlers cannot establish ordering.
- Document real-provider and real-terminal checks as not run until explicitly authorized and executed. Do not claim reviewer calibration or a latency target from mocks.

## Documentation, integration and rollback

Follow root `AGENTS.md`: README covers purpose, installation, first use and the full-context privacy warning. TECHNICAL covers commands, settings, cost, supported hosts, score provenance, no-recheck behavior and failure modes. DEVELOPMENT holds schemas, hook ordering, state transitions, algorithms and test commands. Add the new package to the root catalog only when it exists.

No existing package or confidence rule needs migration during the design phase. Future installation/enablement needs separate approval. Rollback starts with `/confidence off` and cancellation of owned work, then removal of the package declaration only with authorization. Preserve review records unless deletion is explicitly requested.

Keep this unimplemented plan under `plans/planned/`. Archive it only after implementation, required worker/reviewer outcomes or explicit waivers, integrated checks and the HTML report are complete. `plans/archive/` is already ignored by the repository.

## Evidence and open risks

Observed against installed `@earendil-works/pi-coding-agent` version 0.87.1:

- `docs/extensions.md`: lifecycle, `context_with_system`, `agent_before_settle`, nested model calls, native UI, branch-aware persistence and cancellation guidance.
- `dist/core/extensions/types.d.ts`: context/system access, model scope, boundary messages/results, custom entry drafts and continuation contracts.
- `dist/core/extensions/runner.js`, `emitContext`: context handlers compose in order, followed by full-context handlers.
- `dist/core/agent-session.js`, `_installAgentForcedPromptProjection`, `_buildBoundaryContext`, `_runBeforeSettleBoundary`: request-local forced prompt projection differs from reconstructed settlement context.
- `dist/core/model-registry.d.ts`: authenticated provider-neutral `streamSimple`.
- `pi-ai/dist/types.d.ts`: reasoning, tool choice, output/stream options and provider retry setting.
- `docs/tui.md`, `docs/models.md`, `docs/settings.md`, `docs/compaction.md`, `docs/packages.md`, and `examples/extensions/qna.ts`: supported UI/model configuration, compaction limits and nested inference precedent.
- Repository `pi-extension-review/src/runner.ts` and `src/settings.ts`: a heavier isolated review/coverage workflow exists. Reuse conventions, not its multi-turn review policy or context-size default.

No public web research, model inference, extension execution or latency benchmark was needed or performed for this design. Repository-explorer reports were written by the native exploration tool under the installed repo-explorer skill directory.

Remaining implementation gates: exact context capture under extension composition; safe ownership of bounded main-agent investigation; score/usage rendering across modes; and independent worker/review capability. Model review quality and calibration remain empirical risks even after those gates pass.

## Design-phase completion record

- User scope and the one-review/no-recheck decision are recorded above.
- Architecture, context/privacy limits, detailed findings and critical disposition behavior are specified.
- Cost/cancellation bounds, score staleness, proposed configuration, ownership, acceptance checks and rollback are specified.
- No extension code, installation, enablement or provider calls were performed.
- Validation passed: repository Markdown `git diff --check`; a separate whitespace check for this new, untracked plan; balanced fences; nonempty sections; and checks for the approved scope, no-recheck decision and future worker/review gates. The first validation wrapper treated Git's normal no-index exit 1 for added content as failure; a follow-up confirmed there were no whitespace diagnostics.
- Design evidence was checked against installed public API declarations and relevant host source. No runtime correctness, model-quality or latency claim is verified by these document checks. The complete final plan must be reread before closing this design-only goal.
