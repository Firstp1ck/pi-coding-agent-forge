/**
 * `docker-linux` checks (spec §5.4). Each returns the observed value; required
 * failures carry the listed remediation. Every Docker call after
 * `docker.endpoint` uses the endpoint that check resolved.
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { commonChecks, compareVersions, DOCKER_LINUX_MIN_FREE_BYTES, type CommonCheckOptions } from "../../checks/common.ts";
import type { Check, CheckContext, CheckResult } from "../../checks/types.ts";
import { ELECTRON_SHM_SIZE, REQUIRED_RUN_FLAGS } from "../../hardening.ts";
import { LABEL_OWNER, LABEL_SESSION } from "../../labels.ts";
import type { CommandRunner, DockerEndpoint, RunResult } from "../../runner/types.ts";
import { describeFailure, EndpointError, outputTail, resolveEndpoint, runDocker, type EndpointSource } from "./cli.ts";
import { removeObject } from "./footprint.ts";
import {
  baseImageProblem,
  buildArgs,
  IMAGE_BUILD_DOWNLOAD_BYTES,
  IMAGE_BUILD_ESTIMATED_SECONDS,
  IMAGE_BUILD_TIMEOUT_MS,
  inspectImage,
} from "./image.ts";
import { formatViolations, hardRuleViolations, workspaceMountProblem, type ContainerInspect, type PathProbe } from "./inspect.ts";
import { baseImageTag } from "./package.ts";
import { dockerCreateArgs, writeIdentityFiles } from "./run-args.ts";
import { containerUser, hostFlavor, WINDOWS_CONTAINER_UID, type DockerHostFlavor } from "./desktop.ts";
import type { HostRules } from "./inspect.ts";

/** Lowest tested Docker server major (spec §5.4, plan X15). */
export const MIN_DOCKER_SERVER = "29.0";
/** Highest tested major; newer majors warn. */
export const MAX_TESTED_DOCKER_MAJOR = 29;
/** Prefix of probe temp dirs; deliberately not the session-dir prefix, so the startup sweep never sees them. */
export const PROBE_DIR_PREFIX = "pi-gui-probe-";

export const DOCKER_INSTALL_URL = "https://docs.docker.com/engine/install/";
export const DOCKER_DESKTOP_URL = "https://docs.docker.com/desktop/";

