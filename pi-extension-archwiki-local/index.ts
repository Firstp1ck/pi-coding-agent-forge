import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { commandExists, createLocalWikiEngine, jsonToolResult, pathExists, runCommand } from "@firstpick/pi-utils";

const DOCS_PATH = "/usr/share/doc/arch-wiki/html/en";
const CACHE_DIR = path.join(os.homedir(), ".cache", "pi", "archwiki-local");
const SCHEMA_VERSION = 2;
const INSTALL_COMMAND = "sudo pacman -S arch-wiki-docs";
const MISSING_DOCS_MESSAGE = `Local ArchWiki docs are not installed at ${DOCS_PATH}. Install them with: ${INSTALL_COMMAND}`;
const QUERY_EXPANSIONS: Record<string, string[]> = {
  dns: ["resolv.conf", "systemd-resolved", "resolvectl", "NetworkManager", "Domain name resolution"],
  wifi: ["wireless", "iwd", "wpa_supplicant", "NetworkManager"], wireless: ["wifi", "iwd", "wpa_supplicant", "NetworkManager"],
  boot: ["bootloader", "systemd-boot", "GRUB", "initramfs", "mkinitcpio"],
  audio: ["PipeWire", "ALSA", "WirePlumber", "PulseAudio"], sound: ["audio", "PipeWire", "ALSA", "WirePlumber", "PulseAudio"],
  gpu: ["NVIDIA", "AMDGPU", "Intel graphics", "Mesa", "Wayland", "Xorg"],
  aur: ["makepkg", "PKGBUILD", "paru", "yay", "Arch User Repository"], signature: ["pacman-key", "keyring", "package signing"],
  service: ["systemd unit", "systemctl", "journalctl"], bluetooth: ["BlueZ", "bluetoothctl", "controller"],
  snapshots: ["Btrfs", "Snapper", "Timeshift"], luks: ["dm-crypt", "cryptsetup", "initramfs", "mkinitcpio"],
  initramfs: ["mkinitcpio", "hooks", "boot"],
};
const SEARCH_STOPWORDS = ["a", "an", "and", "are", "arch", "archlinux", "as", "at", "be", "by", "can", "docs", "for", "from", "help", "how", "i", "in", "is", "it", "linux", "of", "on", "or", "the", "this", "to", "use", "using", "wiki", "with", "you", "your"];
const TERM_WEIGHTS: Record<string, number> = { configuration: 0.65, desktop: 0.75, guide: 0.45, installation: 0.7, linux: 0.35, service: 0.7, setup: 0.65, system: 0.55, troubleshooting: 0.75 };
const ARCH_LINUX_PROMPT_RE = /\b(arch\s*linux|archlinux|arch-based|endeavouros|endeavour\s*os|cachyos|cachy\s*os|manjaro|garuda|artix|blackarch|arcolinux|archlabs|rebornos|crystal\s*linux|xerolinux|pacman|makepkg|pkgbuild|aur|mkinitcpio|initramfs|systemd|journalctl|systemctl|networkmanager|resolvectl|systemd-resolved|pipewire|wireplumber|alsa|wayland|xorg|nvidia|amdgpu|bluetooth|bluez|btrfs|luks|dm-crypt|pacman-key|keyring|invalid signature|corrupted package)\b/i;

async function packageVersion(): Promise<string | undefined> { const result = await runCommand("pacman", ["-Q", "arch-wiki-docs"], { timeoutMs: 120000 }); return result.ok ? result.stdout.trim() || undefined : undefined; }
async function packageUpdateAvailable(): Promise<string | undefined> { const result = await runCommand("pacman", ["-Qu", "arch-wiki-docs"], { timeoutMs: 120000 }); return result.ok && result.stdout.trim() ? result.stdout.trim() : undefined; }
async function installOrUpdatePackage(): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> { const isRoot = typeof process.getuid === "function" && process.getuid() === 0; if (isRoot) return runCommand("pacman", ["-S", "--needed", "arch-wiki-docs"], { timeoutMs: 120000 }); if (await commandExists("sudo", ["-n", "true"], 3000)) return runCommand("sudo", ["-n", "pacman", "-S", "--needed", "arch-wiki-docs"], { timeoutMs: 120000 }); return { ok: false, stdout: "", stderr: "", error: "Automatic install/update requires root or passwordless sudo." }; }

