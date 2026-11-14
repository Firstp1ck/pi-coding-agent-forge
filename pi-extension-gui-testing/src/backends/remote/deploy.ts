/**
 * Helper deploy for `remote-linux` (spec §7a.3): the package's Linux helper
 * and the GTK 3 smoke app are copied into the remote session dir as one tar
 * stream over SSH, then verified file by file with `sha256sum`. Nothing is
 * installed outside the session dir; it goes away with it.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../docker/package.ts";
import type { SshTransport } from "../../transport/ssh/transport.ts";
import { tarBuffer, type TarStreamEntry } from "../../sync/transport/tar-stream.ts";
import { remoteFailure } from "./session-dir.ts";

/** Package-relative sources and where they go below `tooling/`. */
export const TOOLING_SOURCES = [
  { from: "helpers/linux/helper", to: "helper" },
  { from: "helpers/linux/pi_gui_helper", to: "pi_gui_helper" },
  { from: "testapps/gtk3-smoke", to: "testapps/gtk3-smoke" },
] as const;

/** Smoke app path relative to the remote workspace (`<dir>/workspace` → `<dir>/tooling/…`). */
export const REMOTE_SMOKE_APP = "../tooling/testapps/gtk3-smoke/app.py";

function skipped(name: string): boolean {
  return name === "__pycache__" || name.endsWith(".pyc");
}

async function addTree(entries: TarStreamEntry[], source: string, target: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error(`tooling source ${source} is not a regular file or directory`);
  if (info.isFile()) {
    entries.push({ path: target, type: "file", mode: info.mode & 0o111 ? 0o755 : 0o644, data: await readFile(source) });
    return;
  }
  entries.push({ path: target, type: "dir", mode: 0o755 });
  for (const name of (await readdir(source)).filter((n) => !skipped(n)).sort()) await addTree(entries, join(source, name), `${target}/${name}`);
}

/** Archive entries of the tooling, sorted and with normalised modes. */
export async function toolingEntries(packageRoot: string = PACKAGE_ROOT): Promise<TarStreamEntry[]> {
  const entries: TarStreamEntry[] = [{ path: "testapps", type: "dir", mode: 0o755 }];
  for (const { from, to } of TOOLING_SOURCES) await addTree(entries, join(packageRoot, from), to);
  return entries;
}

/** `sha256` of every file entry, by path. */
export function manifest(entries: readonly TarStreamEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) if (entry.type === "file") map.set(entry.path, createHash("sha256").update(entry.data ?? Buffer.alloc(0)).digest("hex"));
  return map;
}

/** Parses `sha256sum` output (`<hash>  <path>` or `<hash> *<path>`). */
export function parseSha256sum(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match) map.set(match[2].replace(/^\.\//, ""), match[1]);
  }
  return map;
}

/**
 * Extracts `entries` into `dir` on the remote host (umask applies) and checks
 * every file's hash there.
 *
 * @throws Error when extraction fails or a hash differs.
 */
export async function deployFiles(transport: SshTransport, dir: string, entries: readonly TarStreamEntry[], options: { signal?: AbortSignal; umask?: string } = {}): Promise<{ files: number; bytes: number }> {
  const archive = await tarBuffer(entries);
  const umask = options.umask ?? "077";
  if (!/^0?[0-7]{3}$/.test(umask)) throw new Error(`invalid umask ${umask}`);
  const extract = await transport.runStream(["/bin/sh", "-c", `umask ${umask} && exec tar -x -f -`, "sh"], archive, { cwd: dir, timeoutMs: 120_000, ...(options.signal ? { signal: options.signal } : {}) });
  if (extract.exitCode !== 0) throw new Error(`copying files to ${transport.destination}:${dir} failed (${remoteFailure(extract)})`);
  const expected = manifest(entries);
  const paths = [...expected.keys()];
  const sums = await transport.runner.run(["sha256sum", "--", ...paths], { cwd: dir, timeoutMs: 60_000, ...(options.signal ? { signal: options.signal } : {}) });
  if (sums.exitCode !== 0) throw new Error(`verifying the copied files on ${transport.destination} failed (${remoteFailure(sums)})`);
  const actual = parseSha256sum(sums.stdout);
  const wrong = paths.filter((p) => actual.get(p) !== expected.get(p));
  if (wrong.length > 0) throw new Error(`files copied to ${transport.destination}:${dir} differ from the package (${wrong.slice(0, 5).join(", ")}); they were not used`);
  return { files: paths.length, bytes: archive.length };
}

/** Copies the helper and the smoke app into `<session dir>/tooling`. */
export async function deployHelper(transport: SshTransport, tooling: string, options: { signal?: AbortSignal; packageRoot?: string } = {}): Promise<{ files: number; bytes: number }> {
  return deployFiles(transport, tooling, await toolingEntries(options.packageRoot), { ...(options.signal ? { signal: options.signal } : {}), umask: "077" });
}
