# Implementation plan: GUI Testing for Pi — Milestone M1

Status: implemented, Docker acceptance pending · created 2026-10-23 · integration owner: main session (Claude Opus 5.5, T3 thread `9e87038e-81a8-40bd-aa24-502d4581cc1a`; took over from thread `5dbb22a5-ffe4-446e-8cf3-2f6cd8db20be` on 2026-10-24)

- Spec (source of truth for behaviour): [gui-testing-spec.md](gui-testing-spec.md)
- Final report (created at completion): `../../reports/gui-testing-m1.html`
- Later milestones (M1b dependency cache, M1c Docker Desktop hosts, M2–M5) get their own plans. Windows work that M1 must not block is listed in §15.

## 1. Classification

**Complex** (feature-development-workflow). Evidence:

- Three independently verifiable slices: TypeScript extension framework, Python helper + image, and the `docker-linux` backend that joins them.
- Crosses a contract boundary (helper JSON-lines protocol between TypeScript and Python).
- Material security and reliability risk: isolation from the host desktop, container hardening, cleanup after crashes.

## 2. Goal and success criteria

Deliver the M1 row of spec §11: tool interface + `docker-linux` on Linux hosts + setup/doctor framework + cleanup + usage check.

Measurable success criteria (all verified on EndeavourOS, rootful Docker 29.9.1, Node 22.23.4 — within the repo `engines` range; the repo pin in `.node-version` is 24.22.1 — and Pi 1.4.0):

| ID | Criterion | Verified by |
|---|---|---|
| S1 | `/gui-setup docker-linux --fix` on a host with Docker completes with **zero prompts** and ends with one summary | manual run in Pi TUI + transcript |
| S2 | Every check in spec §5.4 (common + `docker-linux`, incl. `docker.endpoint`, `docker.rootless`, `docker.bind-uid`, and `docker.version` ≥ 29.0) exists, returns `pass/warn/fail/blocked` with an observed value, and has the listed remediation | unit tests with stubbed command runner (framework: W1; `docker-linux` checks: W3) |
| S3 | Smoke test (spec §5.5) passes: GTK 3 test app found by name, click changes label, screenshot valid and non-uniform, footprint audit empty | `/gui-setup` run + e2e test |
| S4 | GTK 4, PySide6, and Electron sample apps: snapshot → act by ref → screenshot works | e2e acceptance script |
| S5 | A Tkinter sample app reports `coverage: "none"` and is operable by coordinates | e2e acceptance script |
| S6 | `isolation.inspect` rejects every violation of the spec §4.1 hard-rule list; mount mode refuses a workspace containing a Unix socket and a forbidden project root | unit tests over the shared hard-rule constant + live negative tests that use `docker create` only and never start the container |
| S7 | Footprint audit (spec §7a.4, client + Docker scope) is empty after `gui_stop` and after a real `pi` exit and `/reload`. Crash cases: (a) `SIGKILL` of Pi, no restart → within 15 s no session container and no orphaned `docker` CLI process (helper EOF path); the client temp dir may remain; (b) Pi restarted afterwards → the startup sweep removes the temp dir and the audit is empty; (c) `SIGSTOP` of Pi with a shortened test heartbeat → the helper tears down via the heartbeat path; after `SIGCONT` the audit is empty | e2e cleanup tests |
| S8 | Loop signals (spec §8.1) fire at the specified thresholds and never block a tool call | unit tests |
| S9 | Tools refuse to run when `docker-linux` is not verified, with the spec's error text | unit test |
| S10 | Project is mounted read-only in `mount` mode; `copy` mode honours spec §4.7 exclusions, precedence, and link/special-file rules | e2e test + unit tests for the file-set builder with fixtures: external link, link to a secret, nested secret file and dir at any depth (`services/api/.env`, `fixtures/.ssh/key`), tracked dependency dir, conflicting allow/deny |
| S11 | `npm run check` (typecheck + unit tests) and the helper's Python tests pass | CI-style local run |
| S12 | README, TECHNICAL, DEVELOPMENT, and the bundled skill updated for implemented behaviour, including the mount-mode privacy warning; status notes adjusted | doc checks from repo `AGENTS.md` |
| S13 | Setup cancellation after resource creation, idle timeout, `maxConcurrentSessions`, version drift (stale → `/gui-doctor`), and a second live session are handled per spec; stopping one of two sessions leaves the other usable and its audit clean | unit tests + e2e tests |
| S14 | The packed package contains the extension, helper, Dockerfile, test apps, and skill, and the skill is registered | `npm pack --dry-run` listing check |
| S15 | Commands without UI never prompt; print mode writes the report to stderr, JSON mode emits it as a custom message, and a failed required check sets exit code 1 | `pi -p` and `pi --mode json` runs asserting stderr content, valid JSONL containing the report, and the exit code |

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

All decisions in the spec's decision record (spec §3a: D1–D8, Q5–Q7, T1) are approved by the user (2026-10-23), as are the review fixes X1–X26 (2026-10-23) and Y1–Y19 (2026-10-24) in §13.1. Invariants every workstream must preserve:

1. **Never foreground** (R5): no code path starts a GUI process with the host's `DISPLAY`/`WAYLAND_DISPLAY`. The Docker backend never mounts host display sockets.
2. **No automatic backend switching** (R6).
3. **No install without consent** (R9): remediation runs only after one confirmation or `--fix`.
4. **No project data in images or build context** (spec §4.1).
5. **Cleanup is idempotent** and runs from every exit path; the startup sweep never touches a live owner's resources.
6. **Extension factory starts nothing** (Pi contract); long-lived resources start from commands/tools and stop in `session_shutdown`.
7. **Protocol is versioned**; mismatched `hello` fails closed.
8. **Tk is assumed to have no accessibility tree** (Tk 9.1 not installed; spec §3a T1).
9. **Negative tests never start a container** that has a forbidden setting; they use `docker create` and remove it.
10. **Container lifetime follows the helper**: the helper is PID 1 under `tini` in a `docker run -i --rm` container; stdin EOF or heartbeat timeout ends the container without client action.
11. **No prompts without UI**: commands branch on `ctx.hasUI` and never call `select`/`confirm`/`input` without it.
12. **Rootful Docker only in M1**: rootless daemons fail `docker.rootless` with a clear message (support planned for M1c).

## 5. Contracts frozen before Wave 1 (owner, Wave 0)

The integration owner writes these files first; workers treat them as read-only and request changes through their handoff file.

