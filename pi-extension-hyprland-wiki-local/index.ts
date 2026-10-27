import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLocalWikiEngine, jsonToolResult, pathExists, runCommand } from "@firstpick/pi-utils";

const REPO_URL = "https://github.com/hyprwm/hyprland-wiki.git";
const REPO_PATH = path.join(os.homedir(), ".hyprwiki");
const CACHE_DIR = path.join(os.homedir(), ".cache", "pi", "hyprland-wiki-local");
const SETUP_COMMAND = "/hyprwiki-local-setup";
const CLONE_COMMAND = `git clone ${REPO_URL} ${REPO_PATH}`;
const MISSING_REPO_MESSAGE = `Local Hyprland Wiki repository is not available at ${REPO_PATH}. Run ${SETUP_COMMAND} to clone it (${CLONE_COMMAND}).`;

const QUERY_EXPANSIONS: Record<string, string[]> = {
  monitor: ["monitors", "hyprctl monitors", "workspace"], monitors: ["monitor", "hyprctl monitors", "workspace"],
  nvidia: ["NVIDIA", "env", "Wayland", "GBM"], keyboard: ["input", "kb_layout", "keybinds", "bind"],
  mouse: ["input", "cursor", "sensitivity"], touchpad: ["input", "gestures", "natural_scroll"],
  bind: ["keybinds", "binds", "dispatcher"], keybind: ["bind", "dispatcher", "hyprctl dispatch"],
  rules: ["windowrule", "windowrulev2", "workspace rules"], windowrule: ["window rules", "windowrulev2", "rules"],
  portal: ["xdg-desktop-portal-hyprland", "screenshare", "screen sharing"],
  screenshots: ["grim", "slurp", "portal", "screenshare"], crash: ["crashes", "debug", "logs", "coredump"],
  config: ["hyprland.conf", "variables", "keywords"], plugin: ["plugins", "hyprpm"], hyprpm: ["plugins", "plugin"],
};
const SEARCH_STOPWORDS = ["a", "an", "and", "are", "as", "at", "be", "by", "can", "docs", "for", "from", "help", "how", "hypr", "hyprland", "i", "in", "is", "it", "of", "on", "or", "the", "this", "to", "use", "using", "wiki", "with", "you", "your"];
const TERM_WEIGHTS: Record<string, number> = { basics: 0.6, config: 0.65, configuring: 0.65, ecosystem: 0.7, general: 0.6, installation: 0.75, variables: 0.75, wayland: 0.75 };

async function gitRevision(): Promise<string | undefined> { if (!await pathExists(path.join(REPO_PATH, ".git"))) return undefined; const result = await runCommand("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_PATH, timeoutMs: 120000 }); return result.ok ? result.stdout.trim() || undefined : undefined; }
async function gitRemote(): Promise<string | undefined> { if (!await pathExists(path.join(REPO_PATH, ".git"))) return undefined; const result = await runCommand("git", ["remote", "get-url", "origin"], { cwd: REPO_PATH, timeoutMs: 120000 }); return result.ok ? result.stdout.trim() || undefined : undefined; }

const wiki = createLocalWikiEngine({
  displayName: "Hyprland Wiki",
  docsPath: REPO_PATH,
  cacheDir: CACHE_DIR,
  schemaVersion: 2,
  fileExtensions: /\.mdx?$/i,
  format: "markdown",
  queryExpansions: QUERY_EXPANSIONS,
  searchStopwords: SEARCH_STOPWORDS,
  termWeights: TERM_WEIGHTS,
  missingDocsMessage: MISSING_REPO_MESSAGE,
  metadataExtra: async () => ({ gitRevision: await gitRevision(), gitRemote: await gitRemote() }),
  statusExtra: async () => ({ gitRevision: await gitRevision(), gitRemote: await gitRemote() }),
});

async function executeSetup(): Promise<{ ok: boolean; message: string }> {
  if (!await pathExists(REPO_PATH)) {
    const parent = path.dirname(REPO_PATH);
    await fs.mkdir(parent, { recursive: true });
    const clone = await runCommand("git", ["clone", REPO_URL, REPO_PATH], { cwd: parent, timeoutMs: 120000 });
    return { ok: clone.ok, message: clone.ok ? `Cloned Hyprland Wiki to ${REPO_PATH}.` : `Clone failed: ${clone.stderr || clone.error}` };
  }
  if (await pathExists(path.join(REPO_PATH, ".git"))) {
    const pull = await runCommand("git", ["pull", "--ff-only"], { cwd: REPO_PATH, timeoutMs: 120000 });
    return { ok: pull.ok, message: pull.ok ? `Updated Hyprland Wiki at ${REPO_PATH}.` : `Update failed: ${pull.stderr || pull.error}` };
  }
  return { ok: await wiki.available(), message: `Docs path exists but is not a Git checkout: ${REPO_PATH}` };
}

const searchParams = Type.Object({ query: Type.String({ description: "Search query, e.g. 'monitor rules'" }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })), includeSnippets: Type.Optional(Type.Boolean()) });
const readParams = Type.Object({ page: Type.String({ description: "Hyprland Wiki page title, slug, or absolute local Markdown path" }), maxChars: Type.Optional(Type.Number({ minimum: 1000, maximum: 100000 })) });
const sectionsParams = Type.Object({ page: Type.String({ description: "Hyprland Wiki page title, slug, or absolute local Markdown path" }), maxSections: Type.Optional(Type.Number({ minimum: 1, maximum: 300 })) });
const extractParams = Type.Object({ page: Type.String({ description: "Hyprland Wiki page title, slug, or absolute local Markdown path" }), section: Type.Optional(Type.String()), query: Type.Optional(Type.String()), maxChars: Type.Optional(Type.Number({ minimum: 1000, maximum: 100000 })), maxSections: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })) });
const relatedParams = Type.Object({ page: Type.String({ description: "Hyprland Wiki page title, slug, or absolute local Markdown path" }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })) });
const smokeParams = Type.Object({ maxSearchResults: Type.Optional(Type.Number({ minimum: 3, maximum: 10 })) });

