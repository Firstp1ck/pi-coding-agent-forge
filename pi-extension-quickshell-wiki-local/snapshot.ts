import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export interface SnapshotDocument {
  title: string;
  sourceUrl: string;
  source: "quickshell-guide" | "quickshell-api" | "qt";
  version: string;
  text: string;
  links: string[];
  file: string;
}
export interface SnapshotManifest {
  schemaVersion: number;
  parserVersion: number;
  snapshot: string;
  downloadedAt: string;
  selection: string;
  quickshellVersion: string;
  qtVersions: string[];
  pageCount: number;
  counts: Record<string, number>;
  quickshellInventoryCount: number;
  receivedBytes: number;
  unavailableQtPages: Array<{ url: string; status: number }>;
  sha256: string;
  coverage: string;
}
export interface Snapshot {
  directory: string;
  manifest: SnapshotManifest;
  documents: SnapshotDocument[];
  signature: string;
}

export function canonicalSource(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !["quickshell.org", "doc.qt.io"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.port) {
    throw new Error(`Unsupported documentation source: ${url}`);
  }
  parsed.hash = "";
  if (parsed.hostname === "quickshell.org") {
    if (!/^\/docs\/(v\d+\.\d+\.\d+|master)\/(guide|types)(\/|$)/.test(parsed.pathname)) throw new Error(`Unsupported Quickshell source path: ${url}`);
    parsed.pathname = parsed.pathname.replace(/\/$/, "") + "/";
  } else if (!/^\/qt-6\/[a-z0-9_.-]+\.html$/i.test(parsed.pathname)) throw new Error(`Unsupported Qt source path: ${url}`);
  return parsed.href;
}

/** Load and validate the immutable setup snapshot; never execute downloaded content. */
export function createSnapshotReader(root: string) {
  let cached: Snapshot | undefined;
  return async function readSnapshot(): Promise<Snapshot | undefined> {
    const pointerPath = path.join(root, "current.json");
    let pointerRaw: string;
    try { pointerRaw = await fs.readFile(pointerPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (pointerRaw.length > 4096) throw new Error("Oversized offline snapshot pointer");
    const pointer = JSON.parse(pointerRaw);
    if (pointer.schemaVersion !== 1 || typeof pointer.snapshot !== "string" || !/^[a-f0-9]{32}$/.test(pointer.snapshot)) throw new Error("Invalid offline snapshot pointer");
    const directory = path.join(root, "snapshots", pointer.snapshot);
    const manifestPath = path.join(directory, "manifest.json");
    const pagesPath = path.join(directory, "pages.json");
    for (const entry of [root, path.join(root, "snapshots"), directory, pointerPath, manifestPath, pagesPath]) {
      if ((await fs.lstat(entry)).isSymbolicLink()) throw new Error(`Offline snapshot symlink refused: ${entry}`);
    }
    const [manifestStat, pagesStat] = await Promise.all([fs.stat(manifestPath), fs.stat(pagesPath)]);
    if (manifestStat.size > 1024 * 1024 || pagesStat.size > 100 * 1024 * 1024) throw new Error("Offline snapshot size limit exceeded");
    const signature = JSON.stringify([pointer.snapshot, manifestStat.size, manifestStat.mtimeMs, pagesStat.size, pagesStat.mtimeMs]);
    if (cached?.signature === signature) return cached;
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as SnapshotManifest;
    const raw = await fs.readFile(pagesPath);
    if (manifest.schemaVersion !== 1 || manifest.snapshot !== pointer.snapshot || manifest.sha256 !== createHash("sha256").update(raw).digest("hex")) throw new Error("Offline snapshot integrity check failed. The legacy checkout was not modified; rerun setup or roll back.");
    if (!/^(v\d+\.\d+\.\d+|master)$/.test(manifest.quickshellVersion) || !Array.isArray(manifest.qtVersions) || !manifest.qtVersions.length || !manifest.qtVersions.every((v) => /^6\.\d+(\.\d+)?$/.test(v))) throw new Error("Invalid snapshot version metadata");
    if (typeof manifest.coverage !== "string" || !manifest.counts || !Array.isArray(manifest.unavailableQtPages)) throw new Error("Missing snapshot coverage metadata");
    const documents: SnapshotDocument[] = JSON.parse(raw.toString("utf8"));
    if (!Array.isArray(documents) || documents.length !== manifest.pageCount || documents.length > 1400 || documents.length === 0) throw new Error("Invalid snapshot page inventory");
    const seen = new Set<string>();
    const sources = new Set<string>();
    const counts: Record<string, number> = { "quickshell-guide": 0, "quickshell-api": 0, qt: 0 };
    for (const page of documents) {
      if (typeof page.title !== "string" || typeof page.text !== "string" || typeof page.sourceUrl !== "string" || typeof page.version !== "string" || !Array.isArray(page.links) || !page.links.every((link) => typeof link === "string") || !["quickshell-guide", "quickshell-api", "qt"].includes(page.source) || !/^\d{4}\.md$/.test(page.file) || seen.has(page.file)) throw new Error("Malformed offline document record");
      const source = canonicalSource(page.sourceUrl);
      const parsedSource = new URL(source);
      const expectedKind = parsedSource.hostname === "doc.qt.io" ? "qt" : parsedSource.pathname.includes("/types/") ? "quickshell-api" : "quickshell-guide";
      if (sources.has(source) || page.source !== expectedKind) throw new Error("Duplicate or mislabeled documentation source");
      if (page.source === "qt" ? !manifest.qtVersions.includes(page.version) : page.version !== manifest.quickshellVersion || !parsedSource.pathname.startsWith(`/docs/${page.version}/`)) throw new Error("Mixed or mislabeled source versions in snapshot");
      counts[page.source]++;
      sources.add(source);
      seen.add(page.file);
      const local = await fs.lstat(path.join(directory, page.file));
      if (!local.isFile() || local.isSymbolicLink()) throw new Error("Offline citation file is missing or unsafe");
    }
    if (Object.entries(counts).some(([source, count]) => manifest.counts[source] !== count) || counts["quickshell-api"] + counts["quickshell-guide"] !== manifest.quickshellInventoryCount) throw new Error("Snapshot coverage counts do not match its documents");
    cached = { directory, manifest, documents, signature };
    return cached;
  };
}
