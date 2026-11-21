/**
 * Host writes of session artifacts. File names are generated here, never taken
 * from a helper response, and every write must land directly inside the
 * session's artifact dir without following or replacing anything there.
 */
import { lstat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Names this package gives artifacts: `screenshot-001.png`, `snapshot-002.json`, `app.log`. */
export const ARTIFACT_NAME = /^[a-z0-9][a-z0-9-]{0,62}\.[a-z0-9]{1,8}$/;

/**
 * Path of artifact `name` in `dir`.
 *
 * @throws Error when `name` is not a plain artifact name (no separators, no `..`).
 */
export function artifactPath(dir: string, name: string): string {
  if (!ARTIFACT_NAME.test(name)) throw new Error(`refusing artifact name ${JSON.stringify(name)}`);
  const path = join(dir, name);
  if (dirname(path) !== dir || basename(path) !== name) throw new Error(`artifact ${JSON.stringify(name)} would leave ${dir}`);
  return path;
}

/**
 * Creates artifact `name` in `dir` with mode 0600. Fails when `dir` is not a
 * real directory or `name` already exists (also as a symlink), so nothing is
 * overwritten or written through a link.
 */
export async function writeArtifact(dir: string, name: string, data: string | Buffer): Promise<string> {
  const path = artifactPath(dir, name);
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new Error(`artifact dir ${dir} is not a directory`);
  await writeFile(path, data, { mode: 0o600, flag: "wx" });
  return path;
}

/** Next artifact name of a session: `<kind>-NNN.<ext>` from the session's own counter. */
export function nextArtifactName(live: { counter: number }, kind: "screenshot" | "snapshot", ext: "png" | "json"): string {
  live.counter++;
  return `${kind}-${String(live.counter).padStart(3, "0")}.${ext}`;
}
