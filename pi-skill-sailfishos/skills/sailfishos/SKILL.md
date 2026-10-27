---
name: sailfishos
description: Use when operating or developing for Sailfish OS.
license: MIT
compatibility: Readable by Agent Skills-compatible harnesses on a device or connected host. Helpers require POSIX sh and common device utilities; package queries require pkcon.
metadata:
  version: "0.1.0"
---

# Sailfish OS operations

Treat Sailfish as mobile Linux, not generic Ubuntu, Arch, Fedora, Android, or an SDK VM. Establish actual capabilities before using examples. This skill is guidance, not an enforcement layer or permission to change a phone.

## When to use

Use for Sailfish/SFOS diagnostics, BusyBox shell incompatibilities, PackageKit/RPM/SSU, devel-su, Chum/OpenRepos, systemd user services, Sailjail permissions, Qt/QML apps, Android AppSupport, SSH, storage, or SDK builds. Do not use it to administer an unrelated desktop distribution or Android device.

## Inputs and assumptions

Establish the target device and OS release, normal user, architecture, execution backend (device, SDK target/emulator, or desktop host), requested operation, authorization boundary, and recovery path for disruptive changes. Do not assume a username, UID, IP, shell implementation, repository, helper shortcut, or installed package from a previous device. Personal observations belong in the harness's private memory, not this package.

## Portable workflow

### 1. Identify context and capabilities

Read `/etc/os-release`; check `id`, `uname -m`, shell executable links, PATH, and relevant tools without dumping the environment. Read [capability checks](references/capability-checks.md). Use normal-user read-only probes first.

On a confirmed Sailfish device, run the bundled inventory with its resolved absolute skill path:

```sh
/bin/sh <skill-directory>/scripts/inspect.sh
```

It reports OS, command availability, redacted repository URLs, storage, and selected service states. It refuses a non-Sailfish OS. A host-side run does not inspect a remote phone: transfer a reviewed helper or execute scoped probes on the authorized device. Use narrow file paths and bounded command timeouts.

### 2. Respect shell and privilege boundaries

Read [shell and paths](references/shell-and-paths.md). A file named `/bin/bash` may be BusyBox rather than GNU Bash. Default to POSIX `#!/bin/sh`, quote paths, and verify flags; do not assume arrays, brace expansion, `[[ ]]`, shopt, or GNU utility options. Keep dependent operations together and inspect the harness's shell-state semantics. Aliases and a previous root shell are not reliable authorization or execution state.

Do not install Bash/coreutils merely to make a snippet work. For an authorized privileged operation, use the documented direct-command devel-su form, for example `devel-su /bin/sh /absolute/path/script ARG...`. Do not treat `devel-su -c` as standard su syntax. Intentional shell expressions require an explicit shell: `devel-su /bin/sh -c 'command'`. Prefer direct argv. Never request passwords in chat or bypass authentication. If interaction is unavailable, stop after one failure and give a precise pending handoff.

### 3. Query packages and repositories before mutation

Read [packages and repositories](references/packages-and-repositories.md) before package, repository, or OS changes. Check `pkcon`, `rpm`, and `ssu` individually. Prefer pkcon on the device; SDK target package tooling is a separate context.

```sh
rpm -q PACKAGE
LC_ALL=C pkcon --plain --filter '~source' resolve PACKAGE
/bin/sh <skill-directory>/scripts/package-available.sh PACKAGE [PACKAGE ...]
```

The helper queries cached metadata only. Exit 0 means all names produced Installed/Available results; 3 means a missing match; 2 means invalid input; 1 means a tool/query failure. A zero pkcon exit status with empty Results is not availability proof.

Only when authorized: verify repositories/storage/connectivity, refresh metadata, stop on failure, check every package name, and install with confirmation. Review dependency/removal prompts. RPM queries do not solve transactions; direct RPM installation is a reviewed sideloading exception. Use SSU for persistent repository changes, never hand-edit SSU-generated repo files. Verify SSU and PackageKit state after changes. Chum/OpenRepos are community services, not official OS repos. Match OS, architecture, and stable/testing intent; do not enable all publishers or hardcode another device's release.

