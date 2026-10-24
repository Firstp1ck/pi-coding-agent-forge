# Development guide: GUI Testing for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Status

Implemented in code and covered by unit, contract, and host-runnable helper tests:

| Milestone | Deliverable | Live verification |
|---|---|---|
| M1 | Tool and command surface, setup/doctor framework, client-side cleanup, usage and loop check, Linux helper and base image, `docker-linux` with `mount` and `copy` | Pending: verified with fakes only on the latest development host |
| M1b | Dependency cache (protocol 2) for `docker-linux`, `remote-linux`, `remote-linux-docker` | Pending |
| M1c | `docker-linux` on Docker Desktop (macOS, Windows) | Pending: no macOS or Windows host used yet |
| M2 | `local-linux` | Pending: run with a stand-in Xvfb and a real `dbus-daemon` only; real X, GTK, AT-SPI, and openbox untested |
| M2b | `remote-linux`, `remote-linux-docker` | Pending: loopback `ssh` and fakes only; no real sshd |
| M3 (Linux target) | `cua` on the open-source `cua` CLI with the user's own cloud | Pending: no Cua account; every CLI shape comes from source |
| S1, M4, M5, `cua` Windows/macOS | Windows helper spike, `docker-windows`, `local-windows` | **Blocked**: needs a Windows machine (S1 decides the Windows helper, spec Q4) |

