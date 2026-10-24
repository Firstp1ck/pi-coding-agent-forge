# Development guide: GUI Testing for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Status

Milestone M1 is implemented: the tool and command surface, the setup/doctor framework, client-side cleanup, the usage and loop check, the Linux helper and base image, and the `docker-linux` backend with `mount` and `copy` workspace modes.

The Docker-dependent parts (live setup, the smoke test, sample apps, crash cleanup) have only been verified with fakes on the latest development host. Run the end-to-end suites below on a Linux host with rootful Docker 29+ before publishing. The implementation plan records which gates passed where: [plans/planned/gui-testing-m1-plan.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-gui-testing/plans/planned/gui-testing-m1-plan.md).

## Design documents

These documents are not part of the npm package, so the links point to the repository.

- Behaviour spec (source of truth): [plans/planned/gui-testing-spec.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-gui-testing/plans/planned/gui-testing-spec.md). Move it to `plans/archive/` once every milestone is verified.
- M1 implementation plan, decision record, and review log: [plans/planned/gui-testing-m1-plan.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-gui-testing/plans/planned/gui-testing-m1-plan.md).
- Helper JSON-lines protocol: [docs/protocol.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-gui-testing/docs/protocol.md), with the types in `src/protocol.ts`. Helper and client source comments cite this file, so it stays a separate document.

## Architecture

```
Pi ──► index.ts ──► GuiRuntime (src/tools/runtime.ts)
                     ├─ tools (src/tools/tools.ts)   gui_launch … gui_export
                     ├─ commands (src/commands/)     /gui-setup … /gui-export
                     ├─ SessionRegistry + UsageTracker (src/usage/)
                     ├─ setup flow + report (src/setup/)
                     └─ DockerLinuxBackend (src/backends/docker-linux.ts)
                          ├─ checks (src/backends/docker/checks.ts + src/checks/common.ts)
                          ├─ image build (docker/image.ts, tar.ts) ──► docker build -
                          └─ DockerSession (docker/session.ts)
                               └─ docker run -i --rm … ──► tini ──► helper (helpers/linux)
                                                                     ├─ Xvfb, private D-Bus, AT-SPI, openbox
                                                                     └─ app / setup processes
```

- The extension factory only constructs `GuiRuntime` and registers tools and commands. `session_start` runs the startup sweep in the background; `session_shutdown` stops every session and cancels a running setup. A synchronous `exit` handler exists only while a session runs and force-removes containers.
- The helper is PID 1's child under `tini` in a `docker run -i --rm` container. Stdin EOF, a heartbeat timeout (15 s interval, 60 s timeout), or SIGTERM/SIGHUP tears it down, and `--rm` removes the container without client action.
- Framing: token handshake (`PI_GUI_TESTING_TOKEN`, passed via the CLI environment so it never appears in argv), `<token> <json>` lines, request ids, `{ok, error{code,message}}` envelope. `ping` and `cancel` bypass the per-session queue. See [docs/protocol.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-gui-testing/docs/protocol.md).

## Source layout

| Path | Contents |
|---|---|
| `index.ts` | Extension entry. |
| `src/protocol.ts`, `src/backend.ts`, `src/hardening.ts`, `src/labels.ts`, `src/owner.ts`, `src/*/types.ts` | Frozen M1 contracts (plan §5). Change only through the integration owner and record it in the plan. |
| `src/framing/` | Line codec and `ProtocolClient` (READY handshake, correlation, heartbeat, bypass queue). |
| `src/config/` | Config files, field-by-field precedence, flag parser, verified-backend record and drift detection, atomic writes. |
| `src/checks/` | Check runner (dependency order, parallel probes, timeouts, `blocked`) and the common checks. |
| `src/setup/` | Remediation plan, confirm flow (one `select`; `--fix`/`--no-fix`), doctor, report emitter per Pi mode, smoke test (`smoke.ts`). |
| `src/cleanup/` | Session temp dirs, `owner.json`, owner liveness (boot id + PID + process start time), startup sweep, client audit, exit cleanup. |
| `src/usage/` | Loop detector and usage counters, session registry with limits and idle detection. |
| `src/runner/` | `CommandRunner` abstraction, real spawn runner, fake for tests. |
| `src/backends/docker-linux.ts` | `DockerLinuxBackend`: checks, workspace preparation, session start, `setup` via `exec`, audit, sweep, image build, reset. |
| `src/backends/docker/` | Docker CLI argv and endpoint resolution, checks, image build context (ustar), hardened run argv, `isolation.inspect` rule evaluation, mount-mode guards (forbidden roots, socket scan), `DockerSession`, labelled-resource footprint. |
| `src/sync/` | spec §4.7 file-set builder (Git or walk, secret patterns at any depth, dependency dirs, allow/deny, link and special-file rules) and copy-mode staging. |
| `src/tools/` | `GuiRuntime`, the eight tools, result formatting, PNG decode/scale, logs, export. |
| `src/commands/` | The seven commands with `ctx.hasUI` branching. |
| `helpers/linux/` | Python helper (`helper`, `pi_gui_helper/`), `Dockerfile` (multi-arch Debian trixie slim pinned by digest), `.dockerignore`. |
| `testapps/` | GTK 3 smoke app (baked into the image) and GTK 4, PySide6, Electron, Tk sample apps with `.pi/gui.json`. |
| `skills/gui-testing/SKILL.md` | Bundled skill (spec §9). |