async function executeSmokeTest(params: { maxSearchResults?: number } = {}) {
  const checks: Array<{ name: string; ok: boolean; detail: string; chars?: number }> = [];
  const addCheck = (name: string, ok: boolean, detail: string, payload?: unknown) => checks.push({ name, ok, detail, chars: payload === undefined ? undefined : JSON.stringify(payload).length });
  const status = await wiki.status();
  addCheck("corpus available", Boolean(status.available), `${status.pageCount} indexed files at ${status.docsPath}`);
  if (!status.available) return { ok: false, status, checks };

  const limit = Math.max(3, Math.min(params.maxSearchResults ?? 5, 10));
  const searchCases = [
    { name: "monitors", query: "monitor resolution scale", expectedPath: "content/Configuring/Basics/Monitors.md" },
    { name: "window rules", query: "windowrule float opacity", expectedPath: "content/Configuring/Basics/Window-Rules.md" },
    { name: "portal", query: "xdg desktop portal screenshare", expectedPath: "content/Hypr Ecosystem/xdg-desktop-portal-hyprland.md" },
    { name: "plugins", query: "hyprpm plugins", expectedPath: "content/Plugins/Using-Plugins.md" },
    { name: "nvidia", query: "nvidia wayland hyprland env", expectedPath: "content/Nvidia/_index.md" },
  ];
  for (const testCase of searchCases) {
    const result = await wiki.search({ query: testCase.query, limit, includeSnippets: false });
    addCheck(`search: ${testCase.name}`, result.results.some((entry) => entry.path.endsWith(testCase.expectedPath)), `expected page found in top ${limit}`, result.results);
  }
  const sections = await wiki.sections({ page: "Window-Rules", maxSections: 40 });
  addCheck("sections: window rules title", sections.title === "Window Rules" && sections.sections.some((section) => section.title === "Window Rules"), `${sections.title}; ${sections.sections.length}/${sections.sectionCount} headings`, sections.sections);
  const extract = await wiki.extract({ page: "Window-Rules", section: "Window Rules", maxChars: 4000, maxSections: 2 });
  addCheck("extract: window rules", extract.text.includes("window") && !extract.text.includes("# Or target windows:"), `${extract.text.length} chars, omitted ${extract.omittedSectionCount}`, extract.text);
  const read = await wiki.read({ page: "Window-Rules", maxChars: 2000 });
  addCheck("read: bounded output", read.text.length <= 2100 && read.truncated, `${read.text.length} chars, truncated=${read.truncated}`, read.text);
  return { ok: checks.every((check) => check.ok), status, checks };
}

