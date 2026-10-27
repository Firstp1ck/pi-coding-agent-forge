# Development guide: Model Research for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Source and architecture

This is a separate package, not a generic Workflows preset or execution-engine dependency.

- `index.ts`: command-to-tool bridge, native selections/consent, host detection, session/project ownership, status, continuation notices, and usage reporting.
- `src/types.ts`: serializable comparison subjects, worker targets, evidence, reports, jobs, limits, and runtime contracts.
- `src/subjects.ts`: canonical subject normalization/validation, legacy fallback and inert Markdown label rendering.
- `src/validation.ts`: bounded strict identity/output/run validation, confidence/reference checks, portable skill frontmatter and fixed links.
- `src/prompts.ts`: independent research, exact reciprocal exchange, common rubric, draft synthesis.
- `src/scope.ts`: canonical overall task families, scope instructions, and final usage-table headings and choices.
- `src/engine.ts`: five-job sequencing, checkpoints, evidence-gated selection, explicit writer fallback, cancellation and expiry.
- `src/pi-runtime.ts`: fresh registry conversations with a bounded host-web-tool loop.
- `src/t3-runtime.ts`: app-owned async delegation, catalog targeting, one-read continuation, cancellation.
- `src/tool-bridge.ts`: exact/unambiguous tool discovery and bounded host results.
- `src/public-fetch.ts`: bundled concrete public HTTP(S) GET contract with DNS-pinned IPv4, redirect/response/time bounds and non-executing text extraction.
- `src/storage.ts`: owner/project/runtime-bound records, filesystem locks, immutable state and fixed export.

The DAG is research A/B → freeze both originals → review A/B → choose writer → draft. Standalone dispatch is sequential, with independent fresh contexts. T3 tasks in each wave can overlap after their asynchronous dispatch.

## Operation contract

The registered tool is `model_research`, model-only, declaring `reachesTools: "all"` so deferred host tools can connect. Research models themselves never receive that orchestration capability.

Actions are `models`, `start`, `list`, `status`, `continue`, `writer`, `cancel`, and `export`. See the entry point’s TypeBox parameters for the exact schema. A headless start example:

```json
{
  "action": "start",
  "subjects": ["gpt-6.1-sol", "claude-opus-5.5"],
  "targets": [
    { "hostingProvider": "anthropic", "model": "<exact-catalog-id>", "settings": { "thinking": "off" } },
    { "hostingProvider": "openai-codex", "model": "<exact-catalog-id>", "settings": { "thinking": "off" } }
  ],
  "confirmed": true,
  "maxTokens": 80000,
  "maxTurns": 10,
  "timeoutMs": 600000
}
```

Headless dispatch additionally requires operator-controlled `PI_MODEL_RESEARCH_ALLOW_HEADLESS=1`. Without it, start/writer/dispatching continuation is denied even with `confirmed=true`. The flag is caller-asserted authorization after that opt-in, not an independent user-approval proof. Only set `confirmed` after informed user authorization. An available native confirmation is always used even if this flag is true. Unknown model authors need `modelAuthor`; recognized families cannot be relabeled. Worker targets are selected from the current host catalog, never substituted. Comparison subjects never enter registry lookup, authentication, author inference, or `runtimeFor`; adapters receive only `run.targets`.

`task` is an optional backwards-compatible field for additional priorities, not a scope override. New runs always set immutable `scope: "overall"`; an omitted/blank task uses `OVERALL_RESEARCH_TASK`. Native setup without supplied workers starts with two `ctx.ui.input` subject dialogs, then worker selection and run-bound confirmation; it never asks for study scope. Research, review, draft prompts, and consent use the same canonical overall coverage. `start <text>` remains accepted as extra context.

`subjects` is an optional two-string tuple on `start`; each raw tool string has a 20,000-character transport cap before normalization. `normalizeSubjects(request.subjects)` or `normalizeSubjects([inputA, inputB])` returns the ordered frozen `[{key:"a",model:...},{key:"b",model:...}]` tuple passed to `createRun`. It trims outer whitespace, requires nonempty labels of at most 200 UTF-16 code units, rejects Unicode Cc/Cf controls and U+2028/U+2029 before trimming, and rejects case-insensitive duplicates using en-US lowercase. It never infers subject authors. Unknown and same-author subjects are accepted; the existing distinct worker-author rule stays in `validateTargets`.