## Security invariants

These are enforced in code and covered by tests; keep them when changing anything.

1. Never start a GUI process with the host's display. The Docker backend never mounts host display, D-Bus, or Docker sockets.
2. No automatic backend switching; a configured but unimplemented backend is refused.
3. No remediation without one confirmation or `--fix`; no prompts without UI.
4. No project data in the image or build context: the context is a staged tar of helper files and the smoke app only.
5. `dockerRunArgs()` is the single source of the run configuration for sessions and the `isolation.inspect` probe. `hardRuleViolations()` checks a `docker inspect` result against `src/hardening.ts` and reports every violation. Sessions are inspected after start and before any app runs; a failure stops the session (fail closed).
6. `isolation.inspect` is stricter than the frozen forbidden-path list: it also rejects binds under `/tmp/.X11-unix`, anywhere under `/run` or `/var/run` except private sub-directories of `/run/user/<uid>/`, and any bind source that is itself a socket.
7. Mount mode refuses forbidden roots and any Unix socket in the tree; the scan does not follow symlinks, is bounded to 20 s, and fails closed on timeout or unreadable directories.
8. Negative tests never start a container with a forbidden setting; they use `docker create` and remove it.
9. Cleanup is idempotent; the startup sweep only removes resources of owners proven dead. Owner labels with fewer fields are reported, never swept. The Docker sweep runs whenever a `docker` executable is found on `PATH` (checked on the file system), so Pi startup on hosts without Docker runs no `docker` command.

## Implementation notes