export interface DockerCheckOptions {
  runner: CommandRunner;
  /** Owner label for probe containers. */
  ownerLabel: () => string;
  version: string;
  uid?: number;
  gid?: number;
  /** Where probe dirs are created; default `os.tmpdir()`. */
  tmpRoot?: string;
  endpointSource?: EndpointSource;
  pathProbe?: PathProbe;
  /** Overrides for the common checks (tests). */
  common?: Partial<CommonCheckOptions>;
  /** Client platform; `darwin` and `win32` are Docker Desktop hosts (M1c). Default `process.platform`. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Parsed `docker info` (the fields the checks read). */
export interface DockerInfo {
  ServerVersion?: string;
  OSType?: string;
  Architecture?: string;
  SecurityOptions?: string[];
  ServerErrors?: string[];
  /** e.g. `Docker Desktop`, `Debian GNU/Linux 13 (trixie)`. */
  OperatingSystem?: string;
  /** e.g. `docker-desktop`. */
  Name?: string;
}

/** `true` when `docker info` describes Docker Desktop's engine. */
export function isDockerDesktop(info: DockerInfo): boolean {
  return /docker desktop/i.test(info.OperatingSystem ?? "") || info.Name === "docker-desktop";
}

/** Per-flavor remediation texts (Linux Engine vs Docker Desktop on macOS or Windows). */
function remedies(flavor: DockerHostFlavor) {
  if (flavor === "engine") {
    return {
      install: { summary: `Install Docker Engine (${DOCKER_INSTALL_URL}); setup never installs it for you`, manual: true as const },
      endpoint: "Switch to the local Docker context (docker context use default) and unset a remote DOCKER_HOST",
      daemon: { summary: "Start the Docker daemon", command: ["sudo", "systemctl", "start", "docker"], manual: true as const },
      permission: undefined,
    };
  }
  const windows = flavor === "desktop-windows";
  return {
    install: { summary: `Install Docker Desktop (${DOCKER_DESKTOP_URL}) and start it once; setup never installs it for you`, manual: true as const },
    endpoint: "Use Docker Desktop's context (docker context use desktop-linux) and unset a remote DOCKER_HOST",
    daemon: { summary: "Start Docker Desktop and wait until it reports that the engine is running", manual: true as const },
    permission: windows
      ? { summary: "Add your Windows account to the docker-users group (Computer Management → Local Users and Groups), then sign out and in", manual: true as const }
      : { summary: "Restart Docker Desktop; its socket belongs to your macOS user", manual: true as const },
  };
}

type InfoOutcome =
  | { ok: true; info: DockerInfo }
  | { ok: false; problem: "permission" | "down" | "other"; message: string };

function classifyInfoError(text: string): "permission" | "down" | "other" {
  if (/permission denied/i.test(text)) return "permission";
  if (/cannot connect|is the docker daemon running|no such file or directory|connection refused|timed out/i.test(text)) return "down";
  return "other";
}

/** Runs `docker info` against the endpoint and classifies the outcome. */
export async function dockerInfo(runner: CommandRunner, endpoint: DockerEndpoint, signal: AbortSignal): Promise<InfoOutcome> {
  const result = await runDocker(runner, endpoint, ["info", "--format", "{{json .}}"], { timeoutMs: 10_000, signal });
  let info: DockerInfo | undefined;
  try {
    info = JSON.parse(result.stdout.trim()) as DockerInfo;
  } catch {
    info = undefined;
  }
  const serverErrors = info?.ServerErrors ?? [];
  if (result.exitCode === 0 && info && serverErrors.length === 0 && info.ServerVersion) return { ok: true, info };
  const message = result.timedOut ? `docker info timed out after ${result.durationMs} ms` : serverErrors.join("; ") || outputTail(result) || describeFailure(result);
  return { ok: false, problem: result.timedOut ? "down" : classifyInfoError(message), message };
}

function requireEndpoint(ctx: CheckContext): DockerEndpoint {
  if (!ctx.dockerEndpoint) throw new Error("docker.endpoint did not provide an endpoint");
  return ctx.dockerEndpoint;
}

/** Normalises Docker's architecture names to `amd64` / `arm64`; `undefined` for anything else. */
export function normaliseArch(arch: string | undefined): "amd64" | "arm64" | undefined {
  if (arch === "x86_64" || arch === "amd64") return "amd64";
  if (arch === "aarch64" || arch === "arm64") return "arm64";
  return undefined;
}

/** Client version from `docker --version` output (`Docker version 29.9.1, build …`), or `undefined`. */
export function parseDockerCliVersion(output: string): string | undefined {
  return /version\s+v?([0-9][^\s,]*)/i.exec(output.trim().split("\n")[0])?.[1];
}

/** All `docker-linux` checks: the common ones first, then the Docker ones in dependency order. */
export function dockerLinuxChecks(options: DockerCheckOptions): Check[] {
  const { runner } = options;
  const platform = options.platform ?? process.platform;
  const flavor = hostFlavor(platform);
  const fix = remedies(flavor);
  const rules: HostRules | undefined = flavor === "engine" ? undefined : { platform, ...(options.env ? { env: options.env } : {}), ...(options.home ? { home: options.home } : {}) };
  const { uid, gid } = containerUser(platform, { ...(options.uid !== undefined ? { uid: options.uid } : {}), ...(options.gid !== undefined ? { gid: options.gid } : {}) });
  const tag = baseImageTag(options.version);
  // `docker info` once per check run: the dependents of `docker.permission` share its result object.
  const infoCache = new WeakMap<CheckResult, Promise<InfoOutcome>>();
  const sharedInfo = async (ctx: CheckContext): Promise<DockerInfo> => {
    const key = ctx.dependencies.get("docker.permission");
    let pending = key ? infoCache.get(key) : undefined;
    if (!pending) {
      pending = dockerInfo(runner, requireEndpoint(ctx), ctx.signal);
      if (key) infoCache.set(key, pending);
    }
    const outcome = await pending;
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.info;
  };

  const common = commonChecks("docker-linux", { minFreeBytes: DOCKER_LINUX_MIN_FREE_BYTES, platform, ...options.common });

  const cli: Check = {
    id: "docker.cli",
    description: "docker CLI on PATH",
    kind: "observe",
    required: true,
    remediation: fix.install,
    async run(ctx) {
      let result: RunResult;
      try {
        result = await runner.run(["docker", "--version"], { timeoutMs: 10_000, signal: ctx.signal });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "fail", observed: "docker not found on PATH" };
        throw error;
      }
      if (result.exitCode !== 0) return { status: "fail", observed: `docker --version failed (${describeFailure(result)})` };
      const observed = result.stdout.trim().split("\n")[0];
      const version = parseDockerCliVersion(observed);
      return { status: "pass", observed, ...(version ? { facts: { "docker.cli": version } } : {}) };
    },
  };

