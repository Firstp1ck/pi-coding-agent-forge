/**
 * `remote-linux-docker` runtime checks (spec §5.4 "Runtime:
 * remote-linux-docker"): the docker-linux Docker checks evaluated on the
 * remote host through the SSH runner, with remediations that name the host,
 * plus remote probes for the bind-mount owner and the hard rules, the image
 * architecture, Docker's free space, and egress.
 */
import { randomBytes } from "node:crypto";
import type { Check, CheckContext, CheckOutcome } from "../../checks/types.ts";
import { ELECTRON_SHM_SIZE, REQUIRED_RUN_FLAGS } from "../../hardening.ts";
import { LABEL_OWNER, LABEL_SESSION } from "../../labels.ts";
import type { CommandRunner, DockerEndpoint } from "../../runner/types.ts";
import { shellJoin } from "../../transport/ssh/quote.ts";
import { describeFailure, runDocker } from "../docker/cli.ts";
import { dockerInfo, dockerLinuxChecks, normaliseArch, DOCKER_INSTALL_URL } from "../docker/checks.ts";
import { removeObject } from "../docker/footprint.ts";
import { buildArgs, inspectImage } from "../docker/image.ts";
import { formatViolations, hardRuleViolations, workspaceMountProblem, type ContainerInspect } from "../docker/inspect.ts";
import { baseImageTag } from "../docker/package.ts";
import { dockerCreateArgs, identityFiles } from "../docker/run-args.ts";
import type { RemoteProbes } from "./checks.ts";
import { deployFiles } from "./deploy.ts";
import { fetchRemotePathProbe } from "./docker.ts";
import { createRemoteSessionDir, remoteFailure, removeRemoteSessions } from "./session-dir.ts";

/** Free space at Docker's data root (spec §5.4). */
export const REMOTE_DOCKER_MIN_FREE_BYTES = 5 * 1024 ** 3;

/** The docker-linux checks reused unchanged (through the remote runner). */
const REUSED = new Set(["docker.cli", "docker.endpoint", "docker.daemon", "docker.permission", "docker.version", "docker.ostype", "docker.arch", "image.base"]);

/** `passwd`/`group` archive entries for the remote session dir (bind-mounted read-only). */
export function identityEntries(uid: number, gid: number) {
  const files = identityFiles(uid, gid);
  return [
    { path: "passwd", type: "file" as const, mode: 0o644, data: Buffer.from(files.passwd) },
    { path: "group", type: "file" as const, mode: 0o644, data: Buffer.from(files.group) },
  ];
}

function requireEndpoint(ctx: CheckContext): DockerEndpoint {
  if (!ctx.dockerEndpoint) throw new Error("docker.endpoint did not provide an endpoint");
  return ctx.dockerEndpoint;
}

