# Safety Guard for Pi

Adds confirmation and path protection around commands and edits that could cause serious damage.

![Safety guard confirmation prompt](https://unpkg.com/@firstpick/pi-extension-safety-guard/images/safety_guard_v0.1.9.png)

## What you can do

- Recognizes commands that can delete data or rewrite history.
- Protects important files from unexpected edits.
- Shows all detected operations and risks in one confirmation for a compound command.
- Can optionally request a second model review for risky actions.
- Remembers exact commands, exact operations, or constrained Git operation types for a session or permanently.

## Install

Install it through Pi:

```bash
pi install npm:@firstpick/pi-extension-safety-guard
```

Restart Pi if the package does not appear in your current session.

## How to use it

Safety Guard works automatically.

1. Read the complete command and its listed operations. The prompt distinguishes operations already approved from those needing approval.
2. Choose `Allow once`, or an option that explicitly names both what to remember and for how long.
3. Choose `Block` if any operation is unclear. Nothing in that invocation runs, and no new permissions are saved.

For example, ask Pi to run `git switch -c feature/one && git branch -d old-feature`. One prompt shows both operations. `Allow listed exact operations for this session` remembers those argument lists for later supported commands and chains in the same working directory, called cwd. Different arguments still require approval.

The broader `Allow listed operation types for this session` option covers new simple branch names for the eligible types shown in the prompt. These types are branch creation, non-forced switching, and merged-branch deletion. Read their scope warnings before choosing this option. The corresponding `Always allow ... in this cwd` options persist across sessions.

`Always allow this exact command in this cwd` remains available when you want to remember only the complete original input, not its individual operations.

Run `/safety-guard allow-list` to inspect remembered permissions or `/safety-guard allow-clear-permanent` to remove all permanent permissions.

Run `/safety-guard-setup` to choose protected command groups and paths. Optional second-model review is available but remains off until you enable it.

## Before you start

No setup is required. Automatic review is off by default.

Remembered approvals skip future prompts and model review within their scope. Git operations change your checkout or branches and may run hooks. Only grant repeat permission in a repository you trust.

Unsupported shell syntax requires whole-command approval, so commands with substitutions, redirections, wrappers, or directory changes may prompt more often. Pipelines containing matched SQL also need whole-command approval, including the receiving command. Existing permissions are not automatically broadened. Safety Guard checks command syntax and known risks; it is not a sandbox.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-safety-guard/TECHNICAL.md) for complete commands, configuration, compatibility, security, and troubleshooting information.
