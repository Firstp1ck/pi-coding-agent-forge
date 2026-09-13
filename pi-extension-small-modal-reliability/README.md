# Small Model Reliability for Pi

Adds bounded evidence, scope, verification, and recovery controls so a smaller model can work through a task without treating its own claims as proof.

## What you can do

- Keep a durable task, plan, scratchpad, evidence pack, and verification status.
- Require a bounded scope and native confirmation before a write, shell command, or approved side effect.
- Record cited retrieval evidence, coding-review requirements, and structured-output checks.
- Keep plan phases in one session, with protected Markdown handoffs and validated checkpoints.
- Use deliberately configured automatic advice, or manually confirm exact-model orchestration and evaluation.

## Install

```bash
pi install npm:@firstpick/pi-extension-small-modal-reliability
```

This source worktree is unreleased until a package version is published; the command installs the published package matching its version.

## How to use it

Start with a goal, inspect the task, then let Pi propose bounded work:

```text
/reliability on Investigate the failing parser test without changing files yet.
/reliability status
/reliability evidence status
/reliability verify
```

For a change, ask Pi to inspect first and establish a narrow scope. A scope request does **not** authorize writes, shell commands, or network effects. Review the proposed scope and use Pi's native confirmation only for the exact scope or effect you intend to allow. Use `/reliability approval status` to inspect pending one-time approvals.

Ordinary prompts and queued corrections need a separate native confirmation before consequential work continues. Use `/reliability input confirm` to review the exact proposed instruction; canceling leaves work paused. After a reload, supply the instruction again with `/reliability input confirm <exact text>`. Confirmation creates a new instruction. It does not certify earlier message delivery.

Start a retained-session plan workflow with `/reliability --mode plan-on <goal>`. Ask Pi to maintain its named Markdown handoffs through the reliability controls, not by editing protected task files.

Useful controls include `/reliability checkpoint status`, `/reliability gate final`, `/reliability tasks`, and `/reliability off`.

## Before you start

Reliability is off by default. Task artifacts can contain your prompt, paths, evidence excerpts, and redacted tool summaries. They are stored locally under `.pi/tasks/`; new task storage gets a task-local Git exclusion, but this is not encryption. Redaction is pattern-limited best effort, not a guarantee that artifacts are secret-free. Keep project access appropriate and do not put credentials in prompts or evidence.

These are Pi-tool controls, not an operating-system sandbox. A shell command can access anything your account permits; approve only commands and code you trust.

For a checkpoint durability pause, `/reliability checkpoint recover <CP-id>` can check an eligible live failure before any context transformation. Reloaded or provider-uncertain recovery remains blocked; task resume is not an unfreeze control.

Checkpoints are validated handoffs only: this Pi host cannot replace or compress the active conversation. Automatic advisor calls are possible only after you deliberately configure an exact authenticated model, the `diagnostic-summary` data scope, and positive call, token, and cost budgets in trusted project configuration. Manual separate-model orchestration and live evaluation always show their exact-model data disclosure for native confirmation. Neither advice nor evaluation grants permission or proves completion.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for commands, configuration, storage, compatibility, safety controls, and limits.