Nothing has run against real Docker, Docker Desktop, an X server, an SSH server, or Cua yet. [Before publishing](#before-publishing) lists the live runs per milestone exit criterion. The plans record which gates passed where.

## Design documents

These documents are not part of the npm package, so the links point to the repository.

- Behaviour spec (source of truth): [plans/planned/gui-testing-spec.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-gui-testing/plans/planned/gui-testing-spec.md). Move it to `plans/archive/` once every milestone is verified.
- M1 implementation plan, decision record, and review log: [plans/planned/gui-testing-m1-plan.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-gui-testing/plans/planned/gui-testing-m1-plan.md).
- M1b–M3 implementation plan and decisions (including the Cua Cloud shutdown): [plans/planned/gui-testing-m1b-m3-plan.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-gui-testing/plans/planned/gui-testing-m1b-m3-plan.md). The phase handoffs (`plans/handoffs/post-m1-{F,L,R,C,I,D,W}.md`) are git-ignored working notes; everything contributors need from them is in this guide.
- Helper JSON-lines protocol (version 2): [docs/protocol.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-gui-testing/docs/protocol.md), with the types in `src/protocol.ts`. Helper and client source comments cite this file, so it stays a separate document.

## Architecture

```
Pi ──► index.ts ──► GuiRuntime (src/tools/runtime.ts)
                     ├─ tools (src/tools/tools.ts)        gui_launch … gui_export
                     ├─ commands (src/commands/)          /gui-setup … /gui-export
                     ├─ SessionRegistry + UsageTracker (src/usage/)   cost hook ◄─ CostCapability
                     ├─ setup flow + report (src/setup/), host picker (src/setup/hosts.ts)
                     ├─ dependency cache (src/deps/)
                     └─ BackendRegistry (src/backends/registry.ts) + capabilities (src/backends/capabilities.ts)
                          ├─ docker-linux ─────────► DockerSession ─┐
                          ├─ local-linux ──────────► LocalLinuxSession ┤
                          ├─ remote-linux ─────────► RemoteLinuxSession ┼─► HelperSession (src/transport/helper-session.ts)
                          ├─ remote-linux-docker ──► RemoteDockerSession (DockerSession over SSH)
                          └─ cua ──────────────────► CuaSession ────┘
                                                                     │ stdio, JSON lines (protocol 2)
     transports:  docker run -i --rm … (local)    ──► tini ──► helper (container mode)
                  spawnLocalProcess (local-linux) ──► helper (host mode)
                  ssh ControlMaster (remote-*)    ──► helper (host mode) │ docker run -i --rm on the remote
                  cua sandbox exec -i (cua)       ──► sh env preamble ──► helper (host mode, in the sandbox)
                                                                     helper (helpers/linux)
                                                                       ├─ Xvfb, private D-Bus, AT-SPI, openbox
                                                                       └─ app / setup processes, deps pack/unpack
```

- The extension factory only constructs `GuiRuntime` and registers tools and commands. `session_start` runs the startup sweep in the background; `session_shutdown` stops every session and cancels a running setup. A synchronous `exit` handler exists only while a session runs and runs each session's `forceRemoveArgv()`.
- The runtime, tools, commands, setup, doctor, smoke test, cleanup, startup sweep, and reset know only `Backend` (`src/backend.ts`), the optional capabilities, and the registry. None of them imports a backend module (checked by grep in the F handoff).
- Framing: token handshake (`PI_GUI_TESTING_TOKEN`, never in argv), `<token> <json>` lines, request ids, `{ok, error{code,message}}` envelope. `ping` and `cancel` bypass the per-session queue. See [docs/protocol.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-gui-testing/docs/protocol.md).
- In containers the helper is PID 1's child under `tini` in a `docker run -i --rm` container. Stdin EOF, a heartbeat timeout (15 s interval, 60 s timeout), or SIGTERM/SIGHUP tears it down, and `--rm` removes the container without client action. Host mode (local-linux, remote-linux) tears down the same way; see [Helper host mode](#helper-host-mode-contract).

### Registry and capabilities

`IMPLEMENTED_BACKEND_IDS` in `src/config/types.ts` lists the backends (`docker-linux`, `local-linux`, `remote-linux`, `remote-linux-docker`, `cua`); the order is the picker and completion order, and the first id is the default. `BUILT_IN` in `src/backends/registry.ts` maps each id to `{ description, hostSupport, targets, create }`; `tsc` fails when the two disagree. The list stays literal in `config/types.ts` to avoid a `config → registry → backend → checks → config` import cycle.

`BackendFactoryContext`: `ownerLabel()` (lazy), `tmpRoot?`, `procRoot?` (tests), `configDir?` (directory of the runtime's global config; the cua ledger and settings live there, so a runtime with a test config path never touches the real agent dir), `depsCacheRoot?`, `options` (`RuntimeOptions.backendOptions[id]`, used to inject fakes), and `runtimeOptions` (only docker-linux reads the M1 names `docker` and `dockerOnPath`). Creating a backend must start nothing and run no command: the runtime creates every registered backend at startup to ask its sweep gate.

Capabilities (all optional, detected by type guards in `src/backends/capabilities.ts` unless noted):

| Interface | Members | Used by | Implemented by |
|---|---|---|---|
| `ImageCapability` (`hasImage`) | `imageTag`, `buildImage(signal, onLine)`, `removeBaseImages(signal)` | `/gui-setup` remediation of `image.base`; `--purge-tooling` fit | docker-linux, remote-linux-docker |
| `DriftCapability` (`hasDrift`) | `version`, `currentVersions(signal)` | `gui_launch` drift check; smoke test records `package.version` | all five |
| `ResetCapability` (`hasReset`) | `resetSummary`, `resetNote`, `resetData?(signal)` | `/gui-reset` | all five |
| `SweepAvailability` (`hasSweepAvailability`) | `sweepAvailable({ startup })` | startup sweep (`startup: true`), `/gui-cleanup` (`false`) | all five |
| `OrphanAuditGate` (`hasOrphanAuditGate`) | `orphanAuditReady(results)` | `/gui-doctor` orphan audit | docker-linux, remote-*, cua |
| `RunnerCapability` (`hasRunner`) | `runner` | remediation commands, `.gitignore` check | docker-linux, local-linux, remote-* |
| `SmokeCapability` (`hasSmoke`) | `smokeApp()`, `smokeConfig?(base)` | smoke test | local-linux, remote-*, cua |
| `CostCapability` (`hasCost`) | `estimateCost(usage)` | `UsageTracker` cost warnings | cua |
| `BillingCapability` (`hasBilling`) | `billingStatus(inputs, signal)`, `recordSetupInputs(inputs)` | `/gui-setup` billing confirm, `--cloud`, `--rate-usd-per-hour`, `--targets` | cua |
| `RemoteHostCapability` (`hasRemoteHost`, `bindHost`, `src/backends/remote/host.ts`) | `forHost(host)` (a new view bound to `host`; the receiver never changes), `remoteHost` | host resolution in setup, doctor, cleanup, reset, `gui_launch` drift | remote-* |
| `RemoteSudo` (`hasRemoteSudo`, `src/commands/backend-inputs.ts`) | `passwordlessSudo(signal)` | `runSetup` (remote `sudo -n true`, not the client's) | remote-* |

`sweepAvailable` must be cheap and run no command or network call. Gates: docker-linux = `docker` on `PATH` (file system check); local-linux = `platform === "linux"`; remote-* = always `false` at startup, `true` with a host otherwise; cua = `cua` on `PATH` and a dead-owner ledger record (local files and `/proc` only). A test patches `child_process.*` and `fetch` and proves the whole startup path over all five real backends spawns nothing.

### Session contract

Optional members added after M1 (`src/backend.ts`): `SessionStartOptions.onExitCleanup?(argv)` (`DockerStartOptions` is a compatible alias), `Session.workspacePath?`, `forceRemoveArgv?()`, `workspaceDescription?`, `warnings?`, `platform?`, `capabilities?`, `depsCache?` (`DepsCacheReport`: `state: "hit" | "miss" | "off"`, `detail`, `key?`, `stored?`).

| Backend | `workspaceDescription` | `warnings` |
|---|---|---|
| docker-linux | none (M1 default "read-only mount" or "writable filtered copy") | — |
| local-linux, `mount` / `copy` | "the project directory itself (writable)" / "writable filtered copy (without dependency directories)" | skipped `setup` commands; copy-mode note |
| remote-linux | "writable copy synced to `<host>` (changes stay there)" | — |
| remote-linux-docker, `mount` / `copy` | "read-only mount of the copy synced to `<host>`" / "writable copy synced to `<host>` (changes stay there)" | — |
| cua | "writable copy uploaded to the sandbox (changes stay there)" | — |

`gui_launch` prints `arch:`, the workspace line, `network:`, `dependency cache: …`, and a `<backend> warnings:` block, and returns `details.{session, arch, pid, windows, sync?, depsCache?, backendWarnings?}`. Backend warnings never go to `config.warnings`.

### `HelperSession` (`src/transport/helper-session.ts`)

The generic session over any stdio child. Subclasses (`DockerSession`, `LocalLinuxSession`, `RemoteLinuxSession`, `RemoteDockerSession` via `DockerSession`, `CuaSession`) supply `labels` and hooks: `spawn(env)` (env = `{ PI_GUI_TESTING_TOKEN }`, never argv), `verifyAfterStart(signal)` (throw `SessionError("ISOLATION", …)` to fail closed), `onExitTimeout()`, `teardown()` (never trust the helper), `audit()` (read-only).

It provides READY and `hello` with `validateResult`, error mapping with bounded owned copies of helper text, a 16 KiB launcher stderr tail on start errors (except `quietCodes`, default `ISOLATION`), quoted as whole lines only (`diagnosticTail`, ≤ 1 500 characters) and passed through the backend's `sanitizeDiagnostic` hook when it has one, the `CLOSED` text, the stop sequence (helper `stop` → stdin close → wait 15 s → `onExitTimeout` → SIGTERM to the process group → SIGKILL after 5 s → `teardown`), `auditFootprint()` = `audit()` plus "launcher still running", `platform`/`capabilities` from `hello`, and a settable `depsCache`. `stop()` is idempotent, retryable, and shared by concurrent callers. Waits are unref'd so they cannot keep Pi alive.

Transports: `src/transport/process.ts` (`HelperProcess`, `wrapChildProcess` signalling the process group, `TailBuffer`), `src/transport/local-process.ts` (`spawnLocalProcess(argv, { env, cwd? })`: environment is exactly `env`, default `cwd` `/`, own process group; `DESKTOP_ENV` lists variables that must never leak), `src/transport/types.ts` (`HelperTransport`: `runner`, `spawnHelper(argv, env)`, `close?()`; connection failure = exit code 255 result, quoting is the transport's job, the token travels in the remote env or on stdin), `src/transport/ssh/` (below).

### Adding a backend

1. `src/backends/<id>.ts`: a class implementing `Backend` and the capabilities it supports; its checks, session, and sweep under `src/backends/<id>/`. Host support (`HostSupport { platforms, otherwise }`) goes to `commonChecks(id, { hostSupport })`.
2. Tests under `tests/unit/backends/<area>/`. `tests/unit/backends/fake-backend.mjs` is a minimal working example; register the entry in a test `BackendRegistry` and run it through `GuiRuntime`.
3. Session lifecycle, for every backend:
   1. `await options.recordResource(kind, id)` before creating each resource (`kind: "process"` with id `<pid>:<startTime>` for host processes), so it is listed in `owner.json`.
   2. `options.onExitCleanup?.(argv)` before creating resources: one argv that removes everything synchronously, without a shell, within 5 s. Later calls replace earlier ones. Expose the same argv as `session.forceRemoveArgv()`.
   3. On a failed start, `stopAfterFailedStart(session, error)` (`src/backends/start-failure.ts`) and rethrow; the runtime keeps the half-started session as `failed` and retries.
   4. `auditOrphans` and `sweepOrphans` act only on resources of dead owners; alive or unknown owners are reported, never removed.
4. Integration (owner): add the id to `IMPLEMENTED_BACKEND_IDS` and an entry to `BUILT_IN`, then rerun the suites; command tests that list backends may change text.
5. Backend-specific `/gui-setup` flags are refused on other backends by `setupFlagProblem` (`src/commands/backend-inputs.ts`); add the new flag there.

## Source layout

| Path | Contents |
|---|---|
| `index.ts` | Extension entry. |
| `src/protocol.ts`, `src/backend.ts`, `src/hardening.ts`, `src/labels.ts`, `src/owner.ts`, `src/*/types.ts` | Frozen contracts (M1 plan §5). Change only through the integration owner and record it in the plan. Protocol 2 and the optional `Backend`/`Session` members were owner-approved changes. |
| `src/framing/` | Line codec and `ProtocolClient` (READY handshake, correlation, heartbeat, bypass queue, log-event canonicalisation). |
| `src/config/` | Config files, field-by-field precedence, flag parser (`flags.ts`), verified-backend record and drift detection, atomic writes. |
| `src/checks/` | Check runner (dependency order, parallel probes, timeouts, `blocked`, `targets`) and the common checks. |
| `src/setup/` | Remediation plan, confirm flow, doctor (`recordState: false` probe mode), report emitter per Pi mode, smoke test, host picker (`hosts.ts`). |
| `src/cleanup/` | Session temp dirs, `owner.json`, owner liveness per OS (`identity.ts`), startup sweep, client audit, exit cleanup. |
| `src/usage/` | Loop detector, usage counters with the cost hook, session registry with limits and idle detection. |
| `src/runner/` | `CommandRunner` abstraction, real spawn runner (`INHERITED_ENV` incl. the Windows variables the docker CLI needs), fake for tests. |
| `src/transport/` | `HelperSession`, process wrappers, local spawner, transport contract, `ssh/` (quoting, options, errors, streams, `SshTransport`). |
| `src/backends/registry.ts`, `capabilities.ts`, `host-support.ts`, `response.ts`, `start-failure.ts` | Registry, capability interfaces and guards, host support, helper response validation, failed-start handling. |
| `src/backends/docker-linux.ts`, `src/backends/docker/` | docker-linux: Docker CLI argv and endpoint resolution, checks, image build context (ustar), hardened run argv, `isolation.inspect` rules, mount-mode guards, `DockerSession`, labelled-resource footprint, Docker Desktop rules (`desktop.ts`). |
| `src/backends/local-linux.ts`, `src/backends/local/` | local-linux: host support, helper env allow-list, display lock dir, distro package table, checks, `LocalLinuxSession`, lock/tag footprint audit and sweep. |
| `src/backends/remote-linux.ts`, `remote-linux-docker.ts`, `src/backends/remote/` | Remote backends: `RemoteBackendBase`, probes and checks, packages per manager, remote session-dir scripts, resources, helper deploy, `RemoteLinuxSession`, `RemoteDockerSession`, remote Docker orphans, `purgeTooling`. |
| `src/backends/cua.ts`, `src/backends/cua/` | cua: `CuaApi` seam and `CuaCliApi`, redaction, ledger, settings, session, deploy, tar bundle, checks, cost, orphans. |
| `src/sync/` | Spec §4.7 file-set builder, hardened Git, copy-mode staging; `transport/` streaming tar writer and `WorkspaceSync` (rsync or tar over SSH). |
| `src/deps/` | Dependency cache: key, store, transfer, flow. |
| `src/tools/` | `GuiRuntime`, the eight tools, result formatting, PNG decode/scale, logs, export. |
| `src/commands/` | The seven commands with `ctx.hasUI` branching; `backend-inputs.ts` (flag fit, host resolution); `gitignore.ts`. |
| `helpers/linux/` | Python helper (`helper`, `pi_gui_helper/` incl. `hostmode.py`, `probe.py`, `deps.py`), `Dockerfile` (multi-arch Debian trixie slim pinned by digest, `ARG PROTOCOL_VERSION=2`), `.dockerignore`. |
| `testapps/` | GTK 3 smoke app (baked into the image, deployed to remotes and sandboxes) and GTK 4, PySide6, Electron, Tk sample apps with `.pi/gui.json`. |
| `skills/gui-testing/SKILL.md` | Bundled skill (spec §9). |

## Security invariants

These are enforced in code and covered by tests; keep them when changing anything.

1. Never start a GUI process with the host's display. The Docker backends never mount host display, D-Bus, or Docker sockets. local-linux and remote-linux force the private `DISPLAY`, bus, `XDG_RUNTIME_DIR`, and `HOME` on every child and drop Wayland variables.
2. No automatic backend switching; a configured but unimplemented backend is refused with the "not available yet" text.
3. No remediation without one confirmation or `--fix`; no prompts without UI. Flags that do not fit the backend are refused.
4. No project data in the image or build context: the context is a staged tar of helper files and the smoke app only.
5. `dockerRunArgs()` is the single source of the run configuration for sessions and the `isolation.inspect` probe, locally and on remote hosts. `hardRuleViolations()` checks a `docker inspect` result against `src/hardening.ts` and reports every violation. Sessions are inspected after start and before any app runs; a failure stops the session (fail closed).
6. `isolation.inspect` is stricter than the frozen forbidden-path list: it also rejects binds under `/tmp/.X11-unix`, anywhere under `/run` or `/var/run` except private sub-directories of `/run/user/<uid>/`, any bind source that is itself a socket, and on Docker Desktop the Desktop forbidden paths.
7. Mount mode refuses forbidden roots and any Unix socket in the tree; the scan does not follow symlinks, is bounded to 20 s, and fails closed on timeout or unreadable directories.
8. Negative tests never start a container with a forbidden setting; they use `docker create` and remove it.
9. Cleanup is idempotent; sweeps only remove resources of owners proven dead. Owner labels with fewer fields, unknown owners, and owners from another OS flavor are reported, never swept. Pi startup never runs a command or network call for a backend whose gate is closed, and never contacts a remote host.
10. local-linux never runs `setup` (`exec` is disabled in the helper) and never installs anything for the project.
11. SSH: `BatchMode=yes`, `StrictHostKeyChecking=yes`, a ControlMaster per session, a connect timeout on every call; never handle passwords; never write `~/.ssh/config` or `known_hosts`.
12. Nothing persists on a remote host between sessions except the opt-in Docker base image and packages the user approved; the remote session dir is removed on every exit path.
13. cua: no real API calls in tests; every cleanup path deletes the sandbox unless `keepSandbox`; the package stores no credential; no secret in any argv.
14. The client never unpacks a dependency archive; the helper verifies size and SHA-256 and unpacks under the rules in the protocol doc.

## Implementation notes

### docker-linux (M1)

- `docker run` uses `--pull never`, `--name pi-gui-testing-<session>` (so `owner.json` lists the container before it exists), uid/gid-owned tmpfs for `/tmp`, `/scratch`, `$HOME`, `/deps`, `/run/user/<uid>`, and generated read-only `/etc/passwd` and `/etc/group` from the session dir. `--shm-size 512m` is added for `electron`, `npx electron`, `node …/electron/cli.js`, and Chromium names only.
- The image tag is `pi-gui-testing-base:<package version>`; labels `pi-gui-testing.base`, `.version`, `.protocol` drive `image.base` and drift detection. `docker build --force-rm` removes intermediate containers of an aborted build.
- Docker endpoint: `DOCKER_HOST`, else `docker context inspect`. Every Docker call passes `--host` explicitly. Endpoint rules per OS: see [Docker Desktop](#docker-desktop-m1c).
- **Mount identity:** mount mode resolves the project realpath once, scans it, records dev/ino, passes the realpath to Docker, requires the inspected `/workspace` mount source to equal it (session inspect and `isolation.inspect`), and runs `stat` over the helper's `exec` before setup or the app; a mismatch stops the session. The `exec` triggers the helper's `/deps/venv` creation, which adds a few seconds to sessions without `setup`.
- **Copy-mode TOCTOU:** candidates with a symlinked ancestor are excluded; at copy time each file is opened with `O_NOFOLLOW`, its identity (`dev:ino:birthtime`, so a replacement that reuses the inode is still caught; an in-place edit keeps it) must match enumeration, and its real path (via `/proc/self/fd`) must stay inside the project. This narrows, but does not close, the check-to-copy race: a replacement that reuses the inode within one kernel timestamp tick (a few ms) keeps the identity, and file systems without a birth time fall back to dev/ino. A directory link is kept only when a synced file lies under its target.
- **Helper venv:** the helper `chdir`s to `/` at start and creates `/deps/venv` with `python -I -m venv` from `/` with a minimal environment (no token, no `PYTHON*`), so no workspace module can run before the workspace identity check. `tests/helper/test_venv.py` proves venv creation never imports modules planted in the working directory.
- **Docker sweep gating:** `dockerOnPath()` checks `PATH` on the file system (on Windows, `PATHEXT` names on a `;`-separated `PATH`); the sweep runs whenever it finds `docker`, independent of verification, and reports errors instead of throwing.
- **Exit cleanup for pending starts** uses the backend's endpoint-bound `docker --host <endpoint> rm -f` through `SessionStartOptions.onExitCleanup`, registered before the container is created.

### Runtime, tools, and commands

- `gui_act` coordinates are in the pixels of the image the model saw; the tool divides by the capture's `scale` and defaults `captureId` to the latest screenshot. A stale explicit `captureId` is refused before the helper. `gui_act` returns a screenshot only with `screenshot: true`.
- `gui_stop` works on a live session even if the backend became unverified; all other tools refuse with the spec's "not set up" text.
- Limits are read from config at the first launch and re-read whenever no session runs. The `UsageTracker` is created once; its cost thresholds are getters over the `usageCheck` of the latest non-transient session start.
- **Helper responses are untrusted** (an app runs with the helper's UID and can read its token from `/proc`). `src/backends/response.ts` validates each method's result (types, arrays, enums, base64, PNG header, size limits, transfer ids `^[A-Za-z0-9_-]{1,64}$`, 64-hex SHA-256, sizes ≤ 2^50, `platform` ≤ 256 characters) and fails with `BAD_RESPONSE`. Artifact names are generated client-side (`src/tools/artifacts.ts`), written with exclusive create, and every host write is checked for containment in the artifact dir or export destination.
- **Hardened Git** (`src/sync/git.ts`): `-c core.fsmonitor=false`, hooks disabled, `--no-optional-locks`; used for `ls-files` and `check-ignore`.
- **Teardown state:** sessions move `running → closing → failed | forgotten`. A failed stop keeps the temp dir, `owner.json`, and the exit handler and is retried by `gui_stop`, `/gui-cleanup`, and shutdown.
- **Shutdown:** pending session starts and setup/doctor runs are tracked; shutdown aborts them, waits up to 20 s, and tears down any session that finishes starting late. `admit()` records activity before any await, so idle reaping skips sessions with queued or in-flight calls.
- **Drift:** the verified record holds the keys of each backend's `currentVersions`: docker-linux package, Pi, protocol, Docker CLI/server, image tag and id; local-linux `package.version`, `pi.version`, `protocol`, `python.version`; remote-* `package.version`, `pi.version`, `protocol`, `remote.host` (no connection before each launch); cua `package.version`, `pi.version`, `protocol`, `cua.cli`, `cua.location`, `cua.region`. cua also `cua.image` (fact of `cua.targets`). Any change blocks new launches; running sessions continue. For remote backends `gui_launch` binds a view with `forHost(config.remote.host ?? verified.inputs.host)` before `currentVersions` and passes that host in the session config.
- **Host binding (V1):** the shared remote backend held by the runtime has no host and is never re-pointed. Every operation works on its own immutable view: `/gui-setup` (after `--host`/picker resolution), `/gui-doctor` (after `beginSetup`, so a refused doctor binds nothing), `/gui-cleanup` and `/gui-reset` (`configuredView`), `gui_launch` (`bindHost`). Views share `RemoteSharedState` (running-session counts for `purgeTooling`). `GuiRuntime.sweepableBackends`, `sweepNow`, and `auditOrphans` take optional `BackendViews`; `runSmokeTest` takes `view`. The smoke session reaches its host through `smokeConfig` → `config.remote.host`.
- **Session tools (V6):** tools on an existing session verify and name `LiveSession.backend`, not the active backend; only a session id that is not running falls back to the active backend's verification text.
- **Verified inputs:** `inputs` may hold `backend`, `scope`, `host`, `cloud`, `targets` (never secrets).
- **Failed starts** (`src/backends/start-failure.ts`): when a start fails and its teardown also fails, the backend attaches the leftover session handle to the error; the runtime retains it as `failed` until an audit confirms removal.
- **Response limits:** accessibility bounds accept integers up to ±2^31 and are dropped per node when malformed; window geometry accepts the X11 range; names, values, and titles are cut at 64 KiB.
- **Log limits** (`LOG_LIMITS`): at most 10 000 events / 1 MiB in memory with per-event overhead, 64 KiB per chunk; disk writes are batched with a "dropped N" marker, and `app.log` stops at 64 MiB. Log events are canonicalised in the protocol client (`src/framing/log-event.ts`).
- **Setup runs** are registered before the backend picker opens, so `/gui-cleanup` and shutdown cancel the picker, and a late answer is rejected by a generation check. The picker (and the no-UI hint) lists only backends whose `hostSupport.platforms` includes `RuntimeOptions.platform ?? process.platform`; an explicit `/gui-setup <id>` still runs and `host.os` reports the mismatch.
- **`/gui-setup` order** (`src/commands/commands.ts`): flag fit (`setupFlagProblem`, also after the picker) → host resolution for remote backends (`--host` → `remote.host` local → global → `pickHost` with UI only; no UI and no host fails at once with the `--host` hint) → `bindHost` (the run's own view) → billing (`--accept-billing`, or exactly one `ui.confirm` with `BillingStatus.text`, then `recordSetupInputs`; no UI and no flag → `cua.cost-ack` fails, `needs-user-action`, extra line naming `--accept-billing`) → checks/remediation (`passwordlessSudo` from `hasRemoteSudo`) → smoke → persist (`backend`, `remote.host`, `remote.purgeTooling: true` when given; verified `inputs`). "Other host…" adds a `~/.ssh/config` template to the report.
- **`/gui-doctor --host`:** when it differs from the configured host (string comparison), doctor runs with `recordState: false` and adds the probe-only line; otherwise it refreshes `inputs.host`.
- **Runtime generation:** `guarded()` captures the runtime's shutdown signal before its first `await`; commands that start sessions or write config, and `gui_launch`, refuse a stale generation with "Pi is shutting down (or restarted this extension)".
- **Export destinations** are resolved (nearest existing parent, then the created dir) before the containment check; the export deadline timer is referenced while an export runs. Export runs under one overall deadline; log flush and stream copies are abortable, and a partial file is removed.
- The `.gitignore` offer uses the setup dialog adapter, re-checks abort before writing, opens with `O_NOFOLLOW`, writes only to regular files, and is report-only with `--no-fix`.
- Probe temp dirs use the prefix `pi-gui-probe-`, so the startup sweep never reports them as unknown session dirs.
- `/gui-reset` refuses without UI (no confirmation flag exists).
- Smoke test: transient session not counted against `maxConcurrentSessions`, empty read-only workspace, `network: none` (local-linux and remote-linux override to `default` via `smokeConfig`); accepted button roles `button`, `push button`. The smoke session uses the backend's host but not `config.remote`, so it never triggers `purgeTooling`.

### Helper host mode contract

Used by local-linux and remote-linux. The authoritative text is the docstring of `helpers/linux/pi_gui_helper/hostmode.py`; summary:

- `PI_GUI_HELPER_MODE=host` selects host mode (`container` or unset = image behaviour; anything else fails startup). `PI_GUI_WORKSPACE` (default `cwd` of `launch`/`exec`), `PI_GUI_RUNTIME_DIR` (client-created, real dir, owned by the user, mode 0700; the helper creates `home/`, `tmp/`, `xdg/`, `Xauthority` in it), `PI_GUI_DISPLAY_LOCK_DIR` (per-user lock dir, no group/other write), optional `PI_GUI_ALLOW_EXEC=1` (default off: `exec` answers `BAD_REQUEST`), optional `PI_GUI_DEPS_DIR` (protocol 2; never set by local-linux), plus the token and the heartbeat test variable. Contract variables never reach a child.
- Startup: validate the dirs; claim display `:N`, `N` in 90..599, by `link()`ing a lock record to `<lock dir>/display-<N>.lock`, skipping numbers with an X socket or lock file; start `Xvfb :N -displayfd <fd> -auth <runtime>/Xauthority -nolisten tcp` with a fresh MIT-MAGIC-COOKIE-1 (5 attempts); start a private `dbus-daemon --session` on `unix:path=<runtime>/xdg/pi-gui-bus`, then `at-spi-bus-launcher` and `openbox` when installed (failures degrade: `coverage: "none"`, no `a11y-atspi` in `hello`, windows = mapped non-override-redirect root children); print READY.
- Forced child env: Wayland variables, `NO_AT_BRIDGE`, `SESSION_MANAGER` removed; private `DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `HOME` with `XDG_*_HOME` below it, `TMPDIR`; X11 toolkit forcing; Qt accessibility; `PI_GUI_TAG=<16 hex>`. The request `env` cannot override them. `PATH` is the client's; `/deps/venv` is never created in host mode.
- Lock record (JSON `version: 1`): `display`, `helper` (`<pid>:<starttime>`), `bootId`, `tag`, `runtimeDir`, `workspace`, `createdAt`, `xvfbPid`, `infra` (`xvfb`, `dbus`, `atspi`, `openbox` → `<pid>:<starttime>`); rewritten atomically after each infrastructure process starts.
- Teardown (stop, stdin EOF, signals, heartbeat): kill app and `exec` process groups, openbox, AT-SPI, every process of the user whose initial environment carries the tag (except bus and Xvfb), then bus and Xvfb, then tagged processes again; remove `/tmp/.X<N>-lock` and `/tmp/.X11-unix/X<N>` only when they name this session's Xvfb and it is gone; remove the lock and the runtime subdirs. Host mode never runs the container-wide process sweep.
- Clients may clean up after a lock whose `helper` is dead (other boot, PID gone, other start time): kill tagged processes and `infra` entries whose start time still matches, remove the X files under the same condition, delete the lock. Locks of live helpers are never touched.
- Probes (no READY, no protocol): `helper --probe display` starts and stops a private Xvfb through the lock dir; `helper --probe env` prints which desktop variables a child would see (`linux.wayland-scrub`).

### local-linux (M2)

- Client argv `[python3, "-I", "-B", <pkg>/helpers/linux/helper]` (`/usr/bin/python3` when present), cwd `/`, own process group. Env exactly `PATH LANG LANGUAGE LC_ALL LC_CTYPE LC_MESSAGES TZ USER LOGNAME` from Pi (when set) plus the contract variables and the token; never `HOME`.
- Runtime dir `<session dir>/runtime` (0700); lock dir `<tmp>/pi-gui-displays-<uid>` (0700, ownership checked), deliberately not `pi-gui-testing-*` so the session-dir sweep never sees it. The bus socket path must stay within the 107-byte `sun_path` limit; a too-deep session dir fails with the `TMPDIR` hint.
- `verifyAfterStart` finds the lock whose `helper` equals the spawned helper's `<pid>:<starttime>` and fails closed (`ISOLATION`) unless display ≥ 90, display ≠ the desktop's `DISPLAY` number, `runtimeDir` and `workspace` are the session's, and `/tmp/.X11-unix/X<N>` exists and is owned by the user.
- `network: "none"` is refused (`UNSUPPORTED`). Exit cleanup argv: `["kill", "-TERM", "--", "-<helper pid>"]`.
- Checks: spec §5.4 list plus `linux.xutils`; `linux.screenshot` checks ImageMagick (`magick`, or `import` + `convert`), which the helper uses (`xwd` is not used); `linux.dbus` requires `dbus-daemon`.

### SSH transport (M2b)

- `src/transport/ssh/options.ts`: `BatchMode=yes`, `StrictHostKeyChecking=yes`, `UpdateHostKeys=no`, `ConnectTimeout`, `ServerAlive*`, no agent/X11/port forwarding, no `LocalCommand`, no TTY. One ControlMaster per session (`-M -N -f`, `ControlPersist=60`), socket in the client session dir or `/tmp/pgt-ssh-XXXXXX/s` when the path would exceed `sun_path` (macOS `TMPDIR`). `close()` runs a retryable `ssh -O exit`.
- `quote.ts`: `shellQuote`/`shellJoin` valid in POSIX shells and fish (tested in sh, bash, fish incl. injection cases), `assertDestination` (no leading `-`, whitespace, quotes, or shell characters), `assertEnvEntry`, `assertSafeRemotePath`. csh/tcsh would misparse.
- `errors.ts`: `classifySshFailure` (auth, host key unknown/changed, resolve, unreachable) and `sshRemediation` texts. Probe labels add `host key changed` to the spec's five.
- The remote helper runs under `env -i` with only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TZ` from the login plus the contract variables; the token is written on stdin and never appears in argv on either side.
- `src/setup/hosts.ts`: `listConfigAliases` (Include, globs, `~`, nesting ≤ 16), `resolveHost` (`ssh -G`), `discoverHosts` (≤ 8 parallel probes, 5 s total, only when the picker is shown), `parseOtherHost`, `hostBlockTemplate`, `pickHost` (no UI → `MissingInputError` naming `--host`, probing nothing).
- `remote.hostkey-pinned` records a hash of the `known_hosts` keys (`ssh-keygen -F`) as fact `remote.hostkey`. `ssh.jump` probes each `ProxyJump` hop with `true`.
- Remote installs: `ssh -o BatchMode=yes -T -- <host> 'sudo -n <pm> install …'` after one confirmation or `--fix`, only with passwordless sudo; otherwise shown as `ssh -t <host> sudo <pm> install …`. Package names for pacman, apt-get, dnf, zypper, apk (`src/backends/remote/packages.ts`).

### Remote session dirs, deploy, and sync (M2b)

- Detached `ssh` runs (`src/transport/ssh/stream.ts`, W10): stderr goes to a log opened `O_RDWR|O_CREAT|O_TRUNC|O_APPEND|O_NOFOLLOW`; only a 16 KiB tail is read back, by position into a fresh buffer (a cut leading UTF-8 character dropped); every 200 ms a log over 1 MiB keeps its tail in memory and is emptied. The log is closed and removed on every path.
- Session root: first that passes `remote.session-root` and `remote.exec` of `$XDG_RUNTIME_DIR/pi-gui-testing`, `/tmp/pi-gui-testing-<uid>`, `~/.cache/pi-gui-testing-tmp` (real dir, owned by the user, 0700, exec allowed). Per session `<root>/s-<session>-<random>/` with `owner`, `tooling/`, `workspace/`, `run/`, `deps/`; `<root>/displays/` holds display locks.
- Scripts in `src/backends/remote/session-dir.ts` (`CREATE`, `REMOVE`, `AUDIT`, `LIST`, `SESSION_WRAPPER`) avoid GNU-only flags (bash and BusyBox `sh` tested on the development host only). `/proc` scans are O(user processes) with two forks each (`cat | tr`); start times are parsed in the shell.
- **Process selection (W2):** a snapshot line is ` <pid>:<starttime> <cmdline and environ words> `. A process belongs to a session when a word *is* the session path or lies below it (` P `, ` P/`, `=P `, `=P/`; never a substring, so `s-a-1` does not select `s-a-12`), when its environment holds exactly `PI_GUI_TAG=<tag>` of a display lock naming the session, or when it is an `infra` entry of such a lock from this boot. Before every signal `same` re-reads `/proc/<pid>/stat` field 22 and drops reused PIDs. A session dir that is a symlink or not the user's directory is never followed (`cd -P` is applied to the verified root only): REMOVE reports `left=remote-dir … not touched`, AUDIT reports `dir=`, LIST skips it.
- **Display locks (W9, X5):** `<root>/displays/display-N.lock` records (JSON from `hostmode.py`, ≤ 64 KiB, regular, owned, not symlinks) are parsed as JSON by `JSON_AWK`, a POSIX awk reader run with `LC_ALL=C` (any spacing or key order; `\uXXXX` decoded to UTF-8; invalid JSON, duplicate keys, nesting over 16, control characters, or a non-object top level make the record unusable, so it is never attributed). It prints `s:`/`n:` lines for string and number members (nested objects as `infra.xvfb`) that `field`, `num`, and `infra_of` read. A record belongs to a session when `runtimeDir` is exactly `<root>/<name>/run`. REMOVE kills their tagged and infra processes, then deletes each lock whose helper (`pid:starttime`, same boot) is dead, plus `/tmp/.X<N>-lock` and the socket when the X lock names the recorded `xvfbPid` and that Xvfb is gone; a live helper or Xvfb is a `left=` line. REMOVE also handles locks of a name whose dir is already gone. AUDIT prints `lock=` (leftover kind `display-lock`). LIST prints `lock<TAB>name<TAB>path<TAB>alive|dead` for locks whose session dir is gone and `lock<TAB>-<TAB>path<TAB>unknown` for locks naming no session dir; `decideLocks` removes dead ones through REMOVE and reports the rest.
- **Remote-owned cleanup (V4):** the helper (remote-linux) and `docker run` (remote-linux-docker) run under `SESSION_WRAPPER_SCRIPT` (`sessionWrappedArgv`): `trap : HUP PIPE`, run `"$@"`, then — whatever ended it (stop, stdin EOF after a dropped connection, heartbeat timeout, crash) — `docker --host <h> rm -f -- <container>` (remote-linux-docker), and, only for a dir named `s-*` that is a real directory owned by the user, mode 700, with an `owner=` record, `exec env -i … sh -c REMOVE_SCRIPT sh graceful <name>` (the name only in argv, so it never selects itself). The client's own teardown still runs and kills the wrapper by its path word.
- Removal on stop, failed start, idle reap, and exit (one bounded `ssh` call that kills tagged processes and removes the dir; for remote-linux-docker also `docker --host <h> rm -f <container>`). The root is removed when empty.
- Each session start first removes orphaned session dirs and labelled containers of dead owners on that host. Foreign-owner rule: another boot or another client is `foreign`; kept while a tagged process runs, reported otherwise, removed only after 24 h with no process. Unknown or malformed owners are only reported.
- Helper and smoke app are deployed by tar and verified with `sha256sum` (`deploy.ts`). `helper.deploy` deploys, verifies, and imports the package; the `hello` handshake is covered by the smoke test.
- `WorkspaceSync` (`src/sync/transport/workspace-sync.ts`): stage the §4.7 file set with `copyFileSet` into `sync/stage-N` in the client session dir (copy-mode checks apply; rsync never reads the live project), then rsync (`--checksum`, `--safe-links`, needs rsync on both ends and an alias or `user@host` destination) or the package's own streaming ustar+PAX writer (`tar-stream.ts`; no local `tar` needed). Re-syncs delete files that left the set by exact path inside the remote workspace with `REMOVE_STALE_SCRIPT` (W1): POSIX sh, paths as argv; the workspace must be a real directory owned by the user; each path is walked one component at a time from the resolved workspace, stopping (path left untouched) at a symlink, non-directory, empty, `.`/`..` component, or when `pwd -P` leaves the expected place; the leaf is removed relative to the checked directory (a symlink leaf itself, never its target; never a directory). No `--delete`. Status: `synced N files to <host>:<dir> (X bytes sent via rsync|tar, M excluded)`.
- remote-linux-docker reuses `dockerRunArgs`, `DockerSession`, `hardRuleViolations`, `workspaceMountProblem`, `listLabelledObjects`/`removeObject`, `buildBaseImage`, `resolveEndpoint`, and `dockerLinuxChecks` unchanged with an SSH runner and a remote spawner (`platform: "linux"` pinned). The image build context is streamed over SSH.
- **`purgeTooling`:** `RemoteDockerSession.afterStop` runs only after a clean container and remote teardown; with `remote.purgeTooling` it removes every `pi-gui-testing.base` image on the session's host (90 s bound) when it is the last running session of this backend on that host in this Pi process. A failed removal is an `image` stop leftover that does not keep the session `failed` (audit is empty). A start with `purgeTooling` runs `docker image inspect` and rebuilds a missing image with the status "building the base image on `<host>` (purgeTooling removed it …)". `removeBaseImagesOn(runner, destination, signal)` is exported.

### Dependency cache (M1b)

- **Protocol 2** adds `depsPack`, `depsRead`, `depsReceive`, `depsWrite`, `depsUnpack`, `depsDiscard`, the error codes `ARCHIVE_REJECTED` and `TOO_LARGE`, `hello.platform`, the `deps` capability, and `PI_GUI_DEPS_DIR`. Chunks are 4 MiB (`DEPS_CHUNK_BYTES`), far below the 64 MiB line limit. Default timeouts: pack/unpack 10 min, read/write 60 s, receive/discard 15 s. Archive and unpack rules: [docs/protocol.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-gui-testing/docs/protocol.md#dependency-cache-version-2). In `deps.py`, `_BoundedTarInfo._proc_member` charges every header record to `_Budget` before tarfile reads its payload and refuses an old GNU sparse (`S`) member there, before tarfile's `_proc_sparse` reads its extension blocks; the overridden `_proc_gnusparse_00/01/10` refuse PAX sparse members once the (64 KiB-bounded) PAX record is parsed and before any sparse map is read, and `_apply_pax_info` refuses any other `GNU.sparse.*` attribute (X2, `SparseMemberTests`, traced peak under 1 MiB). The hooks rely on tarfile's private `TarInfo` methods.
- **Format:** gzip, not zstd (spec §4.8 says `.tar.zst`): the helper's Python (3.11 typical) has no zstd before 3.14, and the client must not transcode untrusted data. The client stores the helper's bytes as they are.
- **Layout** (`src/deps/store.ts`): `<root>/<project-hash>/linux-<arch>/<key>.tar.gz` + `<key>.sha256` (`"<sha256>  <key>.tar.gz\n"`) + `<key>.lock` while writing. Root `$XDG_CACHE_HOME/pi-extension-gui-testing/deps` or `~/.cache/…` (0700). `project-hash` = first 16 hex of SHA-256 over the project's real path. The sidecar's mtime is `lastUsed`.
- **Key** (`src/deps/key.ts`): SHA-256 over canonical JSON of key format 1, backend, base (`image <version>` or `helper <version>`), target OS, arch and `platform` from `hello`, `deps.keyFiles` (or `"default"`), `setup`, sorted `deps.env`, and every key file with its SHA-256. Key-file search: depth 8, ≤ 100 000 entries, ≤ 256 files, ≤ 64 MiB per file, no symlinks, skips `.git`/`node_modules`/venvs/build output. A key error means "not used: …" and setup runs.
- **Flow** (`src/deps/flow.ts`): hit = verified lookup → `depsReceive`/`depsWrite`/`depsUnpack` → touch → skip setup. Miss = setup → `depsPack` → `depsRead` into the writer → commit (size and hash verified) → `depsDiscard` → LRU eviction. Writable-workspace guard: before setup an `exec` writes a marker in `${TMPDIR:-/tmp}` and sleeps 1 s; after setup `find <ws> -xdev -cnewer <marker> -print -quit` must find nothing (ctime cannot be forged by tar or `touch`); a failing `find` also means "not stored". Read-only workspaces skip the check.
- **Never fatal:** cache problems fall back to running setup and are named in the report. Only `CLOSED`, `CANCELLED`, `BAD_RESPONSE`, `PROTOCOL_ERROR`, and an aborted start propagate. `ARCHIVE_REJECTED` deletes the entry, reruns setup, and stores a fresh entry.
- **Concurrency:** one writer per entry through an `O_EXCL` lock (stale after 30 min, refreshed every minute); readers re-verify; eviction skips locked entries, keeps the just-used entry last, and removes temp files and unpaired halves older than 1 h.
- **Venv:** `/deps/venv/bin/python*` links point outside the deps dir and are skipped when packing; after an unpack the helper resets `_venv_ready`, so the next `exec`/`launch` recreates the venv (a few seconds of `ensurepip`).
- **remote-linux:** deps dir `<remote session dir>/deps`; setup gets `PIP_TARGET`, `PYTHONPATH`, `npm_config_prefix`, `NODE_PATH`, and `PATH` additions (request `env` may override). `pip install --user` conflicts with `PIP_TARGET`.
- **Not used:** local-linux (no setup, no `PI_GUI_DEPS_DIR`) and cua (its host-mode helper has a guest deps dir `<dir>/deps`, but `runSetupWithCache` is not wired; `setup` installs there every session, also in a reused kept sandbox, whose guest root is cleared at reuse).
- `/gui-cleanup --deps` clears the whole root; a failure is a `deps-cache` footprint leftover. Config `depsCache.{enabled, maxSizeGB}` resolves per field to `ResolvedConfig.depsCache = { enabled, maxBytes }`.

### Docker Desktop (M1c)

- **Host support:** docker-linux runs on `linux`, `darwin`, `win32`.
- **Endpoint** (`src/backends/docker/desktop.ts`): Linux and macOS accept any `unix://` socket (Desktop: `unix:///Users/<u>/.docker/run/docker.sock`, context `desktop-linux`). Windows accepts only a local named pipe `npipe:////./pipe/<name>`; TCP, SSH, unix sockets, and remote pipes fail. Remote backends pass no platform, so Linux semantics apply there.
- **`docker.rootless`:** Desktop passes with a note (identified by `docker info` `OperatingSystem`/`Name`); a daemon reporting `name=rootless` still fails.
- **`docker.bind-uid`:** macOS runs the container as the user's UID/GID and requires the probe file to be owned by the user on the host. Windows has no POSIX UID: the container runs as `1000:1000` (`WINDOWS_CONTAINER_UID`/`GID`, generated user `app`); the probe passes when the file appears in the shared temp dir and can be deleted. A missing file fails with the File sharing hint.
- **Paths:** Windows bind sources stay native (`C:\…:/workspace:ro`); `splitBind`/`bindSources` understand drive letters. Daemon-reported VM forms are mapped back before the rules run (`/run/desktop/mnt/host/c/…`, `/host_mnt/c/…` on Windows; `/host_mnt/…` on macOS). `sameHostPath` accepts equivalent forms (case-insensitive on Windows; `/private` on macOS).
- **Forbidden paths and roots** per OS as listed in TECHNICAL.md; enforced both as bind sources (`isolation.inspect`) and as project roots.
- **Workspace identity:** Desktop file sharing changes dev/ino, so on `darwin`/`win32` the helper runs `[ "$(LC_ALL=C ls -A1 /workspace | sha256sum)" = '<fingerprint>  -' ]`, where the fingerprint is the SHA-256 of the host dir's top-level names, sorted bytewise, each followed by LF. Weaker than dev/ino (a swap to a directory with identical top-level names passes) but fail-closed. Linux keeps dev/ino.
- **`os.tmpdir()`** needs no change: macOS `/var/folders/…` is shared by default; Windows `%LOCALAPPDATA%\Temp` is reachable with WSL 2, Hyper-V needs a shared drive.

### Owner liveness per OS (`src/cleanup/identity.ts`)

- **Linux:** boot id from `/proc/sys/kernel/random/boot_id`; start time from `/proc/<pid>/stat` field 22. Any non-default `procRoot` (tests) means `/proc`.
- **macOS:** start time from `/bin/ps -o lstart= -p <pid>` under `LC_ALL=C TZ=UTC0` as UTC seconds; boot id `darwin-<kern.bootsessionuuid>`, falling back to `darwin-boot-<kern.boottime sec>`. The two forms are different kinds (`bootKind`): an owner recorded with one and judged with the other is `unknown`, never `dead`, so it is never swept (W3).
- **Windows:** start time from PowerShell `Get-Process` (UTC seconds); boot id `win32-boot-<LastBootUpTime UTC seconds>`; `-NoProfile -NonInteractive`, minimal env, `windowsHide`, 15 s timeout; cached per process.
- **Cross-OS labels** (boot-id flavor differs from this host's) are `unknown`, never `dead`, and never swept. Unreadable state is also `unknown`.

### cua (M3, Linux target)

- **Surface:** Cua Cloud (hosted API, `CUA_API_KEY`) ended on 2026-10-18 (cua.ai migration guide). The backend drives the open-source `cua` CLI (written against 0.7, `trycua/cua` at `dcb907e`), which creates sandboxes in the user's own AWS, GCP, Hetzner, or Modal account (`--on <cloud>`). All access goes through the `CuaApi` seam (`src/backends/cua/api.ts`); the only production adapter is `CuaCliApi` (`cli-api.ts`). A new surface needs one new adapter.
- **CLI calls:** `cua --version`; `cua --json auth status` (no network) and `auth whoami`; `cloud status` (providers, regions, TTL, kinds with `usd_per_hour`); `cloud test <cloud>` (creates nothing); `sandbox create <image> --on <cloud> --name <name>`; `sandbox info <cloud>:<name>`; `sandbox ls --no-size`; `sandbox rm <ref> --force`; `sandbox cp <file> <ref>:<path>` (one file per call, so payloads are tars); `sandbox exec -i [--cwd d] <ref> -- argv…`. Exit codes 2 invalid, 3 not found, 4 unsupported, 5 transport, 6 auth, 7 disk, 8 no room, 130 cancelled. Every call: argv only, timeout and abort signal, bounded output (256 KiB, 4 MiB for listings), shape-validated JSON, redacted errors (`redact.ts`: bounded linear patterns, input cut to 4 000 characters at a word boundary). Env pass-through: `CUA_*`, `AWS_*`, `GOOGLE_*`, `CLOUDSDK_*`, `HCLOUD_*`, `MODAL_*`, proxies, `CUA_NO_BROWSER=1`; never `DISPLAY`/`WAYLAND_*`. Only `ARGV_ENV_NAMES` (config locations, profile/project/region names, TLS and proxy settings) may appear in an argv (`nonSecretEnvWords`, W5), and only values without line breaks, without `@` (proxy userinfo), at most 1 024 characters, and unchanged by `redact`. The only direct network call is `cua.network`'s credential-free `HEAD https://api.cua.ai/` (`CUA_SPACES_API_URL` overrides).
- **Unverified assumptions:** `--json` works before every subcommand (clap `global = true`); `sandbox ls` lists cloud sandboxes; `exec -i` accepts `--cwd`; Cua's `linux` image allows `apt-get` as root or with passwordless sudo; `cua sandbox rm` often finishes within the 5 s exit bound.
- **Helper transport:** `exec -i` has no `--env`, so the guest command is `sh -c '<preamble>exec "$@"' sh python3 -I <dir>/tools/helper`. `envPreamble(env)` builds one `IFS= read -r <NAME> && export <NAME> && ` per variable of the helper environment (the token plus `cuaHelperEnv`, sorted by name) and the matching stdin lines, one value per line, written before any frame; names must be plain variable names and values may not hold a line break. The helper runs in host mode (V7, `cuaHelperEnv`): `PI_GUI_WORKSPACE=<dir>/workspace`, `PI_GUI_RUNTIME_DIR=<dir>/run`, `PI_GUI_DISPLAY_LOCK_DIR=/tmp/pi-gui-testing/displays`, `PI_GUI_DEPS_DIR=<dir>/deps`, `PI_GUI_ALLOW_EXEC=1` (setup runs through `exec`), all created 0700 by `deployHelper`; no writable `/deps` and no `python3-venv`. When `setup` uses pip (`setupUsesPip`), the probe also requires `python3 -m pip` and the install adds `python3-pip`. Start errors quote launcher stderr through `diagnosticTail` (whole lines only, ≤ `STDERR_QUOTE_CHARS`) and the `sanitizeDiagnostic` hook, which cua wires to `redact` (W4). The deprecated `cua-computer-server` API is not used.
- **Naming and ledger** (`ledger.ts`): sandbox `pi-gui-testing-<hostTag>-<sessionId>`, `hostTag` = first 8 hex of `sha256(/etc/machine-id)`. One 0600 JSON record per sandbox in `<configDir>/cua-sandboxes/` (0700): `phase` (`creating`, `created`, `deleting`), owner label, session id, `keep`, project key, `image` (X3; absent in records of older versions). Written before `sandbox create`, removed only after deletion is confirmed. Kept sandboxes live under `<name>.kept.json`; every move between the sets is one `rename`, so a record is in exactly one set.
- **Ledger lock** (`ledger-lock.ts`, X1): every transition (`write`, `update`, `remove`, `markKept`, `claimKept`, `claimForDeletion`) runs under one ledger-wide interprocess lock and re-reads the record inside it. Transitions that name an expected owner (`ExpectedOwner`: session id, optionally owner label or `keptAt`) act only while the record still has it (compare-and-swap); `markKept` always needs the session id. The sweep passes the session id and owner label it judged, so a sweep working from an older read can neither move a newer claim back to the kept set nor mark a claimed record `deleting`; session stops pass their own session id. Reads (`read`, `entries`) take no lock; `claimKept` checks lock-free first whether anything is claimable. The lock is a generation counter: `.lock.<n>` is created with `link()` from a fully written temp file (only one process can create a given `n`) and holds `{pid, processStartTime, bootId, token}`; the holder of the highest `n` holds the lock until it creates `.lock.<n>.free`. A waiter takes `n + 1` when `n` is free or its holder is dead by `ownerLiveness` (same boot, PID gone or with another start time). A live holder, an unreadable record, or a holder without a readable identity is never superseded and no file of it is removed, so stale recovery cannot steal a live lock; after `LedgerLockOptions.timeoutMs` (30 s) the transition fails naming the holder. The new holder removes the generations below its own; a taken generation is dropped again if a higher one exists (a slow waiter that reused a removed number). Polling: 5–25 ms.
- **Settings** (`settings.ts`): `<configDir>/cua.json` (0600): `billingAcceptedAt`, `billingLocation`, `location`, `image` (default `linux`; `--image`, a drift key `cua.image`, recorded in verified `inputs.image`), `rateUsdPerHour`. `cua.cli` requires `MIN_CUA_CLI` (0.7).
- **Start order:** refusals first (`network: "none"`, no acknowledgement, acknowledgement for another cloud, no cloud) → `recordResource("sandbox", ref)`, ledger `creating`, `onExitCleanup(cua sandbox rm <ref> --force)` → cost clock, `sandbox create`, ledger `created` → deploy into `/tmp/pi-gui-testing/<sessionId>` (helper tar from the docker build context; probe commands and Python modules; `apt-get install` missing Debian/Ubuntu packages inside the sandbox; workspace tar of the §4.7 file set via `buildFileSet` + `openSyncedFile`, pax for long paths, fails closed when a file shrinks; staged tars in the 0700 client session dir, deleted after upload) → `HelperSession` over `exec -i` → `setup` in `workspace/`.
- **Cleanup paths:** `gui_stop`/idle/`/gui-cleanup` = `HelperSession.stop` then `SandboxHandle.remove()` (`rm --force`, then the record); failures leave the record `deleting` and the session `failed`. Failed starts go through `pendingSession(handle)` + `stopAfterFailedStart`. `session_shutdown` = `stopAll()`. Process `exit` = `forceRemoveArgv()` (`[env, <ARGV_ENV_NAMES>=…, cua, sandbox, rm, <ref>, --force]`, 5 s, allowlisted non-secret settings only); the record stays. Crash = next Pi start's sweep (deletes dead owners' recorded sandboxes; `keep: true` moves to the kept set). Otherwise the cloud TTL and `cua cloud sweep --delete`. A detached exit-time child was rejected: unbounded and unreported.
- **The sweep never touches** live owners, unreadable owners or records (reported), kept sandboxes, this machine's prefix without a record ("record lost", reported), and foreign names.
- **keepSandbox:** stop clears the guest dir, moves the record to kept, ends the session's cost share (the sandbox keeps billing); exit argv `[]`; audit empty. Reuse = claim a kept record of the same project and cloud whose `image` equals the configured image (`claimKept(…, { image, exclude })`), check existence (only `undefined` or `NOT_FOUND` forgets the record, after `cost.sandboxDeleted(ref)` (X4); any other lookup error puts it back in the kept set and fails the start without creating a sandbox, V2), and refuse it when `getSandbox().image` is reported and differs (back to the kept set, next candidate), then `rm -rf /tmp/pi-gui-testing`, redeploy, re-sync. Kept records of the project with another image or without one are not reused; the start lists them in `Session.warnings` (shown by `gui_launch`), the audit and the sweep report records without an image (`NO_IMAGE_KEPT`), and `/gui-reset cua` deletes them. Expired kept sandboxes are forgotten. `/gui-reset cua` claims and deletes kept sandboxes, then removes `cua.json`. Reuse keeps the system packages the helper installed; `setup` runs again in the fresh guest dir (the deps dir is under it).
- **Cost** (`cost.ts`, V5): billing is tracked per sandbox ref from just before `sandbox create` (a reused kept sandbox: its ledger `createdAt`) until deletion is confirmed — by a session stop, the sweep, `/gui-reset`, or a lookup that finds it gone (`onDeleted`); a session's share runs from its start to its stop or `release` (keep). Reuse never opens a second billing record for the same ref. `UsageTracker.estimate(session)` exposes the hook's `{sessionUsd, dailyUsd}`; `/gui-usage` appends `estimated cost $X` to each billed session and an `estimated cost today` line (the latest `dailyUsd` per billing backend, summed) (X7). Rate = `usd_per_hour` from `cloud status`, else `rateUsdPerHour`, else none (`cua.rate` warns). `dailyUsd` counts the overlap with today since local midnight.

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
| Typecheck + unit + contract tests | `npm run check` | Node only (run on Node 26 and Node 22) |
| Real-process integration against a fake `docker` | `node --experimental-strip-types --test tests/unit/backends/process.test.mjs` (also part of `npm test`) | Node only |
| Loopback SSH (real remote scripts through a sandboxed local `ssh` stand-in) | part of `npm test` (`tests/unit/backends/remote/*.test.mjs`, `tests/unit/transport/ssh/*.test.mjs`) | Node and `sh`; the quoting tests also use `bash`, `dash`, `fish`, and `zsh` when installed |
| local-linux host helper with a stand-in Xvfb and the real `dbus-daemon` | part of `npm test` (`tests/unit/backends/local/host-helper.test.mjs`) | Node, Python, `dbus-daemon` |
| Helper unit tests (host) | `python3 -m unittest discover -s tests/helper -v` | Python; `A11yPureTests` need PyGObject (`No module named 'gi'` errors elsewhere are expected), the live Xvfb probe test skips without Xvfb |
| Helper unit tests (image) | `docker run --rm --network none --entrypoint python3 -v "$PWD/tests/helper:/tests:ro" pi-gui-testing-base:<version> -m unittest discover -s /tests -v` | Docker |
| Image contract | `docker run --rm --network none --entrypoint sh pi-gui-testing-base:<version> -c 'python3 -c "import gi, pyatspi" && pip --version && npm --version && python3 -m venv --system-site-packages /tmp/v && ldconfig -p \| grep -q libnss3'` | Docker |
| Helper entrypoint (production flags) | `python3 tests/helper/host/test_entrypoint.py` | Docker |
| e2e smoke | `npm run test:e2e -- tests/e2e/smoke.test.mjs` | rootful Docker 29+ |
| e2e sample apps | `npm run test:e2e -- tests/e2e/apps.test.mjs` | rootful Docker 29+, network for PySide6/Electron |
| e2e lifecycle | `npm run test:e2e -- tests/e2e/lifecycle.test.mjs` | rootful Docker 29+ |
| e2e local-linux | `npm run test:e2e -- tests/e2e/local-linux.test.mjs` | Linux with Xvfb, xdotool, ImageMagick, D-Bus, PyGObject + GTK 3 (skips with "Xvfb not found on PATH" otherwise); run on one X11 and one Wayland desktop |
| e2e remote | `PI_GUI_E2E_SSH_HOST=<alias> npm run test:e2e -- tests/e2e/remote.test.mjs` | key login to the alias (`localhost` works with a local sshd). `PI_GUI_E2E_SSH_SESSION=1` adds a full remote-linux session (host needs Xvfb, xdotool, dbus, python3 with GTK 3); `PI_GUI_E2E_SSH_DOCKER=1` adds the remote-linux-docker checks |
| e2e cua | `PI_GUI_TESTING_CUA_E2E=1 npm run test:e2e -- tests/e2e/cua.test.mjs` | `cua` CLI, `cua auth login`, a connected cloud. **Bills your cloud account**; set a small budget first |

e2e suites skip with a reason when their prerequisites are missing. `PI_GUI_E2E_OFFLINE=1` skips the PySide6 and Electron downloads; `PI_GUI_E2E_VERBOSE=1` prints the image build log. The first Docker run builds the image, which takes minutes.

Coverage map:

- `smoke`: S1/S3 (zero-prompt setup, smoke app), S6 live negatives, and doctor.
- `apps`: S4, S5, every `act` action via `tests/e2e/fixtures/fields/app.py`, the `HANDOFF` path, a UID other than 1000, and Electron without `--shm-size`.
- `lifecycle`: S7 (a)–(c), two concurrent sessions, idle timeout, cancel after resource creation, owner-label PID reuse, and a real `pi -p` exit.
- `local-linux`: required checks, the GTK 3 smoke app on the private display only (no new toplevel on an X11 host `DISPLAY`; a client without the cookie is refused), and the sweep of a killed helper's display.
- `remote`: ControlMaster lifecycle, session dir and tar sync with removal, remote-linux and remote-linux-docker checks, a full remote-linux session with an empty audit.
- `cua`: live smoke test with no sandbox left; sync without secrets and deletion on stop.

Unit coverage added after M1 (counts at the time of each handoff): registry and multi-backend runtime (F); local-linux 32 + helper host mode 28 (L); SSH quoting/transport, hosts, session dirs, sync, both remote backends, checks 75 (R); cua lifecycle, CLI adapter, orphans, checks, runtime, bundle 52 (C); backend wiring 15, purge, flags, config (I); deps key/store/flow 19, helper `test_deps.py` 27 (incl. 18 malicious-archive cases), Docker Desktop 13, portable identity 6 (D). Post-M1 fix round 1 (V1–V14, W1–W10): regression tests named `V<n>:`/`W<n>:` in the unit suites and `tests/helper/test_deps.py` (`ArchiveMetadataBoundTests`, `SymlinkGraphTests`). Round 2 (X1–X7): tests named `X<n>:` (cua `ledger.test.mjs`, `ledger-lock.test.mjs` with real child processes, `lifecycle.test.mjs`; remote `session-dir.test.mjs`; `multi-backend.test.mjs`) and `SparseMemberTests`. The remote exit-handler test runs the argv through `runExitCleanupSync` with an injected 60 s bound and asserts the production `EXIT_COMMAND_TIMEOUT_MS` (5 s) and `ConnectTimeout=3` separately, so it passes on a loaded machine. Last owner run: 475/475 on Node 26 and Node 22.

The real-Pi exit test (`lifecycle`) needs Pi 1.4.0+ and a passing doctor, otherwise it skips. It uses `tests/e2e/fixtures/gui-live-session-extension.ts`, which reuses the real factory with an injected runtime: `pi -e tests/e2e/fixtures/gui-live-session-extension.ts -p /e2e-gui-launch`. Do not name fixtures `pi-session-*`; the repository `.gitignore` ignores that pattern.

e2e Docker queries go through the harness's checked query helper, which throws on spawn errors or a non-zero exit, so a failed query never reads as "no leftovers". `tests/unit/backends/env.mjs` sets `cua.cuaOnPath → false` and a hermetic `depsCacheRoot`, so a real `cua` or cache on a developer's machine is never touched.

No-UI behaviour checks:

```bash
pi -e ./index.ts -p "/gui-doctor docker-linux" </dev/null; echo "exit $?"            # report on stderr
pi -e ./index.ts --mode json -p "/gui-doctor docker-linux" </dev/null | head -5      # JSONL with a gui-testing custom message
pi -e ./index.ts -p "/gui-doctor remote-linux --host nonexistent-alias" </dev/null   # probe-only, exit 1
pi -e ./index.ts -p "/gui-setup cua" </dev/null                                      # needs-user-action, no prompt
```

## Before publishing

1. Run every suite above on real hosts and record the results in the plans. Open live exit criteria (spec §11):
   - **M1:** smoke test on EndeavourOS with Docker 29.x; GTK 4, PySide6, and Electron sample apps snapshot/act/screenshot correctly; a Tk 8.6 app works by coordinates with `coverage: none`. Run on x86-64 and ARM64 if possible.
   - **M1b:** a second session of the same project starts without running `setup`; the key changes when a lockfile changes. Also confirm the real helper's pack/unpack in the image, venv recreation time after a hit, and GNU `find -cnewer` on the bind mount.
   - **M1c:** smoke test on Docker Desktop on macOS and on Windows. Confirm Desktop's `Mounts[].Source` forms, npipe CLI behaviour, `ps lstart` on macOS, PowerShell timing, and file-sharing ownership.
   - **M2:** the same app matrix on local-linux; the Wayland-leak test on a Wayland host session (and an X11 session).
   - **M2b:** smoke test against an amd64 server and a Raspberry Pi 5 (64-bit OS, no monitor, SSH only); no ports opened on the remote; sync excludes secrets. Confirm real OpenSSH `-M -N -f` with `ControlPersist=60`, rsync over the master, BusyBox/Alpine scripts, and `--purge-tooling` against a real daemon.
   - **M3 (Linux target only):** smoke test on a real cloud; sync excludes secrets; stop leaves no running billable sandbox. Confirm the CLI assumptions listed under [cua](#cua-m3-linux-target). The spec's "Linux, Windows; macOS behind a flag" cannot be met before S1.
   - **S1, M4, M5:** blocked on a Windows machine.
2. Run `npm pack --dry-run --json` and confirm `index.ts`, `src/` (including `src/deps/`, `src/backends/{local,remote,cua}/`, `src/transport/ssh/`, `src/sync/transport/`), `helpers/linux/` (helper incl. `hostmode.py` and `deps.py`, Dockerfile), `testapps/`, and `skills/gui-testing/SKILL.md` are listed and `tests/`, `plans/`, `reports/`, and `.pyc` files are not.
3. Check whether `docker build --force-rm` is accepted by the target Docker version.
4. Bump the package version whenever `helpers/linux/` changes. The base image is matched by package version only, so an unchanged version keeps a stale helper image (the protocol label additionally forces a rebuild on protocol changes). Remote hosts and cua sandboxes receive the helper from the installed package at each session. Contributors with a local development image remove it with `/gui-reset docker-linux`.
5. The package has no first-party dependencies, so no dependency ranges need checking.

## Known gaps

- `disk.free` measures `os.tmpdir()`, not Docker's data root (docker-linux).
- Electron detection does not cover `npm start` launches.
- Live `docker inspect` field shapes on Docker 29 are assumed (`HostConfig.CapDrop`, `SecurityOpt` `no-new-privileges`); an unexpected shape refuses every session (fail closed).
- `HelperSession` is a refactor of security-relevant code covered by the unchanged Docker tests and fake-process tests, without a live Docker run. `spawnLocalProcess` relies on POSIX `detached` process-group semantics and was tested on Linux only.
- local-linux: the generic smoke test does not repeat spec §5.5 step 6 (no host toplevel window); `verifyAfterStart` and `linux.wayland-scrub` cover it at setup. Processes that clear their environment and escape the app's process group carry no tag and can survive a SIGKILLed helper. A SIGKILLed helper's bus and Xvfb live until the client teardown or the next sweep.
- Remote: `smoke.timing`, `isolation.no-listen`, `isolation.private-display`, `cleanup.disconnect`, `cleanup.sweep`, and `concurrency.lock` are not separate checks (the behaviour behind `cleanup.*` exists and is unit-tested). `/proc` scans are slow on busy desktop hosts, so the 5 s exit-handler `ssh` call may time out there; the next session start sweeps. "Last session" for `purgeTooling` is per Pi process. Doctor's probe-only decision compares host strings.
- cua: exit-time deletion is best effort (5 s bound; env-only cloud credentials are not in the exit environment); a `sandbox create` interrupted by Pi's exit can still complete (the `creating` record makes the next sweep delete it); ownership is ledger-only; the package-install step assumes a Debian/Ubuntu image; the environment preamble relies on the guest `sh` reading exactly one line per `read` from a pipe; no rate prompt (only `--rate-usd-per-hour`); `billingStatus` needs a working `cua cloud status`, so a first run with `--accept-billing` may need a second run once earlier checks pass.
- Dependency cache: the key cannot see host packages on remote-linux, network-resolved versions without a lockfile, or setup inputs outside the key files; writes outside the deps dir are lost on a hit; a malicious setup can cache malicious packages for the same key; a writer stalled beyond 30 min can be taken over (readers still verify). Several WSL distros sharing one Desktop engine share a boot id but not PID namespaces, so one could judge another's labels dead (pre-existing).
- Docker Desktop: the listing fingerprint does not detect a swap to a directory with identical top-level names.
- Fixed after the documentation pass (round 1, V3/V9–V13): remote-linux refuses `"network": "none"` before creating anything; remote `linux.screenshot` requires `magick`, or `import` and `convert`; the `cua.rate` fix names `--rate-usd-per-hour`; `cua.cli` requires 0.7; the picker is filtered by host support; the cua image has `--image` and is a drift key.
