# Todo Progress for Pi

See live checklist progress for multi-step work, with an opt-in controller that can keep an explicit goal moving safely across turns.

![Todo progress widget](https://unpkg.com/@firstpick/pi-extension-todo-progress/images/todo_progress_v0.1.8.png)

## What you can do

- Follow a compact checklist while Pi works through a multi-step request.
- Start a durable goal with `/goal` when you want Pi to continue unfinished work across turns.
- Inspect, pause, or resume an explicit goal with dedicated commands.
- Keep normal conversations unchanged when you do not opt in to goal execution.

## Install

Install it through Pi:

```bash
pi install npm:@firstpick/pi-extension-todo-progress
```

Restart Pi if the package does not appear in your current session.

## How to use it

For ordinary multi-step requests, ask Pi as usual. The checklist appears when work starts, updates only when progress changes, and clears after a normal final response.

For a goal that may need more than one turn:

1. Run `/goal <one-sentence goal>` or use `/goal` and enter the goal when prompted.
2. Let Pi work. The controller continues unfinished work only after Pi has fully settled.
3. Use `/goal-status` to inspect progress, `/goal-pause` to stop automatic work, or `/goal-resume` to continue a paused, blocked, or waiting goal.

Example:

```text
/goal Implement the complete plan in plans/planned/example.md and verify all acceptance checks.
```

## Before you start

`/goal` opts in to automatic follow-up turns. Use `/goal-pause` or Pi’s normal cancellation control whenever you want execution to stop. Restored running or waiting goals stay paused until you explicitly resume them.

Goal completion, blockers, and external job references are reported by the agent; the extension validates their structure and identity but cannot independently prove that the work or external job is correct.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-todo-progress/TECHNICAL.md) for complete commands, behavior, safety controls, limits, and troubleshooting information.
