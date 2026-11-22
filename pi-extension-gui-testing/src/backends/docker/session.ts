/**
 * One `docker-linux` session (spec §4.1, §6, §7a): a `docker run -i --rm`
 * container whose entrypoint is the helper. Container lifetime follows the
 * helper: closing stdin or a missed heartbeat ends it without client action.
 * The client still verifies after `stop` and removes anything left.
 *
 * The protocol side (handshake, validation, queue, retryable stop) is the
 * generic {@link HelperSession}; this class adds the Docker parts.
 */
import { SessionError, type SyncSummary } from "../../backend.ts";
import type { BackendId } from "../../config/types.ts";
import type { Leftover, LogEvent } from "../../protocol.ts";
import type { CommandRunner, DockerEndpoint } from "../../runner/types.ts";
import { HelperSession } from "../../transport/helper-session.ts";
import { describeFailure, dockerArgv, runDocker } from "./cli.ts";
import { listLabelledObjects, removeObject, toLeftover, type LabelledObject } from "./footprint.ts";
import { formatViolations, hardRuleViolations, workspaceMountProblem, type ContainerInspect, type HostRules, type PathProbe } from "./inspect.ts";
import type { Spawner } from "./process.ts";
import { containerName, dockerRunArgs, WORKSPACE_PATH, type RunArgsInput } from "./run-args.ts";

export { METHOD_TIMEOUTS_MS } from "../../transport/helper-session.ts";

export interface DockerSessionOptions {
  id: string;
  backend: BackendId;
  runner: CommandRunner;
  spawner: Spawner;
  endpoint: DockerEndpoint;
  run: RunArgsInput;
  packageVersion: string;
  sync?: SyncSummary;
  onLog(event: LogEvent): void;
  pathProbe?: PathProbe;
  /** Client platform for the isolation rules (M1c Docker Desktop hosts); default Linux. */
  hostRules?: HostRules;
  readyTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** Time the `docker run` process gets to exit after stdin closes. */
  exitWaitMs?: number;
}

export class DockerSession extends HelperSession {
  readonly containerName: string;
  readonly #docker: DockerSessionOptions;

  constructor(options: DockerSessionOptions) {
    const name = containerName(options.id);
    super({
      id: options.id,
      backend: options.backend,
      packageVersion: options.packageVersion,
      workspacePath: WORKSPACE_PATH,
      onLog: options.onLog,
      ...(options.sync ? { sync: options.sync } : {}),
      ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
      ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
      ...(options.exitWaitMs !== undefined ? { exitWaitMs: options.exitWaitMs } : {}),
      labels: { launcher: "docker", target: "the session container", inside: "inside the container", stillRunning: "docker run CLI still running" },
      hooks: {
        spawn: (env) => options.spawner.spawn(dockerArgv(options.endpoint, dockerRunArgs(options.run)), { env }),
        verifyAfterStart: async (signal) => {
          const violations = await this.#inspectRunning(signal);
          if (violations) throw new SessionError("ISOLATION", `the session container breaks the isolation rules (${violations}); it was removed`);
        },
        onExitTimeout: async () => {
          await removeObject(options.runner, options.endpoint, { kind: "container", id: name, name, session: options.id });
        },
        teardown: () => this.#removeOwn(),
        audit: () => this.#auditOwn(),
      },
    });
    this.#docker = options;
    this.containerName = name;
  }

  /** PID of the `docker run` CLI process, once started. */
  get cliPid(): number | undefined {
    return this.helperPid;
  }

  /** `docker rm -f` argv for the synchronous exit handler. */
  forceRemoveArgv(): string[] {
    return dockerArgv(this.#docker.endpoint, ["rm", "-f", this.containerName]);
  }

  async #inspectRunning(signal: AbortSignal): Promise<string | undefined> {
    const result = await runDocker(this.#docker.runner, this.#docker.endpoint, ["container", "inspect", this.containerName], { timeoutMs: 10_000, signal });
    if (result.exitCode !== 0) return `docker inspect failed: ${describeFailure(result)}`;
    const [container] = JSON.parse(result.stdout) as ContainerInspect[];
    const problems = [];
    const violations = hardRuleViolations(container, this.#docker.pathProbe, this.#docker.hostRules);
    if (violations.length > 0) problems.push(formatViolations(violations));
    // The workspace must be the exact directory that was checked, not whatever the path names now.
    const workspace = workspaceMountProblem(container, this.#docker.run.workspace.source, WORKSPACE_PATH, this.#docker.hostRules?.platform);
    if (workspace) problems.push(`workspace: ${workspace}`);
    return problems.length > 0 ? problems.join("; ") : undefined;
  }

  #listOwn() {
    return listLabelledObjects(this.#docker.runner, this.#docker.endpoint, { session: this.id });
  }

  /** Removes anything still labelled with this session. */
  async #removeOwn(): Promise<Leftover[]> {
    const leftovers: Leftover[] = [];
    let own: LabelledObject[];
    try {
      own = await this.#listOwn();
    } catch (error) {
      leftovers.push({ kind: "docker", id: this.containerName, detail: `could not list the session's Docker objects: ${(error as Error).message}` });
      own = [];
    }
    for (const object of own) {
      const failed = await removeObject(this.#docker.runner, this.#docker.endpoint, object).catch((e: Error) => ({ kind: object.kind, id: object.name, detail: e.message }));
      if (failed) leftovers.push(failed);
    }
    return leftovers;
  }

  /** Read-only: this session's labelled Docker objects. */
  async #auditOwn(): Promise<Leftover[]> {
    try {
      return (await this.#listOwn()).map((o) => toLeftover(o));
    } catch (error) {
      return [{ kind: "docker", id: this.#docker.endpoint.host, detail: `audit failed: ${(error as Error).message}` }];
    }
  }
}
