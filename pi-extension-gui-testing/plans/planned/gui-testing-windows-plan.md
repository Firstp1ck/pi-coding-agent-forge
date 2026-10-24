# Implementation plan: GUI Testing for Pi — Windows (S1 harness, M4, M5, Cua Windows)

Status: in progress · created 2026-10-24 · integration owner: main session (Claude Opus 5.5) · branch `feat/gui-testing-milestones`

- Spec: [gui-testing-spec.md](gui-testing-spec.md) §4.4, §4.5, §4.6, §5.4 (Windows checks), §7a, §11 (S1, M4, M5), Q4
- Previous plans: [gui-testing-m1-plan.md](gui-testing-m1-plan.md), [gui-testing-m1b-m3-plan.md](gui-testing-m1b-m3-plan.md) (invariants still apply)

## 1. User decisions (2026-10-24)

| Decision | Detail |
|---|---|
| Build Windows unverified | The user overrode the spec gate "M5 only if S1 is acceptable": implement S1's harness, M4, M5, and Cua Windows now, verified with fakes and unit tests only. Nothing here runs on Windows until someone runs the S1 harness and the e2e suites on a Windows machine. |
| Keep the Cua CLI design | Cua Cloud ended 2026-10-18; `cua` uses the open-source CLI with the user's own cloud. |

## 2. Owner decisions

| Decision | Reason |
|---|---|
| Q4 → (c) PowerShell 5.1 host + C# core compiled at runtime with `Add-Type` | Ships with every Windows 10/11: no download (spec option b) and no code-signing certificate or build toolchain (option a). The C# source stays in the repo, so it can later be compiled into a signed `.exe` without a rewrite. Revisit after S1 (AV/EDR reaction to runtime compilation and hidden desktops is a known risk). |
| `docker-windows` helper transport: OpenSSH server in the guest, installed by the unattended-install OEM script, reached on a `127.0.0.1`-bound port | Reuses the M2b SSH transport (ControlMaster, quoting, token on stdin) instead of a new channel; no port reachable from other machines. |
| Cua Windows: the Windows helper over `cua sandbox exec -i powershell …` | Same stdio model as the Linux helper; macOS stays refused. |
| S1 is delivered as a runnable harness, not as results | It must run on a Windows machine; its results decide whether the PowerShell form stays. |

## 3. Phases

| Phase | Owner | Exclusive paths | Deliverable |
|---|---|---|---|
| WH helper + S1 harness | worker (`claude-opus-5-5`) | `helpers/windows/**`, `tests/helper-windows/**`, `spikes/s1/**`, `docs/protocol.md` (Windows section) | Windows helper speaking protocol v2 (framing, hello with `platform.os = "windows"`, private desktop, Job Object containment, suspended start, non-elevated launch, UIA snapshot/act, `PrintWindow` screenshots with `allBlack`, coordinate fallback per §4.5, temp-dir rules, teardown on EOF/heartbeat); S1 harness |
| WL `local-windows` | worker | `src/backends/local-windows.ts`, `src/backends/windows/**`, `tests/unit/backends/windows/local-*` | Backend on win32 hosts, §5.4 checks (incl. `helper.job`, `helper.nonelevated`), audit/sweep of jobs and temp dirs |
| WD `docker-windows` | worker | `src/backends/docker-windows.ts`, `src/backends/docker-windows/**`, `tests/unit/backends/windows/docker-*` | dockurr/windows container with KVM, ports on 127.0.0.1, unattended install with OEM script (helper + OpenSSH), copy-on-write session overlay, license acknowledgement, deps cache `windows-<arch>` |
| WC Cua Windows | worker | `src/backends/cua/**` (Windows target only), tests | `--targets windows` deploys the Windows helper; macOS still refused |
| I integration + docs | owner / worker | registry, commands, docs, spec | Registration, flags (`--accept-windows-license`), README/TECHNICAL/DEVELOPMENT/SKILL, spec status |
| Review | 2 × `openai-codex/gpt-6.1-sol` | read-only | Quorum as before |

Order: WH → (WL ∥ WD ∥ WC) → I → review → fixes → report.

## 4. Progress record

| Phase | Status | Evidence |
|---|---|---|
| WH | done 2026-10-24 (never run on Windows) | `claude-opus-5-5`, handoff `plans/handoffs/windows-WH.md`: `helpers/windows/helper.ps1` + 15 C# sources (protocol core + Win32/UIA layer), `spikes/s1/` harness and sample apps, `docs/protocol.md` Windows section, MIT notice for `@iiwate/pi-silent-gui`. Ran here: PowerShell 7.6.8 linux-arm64 (dev tool in `~/.local/share/pi-tools/`) with a fake platform — 108/108 C# core checks, all 15 sources compile at C# 5 against .NET Framework 4.7.2 reference assemblies, 20 Node protocol tests whose results pass `response.ts`. Owner: added `tests/helper-windows/*.test.mjs` to `npm test`; stderr assertions now poll (they raced the stream under load). Owner rerun: concurrent `npm run check` + Node 22 → 589/589 each |
| WL | not started | |
| WD | not started | |
| WC | not started | |
| I | not started | |
| Review | not started | |
