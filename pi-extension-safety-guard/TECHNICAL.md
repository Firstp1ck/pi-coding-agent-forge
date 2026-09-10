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
- Offers session or permanent approvals for exact operations and constrained Git operation types. Exact operations also have a permanent EVERYWHERE option. Existing whole-command grants remain compatible.
- Shows recognized operations and exact matched risk snippets in one bash prompt. Unsupported syntax alone does not prompt.

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

### Approval storage

Approvals are separate from `settings.json` and the guard's settings file. Default locations are:

| Scope | Storage |
| --- | --- |
| Allow once | Not saved |
| Current session | Native Pi session metadata, normally under `~/.pi/agent/sessions/` |
| Permanent current cwd | `<cwd>/.pi/safety-guard-allow.json` |
| Permanent EVERYWHERE | `~/.pi/agent/safety-guard-allow.json` |

The native Pi user-directory setting is honored for approval state. A directory grant applies only to that exact cwd; parent-directory files are not inherited. The guard adds `/safety-guard-allow.json` to the local `.pi/.gitignore` without replacing existing ignore rules.

A user-owned verification file, `~/.pi/agent/safety-guard-allow.json.receipts.json`, confirms which project approval files this user approved. It contains verification metadata, not another copy of the grants. Copied or edited project files without matching verification are ignored and are not overwritten automatically. Symlinked project configuration directories, approval files, and ignore files are rejected for approval writes. The approval and verification files themselves are protected from unconfirmed `write`/`edit` tool changes.

Session grants survive `/reload` and resuming the same session. They are not inherited by `/new`, forked, or cloned sessions. Clearing session grants remains effective after reload and tree navigation. In-memory Pi sessions retain grants only while that session manager exists; they cannot persist across process exit. Session grants created before this update were memory-only and must be approved again after reloading.

### Approval migration and recovery

When a directory is next used, its existing entries in the old global approval file are moved into its local file. EVERYWHERE entries and unvisited directories remain in the global file. Each migration first creates a private `safety-guard-allow.json.legacy-<id>.bak` beside the global file. Legacy records are removed only after the local file and its verification record are saved. Migration failure keeps the old records and reports the issue.

Unverified project files are left untouched. Inspect and move such a file aside yourself if it prevents migration, then retry in that cwd; do not copy someone else's verification file to approve it. New local grants also fail rather than overwriting unverified files.

Approval updates coordinate through `safety-guard-allow.json.lock` beside the global store. A busy-lock error requires a retry. If it persists after a crash, ensure no Pi process is updating approvals before inspecting and removing the stale lock. Do not remove a live lock. Approval state files are limited to 8 MiB; oversized or malformed files are reported rather than overwritten.

Backups are never loaded automatically. Restoring one can revive revoked permissions, so review its contents and restore only deliberately. Older versions cannot read grants moved into project or session storage. For downgrade, either reapprove operations or explicitly restore reviewed backup records.

### Approval scopes and lifetimes

Remembered permissions are scoped to the current working directory unless you explicitly choose `Always allow the command EVERYWHERE`. In option labels, "here" means the current working directory. The bash prompt names both the scope and lifetime; only exact operations have a global option, and it is permanent.

| Scope | Session option | Permanent option | What it covers |
| --- | --- | --- | --- |
| Exact operations | `Allow the command for the current session` | `Always allow the command in the current directory` | The programs and argument lists marked `NEEDS APPROVAL`, standalone or in later supported chains. Equivalent literal quoting and spacing are accepted; different arguments are not. |
| Exact operations everywhere | Not offered | `Always allow the command EVERYWHERE` | The same pending programs and arguments in any working directory, including future sessions. Different arguments or programs are not covered. |
| Operation types | `Allow operation types this session` | `Always allow operation types here` | Broader constrained Git types described in the prompt. Offered only when every pending operation qualifies. |

The remembered whole-command choices have been removed. Previously saved whole-command grants still match only the complete original input, including its spacing and quoting; they are not converted into operation grants.

`Allow once` runs only the current invocation and remembers nothing. `Block`, dismissal, cancellation, or a UI error stops the complete invocation without saving new permissions. The guard never removes a rejected fragment and runs the rest. Existing approvals keep their previous lifetime; your choice applies only to newly remembered permissions.

The single prompt lists recognized operations, all matching enabled risks, already-approved operations, and any reason whole-command approval is required. Multiple occurrences of the same command remain visible. One selection approves all remaining operations at the displayed scope and lifetime. There are no separate per-risk dialogs or shortest-duration aggregation anymore.

Bash prompts start with a **Trigger** section. It names the matched risk rule and shows the actual matched text as `>>> ... <<<`, plus its source line and character column. Terminal prompts also highlight that text in bold warning colors. For example, a risky SQL heredoc marks `DROP TABLE`, not the heredoc opener. Parser failures, redirections, and interpreter names are not risk triggers by themselves.

