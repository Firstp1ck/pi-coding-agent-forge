# Sailfish OS: advanced usage

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Requirements and compatibility

The guidance is usable by Agent Skills-compatible harnesses running on a Sailfish device or a computer connected to one. Identify which environment receives every command: a desktop host, SDK target, emulator, and physical phone are not interchangeable.

The package has no npm runtime dependencies, configuration variables, API keys, or installation hooks. Reading the skill needs no root or network access. Diagnostics use POSIX sh and common device utilities; package lookups also require pkcon. Optional RPM, SSU, and systemd probes depend on installed tools. Other task-specific utilities are discovered before use, not installed automatically.

Do not assume GNU Bash, a particular username, UID, IP, release, Qt version, AppSupport availability, or community repository. BusyBox capabilities vary between devices. Use current target observations and vendor documentation.

## Selecting the skill

In Pi, use `/skill:sailfishos` followed by the task, or ask a scoped Sailfish question in ordinary language. `/reload` refreshes an already-running session when needed. Resolve the installed skill directory from discovery rather than assuming a fixed npm installation path.

Examples:

> Explain why a pkcon query returned success but no package results. Query only; do not refresh or install.

> Review this app's desktop permissions and explain why it works outside Sailjail. Do not disable the sandbox.

> Identify the SDK target needed for this app's release and architecture. Do not change the phone's toolchain.

## Optional read-only diagnostics

Ask Pi to run the bundled inventory on the confirmed device as the normal user. It reports capabilities, repository URLs with credential components redacted, storage, and selected service states. It does not inspect private app data, dump logs, elevate, or restart services. It refuses non-Sailfish hosts; a host-side invocation is not remote-phone inspection.

Package availability checks validate exact names and query cached non-source metadata only. Their result is:

- 0: every requested name has an Installed or Available result.
- 1: a tool or query failed; availability is unknown.
- 2: usage or package-name input is invalid.
- 3: at least one name has no installed or available match.

Cached results can be stale. Refreshing repositories is a separate authorized operation. A successful pkcon command with empty results is not a package match.

## Security and privacy

Guidance does not enforce permissions. Review and approve mutations before they run. Package transactions and repositories affect system trust; dependency removals and RPM scriptlets need review. Device inventories can expose operational information even when credential URLs are redacted.

Keep root/SSH passwords in the local authentication terminal, never in chat or scripts. If a noninteractive tool cannot authenticate, stop after one failure and use a precise interactive handoff. Do not alter PAM/Polkit, disable sandboxing, or use recursive permissions as a workaround. The devel-su command interface is not ordinary su syntax; follow the target's documented direct-command flow.

OS upgrades, mandatory stop releases, flashing, encryption, partitions, and modem/network/UI/power-service restarts require current official instructions, explicit authorization, backups, stable power/connectivity, and a recovery path. Do not change an SDK and claim the phone changed.

## Local observations

This package intentionally contains no personal device snapshot, local account shortcuts, authentication history, or research logs. Save observations in your harness's private memory outside the installed package. Re-probe mutable versions, repositories, services, and helpers before future work.

## Troubleshooting

- Skill missing: verify package discovery and reload the Pi session; do not replace global settings blindly.
- Helper rejects the OS: identify the real device/backend and run there; do not bypass the guard.
- Utility absent: discover a portable alternative before requesting a package addition.
- Authentication denied: distinguish the root/SSH authentication flow from the lock code and cloud credentials; do not guess the cause or bypass it.
- Repository refresh fails: preserve the error and check clock, TLS, network, and release/architecture match before installing.
- App works only unsandboxed: inspect desktop metadata and required permissions rather than launching it as root.
- Device disconnected during a change: use the pre-agreed recovery path; do not repeat disruptive changes blindly.

## Further reading

The skill includes topic-specific vendor/upstream source references loaded on demand. [Sailfish documentation](https://docs.sailfishos.org/) is the starting point for current instructions. Its examples can be version-specific and sometimes destructive; they are not blanket authorization.
