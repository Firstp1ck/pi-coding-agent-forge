# Safety Guard for Pi

Adds confirmation and path protection around commands and edits that could cause serious damage.

![Safety guard confirmation prompt](https://unpkg.com/@firstpick/pi-extension-safety-guard/images/safety_guard_v0.1.9.png)

## What you can do

- Prompts for matched risk patterns, not simply for unfamiliar shell syntax.
- Protects important files from unexpected edits.
- Shows all detected operations and risks in one confirmation for a compound command.
- Can optionally request a second model review for risky actions.
- Saves approvals with their scope: current directory, EVERYWHERE, or the current Pi session, including reload/resume.

## Install

Install it through Pi:

```bash
pi install npm:@firstpick/pi-extension-safety-guard
```

Restart Pi if the package does not appear in your current session.

## How to use it

Safety Guard works automatically.

1. Start with the **Trigger** section. It marks the triggering snippet with `>>> ... <<<` above the full command. Then read the risks and permission scope. The prompt distinguishes operations already approved from those needing approval. In the terminal, use Page Up / Page Down to read details that do not fit on screen.
2. Choose `Allow once`, or an option that explicitly names both what to remember and for how long. A short note beneath the terminal selection list explains the highlighted option's scope and effect.
3. Choose `Block` if any operation is unclear. Nothing in that invocation runs, and no new permissions are saved.

For example, ask Pi to run `git switch -c feature/one && git branch -d old-feature`. One prompt shows both operations. `Allow the command for the current session` remembers those argument lists for later supported commands and chains in the same working directory, called cwd. Different arguments still require approval.

`Always allow the command in the current directory` remembers the same programs and arguments in the current directory. Changes to their arguments still require approval. When operations cannot be reused safely, the prompt offers only `Block` and `Allow once`.

The broader `Allow operation types this session` option appears for eligible branch creation, non-forced switching, and merged-branch deletion. It permits other simple branch names within those types. Read its warning before choosing it. `Always allow operation types here` makes that permission permanent in the current directory.

For the same exact operations across projects, choose `Always allow the command EVERYWHERE`. This saves only the pending argument lists, not all commands of that type. Read the warning under the selected option before confirming.

Approvals are saved separately from Pi's general settings:

| Choice | Location |
| --- | --- |
| This session | The current Pi session; survives reload/resume, not new or forked sessions |
| Permanently in this cwd | `<cwd>/.pi/safety-guard-allow.json` |
| Permanently EVERYWHERE | `~/.pi/agent/safety-guard-allow.json` |

Run `/safety-guard allow-list` to inspect the current session, current directory, and global approvals. `/safety-guard allow-clear-session` revokes the current session's grants durably. `/safety-guard allow-clear-permanent` clears the current directory and EVERYWHERE grants, leaving other directories untouched.

Run `/safety-guard-setup` to choose protected command groups and paths. Optional second-model review is available but remains off until you enable it.

## Before you start

No setup is required. Automatic review is off by default.

Existing directory approvals migrate when you next use that directory. The guard saves a private backup first and leaves old records intact if migration fails. Project approval files are Git-ignored and need a matching user-owned verification record; a file copied from a repository cannot grant permission on its own. Do not edit these files to add approvals. Use the prompt.

Remembered approvals skip future prompts and model review within their scope. **EVERYWHERE applies across directories permanently.** The same relative path can target different files, and executables or hooks may differ between projects. Prefer directory-scoped approval unless you intend to trust those operations everywhere. Git operations change your checkout or branches and may run hooks.

Commands without a matching enabled risk pattern run without a guard prompt. This includes routine Git checks, TypeScript checks, test logging, and diagnostic Node scripts, even when syntax analysis is unavailable. When a risk does match and individual operations cannot be analyzed, approval covers the complete command. Existing permissions are not automatically broadened.

Safety Guard is a pattern checker, not a sandbox. Scripts, imported modules, and indirect execution can hide dangerous actions from its checks. Review unfamiliar code before running it.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-safety-guard/TECHNICAL.md) for complete commands, configuration, compatibility, security, and troubleshooting information.
