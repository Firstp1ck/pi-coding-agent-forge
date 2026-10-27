/** Atomic JSON file writes shared by config and owner records. */
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
  /** File mode of the written file. Default 0o600: config may hold personal choices. */
  mode?: number;
  /** Mode for parent directories created on the way. Default 0o700. */
  dirMode?: number;
}

/**
 * Writes `data` as pretty JSON to `path` via a temp file in the same directory
 * plus `rename`, so readers see either the old or the new file, never a torn
 * one. Creates missing parent directories. The temp file is removed on failure.
 */
export async function writeJsonAtomic(path: string, data: unknown, options: AtomicWriteOptions = {}): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: options.dirMode ?? 0o700 });
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    const handle = await open(temp, "wx", options.mode ?? 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