export default function hyprlandWikiExtension(pi: ExtensionAPI) {
  pi.on?.("before_agent_start", async (event, ctx) => {
    if ("messageType" in event && event.messageType === "custom") return;
    const skillLoaded = event.systemPromptOptions.skills?.some((skill) => skill.name === "hyprland-local") ?? false;
    const looksHyprland = /\b(hyprland|hyprctl|hyprpm|hyprland\.conf|hyprpaper|hyprlock|hypridle|hyprshot|hyprpicker|xdg-desktop-portal-hyprland|wayland compositor|windowrule|workspace rule)\b/i.test(event.prompt ?? "");
    if (!skillLoaded && !looksHyprland) return;
    if (!await wiki.available()) { const warning = `${MISSING_REPO_MESSAGE} Aborting Hyprland-local lookup until setup is complete.`; ctx.ui.notify(warning, "warning"); ctx.abort(); return { message: { customType: "hyprland-wiki-local-missing-docs", content: warning, display: true }, systemPrompt: `${event.systemPrompt}\n\nHyprland Wiki local documentation setup required: ${warning} Do not continue with Hyprland troubleshooting until the user runs ${SETUP_COMMAND}.` }; }
    return { systemPrompt: `${event.systemPrompt}\n\nHyprland local documentation routing: This prompt appears related to Hyprland or its ecosystem. Use hyprwiki_search before web sources, then hyprwiki_extract for focused sections with local path citations. Prefer read-only diagnostics and ask before destructive changes.` };
  });
  pi.registerCommand("hyprwiki-status", { description: "Show local Hyprland Wiki path, Git revision, page count, and cache freshness", handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(await wiki.status(), null, 2), "info") });
  pi.registerCommand("hyprwiki-local-setup", { description: "Clone or update the local Hyprland Wiki repository", handler: async (_args, ctx) => { const result = await executeSetup(); ctx.ui.notify(result.message, result.ok ? "info" : "warning"); } });
  pi.registerCommand("hyprwiki-smoke-test", { description: "Run compact local Hyprland Wiki parser/search/extract smoke tests", handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(await executeSmokeTest(), null, 2), "info") });
  pi.registerTool({ name: "hyprwiki_search", label: "Hyprland Wiki Search", description: `Search local Hyprland Wiki Markdown pages from ${REPO_PATH}.`, promptSnippet: "Search local official Hyprland Wiki pages before using web sources for Hyprland questions", promptGuidelines: ["Use hyprwiki_search first for Hyprland questions before consulting web sources.", "Use hyprwiki_extract after search to retrieve focused sections with citations."], parameters: searchParams, async execute(_id, params) { return jsonToolResult(await wiki.search(params)); } });
  pi.registerTool({ name: "hyprwiki_read", label: "Hyprland Wiki Read", description: "Read a local Hyprland Wiki page as Markdown text with a local path citation.", promptSnippet: "Read local Hyprland Wiki page text by title, slug, or absolute local Markdown path", promptGuidelines: ["Use hyprwiki_read only when broad Hyprland Wiki context is needed; prefer hyprwiki_extract for focused answers."], parameters: readParams, async execute(_id, params) { return jsonToolResult(await wiki.read(params)); } });
  pi.registerTool({ name: "hyprwiki_sections", label: "Hyprland Wiki Sections", description: "List headings/sections for a local Hyprland Wiki page.", promptSnippet: "List headings from a local Hyprland Wiki page", promptGuidelines: ["Use hyprwiki_sections to choose exact local sections before extraction."], parameters: sectionsParams, async execute(_id, params) { return jsonToolResult(await wiki.sections(params)); } });
  pi.registerTool({ name: "hyprwiki_extract", label: "Hyprland Wiki Extract", description: "Extract a named or query-relevant section from a local Hyprland Wiki page.", promptSnippet: "Extract focused local Hyprland Wiki sections by heading or query", promptGuidelines: ["Use hyprwiki_extract to cite exact local sections in final answers."], parameters: extractParams, async execute(_id, params) { return jsonToolResult(await wiki.extract(params)); } });
  pi.registerTool({ name: "hyprwiki_related", label: "Hyprland Wiki Related", description: "Return local Hyprland Wiki pages linked from a given local page.", promptSnippet: "Find locally linked Hyprland Wiki pages related to a page", promptGuidelines: ["Use hyprwiki_related when a Hyprland issue spans connected topics."], parameters: relatedParams, async execute(_id, params) { return jsonToolResult(await wiki.related(params)); } });
  pi.registerTool({ name: "hyprwiki_smoke_test", label: "Hyprland Wiki Smoke Test", description: "Run a compact parser, search, extraction, and read smoke test for local Hyprland Wiki.", promptSnippet: "Smoke-test local Hyprland Wiki parser/search behavior", promptGuidelines: ["Use hyprwiki_smoke_test after package changes or corpus updates to verify search quality and bounded output."], parameters: smokeParams, async execute(_id, params) { return jsonToolResult(await executeSmokeTest(params)); } });
}
