import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safetyGuardConfigFile } from "./config.mjs";

/** Match the native write/edit path normalization; parity is tested with real tools. */
export function normalizeToolPath(input: string, cwd: string): string {
  let value = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
  if (process.platform === "win32" && !value.includes("\\") && !value.startsWith("//")) {
    value = value.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
      (_match, drive: string, rest = "") => `${drive.toUpperCase()}:\\${rest.replaceAll("/", "\\")}`);
  }
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || process.platform === "win32" && value.startsWith("~\\")) value = path.join(homedir(), value.slice(2));
  if (value.startsWith("file://")) value = fileURLToPath(value);
  return path.resolve(cwd, value);
}

/** Resolve existing and dangling links, including parents of a not-yet-created file. */
export function canonicalFilePath(absolute: string): string {
  let root = path.parse(absolute).root;
  let pending = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let resolved = root;
  let links = 0;
  while (pending.length) {
    const next = path.join(resolved, pending.shift()!);
    let info;
    try { info = lstatSync(next); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!info?.isSymbolicLink()) { resolved = next; continue; }
    if (++links > 40) throw new Error("Too many symbolic links in file path");
    const target = path.resolve(path.dirname(next), readlinkSync(next), ...pending);
    root = path.parse(target).root;
    resolved = root;
    pending = target.slice(root.length).split(path.sep).filter(Boolean);
  }
  return resolved;
}

function pathIdentity(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function matchesProtectedName(value: string): boolean {
  const lower = value.toLowerCase().replace(/\\/g, "/");
  return /(^|\/)safety-guard-allow\.json(?:\.receipts\.json|\.legacy-[^/]+\.bak)?$/.test(lower)
    || /(^|\/)\.ssh(\/|$)/.test(lower)
    || /(^|\/)(?:\.git-credentials|auth\.json|id_(?:rsa|ed25519)(?:\.pub)?|\.env(?:\..+)?|\.envrc|\.npmrc|\.pypirc|\.netrc)$/.test(lower)
    || /(^|\/)(?:\.kube\/config|\.aws\/(?:credentials|config)|\.config\/gh\/hosts\.yml)$/.test(lower)
    || /(^|\/)\.config\/gcloud(\/|$)/.test(lower)
    || /\.(pem|key|p12|kdbx)$/.test(lower);
}

export function inspectFileTarget(input: string, cwd: string) {
  const requested = normalizeToolPath(input, cwd);
  const resolved = canonicalFilePath(requested);
  const settings = path.resolve(safetyGuardConfigFile());
  const isSettings = pathIdentity(requested) === pathIdentity(settings)
    || pathIdentity(resolved) === pathIdentity(canonicalFilePath(settings));
  return { requested, resolved, isSettings, protected: isSettings || matchesProtectedName(requested) || matchesProtectedName(resolved) };
}

export function isProtectedPath(input: string, cwd: string): boolean {
  return inspectFileTarget(input, cwd).protected;
}
