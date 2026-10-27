# Shell, filesystem, and navigation

## What is shared with desktop Linux?

Linux kernel, normal processes/files/permissions, glibc userland, RPM packages, systemd, D-Bus, and freedesktop concepts. Sailfish adds a phone-oriented UI, permissions, service stack, hardware adaptations, and release management. There is no single “default Linux distro”: compare Ubuntu, Arch, Fedora, and desktop assumptions individually. [D01, D02]

## Differences that affect scripts

The generic Core Areas documentation lists GNU tools and old library versions. That is **not a capability contract for a current phone**. Sailfish devices can use BusyBox links for shell and core utilities; query the actual implementations and installed RPMs.  Jolla's Rokua announcement documents the move of coreutils/tar/vi to BusyBox. [D17]

| Desktop assumption | Sailfish-safe approach |
|---|---|
| A bash-named binary is GNU Bash | Inspect symlink and real capabilities; use POSIX sh by default |
| `ls /usr/bin/{rpm,pkcon,ssu}` | `ls /usr/bin/rpm /usr/bin/pkcon /usr/bin/ssu` |
| Bash `source file` / `shopt` | POSIX `. file`; no shopt unless genuine Bash is confirmed |
| `ps -p PID -o args` works everywhere | Probe `ps --help`; `ps -o pid,comm,args` and filter PID, or read `/proc/PID/comm` |
| `grep -P`, `find -printf`, `date -d`, `stat -c` all match GNU behavior | Inspect help; use agent search tools or standard grep/awk/printf; test required options |
| `sed -i`, `readlink -f`, `timeout` exist identically | Check implementation/options; prefer precise edit tools and harness timeout |
| Aliases/profile always load | Use executables with explicit paths in noninteractive commands |
| Python, git, jq, compilers are present | `command -v` first; package additions need authorization |
| `set -e` catches every failure | Check important commands explicitly, particularly pipelines and commands returning success with empty results |

BusyBox has release/build-dependent optional features; “POSIX first” is conservative, not a claim that every Bash-like feature is absent. Pipelines normally return only the final command's status; capture/check the original status before parsing when correctness depends on it.

## Paths

Discover actual identity with `id -un`, `id -u`, and `$HOME`. Newer devices commonly use `defaultuser`; older/upgraded ones may retain `nemo`. Do not hard-code a username or UID in reusable commands. [D12, D15]

- `/etc/os-release`: safe OS identity/version.
- `/usr/bin`, `/usr/sbin`, `/bin`, `/sbin`: packaged executables; links may resolve into BusyBox.
- `/etc`: system configuration; root-managed. Inspect relevant files individually.
- `/etc/ssu`: SSU state, **potential credentials**; never dump indiscriminately.
- `/etc/zypp/repos.d`: generated/managed repository files; use SSU for repo changes.
- `/usr/share/applications`: native desktop entries and Sailjail metadata.
- `/usr/share/<app>`: common QML/assets location; use `rpm -ql <package>` to discover.
- `$HOME/.config`, `$HOME/.local/share`, `$HOME/.cache`: user/app state; may be namespaced and protected.
- `$HOME/.local/bin`: good location for **user-owned** helper scripts. Never assume it is on PATH.
- `/run/user/$(id -u)`: runtime user session, sockets, bus, generated service data; do not hard-code the UID.
- `/tmp`: temporary and possibly tmpfs. Large builds/downloads here consume RAM; avoid persistent work there.
- `$HOME/android_storage`: user-facing AppSupport files where available; not the full Android private-data tree.
- `/home/.appsupport`: newer AppSupport internal data location; **private, implementation-dependent**, not a general cleanup target. Older releases can differ. [D14]

Sailfish can use ext4 or Btrfs; encryption and partition layout depend on installation/device. Do not prescribe ext4, Btrfs, or encryption maintenance without inspecting the target layout. Newer installs commonly encrypt user data under /home. [D02, D13]

## Safe command patterns (on device, normal user)

```sh
pwd
id
uname -m
ls -la "$HOME"
ls -l /bin/sh /bin/bash
command -v pkcon
command -v rpm
command -v ssu
df -h / /home /tmp
rpm -qf /usr/bin/pkcon
rpm -ql PACKAGE
```

Prefer targeted searches, e.g. `find "$HOME/Projects" -type f -name '*.spec'`, over a root filesystem crawl. Quote paths and variables; filenames may contain spaces.


## Optional user-shell changes

Fish uses non-POSIX syntax and does not directly read POSIX login profiles. A requested login-shell change does not authorize replacing `/bin/sh` or changing root's shell. Verify the installed shell, account-management command, login environment, recovery path, and user approval first. Preserve the device's session/locale environment without importing secrets or evaluating untrusted text. A login-shell or PATH change does not update an already-running agent process.