/** The runtime checks of `remote-linux-docker`. */
export function remoteDockerRuntimeChecks(probes: RemoteProbes): Check[] {
  const o = probes.options;
  // Bound lazily: the host may be missing (then every call fails with the "no host" message).
  const remote: CommandRunner = { run: (argv, options) => probes.oneShot().runner.run(argv, options) };
  const tag = baseImageTag(o.version);
  const host = () => o.host ?? "<host>";
  const ssh = probes.ssh;

  const reused = dockerLinuxChecks({ runner: remote, ownerLabel: o.ownerLabel, version: o.version, endpointSource: {} }).filter((c) => REUSED.has(c.id));
  const adjusted = reused.map((check): Check => {
    const copy: Check = { ...check };
    switch (check.id) {
      case "docker.cli":
        copy.dependsOn = ["ssh.auth", "remote.os"];
        copy.description = "docker CLI on the remote host";
        copy.remediation = { summary: `Install Docker Engine on ${host()} (${DOCKER_INSTALL_URL}); setup never installs it for you`, manual: true };
        break;
      case "docker.endpoint":
        copy.remediation = { summary: `On ${host()}: switch to the local Docker context (docker context use default)`, manual: true };
        break;
      case "docker.daemon":
        copy.remediation = { summary: `Start Docker on ${host()}: ssh -t ${host()} sudo systemctl start docker`, manual: true };
        break;
      case "docker.permission":
        copy.remediation = { summary: `Add the SSH user to the docker group on ${host()}: ssh -t ${host()} 'sudo usermod -aG docker "$USER"', then reconnect`, manual: true };
        break;
      case "image.base":
        copy.remediation = { ...check.remediation!, summary: `Build the base image on ${host()} from this package's Dockerfile (tooling only; the build context is streamed over SSH and holds no project files)`, command: [ssh, "-T", "--", host(), shellJoin(["docker", ...buildArgs(o.version, tag)])] };
        break;
    }
    return copy;
  });

  const rootless: Check = {
    id: "docker.rootless",
    description: "Docker daemon mode (rootful or rootless) recorded",
    kind: "observe",
    required: false,
    degrades: "rootless Docker maps container UIDs; docker.bind-uid decides whether sessions can write their files",
    dependsOn: ["docker.permission"],
    async run(ctx) {
      const outcome = await dockerInfo(remote, requireEndpoint(ctx), ctx.signal);
      if (!outcome.ok) return { status: "fail", observed: outcome.message };
      const rootlessMode = (outcome.info.SecurityOptions ?? []).some((s) => /name=rootless/.test(s));
      return { status: "pass", observed: rootlessMode ? "rootless daemon" : "rootful daemon", facts: { "docker.mode": rootlessMode ? "rootless" : "rootful" } };
    },
  };

  const imageArch: Check = {
    id: "docker.image-arch",
    description: "base image architecture equals the remote architecture",
    kind: "observe",
    required: true,
    dependsOn: ["image.base", "remote.arch", "ssh.auth"],
    remediation: { summary: "Rebuild the base image on the remote host (/gui-setup with --fix)", manual: true },
    async run(ctx) {
      const facts = await probes.facts(ctx, "ssh.auth");
      const image = await inspectImage(remote, requireEndpoint(ctx), tag, ctx.signal);
      const want = normaliseArch(facts.values.get("arch"));
      const have = normaliseArch(image?.architecture);
      if (!image) return { status: "fail", observed: `${tag} not found` };
      if (!want || have !== want) return { status: "fail", observed: `image is ${image.architecture || "unknown"}, remote is ${facts.values.get("arch") ?? "unknown"}` };
      return { status: "pass", observed: `${image.architecture} on ${facts.values.get("arch")}` };
    },
  };

  /** Runs `body` with a probe session dir on the remote host and removes it afterwards. */
  const withProbeDir = async <T>(ctx: CheckContext, body: (dir: Awaited<ReturnType<typeof createRemoteSessionDir>>, probeId: string) => Promise<T>): Promise<T> => {
    const transport = probes.oneShot();
    const name = `s-probe-${randomBytes(4).toString("hex")}`;
    const probeId = `probe-${randomBytes(4).toString("hex")}`;
    try {
      const dir = await createRemoteSessionDir(transport.runner, { name, ownerLabel: o.ownerLabel(), sessionId: probeId, backend: o.backend, signal: ctx.signal });
      return await body(dir, probeId);
    } finally {
      if (ctx.dockerEndpoint) await removeObject(remote, ctx.dockerEndpoint, { kind: "container", id: `pi-gui-testing-${probeId}`, name: probeId, session: probeId }).catch(() => undefined);
      await removeRemoteSessions(transport.runner, [name], { destination: transport.destination, mode: "fast" }).catch(() => undefined);
    }
  };

  const bindUid: Check = {
    id: "docker.bind-uid",
    description: "files a container writes to the synced dir belong to the SSH user",
    kind: "probe",
    required: true,
    dependsOn: ["image.base", "remote.session-root"],
    timeoutMs: 60_000,
    remediation: { summary: "Use a rootful Docker daemon on the remote host, or one whose user namespace maps container UIDs to the SSH user", manual: true },
    async run(ctx): Promise<CheckOutcome> {
      const endpoint = requireEndpoint(ctx);
      return withProbeDir(ctx, async (dir, probeId) => {
        const result = await runDocker(remote, endpoint, [
          "run", "--rm", "--pull", "never", "--network", "none", "--name", `pi-gui-testing-${probeId}`,
          "--label", `${LABEL_SESSION}=${probeId}`, "--label", `${LABEL_OWNER}=${o.ownerLabel()}`,
          "--user", `${dir.uid}:${dir.gid}`, ...REQUIRED_RUN_FLAGS,
          "-v", `${dir.workspace}:/probe`, "--entrypoint", "/bin/sh", tag, "-c", "touch /probe/owned",
        ], { timeoutMs: 40_000, signal: ctx.signal });
        if (result.exitCode !== 0) return { status: "fail", observed: `probe container failed (${describeFailure(result)})` };
        const owner = await remote.run(["stat", "-c", "%u", `${dir.workspace}/owned`], { timeoutMs: 10_000, signal: ctx.signal });
        if (owner.exitCode !== 0) return { status: "fail", observed: `the probe file is missing (${remoteFailure(owner)})` };
        const uid = Number(owner.stdout.trim());
        if (uid !== dir.uid) return { status: "fail", observed: `file is owned by uid ${uid}, expected ${dir.uid}` };
        return { status: "pass", observed: `owned by uid ${dir.uid}` };
      });
    },
  };

  const isolation: Check = {
    id: "isolation.inspect",
    description: "a session container on the remote host breaks none of the hard rules",
    kind: "probe",
    required: true,
    dependsOn: ["image.base", "remote.session-root"],
    timeoutMs: 60_000,
    async run(ctx): Promise<CheckOutcome> {
      const endpoint = requireEndpoint(ctx);
      return withProbeDir(ctx, async (dir, probeId) => {
        await deployFiles(probes.oneShot(), dir.dir, identityEntries(dir.uid, dir.gid), { signal: ctx.signal, umask: "022" });
        const create = await runDocker(
          remote,
          endpoint,
          dockerCreateArgs({ sessionId: probeId, ownerLabel: o.ownerLabel(), image: tag, uid: dir.uid, gid: dir.gid, sessionDir: dir.dir, workspace: { source: dir.workspace, readOnly: true }, network: "default", shmSize: ELECTRON_SHM_SIZE }),
          { timeoutMs: 20_000, signal: ctx.signal },
        );
        if (create.exitCode !== 0) return { status: "fail", observed: `docker create failed (${describeFailure(create)})` };
        const inspected = await runDocker(remote, endpoint, ["container", "inspect", `pi-gui-testing-${probeId}`], { timeoutMs: 15_000, signal: ctx.signal });
        if (inspected.exitCode !== 0) return { status: "fail", observed: `docker inspect failed (${describeFailure(inspected)})` };
        const [container] = JSON.parse(inspected.stdout) as ContainerInspect[];
        const probe = await fetchRemotePathProbe(remote, [`${dir.dir}/passwd`, `${dir.dir}/group`, dir.workspace], ctx.signal);
        const violations = hardRuleViolations(container, probe);
        if (violations.length > 0) return { status: "fail", observed: formatViolations(violations) };
        const workspace = workspaceMountProblem(container, dir.workspace);
        if (workspace) return { status: "fail", observed: `workspace: ${workspace}` };
        return { status: "pass", observed: "no hard-rule violations (container created on the remote host, never started)" };
      });
    },
  };

  const disk: Check = {
    id: "remote.disk",
    description: "at least 5 GB free at Docker's data root",
    kind: "observe",
    required: true,
    dependsOn: ["docker.permission"],
    async run(ctx) {
      const root = await runDocker(remote, requireEndpoint(ctx), ["info", "--format", "{{.DockerRootDir}}"], { timeoutMs: 10_000, signal: ctx.signal });
      const dir = root.stdout.trim();
      if (root.exitCode !== 0 || !dir.startsWith("/")) return { status: "fail", observed: `Docker data root not reported (${describeFailure(root)})` };
      const df = await remote.run(["df", "-Pk", "--", dir], { timeoutMs: 10_000, signal: ctx.signal });
      const kb = Number(df.stdout.trim().split("\n")[1]?.split(/\s+/)[3]);
      if (df.exitCode !== 0 || !Number.isFinite(kb)) return { status: "fail", observed: `free space at ${dir} not readable (${remoteFailure(df)})` };
      const bytes = kb * 1024;
      return { status: bytes >= REMOTE_DOCKER_MIN_FREE_BYTES ? "pass" : "fail", observed: `${(bytes / 1024 ** 3).toFixed(1)} GB free at ${dir}` };
    },
  };

  const egress: Check = {
    id: "docker.egress",
    description: "the remote host resolves the base image's package mirror",
    kind: "observe",
    required: false,
    degrades: "the base image cannot be built on the remote host without network access",
    dependsOn: ["ssh.auth", "remote.os"],
    async run(ctx) {
      const result = await remote.run(["getent", "hosts", "deb.debian.org"], { timeoutMs: 10_000, signal: ctx.signal });
      return result.exitCode === 0 ? { status: "pass", observed: "deb.debian.org resolves" } : { status: "fail", observed: `deb.debian.org does not resolve (${remoteFailure(result)})` };
    },
  };

  return [...adjusted, rootless, imageArch, bindUid, isolation, disk, egress];
}
