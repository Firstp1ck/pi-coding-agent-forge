#!/bin/sh
# Read-only, bounded Sailfish inventory. Does not elevate or refresh repositories.
export LC_ALL=C
case "${1-}" in
    -h|--help)
        printf '%s\n' "Usage: inspect.sh" "Report OS, commands, repositories (URLs redacted), storage and selected service states." "No installs, configuration changes, elevated commands or log dumps."
        exit 0 ;;
    '') ;;
    *) printf '%s\n' "Usage: inspect.sh" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
    printf '%s\n' "Usage: inspect.sh" >&2
    exit 2
fi
if [ ! -r /etc/os-release ] || ! grep -Eq '^ID="?sailfishos"?$' /etc/os-release; then
    printf '%s\n' "This inspection script is for a Sailfish OS device; identify host/SDK context separately." >&2
    exit 1
fi
have() { command -v "$1" >/dev/null 2>&1; }
heading() { printf '\n== %s ==\n' "$1"; }
state() {
    scope=$1
    shift
    for unit do
        printf '%s: ' "$unit"
        if [ "$scope" = user ]; then
            systemctl --user is-active "$unit" 2>&1
        else
            systemctl is-active "$unit" 2>&1
        fi
        # Inactive/not-found status is an observation, not a script failure.
        :
    done
}
heading "Observation time (device clock)"
date -u '+%Y-%m-%dT%H:%M:%SZ'
heading "OS"
grep -E '^(NAME|ID|VERSION|VERSION_ID|PRETTY_NAME|SAILFISH_FLAVOUR)=' /etc/os-release
uname -sr
uname -m
heading "Account and shell"
printf 'user='; id -un
printf 'uid='; id -u
printf 'group='; id -gn
printf 'HOME=%s\nSHELL=%s\n' "${HOME-unset}" "${SHELL-unset}"
ls -l /bin/sh /bin/bash 2>/dev/null
heading "Command availability"
for tool in pkcon rpm ssu devel-su zypper systemctl journalctl loginctl dbus-send sailjail firejail invoker python3 node git gcc make gdb strace curl connmanctl ip pactl findmnt lsblk getenforce; do
    if path=$(command -v "$tool" 2>/dev/null); then
        printf '%s: %s\n' "$tool" "$path"
    else
        printf '%s: unavailable on PATH\n' "$tool"
    fi
done
heading "Library and package versions"
if have rpm; then
    rpm -q glibc qt5-qtcore qt5-qtdeclarative busybox bash systemd sailfishos-chum-repo-config sailfishos-chum-gui 2>&1
fi
heading "Repositories (userinfo and URL query/fragment redacted)"
if have ssu; then
    # Capture the command separately so sed cannot mask its failure.
    repositories=$(ssu lr 2>&1)
    result=$?
    printf '%s\n' "$repositories" | sed \
        -e 's#\([A-Za-z][A-Za-z0-9+.-]*://\)[^/[:space:]]*@#\1[redacted]@#g' \
        -e 's#[?#][^[:space:]]*#[redacted]#g'
    [ "$result" -eq 0 ] || printf 'ssu lr exited %s\n' "$result"
fi
heading "Storage"
# Report mount capacity without filesystem sources, encryption UUIDs or serials.
df -h / /home /tmp | awk 'NR==1 {print "Size Used Available Use% Mount"; next} NF >= 6 {print $(NF-4), $(NF-3), $(NF-2), $(NF-1), $NF} NF==5 {print $1, $2, $3, $4, $5}'
heading "Selected service states"
if have systemctl; then
    systemctl --version | head -n 1
    state system packagekit.service connman.service ofono.service mce.service dsme.service sshd.service
    state user lipstick.service pulseaudio.service
fi
heading "Session-variable presence (no values)"
# Report only presence of an explicit non-secret whitelist.
[ "${XDG_RUNTIME_DIR+x}" = x ] && printf '%s\n' 'XDG_RUNTIME_DIR=present' || printf '%s\n' 'XDG_RUNTIME_DIR=unset'
[ "${DBUS_SESSION_BUS_ADDRESS+x}" = x ] && printf '%s\n' 'DBUS_SESSION_BUS_ADDRESS=present' || printf '%s\n' 'DBUS_SESSION_BUS_ADDRESS=unset'
[ "${WAYLAND_DISPLAY+x}" = x ] && printf '%s\n' 'WAYLAND_DISPLAY=present' || printf '%s\n' 'WAYLAND_DISPLAY=unset'
[ "${DISPLAY+x}" = x ] && printf '%s\n' 'DISPLAY=present' || printf '%s\n' 'DISPLAY=unset'
heading "Optional SELinux state"
if [ -r /sys/fs/selinux/enforce ]; then
    printf 'SELinux enforce='
    head -c 8 /sys/fs/selinux/enforce
    printf '\n'
elif have getenforce; then
    getenforce
else
    printf '%s\n' "SELinux state not available through this probe."
fi
printf '\n%s\n' "Inspection complete. Re-query mutable state immediately before a change."
exit 0