- `docker run` uses `--pull never`, `--name pi-gui-testing-<session>` (so `owner.json` lists the container before it exists), uid/gid-owned tmpfs for `/tmp`, `/scratch`, `$HOME`, `/deps`, `/run/user/<uid>`, and generated read-only `/etc/passwd` and `/etc/group` from the session dir. `--shm-size 512m` is added for `electron`, `npx electron`, `node …/electron/cli.js`, and Chromium names only.
- The image tag is `pi-gui-testing-base:<package version>`; labels `pi-gui-testing.base`, `.version`, `.protocol` drive `image.base` and drift detection. `docker build --force-rm` removes intermediate containers of an aborted build.
- Docker endpoint: `DOCKER_HOST`, else `docker context inspect`; only `unix://` is accepted in M1. Every Docker call passes `--host` explicitly.
- `gui_act` coordinates are in the pixels of the image the model saw; the tool divides by the capture's `scale` and defaults `captureId` to the latest screenshot. A stale explicit `captureId` is refused before the helper.
- `gui_act` returns a screenshot only with `screenshot: true`.
- `gui_stop` works on a live session even if the backend became unverified; all other tools refuse with the spec's "not set up" text.
- Limits are read from config at the first launch and re-read whenever no session runs.
- **Helper responses are untrusted** (an app runs with the helper's UID and can read its token from `/proc`). `src/backends/response.ts` validates each method's result (types, arrays, enums, base64, PNG header, size limits) and fails with `BAD_RESPONSE`. Artifact names are generated client-side (`src/tools/artifacts.ts`: `snapshot-NNN.json`, `screenshot-NNN.png`), written with exclusive create, and every host write is checked for containment in the artifact dir or export destination.
- **Hardened Git** (`src/sync/git.ts`): `-c core.fsmonitor=false`, hooks disabled, `--no-optional-locks`; used for `ls-files` and `check-ignore`.
- **Copy-mode TOCTOU:** candidates with a symlinked ancestor are excluded; at copy time each file is opened with `O_NOFOLLOW`, its identity (dev/ino) must match enumeration, and its real path (via `/proc/self/fd`) must stay inside the project. This narrows, but does not close, the check-to-copy race. A directory link is kept only when a synced file lies under its target.
- **Mount identity:** mount mode resolves the project realpath once, scans it, records dev/ino, passes the realpath to Docker, requires the inspected `/workspace` mount source to equal it (session inspect and `isolation.inspect`), and runs `stat` over the helper's `exec` before setup or the app; a mismatch stops the session. The `exec` triggers the helper's `/deps/venv` creation, which adds a few seconds to sessions without `setup`.
- **Teardown state:** sessions move `running → closing → failed | forgotten`. A failed stop keeps the temp dir, `owner.json`, and the exit handler and is retried by `gui_stop`, `/gui-cleanup`, and shutdown. `DockerSession.stop()` is retryable and shares one in-flight promise.
- **Shutdown:** pending session starts and setup/doctor runs are tracked; shutdown aborts them, waits up to 20 s, and tears down any session that finishes starting late. `admit()` records activity before any await, so idle reaping skips sessions with queued or in-flight calls.
- **Drift:** the verified record holds package, Pi, protocol, Docker CLI/server, image tag and id; any change blocks new launches, running sessions continue. Records from before this field set ask for `/gui-doctor` once.
- **Docker sweep gating:** `dockerOnPath()` checks `PATH` on the file system; the sweep runs whenever it finds `docker`, independent of verification, and reports errors instead of throwing.
- **Failed starts** (`src/backends/start-failure.ts`): when a start fails and its teardown also fails, the backend attaches the leftover session handle to the error; the runtime retains it as a `failed` session with its temp dir, `owner.json`, and exit-cleanup command until an audit confirms removal.
- **Helper venv:** the helper `chdir`s to `/` at start and creates `/deps/venv` with `python -I -m venv` from `/` with a minimal environment (no token, no `PYTHON*`), so no workspace module can run before the workspace identity check. That check still triggers venv creation because the frozen protocol has no other way to run a command.
- **Response limits:** accessibility bounds accept integers up to ±2^31 and are dropped per node when malformed; window geometry accepts the X11 range; names, values, and titles are cut at 64 KiB.
- **Log limits** (`LOG_LIMITS`): at most 10 000 events / 1 MiB in memory with per-event overhead, 64 KiB per chunk; disk writes are batched with a "dropped N" marker, and `app.log` stops at 64 MiB.
- **Setup runs** are registered before the backend picker opens, so `/gui-cleanup` and shutdown cancel the picker, and a late answer is rejected by a generation check. The `.gitignore` offer uses the setup dialog adapter, re-checks abort before writing, opens with `O_NOFOLLOW` and writes only to regular files, and is report-only with `--no-fix`.
- **Export** runs under one overall deadline; log flush and stream copies are abortable, and a partial file is removed.
- **Log events** are canonicalised in the protocol client (`src/framing/log-event.ts`): only `event`, `stream`, `source`, `data` are kept, and `data` becomes an independent copy cut at 64 Ki characters. `setupTail` keeps the newest 4096 characters as one string. `flush()` writes any outstanding "dropped N" marker.
- **Runtime generation:** `guarded()` captures the runtime's shutdown signal before its first `await`; commands that start sessions or write config, and `gui_launch`, refuse a stale generation with "Pi is shutting down (or restarted this extension)".
- **Exit cleanup for pending starts** uses the backend's endpoint-bound `docker --host <endpoint> rm -f` (via `DockerStartOptions.onExitCleanup`), registered before the container is created. Future backends must call `onExitCleanup` themselves.
- **Export destinations** are resolved (nearest existing parent, then the created dir) before the containment check; the export deadline timer is referenced while an export runs.
- Probe temp dirs use the prefix `pi-gui-probe-`, so the startup sweep never reports them as unknown session dirs.
- `/gui-reset` refuses without UI (no confirmation flag exists); `/gui-cleanup --deps` reports that M1 has no dependency cache.
- Smoke test: transient session not counted against `maxConcurrentSessions`, empty read-only workspace, `network: none`; accepted button roles `button`, `push button`.

## Development setup

```bash
cd pi-extension-gui-testing
npm install
pi -e ./index.ts          # load the extension from the working tree
```

Pi's print mode reads stdin when it is not a TTY; run scripted checks with `</dev/null`.

## Tests

| Suite | Command | Needs |
|---|---|---|
| Typecheck + unit + contract tests | `npm run check` | Node only |
| Real-process integration against a fake `docker` | `node --experimental-strip-types --test tests/unit/backends/process.test.mjs` (also part of `npm test`) | Node only |
| Helper unit tests (host) | `python3 -m unittest discover -s tests/helper -v` | Python; the `A11yPureTests` need PyGObject, so run them in the image |
| Helper unit tests (image) | `docker run --rm --network none --entrypoint python3 -v "$PWD/tests/helper:/tests:ro" pi-gui-testing-base:<version> -m unittest discover -s /tests -v` | Docker |
| Image contract | `docker run --rm --network none --entrypoint sh pi-gui-testing-base:<version> -c 'python3 -c "import gi, pyatspi" && pip --version && npm --version && python3 -m venv --system-site-packages /tmp/v && ldconfig -p \| grep -q libnss3'` | Docker |
| Helper entrypoint (production flags) | `python3 tests/helper/host/test_entrypoint.py` | Docker |
| e2e smoke | `npm run test:e2e -- tests/e2e/smoke.test.mjs` | rootful Docker 29+ |
| e2e sample apps | `npm run test:e2e -- tests/e2e/apps.test.mjs` | rootful Docker 29+, network for PySide6/Electron |
| e2e lifecycle | `npm run test:e2e -- tests/e2e/lifecycle.test.mjs` | rootful Docker 29+ |

e2e suites skip with a reason when no usable rootful Docker is found. `PI_GUI_E2E_OFFLINE=1` skips the PySide6 and Electron downloads; `PI_GUI_E2E_VERBOSE=1` prints the image build log. The first run builds the image, which takes minutes.

Coverage map: `smoke` covers S1/S3 (zero-prompt setup, smoke app), S6 live negatives, and doctor; `apps` covers S4, S5, every `act` action via `tests/e2e/fixtures/fields/app.py`, the `HANDOFF` path, a UID other than 1000, and Electron without `--shm-size`; `lifecycle` covers S7 (a)–(c), two concurrent sessions, idle timeout, cancel after resource creation, owner-label PID reuse, and a real `pi -p` exit.

The real-Pi exit test (`lifecycle`) needs Pi 1.4.0+ and a passing doctor, otherwise it skips. It uses `tests/e2e/fixtures/gui-live-session-extension.ts`, which reuses the real factory with an injected runtime: `pi -e tests/e2e/fixtures/gui-live-session-extension.ts -p /e2e-gui-launch`. Do not name fixtures `pi-session-*`; the repository `.gitignore` ignores that pattern.

Host-runnable helper test `tests/helper/test_venv.py` proves venv creation never imports modules planted in the working directory.

e2e Docker queries go through the harness's checked query helper, which throws on spawn errors or a non-zero exit, so a failed query never reads as "no leftovers".

No-UI behaviour checks:

```bash
pi -e ./index.ts -p "/gui-doctor docker-linux" </dev/null; echo "exit $?"            # report on stderr
pi -e ./index.ts --mode json -p "/gui-doctor docker-linux" </dev/null | head -5      # JSONL with a gui-testing custom message
```

## Before publishing

1. Run every suite in the table above on a rootful Docker 29+ host, on both x86-64 and ARM64 if possible, and record the results in the plan.
2. Run `npm pack --dry-run --json` and confirm `index.ts`, `src/`, `helpers/linux/` (helper, Dockerfile), `testapps/`, and `skills/gui-testing/SKILL.md` are listed and `tests/` and `plans/` are not.
3. Check whether `docker build --force-rm` is accepted by the target Docker version.
4. Bump the package version whenever `helpers/linux/` changes. The base image is matched by package version only, so an unchanged version keeps a stale helper image. Contributors with a local development image remove it with `/gui-reset docker-linux`.

## Known gaps

- `disk.free` measures `os.tmpdir()`, not Docker's data root.
- Electron detection does not cover `npm start` launches.
- Live `docker inspect` field shapes on Docker 29 are assumed (`HostConfig.CapDrop`, `SecurityOpt` `no-new-privileges`); an unexpected shape refuses every session (fail closed).