| File | Content |
|---|---|
| `src/protocol.ts` | Protocol version constant; envelope (`id`, `ok`, `error{code,message}`); request/response types for `hello, ping, launch, wait, snapshot, snapshotFull, screenshot, act, windows, exec, cancel, stop`; screenshot result with `captureId`, `target`, `origin`, `scale`, optional `allBlack`; coordinate `act` bound to a `captureId` (stale → `STALE_REF`); `Leftover {kind: string; id: string; detail?: string}` with an open `kind`; helper invoked as an opaque executable; `log` event (stream, source, bounded data); framing constants (`PI_GUI_TESTING_TOKEN` env, `PI-GUI-TESTING-READY <token>`, 10 s ready timeout, line prefix); queue-bypass list (`ping`, `cancel`); heartbeat interval 15 s / timeout 60 s with a test-only override; error codes (`STALE_REF`, `NOT_FOUND`, `TIMEOUT`, `HANDOFF`, `PROTOCOL_MISMATCH`, `CANCELLED`) |
| `docs/protocol.md` | Same contract in prose + JSON examples for the Python side (moved into `DEVELOPMENT.md` at the end) |
| `src/backend.ts` | `Backend` interface: `id`, `checks()`, `startSession(opts)`, `Session` (`request()`, `sync?`, `stop()`, `auditFootprint()`) |
| `src/checks/types.ts` | `Check`, `CheckResult`, `Remediation` types from spec §5.3 incl. `kind` (`observe`/`probe`), `blocked` status, and `dependsOn` |
| `src/config/types.ts` | Schemas and defaults for `.pi/gui.json`, `.pi/gui.local.json`, global config, verified-backend record; shared-vs-personal field table; global path via `getAgentDir()` |
| `src/usage/types.ts` | `UsageEvent` (tool type, action, ref/coords, screenshot hash, optional `allBlack`), `UsageWarning` |
| `src/runner/types.ts` | `CommandRunner` interface (argv, timeout, abort signal, Docker endpoint) used by checks and the backend; fake implementations live with their tests |
| `src/hardening.ts` | The spec §4.1 hard-rule list and forbidden mount paths as data (incl. the `DISPLAY` predicate `^:[0-9]+$` and no `DBUS_SESSION_BUS_ADDRESS` in `Env`), consumed by `isolation.inspect` and its unit tests |
| `src/labels.ts` | Label keys and values (`pi-gui-testing.base`, `.version`, `.protocol`, `.session`, `.owner`) |
| `src/owner.ts` | `owner.json` record type (pid, processStartTime, bootId, clientId, piSessionId, backend, createdAt, resources[]) and the owner-label format `<clientId>:<pid>:<processStartTime>:<bootId>`; labels with fewer fields are reported, never swept |

## 6. Workstreams and ownership

One writer per path. Shared files not listed are owner-only.

| WS | Owner | Paths (exclusive write) | Deliverable |
|---|---|---|---|
| W0 | integration owner | `src/protocol.ts`, `src/backend.ts`, `src/checks/types.ts`, `src/config/types.ts`, `src/usage/types.ts`, `src/runner/types.ts`, `src/hardening.ts`, `src/labels.ts`, `src/owner.ts`, `docs/protocol.md`, `package.json`, `tsconfig.json`, root `.gitignore` line for `pi-extension-gui-testing/plans/handoffs/`, plan files | Frozen contracts; `package.json` `files` (+ `helpers`, `testapps`, `skills`) and `pi.skills`; scripts `check` = typecheck + unit tests, `test` with recursive glob, `test:e2e`; `engines` aligned with the repo root range; `@types/node` aligned with sibling packages |
| W1 | worker A (TypeScript) | `src/framing/`, `src/config/` (except `types.ts`), `src/checks/` (except `types.ts`), `src/setup/` (except `smoke.ts`), `src/cleanup/`, `src/usage/` (except `types.ts`), `src/runner/` (except `types.ts`), `tests/unit/**` (except `tests/unit/backends/**`) | Framework: framing codec, config + precedence + flag parser, check runner (dependency order, parallelism, timeouts, `blocked`), remediation plan + confirm flow, client temp dirs + `owner.json` + startup sweep + client audit, usage/loop detector, command-runner abstraction with a fake for tests |
| W2 | worker B (Python + Docker) | `helpers/linux/**`, `testapps/**`, `tests/helper/**` | Python helper implementing the full protocol on Xvfb + AT-SPI + xdotool, teardown on stop/EOF/SIGTERM/SIGHUP/heartbeat timeout, screen-reader flag on the private bus, base Dockerfile (pinned Debian slim tag, `ENTRYPOINT ["tini","--","/opt/pi-gui-testing/helper"]` with no `CMD`, labels per `src/labels.ts`, toolkit runtimes for GTK 3/4, Qt xcb, Electron, `setup` toolchain `python3-pip`/`python3-venv`/`nodejs`/`npm`; non-root friendly, uid-owned tmpfs layout per spec §4.1), helper creates `/deps/venv` with `--system-site-packages` before the first `setup`, plus an image contract test (`import gi, pyatspi`, `pip --version`, `npm --version`, venv creation, `ldconfig -p` for Electron libs), GTK 3 smoke app, GTK 4 / PySide6 / Electron / Tk sample apps with their `setup` commands |
| W3 | worker C (TypeScript, after W1+W2) | `src/backends/docker-linux.ts`, `src/backends/docker/**`, `src/sync/**`, `src/setup/smoke.ts`, `src/tools/**`, `src/commands/**`, `index.ts`, `tests/unit/backends/**`, `tests/e2e/**` | `docker-linux` backend (endpoint, rootless, and bind-uid checks, image build, hardened `docker run` with the helper as entrypoint, generated read-only `/etc/passwd` and `/etc/group`, `--shm-size=512m` for Electron/Chromium, `isolation.inspect`, labels, mount/copy modes, full-tree workspace socket scan (20 s bound, fail closed), file-set builder per spec §4.7, Docker-scope audit and teardown), tool + command registration with `ctx.hasUI` branching and no-UI reporting (print → stderr, JSON/RPC → custom message, `process.exitCode = 1` on failure), setup abort controller, smoke test, unit tests for its code, e2e acceptance tests |
| W4 | integration owner | `README.md`, `TECHNICAL.md`, `DEVELOPMENT.md`, `skills/gui-testing/**`, root `README.md` catalog line | Documentation and the bundled skill (spec §9) for implemented behaviour |

W1 and W2 are the two independent implementation outcomes required by the contract; W3 is a third.

Worker launch: T3 `delegate_task`, provider `claudeAgent`, model `claude-opus-5-5` for every implementation worker (user decision 2026-10-24), shared checkout, one writer per path. W0 and W4 stay with the integration owner. Each worker prompt includes this plan, the spec, its exclusive paths, and its handoff path.

## 7. Execution order (DAG)

```
W0 contracts ──┬──► W1 framework (TS) ──┐
               └──► W2 helper + image ──┴──► W3 docker-linux + tools + e2e ──► Integration ──► W4 docs ──► Review quorum ──► Fixes + revalidation ──► Report
```

