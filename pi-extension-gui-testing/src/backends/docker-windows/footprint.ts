/**
 * Orphans of `docker-windows` (spec §7a.2, §7a.4): session containers (each
 * with its disk overlay) and install containers whose `pi-gui-testing.owner`
 * names a dead Pi process. Owners that are alive are exempt; owners that
 * cannot be judged are reported and never removed. The base volume is
 * tooling and never an orphan; only `/gui-reset docker-windows` removes it.
 */
import { DEFAULT_PROC_ROOT, ownerLiveness } from "../../cleanup/identity.ts";
import { parseOwnerLabel, type OwnerLiveness } from "../../owner.ts";
import type { Leftover } from "../../protocol.ts";
import type { CommandRunner, DockerEndpoint } from "../../runner/types.ts";
import { listRoleContainers, removeContainer, type RoleContainer } from "./docker.ts";

export function containerOwnerLiveness(container: Pick<RoleContainer, "owner">, procRoot: string = DEFAULT_PROC_ROOT): OwnerLiveness {
  const owner = parseOwnerLabel(container.owner);
  return owner ? ownerLiveness(owner, procRoot) : "unknown";
}

function leftover(container: RoleContainer, role: "session" | "install", detail: string): Leftover {
  const what = role === "session" ? `Windows session ${container.session || "?"} (container with its disk overlay)` : "Windows install container";
  return { kind: "container", id: container.name, detail: `${what}, ${container.state || "unknown state"}: ${detail}` };
}

async function orphans(runner: CommandRunner, endpoint: DockerEndpoint, signal: AbortSignal | undefined, procRoot: string) {
  const found: { container: RoleContainer; role: "session" | "install"; liveness: OwnerLiveness }[] = [];
  for (const role of ["session", "install"] as const) {
    for (const container of await listRoleContainers(runner, endpoint, role, signal)) found.push({ container, role, liveness: containerOwnerLiveness(container, procRoot) });
  }
  return found;
}

/** Read-only: containers of dead owners, plus those whose owner cannot be judged. */
export async function auditWindowsOrphans(runner: CommandRunner, endpoint: DockerEndpoint, options: { signal?: AbortSignal; procRoot?: string } = {}): Promise<Leftover[]> {
  const out: Leftover[] = [];
  for (const { container, role, liveness } of await orphans(runner, endpoint, options.signal, options.procRoot ?? DEFAULT_PROC_ROOT)) {
    if (liveness === "dead") out.push(leftover(container, role, "owner gone"));
    if (liveness === "unknown") out.push(leftover(container, role, `owner label "${container.owner}" cannot be judged; not removed automatically`));
  }
  return out;
}

/** Removes containers of dead owners; reports unknown owners and failed removals. */
export async function sweepWindowsOrphans(runner: CommandRunner, endpoint: DockerEndpoint, options: { signal?: AbortSignal; procRoot?: string } = {}): Promise<Leftover[]> {
  const out: Leftover[] = [];
  for (const { container, role, liveness } of await orphans(runner, endpoint, options.signal, options.procRoot ?? DEFAULT_PROC_ROOT)) {
    if (liveness === "unknown") {
      out.push(leftover(container, role, `owner label "${container.owner}" cannot be judged; not removed automatically`));
      continue;
    }
    if (liveness !== "dead") continue;
    const failed = await removeContainer(runner, endpoint, container.id, options.signal);
    if (failed) out.push(leftover(container, role, `remove failed (${failed})`));
  }
  return out;
}
