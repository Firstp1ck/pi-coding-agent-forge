# Implementation plan: GUI Testing for Pi — Milestone M1

Status: planned · created 2026-10-23 · integration owner: main session (Claude, T3 thread `5dbb22a5-ffe4-446e-8cf3-2f6cd8db20be`)

- Spec (source of truth for behaviour): [gui-testing-spec.md](gui-testing-spec.md)
- Final report (created at completion): `../../reports/gui-testing-m1.html`
- Later milestones (M1b dependency cache, M1c Docker Desktop hosts, M2–M5) get their own plans.

## 1. Classification

**Complex** (feature-development-workflow). Evidence:

- Three independently verifiable slices: TypeScript extension framework, Python helper + image, and the `docker-linux` backend that joins them.
- Crosses a contract boundary (helper JSON-lines protocol between TypeScript and Python).
- Material security and reliability risk: isolation from the host desktop, container hardening, cleanup after crashes.

## 2. Goal and success criteria

Deliver the M1 row of spec §11: tool interface + `docker-linux` on Linux hosts + setup/doctor framework + cleanup + usage check.

Measurable success criteria (all verified on EndeavourOS, Docker 29.9.1, Node 22.23.4, Pi 1.4.0):

| ID | Criterion | Verified by |
|---|---|---|
| S1 | `/gui-setup docker-linux --fix` on a host with Docker completes with **zero prompts** and ends with one summary | manual run in Pi TUI + transcript |
| S2 | Every `docker-linux` check in spec §5.4 exists, returns `pass/warn/fail/blocked` with an observed value, and has the listed remediation | unit tests with stubbed command runner |
| S3 | Smoke test (spec §5.5) passes: GTK 3 test app found by name, click changes label, screenshot valid and non-uniform, footprint audit empty | `/gui-setup` run + e2e test |
| S4 | GTK 4, PySide6, and Electron sample apps: snapshot → act by ref → screenshot works | e2e acceptance script |
| S5 | A Tkinter sample app reports `coverage: "none"` and is operable by coordinates | e2e acceptance script |
| S6 | `isolation.inspect` rejects a container with any forbidden mount/flag (privileged, docker socket, X11/Wayland socket, host D-Bus, host network) | unit tests + one live negative test |
| S7 | After `gui_stop`, after Pi exit, and after `SIGKILL` of Pi followed by restart, the footprint audit (spec §7a.4, client + Docker scope) is empty | e2e cleanup tests |
| S8 | Loop signals (spec §8.1) fire at the specified thresholds and never block a tool call | unit tests |
| S9 | Tools refuse to run when `docker-linux` is not verified, with the spec's error text | unit test |
| S10 | Project is mounted read-only in `mount` mode; `copy` mode honours spec §4.7 exclusions | e2e test + unit tests for the file-set builder |
| S11 | `npm run check` (typecheck + unit tests) and the helper's Python tests pass | CI-style local run |
| S12 | README, TECHNICAL, DEVELOPMENT updated for implemented behaviour; status notes adjusted | doc checks from repo `AGENTS.md` |

## 3. Scope

In scope (M1):

- Extension entry (`index.ts`), tool registration for `gui_launch`, `gui_wait`, `gui_snapshot`, `gui_screenshot`, `gui_act`, `gui_logs`, `gui_stop`, `gui_export`.
- Commands `/gui-setup`, `/gui-doctor`, `/gui-backend`, `/gui-usage`, `/gui-cleanup`, `/gui-reset`, `/gui-export`.
- Check framework, remediation plan, flag parsing, config files and precedence (spec §5, §7).
- Client-side data lifecycle: session temp dirs, startup sweep, footprint audit for client + local Docker (spec §7a.2, §7a.4).
- Usage and loop check (spec §8.1).
- Linux helper (Python), base Dockerfile, GTK 3 smoke-test app, sample apps for acceptance.
- `docker-linux` backend for Linux hosts, `mount` and `copy` workspace modes.

Non-goals for M1 (later plans): dependency cache (M1b; in M1 `setup` commands run each session), Docker Desktop hosts (M1c), `local-linux`, remote backends, `cua`, Windows backends, sync over SSH.

## 4. Approved decisions and invariants

All decisions D1–D7 and Q5–Q7 in the spec are approved by the user (2026-10-23). Invariants every workstream must preserve:

1. **Never foreground** (R5): no code path starts a GUI process with the host's `DISPLAY`/`WAYLAND_DISPLAY`. The Docker backend never mounts host display sockets.
2. **No automatic backend switching** (R6).
3. **No install without consent** (R9): remediation runs only after one confirmation or `--fix`.
4. **No project data in images or build context** (spec §4.1).
5. **Cleanup is idempotent** and runs from every exit path; the startup sweep never touches a live owner's resources.
6. **Extension factory starts nothing** (Pi contract); long-lived resources start from commands/tools and stop in `session_shutdown`.
7. **Protocol is versioned**; mismatched `hello` fails closed.
8. **Tk is assumed to have no accessibility tree** (Tk 9.1 not installed).

## 5. Contracts frozen before Wave 1 (owner, Wave 0)

The integration owner writes these files first; workers treat them as read-only and request changes through their handoff file.

| File | Content |
|---|---|
| `src/protocol.ts` | Protocol version constant, request/response types for `hello, ping, launch, wait, snapshot, screenshot, act, windows, stop`, framing constants (`PI-GUI-TESTING-READY <token>`, line prefix), error codes (`STALE_REF`, `NOT_FOUND`, `TIMEOUT`, `HANDOFF`, `PROTOCOL_MISMATCH`) |
| `docs/protocol.md` | Same contract in prose + JSON examples for the Python side (moved into `DEVELOPMENT.md` at the end) |
| `src/backend.ts` | `Backend` interface: `id`, `checks()`, `startSession(opts)`, `Session` (`request()`, `sync?`, `stop()`, `auditFootprint()`) |
| `src/checks/types.ts` | `Check`, `CheckResult`, `Remediation` types from spec §5.3 plus `blocked` status and `dependsOn` |

## 6. Workstreams and ownership

One writer per path. Shared files not listed are owner-only.

| WS | Owner | Paths (exclusive write) | Deliverable |
|---|---|---|---|
| W0 | integration owner | `src/protocol.ts`, `src/backend.ts`, `src/checks/types.ts`, `docs/protocol.md`, `package.json`, `tsconfig.json`, plan files | Frozen contracts, package scripts, test runner wiring |
| W1 | worker A (TypeScript) | `src/framing/`, `src/config/`, `src/checks/` (except `types.ts`), `src/setup/`, `src/cleanup/`, `src/usage/`, `src/runner/`, `tests/unit/**` | Framework: framing codec, config + precedence + flag parser, check runner (dependency order, parallelism, timeouts, `blocked`), remediation plan + confirm flow, client temp dirs + `owner.json` + startup sweep + client audit, usage/loop detector, command-runner abstraction with a fake for tests |
| W2 | worker B (Python + Docker) | `helpers/linux/**`, `testapps/**`, `tests/helper/**` | Python helper implementing the full protocol on Xvfb + AT-SPI + xdotool, teardown on stop/EOF/SIGTERM/SIGHUP/heartbeat timeout, screen-reader flag on the private bus, base Dockerfile (Debian slim, labels, non-root friendly), GTK 3 smoke app, GTK 4 / PySide6 / Electron / Tk sample apps with their `setup` commands |
| W3 | worker C (TypeScript, after W1+W2) | `src/backends/docker-linux.ts`, `src/backends/docker/**`, `src/tools/**`, `src/commands/**`, `index.ts`, `tests/e2e/**` | `docker-linux` backend (image build, hardened `docker run`, `isolation.inspect`, labels, mount/copy modes, file-set builder per spec §4.7, Docker-scope audit and teardown), tool + command registration, smoke test, e2e acceptance tests |
| W4 | integration owner | `README.md`, `TECHNICAL.md`, `DEVELOPMENT.md`, root `README.md` catalog line | Documentation for implemented behaviour |

W1 and W2 are the two independent implementation outcomes required by the contract; W3 is a third.

Worker launch: T3 `delegate_task`, models chosen at launch from `orchestrator_capabilities` per the user's routing policy (backend/large-context work: `gpt-6.1-sol`; fallback Claude Opus 5.5). Each worker prompt includes this plan, the spec, its exclusive paths, and its handoff path.

## 7. Execution order (DAG)

```
W0 contracts ──┬──► W1 framework (TS) ──┐
               └──► W2 helper + image ──┴──► W3 docker-linux + tools + e2e ──► Integration ──► W4 docs ──► Review quorum ──► Fixes + revalidation ──► Report
```