  const endpoint: Check = {
    id: "docker.endpoint",
    description: "Docker endpoint is a local unix:// socket",
    kind: "observe",
    required: true,
    dependsOn: ["docker.cli"],
    remediation: { summary: fix.endpoint, manual: true },
    async run(ctx) {
      try {
        const resolved = await resolveEndpoint(runner, { signal: ctx.signal, source: options.endpointSource, platform });
        return { status: "pass", observed: `${resolved.host} (context ${resolved.context})`, facts: { context: resolved.context, host: resolved.host } };
      } catch (error) {
        if (error instanceof EndpointError) return { status: "fail", observed: error.message };
        throw error;
      }
    },
  };

  const daemon: Check = {
    id: "docker.daemon",
    description: "Docker daemon answers docker info",
    kind: "observe",
    required: true,
    dependsOn: ["docker.endpoint"],
    remediation: fix.daemon,
    async run(ctx) {
      const outcome = await dockerInfo(runner, requireEndpoint(ctx), ctx.signal);
      if (outcome.ok) return { status: "pass", observed: `server ${outcome.info.ServerVersion} at ${ctx.dockerEndpoint!.host}` };
      if (outcome.problem === "permission") {
        return { status: "pass", observed: `daemon socket at ${ctx.dockerEndpoint!.host} refuses this user (see docker.permission)` };
      }
      return { status: "fail", observed: outcome.message };
    },
  };

  const permission: Check = {
    id: "docker.permission",
    description: "docker info works without sudo",
    kind: "observe",
    required: true,
    dependsOn: ["docker.daemon"],
    remediation: fix.permission ?? {
      summary: "Add your user to the docker group, then log out and back in",
      command: ["sudo", "usermod", "-aG", "docker", safeUserName()],
      manual: true,
    },
    async run(ctx) {
      const outcome = await dockerInfo(runner, requireEndpoint(ctx), ctx.signal);
      if (outcome.ok) return { status: "pass", observed: `docker info works as ${safeUserName()}` };
      return { status: "fail", observed: outcome.message };
    },
  };

  const rootless: Check = {
    id: "docker.rootless",
    description: "Docker daemon is rootful",
    kind: "observe",
    required: true,
    dependsOn: ["docker.permission"],
    async run(ctx) {
      const info = await sharedInfo(ctx);
      const security = info.SecurityOptions ?? [];
      const summary = security.map((s) => /name=([^,]+)/.exec(s)?.[1] ?? s).join(", ") || "none";
      if (security.some((s) => /name=rootless/.test(s))) {
        return {
          status: "fail",
          observed: `rootless Docker daemon (security options: ${summary}); this version needs a rootful daemon because rootless Docker maps container UIDs to other host UIDs; rootless support is planned`,
        };
      }
      if (flavor !== "engine") {
        // Docker Desktop's engine is rootful inside its own Linux VM; file sharing, not UID mapping, decides who owns bind-mounted files (docker.bind-uid).
        const engine = isDockerDesktop(info) ? "Docker Desktop" : info.OperatingSystem ? `"${info.OperatingSystem}"` : "a Docker VM";
        return { status: "pass", observed: `rootful inside ${engine}'s Linux VM (security options: ${summary}); files on bind mounts are mapped by its file sharing, see docker.bind-uid` };
      }
      return { status: "pass", observed: `rootful (security options: ${summary})` };
    },
  };

