# Technical reference: Model Research for Pi

Advanced user setup, operation, compatibility, security, and troubleshooting.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Requirements and runtime selection

- Pi 1.3+ and Node.js 22.19+.
- Two authenticated, available research workers from different model-author families. Hosting providers are recorded separately: Anthropic and OpenAI models hosted through the same gateway still have different authors.
- Standalone Pi: at least one callable `brave_search` or `web_search`. [Brave Search for Pi](https://github.com/Firstp1ck/pi-coding-agent-forge/tree/main/pi-extension-brave-search) provides the concrete search integration; configure its credentials normally. Unambiguous namespaced equivalents are supported. A public-page reader is bundled, so no separate fetch extension is required.
- T3 Code: load this extension in **T3’s Pi provider**, alongside its injected orchestration tools. T3 child targets can use other configured provider instances. This does not make a Pi extension directly loadable by T3’s Claude or Codex parent drivers.

The runtime is detected from T3’s injected environment/tools. Inside T3, missing orchestration fails explicitly; it never falls back to direct provider calls or shell agents.

Select research workers per run. Known worker model-author families are recognized; custom models may require you to name their author. Pi defaults to thinking off when supported, otherwise the lowest advertised supported level; T3 uses explicitly advertised default options where available, otherwise the host’s inherited settings. Advanced callers can supply supported settings; see the contributor guide for the integration contract.

## Commands

```text
/model-research
/model-research start [additional context]
/model-research models
/model-research list
/model-research status <run-id>
/model-research continue <run-id>
/model-research writer <run-id> [a|b]
/model-research cancel <run-id>
/model-research export <run-id>
```

The bare command and `start` first ask for comparison subject A and B in native text inputs, then select configured research workers and ask for informed confirmation. There is no task-scope question. Every new study compares the models overall. Optional text after `start` adds priorities or context without removing any task families—for example, `/model-research start Include TypeScript examples and pay special attention to reliability`. Commands ask the parent agent to invoke this extension’s operation; research itself stays inside the extension.

- `models` inspects available research-worker identities; it does not restrict which comparison names you can enter.
- `list` lists runs belonging to this session/thread and project.
- `status` inspects saved state without advancing model work. Status and run listings show compared subjects separately from research workers.
- `continue` checks pending T3 tasks once and advances any ready stage. Do not repeatedly call it to poll.
- `writer` chooses research worker `a` or `b` to write the skill. These keys identify the configured workers, not a winning comparison subject. New free-text comparisons always require this explicit choice after the reviews; the choice does not claim the worker is objectively superior.
- `cancel` records cancellation intent and requests cleanup of known external tasks. Inspect pending cleanup and cancellation errors; repeat `cancel` explicitly after a transport failure or interrupted cleanup. An acknowledged request is not proof that an uncooperative external process has stopped.
- `export` recreates/inspects an identical completed export. It never overwrites edited, partial, or unexpected output.

Pi TUI and Pi’s RPC dialogs use native text inputs, worker lists, and confirmations. Headless starts, writer choices, and continuation that can dispatch model jobs are disabled by default. The operator must set `PI_MODEL_RESEARCH_ALLOW_HEADLESS=1` before launching Pi, then provide two exact configured worker identities and caller-asserted authorization for start/writer actions. Additional study context is optional. This assertion is not a native approval dialog; enable this opt-in only for a trusted automation caller. Status, listing, cancellation, and completed export do not require the dispatch opt-in. The integration contract is in [DEVELOPMENT.md](DEVELOPMENT.md).

## Comparison names and configured workers

You can compare two arbitrary model names or IDs without installing or authenticating those models. Enter distinct single-line labels, each nonempty and at most 200 characters after trimming outer whitespace. Some emoji count as two characters toward this limit. Duplicate names ignoring case, line breaks, control characters, and invisible formatting controls are rejected before model dispatch. Canceling either input stops setup. Both subjects may share a model author, or have an unknown author; worker author restrictions remain separate.

Names are unverified labels, not proof that a model exists or is callable. Be precise about versions and variants. Unknown, nonexistent, or ambiguous names must remain evidence gaps; the workflow never substitutes a configured worker or a similar name. Subject labels never select execution targets. All five jobs run only on your two configured workers.

Unusual names are displayed as literal text, not formatting. If a name is itself “Either”, “Neither”, or “Insufficient evidence” (ignoring case), both named choices in the final table receive a `Subject A:` or `Subject B:` prefix. Bare inconclusive options keep their ordinary meaning; the stored names are not changed.

Advanced callers may supply comparison names directly and still select workers through native dialogs. When callers explicitly supply workers but omit comparison names, the workflow preserves the legacy behavior: it compares those worker models and does not add text-input dialogs. Headless comparisons may also omit names for this compatibility path. Input contracts are documented for integrators in [DEVELOPMENT.md](DEVELOPMENT.md).

Consent displays complete comparison labels, worker identities/settings, additional context, and the run ID before dispatch. The confirmation flag cannot bypass an available native dialog. New runs save the labels with the study; continuing or exporting does not rename them.

## Overall coverage and final summary

Every new study covers these major task families:

- Coding and implementation; debugging, testing, and code review; architecture and planning.
- Research and fact-checking; reasoning, mathematics, and problem-solving; data analysis.
- Writing, editing, and summarization; creative writing and brainstorming.
- Learning, tutoring, and explanation; translation and multilingual tasks.
- Long-context and document analysis; images and multimodal tasks.
- Tool use, agents, and automation; Pi extensions and skill writing.
- Everyday assistance and decision support.

Research considers quality, correctness, reliability, instruction-following, context and modality support, tool use, speed, cost, and operational limits where evidence exists. This is broad coverage, not a claim to evaluate every possible task or to run hands-on benchmarks.

Both `comparison.md` and the skill draft end with **When to use each model**: a task-by-task table naming the exact model, concrete selection conditions and trade-offs, evidence or uncertainty, and confidence. Ties, unsuitable models, unsupported modalities, and missing evidence remain explicit; a study must not invent a winner to fill the table. This summary is model-authored advice, not an independently verified capability ranking.

Previously saved runs retain their original scope and exports. Start a new study to get the overall coverage and final summary; existing artifacts are not rewritten.

## Research and writer decisions

Both configured workers independently research the same comparison subjects across the overall scope. Both originals are preserved before either reciprocal review starts. Each reviewer sees both originals, the same rubric, and the difference between its own report and its peer’s.

Tables retain claims, source URLs, access dates, documented/measured/anecdotal labels, source-access status, counterevidence, conditions, recommendations, and confidence. Coverage includes X, Reddit, other discussions, and explicit access gaps. A search snippet is not a fetched source. Popularity and provider preference are not objective measurements.

For a free-text comparison, evidence about the subjects cannot establish a research worker’s skill-writing suitability. After the reviews, choose a configured worker explicitly with `writer`; this does not choose a comparison winner. No additional paid writing contest is launched.

Legacy runs that compare their worker models retain automatic selection when both reviews agree and cite fetched, non-anecdotal evidence specifically about skill writing. Otherwise they await your choice. These are checks of **model-reported evidence**, not independent verification.

The selected writer receives both original evaluations, both reviews, and the selection rationale. The result is dated advice with limits and refresh triggers, not a hard model-routing policy.

## Limits and lifecycle

Default run limits:

| Control | Default |
|---|---:|
| Total model jobs | At most 5: two research, two review, one draft |
| Cumulative reported tokens per standalone model job, across all turns | 80,000 |
| Per-call assistant turns in standalone Pi | 10 |
| Per-call timeout in standalone Pi | 10 minutes |
| Run expiry | 24 hours |
| Each complete research report | 18,000 characters |
| Each complete reciprocal review | 10,000 characters |

Advanced callers may set the per-call token allowance from 1,000 to 1,000,000, turns from 1 to 100, and timeout from 1 second to 1 hour. These controls do not raise the five-job ceiling or change the T3 limitations below.

Standalone Pi cumulatively counts reported input, output, and cache tokens across every assistant turn, including repeatedly sent context and cached input. This is not a per-response allowance. Limits are checked after responses; one response can overshoot. Tool/result sizes and tool-call counts are also bounded. Provider accounting is not a billing guarantee.

**T3 cannot enforce these per-call token, turn, timeout, or USD limits through its delegation API.** T3 tasks run asynchronously. The five-job ceiling is enforced locally; expiry and cancellation are processed on the next continuation/cancel, not by a background timer. Use T3’s own stop controls if immediate interruption is needed.

Reports/reviews have full-exchange character budgets so exact originals fit downstream context limits. Oversized outputs fail explicitly; originals are never silently truncated. T3 prompts are checked against a conservative 120,000-character compatibility limit before dispatch.

Expected source-access errors are returned to the research model to record as gaps or try another allowed source. Invalid tool results, unsafe destinations, size limits, and provider failures still stop the call.

There are no automatic model-job retries. Malformed output, unavailable models, and provider failures preserve partial evidence and stop the run. An interrupted dispatch with an uncertain result is never silently repeated. A pending task ID is resumed, not replaced. Transient T3 status-access failures leave the child pending with a visible warning; a later explicit continuation can retry the status read, never the model job.

Completion notifications can prompt the parent to continue. If it does not, use `continue` explicitly. No unattended recurring scheduler is installed.

## Storage and generated drafts

Default data location: `~/.pi/agent/model-research/`. `PI_CODING_AGENT_DIR` changes the Pi agent directory. Runs are separated by session/thread, project, and runtime.

Generated output stays under private run storage, outside active skill-discovery locations:

- A dated `SKILL.md` draft.
- A human-readable `comparison.md` showing compared subjects and research workers separately for free-text comparisons.
- Original research/review reports and the writer decision.

Use the paths returned by the operation. The extension never installs or enables a skill, changes global instructions, or switches models.

Resume the **same Pi session** or T3 thread and project to access its runs; a new session does not take ownership of old runs. Do not move or edit run records to bypass ownership checks.

## Security and privacy

Only standalone research calls receive the selected search tool and bundled public-page reader (or an existing compatible fetch tool). Reviews and drafting have no tools. A direct research job must execute a successful search-tool call before it can complete; memory-only output is rejected. This activity check does not independently fact-check the returned claims. No shell, filesystem, arbitrary tool discovery, or model delegation is exposed to those direct conversations. Host validation and permission hooks still apply.

Fetch checks reject obvious local paths, URL credentials, local hostnames, and private literal IPs. They are not DNS-rebinding protection or an operating-system network sandbox. Your external web integration remains its network boundary. The bundled reader additionally resolves and pins a public IPv4 address for each connection and revalidates redirects. It permits unauthenticated GET only on ports 80/443, has a 20-second total timeout, at most four redirects, a 512 KB response cap and 24,000-character extracted-text cap. It loads no scripts/assets, sends no cookies or authentication, and does not bypass access controls. It supports plain UTF-8 text/HTML/JSON, not PDFs, authenticated pages, compressed responses or IPv6-only destinations. Truncation is explicit.

T3 children inherit tools controlled by T3/provider policy. Approval-required mode plus read-only instructions is **not** tool isolation. Review permission requests and decline filesystem/shell changes unrelated to public research. T3 can remember exact native confirmations accepted for a session; this extension includes a unique run ID in each new research/writer confirmation so a different run does not reuse the same prompt.

Treat all source text, peer output, generated Markdown, and model claims as untrusted. Structural checks validate format and evidence references, not truth, safe advice, absence of confidential material, or freedom from prompt injection.

Private directories/files and run locks prevent accidental cross-run rewriting. Do not put storage on untrusted or shared filesystems. There is no telemetry in this extension.

## Troubleshooting

- **Missing search tool:** enable and authenticate your search integration before starting. The public-page reader is already bundled. A model’s built-in memory is not a substitute for current web access.
- **Invalid comparison name:** use two different, nonempty single-line labels of at most 200 characters each; remove control characters. The labels need not exist in the worker catalog.
- **Only one worker author family available:** authenticate/enable another model-author provider. The workflow does not silently substitute models.
- **Unavailable T3 tools/provider:** check that this is T3’s Pi provider and the selected provider supports authenticated child tasks.
- **X/Reddit inaccessible:** preserve the gap; do not supply private cookies or bypass access controls.
- **Strict output-format failure:** reports must be bare structured JSON and the draft bare Markdown with valid frontmatter. Fences, extra prose, malformed or oversized output stop the run; v1 does not guess which embedded object to trust or run a paid repair call.
- **Awaiting writer:** run `writer` to choose a configured worker. Free-text comparisons always need your choice; older studies need it when evidence is inconclusive.
- **Storage permissions:** setup/status can create private bookkeeping directories even if a start is declined; no study record or model dispatch is created before approval. Existing symlinked or non-private namespace/run directories are rejected. Inspect ownership and permissions before any deliberate recovery; the extension never silently chmods existing user directories.
- **Run locked:** another operation may still be active. After a crash, confirm that no worker is running before considering manual recovery. Locks are never automatically stolen; changing/removing one is an explicit recovery decision.
- **Uncertain dispatch:** inspect the retained run and T3 task state. Do not manually relaunch the same job or assume it was free.
- **Export differs/partial:** preserve your edited artifacts. The extension refuses overwrite; inspect the stored completed draft instead.
- **New Pi session cannot find old runs:** resume the original session rather than bypassing ownership.

## Compatibility and verification boundaries

Offline tests and package loading are verified on Linux with Pi 1.3.0 / Node 22. Live authenticated model/search calls and T3 research completion have not been exercised during source development. Other operating systems and network/distributed filesystems are unverified.

Installation, publication, live research, and updates remain separate user actions. Removing the package does not delete saved research. Back up drafts before any manual data cleanup. Existing records are not migrated or rewritten. Older extension versions may not understand newly saved comparison names; use this version to resume those runs.