| Wave | Runs | Gate to next wave |
|---|---|---|
| 0 | W0 | Contracts committed to the working tree; `npm run typecheck` passes |
| 1 | W1 ∥ W2 | Both handoffs present; W1 unit tests pass; W2 helper tests pass inside the built image |
| 2 | W3 | e2e smoke passes locally |
| 3 | Integration + W4 | All acceptance checks in §8 recorded |
| 4 | Review quorum (2 fresh read-only reviewers) | Every finding dispositioned; accepted fixes revalidated |
| 5 | Report | HTML report saved and linked |

## 8. Acceptance checks

| Check | Command / method | Covers |
|---|---|---|
| Typecheck | `npm run typecheck` | all TS |
| Unit tests | `node --experimental-strip-types --test tests/unit/*.test.mjs` | S2, S8, S9, S10 (file set) |
| Helper tests | `docker run --rm <base-image> python3 -m pytest /opt/pi-gui-testing/tests` (no network) | protocol, teardown, framing noise tolerance |
| e2e smoke | `node --experimental-strip-types --test tests/e2e/smoke.test.mjs` | S3, S6 live negative, S7 |
| e2e apps | `node --experimental-strip-types --test tests/e2e/apps.test.mjs` | S4, S5 |
| Crash sweep | e2e test: spawn Pi-equivalent harness, `SIGKILL`, restart, audit | S7 |
| Pi live | manual: `pi -e ./pi-extension-gui-testing/index.ts`, run `/gui-setup docker-linux --fix`, ask Pi to test the GTK 3 app | S1, S3 |
| Pi print mode | `pi -p "/gui-doctor docker-linux"` | verifies spec §5.2 "Modes" assumption |
| Image in tool result | confirm the screenshot reaches the model as an image block in the live run | spec §8 |
| Docs | `git diff --check -- '*.md'`, link check, TECHNICAL scan per `AGENTS.md` | S12 |

## 9. Integration and rollback

- Integration owner reviews each worker's actual diff and evidence (not the claim), runs every check in §8 on the merged tree, and records results in §12.
- Conflicts are resolved against the spec; any change to a frozen contract goes through the owner and is recorded in §11.
- Rollback: the package is unpublished; revert by removing the package directory changes in Git. Runtime rollback for users: `/gui-reset docker-linux` removes images/containers by label; `docker image rm $(docker image ls -q --filter label=pi-gui-testing.base)` as manual fallback.

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Electron needs Chromium sandbox features unavailable in an unprivileged container | S4 fails | Launch Electron with `--no-sandbox` inside the container only; container stays unprivileged; document |
| `--user <uid>` without a passwd entry breaks apps expecting `$HOME` | app crashes | tmpfs `$HOME`, `HOME` env, `nss_wrapper` or generated passwd entry |
| GTK 4 / Qt only expose AT-SPI when the a11y bus is up and flagged | empty tree | helper starts `at-spi-bus-launcher` and sets `IsEnabled`/`ScreenReaderEnabled` before launch (spec §4.2) |
| Pi 1.4.0 may not run extension commands in print mode | S1 automation path | verify in Wave 3; document RPC path if not |
| Tool results may not render image blocks for every model | Pi cannot see screenshots | verify in live run; fallback: return path + `read` hint |
| Docker build needs network for Debian packages | offline setup fails | `docker.egress`-style warning; clear error |
| Startup sweep killing a live session's resources | data loss / broken session | owner liveness via PID + process start time; unit tests for PID reuse |
| Helper and TS drift on protocol | runtime failures | frozen `src/protocol.ts` + `docs/protocol.md`; `hello` version check; contract tests on both sides |

## 11. Decision and change record

| Date | Decision | By |
|---|---|---|
| 2026-10-23 | Spec decisions D1–D7, Q5–Q7 approved | user |
| 2026-10-23 | Tk 9.1 assumed not installed; Tk always coordinates | user |
| 2026-10-23 | Feature classified complex; M1 planned as W0–W4 | integration owner |

## 12. Progress record

| Wave | Status | Evidence |
|---|---|---|
| Plan review | reviews complete, dispositions recorded; accepted fixes awaiting user approval before spec/plan edits | §13.1 |
| 0 | not started | |
| 1 | not started | |
| 2 | not started | |
| 3 | not started | |
| 4 | not started | |
| 5 | not started | |

