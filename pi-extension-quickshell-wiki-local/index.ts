import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalSource, createSnapshotReader, type Snapshot } from "./snapshot.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const CONFIG = {
  extensionId: "quickshell",
  displayName: "Quickshell Docs",
  skillName: "quickshell-local",
  docsPath: path.resolve((process.env.QUICKSHELL_DOCS_PATH || "~/.quickshell-docs").replace(/^~(?=\/|$)/, os.homedir())),
  requestedVersion: process.env.QUICKSHELL_DOCS_VERSION,
  repoUrl: "https://quickshell.org/sitemap-index.xml",
  setupCommand: "/quickshell-wiki-local-setup",
  format: "markdown",
  fileExtensions: /\.mdx?$/i,
  promptDetection: /\b(quickshell|shell\.qml|PanelWindow|WlrLayershell|IpcHandler)\b/i,
  queryExpansions: {
    setup: ["install", "configuration"], bar: ["PanelWindow", "anchors"],
    qmlls: ["language server"], bindings: ["reactive bindings", "property bindings"],
    ipc: ["IpcHandler"], pragmas: ["pragma", "advanced"],
  } as Record<string, string[]>,
  searchStopwords: new Set(["how", "do", "i", "the", "a", "to", "with", "on"]),
  termWeights: { quickshell: 0.15, qt: 0.15, qml: 0.4 } as Record<string, number>,
};

const LEGACY_COVERAGE = "Legacy usage guides only. Run /quickshell-wiki-local-setup to download the newest published guides, full Quickshell API and core Qt references. @@Type markers are upstream cross-references, not runnable QML.";
interface Section { title: string; level: number; anchor: string; text: string }
interface Page { title: string; path: string; slug: string; text: string; sections: Section[]; source?: string; sourceUrl?: string; sourceVersion?: string; links?: string[] }
interface Corpus { version: string; pages: Page[]; signature: string; snapshot?: Snapshot }

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_./+-]+/g, " ").trim();
}
function anchor(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function bounded(value: number | undefined, fallback: number, max: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.floor(value!), max)) : fallback;
}
function limited(text: string, maxChars: number) {
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
}
function jsonResult<T>(details: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
}
async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