### 4. Diagnose services, apps, and development targets

Read [services and diagnostics](references/services-and-diagnostics.md) and [apps and development](references/apps-and-development.md) for the relevant branch. Start with status and bounded logs. Distinguish system and user managers; inspect user services as the logged-in device user. Inactive/missing units and permission-limited logs are observations, not automatic corruption.

Inspect actual RPM files and desktop entries instead of inventing launcher commands or D-Bus interfaces. Never eval a desktop Exec value. Reproduce permission issues with Sailjail; running a binary directly can bypass the sandbox. Unix ownership, protected groups, D-Bus policy, Polkit, and sandboxing are different layers. Do not repair them with recursive chmod/chown or disabled security.

Generic AArch64 or Android binaries are not automatically ABI-compatible. Query loader/libc/Qt/modules and use a matching SDK build target where feasible, rather than replacing the phone's runtime/toolchain. AppSupport is optional and device/licence/version-dependent; its existence is not established by one directory or repository name.

### 5. Plan high-impact operations explicitly

OS upgrade/downgrade, distribution upgrades, release/domain/RnD changes, flashing/reset, encryption/partition changes, bootloader/kernel changes, force/nodeps RPM operations, database rebuilding, permanent power-policy changes, and bulk deletion require an exact target, current official instructions, backup, adequate storage/power/connectivity, authenticated access, and a recovery/rollback plan. Respect mandatory stop releases. An install request is not a whole-OS-upgrade request.

Network, USB, UI, modem, audio, or power-service restarts require scoped authorization and a fallback path; they can disconnect the session or interrupt calls. Change one thing at a time and stop on unexpected errors.

## Safety and side effects

Reading this skill does not install packages, change settings, activate repositories, enable SSH, or grant root access. Helpers do not refresh/install/remove, elevate, launch apps, or restart services. Package queries can activate PackageKit and read existing metadata; this is not proof of a fault. Inventory output still contains operational details: review before sharing.

Do not dump SSU credential files, raw environment values, agent authentication, private SSH keys, account databases, contacts, messages, calls, or Android private app data. Do not publish captured device inventories as reusable skill content. Keep root's shell and system `/bin/sh` intact during an explicitly requested user-shell change. Authentication failures are blockers, not permission to alter PAM/Polkit or weaken TLS/SSH verification.

## Scripts, references, and dependencies

- `scripts/inspect.sh`: POSIX sh, grep, sed, awk, date, uname, id, ls, df, head; uses installed RPM/SSU/systemd tools conditionally. Device-only, read-only, bounded inventory.
- `scripts/package-available.sh`: POSIX sh, grep, and pkcon; normal-user cached package queries with validated package names.
- [Capability checks](references/capability-checks.md)
- [Shell and paths](references/shell-and-paths.md)
- [Packages and repositories](references/packages-and-repositories.md)
- [Services and diagnostics](references/services-and-diagnostics.md)
- [Apps and development](references/apps-and-development.md)
- [Sources and limitations](references/sources.md)

No npm runtime dependencies, install hooks, API keys, or assumed local wrappers. Other topic-specific tools must be discovered before use. Invoke helpers with `/bin/sh`; do not depend on executable mode or an npm bin entry.

## Verification

After any authorized change, read back the exact file/package/repository/service state and repeat the originally requested behavior. Report separately: completed and verified; prepared but not executed; documented but not tested on this target. Include commands, paths, failures, and omitted checks. Never infer an active repository from a downloaded RPM. Recheck mutable facts and current primary documentation before future operations.

## Pi adapter

In Pi, install with `pi install npm:@firstpick/pi-skill-sailfishos`, then use `/reload` if the running session has not discovered it. Invoke `/skill:sailfishos` or ask a scoped Sailfish question normally. Resolve the installed skill path from Pi discovery rather than assuming a fixed npm directory. Pi's bash calls can be separate noninteractive processes; combine dependent cd/export/command operations and never assume elevation persists. Use Pi's available file tools for narrow reads/edits. Do not modify Pi settings, disable sandboxing, or install extra extensions merely to use this skill.