## 13. Reviews

### 13.1 Pre-implementation review of spec + plan (requested by user)

| Run | Provider / model | Task id | Status |
|---|---|---|---|
| R-pre-1 | Claude / `claude-fable-5-1` | — | launch failed 2026-10-23: `delegate_task` → `parent_not_active` (2 attempts, clientRequestId `gui-testing-m1-prereview-fable-r1`) |
| R-pre-2 | Codex / `gpt-6-astra` | — | launch failed 2026-10-23: `delegate_task` → `parent_not_active` (2 attempts, clientRequestId `gui-testing-m1-prereview-astra-r1`) |
| R-pre-3 | Claude / `claude-fable-5-1` | `…delegate-task%3Agui-testing-m1-prereview-fable-r2` | completed 2026-10-23: **ready after fixes**, 22 findings (F1–F22) |
| R-pre-4 | Codex / `gpt-6-astra` | `…delegate-task%3Agui-testing-m1-prereview-astra-r2` | completed 2026-10-23: **ready after fixes**, 14 findings (F1–F14) + 1 unverifiable item |

Both reviewers returned **ready after fixes**. Each finding was verified by the integration owner against the spec/plan text, the scaffold, Pi 1.4.0 sources (`dist/modes/print-mode.js`, `dist/core/agent-session.js`, `dist/core/extensions/types.d.ts`, `docs/extensions.md`), `.gitignore`, and the host (`docker context ls`, `/tmp/.X11-unix`, `/run/user/1000`). IDs: `A-Fn` = Astra (R-pre-4), `B-Fn` = Fable (R-pre-3). Overlapping findings are merged into one fix (`X#`). Status of every row: approved by user? **pending**.

