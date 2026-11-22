/**
 * Docker calls of `docker-windows` against the endpoint resolved once per
 * operation: container state, published ports (must be `127.0.0.1` only),
 * logs for install progress, labelled containers and the base volume, and a
 * read-only stamp of the installed disk (to show that sessions never write it).
 */
import { LABEL_OWNER, LABEL_SESSION } from "../../labels.ts";
import type { CommandRunner, DockerEndpoint } from "../../runner/types.ts";
import { describeFailure, runDocker } from "../docker/cli.ts";
import { BASE_VOLUME, LABEL_WINDOWS, LABEL_WINDOWS_INSTALL, type WindowsRole } from "./constants.ts";
import { LOOPBACK } from "./guest-ssh.ts";

export interface ContainerState {
  running: boolean;
  status: string;
  exitCode?: number;
}

/** State of container `name`, or `undefined` when it does not exist. */
export async function containerState(runner: CommandRunner, endpoint: DockerEndpoint, name: string, signal?: AbortSignal): Promise<ContainerState | undefined> {
  const result = await runDocker(runner, endpoint, ["container", "inspect", "--format", "{{json .State}}", name], { timeoutMs: 15_000, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) {
    if (/no such (container|object)/i.test(result.stderr)) return undefined;
    throw new Error(`docker container inspect ${name} failed (${describeFailure(result)})`);
  }
  const state = JSON.parse(result.stdout.trim()) as { Running?: boolean; Status?: string; ExitCode?: number };
  return { running: state.Running === true, status: state.Status ?? "unknown", ...(typeof state.ExitCode === "number" ? { exitCode: state.ExitCode } : {}) };
}

/** A container's immutable id and labels. */
export interface ContainerIdentity {
  id: string;
  labels: Record<string, string>;
}

/** Id and labels of container `name`, or `undefined` when it does not exist. */
export async function containerIdentity(runner: CommandRunner, endpoint: DockerEndpoint, name: string, signal?: AbortSignal): Promise<ContainerIdentity | undefined> {
  const result = await runDocker(runner, endpoint, ["container", "inspect", "--format", "{{json .Id}}\t{{json .Config.Labels}}", name], { timeoutMs: 15_000, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) {
    if (/no such (container|object)/i.test(result.stderr)) return undefined;
    throw new Error(`docker container inspect ${name} failed (${describeFailure(result)})`);
  }
  const [rawId, rawLabels] = result.stdout.trim().split("\t");
  let id: unknown;
  let labels: unknown;
  try {
    id = JSON.parse(rawId ?? "");
    labels = JSON.parse(rawLabels ?? "") ?? {};
  } catch {
    throw new Error(`docker container inspect ${name} gave an unreadable answer`);
  }
  if (typeof id !== "string" || !/^[0-9a-f]{12,64}$/.test(id) || typeof labels !== "object" || Array.isArray(labels)) throw new Error(`docker container inspect ${name} gave an unreadable answer`);
  const strings = Object.fromEntries(Object.entries(labels as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  return { id, labels: strings };
}

/**
 * Host port of `containerPort` (e.g. `22/tcp`). Fails closed unless every
 * binding Docker reports is on `127.0.0.1`.
 *
 * @throws Error when the port is not published, or published on another address.
 */
export async function publishedPort(runner: CommandRunner, endpoint: DockerEndpoint, name: string, containerPort: string, signal?: AbortSignal): Promise<number> {
  const result = await runDocker(runner, endpoint, ["port", name, containerPort], { timeoutMs: 15_000, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) throw new Error(`docker port ${name} ${containerPort} failed (${describeFailure(result)})`);
  const bindings = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (bindings.length === 0) throw new Error(`${containerPort} of ${name} is not published`);
  let port: number | undefined;
  for (const binding of bindings) {
    const match = /^(.*):(\d+)$/.exec(binding);
    if (!match || match[1] !== LOOPBACK) throw new Error(`${containerPort} of ${name} is published on ${binding}, not only on ${LOOPBACK}; the container was stopped`);
    port = Number(match[2]);
  }
  return port!;
}

/** Last non-empty log line (ANSI escapes removed), for progress. */
export async function lastLogLine(runner: CommandRunner, endpoint: DockerEndpoint, name: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await runDocker(runner, endpoint, ["logs", "--tail", "20", name], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) return undefined;
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((l) => l.replace(/\x1b\[[0-9;?=]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim())
    .filter(Boolean);
  return lines.at(-1)?.slice(0, 200);
}

export interface RoleContainer {
  id: string;
  name: string;
  session: string;
  owner: string;
  install: string;
  state: string;
}

/** Containers of one role (every state). */
export async function listRoleContainers(runner: CommandRunner, endpoint: DockerEndpoint, role: Exclude<WindowsRole, "base">, signal?: AbortSignal): Promise<RoleContainer[]> {
  const format = `{{.ID}}\t{{.Names}}\t{{.Label "${LABEL_SESSION}"}}\t{{.Label "${LABEL_OWNER}"}}\t{{.Label "${LABEL_WINDOWS_INSTALL}"}}\t{{.State}}`;
  const result = await runDocker(runner, endpoint, ["ps", "-a", "--no-trunc", "--filter", `label=${LABEL_WINDOWS}=${role}`, "--format", format], { timeoutMs: 15_000, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) throw new Error(`docker ps failed (${describeFailure(result)})`);
  return result.stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line) => {
      const [id, name, session, owner, install, state] = line.split("\t");
      return { id, name: name ?? id, session: session ?? "", owner: owner ?? "", install: install ?? "", state: state ?? "" };
    });
}

/** `docker rm -f`; a vanished container counts as removed. Returns the failure text, if any. */
export async function removeContainer(runner: CommandRunner, endpoint: DockerEndpoint, name: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await runDocker(runner, endpoint, ["rm", "-f", name], { timeoutMs: 30_000, ...(signal ? { signal } : {}) });
  if (result.exitCode === 0 || /no such container/i.test(result.stderr)) return undefined;
  return describeFailure(result);
}

/** Labels of the base volume, or `undefined` when it does not exist. */
export async function volumeLabels(runner: CommandRunner, endpoint: DockerEndpoint, volume: string = BASE_VOLUME, signal?: AbortSignal): Promise<Record<string, string> | undefined> {
  const result = await runDocker(runner, endpoint, ["volume", "inspect", "--format", "{{json .Labels}}", volume], { timeoutMs: 15_000, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) {
    if (/no such volume|not found/i.test(result.stderr)) return undefined;
    throw new Error(`docker volume inspect ${volume} failed (${describeFailure(result)})`);
  }
  const parsed = JSON.parse(result.stdout.trim() || "null") as Record<string, string> | null;
  return parsed ?? {};
}

/** Creates the labelled base volume. */
export async function createBaseVolume(runner: CommandRunner, endpoint: DockerEndpoint, installId: string, signal?: AbortSignal): Promise<void> {
  const result = await runDocker(runner, endpoint, ["volume", "create", "--label", `${LABEL_WINDOWS}=base`, "--label", `${LABEL_WINDOWS_INSTALL}=${installId}`, BASE_VOLUME], {
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  });
  if (result.exitCode !== 0) throw new Error(`docker volume create ${BASE_VOLUME} failed (${describeFailure(result)})`);
}

/** Removes every volume labelled as a `docker-windows` base. Returns the removed names and failures. */
export async function removeBaseVolumes(runner: CommandRunner, endpoint: DockerEndpoint, signal?: AbortSignal): Promise<{ removed: string[]; failed: { name: string; detail: string }[] }> {
  const list = await runDocker(runner, endpoint, ["volume", "ls", "-q", "--filter", `label=${LABEL_WINDOWS}=base`], { timeoutMs: 15_000, ...(signal ? { signal } : {}) });
  if (list.exitCode !== 0) throw new Error(`docker volume ls failed (${describeFailure(list)})`);
  const removed: string[] = [];
  const failed: { name: string; detail: string }[] = [];
  for (const name of [...new Set(list.stdout.split("\n").map((l) => l.trim()).filter(Boolean))]) {
    const result = await runDocker(runner, endpoint, ["volume", "rm", "-f", name], { timeoutMs: 120_000, ...(signal ? { signal } : {}) });
    if (result.exitCode === 0 || /no such volume/i.test(result.stderr)) removed.push(name);
    else failed.push({ name, detail: describeFailure(result) });
  }
  return { removed, failed };
}

/** `true` when the pinned image is present locally. */
export async function imagePresent(runner: CommandRunner, endpoint: DockerEndpoint, image: string, signal?: AbortSignal): Promise<{ present: boolean; id?: string; architecture?: string; detail?: string }> {
  const result = await runDocker(runner, endpoint, ["image", "inspect", "--format", "{{json .}}", image], { timeoutMs: 15_000, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) {
    if (/no such (image|object)/i.test(result.stderr)) return { present: false };
    return { present: false, detail: describeFailure(result) };
  }
  const parsed = JSON.parse(result.stdout.trim()) as { Id?: string; Architecture?: string };
  return { present: true, ...(parsed.Id ? { id: parsed.Id } : {}), ...(parsed.Architecture ? { architecture: parsed.Architecture } : {}) };
}

/**
 * `<name> <size> <mtime>` of the installed disk files in the base volume,
 * read by a throw-away container that mounts the volume read-only and has no
 * network or capabilities. A session must not change it.
 */
export async function baseDiskStamp(runner: CommandRunner, endpoint: DockerEndpoint, image: string, signal?: AbortSignal): Promise<string> {
  const result = await runDocker(
    runner,
    endpoint,
    [
      "run", "--rm", "--pull", "never", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--label", `${LABEL_WINDOWS}=probe`, "-v", `${BASE_VOLUME}:/storage:ro`, "--entrypoint", "/bin/sh", image,
      "-c", 'cd /storage && for f in data.img data.qcow2; do [ -f "$f" ] && stat -c "%n %s %Y" "$f"; done; true',
    ],
    { timeoutMs: 60_000, ...(signal ? { signal } : {}) },
  );
  if (result.exitCode !== 0) throw new Error(`reading the base disk stamp failed (${describeFailure(result)})`);
  const stamp = result.stdout.trim();
  if (!stamp) throw new Error(`the base volume ${BASE_VOLUME} holds no installed disk (data.img or data.qcow2)`);
  return stamp;
}
