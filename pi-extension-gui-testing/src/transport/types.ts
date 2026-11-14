/**
 * What a transport gives a backend: short commands ({@link CommandRunner})
 * and one long-lived helper process ({@link HelperProcess}) for
 * {@link HelperSession}. The local transport is `createSpawnRunner()` plus
 * `spawnLocalProcess()`; Docker uses its endpoint-bound runner and spawner.
 *
 * Contract for an SSH transport (`src/transport/ssh/`):
 * - `runner.run(argv, options)` runs `argv` on the remote host and resolves
 *   with the remote exit code, like the local runner: argv only (quoted for the
 *   remote shell by the transport, never by callers), `timeoutMs` bounds the
 *   whole call including the connection, `signal` aborts it, `env` is set on the
 *   remote command only, `input` goes to remote stdin. Rejects only when `ssh`
 *   itself cannot be spawned. A connection failure is a result with `ssh`'s exit
 *   code 255 and its stderr.
 * - `spawnHelper(argv, env)` starts the remote helper with open pipes; the
 *   protocol token travels in `env` (remote side), never in argv.
 * - `close()` ends the per-session ControlMaster; idempotent.
 */
import type { CommandRunner } from "../runner/types.ts";
import type { HelperProcess } from "./process.ts";

export interface HelperTransport {
  /** Short commands on the machine that runs the helper. */
  readonly runner: CommandRunner;
  /** Starts the helper with `env` (holding the protocol token) and open pipes. */
  spawnHelper(argv: readonly string[], env: Readonly<Record<string, string>>): HelperProcess;
  /** Releases the transport (e.g. an SSH ControlMaster). Idempotent. */
  close?(): Promise<void>;
}