| Wave | Runs | Gate to next wave |
|---|---|---|
| 0 | W0 | Contracts committed to the working tree; `npm run typecheck` passes; two live Pi spikes recorded in §12: (a) a stub command's report reaches stderr under `pi -p`, appears as a custom message in valid JSONL under `--mode json`, and `process.exitCode = 1` survives to the process exit code, (b) whether a second command can run while a command handler is still running (decides whether `/gui-cleanup` can cancel setup) |
| 1 | W1 ∥ W2 | Both handoffs present; W1 unit tests pass; W2 helper tests pass inside the built image |
| 2 | W3 | e2e smoke passes locally |
| 3 | Integration + W4 | All acceptance checks in §8 recorded |
| 4 | Review quorum (2 fresh read-only reviewer runs, both Codex `gpt-6.1-sol`, user decision 2026-10-24; same-model fallback recorded as the user's explicit choice) | Every finding dispositioned; accepted fixes revalidated |
| 5 | Report | HTML report saved and linked |

## 8. Acceptance checks

All commands run from `pi-extension-gui-testing/` unless stated otherwise.

| Check | Command / method | Covers |
|---|---|---|
| Typecheck | `npm run typecheck` | all TS |
| Unit tests | `npm test` (= `node --experimental-strip-types --test "tests/unit/**/*.test.mjs"`) | S2, S6 (rules), S8, S9, S10 (file set), S13 (unit parts) |
| Helper unit tests | `docker run --rm --network none --entrypoint python3 -v "$PWD/tests/helper:/tests:ro" <base-image> -m unittest discover -s /tests -v` (stdlib `unittest`, so the production image carries no test framework) | protocol, envelope, framing noise tolerance |
| Helper entrypoint test | test client starts `docker run -i --rm --network none <base-image>` exactly as production does and checks READY, `hello`, EOF teardown, and heartbeat teardown with the shortened test timeout | X1, Y7, Y10 |
| Image contract | `docker run --rm --network none --entrypoint sh <base-image> -c 'python3 -c "import gi, pyatspi" && pip --version && npm --version && python3 -m venv --system-site-packages /tmp/v && ldconfig -p \| grep -q libnss3'` | S3, S4 prerequisites |
| e2e smoke | `npm run test:e2e -- tests/e2e/smoke.test.mjs` | S3, S6 live negatives (`docker create` only), S7 |
| e2e apps | `npm run test:e2e -- tests/e2e/apps.test.mjs` | S4, S5 |
| e2e lifecycle | `npm run test:e2e -- tests/e2e/lifecycle.test.mjs`: S7 crash cases (a)–(c), two concurrent sessions, idle timeout, cancel after resource creation, owner-label PID reuse without a temp dir | S7, S13 |
| Pi exit | manual: `pi -e ./index.ts`, start a session, `/reload`, then quit; audit with `/gui-doctor` and `docker ps -a --filter label=pi-gui-testing.session` | S7 |
| Pi live | manual: `pi -e ./index.ts`, run `/gui-setup docker-linux --fix`, ask Pi to test the GTK 3 app | S1, S3 |
| Pi no-UI modes | `pi -e ./index.ts -p "/gui-doctor docker-linux"`: assert stderr contains the check table and the exit code is 0 (1 with a required check forced to fail); `pi -e ./index.ts --mode json -p "/gui-doctor docker-linux"`: assert stdout is valid JSONL and contains the report as a custom message | S15 |
| Package contents | `npm pack --dry-run --json` lists `index.ts`, `src/`, `helpers/linux/Dockerfile`, the helper, `testapps/`, `skills/gui-testing/SKILL.md` | S14 |
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
| Chromium/Electron crash with the 64 MB default `/dev/shm` | S4 fails | `--shm-size=512m` for these apps, or `--disable-dev-shm-usage`; verified in S4 |
| Rootless Docker users cannot use M1 | setup fails for them | `docker.rootless` fails with a clear message; TECHNICAL lists the requirement; support planned for M1c |
| `--user <uid>` without a passwd entry breaks apps expecting `$HOME` | app crashes | uid-owned tmpfs `$HOME` and `XDG_RUNTIME_DIR`, `HOME` env, passwd entry generated by the helper at start (spec §4.1) |
| GTK 4 / Qt only expose AT-SPI when the a11y bus is up and flagged | empty tree | helper starts `at-spi-bus-launcher` and sets `IsEnabled`/`ScreenReaderEnabled` before launch (spec §4.2) |
| In print/JSON mode Pi redirects extension stdout writes to stderr and reserves stdout | S15 fails | Report channel per mode (print → stderr, JSON/RPC → custom message), explicit `process.exitCode`; Wave 0 spike verifies all three |
| A second command may not run while a command handler is active | `/gui-cleanup` cannot cancel setup | Wave 0 spike; setup still aborts via dialog timeouts and `session_shutdown` |
| Tool results may not render image blocks for every model | Pi cannot see screenshots | verify in live run; fallback: return path + `read` hint |
| Docker build needs network for Debian packages | offline setup fails | `docker.egress`-style warning; clear error |
| Startup sweep killing a live session's resources | data loss / broken session | owner liveness via boot id + PID + process start time; malformed records never treated as dead; unit tests for PID reuse, other boot, partial record, another live Pi |
| Helper and TS drift on protocol | runtime failures | frozen `src/protocol.ts` + `docs/protocol.md`; `hello` version check; contract tests on both sides |

## 11. Decision and change record

| Date | Decision | By |
|---|---|---|
| 2026-10-23 | Spec decisions D1–D7, Q5–Q7 approved; written into spec §3a as the decision record | user |
| 2026-10-23 | Tk 9.1 assumed not installed; Tk always coordinates | user |
| 2026-10-23 | Feature classified complex; M1 planned as W0–W4 | integration owner |
| 2026-10-23 | `local-windows` uses `@iiwate/pi-silent-gui` as reference design and S1 test vehicle, not as a dependency (spec §3a D8, §4.5, S1, Q4) | user |
| 2026-10-23 | Pre-implementation review fixes X1–X26 approved and applied to spec and plan (§13.1); Docker server floor 29.0; second-command cancellation verified in Wave 0 | user |
| 2026-10-24 | W2 deviations accepted: image built from a staged tar context piped to `docker build -` instead of `--build-context` (no buildx on this host; still tooling-only); apps and `exec` run in their own process group under the helper; window refs `win:0x<id>`; `sha256` over raw RGB pixels; `wait` timeout → `matched: false`; `cancel` always `ok`; `stop` `ok: false` with process leftovers; `act` fallbacks and text formats; GTK 4 coordinates corrected by the window offset; AT-SPI cache cleared before each snapshot. `docs/protocol.md` and spec §4.1 updated accordingly | integration owner |
| 2026-10-24 | W1 deviations accepted: exit code 1 only without UI; the single remediation prompt is a `select` (apply all / review each / cancel); setup's own 10-minute dialog timer instead of Pi's `timeout`; `--fix` applies optional remediations only when the remediation step runs for a required failure; process resource ids `<pid>:<startTime>`. Spec §5.2 wording updated. Contract fix: `SessionError` rewritten without a parameter property (strip-types load failure reported by W1) | integration owner |
| 2026-10-24 | Implementation started; this thread is integration owner; implementation workers `claude-opus-5-5`; review quorum two `gpt-6.1-sol` runs (overrides the X24 Fable seat) | user |
| 2026-10-24 | Implementation continues on a Sailfish OS aarch64 host without Docker; Docker-dependent gates deferred to a Docker host and reported as unverified; skill drafted by owner ahead of W3 | integration owner |
| 2026-10-24 | Round 3 fixes Y1–Y19 approved and applied to spec, plan, README, TECHNICAL: decision `W1` renamed `D8`; no-UI reports on stderr (print) / custom message (JSON, RPC); rootless Docker refused in M1, support deferred to M1c | user |

## 12. Progress record

| Wave | Status | Evidence |
|---|---|---|
| Plan review | done 2026-10-24: round 2 fixes X1–X26 and round 3 fixes Y1–Y19 approved and applied | §13.1 |
| 0 | done 2026-10-24 | Contracts written: `src/protocol.ts`, `src/backend.ts`, `src/checks/types.ts`, `src/config/types.ts`, `src/usage/types.ts`, `src/runner/types.ts`, `src/hardening.ts`, `src/labels.ts`, `src/owner.ts`, `docs/protocol.md`, contract test `tests/contracts/owner-label.test.mjs`; `package.json` (`pi.skills`, `files`, scripts, `engines` = root range, `@types/node ^24.12.4`); root `.gitignore` ignores `pi-extension-gui-testing/plans/handoffs/` (`git check-ignore` confirmed). `npm run check` → typecheck exit 0, 2/2 tests pass. **Spike (a)** with a stub extension (`/tmp/gui-spike/spike.ts`): `pi -p "/spike-report ok"` → exit 0, stdout empty, `process.stdout.write` text and stderr text both on stderr, custom message not printed; `"/spike-report fail"` with `process.exitCode = 1` → exit 1; `--mode json` → exit 0, 3 valid JSONL records, custom message present in `message_start`/`message_end`. **Spike (b)** in `--mode rpc`: `/spike-slow` (8 s) started at 716 ms, `/spike-quick` sent ~3 s later ran at 3789 ms, slow ended at 8716 ms → a second command runs while a command handler is active, so `/gui-cleanup` can abort setup (X14 resolved). Extra finding: print mode reads stdin when it is not a TTY and hangs if stdin stays open; tests and docs must run `pi -p` with stdin closed (`</dev/null`). |
| 1 | done 2026-10-24, gate passed | **W1** (`claude-opus-5-5`, task `…gui-testing-m1-W1-r1`, handoff `plans/handoffs/m1-W1.md`): framing codec + protocol client, runner + fake, config + flags, check runner + common checks, setup flow/doctor/report emitter, client lifecycle (temp dir, owner.json, liveness, sweep, audits, exit cleanup), usage detector + session registry; wrote only W1 paths. Owner rerun: `npm run check` → typecheck exit 0, 105/105 tests. Spot checks: `emitReport` per mode, `ownerLiveness` rules. **W2** (`claude-opus-5-5`, task `…gui-testing-m1-W2-r1`, handoff `plans/handoffs/m1-W2.md`): Python helper, Dockerfile (`debian:trixie-20261020-slim` by digest), image `pi-gui-testing-base:dev` (`sha256:35eede09…`, ~803 MB, labels base/version/protocol, entrypoint `tini -- /opt/pi-gui-testing/helper`, no `CMD`), GTK 3 smoke app baked in, sample apps GTK 4 / PySide6 / Electron / Tk; wrote only W2 paths. W2 reports GTK 3/GTK 4/PySide6/Electron `coverage: full` with act-by-ref + screenshot, Tk `none` by coordinates, READY 0.3–1.1 s. Owner rerun: in-image `python3 -m unittest discover` → 33 OK; image contract one-liner → ok; `python3 tests/helper/host/test_entrypoint.py` (production `docker run` flags) → 15 OK in 17 s (smoke flow, stale refs/captureId, exec logs, cancel/ping bypass, EOF/heartbeat/SIGTERM/mismatch teardown); `docker ps -a --filter label=pi-gui-testing.session` → none left. Sample-app run (`test_apps.py`, 3 OK) taken from W2's evidence, not rerun. Contract fix by owner: `SessionError` without parameter property. |
| 2 | done 2026-10-24 on Sailfish host; Docker gate open | **W3** (`claude-opus-5-5`, effort high, task `…gui-testing-m1-W3-r1-sailfish`, handoff `plans/handoffs/m1-W3.md`): docker-linux backend (all §5.4 checks, staged-tar image build, hardened `docker run`, `isolation.inspect`, mount guards + socket scan, Docker audit/sweep), §4.7 file-set builder, 8 tools, 7 commands, smoke test, `index.ts`; no W0/W1/W2 file changed. **Host change:** this wave ran on a Sailfish OS 5.2 aarch64 device (Node 26.12.1, Python 3.11, Pi 1.3.0, no Docker, no sudo); W1/W2 handoffs did not carry over (gitignored). Owner rerun: `npm run check` → typecheck exit 0, 174/174; e2e (17 tests) skip with "docker CLI not found"; `process.test.mjs` (real processes, fake `docker`) 3/3; host helper tests 30 OK + 3 need PyGObject (in-image); `pi -p "/gui-doctor docker-linux" </dev/null` → exit 1, report on stderr; `--mode json` → valid JSONL with custom message; `npm pack --dry-run` lists extension, helper, Dockerfile, testapps, skill. Base digest `debian:trixie-20261020-slim@sha256:62bd…` verified to be a multi-arch OCI index incl. arm64v8 (registry query). **Not verified (needs rootful Docker 29+ host):** e2e smoke/apps/lifecycle, in-image helper tests, image contract, S1/S3/S4/S5/S6-live/S7/S13-e2e, live Pi 1.4.0 run, image block in a live model run. |
| 3 | done 2026-10-24 (integration + W4) | Owner reviewed W3 diff and handoff; resolved W3 open item 1 (arm64 digest). W4: `README.md`, `TECHNICAL.md` (M1 vs planned backends, check table, no-UI behaviour, tool overview, storage, mount/copy security, limits, troubleshooting), `DEVELOPMENT.md` (architecture, layout, invariants, implementation notes, test matrix, pre-publish steps, known gaps), `skills/gui-testing/SKILL.md`, root catalog line. `git diff --check` clean; fences balanced; relative links resolve. Deviation: `docs/protocol.md` stays a separate contributor doc linked from `DEVELOPMENT.md` because helper and client sources cite it (plan §5 said move). |
| 4 | done 2026-10-24 | Six review rounds by two `openai-codex/gpt-6.1-sol` seats (xhigh, read-only); fixes Z1–Z18, Q1–Q12, P1–P8 (`claude-opus-5-5` workers + owner), R1–R4, S1–S2, T1–T2 (owner, `claude-opus-5-5`). Final round: seat A **ready**, seat B **ready after fixes** (doc phrase, applied). Every finding dispositioned and revalidated; see §13.2 |
| 5 | done 2026-10-24 | Report `reports/gui-testing-m1.html`. **M1 code complete; Docker-dependent acceptance (S1, S3, S4, S5, S6 live, S7, S13 e2e, live Pi 1.4.0 run, image block in a live model run) still open** until the e2e suites run on a rootful Docker 29+ Linux host; see DEVELOPMENT.md "Before publishing" |

## 13. Reviews

### 13.1 Pre-implementation review of spec + plan (requested by user)

Scope includes the `local-windows` reference-design change (spec §4.5, §5.4 `helper.job`/`helper.nonelevated`, §7a.4, S1, Q4) and its effect on M1 contracts (§15).

| Run | Provider / model | Task id | Status |
|---|---|---|---|
| R-pre-1 | Claude / `claude-fable-5-1` | — | launch failed 2026-10-23: `delegate_task` → `parent_not_active` (2 attempts, clientRequestId `gui-testing-m1-prereview-fable-r1`) |
| R-pre-2 | Codex / `gpt-6-astra` | — | launch failed 2026-10-23: `delegate_task` → `parent_not_active` (2 attempts, clientRequestId `gui-testing-m1-prereview-astra-r1`) |
| R-pre-3 | Claude / `claude-fable-5-1` | `…delegate-task%3Agui-testing-m1-prereview-fable-r2` | completed 2026-10-23: **ready after fixes**, 22 findings (F1–F22) |
| R-pre-4 | Codex / `gpt-6-astra` | `…delegate-task%3Agui-testing-m1-prereview-astra-r2` | completed 2026-10-23: **ready after fixes**, 14 findings (F1–F14) + 1 unverifiable item |
| R-pre-5 | Claude / `claude-fable-5-1` | `…delegate-task%3Agui-testing-m1-prereview-fable-r3` | round 3 completed 2026-10-24: **ready after fixes**, 14 findings (F1–F14) |
| R-pre-6 | Codex / `gpt-6-astra` | `…delegate-task%3Agui-testing-m1-prereview-astra-r3` | round 3 completed 2026-10-24: **ready after fixes**, 11 findings (F1–F11) |

Both reviewers returned **ready after fixes**. Each finding was verified by the integration owner against the spec/plan text, the scaffold, Pi 1.4.0 sources (`dist/modes/print-mode.js`, `dist/core/agent-session.js`, `dist/core/extensions/types.d.ts`, `docs/extensions.md`), `.gitignore`, and the host (`docker context ls`, `/tmp/.X11-unix`, `/run/user/1000`). IDs: `A-Fn` = Astra (R-pre-4), `B-Fn` = Fable (R-pre-3). Overlapping findings are merged into one fix (`X#`). All rows approved by the user on 2026-10-23 and applied to the spec and this plan.

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
| X13 | A-F12, B-F7, B-F19 | medium | print mode prints only last assistant text (`print-mode.js` l.110–122), JSON/print have no UI (`extensions.md` l.365); `pi -p` line lacks `-e`; helper-test command lacks `--network none`; `check` is typecheck only; glob not recursive | accepted; reporting channel superseded by Y1 | Commands branch on `ctx.hasUI`; report via `pi.sendMessage(display:true)` + stdout fallback in print/json; acceptance asserts stdout content; helper tests `docker run --rm --network none -v <tests>:ro`; `check = typecheck && test`, recursive glob, `test:e2e` script; every command states cwd and `-e ./index.ts` |
| X14 | B-F8, A-F13 (cancel part) | medium | `ctx.signal` undefined when not streaming (`types.d.ts` l.239; `extensions.md` l.238) | accepted; cancel-command behaviour verified in Wave 0 (user: ok) | Setup owns an `AbortController` aborted by `session_shutdown`, dialog `signal`/timeout, and `/gui-cleanup`; aborted image build leaves no labelled image/build container. Whether a second command can run while a command handler is active must be verified in Wave 0 |
| X15 | A-F13 (remaining) | medium | `docker.version` "minimum tested" unspecified (spec l.365); no acceptance for idle expiry, session limit, version drift, live-owner preservation, real Pi exit | accepted; floor confirmed by user | Floor: server ≥ 29.0 (lowest tested major), warn on untested newer majors; add the listed tests incl. one real `pi` exit/reload cleanup case |
| X16 | A-F14, B-F9 | medium | `package.json` `files` omits `helpers`, `testapps`, `skills`; `pi` has no `skills`; plan omits the bundled skill (spec §9) | accepted | W0 fixes `files` + `pi.skills`; skill added to M1 (owner W4); `npm pack --dry-run` acceptance check for runtime assets |
| X17 | B-F10 | medium | spec §4.1 package list lacks PyGObject GTK 3/4, Qt/xcb, Electron libs | accepted | Full apt set in the W2 Dockerfile, documented in DEVELOPMENT; image contract test (`import gi, pyatspi`, `ldconfig -p` for Electron libs); pin Debian base tag |
| X18 | B-F11 | medium | only `pi-gui-testing.session` label defined; plan l.127 uses undefined `pi-gui-testing.base`; `image.base` "label version" unspecified | accepted | Labels `pi-gui-testing.base=true`, `.version`, `.protocol` on the base image; session objects `pi-gui-testing.session` + `.owner`; base image never carries the session label |
| X19 | B-F13 | medium | mount mode exposes `.env*`/keys to a networked container running `setup`; §4.7 applies only to copy/remote | accepted (warning); tmpfs shadowing **deferred** | Spec §4.1 + TECHNICAL + README safety note (spec applied in round 2; README/TECHNICAL applied in round 3 as Y9); recommend `copy` or `network: "none"` for untrusted setup. Shadowing secret paths in mount mode deferred to a later plan (changes approved default behaviour) |
| X20 | B-F14 | medium | Node `exit` allows sync work only; print mode's SIGTERM/SIGHUP handlers call `process.exit` (`print-mode.js` l.31–45); `session_shutdown` reasons verified (`types.d.ts` l.639) | accepted | Primary path `session_shutdown`; `exit` handler uses bounded `spawnSync docker rm -f`; no extension SIGINT handler; crash case covered by X1 + sweep |
| X21 | B-F16 | medium | `/gui-export` (and `/gui-cleanup`) missing from spec §5.1 table | accepted | Add both rows to §5.1 |
| X22 | B-F20 | low | `git check-ignore` matches `archive/`, `reports/`, but not `pi-extension-gui-testing/plans/handoffs/` | accepted | Add the path to root `.gitignore` in W0 |
| X23 | B-F21 | low | `dist/index.d.ts` l.2 exports `getAgentDir`, `VERSION` | accepted | Global config at `join(getAgentDir(), "gui", "config.json")`; `pi.version` uses `VERSION` |
| X24 | B-F22 | low | plan l.105 names no reviewer model; user policy requires Fable | accepted | Wave 4: Claude seat `claude-fable-5-1` + one Codex reviewer |
| X25 | A unverifiable item | medium | `grep` finds D1–D7 only at plan l.54, l.146; neither document defines them | accepted (user supplied the record) | D1–D7 were planning-conversation labels; user-supplied table added as spec §3a Decision record (with Q5–Q7, T1, W1); plan references point to it |
| X26 | owner | low | spec §5.4 `sync.exclusions` cites "§4.3" for secret patterns; patterns are in §4.7 | accepted | Fix cross-reference |

Rejected: none. Reviewer unverifiable items carried into Wave 0/2 checks: print-mode stdout for custom messages, image blocks reaching the model, non-root Xvfb + AT-SPI in Debian slim, Electron `--no-sandbox` under the default seccomp profile, `docker rm -f` racing `--rm`.

#### Round 3 (R-pre-5 Fable, R-pre-6 Astra)

Scope: spec + plan after X1–X26, README, TECHNICAL, repo `AGENTS.md`, Pi 1.4.0 docs, the `local-windows` reference design, plan §11 and §15. Both returned **ready after fixes**; no correctly applied X-fix was re-reported. Verified by the integration owner against Pi 1.4.0 (`dist/main.js` l.521–525 and l.820–822, `dist/core/output-guard.js` l.38–55 and l.67, `dist/core/agent-session.js` l.1700–1720, `docs/json.md` l.19), README/TECHNICAL, the spec text, root `package.json` + `.node-version`, `docker info` (rootful, builtin seccomp), and `npm view @iiwate/pi-silent-gui` (MIT, 0.2.0, `os: win32`, Python ≥ 3.10 + `pycaw`, tools `silent_spawn/message/capture/kill`, `silent_message` supports `key`, no UIA). IDs: `A3-Fn` = Astra, `B3-Fn` = Fable. All rows approved by the user on 2026-10-24 and applied to the spec, this plan, README, and TECHNICAL.

| Fix | Findings | Sev | Verified evidence | Disposition | Fix summary |
|---|---|---|---|---|---|
| Y1 | A3-F4, B3-F1 (X13) | high | non-interactive modes replace `process.stdout.write` with a stderr writer (`output-guard.js` l.45–49, `main.js` l.522–525); raw writer not exported to extensions; JSON stdout reserved for JSONL; thrown command errors are caught and do not set the exit code (`agent-session.js` l.1708–1719); `main.js` l.821 only overrides a non-zero code | accepted | No-UI report channel per mode: print → stderr (respects Pi's guard; no `fs.writeSync(1)` bypass); JSON/RPC → `pi.sendMessage` custom message, never plain text on stdout. On required-check failure set `process.exitCode = 1`. Wave 0 spike asserts stderr content, exit code, and valid JSONL. Spec §5.2, plan S15 and §8 row updated |
| Y2 | A3-F3, B3-F2 (X2) | high | spec §4.1 image list has no `python3-pip`, `python3-venv`, `nodejs`, `npm`; nothing creates `/deps/venv`; Debian marks system Python externally managed | accepted | Add those packages; helper creates `/deps/venv` with `python3 -m venv --system-site-packages` (keeps `gi`/`pyatspi`) before the first `setup`; helper itself runs on system `python3`, the app on the venv; image contract test adds `pip --version`, `npm --version`, venv creation; spec §7 example tested in e2e |
| Y3 | A3-F2, B3-F4 (X2) | medium | non-root `--user`, `--cap-drop ALL`, `/etc/passwd` root-owned and not on a writable mount | accepted | Client generates `passwd`/`group` for the host UID/GID in the session temp dir and bind-mounts them read-only at `/etc/passwd`, `/etc/group`; check that the UID resolves (`id -un`); no root entrypoint, no `LD_PRELOAD` |
| Y4 | A3-F1 (X4b) | high | spec §4.1 socket scan skips `.git`, `node_modules`, virtualenvs although they are inside the mount | accepted | Scan the whole mounted tree; bound 20 s; fail closed on timeout or unreadable dirs with a message pointing to `copy` mode; fixtures with sockets in each formerly skipped dir |
| Y5 | A3-F5, B3-F9 (plan §15) | medium | spec §6 `screenshot` has no `allBlack`, scale, or capture identity; `act x,y` has no coordinate space; `leftovers[]` untyped; plan §5 protocol row lists none of §15's needs; `UsageEvent` lacks `allBlack` | accepted | Spec §6 + plan §5: screenshot result adds `captureId`, `target` (screen/window ref), `origin`, `scale`, `allBlack?`; `act` with `x,y` takes `captureId` and coordinates in that capture's unscaled pixel space, stale `captureId` → `STALE_REF`; `Leftover {kind: string; id: string; detail?: string}`; helper invoked as an opaque executable; `UsageEvent.allBlack?`; tests for downscaled captures and two windows |
| Y6 | A3-F6 (X7) | medium | owner label `<clientId>:<pid>:<bootId>` lacks `processStartTime`, so same-boot PID reuse is undetectable without `owner.json` | accepted | Label `pi-gui-testing.owner=<clientId>:<pid>:<processStartTime>:<bootId>`; labels with fewer fields are reported, never swept; no-dir PID-reuse unit test |
| Y7 | A3-F7, B3-F8 (X1) | medium | killing Pi closes the `docker run -i` stdin → helper takes the EOF path, not the heartbeat path; the helper cannot remove the client temp dir, which spec §7a allows until next start | accepted | S7 split: (a) SIGKILL Pi, no restart → no container and no orphaned `docker` CLI within 15 s; client temp dir may remain; (b) restart → sweep removes it, audit empty; (c) `SIGSTOP` Pi with shortened test heartbeat → helper teardown via heartbeat path, then `SIGCONT` + audit |
| Y8 | A3-F8 (X6) | medium | §4.7 calls patterns root-relative, so built-in `.env*`, `.ssh/`, `secrets*` would not match `services/api/.env` | accepted | Built-in secret patterns match the basename at any depth (directories exclude their subtree); user `sync.allow`/`sync.deny` use gitignore-style patterns relative to the root; fixtures for nested files/dirs and allow/deny precedence |
| Y9 | A3-F9, B3-F5 (X19) | medium | README l.31 "`.env`, keys, and credentials are never sent"; TECHNICAL l.110, l.165 lack the mount-mode warning and present exclusions as absolute although `sync.allow` overrides them | accepted | README "Before you start": mount-mode warning + exclusions are defaults; TECHNICAL `workspaceMode` row and Security section explain mount-mode exposure, `copy`/`network: "none"`, and `sync.allow`. Applied to user docs now; X19 summary corrected |
| Y10 | A3-F10 (X1/X13) | medium | plan §8 helper/image commands append `python3 …` after the image; with the helper as `ENTRYPOINT` these become helper args | accepted | Dockerfile: `ENTRYPOINT ["tini","--","/opt/pi-gui-testing/helper"]`, no `CMD`; test commands use `--entrypoint python3`; a separate helper test drives the real entrypoint (framing, EOF, heartbeat) |
| Y11 | A3-F11, B3-F6 (X11/X21/X23) | low | TECHNICAL l.30 "without changing anything", l.33 `/gui-export` without args, l.89/l.155 hard-coded `~/.pi/agent`; spec §5.1 flag table lacks `--purge-tooling` (TECHNICAL l.51 has it) | accepted | Align TECHNICAL with spec §5.1/§7; add `--purge-tooling` row to spec §5.1 |
| Y12 | B3-F3 | medium | rootless Docker maps container UIDs to subuids, breaking `--user <hostuid>` ownership and access to the 0700 temp dir; spec `docker.permission` suggests rootless; `docker.rootless`/`docker.bind-uid` exist only for the remote variant; this host is rootful | accepted (detect and refuse); rootless support **deferred** | Add `docker.rootless` (observe, required: fails on rootless in M1 with a clear message) and `docker.bind-uid` (probe) to `docker-linux`; drop "rootless hint" from `docker.permission`; rootless support planned with M1c |
| Y13 | B3-F7 | medium | TECHNICAL has no requirements section; Docker ≥ 29.0 excludes many distro packages | accepted | TECHNICAL "Requirements" per backend: Pi ≥ 1.4.0, Docker server ≥ 29.0 rootful, 5 GB free, network for the image build |
| Y14 | B3-F10 | low | "`DISPLAY` names the container's own Xvfb" is not inspectable before the helper starts Xvfb | accepted | Hard-rule predicate: `Env.DISPLAY` matches `^:[0-9]+$`, no bind under `/tmp/.X11-unix`, `DBUS_SESSION_BUS_ADDRESS` absent from `Env` |
| Y15 | B3-F11 | low | reference `silent_message` supports `key` actions | accepted | Spec §4.5: "no text typing (single key actions only)" |
| Y16 | B3-F12 | low | decision `W1` (spec §3a) collides with workstream `W1` (plan §6) | accepted (user) | Decision renamed `D8` in spec §3a, plan §4, §11 |
| Y17 | B3-F13 | low | package `engines` `>=22.19.0` vs root `^22.23.4 \|\| ^24.22.1 \|\| >=26.12.1`; repo pin is `.node-version` 24.22.1 (reviewer cited `.nvmrc`, which does not exist); `@types/node ^26` | accepted | W0: package `engines` = root range; `@types/node` aligned with sibling packages; plan §2 states Node 22.23.4 (within the repo range) |
| Y18 | B3-F14 | low | 60 s heartbeat timeout defined only in §7a.3 | accepted | State 15 s interval + 60 s timeout in §6; reference from §4.1 and §7a.3 |
| Y19 | B3 unverifiable (Electron) | low | Chromium in containers commonly needs more than the 64 MB `/dev/shm` | accepted | Plan §10 risk: `--shm-size=512m` or `--disable-dev-shm-usage`, verified in S4 |

Rejected: none. Carried as unverifiable to Waves 0–2: Debian package availability on the pinned tag, non-root Xvfb/D-Bus/AT-SPI under `--cap-drop ALL`, tmpfs `uid/gid/mode`, Electron under the default seccomp profile, rootless behaviour (needs a rootless host), reference-package source claims (S1).

### 13.2 Post-integration review quorum (Wave 4)

| Run | Provider / model | Task id | Status |
|---|---|---|---|
| R-post-A1 | Pi / `openai-codex/gpt-6.1-sol` (xhigh), seat A security/backend | `…gui-testing-m1-review-sol-A-r1` | completed 2026-10-24: **not ready**, 6 findings |
| R-post-B1 | Pi / `openai-codex/gpt-6.1-sol` (xhigh), seat B tools/lifecycle/docs | `…gui-testing-m1-review-sol-B-r1` | completed 2026-10-24: **not ready**, 14 findings |

Owner verified each finding against the code (A-F1 `tools.ts` snapshot path built from helper-supplied `snapshotId`; A-F2 `git ls-files` without `core.fsmonitor=false`; A-F3/B-F1 `lstat` on a path with symlinked ancestors; A-F5/B-F2 `closeSession` deletes the entry before `stop()` succeeds; B-F10 `renderReport` `else if`). All accepted. Fixes Z1–Z18 go to one `claude-opus-5-5` worker (W3 paths plus the listed W1 files, approved by owner); Z18 by owner.

| Fix | Findings | Sev | Disposition | Fix summary |
|---|---|---|---|---|
| Z1 | A-F1 | critical | accepted | Treat helper responses as untrusted: client-generated artifact names, containment check for every host write, method-specific response validation |
| Z2 | A-F2 | high | accepted | `git -c core.fsmonitor=false` (and other exec-capable config neutralised) for enumeration |
| Z3 | A-F3, B-F1 | high | accepted | Reject paths with symlinked ancestors; containment + type re-check at copy time (`O_NOFOLLOW`-style) |
| Z4 | A-F4 | high | accepted | Mount the realpath; after start, compare `/workspace` dev/ino inside the container with the scanned host dir; mismatch → stop (fail closed) |
| Z5 | A-F5, B-F2 | medium/high | accepted | Keep failed sessions and exit cleanup until teardown succeeds; retryable stop; `/gui-cleanup` retries own ended sessions |
| Z6 | A-F6 | low | accepted | Keep a directory link only when its target directory is in the synced set |
| Z7 | B-F3 | high | accepted | Track and await pending starts/setup in shutdown; no late registration after abort |
| Z8 | B-F4 | medium | accepted | Docker sweep whenever a `docker` CLI is on PATH, independent of verification |
| Z9 | B-F5 | medium | accepted | `gui_export` honours signal and a timeout |
| Z10 | B-F6 | medium | accepted | Idle activity recorded at admission; in-flight calls block idle reaping |
| Z11 | B-F7 | medium | accepted | Drift check covers every recorded version; documented policy for existing sessions |
| Z12 | B-F8 | medium | accepted | Count failed launches for launch-storm detection |
| Z13 | B-F9 | medium | accepted | `.gitignore` offer for `.pi/gui.local.json` per spec §7 (no-UI: report only) |
| Z14 | B-F10 | medium | accepted | Report shows remaining manual steps after applied fixes (W1 `src/setup/report.ts`) |
| Z15 | B-F11 | medium | accepted | e2e cancel test uses `runtime.ownerLabel()` |
| Z16 | B-F12 | medium | accepted | e2e real-Pi exit test leaves a live session and asserts cleanup |
| Z17 | B-F13 | medium | accepted | Surface config warnings in command reports and tool results |
| Z18 | B-F14 | low | accepted (owner) | `DEVELOPMENT.md` links unpackaged docs by repository URL |

Fix run: `claude-opus-5-5` (effort high), task `…gui-testing-m1-fixes-Z-r1`, handoff `plans/handoffs/m1-Z.md`. Owner rerun: `npm run check` → 207/207; e2e 18 skipped (no Docker). Z18 applied by owner; TECHNICAL/DEVELOPMENT updated for the 12 user-visible changes. Residual: Z3 narrows but does not close the check-to-copy race; Z4 exact mount-source equality and dev/ino on btrfs/overlay unverified on real Docker.

| Run | Provider / model | Task id | Status |
|---|---|---|---|
| R-post-A2 | Pi / `openai-codex/gpt-6.1-sol` (xhigh), seat A round 2 | `…gui-testing-m1-review-sol-A-r2` | completed 2026-10-24: **not ready**; A-F1/F2/F6 fixed, A-F3/F4/F5 partial; 5 new findings |
| R-post-B2 | Pi / `openai-codex/gpt-6.1-sol` (xhigh), seat B round 2 | `…gui-testing-m1-review-sol-B-r2` | completed 2026-10-24: **not ready**; 8 of 14 fixed, 6 partial; 10 new findings |

Round-2 findings, owner-verified (`.gitignore:28` `pi-session-*` matches the fixture; `ensure_venv` runs `python -m venv` without `-I` from the helper's `/workspace` cwd; `addLocalConfigToGitignore` uses `readFile`/`appendFile` without no-follow). All accepted. Fixes Q1–Q12 by one `claude-opus-5-5` worker; the helper change for Q1 (W2 path) is approved by the owner; Q12 by owner.

| Fix | Findings | Sev | Fix summary |
|---|---|---|---|
| Q1 | A2-F1 | high | Venv creation runs `python -I` with `cwd=/` and a sanitised env; identity check runs no workspace code (helper + client) |
| Q2 | A2-F2, B2-F2 | high | Failed starts keep a retryable record (container, owner.json, exit cleanup) until cleanup is confirmed |
| Q3 | A2-F3, B2-F1 | high/medium | `.gitignore` write: no-follow descriptor, regular file only, refuse symlinks/special files |
| Q4 | A2-F4 | medium | Accessibility bounds validated separately from screenshot limits |
| Q5 | A2-F5 | medium | Log buffer bounds event count and size with overhead; bounded persistence queue and artifact size |
| Q6 | B2-F3 | high (plausible) | Setup tracked before the first dialog; stale continuations after shutdown rejected |
| Q7 | B2-F4, B2-F5 | medium | `.gitignore` confirm uses the setup dialog adapter, abort check before write; `--no-fix` is report-only |
| Q8 | B2-F6 | medium | Export flush/copy abortable with an overall deadline |
| Q9 | B2-F7 | medium | Rename the e2e Pi fixture so the repo `.gitignore` does not hide it |
| Q10 | B2-F8 | medium | e2e Docker queries fail on non-zero status |
| Q11 | B2-F9 | low | Config warnings also on failed `gui_launch` |
| Q12 | B2-F10 | low | Doc inconsistencies (owner) |

Fix run: `claude-opus-5-5` (effort high), task `…gui-testing-m1-fixes-Q-r1`, handoff `plans/handoffs/m1-Q.md`. Owner rerun: `npm run check` → 222/222; host helper tests pass except the 3 known `gi` errors (new `test_venv.py` 3/3); fixtures no longer ignored. Q12 and the Q doc changes applied by owner. Package unpublished on npm (E404), so the helper change needs no version bump; DEVELOPMENT now requires a version bump for any future helper change. Q1 accepted as mitigated: the identity check still triggers venv creation, which now runs only package code.

| Run | Provider / model | Task id | Status |
|---|---|---|---|
| R-post-A3 | Pi / `openai-codex/gpt-6.1-sol` (xhigh), seat A round 3 | `…gui-testing-m1-review-sol-A-r3` | completed 2026-10-24: **not ready**; A2-F1–F4 fixed, A2-F5 partial; 1 blocking + 3 non-blocking |
| R-post-B3 | Pi / `openai-codex/gpt-6.1-sol` (xhigh), seat B round 3 | `…gui-testing-m1-review-sol-B-r3` | completed 2026-10-24: **not ready**; B2 findings fixed except B2-F10 partial; 4 blocking + 2 non-blocking |

Round-3 findings, all accepted. Owner note: `npm test` passes 3/3 runs on Node 26.12.1 here, but seat B reproduced 3 cancelled tests on Node 22.23.4 (in `engines`), so P4 is accepted as blocking.

| Fix | Findings | Blocking | Fix summary |
|---|---|---|---|
| P1 | A3-F1 | yes | Canonicalise log events (known fields only, owned bounded copies); byte-bound `setupTail`; adversarial framing→buffer tests |
| P2 | B3-F1 | yes | Runtime generation captured before the first await in commands; retired runtime rejects late continuations |
| P3 | B3-F2 | yes | `/gui-cleanup --all`/backend cleanup independent of project-config parsing; fallback for default cleanup |
| P4 | A3-F4, B3-F4 | yes | Export tests and deadline timers kept referenced while pending |
| P5 | B3-F3 | yes | Export destination ancestors resolved (realpath) before the containment check |
| P6 | A3-F2 | no | Pending-start exit cleanup uses the endpoint-bound removal argv |
| P7 | A3-F3, B3-F5 | no | Drop marker drained on flush; `gui_logs` stops claiming the full log |
| P8 | B3-F6 | no | Doc units and error strings (owner) |

Fix run: `claude-opus-5-5` (effort high), task `…gui-testing-m1-fixes-P-r1`, handoff `plans/handoffs/m1-P.md`. Owner rerun: `npm run check` → 232/232 ×2 on Node 26.12.1; unit suite on Node 22.23.4 (`~/.local/share/pi-node/node-v22.23.4-linux-arm64`) → 232/232, 0 cancelled, ×3. P8 and P doc changes applied by owner.

| Run | Provider / model | Task id | Status |
|---|---|---|---|
| R-post-A4 | Pi / `openai-codex/gpt-6.1-sol` (xhigh), seat A round 4 | `…gui-testing-m1-review-sol-A-r4` | completed 2026-10-24: **not ready**; A3-F1–F4 fixed; 1 blocking (A4-F1) |
| R-post-B4 | Pi / `openai-codex/gpt-6.1-sol` (xhigh), seat B round 4 | `…gui-testing-m1-review-sol-B-r4` | completed 2026-10-24: **not ready**; B3 fixed except B3-F3 partial; 1 blocking (B4-F1) + 2 non-blocking |

Round-4 fixes, all accepted and applied by the owner directly (the owner session is itself `claude-opus-5-5`; changes are small and local):

| Fix | Findings | Blocking | Fix summary |
|---|---|---|---|
| R1 | A4-F1 | yes | `DiagnosticBuffer` stores `ownedSlice` copies; regression test fails on Node 22.23.4 before (200.2 MiB retained) and passes after |
| R2 | B4-F1 | yes | Component-aware `isWithin`/`isRelativeInside` (`src/paths.ts`) for export and file-set link checks; `..kept` / `..via-link` cases added to the P5 test; `tests/unit/sync/paths.test.mjs` |
| R3 | B4-F2 | no | P4 subprocess test removes its temp dir from the parent |
| R4 | B4-F3 | no | `package.json` `files` excludes `helpers/**/__pycache__` and `*.pyc` (`npm pack --dry-run`: 110 files, 0 bytecode, no tests/plans) |

Owner validation: `npm run check` → 234/234 on Node 26.12.1; unit suite on Node 22.23.4 → 234/234, 0 cancelled; e2e 18 skipped; no leaked `gui-export-ref-*` dirs; `git diff --check` clean.

| Run | Provider / model | Task id | Status |
|---|---|---|---|
| R-post-A5 | Pi / `openai-codex/gpt-6.1-sol` (xhigh), seat A round 5 | `…gui-testing-m1-review-sol-A-r5` | completed 2026-10-24: **not ready**; A4-F1 fixed (0.21 MiB on Node 22); 2 blocking (A5-F1 response text slices, A5-F2 error slices) |
| R-post-B5 | Pi / `openai-codex/gpt-6.1-sol` (xhigh), seat B round 5 | `…gui-testing-m1-review-sol-B-r5` | completed 2026-10-24: **ready after fixes**; B4-F1–F3 fixed; 1 non-blocking doc item (B5-F1 RPC has UI) |

Round-5 fixes (owner): **S1** (A5-F1, A5-F2) owned copies in `src/backends/response.ts` text validator, `src/backends/docker/session.ts` `#toSessionError` and docker stderr tail, `src/tools/format.ts` `clip()`; regression test in `tests/unit/backends/session.test.mjs` fails before (180.2 MiB on Node 22) and passes after. **S2** (B5-F1) TECHNICAL distinguishes print/JSON (no prompts, exit code 1) from RPC (client answers, exit code unchanged). Validation: 235/235 on Node 26.12.1 and Node 22.23.4, 0 cancelled.

| Run | Provider / model | Task id | Status |
|---|---|---|---|
| R-post-A6 | Pi / `openai-codex/gpt-6.1-sol` (xhigh), seat A round 6 | `…gui-testing-m1-review-sol-A-r6` | completed 2026-10-24: **ready**; A5-F1/F2 fixed (< 7.4 MiB retained on Node 22 and 26); 1 non-blocking (A6-F1 RegExp statics keep one rejected base64 field, ~16 MiB, bounded) |
| R-post-B6 | Pi / `openai-codex/gpt-6.1-sol` (xhigh), seat B round 6 | `…gui-testing-m1-review-sol-B-r6` | completed 2026-10-24: **ready after fixes**; B5-F1 fixed; 1 non-blocking doc phrase (B6-F1 `.gitignore` prompt also in RPC) |

Quorum result: both seats have no blocking findings. Owner applied both non-blocking items: **T1** (A6-F1) base64 check is a char-code loop instead of a RegExp, with `tests/unit/backends/response.test.mjs`; **T2** (B6-F1) TECHNICAL says "in print or JSON mode". Final owner validation: `npm run check` → 236/236 (Node 26.12.1); unit suite on Node 22.23.4 → 236/236, 0 cancelled; e2e 18 skipped (no Docker); host helper tests pass except the 3 PyGObject tests; `pi -p "/gui-doctor docker-linux" </dev/null` → exit 1, stdout empty, report on stderr; `--mode json` → exit 1, 3 valid JSONL records with the `gui-testing` custom message; `npm pack --dry-run` → 110 files incl. skill, no bytecode/tests/plans; Markdown `git diff --check` clean.

## 14. Worker handoff artifacts

Each worker writes only its own file:

- `plans/handoffs/m1-W1.md`
- `plans/handoffs/m1-W2.md`
- `plans/handoffs/m1-W3.md`

Required content: identity/status, changed files with summary, commands run with exit codes, validation omissions, deviations and assumptions, unresolved decisions, residual risks, integration notes.

## 15. Forward compatibility with later milestones

M1 does not implement Windows backends, but its frozen contracts must not block them.

| Later need | Source | What M1 must allow |
|---|---|---|
| Spike S1 runs `@iiwate/pi-silent-gui` unchanged on Windows | spec §11 S1 | Nothing in M1; S1 is independent and can run in parallel with M1 on a Windows machine |
| `allBlack` flag on screenshots | spec §4.5 | `screenshot` result type in `src/protocol.ts` has an optional `allBlack` field; the usage check (W1) can count it |
| Full-window coordinate space | spec §4.5 | `act` coordinates are documented as relative to the returned screenshot, not the screen |
| Job Object and private-desktop audit entries | spec §7a.4 | `Session.auditFootprint()` returns typed leftover entries with an open `kind` string, not a Linux-only enum |
| Checks `helper.job`, `helper.nonelevated` | spec §5.4 | Check framework (W1) accepts backend-specific checks without core changes |
| Helper may be a native `.exe` or a Python helper (Q4) | spec Q4 | Transport layer treats the helper as an opaque executable with stdio; no assumption that it is Python |