  const version: Check = {
    id: "docker.version",
    description: `Docker server ${MIN_DOCKER_SERVER} or newer`,
    kind: "observe",
    required: true,
    dependsOn: ["docker.permission"],
    async run(ctx) {
      const server = (await sharedInfo(ctx)).ServerVersion ?? "";
      const cmp = compareVersions(server, MIN_DOCKER_SERVER);
      if (cmp === undefined) return { status: "fail", observed: `unrecognised server version "${server}"` };
      const facts = { "docker.server": server };
      if (cmp < 0) return { status: "fail", observed: `server ${server} is older than ${MIN_DOCKER_SERVER}`, facts };
      const major = Number(server.split(".")[0]);
      if (major > MAX_TESTED_DOCKER_MAJOR) return { status: "warn", observed: `server ${server} (newer than the tested ${MAX_TESTED_DOCKER_MAJOR}.x)`, facts };
      return { status: "pass", observed: `server ${server}`, facts };
    },
  };

  const ostype: Check = {
    id: "docker.ostype",
    description: "Docker runs Linux containers",
    kind: "observe",
    required: true,
    dependsOn: ["docker.permission"],
    remediation: { summary: flavor === "desktop-windows" ? "In Docker Desktop, choose \"Switch to Linux containers\"" : "Switch Docker to Linux containers", manual: true },
    async run(ctx) {
      const os = (await sharedInfo(ctx)).OSType ?? "unknown";
      return { status: os === "linux" ? "pass" : "fail", observed: `OSType ${os}` };
    },
  };

  const arch: Check = {
    id: "docker.arch",
    description: "Docker architecture is amd64 or arm64",
    kind: "observe",
    required: true,
    dependsOn: ["docker.permission"],
    async run(ctx) {
      const raw = (await sharedInfo(ctx)).Architecture;
      const normalised = normaliseArch(raw);
      if (!normalised) return { status: "fail", observed: `architecture ${raw ?? "unknown"} is not supported (amd64 or arm64 needed)` };
      return { status: "pass", observed: `${raw} (${normalised})`, facts: { "docker.arch": normalised } };
    },
  };

  const image: Check = {
    id: "image.base",
    description: "base image present with matching version and protocol labels",
    kind: "observe",
    required: true,
    dependsOn: ["docker.permission"],
    remediation: {
      summary: "Build the base image from this package's Dockerfile (tooling only; no project files enter the build)",
      command: ["docker", ...buildArgs(options.version, tag)],
      downloadBytes: IMAGE_BUILD_DOWNLOAD_BYTES,
      estimatedSeconds: IMAGE_BUILD_ESTIMATED_SECONDS,
      timeoutMs: IMAGE_BUILD_TIMEOUT_MS,
    },
    async run(ctx) {
      const info = await inspectImage(runner, requireEndpoint(ctx), tag, ctx.signal);
      if (!info) return { status: "fail", observed: `${tag} not found` };
      const problem = baseImageProblem(info, options.version);
      if (problem) return { status: "fail", observed: `${tag}: ${problem}` };
      return {
        status: "pass",
        observed: `${tag} (${info.id.replace(/^sha256:/, "").slice(0, 12)}, ${info.architecture})`,
        facts: { "image.base": options.version, "image.id": info.id },
      };
    },
  };