Without `subjects`, starts with explicitly supplied `targets` preserve legacy subjects-as-workers behavior and receive no new text dialogs. Interactive starts with neither field collect subjects first. Supplying `subjects` without workers skips label inputs and opens native worker selection. Headless starts still require explicit worker targets, operator opt-in, and `confirmed: true`; optional subjects do not relax those gates. An undefined native input cancels setup, and invalid labels fail before worker selection or dispatch. No run record exists before approval, though storage bookkeeping and read-only catalog discovery may occur during setup.

Run summaries in start/status/continue/writer/cancel/export results and list entries contain `subjects: comparisonSubjects(run)` and `workers: run.targets`, while retaining `models: run.targets` for compatibility. Legacy summaries derive subjects from exact historical worker IDs without updating records. Consent separately labels complete comparison names and worker identities/settings, includes the full bounded study context and run ID, and always uses native approval when available. Explicit-subject writer dialogs select a configured research worker; they do not choose the comparison winner.

Commands queue an exact tool request through `pi.sendUserMessage` because command contexts lack `executeTool`. Both TUI and RPC use native `ctx.ui.select/input/confirm`, not custom terminal-only components.

A saved custom session entry records only the active run pointer and pending task IDs. A matching T3 child-result notification adds a reminder to reconcile through the tool. It does not itself dispatch or poll. Pending operation results request turn termination. The host/parent remains responsible for invoking continuation.

## Core contracts

`Runtime.kind` is `pi | t3`. `start(job, signal?)` and `check(job, signal?)` return either `{status:"complete",text,usage?}` or `{status:"pending",taskId}`; `cancel(job, signal?)` returns void. Constructors receive the run’s frozen target pair because jobs reference target keys a/b.

`Runtime.preflight`, when present, is invoked before the dispatch checkpoint so known incompatibilities are not labeled uncertain paid launches. Research JSON is bounded to 18,000 characters and review JSON to 10,000; identity metadata is bounded as well. Final T3 prompts, including the adapter prefix, must fit 120,000 characters. Exact originals are never truncated.

`advanceRun` saves before dispatch and after every outcome. Persisted dispatch-in-progress is uncertain, not permission to relaunch. Each continuation checks pending jobs once. Raw outputs and parsed snapshots remain separate and consistent; originals and reviews freeze before downstream prompts are formed.

New overall drafts require a final `## When to use each model` section containing only a five-column Markdown table: `Task`, `Use`, `When and why`, `Evidence / uncertainty`, and `Confidence`. Validation requires exactly one row per canonical task family, nonempty cells, an exact comparison subject label (legacy: worker model ID) or `Either`/`Neither`/`Insufficient evidence`, and integer `N/100` confidence. Research prompts request each family’s arguments or an explicit evidence gap; review prompts flag missing coverage. These checks do not establish that the recommendations are true or sufficiently specific.

Explicit-subject drafts require complete-label identity matches, not substrings of longer model names, and canonical inert Markdown spellings in Use cells. `subjectChoiceLabels(subjects)` is the source of those spellings: it escapes labels and, if either collides case-insensitively with an inconclusive option, prefixes both named choices with `Subject A:` / `Subject B:`. Bare inconclusive choices remain distinct. Inputs/reports keep their exact normalized names.

`validateSkillDraft(raw, asOfDate, identities, requireUsageSummary, workers?)` distinguishes canonical comparison tuples from legacy full worker identities. Domain callers pass `run.subjects ?? run.targets` and supply the fifth worker-context argument only for explicit subjects. Explicit Routing guidance and final-table text cannot reference unrelated worker-only model IDs; worker provenance belongs in Limits and uncertainty. Subject labels that equal or include worker IDs remain valid. This is a bounded lexical identity-consistency guard, not semantic verification of arbitrary prose or factual routing claims.

For explicit-subject research JSON, `subjects` must exactly match the canonical run tuple, in order, while `researcher` remains the exact execution-worker identity. Evidence `supportsTarget` and `subjectTargets` refer to comparison subjects a/b; researcher/reviewer keys and evidence-ID prefixes identify workers. Missing, reordered, noncanonical or substituted subjects and spoofed worker identities fail `invalid_output`. Legacy output contracts stay strict and do not acquire required subjects.