export function parseGuide(raw: string, file: string): Page {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const title = frontmatter?.[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1]
    || path.basename(file, path.extname(file));
  const body = frontmatter ? raw.slice(frontmatter[0].length) : raw;
  const sections: Section[] = [{ title, level: 1, anchor: anchor(title), text: "" }];
  let fence: { char: string; length: number } | undefined;
  for (const line of body.split(/\r?\n/)) {
    const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (delimiter) {
      if (!fence) fence = { char: delimiter[1][0], length: delimiter[1].length };
      else if (delimiter[1][0] === fence.char && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      sections[sections.length - 1].text += `${line}\n`;
      continue;
    }
    const heading = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const explicit = heading[2].match(/\s+\{#([^}]+)\}$/);
      const name = heading[2].replace(/\s+\{#[^}]+\}$/, "").replace(/[*`]/g, "");
      sections.push({ title: name, level: heading[1].length, anchor: explicit?.[1] || anchor(name), text: "" });
    } else sections[sections.length - 1].text += `${line}\n`;
  }
  for (const section of sections) section.text = section.text.trim();
  return { title, path: file, slug: path.basename(file, path.extname(file)), text: `# ${title}\n\n${body.trim()}`, sections };
}

function expandQuery(query: string) {
  const raw = normalize(query).split(/\s+/).filter(Boolean);
  const ignoredStopwords = raw.filter((word) => CONFIG.searchStopwords.has(word));
  const terms = raw.filter((word) => !CONFIG.searchStopwords.has(word));
  const groups = (terms.length ? terms : raw).map((word) => [...new Set([word, ...(CONFIG.queryExpansions[word] || [])].map(normalize))]);
  return { terms: [...new Set(groups.flat())], groups, ignoredStopwords };
}
function score(text: string, terms: string[], cap: number): number {
  const normalized = normalize(text);
  return terms.reduce((sum, term) => sum + Math.min(cap, normalized.split(term).length - 1) * (CONFIG.termWeights[term] ?? 1), 0);
}

function exactTypeBonus(page: Page, terms: string[]): number {
  const name = page.source === "quickshell-api" ? page.slug.split("/").pop()
    : page.source === "qt" ? page.title.match(/^(.+?) QML Type(?:\s|$)/)?.[1] : undefined;
  return name && terms.includes(normalize(name)) ? 40 : 0;
}

export function createWiki(docsPath = CONFIG.docsPath, requestedVersion = CONFIG.requestedVersion) {
  docsPath = path.resolve(docsPath);
  let cache: Corpus | undefined;
  const offlinePath = `${docsPath}.offline`;
  const readSnapshot = createSnapshotReader(offlinePath);
  const missing = `Local Quickshell guides are unavailable at ${docsPath}. Run ${CONFIG.setupCommand}.`;

  async function profile() {
    let raw: string;
    try { raw = await fs.readFile(path.join(docsPath, "versions.json"), "utf8"); }
    catch { throw new Error(missing); }
    const data = JSON.parse(raw);
    if (!Array.isArray(data.versions) || typeof data.default !== "string") throw new Error("Invalid Quickshell versions.json");
    const names = data.versions.map((entry: { name?: unknown }) => entry?.name);
    if (names.some((name: unknown) => typeof name !== "string" || !/^(master|v\d+\.\d+\.\d+)$/.test(name))) {
      throw new Error("Unsupported Quickshell guide version in versions.json");
    }
    const version = requestedVersion && requestedVersion !== "latest" ? requestedVersion : data.default;
    const selected = names.indexOf(version);
    if (selected < 0) throw new Error(`Unknown docs version '${version}'. Available: ${names.join(", ")}`);
    const files = new Map<string, string>();
    // Match upstream's guide inheritance: older pages remain until replaced by a newer revision.
    for (const name of names.slice(selected).reverse() as string[]) {
      const dir = path.join(docsPath, "src", "guide", name.replaceAll(".", "_"));
      if (!await exists(dir)) continue;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isFile() && CONFIG.fileExtensions.test(entry.name)) {
          files.set(entry.name.replace(CONFIG.fileExtensions, ""), path.join(dir, entry.name));
        }
      }
    }
    if (!files.size) throw new Error(missing);
    const paths = [...files.values()].sort();
    const fingerprints = await Promise.all(paths.map(async (file) => {
      const stat = await fs.stat(file);
      return [file, stat.size, stat.mtimeMs];
    }));
    return { version, paths, signature: JSON.stringify([version, fingerprints]) };
  }

  async function load(): Promise<Corpus> {
    const snapshot = await readSnapshot();
    if (snapshot) {
      if (requestedVersion && requestedVersion !== "latest" && requestedVersion !== snapshot.manifest.quickshellVersion) {
        throw new Error(`Active snapshot is ${snapshot.manifest.quickshellVersion}, not ${requestedVersion}. Run setup --version ${requestedVersion}; no silent mixed-version lookup.`);
      }
      if (cache?.signature === snapshot.signature) return cache;
      const pages = snapshot.documents.map((document): Page => {
        const file = path.join(snapshot.directory, document.file);
        const parsed = parseGuide(`---\ntitle: ${JSON.stringify(document.title)}\n---\n${document.text}`, file);
        const url = new URL(document.sourceUrl);
        const suffix = url.pathname.replace(/^\/docs\/[^/]+\//, "");
        const slug = document.source === "qt" ? path.basename(url.pathname, ".html")
          : document.source === "quickshell-api" ? suffix.replace(/^types\//, "").replace(/\/$/, "") || "types"
          : suffix.replace(/^guide\/?/, "").replace(/\/$/, "") || "index";
        return { ...parsed, slug, source: document.source, sourceUrl: document.sourceUrl, sourceVersion: document.version, links: document.links };
      });
      cache = { version: snapshot.manifest.quickshellVersion, pages, signature: snapshot.signature, snapshot };
      return cache;
    }
    const current = await profile();
    if (cache?.signature === current.signature) return cache;
    const pages = await Promise.all(current.paths.map(async (file) => parseGuide(await fs.readFile(file, "utf8"), file)));
    cache = { version: current.version, pages, signature: current.signature };
    return cache;
  }
  async function loadPage(ref: string) {
    const corpus = await load();
    const normalized = normalize(ref.replace(/^@(?=\/)/, ""));
    if (!normalized) throw new Error("A non-empty page title, slug or source path is required.");
    let page = corpus.pages.find((page) => normalize(page.path) === normalized)
      || corpus.pages.find((page) => normalize(page.slug) === normalized)
      || corpus.pages.find((page) => normalize(page.title) === normalized)
      || corpus.pages.find((page) => page.sourceUrl === ref);
    if (!page) {
      const short = corpus.pages.filter((candidate) => normalize(candidate.slug.split("/").pop() || "") === normalized);
      if (short.length === 1) page = short[0];
      if (short.length > 1) throw new Error(`Ambiguous page '${ref}'. Use a source path returned by quickshell_wiki_search.`);
    }
    if (!page) throw new Error(`No selected offline document matched '${ref}'. Use quickshell_wiki_search first.`);
    return { corpus, page };
  }
  function metadata(corpus: Corpus, page?: Page) {
    return { docsVersion: corpus.version, coverage: corpus.snapshot?.manifest.coverage || LEGACY_COVERAGE,
      mode: corpus.snapshot ? "full-offline" : "legacy-guides", ...(page ? { title: page.title, path: page.path, source: page.source || "quickshell-guide", sourceUrl: page.sourceUrl, sourceVersion: page.sourceVersion || corpus.version } : {}) };
  }
  async function status() {
    try {
      const corpus = await load();
      const manifest = corpus.snapshot?.manifest;
      return { available: true as const, docsPath, offlinePath, ...metadata(corpus), pageCount: corpus.pages.length,
        counts: manifest?.counts, qtVersions: manifest?.qtVersions, downloadedAt: manifest?.downloadedAt, selection: manifest?.selection,
        unavailableQtPages: manifest?.unavailableQtPages, snapshot: manifest?.snapshot,
        versionWarning: "Newest published documentation may differ from installed Quickshell or Qt. Verify installed versions before using newly introduced APIs.", cache: "memory, fresh" };
    } catch (error) {
      return { available: false as const, docsPath, offlinePath, pageCount: 0, error: String(error) };
    }
  }
  async function search(params: { query: string; limit?: number; includeSnippets?: boolean; includeDetails?: boolean; source?: string }) {
    const corpus = await load();
    const expanded = expandQuery(params.query);
    if (params.source && !["quickshell-guide", "quickshell-api", "qt"].includes(params.source)) throw new Error("source must be quickshell-guide, quickshell-api or qt");
    const all = corpus.pages.filter((page) => !params.source || (page.source || "quickshell-guide") === params.source).map((page) => ({ page, score: exactTypeBonus(page, expanded.terms) + score(page.title, expanded.terms, 1) * 20 + score(page.slug, expanded.terms, 1) * 10 + score(page.sections.map((s) => s.title).join(" "), expanded.terms, 1) * 8 + score(page.text, expanded.terms, 12) }))
      .filter((result) => result.score > 0).sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path));
    const selected = all.slice(0, bounded(params.limit, 5, 50));
    return { ...metadata(corpus), query: params.query, expandedTokens: expanded.terms, ignoredStopwords: expanded.ignoredStopwords, omittedResultCount: all.length - selected.length,
      results: selected.map(({ page, score: value }) => ({ title: page.title, path: page.path, source: page.source || "quickshell-guide", score: Math.round(value * 100) / 100,
        ...(params.includeSnippets ? { snippet: page.text.slice(0, 260) } : {}),
        ...(params.includeDetails ? { matchedTerms: expanded.terms.filter((term) => normalize(page.text).includes(term)) } : {}),
      })) };
  }
  async function sections(params: { page: string; maxSections?: number }) {
    const { corpus, page } = await loadPage(params.page);
    const selected = page.sections.slice(0, bounded(params.maxSections, 40, 100));
    return { ...metadata(corpus, page), sectionCount: page.sections.length, omittedSectionCount: page.sections.length - selected.length, sections: selected.map(({ title, level, anchor }) => ({ title, level, anchor })) };
  }
  async function extract(params: { page: string; section?: string; query?: string; maxChars?: number; maxSections?: number; minTokenMatches?: number; requireAllTerms?: boolean }) {
    const { corpus, page } = await loadPage(params.page);
    let selected = page.sections;
    if (params.section) {
      const needle = normalize(params.section);
      const exact = selected.filter((section) => normalize(section.title) === needle || section.anchor === params.section);
      selected = exact.length ? exact : selected.filter((section) => normalize(section.title).includes(needle));
    }
    if (params.query) {
      const expanded = expandQuery(params.query);
      const minimum = params.requireAllTerms ? expanded.groups.length : bounded(params.minTokenMatches, 1, expanded.groups.length || 1);
      selected = selected.filter((section) => {
        const text = normalize(`${section.title}\n${section.text}`);
        return expanded.groups.length > 0 && expanded.groups.filter((group) => group.some((term) => text.includes(term))).length >= minimum;
      }).sort((a, b) => score(`${b.title}\n${b.text}`, expanded.terms, 4) - score(`${a.title}\n${a.text}`, expanded.terms, 4));
    }
    const totalMatchedSections = selected.length;
    selected = selected.slice(0, bounded(params.maxSections, 3, 25));
    const text = selected.map((section) => `${"#".repeat(section.level)} ${section.title}\n\n${section.text}`).join("\n\n");
    return { ...metadata(corpus, page), citation: `${page.path} — ${selected.map((s) => s.title).join(", ") || "no matching section"}`, totalMatchedSections, omittedSectionCount: totalMatchedSections - selected.length,
      matchedSections: selected.map(({ title, level, anchor }) => ({ title, level, anchor })), ...limited(text, bounded(params.maxChars, 6000, 12000)) };
  }
  async function read(params: { page: string; maxChars?: number }) {
    const { corpus, page } = await loadPage(params.page);
    return { ...metadata(corpus, page), citation: `${page.path} — ${page.title}`, ...limited(page.text, bounded(params.maxChars, 8000, 12000)) };
  }
  async function related(params: { page: string; limit?: number }) {
    const { corpus, page } = await loadPage(params.page);
    const links = new Map<string, { title: string; path: string }>();
    const unavailable = new Set<string>();
    const hrefs = page.links || [...page.text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((match) => match[2]);
    const bySource = new Map(corpus.pages.filter((p) => p.sourceUrl).map((p) => [canonicalSource(p.sourceUrl!), p]));
    for (const raw of hrefs) {
      const href = raw.split(/[?#]/)[0];
      if (!href) continue;
      let target: Page | undefined;
      if (/^https?:/i.test(href)) {
        try { target = bySource.get(canonicalSource(href)); }
        catch { continue; }
        if (!target) unavailable.add(href);
      } else {
        const slug = href.match(/^@docs\/guide(?:\/([^/]+))?\/?$/)?.[1] || (href === "@docs/guide" ? "index" : undefined);
        target = slug ? corpus.pages.find((p) => p.slug === slug) : corpus.pages.find((p) => p.path === path.resolve(path.dirname(page.path), href));
        if (!target) unavailable.add(href);
      }
      if (target && target.path !== page.path) links.set(target.path, { title: target.title, path: target.path });
    }
    const selected = [...links.values()].slice(0, bounded(params.limit, 5, 50));
    return { ...metadata(corpus, page), links: selected, omittedLinkCount: links.size - selected.length, unavailableLocalLinkCount: unavailable.size, unavailableLocalLinks: [...unavailable].slice(0, 10), omittedUnavailableLinkCount: Math.max(0, unavailable.size - 10) };
  }
  async function smokeTest() {
    const info = await status();
    if (!info.available) return { ok: false, status: info, checks: [] };
    const corpus = await load();
    const checks: { name: string; ok: boolean }[] = [];
    for (const item of [
      { query: "installation setup", slug: "install-setup" },
      { query: "PanelWindow", slug: "introduction" },
      { query: "childrenRect binding loops", slug: "size-position" },
      { query: "reactive bindings", slug: "qml-language" },
      { query: "distributing configurations", slug: "distribution" },
    ]) {
      const result = await search({ query: item.query, limit: 5, source: "quickshell-guide" });
      checks.push({ name: `search: ${item.slug}`, ok: result.results.some((p) => corpus.pages.find((page) => page.path === p.path)?.slug === item.slug) });
    }
    checks.push({ name: "titles and code-aware headings", ok: corpus.pages.every((p) => p.title.length > 0 && !p.sections.some((s) => /^#include\b|^\/\/|^import\s/.test(s.title))) });
    const guideLinks = await related({ page: "index", limit: 10 });
    checks.push({ name: "guide aliases resolve", ok: guideLinks.links.some((p) => p.title === "Introduction") });
    const excerpt = await extract({ page: "introduction", section: "Creating Windows", maxChars: 4000 });
    checks.push({ name: "exact section extraction", ok: excerpt.matchedSections.length === 1 && excerpt.text.includes("PanelWindow") && !excerpt.truncated });
    const boundedRead = await read({ page: "introduction", maxChars: 1000 });
    checks.push({ name: "bounded read", ok: boundedRead.text.length === 1000 && boundedRead.truncated });
    if (corpus.snapshot) {
      for (const query of ["PanelWindow", "PwNodeAudio", "PwObjectTracker", "Mpris", "SystemTray", "UPower", "IpcHandler"]) {
        const result = await search({ query, limit: 5, source: "quickshell-api" });
        checks.push({ name: `API: ${query}`, ok: result.results.some((p) => p.title.includes(query)) });
      }
      const slider = await search({ query: "Slider", source: "qt", limit: 5 });
      checks.push({ name: "Qt Controls: Slider", ok: slider.results.some((p) => p.title.startsWith("Slider QML Type")) });
    }
    return { ok: checks.every((check) => check.ok), status: info, checks };
  }
  return { status, search, sections, extract, read, related, smokeTest };
}

export interface SetupOptions { version?: string; rollback?: boolean; progress?: (message: string) => void }

export function parseSetupArgs(args: string): SetupOptions {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return {};
  if (words.length === 1 && words[0] === "--rollback") return { rollback: true };
  if (words.length === 2 && words[0] === "--version" && /^(latest|master|v\d+\.\d+\.\d+)$/.test(words[1])) return { version: words[1] };
  throw new Error("Usage: /quickshell-wiki-local-setup [--version latest|vX.Y.Z|master] [or --rollback]");
}

export async function executeSetup(docsPath = CONFIG.docsPath, options: SetupOptions = {}) {
  const offlinePath = `${path.resolve(docsPath)}.offline`;
  const helper = fileURLToPath(new URL("./scripts/sync_docs.py", import.meta.url));
  const version = options.version || CONFIG.requestedVersion || "latest";
  if (!/^(latest|master|v\d+\.\d+\.\d+)$/.test(version)) throw new Error("Invalid documentation version");
  const args = [helper, "--root", offlinePath, "--version", version];
  if (options.rollback) args.push("--rollback");
  return await new Promise<{ ok: boolean; message: string }>((resolve) => {
    const child = execFile("python3", args, { timeout: 1860000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      try {
        const result = JSON.parse(stdout.trim());
        if (error || !result.ok) {
          resolve({ ok: false, message: `${result.error || error?.message || "Documentation setup failed"}. Previous snapshot retained.` });
          return;
        }
        const manifest = result.manifest;
        resolve({ ok: true, message: `${options.rollback ? "Restored" : "Downloaded"} ${manifest.pageCount} pages: Quickshell ${manifest.quickshellVersion}, Qt ${manifest.qtVersions.join(", ")}. ${manifest.counts["quickshell-guide"]} guides, ${manifest.counts["quickshell-api"]} API pages, ${manifest.counts.qt} Qt pages. ${manifest.unavailableQtPages.length} unavailable optional Qt links. Offline storage: ${offlinePath}.` });
      } catch {
        resolve({ ok: false, message: `Setup failed: ${error?.message || stderr.slice(-2000) || "Invalid helper response"}. Python 3 is required. Previous snapshot retained; inspect a stale .setup-lock after interruption.` });
      }
    });
    let pending = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      pending = (pending + chunk.toString()).slice(-8192);
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) if (line.trim()) options.progress?.(line.slice(0, 1000));
    });
  });
}

const page = Type.String({ minLength: 1, maxLength: 2000, description: "Document title, qualified type slug, source URL or returned local citation path" });
const maxChars = Type.Optional(Type.Number({ minimum: 1000, maximum: 12000 }));
export default function quickshellWikiExtension(pi: ExtensionAPI) {
  const wiki = createWiki();
  pi.on("before_agent_start", async (event) => {
    if (!CONFIG.promptDetection.test(event.prompt || "")) return;
    const status = await wiki.status();
    const guidance = status.available
      ? `Load the quickshell-local skill. Use quickshell_wiki_search before web sources, then quickshell_wiki_sections and an exact quickshell_wiki_extract. Cite local paths and headings. Selected Quickshell docs: ${status.docsVersion}. Compare with quickshell --version and installed Qt. ${status.coverage} Use source filters to distinguish guides, Quickshell APIs and Qt references. Ask before editing configs or running QML.`
      : `${status.error} Explain the setup requirement. Do not claim local evidence or install anything automatically. Offer official online sources only if the user wants to continue without local docs.`;
    return { systemPrompt: `${event.systemPrompt}\n\nQuickshell local documentation routing: ${guidance}` };
  });
  pi.registerCommand("quickshell-wiki-status", { description: "Show Quickshell/Qt versions, source counts, snapshot age and coverage", handler: async (_args, ctx) => { ctx.ui.notify(JSON.stringify(await wiki.status(), null, 2), "info"); } });
  pi.registerCommand("quickshell-wiki-local-setup", { description: "Download newest published Quickshell guides/API and core Qt docs; --version pins, --rollback restores", handler: async (args, ctx) => {
    ctx.ui.setStatus("quickshell-wiki-setup", "Downloading Quickshell and Qt documentation...");
    try {
      const result = await executeSetup(CONFIG.docsPath, { ...parseSetupArgs(args), progress: (message) => ctx.ui.notify(message, "info") });
      ctx.ui.notify(result.message, result.ok ? "info" : "warning");
    } catch (error) { ctx.ui.notify(String(error), "error"); }
    finally { ctx.ui.setStatus("quickshell-wiki-setup", undefined); }
  } });
  pi.registerCommand("quickshell-wiki-smoke-test", { description: "Check Quickshell guide search, parsing, links and output bounds", handler: async (_args, ctx) => { const result = await wiki.smokeTest(); ctx.ui.notify(JSON.stringify(result, null, 2), result.ok ? "info" : "warning"); } });
  pi.registerTool({ name: "quickshell_wiki_search", label: "Quickshell documentation search", description: "Search offline Quickshell guides/API and core Qt docs. source can be quickshell-guide, quickshell-api or qt. Compact by default.", promptSnippet: "Search offline Quickshell and Qt documentation before web sources", promptGuidelines: ["Use quickshell_wiki_search first for Quickshell development; use source=quickshell-api for service/type contracts, qt for Qt controls, and quickshell-guide for tutorials."], parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 300 }), source: Type.Optional(Type.String({ description: "quickshell-guide, quickshell-api, or qt; omit to search all" })), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })), includeSnippets: Type.Optional(Type.Boolean()), includeDetails: Type.Optional(Type.Boolean()) }), async execute(_id, params) { return jsonResult(await wiki.search(params)); } });
  pi.registerTool({ name: "quickshell_wiki_sections", label: "Quickshell documentation sections", description: "List document headings and original member anchors with omission counts.", parameters: Type.Object({ page, maxSections: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }), async execute(_id, params) { return jsonResult(await wiki.sections(params)); } });
  pi.registerTool({ name: "quickshell_wiki_extract", label: "Quickshell documentation extract", description: "Extract headings or original member anchors from offline Quickshell/Qt docs with local and upstream citations. No match returns empty text. Bounds: 12000 characters, 25 sections.", promptSnippet: "Extract exact Quickshell/Qt documentation sections with local citations", promptGuidelines: ["Use quickshell_wiki_sections then quickshell_wiki_extract with an exact heading for final evidence."], parameters: Type.Object({ page, section: Type.Optional(Type.String()), query: Type.Optional(Type.String()), maxChars, maxSections: Type.Optional(Type.Number({ minimum: 1, maximum: 25 })), minTokenMatches: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })), requireAllTerms: Type.Optional(Type.Boolean()) }), async execute(_id, params) { return jsonResult(await wiki.extract(params)); } });
  pi.registerTool({ name: "quickshell_wiki_read", label: "Quickshell documentation read", description: "Read broad document context, bounded to 12000 characters with source/version and truncation metadata. Prefer exact extracts.", parameters: Type.Object({ page, maxChars }), async execute(_id, params) { return jsonResult(await wiki.read(params)); } });
  pi.registerTool({ name: "quickshell_wiki_related", label: "Quickshell related documentation", description: "Resolve links across downloaded Quickshell/Qt documents and report unavailable local references.", parameters: Type.Object({ page, limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })) }), async execute(_id, params) { return jsonResult(await wiki.related(params)); } });
  pi.registerTool({ name: "quickshell_wiki_smoke_test", label: "Quickshell documentation smoke test", description: "Check local guide/API/Qt search, extraction, links and bounds without network access.", parameters: Type.Object({}), async execute() { return jsonResult(await wiki.smokeTest()); } });
}
