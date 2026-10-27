/**
 * Command-runner abstraction used by checks and backends, so unit tests can
 * substitute a fake. Commands are argv arrays, never shell strings.
 */

export interface RunOptions {
  /** Hard bound; the child is killed when it elapses. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Merged over a minimal inherited environment chosen by the runner. */
  env?: Record<string, string>;
  cwd?: string;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  /** Output beyond this many bytes per stream is dropped and `truncated` is set. Default 1 MiB. */
  maxOutputBytes?: number;
}

export interface RunResult {
  /** `null` when the process was killed by a signal or timeout. */
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface CommandRunner {
  /**
   * Runs `argv[0]` with the remaining arguments.
   *
   * Resolves for every outcome, including non-zero exits and timeouts; rejects
   * only when the executable cannot be spawned (e.g. `ENOENT`) or `signal`
   * aborts before spawn.
   */
  run(argv: readonly string[], options: RunOptions): Promise<RunResult>;
}

/**
 * The Docker endpoint resolved once per session (spec §4.1). Every `docker`
 * call of that session passes it explicitly.
 */
export interface DockerEndpoint {
  /** Context name, e.g. `default`. */
  context: string;
  /** Endpoint URL; M1 accepts only `unix://` sockets. */
  host: string;
}
