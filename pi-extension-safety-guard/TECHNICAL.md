# Technical reference: Safety Guard for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

Interactive safety prompts for high-risk operations in Pi.

![Safety guard confirmation prompt](https://unpkg.com/@firstpick/pi-extension-safety-guard/images/safety_guard_v0.1.9.png)

## What it does

- Intercepts risky `bash` commands and requires confirmation.
- Intercepts `write`/`edit` on protected paths and requires confirmation.
- In non-interactive mode, blocks risky operations with explicit reasons.
- Has persistent setup through `/safety-guard-setup`, including per-category toggles and independent preview lines before/after matches.
- Optionally auto-reviews matched calls with one authenticated Pi model and supported thinking level; this is off by default.
- Can be toggled globally with `/safety-guard on|off|status`.
- Supports session or permanent approvals per cwd for whole exact commands, listed exact operations, and constrained Git operation types.
- Shows all recognized operations in one bash prompt and requires whole-command approval for unsupported syntax.

## Guarded command categories

### Git destruction / history rewriting

Examples:

- `git reset --hard`
- `git reset --soft`, `git reset --mixed`, `git reset --merge`, `git reset --keep`
- `git reset HEAD~...`, `git reset HEAD^...`, `git reset <commit>`
- `git clean -f`, including `git clean -fd` / `git clean -xdf`
- `git checkout -- <path>`, `git switch ...`, and `git restore ...`
- `git branch -d/-D`, `git tag -d`
- `git push --force`, `git push --force-with-lease`
- `git push --delete`, `git push :refs/heads/...`
- `git rebase`, including interactive rebases
- `git commit --amend`, `git commit --fixup`, `git commit --squash`
- `git filter-branch`, `git filter-repo`
- `git replace`, `git update-ref`
- `git notes remove`, `git notes prune`
- `git reflog expire`, `git gc --prune`, `git prune`

### Filesystem deletion / overwrite

Examples:

- recursive or force `rm`
- `rm` targeting `/`, `~`, `$HOME`, `.`, or globs
- `find ... -delete`
- `find ... -exec rm ...`
- `xargs ... rm`
- `truncate -s 0`
- `shred`
- `dd`
- `mkfs`, `wipefs`, `parted`, `fdisk`, `sfdisk`, `sgdisk`

### Docker / Podman destruction

Examples:

- `docker rm`, `docker rmi`
- `docker volume rm`, `docker volume prune`
- `docker system prune`
- `docker compose down -v` / `--volumes`
- `docker-compose down -v` / `--volumes`
- `podman rm`, `podman rmi`, `podman system prune`

### Package removal

Examples:

- `npm uninstall/remove/rm/prune`
- `pnpm remove/prune`
- `yarn remove/autoclean`
- `bun remove`
- `pip uninstall`, `uv remove`, `cargo remove`
- `pacman -R`, `paru -R`, `yay -R`
- `apt remove/purge/autoremove`, `dnf remove`

### System state / permissions

Examples:

- `sudo`
- `shutdown`, `reboot`, `poweroff`
- `systemctl stop/disable/mask/restart`
- `killall`, `pkill`, `kill -9`
- `mount`, `umount`, `swapon`, `swapoff`
- recursive `chmod` / `chown`
- `chmod 777`
- `setfacl`
- common fork-bomb signature

### Dangerous SQL

Examples:

- `DROP DATABASE`, `DROP SCHEMA`
- `DROP TABLE`, `DROP INDEX`
- `TRUNCATE` / `TRUNCATE TABLE`
- `DELETE FROM ...` without `WHERE`
- `UPDATE ... SET ...` without `WHERE`
- `ALTER TABLE ... DROP COLUMN/CONSTRAINT`

SQL checks include literal command arguments and, for whole-command fallback, original text including heredoc bodies. Database client calls like `psql <<SQL ... SQL` can still be guarded. Standalone SQL text printed by `echo` or `printf` is not treated as execution, but piped output may be executed by its receiver.

A pipeline containing matched SQL, such as `echo 'DROP TABLE sample;' | psql`, requires approval for the complete command. Existing exact-operation approvals do not bypass this check, and new reusable operation approvals are not offered. A whole-command approval remains exact, so changing the receiver requires approval again. This conservative rule also prompts when SQL is piped into a harmless receiver such as `cat`; the guard does not prove what receivers do.

### Secret file access

Examples of commands that may reveal or copy secrets are prompted when targeting sensitive files:

- `cat`, `grep`, `rg`, `awk`, `sed`, `cp`
- `.env`, `.env.*`, `.git-credentials`, `auth.json`
- `id_rsa`, `id_ed25519`
- `.npmrc`, `.pypirc`, `.netrc`
- `.aws/credentials`, `.aws/config`, `.kube/config`
- `.config/gh/hosts.yml`, `.config/gcloud/...`
- `*.pem`, `*.key`, `*.p12`, `*.kdbx`

## Protected paths

`write` and `edit` prompts are triggered for sensitive paths including:

- `.ssh/`
- `.git-credentials`
- `auth.json`
- `id_rsa`, `id_ed25519`, and matching `.pub` files
- `.env`, `.env.*`, `.envrc`
- `.npmrc`, `.pypirc`, `.netrc`
- `.kube/config`
- `.aws/credentials`, `.aws/config`
- `.config/gh/hosts.yml`
- `.config/gcloud/`
- `*.pem`, `*.key`, `*.p12`, `*.kdbx`

## Install

```bash
pi install npm:@firstpick/pi-extension-safety-guard
```

## Configuration

No configuration is required. Run `/safety-guard-setup` to edit all persistent guard settings:

- master enabled state
- Git, filesystem, Docker/Podman, package, system, database, and secret-access command categories
- protected-path `write` and `edit` guards
- command-preview lines before and after each matched line (`0`-`20`, default `3` each)
- optional auto-review enablement, authenticated model, and model-supported thinking level

Auto-review defaults off. When enabled, one verdict covers the complete bash invocation and all its pending risk reasons. An allow verdict proceeds without a popup and never creates remembered permissions; a block verdict stops the tool and emits a notification. Bash input longer than 4,096 characters skips automatic review because the reviewer would not receive its complete text. Missing models or authentication, timeouts, provider failures, and invalid verdicts fall back to the existing confirmation prompt. In non-interactive mode that existing fallback remains fail-closed.

While a review is awaited, the TUI/RPC surface shows a non-modal status and widget indicator. Overlapping reviews are counted independently, and successful allows are quiet after the indicator clears.

Settings are stored globally in:

```text
~/.pi/agent/safety-guard.json
```

Set `PI_SAFETY_GUARD_CONFIG_FILE` to override that path. Invalid configuration fails safe: every guard is enabled with default context limits and auto-review disabled. The additive auto-review fields retain config version `1`; older version-1 files normalize to the disabled default without rewriting or deleting existing settings.

The persisted auto-review shape is:

```json
{
  "autoReview": {
    "enabled": false,
    "model": {
      "provider": "",
      "modelId": "",
      "thinkingLevel": "off"
    }
  }
}
```

The reviewer receives only rule/category/risk metadata, cwd, and bounded command or path text from the pending tool input. It does not receive the conversation transcript, file contents, tool results, or credentials. Unavailable, timed-out, or invalid reviews fall back to the normal confirmation prompt; see the contributor guide for the internal request and verdict protocol.

Permanent allows are stored separately in:

```text
~/.pi/agent/safety-guard-allow.json
```

### Approval scopes and lifetimes

Every remembered permission is scoped to the current working directory. The bash prompt offers combinations of scope and lifetime, rather than making session approvals exact and permanent approvals broader.

| Scope | Session option | Permanent option | What it covers |
| --- | --- | --- | --- |
| Complete input | `Allow this exact command for this session` | `Always allow this exact command in this cwd` | Only the original full command string. Different spacing or arguments require approval. |
| Listed exact operations | `Allow listed exact operations for this session` | `Always allow listed exact operations in this cwd` | The argument lists of the operations marked `NEEDS APPROVAL`, standalone or in later supported chains. Equivalent literal quoting and spacing are accepted; different arguments are not. |
| Listed operation types | `Allow listed operation types for this session` | `Always allow listed operation types in this cwd` | The constrained Git types described in the prompt. Offered only when every pending operation qualifies. |

`Allow once` runs only the current invocation and remembers nothing. `Block`, dismissal, cancellation, or a UI error stops the complete invocation without saving new permissions. The guard never removes a rejected fragment and runs the rest. Existing approvals keep their previous lifetime; your choice applies only to newly remembered permissions.

The single prompt lists recognized operations, all matching enabled risks, already-approved operations, and any reason whole-command approval is required. Multiple occurrences of the same command remain visible. One selection approves all remaining operations at the displayed scope and lifetime. There are no separate per-risk dialogs or shortest-duration aggregation anymore.

Protected-path prompts retain `Allow for this session`, `Always allow write to this path in this cwd`, and `Always allow edit to this path in this cwd`. They cover the resolved path for that tool, including future contents, not just the current change.

### Reusable Git operation types

| Type | Supported command forms | Not covered |
| --- | --- | --- |
| Branch creation | `git switch -c NAME`, `git switch --create NAME` | Force creation, extra flags, start points |
| Non-forced switching | `git switch NAME` | Discard/force flags, detach options, extra arguments |
| Merged-branch deletion | `git branch -d NAME` | `-D`, multiple branch arguments, other flags |

Each type permits any simple branch name in the same cwd. A simple name begins with an ASCII letter or digit and contains only ASCII letters, digits, `.`, `_`, `/`, or `-`. Git still validates names and whether `-d` is permitted. Quotes around a literal name do not broaden the allowed characters. Different types require separate grants. No type grants blanket permission for all Git commands.

### Supported command syntax and fallback

Operation permissions apply only to successfully analyzed literal simple commands and linear chains using `&&`, `||`, `;`, newlines, or `|`. Ordinary single/double quotes containing literal text and comments are supported. An allowed operation cannot cover another unapproved operation in the chain.

Expansions, substitutions, globs, escaped/concatenated words, redirects, heredocs, control flow, background execution, environment assignments, interpreter/execution wrappers, directory-changing commands, executable paths, and Git global options require whole-command approval. This conservative fallback applies even when no known dangerous pattern matches. A previously saved operation permission never bypasses it. Syntax checks do not prove what an arbitrary executable will do.

Mixed pipeline/conditional chains whose grouping cannot be safely analyzed also require whole-command approval.

Risk excerpts use `!!!` for matched lines and `>>> pattern <<<` for matched text. Quoted arguments can prevent an exact text marker; the listed operation and its risk label still apply.

Analysis also falls back when input exceeds 65,536 characters, contains unsupported control characters, contains more than 32 operations, or exceeds parser limits. Parser loading or parsing failures use the same path. Large prompts that cannot display the complete permission scope offer only `Block` and `Allow once`. Context-line settings still control risk excerpts; the complete invocation is also shown when it fits.

Remembered approvals are checked before optional model review, including in non-interactive mode. With no applicable approval, model review is used if enabled and the full input fits its bound; otherwise non-interactive calls are blocked. Turning a category off disables its known-risk checks, but does not disable the unknown-syntax fallback. The master off switch disables both.

### Safety, updates, and troubleshooting

- Git operations may change your checkout, delete local branches, or execute hooks. Cwd scoping does not make a repository, executable, hook, or shell startup configuration trustworthy. This extension is not a sandbox.
- Supported literal commands without a matching enabled risk can run without a prompt. Arbitrary executable behavior is not proven safe by syntax analysis.
- Existing exact approvals remain whole-command/path approvals. Updating does not convert them into reusable operation permissions.
- Permissions previously granted with `Always allow git switch branch creation in this cwd` remain standalone-only and keep their original restrictions. To use the new operation scopes in chains, explicitly approve them through the new options.
- Old versions ignore new operation permissions. They may drop unfamiliar permissions when saving their allow store. Use `/safety-guard allow-clear-permanent` before downgrading if you want to remove all saved permissions.
- If a supported command still asks for whole-command approval, check the cwd, syntax, and analysis-limit message. Reload Pi after correcting a missing or broken parser dependency. Do not work around parser failure with a blanket allow rule.
- Mismatched entries produced by the issue's old local label-key patch are ignored rather than broadened. Approve the command again using the explicit options.

## Commands

```text
/safety-guard-setup
/safety-guard status
/safety-guard on
/safety-guard off
/safety-guard allow-list
/safety-guard allow-clear-session
/safety-guard allow-clear-permanent
```

`/safety-guard-setup` opens a settings list in Pi's TUI, followed by authenticated model and supported-thinking selectors when auto-review is enabled. RPC setup uses the JSON editor plus the same authenticated selectors. In Pi Web UI it opens a browser-native setup dialog with the same persisted settings.

When disabled, the status bar shows `🔓!`. The `on` and `off` commands update the global setup file.

`allow-list` shows both session and permanent entries and distinguishes whole-command, legacy rule, exact-operation, and operation-type permissions without printing complete stored command contents. `allow-clear-session` clears only the in-memory list. `allow-clear-permanent` empties the persisted allow file.

## Example view

```text
git switch -c feature/two && npm uninstall example
Safety Guard: bash approval
1. ALREADY APPROVED: git switch -c feature/two
2. NEEDS APPROVAL: npm uninstall example
Risks: JS package removal

Choose Block, Allow once, or an available scope/lifetime option.
```

The guard adds a pause before risky shell commands or sensitive file edits, while still letting you proceed intentionally.
