/**
 * Git invocations on a project the user opened (spec §4.7, §7). A repository's
 * own `.git/config` is untrusted: it can name programs Git runs implicitly,
 * such as `core.fsmonitor` for every index read. Every call here overrides the
 * exec-capable settings that apply to read-only index and ignore queries.
 */

/**
 * Settings forced with `-c`, which beats every config file:
 *
 * - `core.fsmonitor=false` (and the pre-2.36 `core.useBuiltinFSMonitor`): no
 *   file-system monitor hook runs on index reads.
 * - `core.hooksPath=/dev/null`: no hook can run, even if a future Git version
 *   runs one for these commands.
 * - `core.untrackedCache=false`: no cache update writes into `.git`.
 */
export const SAFE_GIT_CONFIG = [
  "core.fsmonitor=false",
  "core.useBuiltinFSMonitor=false",
  "core.hooksPath=/dev/null",
  "core.untrackedCache=false",
] as const;

/** Environment for these calls: no optional index lock or refresh write, no credential prompt. */
export const SAFE_GIT_ENV: Readonly<Record<string, string>> = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

/**
 * `git` argv for a read-only query in `root` with {@link SAFE_GIT_CONFIG}.
 *
 * @param args Subcommand and its arguments, e.g. `["ls-files", "-z"]`.
 */
export function safeGitArgv(root: string, args: readonly string[]): string[] {
  return ["git", "--no-pager", "--no-optional-locks", ...SAFE_GIT_CONFIG.flatMap((c) => ["-c", c]), "-C", root, ...args];
}