Research IDs are prefixed a-/b-. Every row references known evidence; model identities, dates, URLs, confidence, coverage and access gaps validate. This is provenance-shape validation, not a network fetch audit or factual truth check.

For explicit subjects, both reviews must return `writerRecommendation: "undetermined"` and `writerEvidenceIds: []`; the engine independently blocks automatic worker election even when subject labels equal worker IDs. `chooseWriter` records a user choice of worker key a/b. For legacy runs only, automatic selection requires both reviews to agree and each to cite qualifying model-reported skill-writing evidence; otherwise it awaits explicit choice. No automatic model-job retries, paid bakeoffs, or silent repair calls exist. Cancellation intent is distinct from per-job `cancellationAcknowledgedAt` and `cancellationError`; explicit repeated cancellation reconciles unfinished cleanup after interruption. Unknown T3 dispatches with no handle stay visibly unresolved. Abort during awaited status/dispatch processing enters independent cleanup with an explicit fresh ten-second signal: undefined would inherit the aborted owner through Pi’s nested-tool context. T3 cancellation responses must match taskId and the documented cancel acknowledgement enum before cleanup is recorded.

## Runtime boundaries

### Standalone Pi

The host’s `modelRegistry.streamSimple` resolves credentials at request time. The adapter derives native stream-option types from the SDK; Pi’s UI setting `off` is sent as undefined reasoning, never the truthy string `off`, matching Anthropic and the agent-loop contract. Calls use fresh message arrays and no parent transcript. Only known callable Brave/Web search and fetch schemas are declared on research calls. Nested tool execution uses `ctx.executeTool` so host hooks and validation remain authoritative. Expected host access/HTTP failures become error tool messages for source-gap recovery. Standalone research cannot complete without an actual successful search-tool call. Invalid-result, policy and size-limit failures remain terminal.

Reported usage counts input/output/cache tokens and model cost. The integration reports only newly incurred direct-model usage per operation, retaining the known cost total without inventing a category split; the host accounts nested web-tool usage separately. Missing provider usage and preterminal failures can limit accounting accuracy. No hard cost cap is promised.

Cancellation/timeout abort the provider and bounded host awaits. A provider or host tool that ignores abort may continue externally; no implementation can claim OS-level cancellation through that signal alone.

### Bundled public-page contract

`model_research_fetch` is a registered inactive/codemode helper with an exact `{url: string}` input and structured output containing original/final URL, access time, HTTP status/content type, extracted text, truncation and bytes. The direct conversation reaches it only through host `executeTool`, preserving permission hooks. Discovery prefers it over an optional generic `fetch_content` tool. Failure results preserve structured `errorKind` metadata across native tool wrapping; only access failures recover. Policy, limit, invalid-result or unclassified bundled-reader failures stop research.

DNS is resolved before each hop; only validated public IPv4 answers can be connected. Native HTTP(S) requests connect to the pinned address while retaining the original HTTP Host and TLS server name/certificate checks. No caller headers, cookies, authentication, arbitrary ports, assets or JavaScript are accepted. Redirects are revalidated. A bounded linear text extractor strips active/markup sections; content remains untrusted model data. Offline tests inject DNS/transport, never access the network.

### T3

T3 detection uses injected markers or orchestration tools and fails closed when its bridge is missing. The live catalog supplies the parent thread owner, provider instances, model IDs and option descriptors. Targets retain the actual instance and model; author and transport are separate.

Calls use only app-owned `orchestrator_capabilities`, `delegate_task`, `task_status`, and `task_cancel` through the host bridge. Delegation sets async mode, stable per-job `clientRequestId`, explicit provider/model/options, approval-required runtime and inherited interaction mode. No child-thread messaging or top-level thread creation is used.

T3’s injected Pi bridge can flatten both text JSON and identical structured JSON into one text block. The bounded transport decoder accepts only a complete JSON value or up to four deeply identical JSON documents; conflicting documents, prose and fences fail closed. Handle recovery uses the same decoder. This is transport compatibility, not permissive normalization of model research output.

