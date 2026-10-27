# Sailfish OS skill

Help Pi diagnose and maintain Sailfish OS devices without treating a phone like a generic desktop Linux system.

## Helpful when

- Package installation or Chum repository setup fails and you need to distinguish missing packages from authentication or repository errors.
- Shell snippets fail under BusyBox, or an app behaves differently in the terminal and its Sailjail sandbox.
- You need to inspect services, storage, SSH connectivity, or a matching Sailfish SDK build target safely.

## What to share with Pi

- Whether Pi is running on the phone, an SDK target, or a connected computer.
- The device release, requested package or app, exact error, and what changes you authorize.
- Any backup, connectivity, or recovery constraints. Never send passwords, tokens, or private account data.

## Try asking

> Inspect this Sailfish device as the normal user. Check whether curl is available in the configured repositories, but do not refresh metadata, install packages, change repositories, or restart services.

After installation, ask normally or invoke `/skill:sailfishos` with your scoped request. Use `/reload` if an already-running Pi session has not discovered the skill.

## What you'll get

- A context-aware diagnosis with actual capability checks rather than assumed desktop commands.
- A distinction between missing packages, failed queries, and blocked authentication.
- A scoped change plan and verification evidence, or a clear handoff when execution is blocked.

## Keep in mind

This skill provides guidance, not a runtime security guard. Installing it does not change the phone, enable SSH, activate Chum, or grant root access. Its optional diagnostic helpers are read-only; privileged or disruptive changes need separate authorization. Review diagnostic output before sharing it.

## Install

This package is prepared for its first release and is **not yet published** to npm. Once published:

```sh
pi install npm:@firstpick/pi-skill-sailfishos
```

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for advanced usage, compatibility, safety, and troubleshooting. Contributors can use [DEVELOPMENT.md](DEVELOPMENT.md).

[MIT license](LICENSE)