In the terminal, bash prompts show command and risk details without a separate permission section. A short note under the selection list follows the highlighted option. It explains whether anything is saved, the exact scope, and whether future prompts and model review are skipped. Headings and warnings are highlighted; explanations use normal text. A single-operation command is shown once rather than repeated in the operation list. Lines wrap within 100 columns. On shorter screens, Page Up / Page Down scroll the details while the approval choices remain visible. These keys follow your Pi selection-page keybindings. Long selected option labels wrap below the list so you can read the full scope before confirming. RPC clients receive the command details as plain text, followed by compact guidance for the available choices immediately before the selection list.

The EVERYWHERE option appears immediately after the directory-scoped permanent exact-operation option. Its highlighted warning states that relative paths can target different files, executables/hooks may differ, and covered calls skip future prompts and model review. RPC clients receive the same warning before the choices. Existing local approvals are not widened; only operations still marked `NEEDS APPROVAL` receive new global grants.

Global approvals require successful operation analysis, just like directory-scoped operation approvals. They cannot cover another unmatched operation, a matched risk in unsupported syntax, or SQL in a pipeline. The option is absent when operation reuse is unavailable or the authorization preview is incomplete. It does not apply to `write` or `edit` tools.

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

Expansions, substitutions, globs, escaped/concatenated words, redirects, heredocs, control flow, background execution, environment assignments, interpreter/execution wrappers, directory-changing commands, executable paths, and Git global options can prevent reusable operation analysis. Mixed pipeline/conditional chains can also exceed that analysis. None of these conditions prompts by itself.

When operation analysis is unavailable, the guard falls back to the published pattern-driven behavior. It checks shell-command patterns outside heredoc bodies and SQL patterns across the complete input. If no enabled pattern matches, the call proceeds without a prompt or model review. If a pattern matches and no existing whole-command grant covers it, only `Block` and `Allow once` are offered; saved operation permissions do not cover it. Shell syntax and arbitrary executable behavior are not proven safe by these checks.

The Trigger section maps known risk matches back to the original command, including literal quoted arguments. Additional risk excerpts use `!!!` for matched lines and `>>> pattern <<<` for matched text. Their text-based matches can miss quoted spellings; use the source-mapped Trigger section to locate those matches.

Operation analysis also falls back when input exceeds 65,536 characters, contains unsupported control characters, contains more than 32 operations, or exceeds parser limits. Parser loading and parsing failures use the same pattern-checking fallback, not a blanket approval prompt. Pattern checks still cover input beyond the operation-analysis size limit. Large risk prompts that cannot display the complete permission scope offer only `Block` and `Allow once`. Context-line settings still control risk excerpts; the complete invocation is also shown when it fits.

Remembered approvals are checked before optional model review, including in non-interactive mode. Only calls with an uncovered risk match enter review or confirmation. Without an applicable approval or successful model review, matched risks remain blocked in non-interactive mode. Turning a category off disables its pattern checks; the master off switch disables the guard.

### Safety, updates, and troubleshooting

- Git operations may change your checkout, delete local branches, or execute hooks. Cwd scoping does not make a repository, executable, hook, or shell startup configuration trustworthy. This extension is not a sandbox.
- Commands without a matching enabled risk run without a guard prompt, including when syntax analysis fails. Scripts, imports, dynamic execution, and unusual spellings can hide actions from pattern checks.
- Existing exact approvals remain whole-command/path approvals. Updating does not convert them into reusable operation permissions.
- Permissions previously granted with `Always allow git switch branch creation in this cwd` remain standalone-only and keep their original restrictions. To use the new operation scopes in chains, explicitly approve them through the new options.
- Old versions ignore new operation permissions and do not read the new project/session stores. They may drop unfamiliar permissions when saving the global store. Review the migration guidance before downgrading; `allow-clear-permanent` now clears only the current cwd and EVERYWHERE grants.
- If a command prompts, check the named rule and marked text in the Trigger section. Parser problems can remove reusable operation choices for matched risks, but must not trigger prompts for otherwise unmatched commands. Correcting the dependency and reloading Pi restores operation analysis.
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

`allow-list` shows the current session's grants plus current-cwd and global permanent entries, and reports both permanent storage paths. It distinguishes whole-command, legacy rule, exact-operation, and operation-type permissions without printing complete stored command contents. Global exact-operation entries are marked `EVERYWHERE`.

`allow-clear-session` saves a durable clear for the current session. `allow-clear-permanent` clears global EVERYWHERE grants and the current cwd's permanent grants, including unmigrated legacy records for that cwd. Other directories and session grants remain untouched. A failed clear is reported, not presented as success.

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
