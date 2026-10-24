/**
 * Docker CLI plumbing for `docker-linux` (spec §4.1 "Docker endpoint"). Every
 * call of a session passes the endpoint resolved once for it via `--host`,
 * which makes the CLI ignore `DOCKER_CONTEXT` and the current context.
 */
import { access, constants, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { CommandRunner, DockerEndpoint, RunOptions, RunResult } from "../../runner/types.ts";

/**
 * `true` when an executable `docker` file is on `PATH`. Looks at the file
 * system only and never runs anything, so hosts without Docker see no
 * `docker` command at all (e.g. at Pi startup).
 */
export async function dockerOnPath(path: string | undefined = process.env.PATH): Promise<boolean> {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "docker");
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Not here; keep looking.
    }
  }
  return false;
}

/** Argv of one `docker` call against `endpoint`. */
export function dockerArgv(endpoint: DockerEndpoint, args: readonly string[]): string[] {
  return ["docker", "--host", endpoint.host, ...args];
}

/** Runs `docker --host <endpoint> …args`. */
export function runDocker(
  runner: CommandRunner,
  endpoint: DockerEndpoint,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return runner.run(dockerArgv(endpoint, args), options);
}

/** Last lines of a command's output for error messages. */
export function outputTail(result: Pick<RunResult, "stdout" | "stderr">, max = 300): string {
  const text = (result.stderr.trim() || result.stdout.trim()).replace(/\s+/g, " ");
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/** Describes a failed run in one line: timeout, signal, or exit code plus the output tail. */
export function describeFailure(result: RunResult): string {
  if (result.timedOut) return `timed out after ${result.durationMs} ms`;
  const status = result.exitCode === null ? `killed by ${result.signal}` : `exit ${result.exitCode}`;
  const tail = outputTail(result);
  return tail ? `${status}: ${tail}` : status;
}

/** Thrown when the active Docker endpoint is not a local `unix://` socket or cannot be read. */
export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointError";
  }
}

export interface EndpointSource {
  /** Value of `DOCKER_HOST` in the client environment, if set. */
  dockerHost?: string;
}

/**
 * Resolves the Docker endpoint the CLI would use: `DOCKER_HOST` when set
 * (it overrides contexts), otherwise the current context (honouring
 * `DOCKER_CONTEXT`) via `docker context inspect`. Only `unix://` endpoints are
 * accepted (spec §4.1); remote contexts and remote `DOCKER_HOST` values fail.
 *
 * @throws EndpointError with a user-facing explanation.
 */
export async function resolveEndpoint(
  runner: CommandRunner,
  options: { signal?: AbortSignal; timeoutMs?: number; source?: EndpointSource } = {},
): Promise<DockerEndpoint> {
  const dockerHost = options.source ? options.source.dockerHost : process.env.DOCKER_HOST;
  if (dockerHost !== undefined && dockerHost !== "") {
    return acceptEndpoint("DOCKER_HOST", dockerHost);
  }
  const result = await runner.run(["docker", "context", "inspect", "--format", "{{json .}}"], {
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal,
  });
  if (result.exitCode !== 0) throw new EndpointError(`docker context inspect failed (${describeFailure(result)})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim().split("\n")[0] ?? "");
  } catch {
    throw new EndpointError(`docker context inspect printed no JSON: ${outputTail(result)}`);
  }
  const context = parsed as { Name?: unknown; Endpoints?: { docker?: { Host?: unknown } } };
  const name = typeof context.Name === "string" && context.Name ? context.Name : "default";
  const host = context.Endpoints?.docker?.Host;
  if (typeof host !== "string" || host === "") throw new EndpointError(`context "${name}" has no Docker endpoint`);
  return acceptEndpoint(name, host);
}

function acceptEndpoint(context: string, host: string): DockerEndpoint {
  if (!host.startsWith("unix://") || host.length <= "unix://".length) {
    const origin = context === "DOCKER_HOST" ? "DOCKER_HOST" : `context "${context}"`;
    throw new EndpointError(
      `${origin} points to ${host}; only a local Docker daemon on a unix:// socket is supported. ` +
        (context === "DOCKER_HOST" ? "Unset DOCKER_HOST" : "Run: docker context use default"),
    );
  }
  return { context, host };
}

/** Socket path of a `unix://` endpoint. */
export function socketPath(endpoint: DockerEndpoint): string {
  return endpoint.host.slice("unix://".length);
}

/**
 * Parses newline-separated JSON objects, as printed by `--format '{{json .}}'`
 * for list commands. Blank lines are skipped; a malformed line throws.
 */
export function parseJsonLines<T>(text: string): T[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}
