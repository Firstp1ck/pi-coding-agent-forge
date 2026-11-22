/**
 * Quoting for commands that `ssh` hands to the remote login shell (spec
 * §4.2a). OpenSSH joins every word after the destination with spaces and the
 * remote shell parses the result, so every argument must be quoted here.
 *
 * The quoting works the same in POSIX shells (sh, dash, bash, ksh, zsh) and in
 * fish: plain text goes inside single quotes, and the two characters single
 * quotes treat differently across those shells, `'` and `\`, are written as
 * `"'"` and `"\\"` outside them. Scripts always run under `/bin/sh -c`, so
 * only this outer layer meets the user's login shell.
 */

/** Characters that stay unquoted (never special at any position in the supported shells). */
const BARE = /^[A-Za-z0-9_./:@+-][A-Za-z0-9_./:@,+=-]*$/;

/**
 * Quotes one word for the remote login shell.
 *
 * @throws Error for a NUL character, which no shell argument can carry.
 */
export function shellQuote(word: string): string {
  if (word.includes("\0")) throw new Error("a remote command argument contains a NUL character");
  if (word === "") return "''";
  if (BARE.test(word)) return word;
  let out = "";
  let open = false;
  for (const ch of word) {
    if (ch === "'" || ch === "\\") {
      if (open) {
        out += "'";
        open = false;
      }
      out += ch === "'" ? `"'"` : `"\\\\"`;
      continue;
    }
    if (!open) {
      out += "'";
      open = true;
    }
    out += ch;
  }
  if (open) out += "'";
  return out;
}

/** Quotes and joins an argv into one remote command line. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

/**
 * The remote command line that runs `script` under `/bin/sh -c` with `args`
 * as `$1`, `$2`, …. Arguments are never part of the script text, so they are
 * never re-parsed as shell code.
 */
export function shScript(script: string, args: readonly string[] = []): string {
  return shellJoin(["/bin/sh", "-c", script, "sh", ...args]);
}

/** A portable environment variable name. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Checks an environment entry for the remote side.
 *
 * @throws Error for an invalid name, or a value with a newline or NUL (values travel as lines).
 */
export function assertEnvEntry(name: string, value: string): void {
  if (!ENV_NAME.test(name)) throw new Error(`invalid environment variable name ${JSON.stringify(name)}`);
  if (typeof value !== "string" || value.includes("\n") || value.includes("\0") || value.includes("\r")) {
    throw new Error(`environment variable ${name} has a value that cannot be passed to the remote host (newline or NUL)`);
  }
}

/**
 * Checks an SSH destination as given by the user (an alias from
 * `~/.ssh/config`, `user@host`, or an `ssh://` URI).
 *
 * @returns The destination unchanged.
 * @throws Error for an empty value, a leading `-` (it would be read as an option), whitespace, or control characters.
 */
export function assertDestination(destination: string): string {
  if (typeof destination !== "string" || destination.length === 0) throw new Error("no SSH host given");
  if (destination.length > 255) throw new Error("SSH host is longer than 255 characters");
  if (destination.startsWith("-")) throw new Error(`SSH host ${JSON.stringify(destination)} starts with "-"`);
  if (/[\s\0-\x1f\x7f'"`$\\;&|<>()]/.test(destination)) throw new Error(`SSH host ${JSON.stringify(destination)} contains whitespace, quotes, or shell characters`);
  return destination;
}

/** Remote paths this package creates or uses must consist of these characters only. */
export const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/@+-]*$/;

/**
 * Checks an absolute remote path made of safe characters (no `..` segment).
 *
 * @throws Error naming the path otherwise.
 */
export function assertSafeRemotePath(path: string): string {
  if (!SAFE_REMOTE_PATH.test(path) || path.split("/").includes("..")) throw new Error(`unsafe remote path ${JSON.stringify(path)}`);
  return path;
}
