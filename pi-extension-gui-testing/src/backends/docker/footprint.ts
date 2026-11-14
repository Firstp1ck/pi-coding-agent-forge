/**
 * Docker-scope footprint (spec §7a.2, §7a.4): containers, volumes, and
 * networks labelled `pi-gui-testing.session`. Session audits look at one
 * session id; orphan audits and sweeps judge each object's owner label and
 * only ever remove objects whose owner is dead.
 */
import { ownerLiveness, DEFAULT_PROC_ROOT } from "../../cleanup/identity.ts";
import { LABEL_OWNER, LABEL_SESSION } from "../../labels.ts";
import { parseOwnerLabel, type OwnerLiveness } from "../../owner.ts";
import type { Leftover } from "../../protocol.ts";
import type { CommandRunner, DockerEndpoint } from "../../runner/types.ts";
import { describeFailure, runDocker } from "./cli.ts";

export type DockerObjectKind = "container" | "volume" | "network";

export interface LabelledObject {
  kind: DockerObjectKind;
  /** Container id, volume name, or network id. */
  id: string;
  name: string;
  session: string;
  owner: string;
}

const LIST_FORMATS: Record<DockerObjectKind, { args: string[]; format: string }> = {
  container: { args: ["ps", "-a", "--no-trunc"], format: `{{.ID}}\t{{.Names}}\t{{.Label "${LABEL_SESSION}"}}\t{{.Label "${LABEL_OWNER}"}}` },
  volume: { args: ["volume", "ls"], format: `{{.Name}}\t{{.Name}}\t{{.Label "${LABEL_SESSION}"}}\t{{.Label "${LABEL_OWNER}"}}` },
  network: { args: ["network", "ls", "--no-trunc"], format: `{{.ID}}\t{{.Name}}\t{{.Label "${LABEL_SESSION}"}}\t{{.Label "${LABEL_OWNER}"}}` },
};

/**
 * Lists labelled objects of every kind.
 *
 * @param session Only objects of this session; default every labelled object.
 * @throws Error when a `docker` call fails.
 */
export async function listLabelledObjects(
  runner: CommandRunner,
  endpoint: DockerEndpoint,
  options: { session?: string; signal?: AbortSignal } = {},
): Promise<LabelledObject[]> {
  const filter = options.session === undefined ? LABEL_SESSION : `${LABEL_SESSION}=${options.session}`;
  const objects: LabelledObject[] = [];
  for (const kind of ["container", "volume", "network"] as const) {
    const { args, format } = LIST_FORMATS[kind];
    const result = await runDocker(runner, endpoint, [...args, "--filter", `label=${filter}`, "--format", format], {
      timeoutMs: 15_000,
      signal: options.signal,
    });
    if (result.exitCode !== 0) throw new Error(`docker ${args.join(" ")} failed (${describeFailure(result)})`);
    for (const line of result.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const [id, name, session, owner] = line.split("\t");
      objects.push({ kind, id, name: name ?? id, session: session ?? "", owner: owner ?? "" });
    }
  }
  return objects;
}

/** Liveness of an object's owner; an unparseable label is `unknown` and never swept. */
export function objectOwnerLiveness(object: LabelledObject, procRoot: string = DEFAULT_PROC_ROOT): OwnerLiveness {
  const owner = parseOwnerLabel(object.owner);
  return owner ? ownerLiveness(owner, procRoot) : "unknown";
}

export function toLeftover(object: LabelledObject, detail?: string): Leftover {
  const leftover: Leftover = { kind: object.kind, id: object.name || object.id };
  const parts = [`session ${object.session || "?"}`, detail].filter(Boolean);
  leftover.detail = parts.join(", ");
  return leftover;
}

/** Removes one object; returns a leftover when Docker refused. A vanished object counts as removed. */
export async function removeObject(
  runner: CommandRunner,
  endpoint: DockerEndpoint,
  object: Pick<LabelledObject, "kind" | "id" | "name" | "session">,
  signal?: AbortSignal,
): Promise<Leftover | undefined> {
  const args =
    object.kind === "container" ? ["rm", "-f", object.id] : object.kind === "volume" ? ["volume", "rm", "-f", object.id] : ["network", "rm", object.id];
  const result = await runDocker(runner, endpoint, args, { timeoutMs: 20_000, signal });
  if (result.exitCode === 0 || /no such|not found/i.test(result.stderr)) return undefined;
  return { kind: object.kind, id: object.name || object.id, detail: `remove failed (${describeFailure(result)})` };
}

/** Orphan audit: objects whose owner is dead, plus objects whose owner cannot be judged. Live owners are exempt. */
export async function auditDockerOrphans(
  runner: CommandRunner,
  endpoint: DockerEndpoint,
  options: { signal?: AbortSignal; procRoot?: string } = {},
): Promise<Leftover[]> {
  const leftovers: Leftover[] = [];
  for (const object of await listLabelledObjects(runner, endpoint, { signal: options.signal })) {
    const liveness = objectOwnerLiveness(object, options.procRoot);
    if (liveness === "dead") leftovers.push(toLeftover(object, "owner gone"));
    if (liveness === "unknown") leftovers.push(toLeftover(object, `owner label "${object.owner}" cannot be judged; not removed automatically`));
  }
  return leftovers;
}

/** Removes objects of dead owners; reports objects with unknown owners and failed removals. */
export async function sweepDockerOrphans(
  runner: CommandRunner,
  endpoint: DockerEndpoint,
  options: { signal?: AbortSignal; procRoot?: string } = {},
): Promise<Leftover[]> {
  const leftovers: Leftover[] = [];
  // Containers first: a network or volume in use by a container cannot be removed.
  const objects = await listLabelledObjects(runner, endpoint, { signal: options.signal });
  for (const object of objects) {
    const liveness = objectOwnerLiveness(object, options.procRoot);
    if (liveness === "unknown") {
      leftovers.push(toLeftover(object, `owner label "${object.owner}" cannot be judged; not removed automatically`));
      continue;
    }
    if (liveness !== "dead") continue;
    const failed = await removeObject(runner, endpoint, object, options.signal);
    if (failed) leftovers.push(failed);
  }
  return leftovers;
}
