# Pi Execution Adapter

Read this reference when applying the governance in `../SKILL.md` inside Pi. It is the only Pi-specific file in this skill, and it is the only place where exact model choices appear.

## 1. Mechanics ownership

The installed `pi-subagents` skill is canonical for Pi delegation mechanics: the `subagent` tool schema, action names, execution and context modes, chain and parallel authoring, agent management, settings, artifacts, and error handling. Read it for **how** to launch, monitor, and wait.

This skill is canonical for **admissibility**: whether a shape may be launched, who may write, what a worker is told, what a handoff must return, when a replacement is legal, and how a finding is dispositioned. When both are loaded, mechanics questions resolve to `pi-subagents` and admissibility questions resolve here. Neither file overrides the other, and this adapter never restates the `pi-subagents` API.

Pi's active prompt policies and runtime enforcement extensions remain separate controls. A model-invoked skill does not replace them and does not claim their guarantees.

## 2. Discovery and launch posture

1. Call the discovery action before execution and use only executable, non-disabled agents or chains it returns. Do not launch from remembered role names.
2. Launch through the native `subagent(...)` tool. Never spawn children through `bash`, nested `pi -p` invocations, detached processes, or hand-managed session files.
3. Pi execution-mode aliases `single`, `parallel`, and `tasks`, workflow scripts, and schedules may launch one or multiple justified children. Apply the same role-fit, plan, isolation, and retry rules regardless of execution mode; cardinality is not an admissibility gate.
4. Prefer `async: true` so runs stay trackable in the Pi UI, and give each run a clear `phase`, `label`, and role-specific task. For plan-governed work, include the workstream ID and the expected handoff artifact path.
5. Prefer fresh context plus explicit plan and file references over hidden parent history. Forked context is a branched thread that inherits parent history, not a filtered review context.
6. Monitor with the status action and block with `subagent_wait()` only when the current request must run to completion, or when a headless turn must receive results before it ends. Never substitute sleep or status-polling loops for lifecycle tracking.
7. Ordinary Pi children do not receive the `subagent` tool or the `pi-subagents` skill. Only an explicitly assigned fanout child may delegate, and only for its assigned work.

### Specialist role mapping

Use these names only when live discovery reports them executable and non-disabled:

| Necessary outcome | Pi role |
| --- | --- |
| Local code, configuration, convention, or repository reconnaissance | `scout` |
| Bounded requirements, interface, validation, or handoff context | `context-builder` |
| Implementation design, sequencing, migration, or dependency planning | `planner` |
| Current external evidence or authoritative documentation | `researcher` |
| Challenge inherited direction, architecture, or drift | `oracle` or its compatibility alias `advisor` |
| Bounded generic independent outcome with no better specialist | `delegate` |
| Approved implementation inside assigned ownership | `worker` |
| Independent critique of an inspectable target | `reviewer` |

`oracle` and `advisor` are one advisory capability. Launch both only when they have distinct, necessary advisory outcomes; aliases alone do not create separate value.

## 3. Local model defaults

These are **Pi-local defaults for this workstation**, not portable policy. They are volatile, and they are subordinate to live runtime availability, the configured model scope, agent overrides, and any explicit user choice. Verify the live mapping before relying on them, and drop any entry the runtime does not currently offer.

| Slot | Local default | Notes |
| --- | --- | --- |
| Implementation worker | `openai-codex/gpt-5.6-sol` with high thinking | Unless the task or the user requires another provider. |
| Fix worker | `openai-codex/gpt-5.6-sol` with high thinking | Or the implementation provider already selected for the feature. |
| Tests and acceptance reviewer | Most capable available review model, preferring the `openai-codex` provider | Select from the live model registry rather than pinning a model ID. Use high or greater thinking when supported. |
| Feature correctness reviewers | Most capable available review models from the required distinct provider families | Prefer `openai-codex` for the primary reviewer when compatible with the feature provider-diversity requirement. Use high or greater thinking when supported. |

Provider route preference: when a usable OpenAI Codex or Anthropic subscription is detected, prefer its subscription-backed provider route over the OpenRouter API for subagents. Use OpenRouter only when the matching subscription route is unavailable, unsuitable for the task, exhausted, or explicitly requested by the user.

A model choice never changes admissibility. An unavailable default is a provider problem to solve with an eligible fallback; it is not a reason to duplicate a live child, broaden a task, or lower an independent gate.

## 4. Isolation in Pi

- One writer per cwd or worktree. Isolated worktree fanout requires a clean tree; a dirty repository runs sequentially in the shared tree unless the user approves cleaning it.
- Background execution is not permission for parallel writes. While an async writer runs, the parent reads, prepares validation, or inspects unaffected context instead of editing the same tree.
- Give concurrent children distinct output paths so artifacts never collide.

## 5. Retry helpers in Pi

- Prefer the generic bounded-retry or success-quorum gate tool when it is available for read-only retries and quorum workflows, and set each task's `retrySafety` honestly. An omitted value defaults to `may-write` and disables automatic post-launch retry.
- Inspect structured status, fleet views, and run artifacts rather than scraping terminal output when classifying a failure.
- Use a recovery action for a failed persisted run instead of a fresh duplicate launch when the run can be recovered.
- Apply the live-child deduplication rule in `RETRY-AND-RECOVERY.md` before every replacement payload, including after a call-level failure.

## 6. Escalation

A child that meets an unapproved product, architecture, scope, or safety decision uses `contact_supervisor` and waits for the reply. Generic `intercom` is a fallback only when the bridge-provided supervisor tool is unavailable. A child never resolves such a decision by itself, and the parent never delegates the decision back to the child.

## 7. Package lifecycle

This package is not installed or enabled by its creation. Installing it, enabling it, publishing it, or changing Pi settings requires separate explicit user approval. A later approved local installation may use `pi install <absolute-path-to-package>`.
