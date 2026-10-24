/**
 * Docker CLI plumbing for `docker-linux` (spec §4.1 "Docker endpoint"). Every
 * call of a session passes the endpoint resolved once for it via `--host`,
 * which makes the CLI ignore `DOCKER_CONTEXT` and the current context.
 */
import { access, constants, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { CommandRunner, DockerEndpoint, RunOptions, RunResult } from "../../runner/types.ts";
import { endpointProblem, endpointRemedy } from "./desktop.ts";

/**
 * `true` when an executable `docker` file is on `PATH`. Looks at the file
 * system only and never runs anything, so hosts without Docker see no
 * `docker` command at all (e.g. at Pi startup). On Windows the names come
 * from `PATHEXT` (`docker.exe`) and `PATH` is `;`-separated.
 */
export async function dockerOnPath(
  path: string | undefined = process.env.PATH ?? process.env.Path,
  platform: NodeJS.Platform = process.platform,
  pathExt: string | undefined = process.env.PATHEXT,
): Promise<boolean> {
  const windows = platform === "win32";
  const p = windows ? win32 : posix;
  const names = windows ? (pathExt || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => `docker${ext.toLowerCase()}`) : ["docker"];
  for (const dir of (path ?? "").split(windows ? ";" : ":")) {
    if (!dir) continue;
    for (const name of names) {
      // Windows accepts either separator; keep the one the PATH entry uses.
      const candidate = windows ? `${dir.replace(/[\\/]+$/, "")}${dir.includes("\\") ? "\\" : "/"}${name}` : p.join(dir, name);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        // Windows has no execute bit; existence is what counts there.
        await access(candidate, windows ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        // Not here; keep looking.
      }
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

/** Client platform whose endpoint kinds are accepted (default: Linux semantics, as on remote hosts). */
export type EndpointPlatform = NodeJS.Platform;

/**
 * Resolves the Docker endpoint the CLI would use: `DOCKER_HOST` when set
 * (it overrides contexts), otherwise the current context (honouring
 * `DOCKER_CONTEXT`) via `docker context inspect`. Only local endpoints are
 * accepted (spec §4.1): `unix://` sockets, and on Windows (`platform:
 * "win32"`, Docker Desktop) local named pipes; remote contexts and remote
 * `DOCKER_HOST` values fail. Without `platform` the Linux rule applies (the
 * remote backends resolve endpoints on a Linux host).
 *
 * @throws EndpointError with a user-facing explanation.
 */
export async function resolveEndpoint(
  runner: CommandRunner,
  options: { signal?: AbortSignal; timeoutMs?: number; source?: EndpointSource; platform?: EndpointPlatform } = {},
): Promise<DockerEndpoint> {
  const platform = options.platform ?? "linux";
  const dockerHost = options.source ? options.source.dockerHost : process.env.DOCKER_HOST;
  if (dockerHost !== undefined && dockerHost !== "") {
    return acceptEndpoint("DOCKER_HOST", dockerHost, platform);
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
  return acceptEndpoint(name, host, platform);
}

function acceptEndpoint(context: string, host: string, platform: EndpointPlatform): DockerEndpoint {
  const problem = endpointProblem(platform, host);
  if (problem) {
    const origin = context === "DOCKER_HOST" ? "DOCKER_HOST" : `context "${context}"`;
    throw new EndpointError(`${origin} points to ${host}; ${problem}. ${endpointRemedy(platform, context === "DOCKER_HOST" ? "DOCKER_HOST" : "context")}`);
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