| Fix | Findings | Sev | Verified evidence | Disposition | Fix summary |
|---|---|---|---|---|---|
| X1 | A-F1, B-F2, B-F15 | high | spec l.530 `docker exec -i`; l.646–651 teardown ends with `docker rm -f` which an in-container helper cannot run (no Docker socket, l.69–71); S7 needs empty audit after SIGKILL with no restart | accepted | Helper is the container entrypoint (PID 1 via `tini`), `docker run -i --rm`; EOF/heartbeat timeout → helper exits → `--rm` removes container. `docker exec` only for diagnostics. Two crash tests: restart within 10 s (sweep path) and after 90 s (helper path); test-only env var shortens heartbeat |
| X2 | A-F6, B-F1, B-F17 | high | spec l.57 vs l.63–64 (`--user` + read-only `/workspace`); `/deps` defined only in M1b §4.8; no writable `XDG_RUNTIME_DIR` for containers | accepted | M1: uid-owned tmpfs `/deps` (same path M1b fills from cache), fixed env (`VIRTUAL_ENV=/deps/venv`, `PATH`, `npm_config_prefix`, `PYTHONUSERBASE`), `setup` cwd `/workspace` run as host UID via `sh -c`; tmpfs `HOME`, `/tmp`, `/scratch`, `/run/user/<uid>` with explicit `uid,gid,mode`; generated passwd entry; §4.2 env block applies in-container |
| X3 | A-F2, B-F18 | high | protocol (spec l.538–548) has no request ids, error envelope, setup/exec message, app-log stream, cancel, or full-tree transfer, yet M1 needs `setup`, `gui_logs`, full dumps, heartbeats during long ops | accepted | Wave 0 protocol adds: `id` correlation, `{ok,error{code,message}}` envelope, `exec` (setup) with exit status, `log` events (bounded), `cancel`, snapshot full-tree file transfer; heartbeat bypasses the per-session queue; token via env `PI_GUI_TESTING_TOKEN`, READY within 10 s or fail |
| X4 | B-F4, A-F3 | high | spec l.69–71 omits `--ipc/--pid/--userns=host`, `CapAdd`, `Devices`, env leakage, and ancestor-dir mounts | accepted | One W0-owned hardening constant used by unit tests and `isolation.inspect`: `Privileged=false`, `NetworkMode/IpcMode/PidMode/UsernsMode≠host`, `CapAdd` empty (plus `--cap-drop ALL`, `no-new-privileges`), `Devices` empty, canonical bind sources not equal to/ancestor of `/tmp/.X11-unix`, `/run/user`, `/run/dbus`, `/var/run`, `docker.sock`; `Env` has no `WAYLAND_DISPLAY`/host `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY` = private Xvfb. Project root that is `/`, `$HOME`, or an ancestor of those paths is refused. Bounded socket scan of the workspace (A-F3) — see X4b |
| X4b | A-F3 (socket inside workspace) | medium | container runs as host UID, so a Unix socket inside the read-only project mount stays connectable | accepted | Before `docker run` in mount mode: bounded `find -type s` walk (skips `.git`, `node_modules`, venvs; 5 s timeout) → refuse with path list; fixture test |
| X5 | B-F3 | high | S6 "live negative test" with X11/Wayland mount; host has live `X0`, `X1`, `wayland-1`, `bus` sockets | accepted | Negative tests use `docker create` only (never start) with dummy sources in the test temp dir, or flags needing no host socket; invariant 9: "never start a negative-test container" |
| X6 | A-F4 | high | spec §4.7 has no symlink, special-file, path-boundary, or allow/deny precedence rules | accepted | Root-relative matching; precedence `always-excluded < sync.allow`, `sync.deny` beats allow, dependency dirs never synced; non-dereferencing traversal; links escaping the root or pointing to an excluded target are dropped and counted; special files dropped; fixtures for each |
| X7 | A-F5 | high | `owner.json` lacks boot id and resource manifest; no rule for partial records or labelled objects without a temp dir | accepted | `owner.json` written atomically (tmp + rename): `{pid, processStartTime, bootId, clientId, piSessionId, backend, resources[]}`; Docker objects labelled `pi-gui-testing.session` + `pi-gui-testing.owner=<clientId:pid:bootId>`; malformed/partial record → skip and report, never delete a live owner; labelled objects with dead owner swept even without a dir |
| X8 | A-F7 | high | no locality check; `docker context ls` shows only local default here, but a remote context/`DOCKER_HOST` would pass every check | accepted | New required check `docker.endpoint`: active context endpoint is `unix://`; endpoint frozen per session and passed as `--context`/`-H` to every call |
| X9 | A-F8, B-F6 | medium | spec l.290–292 vs l.595–597 contradict | accepted | §5.2 step 1: `flags → .pi/gui.local.json → global → environment → prompt`; `.pi/gui.json` only shared fields; one field table shared by setup and launch |
| X10 | A-F9 | medium | §7a.4 exempts live sessions only for the temp-dir row; two sessions allowed (§8) | accepted | Post-`gui_stop` audit is session-scoped; doctor/sweep audits report only orphans across all resource types; two-session e2e test |
| X11 | A-F10 | medium | §5.1 doctor "without changing anything" vs §5.3 "no side effects" vs `isolation.inspect` test container; stale state points to doctor | accepted | Define: doctor makes no remediation/config-choice changes, may create bounded labelled test resources (cleaned + audited), refreshes verified state on success, marks backend unverified on failure; checks split into `observe` and `probe` kinds |
| X12 | A-F11, B-F5, B-F12 | medium | `tests/unit/**` W1-exclusive while S2/S6/S10 test W3 code; smoke test placed in `src/setup/` (W1) but delivered by W3; config/usage/runner types not frozen | accepted | W3 owns `tests/unit/backends/**` and `src/setup/smoke.ts`; W0 also freezes `src/config/types.ts`, `src/usage/types.ts`, `src/runner/types.ts`; S2 (docker checks), S6, S10 move to W3 |
| X13 | A-F12, B-F7, B-F19 | medium | print mode prints only last assistant text (`print-mode.js` l.110–122), JSON/print have no UI (`extensions.md` l.365); `pi -p` line lacks `-e`; helper-test command lacks `--network none`; `check` is typecheck only; glob not recursive | accepted | Commands branch on `ctx.hasUI`; report via `pi.sendMessage(display:true)` + stdout fallback in print/json; acceptance asserts stdout content; helper tests `docker run --rm --network none -v <tests>:ro`; `check = typecheck && test`, recursive glob, `test:e2e` script; every command states cwd and `-e ./index.ts` |
| X14 | B-F8, A-F13 (cancel part) | medium | `ctx.signal` undefined when not streaming (`types.d.ts` l.239; `extensions.md` l.238) | accepted; **needs verification** for the cancel command | Setup owns an `AbortController` aborted by `session_shutdown`, dialog `signal`/timeout, and `/gui-cleanup`; aborted image build leaves no labelled image/build container. Whether a second command can run while a command handler is active must be verified in Wave 0 |
| X15 | A-F13 (remaining) | medium | `docker.version` "minimum tested" unspecified (spec l.365); no acceptance for idle expiry, session limit, version drift, live-owner preservation, real Pi exit | accepted; floor value **needs verification** | Proposed floor: server ≥ 29.0 (only tested major), warn on untested; add the listed tests incl. one real `pi` exit/reload cleanup case |
| X16 | A-F14, B-F9 | medium | `package.json` `files` omits `helpers`, `testapps`, `skills`; `pi` has no `skills`; plan omits the bundled skill (spec §9) | accepted | W0 fixes `files` + `pi.skills`; skill added to M1 (owner W4); `npm pack --dry-run` acceptance check for runtime assets |
| X17 | B-F10 | medium | spec §4.1 package list lacks PyGObject GTK 3/4, Qt/xcb, Electron libs | accepted | Full apt set in the W2 Dockerfile, documented in DEVELOPMENT; image contract test (`import gi, pyatspi`, `ldconfig -p` for Electron libs); pin Debian base tag |
| X18 | B-F11 | medium | only `pi-gui-testing.session` label defined; plan l.127 uses undefined `pi-gui-testing.base`; `image.base` "label version" unspecified | accepted | Labels `pi-gui-testing.base=true`, `.version`, `.protocol` on the base image; session objects `pi-gui-testing.session` + `.owner`; base image never carries the session label |
| X19 | B-F13 | medium | mount mode exposes `.env*`/keys to a networked container running `setup`; §4.7 applies only to copy/remote | accepted (warning); tmpfs shadowing **deferred** | Spec §4.1 + TECHNICAL + README safety note; recommend `copy` or `network: "none"` for untrusted setup. Shadowing secret paths in mount mode deferred to a later plan (changes approved default behaviour) |
| X20 | B-F14 | medium | Node `exit` allows sync work only; print mode's SIGTERM/SIGHUP handlers call `process.exit` (`print-mode.js` l.31–45); `session_shutdown` reasons verified (`types.d.ts` l.639) | accepted | Primary path `session_shutdown`; `exit` handler uses bounded `spawnSync docker rm -f`; no extension SIGINT handler; crash case covered by X1 + sweep |
| X21 | B-F16 | medium | `/gui-export` (and `/gui-cleanup`) missing from spec §5.1 table | accepted | Add both rows to §5.1 |
| X22 | B-F20 | low | `git check-ignore` matches `archive/`, `reports/`, but not `pi-extension-gui-testing/plans/handoffs/` | accepted | Add the path to root `.gitignore` in W0 |
| X23 | B-F21 | low | `dist/index.d.ts` l.2 exports `getAgentDir`, `VERSION` | accepted | Global config at `join(getAgentDir(), "gui", "config.json")`; `pi.version` uses `VERSION` |
| X24 | B-F22 | low | plan l.105 names no reviewer model; user policy requires Fable | accepted | Wave 4: Claude seat `claude-fable-5-1` + one Codex reviewer |
| X25 | A unverifiable item | medium | `grep` finds D1–D7 only at plan l.54, l.146; neither document defines them | **needs verification** (user) | User to point to the D1–D7 record; otherwise replace with "all spec decisions as of 2026-10-23" |
| X26 | owner | low | spec §5.4 `sync.exclusions` cites "§4.3" for secret patterns; patterns are in §4.7 | accepted | Fix cross-reference |

Rejected: none. Reviewer unverifiable items carried into Wave 0/2 checks: print-mode stdout for custom messages, image blocks reaching the model, non-root Xvfb + AT-SPI in Debian slim, Electron `--no-sandbox` under the default seccomp profile, `docker rm -f` racing `--rm`.

### 13.2 Post-integration review quorum (Wave 4)

Not started.

## 14. Worker handoff artifacts

Each worker writes only its own file:

- `plans/handoffs/m1-W1.md`
- `plans/handoffs/m1-W2.md`
- `plans/handoffs/m1-W3.md`

Required content: identity/status, changed files with summary, commands run with exit codes, validation omissions, deviations and assumptions, unresolved decisions, residual risks, integration notes.
