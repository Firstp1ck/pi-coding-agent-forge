/**
 * Facts about this installed package that the `docker-linux` backend needs:
 * where its tooling files live and which version labels the base image carries.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_IMAGE_REPOSITORY } from "../../labels.ts";

/** Absolute path of the package root (the directory holding `package.json`). */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let cachedVersion: string | undefined;

/** `version` from the package's `package.json`, read once. */
export function packageVersion(): string {
  if (cachedVersion === undefined) {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: unknown };
    if (typeof manifest.version !== "string" || manifest.version === "") throw new Error("package.json has no version");
    cachedVersion = manifest.version;
  }
  return cachedVersion;
}

/** Local tag of the base image for this package version. The labels, not the tag, decide freshness. */
export function baseImageTag(version: string = packageVersion()): string {
  return `${BASE_IMAGE_REPOSITORY}:${version}`;
}
