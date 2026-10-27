# Services, diagnostics, connectivity, and phone safety

Sailfish uses systemd system and user managers, D-Bus, and a phone-oriented middleware stack. The familiar command does not imply modern desktop versions/features: Sailfish may use older vendor-patched systemd versions. Probe help before using newer options. [D01, D02]

## System vs user services

**Normal device user, read-only:**
```sh
systemctl --version
systemctl --no-pager status connman.service
systemctl --no-pager status ofono.service
systemctl --no-pager status packagekit.service
systemctl --user --no-pager status lipstick.service
systemctl --user --no-pager status pulseaudio.service
journalctl --no-pager -b -u packagekit.service -n 80
journalctl --user --no-pager -b -u lipstick.service -n 80
```
Use real discovered units; status may return nonzero for inactive/missing units. Do not collapse all such outcomes into “command broken”. Logs may be permission-limited. Request scoped authorized root access only if necessary. Review/redact logs before sharing; networking, app and telephony logs can contain personal data.

Use `systemctl list-unit-files --no-pager` / `systemctl --user list-unit-files --no-pager` with bounded filtering to discover actual names. Avoid blanket logs for the whole phone.

If the user bus is unavailable:
- Determine which account/session is running the tool.
- Check **presence**, not a full dump, of XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS.
- Check `loginctl` and session status if needed.
- Use the actual device user's session. Do not set fake bus addresses, assume UID 100000 universally, or create a second UI session as a workaround.

## Common components (verify per device)

| Component | Typical role | Disruption risk |
|---|---|---|
| lipstick (user) | Homescreen, compositor, launcher/window management | UI/session interruption |
| maliit-server (user) | On-screen input | Keyboard disruption |
| pulseaudio (user) | Audio; routing policies may involve other middleware | Calls/media lose audio |
| connman (system) | Wi-Fi and mobile-data connectivity | Can drop SSH/network |
| ofono (system) | Modem/SIM/telephony | Calls/data/SIM availability interrupted |
| mce (system) | Display/input/power mode control | Lock/display/suspend impact |
| dsme (system) | Device state management, power transitions | Shutdown/reboot behavior |
| timed | Alarms and time scheduling | Alarm delivery/time correctness |
| usb-moded | USB mode/gadget setup | USB/SSH/MTP disconnect |
| packagekit | Package transactions | Install/update corruption if interrupted |
| bluez/bluetooth | Bluetooth stack | Connected peripherals/audio |

These are discovery hints, not a guaranteed complete unit-name list. [D01, D02, D04]

**Do not restart** the user session, connman, ofono, usb-moded, dsme or mce to “see if it helps” without a scoped requested repair, user approval, and a fallback control path. `systemctl restart user@UID` can terminate the entire session. Never use an example's hardcoded UID without checking.

## Network diagnostics

ConnMan, not NetworkManager/nmcli, is the documented primary connection manager. oFono integrates cellular networking; BlueZ handles Bluetooth. `connmanctl` is optional; check its presence. [D02]

Safe targeted checks, if installed:
```sh
command -v ip
ip addr show
ip route show
systemctl --no-pager status connman.service
date -u
curl --head --connect-timeout 10 --max-time 20 https://repo.sailfishos.org/
```
Do not share addresses/device identifiers unnecessarily. A successful connection to the repo root only tests basic reachability; check the actual selected repo's repodata for package setup.

Do not edit resolv.conf, routes, APNs, modem configuration, or restart network services without a task-specific plan. Do not bypass TLS verification with `curl -k`. Mobile traffic can cost money.

## SSH and transfers (host-side commands)

The device Settings toggles for developer tools and remote SSH access are separate. Keep developer-update/RnD settings unchanged for ordinary terminal access. Verify the SSH server, actual user, address, and authentication flow locally. [D06, D15]

Official USB examples use 192.168.2.15, but read the current settings/interface address rather than assuming it for every device. Identify whether user is defaultuser or nemo. Verify host keys, don't disable host-key checking, and don't expose remote connection to untrusted networks.

```sh
# On the computer, using discovered DEVICE-ADDRESS and actual username:
ssh USER@DEVICE-ADDRESS
scp ./my-package.rpm USER@DEVICE-ADDRESS:<device-home>/Downloads/
```
The names above are examples; adapt them, don't run them literally. SSH device passwords stay in the terminal, not in prompts/scripts. Logs and private data copied off-device require explicit scope and redaction.

## Storage and power

`df -h / /home /tmp` distinguishes OS space, encrypted user-data space and temporary RAM-backed storage. Optional `findmnt` and `lsblk` can clarify mounts, but avoid sharing encryption UUIDs. Use narrow `du` checks for a relevant directory, not the whole private home tree.

Large builds should use a host or a deliberate workspace under user storage. Package caches live on their own filesystems; inspect rather than guess. Do not clean contacts/messages/Android data to free space.

Phone suspend can interrupt long jobs. Explain this rather than blindly disabling suspend; permanent mce changes affect battery and thermals. OS updates require charger and a stable path. Do not assume laptop power tools or generic systemctl suspend behavior match this adaptation.

## Permission/debugging decision tree

1. File failure: `ls -ld` parent paths; normal Unix ownership/mode; protected group access.
2. App works unsandboxed but fails from launcher: inspect desktop X-Sailjail permissions and app data namespace.
3. D-Bus failure: correct session/system bus and service policy; do not invent APIs.
4. System mutation denied: root/Polkit/interactive authorization, not file chmod.
5. Check optional MAC state only if relevant; SELinux existing is not proof it is enforcing. Never turn security layers off to diagnose by default.
6. Native binary won't start: architecture/loader/library dependencies before permission hacks.
7. Gather bounded relevant logs, reproduce one action, then re-query state.

Read Sailjail's APPDEBUG instructions for tracing; generic sudo-gdb examples may bypass or conflict with sandbox/group behavior. Debugging can expose personal data and significantly change timing. Use temporary scoped diagnostics only, with a cleanup plan. [D07, D18]
