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
| WL | done 2026-10-24 (unregistered, never run on Windows) | handoff `plans/handoffs/windows-WL.md`: `local-windows` backend, shared `src/backends/windows/**`, 12 Windows checks via helper probes, runtime dir with owner-only ACL, foreground-unchanged isolation check, session.json audit/sweep |
| WD | done 2026-10-24 (unregistered, never run) | handoff `plans/handoffs/windows-WD.md`: dockurr/windows 6.06 by digest, unattended install with OEM OpenSSH + helper, QEMU `-snapshot` session overlay, SSH on random 127.0.0.1 port, `--cap-drop ALL` + listed caps, base volume as tooling; `network: none` refused; one session at a time; helper runs in session 0 over SSH (private desktop, not the interactive session — spec §4.4 deviation) |
| WC | done 2026-10-24 (never run) | handoff `plans/handoffs/windows-WC.md`: Windows target in `cua` (target-aware ledger records, `windowsImage`, Windows rate, encoded PowerShell commands, StdinEnv start); Cua CLI 0.9.0 marks Windows unsupported on all four clouds, so `cua.targets` fails until Cua offers it |
| I | done 2026-10-24 | `claude-opus-5-5`, handoff `plans/handoffs/windows-I.md`: `local-windows`, `docker-windows` registered, `cua` targets linux+windows, `SessionStartOptions.target`, `--accept-windows-license`, VM size flags, cua Windows image/rate flags, smoke test backend-neutral with foreground check, runner timing test hardened, docs (README/TECHNICAL/DEVELOPMENT/SKILL/spec/root catalog). Owner rerun on the settled tree: concurrent `npm run check` + Node 22 → 710/710 each; `npm pack` 212 files incl. 17 Windows helper files, no spikes/tests/plans; Markdown diff check clean |
| Review | round 1 done 2026-10-24 | seat A (`…gui-testing-windows-review-A-r1`): **not ready**, 10 findings (9 blocking); seat B (`…-B-r1`): **ready after fixes**, 5 findings (3 blocking). All accepted as WF1–WF15 (below); fix run WF-r1 launched |

## 5. Review round 1 dispositions

All accepted. WF1 A-F1 runtime-dir cleanup traverses a replaced directory (handle-anchored no-reparse deletion); WF2 A-F2 forged `session.json` authorizes killing unrelated processes (tie process kills to helper/job ownership); WF3 A-F3 `WIN32_FIND_DATAW`/`BY_HANDLE_FILE_INFORMATION` FILETIME padding (file names lose two chars); WF4 A-F4 `Exec` reads `ExitCode` after `Forget` closes the child (every setup reports -1); WF5 A-F5 + B-F1 docker-windows one-session rule not atomic (interprocess lease, stale container removal); WF6 A-F6 nested Job Objects with UI limits (plausible); WF7 A-F7 `OSVERSIONINFOEX` ANSI marshalling (156 vs 284 bytes); WF8 A-F8 exit cleanup `taskkill /PID` without creation-time check; WF9 A-F9 snapshot/window budgets vs client limits; WF10 A-F10 unbounded abandoned desktop workers; WF11 B-F2 early local-windows start failures lose cleanup tracking; WF12 B-F3 docker-windows `setup` runs under `cmd.exe` while docs promise PowerShell; WF13 B-F4 generic temp sweep deletes Windows cleanup evidence first; WF14 B-F5 local-windows e2e skips teardown on assertion failure. Also keep the integration worker's late flake hardening of `cleanup.test.mjs` and `lifecycle.test.mjs` (found uncommitted after `4a3c539`). Both reviewers saw the full concurrent suite exceed 240 s on this host.

Fix WF-r1 (`claude-opus-5-5`, handoff `plans/handoffs/windows-WF.md`): all 14 fixed with regression tests (WF6/WF8/WF14 compile-checked only); new `docker-windows/lease.ts`, `windows/setup-command.ts`, `PI_GUI_WIN_TAG`, native layout checks. Owner rerun (sequential): `npm run check` 727/727; Node 22 727/727. Accepted residuals: WF1 path-based removal keeps a one-syscall window; a forged record naming a live unrelated process blocks cleanup (reported, never killed). Round 2 review launched.

Round 2: seat A (`…windows-review-A-r2`) **not ready** — A-F1/F3/F4/F7 fixed, F5 admission fixed, F6/F8/F10 verified as far as possible here, F2 and F9 partial; seat B (`…-B-r2`) **ready after fixes**, B-F1–F5 fixed, `npm run check` 727/727. Accepted as WG1–WG7: WG1 orphan sweep trusts the writable runtime `owner.json` copy for kills (forge both files → victim killed); WG2 stale-lease recovery removes the leased container by name before checking its owner label (can delete a live owner's container); WG3 window list has no encoded-byte budget (350 × 64 Ki CJK titles exceed the 64 MiB line); WG4 screenshot base64 can exceed `RESPONSE_LIMITS.pngBase64Chars` (3600×3600 high-entropy); WG5 lease token leaks when the lock release fails after publication (both seats); WG6 walk truncation not reflected in `truncated`; WG7 blank line at `src/backends/windows/local-session.ts:242`. Fix run WG-r1 launched.

Fix WG-r1 (`claude-opus-5-5`, handoff `plans/handoffs/windows-WG.md`): kill authorization only from the client's own session record; stale-lease recovery inspects and removes by immutable ID only for the dead lease owner; window list byte budget + `truncated`; screenshot downscale to the client base64 limit or `TOO_LARGE`; lease relinquished when the lock release fails after publication; walk truncation propagated; blank line removed. Owner rerun (sequential): `npm run check` 735/735; Node 22 735/735; `git diff --check` clean. Round 3 review launched.