function stripHtmlTitle(html: string, filePath: string, fallback: string): string {
  const raw = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const title = raw.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/\s*-\s*ArchWiki\s*$/i, "").trim();
  return title || decodeURIComponent(path.basename(filePath, ".html")).replace(/_/g, " ") || fallback;
}
function transformArchText(text: string, title: string): string {
  const noisy = new Set(["Jump to content", "Contents", "move to sidebar", "hide", "Beginning"]);
  const cleaned = text.split(/\n/).filter((line) => !noisy.has(line.trim().replace(/^#+\s*/, ""))).join("\n");
  const titleLower = title.toLowerCase();
  const lines = cleaned.split(/\n/);
  const index = lines.findIndex((line) => line.replace(/^#+\s*/, "").trim().toLowerCase() === titleLower);
  return index > 0 ? lines.slice(index).join("\n") : cleaned;
}

const wiki = createLocalWikiEngine({
  displayName: "ArchWiki",
  docsPath: DOCS_PATH,
  cacheDir: CACHE_DIR,
  schemaVersion: SCHEMA_VERSION,
  fileExtensions: /\.html?$/i,
  format: "html",
  queryExpansions: QUERY_EXPANSIONS,
  searchStopwords: SEARCH_STOPWORDS,
  termWeights: TERM_WEIGHTS,
  missingDocsMessage: MISSING_DOCS_MESSAGE,
  titleFromHtml: stripHtmlTitle,
  transformText: transformArchText,
  metadataExtra: async () => ({ archWikiDocsPackage: await packageVersion() }),
  statusExtra: async () => ({ docsPathExists: await pathExists(DOCS_PATH), docsInstalled: await wiki.available(), installCommand: INSTALL_COMMAND, cacheDir: CACHE_DIR, archWikiDocsPackage: await packageVersion() }),
});

async function executeSetup() {
  if (!await commandExists("pacman", ["--version"], 3000)) return { ok: false, message: `pacman is not available. Please install local ArchWiki docs manually: ${INSTALL_COMMAND}` };
  if (await wiki.available()) {
    const current = await wiki.status();
    const update = await packageUpdateAvailable();
    if (!update) return { ok: true, message: `arch-wiki-docs is installed and no update is reported by pacman (${current.archWikiDocsPackage ?? "package version unknown"}).`, details: current };
    const result = await installOrUpdatePackage();
    return { ok: result.ok, message: result.ok ? `Updated arch-wiki-docs. Previous pending update: ${update}` : `arch-wiki-docs has an available update (${update}), but automatic update is not possible. Run: ${INSTALL_COMMAND}`, details: { update, result, status: await wiki.status() } };
  }
  const result = await installOrUpdatePackage();
  return { ok: result.ok && await wiki.available(), message: result.ok ? "Installed arch-wiki-docs via pacman." : `Could not install arch-wiki-docs automatically. Run: ${INSTALL_COMMAND}`, details: result };
}

const searchParams = Type.Object({ query: Type.String({ description: "Search query, e.g. 'pacman invalid signature'" }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })), language: Type.Optional(Type.String()), includeSnippets: Type.Optional(Type.Boolean()) });
const readParams = Type.Object({ page: Type.String({ description: "ArchWiki page title, slug, or absolute local HTML path" }), maxChars: Type.Optional(Type.Number({ minimum: 1000, maximum: 100000 })) });
const sectionsParams = Type.Object({ page: Type.String({ description: "ArchWiki page title, slug, or absolute local HTML path" }), maxSections: Type.Optional(Type.Number({ minimum: 1, maximum: 300 })) });
const extractParams = Type.Object({ page: Type.String({ description: "ArchWiki page title, slug, or absolute local HTML path" }), section: Type.Optional(Type.String()), query: Type.Optional(Type.String()), maxChars: Type.Optional(Type.Number({ minimum: 1000, maximum: 100000 })), maxSections: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })) });
const relatedParams = Type.Object({ page: Type.String({ description: "ArchWiki page title, slug, or absolute local HTML path" }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })) });
const smokeParams = Type.Object({ maxSearchResults: Type.Optional(Type.Number({ minimum: 3, maximum: 10 })) });

