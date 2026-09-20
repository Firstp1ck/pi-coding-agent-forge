# Technical reference: Todo Progress for Pi

Advanced user behavior, controls, limits, safety, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Checklist behavior

The extension asks Pi to state a concise goal before beginning multi-step work and to publish short Markdown checklists with these markers:

- `- [ ]` — not started
- `- [-]` — in progress
- `- [x]` — complete

The widget shows up to five rows. It keeps the current list through tool-use, aborted, failed, and length-limited endings so work can be recovered. A normal final response or a newly delivered ordinary user request clears stale display state. After compaction, one complete checklist may replace the previous list.

Checklist tracking is available in ordinary chat and does not enable automatic continuation by itself.

## Explicit goals

`/goal` is an opt-in execution mode. It keeps the submitted goal separate from the temporary checklist and requires Pi to record a checkpoint before ending each goal run. Goal text is limited to 100,000 characters after whitespace normalization; larger submissions are rejected before starting.

A checkpoint can report that work should continue, has completed, is blocked, or is waiting for a native background notification. Completed goals stop automatic follow-ups. Blocked, waiting, paused, cancelled, and terminally failed goals do not continue automatically.

A goal queued while Pi is busy does not affect the active turn. It becomes active only when its uniquely identified kickoff message is actually delivered. Pausing a queued goal cancels that kickoff and removes its instruction from model context without clearing or aborting unrelated Pi messages.

Each low-level Pi run receives a fresh run identity. `/goal-status` shows the goal, controller state, goal and run identities, retry counters, latest checkpoint summary, last stop reason, and available pause or blocker detail.

## Commands

- `/goal <goal>` — submit an explicit goal. If Pi is busy, queue it as a follow-up.
- `/goal` — open an interactive prompt for the goal. In headless modes, supply the goal as an argument.
- `/goal-status` — show current goal state, identities, counters, checkpoint, and failure or blocker details.
- `/goal-pause` — pause the active goal, request cancellation of its active work, and prevent queued goal requests from activating.
- `/goal-resume` — resume a paused, blocked, or waiting goal when Pi is idle and has no pending messages.
- `/todo-progress-status` — show whether the extension is loaded and whether a checklist or goal is present.

## Shortcuts

- `Ctrl+Alt+X` — hide the current checklist. This does not erase an active explicit goal.
- `Ctrl+Alt+J` / `Ctrl+Alt+K` — scroll the checklist down or up.

## Continuation and recovery rules

Automatic continuation waits for Pi’s settled boundary, after native retries, recovery compaction, and queued follow-ups have had their turn. Pending user messages suppress an extra goal follow-up.

The controller pauses automatically after either limit is reached:

- 3 consecutive runs with no new observable checklist or successful tool progress;
- 20 automatic continuations in one explicit start or resume cycle.

Repeated identical tool results do not repeatedly count as progress. Explicit `/goal-resume` starts a fresh bounded continuation cycle while preserving the durable goal.

Reloading a session, restoring a branch, or navigating the session tree pauses goals that were running or waiting. Completed and blocked goals keep their terminal state. Run `/goal-resume` after inspecting unfinished work. During an uninterrupted session, a native custom notification can wake a waiting goal for reassessment; the controller does not poll.

## Safety and limitations

- Pi’s normal cancellation and `/goal-pause` take precedence over late assistant, tool, or notification events.
- Provider errors and response truncation are allowed to use Pi’s native retry or compaction recovery first. A final failed or truncated settled outcome pauses the goal.
- Goal completion, plan coverage, verification evidence, blocker truth, and job identity are agent attestations. The extension checks required fields and exact goal/run identities but does not prove the underlying claims.
- A waiting checkpoint records a job or receipt reference, but generic custom notifications are not independently verified against a background-job registry. Treat the resulting wake as a request to reassess, not proof that the named job succeeded.
- Successful tool activity is a conservative progress signal, not proof that the goal advanced semantically.
- The extension does not poll, sleep, create a scheduler, restrict tools, or bypass normal approvals.

## Persistence and privacy

Checklist and explicit goal state are stored in the current Pi session. Goal text, status summaries, evidence, blocker details, and job references can therefore remain in session history. Do not put secrets in a goal or checkpoint.

State follows the active session branch. Old checklist-only sessions remain readable and do not become explicit goals automatically.

## Troubleshooting

- **A restored goal does not restart:** This is expected. Check `/goal-status`, then run `/goal-resume` when Pi is idle and pending messages are clear.
- **Resume says to wait:** Let the active run and queued messages settle before trying again.
- **A goal paused after repeated turns:** Check whether the no-progress or 20-continuation limit was reached. Inspect the remaining work before resuming.
- **A waiting goal did not wake:** Confirm that the native job mechanism emitted a Pi notification, or use `/goal-resume` to reassess manually. The extension does not poll external work.
- **A queued goal was paused before delivery:** Its canceled kickoff is removed from model context and does not activate the controller. Unrelated queued messages remain untouched.
- **The checklist remains visible after interruption:** This preserves recovery context. Hide it with `Ctrl+Alt+X` or continue with a new request.
- **Startup failed but the goal still says running:** Pi's asynchronous prompt API cannot report every startup failure back to the controller. Resolve the reported provider or startup error, then use `/goal-pause` and `/goal-resume`.
