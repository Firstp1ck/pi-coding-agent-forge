/**
 * Base image for `docker-linux` (spec §4.1): built locally from the package's
 * Dockerfile through a staged tar stream piped to `docker build -`. The stream
 * holds only package tooling (helper, Dockerfile, GTK 3 smoke app), never a
 * project file, and needs no buildx plugin.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BASE_LABEL_VALUE, LABEL_BASE, LABEL_PROTOCOL, LABEL_VERSION } from "../../labels.ts";
import { PROTOCOL_VERSION } from "../../protocol.ts";
import type { CommandRunner, DockerEndpoint, RunResult } from "../../runner/types.ts";
import { describeFailure, dockerArgv, runDocker } from "./cli.ts";
import { PACKAGE_ROOT, baseImageTag, packageVersion } from "./package.ts";
import type { Spawner } from "./process.ts";
import { runWithInput } from "./process.ts";
import { createTar, type TarEntry } from "./tar.ts";

/** Package-relative sources of the build context and where they go inside it. */
export const BUILD_CONTEXT_SOURCES = [
  { from: "helpers/linux/Dockerfile", to: "Dockerfile" },
  { from: "helpers/linux/.dockerignore", to: ".dockerignore" },
  { from: "helpers/linux/helper", to: "helper" },
  { from: "helpers/linux/pi_gui_helper", to: "pi_gui_helper" },
  { from: "testapps/gtk3-smoke", to: "testapps/gtk3-smoke" },
] as const;

/** Upper bound for an image build (downloads ~0.5 GB of Debian packages). */
export const IMAGE_BUILD_TIMEOUT_MS = 45 * 60_000;
/** Shown in the remediation plan. */
export const IMAGE_BUILD_DOWNLOAD_BYTES = 500 * 1024 ** 2;
export const IMAGE_BUILD_ESTIMATED_SECONDS = 600;

function skipped(name: string): boolean {
  return name === "__pycache__" || name.endsWith(".pyc");
}

async function addTree(entries: TarEntry[], source: string, target: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new Error(`build context source ${source} is not a regular file or directory`);
  }
  if (info.isFile()) {
    entries.push({ path: target, type: "file", mode: info.mode & 0o111 ? 0o755 : 0o644, data: await readFile(source) });
    return;
  }
  entries.push({ path: target, type: "dir", mode: 0o755 });
  const names = (await readdir(source)).filter((n) => !skipped(n)).sort();
  for (const name of names) await addTree(entries, join(source, name), `${target}/${name}`);
}

/**
 * Builds the context archive from the package files listed in
 * {@link BUILD_CONTEXT_SOURCES}. Paths are sorted and metadata normalised, so
 * the archive is reproducible.
 */
export async function stageBuildContext(packageRoot: string = PACKAGE_ROOT): Promise<Buffer> {
  const entries: TarEntry[] = [{ path: "testapps", type: "dir", mode: 0o755 }];
  for (const { from, to } of BUILD_CONTEXT_SOURCES) await addTree(entries, join(packageRoot, from), to);
  return createTar(entries);
}

/** `docker build` arguments (after `docker --host <h>`). */
export function buildArgs(version: string = packageVersion(), tag: string = baseImageTag(version)): string[] {
  return [
    "build",
    "--force-rm",
    "--build-arg",
    `PACKAGE_VERSION=${version}`,
    "--build-arg",
    `PROTOCOL_VERSION=${PROTOCOL_VERSION}`,
    "-t",
    tag,
    "-",
  ];
}

export interface BuildImageOptions {
  spawner: Spawner;
  endpoint: DockerEndpoint;
  signal: AbortSignal;
  onLine?: (line: string) => void;
  timeoutMs?: number;
  version?: string;
  packageRoot?: string;
}

/**
 * Builds and tags the base image. An abort or timeout kills the build; since
 * the tag and labels are applied only at the end, no labelled image remains.
 */
export async function buildBaseImage(options: BuildImageOptions): Promise<RunResult> {
  const version = options.version ?? packageVersion();
  const context = await stageBuildContext(options.packageRoot);
  return runWithInput(options.spawner, dockerArgv(options.endpoint, buildArgs(version)), context, {
    timeoutMs: options.timeoutMs ?? IMAGE_BUILD_TIMEOUT_MS,
    signal: options.signal,
    onLine: options.onLine,
  });
}

export interface ImageInfo {
  id: string;
  architecture: string;
  labels: Record<string, string>;
}

/**
 * Inspects an image by reference.
 *
 * @returns `undefined` when the image does not exist.
 * @throws Error when Docker fails for another reason.
 */
export async function inspectImage(
  runner: CommandRunner,
  endpoint: DockerEndpoint,
  ref: string,
  signal?: AbortSignal,
): Promise<ImageInfo | undefined> {
  const result = await runDocker(runner, endpoint, ["image", "inspect", "--format", "{{json .}}", ref], { timeoutMs: 10_000, signal });
  if (result.exitCode !== 0) {
    if (/no such (image|object)/i.test(result.stderr)) return undefined;
    throw new Error(`docker image inspect ${ref} failed (${describeFailure(result)})`);
  }
  const raw = JSON.parse(result.stdout.trim()) as { Id?: string; Architecture?: string; Config?: { Labels?: Record<string, string> | null } };
  return { id: raw.Id ?? "", architecture: raw.Architecture ?? "", labels: raw.Config?.Labels ?? {} };
}

/** Why `image` is not a usable base image for this package, or `undefined` when it is. */
export function baseImageProblem(image: ImageInfo, version: string = packageVersion()): string | undefined {
  const labels = image.labels;
  if (labels[LABEL_BASE] !== BASE_LABEL_VALUE) return `label ${LABEL_BASE} is ${labels[LABEL_BASE] ?? "missing"}`;
  if (labels[LABEL_VERSION] !== version) return `label ${LABEL_VERSION} is ${labels[LABEL_VERSION] ?? "missing"}, this package is ${version}`;
  if (labels[LABEL_PROTOCOL] !== String(PROTOCOL_VERSION)) {
    return `label ${LABEL_PROTOCOL} is ${labels[LABEL_PROTOCOL] ?? "missing"}, this package speaks ${PROTOCOL_VERSION}`;
  }
  return undefined;
}