async function executeSmokeTest(params: { maxSearchResults?: number } = {}) {
  const checks: Array<{ name: string; ok: boolean; detail: string; chars?: number }> = [];
  const addCheck = (name: string, ok: boolean, detail: string, payload?: unknown) => checks.push({ name, ok, detail, chars: payload === undefined ? undefined : JSON.stringify(payload).length });
  const status = await wiki.status();
  addCheck("corpus available", Boolean(status.available), `${status.pageCount} indexed files at ${status.docsPath}`);
  if (!status.available) return { ok: false, status, checks };

  const limit = Math.max(3, Math.min(params.maxSearchResults ?? 5, 10));
  const searchCases = [
    { name: "package signing", query: "pacman invalid signature keyring", expectedPath: "Pacman/Package_signing.html" },
    { name: "pipewire", query: "pipewire no audio wireplumber", expectedPath: "PipeWire.html" },
    { name: "dns", query: "networkmanager dns systemd resolved", expectedPath: "Systemd-resolved.html" },
    { name: "aur", query: "aur makepkg pkgbuild", expectedPath: "Arch_User_Repository.html" },
    { name: "luks", query: "mkinitcpio luks encrypt boot", expectedPath: "Dm-crypt/Encrypting_an_entire_system.html" },
  ];
  for (const testCase of searchCases) {
    const result = await wiki.search({ query: testCase.query, limit, includeSnippets: false });
    addCheck(`search: ${testCase.name}`, result.results.some((entry) => entry.path.endsWith(testCase.expectedPath)), `expected page found in top ${limit}`, result.results);
  }
  const sections = await wiki.sections({ page: "Pacman/Package_signing", maxSections: 40 });
  addCheck("sections: package signing", sections.sections.length >= 5 && sections.omittedSectionCount >= 0, `${sections.sections.length}/${sections.sectionCount} headings, omitted ${sections.omittedSectionCount}`, sections.sections);
  const extract = await wiki.extract({ page: "Pacman/Package_signing", section: "Invalid signature errors", maxChars: 4000, maxSections: 2 });
  addCheck("extract: invalid signature", extract.text.includes("signature") && !extract.truncated, `${extract.text.length} chars, omitted ${extract.omittedSectionCount}`, extract.text);
  const read = await wiki.read({ page: "Pacman/Package_signing", maxChars: 2000 });
  addCheck("read: bounded output", read.text.length <= 2100 && read.truncated, `${read.text.length} chars, truncated=${read.truncated}`, read.text);
  return { ok: checks.every((check) => check.ok), status, checks };
}