Only the stable original `summary` of a completed `result_available` task is accepted, not `latestTerminalSummary`. Pending task IDs survive checkpoints and completion, including identity rejection after the host has returned a known child ID. No timers/watchers poll T3. Transient bridge access failures on status reads carry `retryableStatus`; the engine retains the pending task and records `statusError` for explicit later reconciliation. Terminal task states, bad identities and malformed results remain errors. Per-call token/turn/timeout limits cannot be imposed by this API; the user-facing warning must stay prominent.

Read-only child prompts and approval-required mode do not sandbox inherited tools. Native T3 permissions remain the security boundary.

## Persistence and artifacts

Schema version remains 1. Optional immutable `run.subjects` is a readonly ordered tuple of `{key:"a"|"b", model:string}`. `createRun` clones it; `validateSubjects` rejects extra fields, nontrimmed values, or invalid ordering without repairing records. `comparisonSubjects` derives legacy labels without normalization. Storage immutable-state checks reject adding, removing, reordering, or changing explicit subjects across saves. No record migration occurs.

Prompt builders accept optional subjects and separate their unverified labels from execution identities in length-labelled untrusted JSON blocks. Unknown or ambiguous labels require evidence gaps. Draft body identities and all 15 task-family choices validate against subjects, with canonical escaped Markdown labels accepted. Structural checks do not prove model existence or factual capability.

Storage namespaces are SHA-256-derived from nonsecret session/thread owner, canonical project root, and runtime. Each strict envelope repeats those identities. Never share another owner’s records by weakening validation.

Per-run exclusive filesystem lock files guard the whole read/advance/export operation. Saves require a matching live lock and atomic record replacement. Locks are not automatically stolen. Interrupted/uncertain dispatch is intentionally fail-closed.

Exports are fixed to private run storage: `draft/<validated-skill-name>/SKILL.md`, `comparison.md`, and the five fixed reference JSON files. Export preserves exact original raw reports/reviews, including explicit subject identities. Explicit-subject comparison exports have separate Compared subjects and Research workers sections and label the writer decision as a worker choice; legacy layouts remain unchanged. Subject labels are escaped as inert Markdown, including inside table cells. For new overall runs, the final validated usage section is copied from `SKILL.md` to the end of `comparison.md`, keeping one source for the synthesis. Older schema-v1 records without `scope` remain readable and resumable with the older draft validation; their export layout is unchanged so existing exports remain identical. Do not retrofit a scope marker or rewrite frozen outputs.

Existing identical output is inspectable; edited, partial, extra, or symlinked output fails closed. No arbitrary output path or active skill-discovery destination is accepted.

Generated Markdown remains untrusted. Validators do not prove that a skill is safe to activate or that no sensitive data was entered.

## Contributor validation

Install development dependencies only in an authorized development checkout. Pi supplies runtime peers; do not add a first-party dependency merely for a path helper.

```bash
npm test
npm run typecheck
npm run check
npm pack --dry-run --json
git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'
```

Tests use Node’s type stripping, fake model streams, fake T3/tool bridges, and temporary private directories. No provider credentials, external web access, installed state, or live T3 userdata is used.

Cover phase isolation/exact exchange, evidence validation/selection, partial and uncertain outcomes, task-ID retention, cancellation/expiry, auth/scope, allowlists, limits, host errors, owner/lock boundaries, symlinks/no-overwrite, export contents, native dialogs without a scope question, overall default/additional-priority coverage, complete final usage tables, legacy record/export compatibility, and notification-driven continuation.

`tests/integration.test.mjs` drives the registered operation through Pi TUI-shaped and T3 RPC-shaped contexts offline. Fixtures copy the prompt’s exact canonical subjects into research JSON, retain configured researcher/reviewer identities, and return undetermined reviews. Draft fixtures use subjects in the body and alternate subjects across all 15 usage-table choices. End-to-end checks cover label-input → worker-selection → confirmation ordering, five-worker-job dispatch, separate consent/status/list identities, explicit worker writing, persisted reload, raw references and export identity, unchanged legacy/headless authorization, old schema-v1 resume, canceled/invalid inputs, full consent text, authentication/family restrictions, and output substitutions. Dedicated domain/storage tests retain strict legacy and immutable-state coverage.

Live research is a separate opt-in acceptance check with an explicitly approved model pair and spending/usage expectations. Do not describe offline fixtures as live provider verification.