  const bindUid: Check = {
    id: "docker.bind-uid",
    description: "files a container writes to a bind mount belong to you",
    kind: "probe",
    required: true,
    dependsOn: ["image.base", "docker.rootless"],
    timeoutMs: 45_000,
    async run(ctx) {
      const endpointValue = requireEndpoint(ctx);
      const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), PROBE_DIR_PREFIX));
      const probeId = `probe-${randomBytes(4).toString("hex")}`;
      try {
        const result = await runDocker(
          runner,
          endpointValue,
          [
            "run", "--rm", "--pull", "never", "--network", "none", "--name", `pi-gui-testing-${probeId}`,
            "--label", `${LABEL_SESSION}=${probeId}`, "--label", `${LABEL_OWNER}=${options.ownerLabel()}`,
            "--user", `${uid}:${gid}`, ...REQUIRED_RUN_FLAGS,
            "-v", `${dir}:/probe`, "--entrypoint", "/bin/sh", tag, "-c", "touch /probe/owned",
          ],
          { timeoutMs: 30_000, signal: ctx.signal },
        );
        if (result.exitCode !== 0) return { status: "fail", observed: `probe container failed (${describeFailure(result)})` };
        const created = await stat(join(dir, "owned")).catch(() => undefined);
        if (!created) {
          return {
            status: "fail",
            observed:
              flavor === "engine"
                ? "the probe container's file did not appear in the bind-mounted directory"
                : `the probe container's file did not appear in ${dir}; allow Docker Desktop's file sharing for that directory (Settings → Resources → File sharing)`,
          };
        }
        if (flavor === "desktop-windows") {
          // Windows has no POSIX owner to compare: the file must show up and be yours to remove (rm below).
          await rm(join(dir, "owned"));
          return { status: "pass", observed: `created through Docker Desktop file sharing and removable by you (Windows has no POSIX owner; the container runs as uid ${WINDOWS_CONTAINER_UID})` };
        }
        if (created.uid !== uid) return { status: "fail", observed: `file is owned by uid ${created.uid}, expected ${uid}` };
        return { status: "pass", observed: flavor === "desktop-macos" ? `owned by uid ${uid} (Docker Desktop file sharing maps it to you)` : `owned by uid ${uid}` };
      } finally {
        await removeObject(runner, endpointValue, { kind: "container", id: `pi-gui-testing-${probeId}`, name: probeId, session: probeId }).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    },
  };

  const isolation: Check = {
    id: "isolation.inspect",
    description: "a session container breaks none of the hard rules",
    kind: "probe",
    required: true,
    dependsOn: ["image.base", "docker.rootless"],
    timeoutMs: 30_000,
    async run(ctx) {
      const endpointValue = requireEndpoint(ctx);
      const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), PROBE_DIR_PREFIX));
      const probeId = `probe-${randomBytes(4).toString("hex")}`;
      try {
        await writeIdentityFiles(dir, uid, gid);
        await mkdir(join(dir, "workspace"), { mode: 0o700 });
        // Sessions mount a resolved path; so does the probe, and Docker must report exactly it.
        const workspaceDir = await realpath(join(dir, "workspace"));
        const create = await runDocker(
          runner,
          endpointValue,
          dockerCreateArgs({
            sessionId: probeId,
            ownerLabel: options.ownerLabel(),
            image: tag,
            uid,
            gid,
            sessionDir: dir,
            workspace: { source: workspaceDir, readOnly: true },
            network: "default",
            shmSize: ELECTRON_SHM_SIZE,
          }),
          { timeoutMs: 15_000, signal: ctx.signal },
        );
        if (create.exitCode !== 0) return { status: "fail", observed: `docker create failed (${describeFailure(create)})` };
        const inspected = await runDocker(runner, endpointValue, ["container", "inspect", `pi-gui-testing-${probeId}`], { timeoutMs: 10_000, signal: ctx.signal });
        if (inspected.exitCode !== 0) return { status: "fail", observed: `docker inspect failed (${describeFailure(inspected)})` };
        const [container] = JSON.parse(inspected.stdout) as ContainerInspect[];
        const violations = hardRuleViolations(container, options.pathProbe, rules);
        if (violations.length > 0) return { status: "fail", observed: formatViolations(violations) };
        const workspace = workspaceMountProblem(container, workspaceDir, "/workspace", platform);
        if (workspace) return { status: "fail", observed: `workspace: ${workspace}` };
        return { status: "pass", observed: "no hard-rule violations (container created, never started)" };
      } finally {
        await removeObject(runner, endpointValue, { kind: "container", id: `pi-gui-testing-${probeId}`, name: probeId, session: probeId }).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    },
  };

  return [...common, cli, endpoint, daemon, permission, rootless, version, ostype, arch, image, bindUid, isolation];
}

function safeUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "$USER";
  }
}