export default function archWikiLocalExtension(pi: ExtensionAPI) {
  pi.on?.("before_agent_start", async (event, ctx) => {
    if ("messageType" in event && event.messageType === "custom") return;
    const skillLoaded = event.systemPromptOptions.skills?.some((skill) => skill.name === "arch-linux-local") ?? false;
    if (!skillLoaded && !ARCH_LINUX_PROMPT_RE.test(event.prompt ?? "")) return;
    if (!await wiki.available()) { const warning = `${MISSING_DOCS_MESSAGE}. Aborting ArchWiki-local troubleshooting until the docs are installed. You can also run /archwiki-local-setup.`; ctx.ui.notify(warning, "warning"); ctx.abort(); return { message: { customType: "archwiki-local-missing-docs", content: warning, display: true }, systemPrompt: `${event.systemPrompt}\n\nArchWiki-local setup required: ${warning} Do not continue with ArchWiki-local troubleshooting until the user installs arch-wiki-docs.` }; }
    return { systemPrompt: `${event.systemPrompt}\n\nArch/Arch-based local documentation routing: This user prompt appears related to Arch Linux, an Arch-based distro, or Linux troubleshooting that commonly maps to ArchWiki. Use archwiki_search before web sources, then archwiki_extract for focused sections. If the distro is EndeavourOS or CachyOS, prioritize that distro context after local ArchWiki; otherwise detect the distro with read-only evidence before assuming vanilla Arch behavior. Cite local ArchWiki paths separately from observed system evidence. Prefer read-only diagnostics and ask before destructive changes.` };
  });
  pi.registerCommand("archwiki-status", { description: "Show local ArchWiki docs path, page count, package version, and cache freshness", handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(await wiki.status(), null, 2), "info") });
  pi.registerCommand("archwiki-local-setup", { description: "Install the local ArchWiki documentation package (arch-wiki-docs) when possible", handler: async (_args, ctx) => { const result = await executeSetup(); ctx.ui.notify(result.message, result.ok ? "info" : "warning"); } });
  pi.registerCommand("archwiki-smoke-test", { description: "Run compact local ArchWiki parser/search/extract smoke tests", handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(await executeSmokeTest(), null, 2), "info") });
  pi.registerTool({ name: "archwiki_search", label: "ArchWiki Search", description: "Search installed local English ArchWiki pages from arch-wiki-docs.", promptSnippet: "Search local ArchWiki pages before using web sources for Arch/Linux troubleshooting", promptGuidelines: ["Use archwiki_search first for Arch Linux and Linux troubleshooting questions before consulting web sources.", "Use archwiki_extract after archwiki_search to retrieve focused local ArchWiki sections with citations."], parameters: searchParams, async execute(_id, params) { const payload = await wiki.search(params); return jsonToolResult({ language: params.language ?? "en", ...payload }); } });
  pi.registerTool({ name: "archwiki_read", label: "ArchWiki Read", description: "Read a local ArchWiki page as clean text with a local path citation.", promptSnippet: "Read clean local ArchWiki page text by title, slug, or absolute local path", promptGuidelines: ["Use archwiki_read only when broad ArchWiki page context is needed; prefer archwiki_extract for focused answers."], parameters: readParams, async execute(_id, params) { return jsonToolResult(await wiki.read(params)); } });
  pi.registerTool({ name: "archwiki_sections", label: "ArchWiki Sections", description: "List headings/sections for a local ArchWiki page.", promptSnippet: "List headings from a local ArchWiki page", promptGuidelines: ["Use archwiki_sections to choose exact local ArchWiki sections before extraction."], parameters: sectionsParams, async execute(_id, params) { return jsonToolResult(await wiki.sections(params)); } });
  pi.registerTool({ name: "archwiki_extract", label: "ArchWiki Extract", description: "Extract a named or query-relevant section from a local ArchWiki page.", promptSnippet: "Extract focused local ArchWiki sections by heading or query", promptGuidelines: ["Use archwiki_extract to cite exact local ArchWiki sections in final answers."], parameters: extractParams, async execute(_id, params) { return jsonToolResult(await wiki.extract(params)); } });
  pi.registerTool({ name: "archwiki_related", label: "ArchWiki Related", description: "Return local ArchWiki pages linked from a given local ArchWiki page.", promptSnippet: "Find locally linked ArchWiki pages related to a page", promptGuidelines: ["Use archwiki_related when an Arch/Linux issue spans multiple subsystems."], parameters: relatedParams, async execute(_id, params) { return jsonToolResult(await wiki.related(params)); } });
  pi.registerTool({ name: "archwiki_smoke_test", label: "ArchWiki Smoke Test", description: "Run a compact parser, search, extraction, and read smoke test for local ArchWiki.", promptSnippet: "Smoke-test local ArchWiki parser/search behavior", promptGuidelines: ["Use archwiki_smoke_test after package changes or corpus updates to verify search quality and bounded output."], parameters: smokeParams, async execute(_id, params) { return jsonToolResult(await executeSmokeTest(params)); } });
}
